/**
 * Bedrock-facing constants and small helpers.
 * All engine access goes through try/catch guards so a missing block or an
 * unloaded chunk cannot throw out of the simulation loop.
 */
import * as mc from '@minecraft/server';

export const NS = 'rw';
export const WATER_ID = 'rw:realistic_water';
export const SOURCE_ID = 'rw:realistic_water_source';
export const SAND_ID = 'rw:realistic_sand';
export const BUCKET_ID = 'rw:realistic_water_bucket';

export const FOG_ID = 'rw:underwater';
export const PARTICLE = {
  bubble: 'rw:bubble',
  foam: 'rw:foam',
  spray: 'rw:spray',
  dust: 'rw:sand_dust'
};

export const LEVEL_STATE = 'rw:level';
export const LAYERS_STATE = 'rw:layers';

export const log = (...a) => {
  try { console.warn('[realistic-water]', ...a); } catch { /* console unavailable */ }
};

/** Blocks our fluid may replace when it flows into a cell. */
const REPLACEABLE = new Set([
  'minecraft:air', 'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern',
  'minecraft:large_fern', 'minecraft:snow_layer', 'minecraft:deadbush', 'minecraft:seagrass',
  'minecraft:kelp', 'minecraft:vine', 'minecraft:dandelion', 'minecraft:poppy',
  'minecraft:blue_orchid', 'minecraft:allium', 'minecraft:azure_bluet', 'minecraft:oxeye_daisy',
  'minecraft:cornflower', 'minecraft:lily_of_the_valley', 'minecraft:sweet_berry_bush',
  'minecraft:red_flower', 'minecraft:yellow_flower', 'minecraft:double_plant',
  'minecraft:snow', 'minecraft:fire', 'minecraft:soul_fire', 'minecraft:structure_void'
]);

export function isReplaceableId(id) {
  return REPLACEABLE.has(id);
}

/** @returns {import('@minecraft/server').Block|undefined} */
export function getBlockSafe(dimension, x, y, z) {
  try {
    return dimension.getBlock({ x, y, z });
  } catch {
    return undefined;
  }
}

/**
 * Read one cell into the flat description the simulation understands.
 * Returns null when the chunk is not loaded (the caller keeps the cell blocked).
 */
export function readCell(dimension, x, y, z) {
  const b = getBlockSafe(dimension, x, y, z);
  if (!b) return null;
  const id = b.typeId;
  if (id === WATER_ID) {
    let level = 15;
    try { level = b.permutation.getState(LEVEL_STATE); } catch { /* state missing */ }
    if (typeof level !== 'number') level = 15;
    return { solid: false, isSand: false, isWater: true, level, source: false };
  }
  if (id === SOURCE_ID) {
    return { solid: false, isSand: false, isWater: true, level: 15, source: true };
  }
  if (id === SAND_ID) {
    let layers = 8;
    try { layers = b.permutation.getState(LAYERS_STATE); } catch { /* state missing */ }
    if (typeof layers !== 'number') layers = 8;
    return { solid: false, isSand: true, isWater: false, layers, level: -1, source: false };
  }
  let air = false;
  try { air = b.isAir === true; } catch { air = false; }
  // Vanilla water/lava cannot be replaced by our fluid, so anything that is not
  // air is treated as a wall. Otherwise our water would flow into a vanilla
  // water cell and be deleted when the write is refused.
  return { solid: !air, isSand: false, isWater: false, level: -1, source: false };
}

/** Write a water level into the world. level < 0 removes our water block. */
export function writeWaterLevel(dimension, x, y, z, level) {
  const b = getBlockSafe(dimension, x, y, z);
  if (!b) return false;
  const id = b.typeId;
  const ours = id === WATER_ID || id === SOURCE_ID;
  if (level < 0) {
    if (ours) b.setType('minecraft:air');
    return true;
  }
  if (!ours && !isReplaceableId(id)) return false;
  try {
    b.setPermutation(mc.BlockPermutation.resolve(WATER_ID, { [LEVEL_STATE]: level }));
    return true;
  } catch (e) {
    log('water write failed', x, y, z, e?.message ?? e);
    return false;
  }
}

/** Write sand layers into the world. layers 0 removes the block. */
export function writeSandLayers(dimension, x, y, z, layers) {
  const b = getBlockSafe(dimension, x, y, z);
  if (!b) return false;
  const id = b.typeId;
  const ours = id === SAND_ID;
  if (layers <= 0) {
    if (ours) b.setType('minecraft:air');
    return true;
  }
  if (!ours && !isReplaceableId(id)) return false;
  try {
    b.setPermutation(mc.BlockPermutation.resolve(SAND_ID, { [LAYERS_STATE]: Math.max(1, Math.min(8, layers)) }));
    return true;
  } catch (e) {
    log('sand write failed', x, y, z, e?.message ?? e);
    return false;
  }
}

export function placeSourceBlock(dimension, x, y, z) {
  const b = getBlockSafe(dimension, x, y, z);
  if (!b) return false;
  if (!isReplaceableId(b.typeId) && b.typeId !== WATER_ID && b.typeId !== SOURCE_ID) return false;
  try {
    b.setPermutation(mc.BlockPermutation.resolve(SOURCE_ID));
    return true;
  } catch (e) {
    log('source place failed', x, y, z, e?.message ?? e);
    return false;
  }
}

export function clearWaterBlock(dimension, x, y, z) {
  const b = getBlockSafe(dimension, x, y, z);
  if (!b) return false;
  if (b.typeId === WATER_ID || b.typeId === SOURCE_ID) {
    b.setType('minecraft:air');
    return true;
  }
  return false;
}
