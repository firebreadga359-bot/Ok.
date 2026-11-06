/**
 * Realistic Water - Bedrock port entry point.
 *
 * Wiring only: settings, per-dimension solver + world bridge, block events,
 * commands and presentation. The physics lives in core/ (pure, unit tested).
 */
import * as mc from '@minecraft/server';
import { settings, serializeSettings, loadSettings } from './core/settings.js';
import { Solver } from './core/solver.js';
import { WorldBridge } from './adapters/worldIO.js';
import { Presentation } from './adapters/presentation.js';
import { subscribeStartup, subscribeScriptEvents, COMMAND_HELP } from './adapters/commands.js';
import { registerItems } from './adapters/items.js';
import { installVanilla } from './adapters/vanilla.js';
import { installPhysics } from './adapters/physics.js';
import {
  WATER_ID, SOURCE_ID, SAND_ID, log, writeWaterLevel, writeSandLayers, readCell, getBlockSafe
} from './adapters/bedrock.js';

const world = mc.world;
// `system` must be bound explicitly: an unbound global throws a ReferenceError at
// module load, which kills the whole script (water, sand, commands and all).
const system = mc.system;

/** @type {Map<string, Solver>} */
const solvers = new Map();
/** @type {Map<string, WorldBridge>} */
const bridges = new Map();
const presentation = new Presentation();

const SEED_BUDGET = 1600;

try {
  loadSettings(world.getDynamicProperty('rw:settings'));
} catch { /* first run */ }

function solverFor(dimensionId) {
  let s = solvers.get(dimensionId);
  if (!s) { s = new Solver(settings); solvers.set(dimensionId, s); }
  return s;
}

function bridgeFor(dimension) {
  let b = bridges.get(dimension.id);
  if (!b) {
    b = new WorldBridge(dimension, solverFor(dimension.id), settings);
    bridges.set(dimension.id, b);
  }
  return b;
}

function playersOf(dimensionId) {
  return world.getAllPlayers().filter(p => p.dimension.id === dimensionId);
}

function nearestPlayer(dimensionId, x, y, z) {
  let best = null, bestD = Infinity;
  for (const p of playersOf(dimensionId)) {
    const d = (p.location.x - x) ** 2 + (p.location.y - y) ** 2 + (p.location.z - z) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Drop a cube of material in front of the player (/rw:ball, /rw:sand). */
function ball(origin, size, material) {
  const player = origin?.sourceEntity;
  if (!player || !player.location) return 'Run this as a player';
  const s = Math.max(1, Math.min(32, size | 0));
  const solver = solverFor(player.dimension.id);
  const bridge = bridgeFor(player.dimension);
  const view = player.getViewDirection();
  const eye = player.getHeadLocation();
  const cx = eye.x + view.x * (s + 3);
  const cy = eye.y + view.y * (s + 3);
  const cz = eye.z + view.z * (s + 3);
  const half = s * 0.5;
  const n = solver.addEmitBox(cx - half, cy - half, cz - half, cx + half, cy + half, cz + half, material);
  bridge.cache.clear();
  return `Dropped a ${s}^3 block cube of ${material === 'SAND' ? 'sand' : 'water'} (${n} cells)`;
}

/** Delete simulated blocks around the player (/rw:remove). */
function removeAll(origin, what) {
  const player = origin?.sourceEntity;
  if (!player) return 'Run this as a player';
  const dim = player.dimension;
  const solver = solverFor(dim.id);
  const bridge = bridgeFor(dim);
  const f = solver.water;
  if (!f) return 'Nothing to remove';
  const material = String(what ?? 'all').toLowerCase();
  let removed = 0;
  for (let i = 0; i < f.count; i++) {
    const x = f.minX + (i % f.nx);
    const y = f.minY + (Math.floor(i / f.nx) % f.ny);
    const z = f.minZ + Math.floor(i / (f.nx * f.ny));
    const b = getBlockSafe(dim, x, y, z);
    if (!b) continue;
    if (b.typeId === WATER_ID || b.typeId === SOURCE_ID) {
      if (material === 'sand') continue;
      writeWaterLevel(dim, x, y, z, -1);
      removed++;
    } else if (b.typeId === SAND_ID) {
      if (material === 'water') continue;
      writeSandLayers(dim, x, y, z, 0);
      removed++;
    }
  }
  solver.clearAll(material === 'sand' ? 'SAND' : (material === 'water' ? 'WATER' : 'BOTH'));
  bridge.cache.clear();
  solver.invalidateWrites();
  return `Removed ${removed} realistic ${material === 'sand' ? 'sand' : 'water'} blocks`;
}

/** Re-read our blocks around the player from scratch (/rw:reload). */
function reload(origin) {
  const player = origin?.sourceEntity ?? world.getAllPlayers()[0];
  if (!player) return;
  const id = player.dimension.id;
  bridges.delete(id);
  solvers.delete(id);
}

const commandApi = {
  world,
  getSolver: (origin) => {
    const dimId = origin?.sourceEntity?.dimension?.id ?? world.getAllPlayers()[0]?.dimension?.id;
    return dimId ? solvers.get(dimId) : undefined;
  },
  reload,
  removeAll,
  ball,
  /** installed below; null until the subsystem boots */
  physics: null,
  diag: () => diagLine()
};

// ---------------------------------------------------------------------------
// startup diagnostics: one failing subsystem must not hide the others
// ---------------------------------------------------------------------------

const diag = {
  entries: [],
  add(name, ok, detail = '') { this.entries.push({ name, ok, detail }); return ok; }
};

function boot(name, fn) {
  try {
    const value = fn();
    diag.add(name, value !== false, value === false ? 'unavailable on this build' : '');
    return value;
  } catch (e) {
    diag.add(name, false, e?.message ?? String(e));
    log('startup subsystem failed:', name, e?.message ?? e);
    return null;
  }
}

function diagLine() {
  const lines = ['Realistic Water diagnostics:'];
  for (const e of diag.entries) {
    lines.push(`  ${e.ok ? 'OK  ' : 'FAIL'} ${e.name}${e.detail ? ' - ' + e.detail : ''}`);
  }
  const player = world.getAllPlayers()[0];
  if (player) {
    const solver = solvers.get(player.dimension.id);
    const bridge = bridges.get(player.dimension.id);
    lines.push(`  field: ${solver?.water ? `${solver.water.nx}x${solver.water.ny}x${solver.water.nz} at ${solver.water.minX},${solver.water.minY},${solver.water.minZ}` : 'not allocated yet'}`);
    lines.push(`  unseeded cells: ${bridge ? bridge.seedRemaining() : '-'}`);
    lines.push(`  water cells: ${solver?.stats.waterCells ?? 0}, sand cells: ${solver?.stats.sandCells ?? 0}`);
  }
  lines.push(`  physics: ${commandApi.physics ? commandApi.physics.statsLine() : 'not installed'}`);
  lines.push(`  ticks: ${tickCounter}, tick errors: ${tickErrors}, radius: ${settings.bedrockFieldRadius}`);
  lines.push('  If water still does not move, copy this list into the bug report.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// block change plumbing
// ---------------------------------------------------------------------------

function notifyBlockChange(dimension, x, y, z, prevId, newId) {
  const bridge = bridges.get(dimension.id);
  if (!bridge) return;
  try { bridge.onBlockChanged(x, y, z, prevId, newId); } catch (e) { log('block change failed', e?.message ?? e); }
}

try {
  world.afterEvents.blockPlace.subscribe((ev) => {
    const b = ev.block;
    if (!b) return;
    notifyBlockChange(b.dimension, b.location.x, b.location.y, b.location.z,
      ev.previousBlock?.typeId ?? 'minecraft:air', b.typeId);
  });
} catch (e) { log('blockPlace unavailable', e?.message ?? e); }

try {
  world.afterEvents.blockBreak.subscribe((ev) => {
    const b = ev.block;
    if (!b) return;
    notifyBlockChange(b.dimension, b.location.x, b.location.y, b.location.z,
      ev.brokenBlockPermutation?.type?.id ?? WATER_ID, 'minecraft:air');
  });
} catch (e) { log('blockBreak unavailable', e?.message ?? e); }

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

let tickCounter = 0;
let warnedSeed = false;
const PLAYER_TICK = 1 / 20;

let tickErrors = 0;

function simulate() {
  tickCounter++;
  const allPlayers = world.getAllPlayers();
  if (allPlayers.length === 0) return;

  /** @type {Map<string, any[]>} */
  const byDimension = new Map();
  for (const p of allPlayers) {
    const id = p.dimension.id;
    if (!byDimension.has(id)) byDimension.set(id, []);
    byDimension.get(id).push(p);
  }

  for (const [dimId, players] of byDimension) {
    const dim = players[0].dimension;
    const solver = solverFor(dimId);
    const bridge = bridgeFor(dim);

    // field follows whoever is nearest to the current field centre
    let anchor = players[0];
    if (solver.water) {
      const f = solver.water;
      const cx = f.minX + f.nx / 2, cy = f.minY + f.ny / 2, cz = f.minZ + f.nz / 2;
      anchor = nearestPlayer(dimId, cx, cy, cz) ?? players[0];
    }
    const loc = anchor.location;
    const reseeded = bridge.ensureField(loc.x, loc.y, loc.z);
    if (reseeded && !warnedSeed) {
      warnedSeed = true;
      log('simulation field allocated, seeding from world');
    }

    bridge.seed(SEED_BUDGET);

    const changes = solver.step(PLAYER_TICK);
    bridge.applyChanges(changes);

    // physics bodies move one real block at a time, after the fluid step so
    // displaced water is written in the same tick
    try { commandApi.physics?.tick(dim); } catch (e) { log('physics tick failed', e?.message ?? e); }
    if (tickCounter % 200 === 0) { try { commandApi.physics?.save(); } catch { /* quota */ } }

    presentation.spawnWhitewater(dim, solver.particles);
    presentation.flowAudio(dim, solver, players, settings);
    presentation.updateFog(players, bridge, settings);
    presentation.entityPhysics(dim, bridge, players, settings);
    if (solver.stats.sandCells > 0) {
      presentation.spawnSandDust(dim, solver, 6);
    }
  }
}

system.runInterval(() => {
  try {
    simulate();
  } catch (e) {
    // one broken cell must never stop the whole simulation
    if (++tickErrors <= 3) log('simulation tick failed', e?.message ?? e);
  }
}, 1);

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

boot('custom commands', () => subscribeStartup(commandApi));
boot('scriptevent fallback', () => subscribeScriptEvents(commandApi));
boot('bucket and sand items', () => registerItems({ bridges, settings }) ?? true);
// normal water buckets and normal sand blocks work without any command
boot('vanilla water/sand conversion', () => installVanilla({ bridges, settings, world }) ?? true);
// blocks into physics bodies via the converter
commandApi.physics = boot('physics converter', () => installPhysics({ bridges, settings, world, system })) || null;

// first join helper: hand out the bucket + sand once per player
try {
  world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    const player = ev.player;
    if (!player.getDynamicProperty('rw:kit')) {
      player.setDynamicProperty('rw:kit', true);
      player.sendMessage('Realistic Water loaded. Pour a normal water bucket, place plain sand, or use a physics converter. /rw:diag checks that everything booted.');
    }
  });
} catch (e) { log('playerSpawn unavailable', e?.message ?? e); }

world.afterEvents.worldLoad?.subscribe?.(() => {
  log('world loaded, realistic water ready');
  try { loadSettings(world.getDynamicProperty('rw:settings')); } catch { /* ignore */ }
  try {
    const physics = commandApi.physics;
    if (physics) {
      // proxy entities from a previous session have no body behind them
      for (const id of ['minecraft:overworld', 'minecraft:nether', 'minecraft:the_end']) {
        try { physics.sweepProxies(mc.world.getDimension(id)); } catch { /* dim missing */ }
      }
      const restored = physics.load();
      if (restored) log('restored', restored, 'physics bodies');
    }
  } catch { /* ignore */ }
  diag.add('world load event', true);
});

log('Realistic Water port active. Vanilla water/sand convert automatically. Help lines:', COMMAND_HELP.length);
