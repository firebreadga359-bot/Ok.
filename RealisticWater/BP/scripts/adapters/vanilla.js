/**
 * Vanilla integration: ordinary water and sand join the simulation with no
 * commands, no special items and no setup.
 *
 *   - a normal `minecraft:water_bucket` pour converts the local body of vanilla
 *     water into `rw:realistic_water` (the poured cell becomes a spring)
 *   - a normally placed `minecraft:sand` block becomes `rw:realistic_sand`
 *   - using vanilla sand on an existing realistic sand block stacks layers
 *
 * Bounded on purpose: only connected bodies of at most MAX_BODY cells within
 * BODY_RADIUS of the pour are converted. Oceans and large lakes stay vanilla,
 * because draining a 3000-cell ocean into the field would be neither stable nor
 * wanted. Conversion is skipped when a chunk is not loaded.
 */
import * as mc from '@minecraft/server';
import {
  WATER_ID, SOURCE_ID, SAND_ID, LEVEL_STATE, LAYERS_STATE,
  getBlockSafe, placeSourceBlock, log
} from './bedrock.js';
import { faceOffset } from './items.js';

const VANILLA_WATER = 'minecraft:water';
const VANILLA_SAND = 'minecraft:sand';
const WATER_BUCKET = 'minecraft:water_bucket';

const MAX_BODY = 320;
const BODY_RADIUS = 8;
const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
];

/** Vanilla `liquid_depth` (0 = source) to our 0..15 surface level. */
function depthToLevel(block) {
  let depth = 0;
  try { depth = block.permutation.getState('liquid_depth'); } catch { /* state missing */ }
  if (typeof depth !== 'number') depth = 0;
  return depth <= 0 ? 15 : Math.max(1, 15 - depth);
}

function clamp01(v) { return v < 0.05 ? 0.05 : (v > 1 ? 1 : v); }

/** Tell the running solver about a freshly converted water cell. */
function adoptWater(ctx, dimension, x, y, z, level, isSource) {
  const bridge = ctx.bridges.get(dimension.id);
  if (!bridge) return;
  bridge.invalidate(x, y, z);
  const f = bridge.solver.water;
  const i = f ? f.index(x, y, z) : -1;
  if (i < 0) return;
  if (bridge.seeded && !bridge.seeded[i]) return; // seeding will read it later
  f.solid[i] = 0;
  f.vol[i] = clamp01((level + 1) / 16);
  f.source[i] = isSource ? 1 : 0;
  bridge.solver.lastLevel[i] = level;
}

/** Tell the running solver about a freshly converted sand cell. */
function adoptSand(ctx, dimension, x, y, z, layers) {
  const bridge = ctx.bridges.get(dimension.id);
  if (!bridge) return;
  bridge.invalidate(x, y, z);
  const f = bridge.solver.water;
  const i = f ? f.index(x, y, z) : -1;
  if (i < 0) return;
  if (bridge.seeded && !bridge.seeded[i]) return;
  bridge.sandField.solid[i] = 0;
  bridge.sandField.sed[i] = Math.max(0, Math.min(1, layers / 8));
  bridge.solver.lastLayers[i] = layers;
}

/**
 * Walk the connected vanilla water body from a seed.
 * @returns {Array<{x:number,y:number,z:number,block:any,level:number}>|null}
 *   null when the chunk is unloaded or the body is larger than MAX_BODY.
 */
function collectPond(dimension, sx, sy, sz) {
  const cells = [];
  const seen = new Set([`${sx},${sy},${sz}`]);
  const queue = [[sx, sy, sz]];
  let head = 0;
  while (head < queue.length) {
    const [x, y, z] = queue[head++];
    const b = getBlockSafe(dimension, x, y, z);
    if (!b) return null;
    if (b.typeId !== VANILLA_WATER) continue;
    if (Math.abs(x - sx) > BODY_RADIUS || Math.abs(y - sy) > BODY_RADIUS ||
        Math.abs(z - sz) > BODY_RADIUS) continue;
    cells.push({ x, y, z, block: b, level: depthToLevel(b) });
    if (cells.length > MAX_BODY) return null;
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const k = `${x + dx},${y + dy},${z + dz}`;
      if (!seen.has(k)) { seen.add(k); queue.push([x + dx, y + dy, z + dz]); }
    }
  }
  return cells;
}

/**
 * Convert vanilla water around (x,y,z) into simulated water and make the seed
 * cell a spring. Returns the number of converted cells, or -1 when the body was
 * too large to touch.
 */
export function convertWaterBody(ctx, dimension, x, y, z) {
  const cells = collectPond(dimension, x, y, z);
  if (cells === null) return -1;

  let converted = 0;
  for (const c of cells) {
    try {
      c.block.setPermutation(mc.BlockPermutation.resolve(WATER_ID, { [LEVEL_STATE]: c.level }));
    } catch (e) {
      log('vanilla water conversion failed', c.x, c.y, c.z, e?.message ?? e);
      continue;
    }
    adoptWater(ctx, dimension, c.x, c.y, c.z, c.level, false);
    converted++;
  }

  // The cell the player poured into feeds the body, like a placed spring.
  if (placeSourceBlock(dimension, x, y, z)) adoptWater(ctx, dimension, x, y, z, 15, true);
  return converted;
}

/** Convert one vanilla sand block; returns true when it was replaced. */
export function convertSandBlock(ctx, dimension, x, y, z) {
  const b = getBlockSafe(dimension, x, y, z);
  if (!b || b.typeId !== VANILLA_SAND) return false;
  try {
    b.setPermutation(mc.BlockPermutation.resolve(SAND_ID, { [LAYERS_STATE]: 8 }));
  } catch (e) {
    log('vanilla sand conversion failed', x, y, z, e?.message ?? e);
    return false;
  }
  adoptSand(ctx, dimension, x, y, z, 8);
  return true;
}

/** One "too big to simulate" notice per player per 10 s. */
const warned = new Map();

function warnTooBig(player) {
  const now = mc.system.currentTick;
  const last = warned.get(player.id) ?? -9999;
  if (now - last < 200) return;
  warned.set(player.id, now);
  try {
    player.sendMessage('That water body is too large to simulate (limit 320 blocks). ' +
      'Bucket-sized pools convert automatically.');
  } catch { /* player left */ }
}

/** Stack a layer when vanilla sand is used on a realistic sand block. */
function stackVanillaSand(player, block) {
  try {
    const layers = block.permutation.getState(LAYERS_STATE) ?? 8;
    if (layers >= 8) return false;
    block.setPermutation(mc.BlockPermutation.resolve(SAND_ID, { [LAYERS_STATE]: layers + 1 }));
    const container = player.getComponent('minecraft:inventory')?.container;
    if (container) {
      for (let s = 0; s < container.size; s++) {
        const it = container.getItem(s);
        if (it && it.typeId === VANILLA_SAND) {
          if (it.amount <= 1) container.setItem(s, undefined);
          else { it.amount -= 1; container.setItem(s, it); }
          break;
        }
      }
    }
    return true;
  } catch { return false; }
}

/**
 * @param {{bridges:Map<string,any>, settings:object, world:any}} ctx
 */
export function installVanilla(ctx) {
  // 1. Normally placed blocks: sand joins the granular solver, water poured from
  //    a bucket joins the fluid solver.
  try {
    mc.world.afterEvents.blockPlace.subscribe((ev) => {
      const b = ev.block;
      if (!b) return;
      const loc = b.location;
      try {
        if (b.typeId === VANILLA_SAND) {
          convertSandBlock(ctx, b.dimension, loc.x, loc.y, loc.z);
        } else if (b.typeId === VANILLA_WATER) {
          const player = ev.player;
          if (convertWaterBody(ctx, b.dimension, loc.x, loc.y, loc.z) < 0 && player) {
            warnTooBig(player);
          }
        }
      } catch (e) { log('vanilla place conversion failed', e?.message ?? e); }
    });
  } catch (e) { log('blockPlace unavailable for vanilla conversion', e?.message ?? e); }

  // 2. Water bucket / sand use. The bucket's own vanilla placement is converted
  //    a couple of ticks later, so this works whether or not blockPlace fires
  //    for fluid placement on the current build.
  try {
    mc.world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
      const item = ev.itemStack;
      const player = ev.player;
      if (!item || !player) return;

      if (item.typeId === VANILLA_SAND && ev.block?.typeId === SAND_ID) {
        stackVanillaSand(player, ev.block);
        return;
      }
      if (item.typeId !== WATER_BUCKET || player.isSneaking) return;

      const off = faceOffset(ev.blockFace);
      const dimension = player.dimension;
      const target = {
        x: ev.block.location.x + off.x,
        y: ev.block.location.y + off.y,
        z: ev.block.location.z + off.z
      };
      try {
        mc.system.runTimeout(() => {
          try {
            if (convertWaterBody(ctx, dimension, target.x, target.y, target.z) < 0) {
              warnTooBig(player);
            }
          } catch (e) { log('bucket conversion failed', e?.message ?? e); }
        }, 2);
      } catch (e) { log('runTimeout unavailable', e?.message ?? e); }
    });
  } catch (e) { log('interact unavailable for vanilla conversion', e?.message ?? e); }

  log('vanilla water and sand convert automatically (no commands needed)');
}
