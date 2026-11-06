/**
 * Physics converter: turns ordinary blocks into weight-driven physics bodies.
 *
 * Movement is cell-accurate (see core/physics.js) because Bedrock refuses to draw
 * a custom block anywhere but a block position. To make the motion look smooth
 * anyway, an airborne body is drawn by a persistent proxy entity with a full-size
 * cube geometry and a material texture, teleported every tick to an interpolated
 * position between its cells. When the body comes to rest the proxy is removed and
 * the exact block is placed, so the settled result is the real block, not a proxy.
 *
 * If the proxy entity is unavailable (older build, missing resource pack) the
 * adapter falls back to moving the real block one cell at a time, which is what
 * earlier versions did.
 *
 * In game
 *   - place `rw:physics_converter` (8 iron + 1 redstone, or /give) and use it
 *     while holding any block: one block becomes a body thrown where you look
 *   - right-click or hit a body to shove it (impulse / mass)
 *   - /rw:physics on also converts every block you place
 *   - /rw:diag reports the physics mode actually in use
 */
import * as mc from '@minecraft/server';
import {
  PhysicsWorld, massOf, massLabel, bodyClass, DEFAULT_PHYSICS
} from '../core/physics.js';
import {
  WATER_ID, SOURCE_ID, SAND_ID, PARTICLE, log, getBlockSafe, isReplaceableId
} from './bedrock.js';

export const CONVERTER_ID = 'rw:physics_converter';
export const BODY_TAG = 'rw_physics_body';
const BODIES_PROP = 'rw:bodies';
const PASSABLE = new Set([WATER_ID, SOURCE_ID, SAND_ID]);

function statesOf(permutation) {
  try { return permutation.getAllStates() ?? {}; } catch { return {}; }
}

function isAirBlock(block) {
  try { return block.isAir === true; } catch { return false; }
}

function freeCell(block) {
  if (!block) return false;
  return isAirBlock(block) || PASSABLE.has(block.typeId) || isReplaceableId(block.typeId);
}

function gameMode(player) {
  try { return String(player.getGameMode?.() ?? '').toLowerCase(); } catch { return ''; }
}

export function installPhysics(ctx) {
  /** @type {Map<string, {world: PhysicsWorld, dimension: any}>} */
  const worlds = new Map();
  /** @type {Map<number, any>} body id -> proxy entity */
  const proxies = new Map();
  /** @type {Map<number, {x:number,y:number,z:number}>} body id -> smoothed visual position */
  const visuals = new Map();
  const state = {
    auto: !!ctx.settings?.bedrockPhysicsAuto,
    /** 'smooth' uses the proxy entity, 'blocks' is the fallback */
    mode: 'smooth'
  };

  function worldFor(dimension) {
    let entry = worlds.get(dimension.id);
    if (entry) return entry;

    const grid = {
      isSolid(x, y, z) {
        const block = getBlockSafe(dimension, x, y, z);
        if (!block) return true;
        if (isAirBlock(block)) return false;
        return !PASSABLE.has(block.typeId);
      },
      waterAt(x, y, z) {
        const bridge = ctx.bridges.get(dimension.id);
        if (!bridge) return 0;
        try { return bridge.waterVolumeAt(x + 0.5, y + 0.5, z + 0.5); } catch { return 0; }
      },
      /**
       * Permission for a body to occupy a cell. Deliberately writes nothing: the
       * proxy entity is the visible body while it is moving. Water in the cell is
       * pushed out, which is what makes a falling block splash.
       */
      tryMove(body, from, to) {
        const block = getBlockSafe(dimension, to.x, to.y, to.z);
        if (!block) return false;
        if (!freeCell(block)) return false;

        const bridge = ctx.bridges.get(dimension.id);
        if (bridge) {
          const f = bridge.solver.water;
          const i = f ? f.index(to.x, to.y, to.z) : -1;
          if (i >= 0 && f.vol[i] > 0.02) {
            f.vol[i] = 0;
            f.source[i] = 0;
          }
          bridge.invalidate(to.x, to.y, to.z);
          bridge.invalidate(from.x, from.y, from.z);
        }
        return true;
      }
    };

    const world = new PhysicsWorld({
      grid,
      config: {
        gravity: ctx.settings?.bedrockPhysicsGravity ?? DEFAULT_PHYSICS.gravity,
        punchImpulse: ctx.settings?.bedrockPhysicsPunch ?? DEFAULT_PHYSICS.punchImpulse
      }
    });
    entry = { world, dimension };
    worlds.set(dimension.id, entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // visuals
  // -------------------------------------------------------------------------

  function spawnProxy(dimension, body) {
    if (state.mode === 'blocks') return null;
    const identifier = `rw:body_${bodyClass(body.typeId)}`;
    try {
      const entity = dimension.spawnEntity(identifier, { x: body.x + 0.5, y: body.y, z: body.z + 0.5 });
      try { entity.addTag(BODY_TAG); } catch { /* tags optional */ }
      try { entity.isPersistent = true; } catch { /* already persistent */ }
      proxies.set(body.id, entity);
      visuals.set(body.id, { x: body.x + 0.5, y: body.y, z: body.z + 0.5 });
      return entity;
    } catch (e) {
      // Proxy entity missing: fall back to the block-stepping renderer, once.
      log('physics proxy unavailable, falling back to block motion:', e?.message ?? e);
      state.mode = 'blocks';
      return null;
    }
  }

  function dropProxy(body) {
    const entity = proxies.get(body.id);
    proxies.delete(body.id);
    visuals.delete(body.id);
    if (!entity) return;
    try { if (entity.isValid !== false) entity.remove(); } catch { /* already gone */ }
  }

  function proxyFor(entity) {
    for (const [id, candidate] of proxies) {
      if (candidate === entity) return id;
    }
    return undefined;
  }

  /** Interpolated position between cells, capped by speed so it never lags far. */
  function smoothStep(body) {
    const target = { x: body.x + 0.5, y: body.y, z: body.z + 0.5 };
    const prev = visuals.get(body.id) ?? target;
    const speed = Math.hypot(body.vx, body.vy, body.vz);
    const maxStep = Math.max(0.35, speed / 20 * 1.8);
    const clamp = (d) => (d > maxStep ? maxStep : (d < -maxStep ? -maxStep : d));
    const next = {
      x: prev.x + clamp(target.x - prev.x),
      y: prev.y + clamp(target.y - prev.y),
      z: prev.z + clamp(target.z - prev.z)
    };
    visuals.set(body.id, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // block handoff
  // -------------------------------------------------------------------------

  function clearCells(dimension, body) {
    const bridge = ctx.bridges.get(dimension.id);
    if (bridge) {
      const f = bridge.solver.water;
      const i = f ? f.index(body.x, body.y, body.z) : -1;
      if (i >= 0 && f.vol[i] > 0.02) { f.vol[i] = 0; f.source[i] = 0; }
      bridge.invalidate(body.x, body.y, body.z);
    }
  }

  /** Put the real block back. Returns true when it was placed. */
  function materialize(dimension, body) {
    let permutation;
    try { permutation = mc.BlockPermutation.resolve(body.typeId, body.states ?? {}); }
    catch (e) { log('physics materialise failed', body.typeId, e?.message ?? e); return false; }

    const base = { x: Math.round(body.x), y: Math.round(body.y), z: Math.round(body.z) };
    const existing = getBlockSafe(dimension, base.x, base.y, base.z);
    if (existing && existing.typeId === body.typeId) return true; // block mode already placed it
    for (let dy = 0; dy <= 3; dy++) {
      const cell = { x: base.x, y: base.y + dy, z: base.z };
      const block = getBlockSafe(dimension, cell.x, cell.y, cell.z);
      if (!block || !freeCell(block)) continue;
      try {
        block.setPermutation(permutation);
        const bridge = ctx.bridges.get(dimension.id);
        if (bridge) {
          const f = bridge.solver.water;
          const i = f ? f.index(cell.x, cell.y, cell.z) : -1;
          if (i >= 0) { f.vol[i] = 0; f.source[i] = 0; }
          bridge.invalidate(cell.x, cell.y, cell.z);
        }
        return true;
      } catch { /* try the next cell */ }
    }
    // No room: drop the block as an item rather than deleting it.
    try {
      dimension.spawnItem(new mc.ItemStack(body.typeId, 1),
        { x: base.x + 0.5, y: base.y + 0.5, z: base.z + 0.5 });
    } catch { /* item could not spawn */ }
    return false;
  }

  /** Fallback renderer: keep a real block at the body's cell (one cell per tick). */
  function blockProxySync(dimension, body, previous) {
    const from = previous ?? body;
    const moved = from.x !== body.x || from.y !== body.y || from.z !== body.z;
    if (moved) {
      const old = getBlockSafe(dimension, from.x, from.y, from.z);
      if (old && old.typeId === body.typeId) {
        try { old.setType('minecraft:air'); } catch { /* ignore */ }
      }
    }
    const block = getBlockSafe(dimension, body.x, body.y, body.z);
    if (!block || !freeCell(block)) return;
    if (block.typeId === body.typeId) return; // already drawn
    try {
      block.setPermutation(mc.BlockPermutation.resolve(body.typeId, body.states ?? {}));
      clearCells(dimension, body);
    } catch { /* leave it to the next tick */ }
  }

  // -------------------------------------------------------------------------
  // spawning bodies
  // -------------------------------------------------------------------------

  /** Turn a block item into a body. Returns a {ok, message} result. */
  function spawnFromItem(player, item, origin, throwIt = true) {
    if (!item) return { ok: false, message: 'Hold a block in your hand, then use the converter.' };
    let permutation;
    try { permutation = mc.BlockPermutation.resolve(item.typeId); }
    catch { return { ok: false, message: `${item.typeId} is not a block, so it cannot become a physics body.` }; }

    const dimension = player.dimension;
    const base = origin ?? player.location;
    let cell = null;
    for (let dy = 1; dy <= 6 && !cell; dy++) {
      const block = getBlockSafe(dimension, Math.floor(base.x), Math.floor(base.y) + dy, Math.floor(base.z));
      if (block && freeCell(block)) cell = { x: block.location.x, y: block.location.y, z: block.location.z };
    }
    if (!cell) return { ok: false, message: 'No free space here for a physics body.' };

    const entry = worldFor(dimension);
    const look = throwIt ? player.getViewDirection() : { x: 0, y: 0, z: 0 };
    const body = entry.world.spawn({
      typeId: item.typeId,
      states: statesOf(permutation),
      x: cell.x, y: cell.y, z: cell.z,
      vx: look.x * 6, vy: 2.5 + look.y * 6, vz: look.z * 6
    });
    spawnProxy(dimension, body);

    if (gameMode(player) !== 'creative') {
      try {
        const container = player.getComponent('minecraft:inventory')?.container;
        if (container) {
          if (item.amount > 1) { item.amount -= 1; container.setItem(player.selectedSlotIndex, item); }
          else container.setItem(player.selectedSlotIndex, undefined);
        }
      } catch { /* inventory unavailable */ }
    }

    return {
      ok: true,
      body,
      message: `Converted ${item.typeId} - ${massLabel(body.mass)}. Hit it to shove it.`
    };
  }

  /** Adopt an already placed block as a body (converter command / auto mode). */
  function adopt(player, block) {
    if (!block) return null;
    const dimension = block.dimension;
    const entry = worldFor(dimension);
    const loc = block.location;
    if (entry.world.bodyAt(loc.x, loc.y, loc.z)) return null;
    let states;
    try { states = statesOf(block.permutation); } catch { return null; }

    if (state.mode !== 'blocks') {
      try { block.setType('minecraft:air'); } catch { return null; }
    }

    const body = entry.world.spawn({
      typeId: block.typeId, states, x: loc.x, y: loc.y, z: loc.z
    });
    spawnProxy(dimension, body);
    return body;
  }

  function pushBody(dimension, body, dir) {
    if (!body) return false;
    const entry = worldFor(dimension);
    entry.world.push(body, dir);
    try {
      dimension.playSound('random.anvil_land',
        { x: body.x + 0.5, y: body.y + 0.5, z: body.z + 0.5 },
        { volume: Math.min(1, body.mass / 4000), pitch: 0.7 + Math.min(0.8, 40 / body.mass) });
    } catch { /* sound unavailable */ }
    return true;
  }

  function pushAt(dimension, cell, dir) {
    const entry = worlds.get(dimension.id);
    if (!entry) return false;
    return pushBody(dimension, entry.world.bodyAt(cell.x, cell.y, cell.z), dir);
  }

  // -------------------------------------------------------------------------
  // per-tick integration
  // -------------------------------------------------------------------------

  function tick(dimension) {
    const entry = worlds.get(dimension.id);
    if (!entry) return 0;
    const world = entry.world;
    if (!world.bodies.length) return 0;

    /** @type {Map<number, {x:number,y:number,z:number}>} */
    const before = new Map();
    for (const body of world.bodies) before.set(body.id, { x: body.x, y: body.y, z: body.z });

    world.step(1 / 20);

    for (const body of world.bodies.slice()) {
      if (body.settled) {
        // Hand the motion back to the world: real block in, proxy out.
        if (state.mode === 'blocks') blockProxySync(dimension, body, before.get(body.id));
        materialize(dimension, body);
        dropProxy(body);
        world.remove(body.id);
        continue;
      }

      if (state.mode === 'blocks') {
        blockProxySync(dimension, body, before.get(body.id));
      } else {
        const entity = proxies.get(body.id);
        const position = smoothStep(body);
        try {
          if (entity && entity.isValid !== false) entity.teleport(position);
          else if (!proxies.has(body.id)) spawnProxy(dimension, body);
        } catch {
          // lost the proxy (unloaded chunk, remove()): respawn once
          proxies.delete(body.id);
          visuals.delete(body.id);
          spawnProxy(dimension, body);
        }
      }
    }

    for (const s of world.splashes) {
      try { dimension.spawnParticle(PARTICLE.foam, { x: s.x + 0.5, y: s.y + 0.9, z: s.z + 0.5 }); } catch { /* ignore */ }
      if (s.volume > 0.5) {
        try {
          dimension.playSound('random.splash', { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5 },
            { volume: Math.min(1, s.volume), pitch: 0.9 + Math.random() * 0.3 });
        } catch { /* ignore */ }
      }
    }
    world.splashes.length = 0;

    for (const impact of world.impacts) {
      try { dimension.spawnParticle(PARTICLE.dust, { x: impact.x + 0.5, y: impact.y + 0.2, z: impact.z + 0.5 }); } catch { /* ignore */ }
      if (impact.energy > 6000) {
        try {
          dimension.playSound('dig.stone', { x: impact.x + 0.5, y: impact.y + 0.5, z: impact.z + 0.5 },
            { volume: Math.min(1, impact.energy / 120000), pitch: 0.6 + Math.random() * 0.3 });
        } catch { /* ignore */ }
      }
      const cfg = world.cfg;
      if (impact.energy > cfg.damageEnergy) {
        const damage = Math.max(1, Math.min(cfg.maxDamage, Math.round(impact.energy / cfg.damageEnergy)));
        try {
          const here = dimension.getEntitiesAtBlockLocation
            ? dimension.getEntitiesAtBlockLocation({ x: impact.x, y: impact.y, z: impact.z })
            : [];
          for (const entity of here) {
            if (entity.typeId === 'minecraft:item') continue;
            if (entity.hasTag?.(BODY_TAG)) continue;
            try { entity.applyDamage(damage, { cause: 'fall' }); } catch { /* immune */ }
          }
        } catch { /* API unavailable */ }
      }
    }
    world.impacts.length = 0;
    return world.bodies.length;
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  try {
    mc.world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
      const block = ev.block;
      const player = ev.player;
      if (!block || !player) return;
      if (ev.isFirstEvent === false) return;
      if (block.typeId !== CONVERTER_ID) return;
      try {
        const res = spawnFromItem(player, ev.itemStack, block.location);
        if (res.message) player.sendMessage(res.message);
      } catch (e) { log('physics converter failed', e?.message ?? e); }
    });
  } catch (e) { log('physics converter subscription failed', e?.message ?? e); }

  // shove a body: right-click it, or hit it
  try {
    mc.world.afterEvents.playerInteractWithEntity.subscribe((ev) => {
      if (ev.isFirstEvent === false) return;
      const target = ev.target;
      const player = ev.player;
      if (!target || !player) return;
      let isBody = false;
      try { isBody = target.hasTag?.(BODY_TAG) === true; } catch { isBody = false; }
      if (!isBody) return;
      const id = proxyFor(target);
      if (id === undefined) return;
      const entry = worlds.get(player.dimension.id);
      const body = entry?.world.bodies.find(b => b.id === id);
      if (body) pushBody(player.dimension, body, player.getViewDirection());
    });
  } catch (e) { log('physics interact-with-entity subscription failed', e?.message ?? e); }

  try {
    mc.world.afterEvents.entityHitEntity?.subscribe?.((ev) => {
      const target = ev.hitEntity;
      if (!target?.hasTag?.(BODY_TAG)) return;
      const id = proxyFor(target);
      if (id === undefined) return;
      const dimension = target.dimension;
      const entry = worlds.get(dimension.id);
      const body = entry?.world.bodies.find(b => b.id === id);
      const dir = ev.damagingEntity?.getViewDirection?.() ?? { x: 0, y: 1, z: 0 };
      if (body) pushBody(dimension, body, dir);
    });
  } catch { /* optional event */ }

  // physics mode: every block a player places becomes a body
  try {
    mc.world.afterEvents.blockPlace.subscribe((ev) => {
      if (!state.auto) return;
      const block = ev.block;
      if (!block) return;
      if (block.typeId === CONVERTER_ID) return;
      if (PASSABLE.has(block.typeId)) return;
      try { adopt(ev.player, block); } catch (e) { log('physics adopt failed', e?.message ?? e); }
    });
  } catch (e) { log('physics blockPlace subscription failed', e?.message ?? e); }

  // -------------------------------------------------------------------------
  // public api
  // -------------------------------------------------------------------------

  const api = {
    tick,
    pushAt,
    adopt,
    spawnFromItem,
    worlds,
    mode: () => state.mode,
    isAuto: () => state.auto,
    setAuto(on) {
      state.auto = !!on;
      ctx.settings.bedrockPhysicsAuto = state.auto;
      return state.auto;
    },
    convertAhead(player) {
      const view = player.getViewDirection();
      const eye = player.getHeadLocation();
      for (let d = 1; d <= 6; d++) {
        const x = Math.floor(eye.x + view.x * d);
        const y = Math.floor(eye.y + view.y * d);
        const z = Math.floor(eye.z + view.z * d);
        const block = getBlockSafe(player.dimension, x, y, z);
        if (!block || isAirBlock(block)) continue;
        if (PASSABLE.has(block.typeId)) continue;
        const body = adopt(player, block);
        if (body) return `${block.typeId} converted - ${massLabel(body.mass)}`;
      }
      return 'No block in range to convert';
    },
    statsLine() {
      const lines = [];
      for (const [id, entry] of worlds) lines.push(`${id}: ${entry.world.statsLine()}`);
      const head = lines.length ? lines.join('  |  ') : 'no physics bodies yet';
      return `${head}  mode=${state.mode} auto=${state.auto ? 'on' : 'off'}`;
    },
    clear() {
      let n = 0;
      for (const dimensionEntry of worlds.values()) {
        for (const body of dimensionEntry.world.bodies) {
          dropProxy(body);
          if (state.mode === 'blocks') materialize(dimensionEntry.dimension, body);
        }
        n += dimensionEntry.world.clear();
      }
      return n;
    },
    /** Remove stray proxy entities (called on world load before restoring). */
    sweepProxies(dimension) {
      let n = 0;
      try {
        const found = dimension.getEntities ? dimension.getEntities({ families: ['rw_body'] }) : [];
        for (const entity of found) { try { entity.remove(); n++; } catch { /* gone */ } }
      } catch { /* API unavailable */ }
      proxies.clear();
      visuals.clear();
      return n;
    },
    save() {
      const out = [];
      for (const [dimId, entry] of worlds) {
        for (const body of entry.world.bodies) {
          out.push([dimId, body.typeId, body.states, body.x, body.y, body.z]);
          if (out.length >= 120) break;
        }
      }
      try { mc.world.setDynamicProperty(BODIES_PROP, JSON.stringify(out)); } catch { /* quota */ }
    },
    load() {
      let raw;
      try { raw = mc.world.getDynamicProperty(BODIES_PROP); } catch { return 0; }
      if (typeof raw !== 'string' || !raw) return 0;
      let list;
      try { list = JSON.parse(raw); } catch { return 0; }
      if (!Array.isArray(list)) return 0;
      let n = 0;
      for (const row of list) {
        try {
          const [dimId, typeId, states, x, y, z] = row;
          let dimension = null;
          try { dimension = mc.world.getDimension(dimId); } catch { dimension = null; }
          if (!dimension) continue;
          const entry = worldFor(dimension);
          const body = entry.world.spawn({ typeId, states, x, y, z });
          spawnProxy(dimension, body);
          n++;
        } catch { /* skip stale row */ }
      }
      return n;
    }
  };

  log('physics converter ready (smooth proxy mode); /rw:diag reports the active mode');
  return api;
}

export { massOf, bodyClass };
