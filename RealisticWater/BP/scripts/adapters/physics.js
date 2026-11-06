/**
 * Physics converter: turns ordinary blocks into weight-driven physics bodies.
 *
 * How it works in game
 *   - place `rw:physics_converter` (crafted from iron + redstone, or /give)
 *   - use it while holding any block: one of that block leaves your hand and
 *     becomes a body with its own mass, thrown in the direction you look
 *   - land a body in water and it either floats or sinks depending on mass
 *   - right-click a body with an empty hand to shove it (impulse / mass)
 *   - /rw:physics on also converts every block you place
 *
 * Bodies are real blocks: the world block is moved cell by cell, so what you see
 * and collide with is the actual block, and its drops/behaviour stay vanilla.
 */
import * as mc from '@minecraft/server';
import { PhysicsWorld, massOf, massLabel, DEFAULT_PHYSICS } from '../core/physics.js';
import {
  WATER_ID, SOURCE_ID, SAND_ID, PARTICLE, log, getBlockSafe, isReplaceableId
} from './bedrock.js';

export const CONVERTER_ID = 'rw:physics_converter';
const BODIES_PROP = 'rw:bodies';
const PASSABLE = new Set([WATER_ID, SOURCE_ID, SAND_ID]);

/** Permutation states of a block as a plain object (safe on any build). */
function statesOf(permutation) {
  try { return permutation.getAllStates() ?? {}; } catch { return {}; }
}

function isAirBlock(block) {
  try { return block.isAir === true; } catch { return false; }
}

export function installPhysics(ctx) {
  /** @type {Map<string, {world: PhysicsWorld, dimension: any}>} */
  const worlds = new Map();
  const state = { auto: !!ctx.settings?.bedrockPhysicsAuto, savedTick: 0 };

  function worldFor(dimension) {
    let entry = worlds.get(dimension.id);
    if (entry) return entry;

    const grid = {
      isSolid(x, y, z) {
        const block = getBlockSafe(dimension, x, y, z);
        if (!block) return true;               // unloaded chunks are walls
        if (isAirBlock(block)) return false;
        return !PASSABLE.has(block.typeId);    // water/sand are passable
      },
      waterAt(x, y, z) {
        const bridge = ctx.bridges.get(dimension.id);
        if (!bridge) return 0;
        try { return bridge.waterVolumeAt(x + 0.5, y + 0.5, z + 0.5); } catch { return 0; }
      },
      tryMove(body, from, to) {
        const target = getBlockSafe(dimension, to.x, to.y, to.z);
        const source = getBlockSafe(dimension, from.x, from.y, from.z);
        if (!target || !source) return false;

        const targetId = target.typeId;
        const free = isAirBlock(target) || PASSABLE.has(targetId) || isReplaceableId(targetId);
        if (!free) return false;

        let permutation;
        try { permutation = mc.BlockPermutation.resolve(body.typeId, body.states ?? {}); }
        catch (e) { log('physics permutation failed', body.typeId, e?.message ?? e); return false; }

        const bridge = ctx.bridges.get(dimension.id);
        const water = bridge ? bridge.waterVolumeAt(to.x + 0.5, to.y + 0.5, to.z + 0.5) : 0;

        try {
          // displace the water in the cell the block is entering
          if (bridge && water > 0.02) {
            const f = bridge.solver.water;
            const i = f ? f.index(to.x, to.y, to.z) : -1;
            if (i >= 0) { f.vol[i] = 0; f.source[i] = 0; }
            bridge.invalidate(to.x, to.y, to.z);
          }
          target.setPermutation(permutation);
          if (source.typeId === body.typeId) {
            source.setType('minecraft:air');
          } else if (isAirBlock(source) === false) {
            // our block was replaced while airborne: the body is gone
            return false;
          }
          if (bridge) {
            bridge.invalidate(to.x, to.y, to.z);
            bridge.invalidate(from.x, from.y, from.z);
          }
          return true;
        } catch (e) {
          log('physics move failed', to.x, to.y, to.z, e?.message ?? e);
          return false;
        }
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

  /** First free cell at or above (x,y,z). */
  function freeCell(dimension, x, y, z, maxUp = 6) {
    for (let i = 0; i <= maxUp; i++) {
      const block = getBlockSafe(dimension, x, y + i, z);
      if (!block) return null;
      if (isAirBlock(block) || PASSABLE.has(block.typeId) || isReplaceableId(block.typeId)) {
        return { x, y: y + i, z };
      }
    }
    return null;
  }

  function writeBlock(dimension, cell, permutation) {
    const block = getBlockSafe(dimension, cell.x, cell.y, cell.z);
    if (!block) return false;
    try { block.setPermutation(permutation); return true; } catch { return false; }
  }

  /** Turn a block item into a body. Returns a message for the player. */
  function spawnFromItem(player, item, origin, throwIt = true) {
    if (!item) return { ok: false, message: 'Hold a block in your hand, then use the converter.' };
    let permutation;
    try { permutation = mc.BlockPermutation.resolve(item.typeId); }
    catch { return { ok: false, message: `${item.typeId} is not a block, so it cannot become a physics body.` }; }

    const dimension = player.dimension;
    const base = origin ?? player.location;
    const cell = freeCell(dimension, Math.floor(base.x), Math.floor(base.y) + 1, Math.floor(base.z));
    if (!cell) return { ok: false, message: 'No free space here for a physics body.' };

    if (!writeBlock(dimension, cell, permutation)) {
      return { ok: false, message: 'Could not place the block here.' };
    }

    const entry = worldFor(dimension);
    const look = throwIt ? player.getViewDirection() : { x: 0, y: 0, z: 0 };
    const body = entry.world.spawn({
      typeId: item.typeId,
      states: statesOf(permutation),
      x: cell.x, y: cell.y, z: cell.z,
      vx: look.x * 6, vy: 2.5 + look.y * 6, vz: look.z * 6
    });

    if (world_getGameMode(player) !== 'creative') {
      try {
        if (item.amount > 1) { item.amount -= 1; player.getComponent('minecraft:inventory')?.container?.setItem(player.selectedSlotIndex, item); }
        else player.getComponent('minecraft:inventory')?.container?.setItem(player.selectedSlotIndex, undefined);
      } catch { /* inventory unavailable */ }
    }

    return {
      ok: true,
      body,
      message: `Converted ${item.typeId} - ${massLabel(body.mass)}. Punch it with an empty hand to shove it.`
    };
  }

  function world_getGameMode(player) {
    try { return String(player.getGameMode?.() ?? '').toLowerCase(); } catch { return ''; }
  }

  /** Push whatever body occupies the cell. Returns true when one was hit. */
  function pushAt(dimension, cell, dir) {
    const entry = worlds.get(dimension.id);
    if (!entry) return false;
    const body = entry.world.bodyAt(cell.x, cell.y, cell.z);
    if (!body) return false;
    entry.world.push(body, dir);
    try {
      dimension.playSound('random.anvil_land', { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
        { volume: Math.min(1, body.mass / 4000), pitch: 0.7 + Math.min(0.8, 40 / body.mass) });
    } catch { /* sound unavailable */ }
    return true;
  }

  /** Adopt an already placed block as a body (auto mode). */
  function adopt(player, block) {
    if (!block) return null;
    const dimension = block.dimension;
    const entry = worldFor(dimension);
    const loc = block.location;
    if (entry.world.bodyAt(loc.x, loc.y, loc.z)) return null;
    let permutation;
    try { permutation = block.permutation; } catch { return null; }
    return entry.world.spawn({
      typeId: block.typeId,
      states: statesOf(permutation),
      x: loc.x, y: loc.y, z: loc.z
    });
  }

  // -------------------------------------------------------------------------
  // per-tick integration + presentation
  // -------------------------------------------------------------------------

  function tick(dimension) {
    const entry = worlds.get(dimension.id);
    if (!entry) return 0;
    const world = entry.world;
    if (!world.bodies.length) return 0;

    world.step(1 / 20);

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

    const entities = [];
    for (const impact of world.impacts) {
      try { dimension.spawnParticle(PARTICLE.dust, { x: impact.x + 0.5, y: impact.y + 0.2, z: impact.z + 0.5 }); } catch { /* ignore */ }
      if (impact.energy > 6000) {
        try {
          dimension.playSound('dig.stone', { x: impact.x + 0.5, y: impact.y + 0.5, z: impact.z + 0.5 },
            { volume: Math.min(1, impact.energy / 120000), pitch: 0.6 + Math.random() * 0.3 });
        } catch { /* ignore */ }
      }
      const cfg = world.cfg;
      if (impact.energy > cfg.damageEnergy && entities.length < 8) {
        const damage = Math.max(1, Math.min(cfg.maxDamage, Math.round(impact.energy / cfg.damageEnergy)));
        try {
          const here = dimension.getEntitiesAtBlockLocation
            ? dimension.getEntitiesAtBlockLocation({ x: impact.x, y: impact.y, z: impact.z })
            : [];
          for (const entity of here) {
            if (entity.typeId === 'minecraft:item') continue;
            try { entity.applyDamage(damage, { cause: 'fall' }); } catch { /* immune */ }
          }
        } catch { /* API unavailable */ }
      }
    }
    world.impacts.length = 0;

    // a body whose block vanished (mined, replaced) stops existing
    for (const body of world.bodies.slice()) {
      const block = getBlockSafe(dimension, body.x, body.y, body.z);
      if (!block || block.typeId !== body.typeId) world.remove(body.id);
    }
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

      try {
        if (block.typeId === CONVERTER_ID) {
          const res = spawnFromItem(player, ev.itemStack, block.location);
          if (res.message) player.sendMessage(res.message);
          return;
        }
        // empty hand on a physics body: shove it
        if (!ev.itemStack && pushAt(player.dimension, block.location, player.getViewDirection())) {
          return;
        }
      } catch (e) { log('physics interact failed', e?.message ?? e); }
    });
  } catch (e) { log('physics interact subscription failed', e?.message ?? e); }

  // left-clicking a body also shoves it (guarded: the event is newer than some builds)
  try {
    mc.world.afterEvents.entityHitBlock?.subscribe?.((ev) => {
      const block = ev.hitBlock;
      if (!block) return;
      const dir = ev.damagingEntity?.getViewDirection?.() ?? { x: 0, y: 1, z: 0 };
      pushAt(block.dimension, block.location, dir);
    });
  } catch { /* optional event */ }

  // auto mode: every block a player places becomes a body
  try {
    mc.world.afterEvents.blockPlace.subscribe((ev) => {
      if (!state.auto) return;
      const block = ev.block;
      if (!block) return;
      if (block.typeId === CONVERTER_ID) return;
      if (block.typeId === WATER_ID || block.typeId === SOURCE_ID || block.typeId === SAND_ID) return;
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
    isAuto: () => state.auto,
    setAuto(on) {
      state.auto = !!on;
      ctx.settings.bedrockPhysicsAuto = state.auto;
      return state.auto;
    },
    /** Toggle physics for the block in front of the player (/rw:physics). */
    convertAhead(player) {
      const view = player.getViewDirection();
      const eye = player.getHeadLocation();
      for (let d = 1; d <= 6; d++) {
        const x = Math.floor(eye.x + view.x * d);
        const y = Math.floor(eye.y + view.y * d);
        const z = Math.floor(eye.z + view.z * d);
        const block = getBlockSafe(player.dimension, x, y, z);
        if (!block || isAirBlock(block)) continue;
        if (block.typeId === WATER_ID || block.typeId === SOURCE_ID || block.typeId === SAND_ID) continue;
        const body = adopt(player, block);
        if (body) return `${block.typeId} converted - ${massLabel(body.mass)}`;
      }
      return 'No block in range to convert';
    },
    statsLine() {
      const lines = [];
      for (const [id, entry] of worlds) {
        lines.push(`${id}: ${entry.world.statsLine()}`);
      }
      return lines.length ? `${lines.join('  |  ')}  auto=${state.auto ? 'on' : 'off'}` : `no physics bodies yet, auto=${state.auto ? 'on' : 'off'}`;
    },
    clear() {
      let n = 0;
      for (const entry of worlds.values()) n += entry.world.clear();
      return n;
    },
    /** Persist body cells so a reload can restore them (best effort). */
    save() {
      const out = [];
      for (const [dimId, entry] of worlds) {
        for (const b of entry.world.bodies) {
          out.push([dimId, b.typeId, b.states, b.x, b.y, b.z]);
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
          entry.world.spawn({ typeId, states, x, y, z });
          n++;
        } catch { /* skip stale row */ }
      }
      return n;
    }
  };

  log('physics converter ready: place a converter and use it with a block');
  return api;
}

export { massOf };
