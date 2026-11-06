/**
 * Items: the realistic water bucket and sand layer stacking.
 *
 * Original behaviour (ModContent / BucketItem):
 *   - bucket places a realistic water source block
 *   - source blocks are infinite springs (RealisticWaterBlock.INFINITE)
 *   - sand stacks up to 8 layers when the same item is used on it
 */
import * as mc from '@minecraft/server';
import { BUCKET_ID, SAND_ID, WATER_ID, SOURCE_ID, readCell, placeSourceBlock } from './bedrock.js';

function countItem(player, typeId) {
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    if (!inv) return 0;
    let n = 0;
    for (let s = 0; s < inv.size; s++) {
      const it = inv.getItem(s);
      if (it && it.typeId === typeId) n += it.amount;
    }
    return n;
  } catch { return 0; }
}

function consumeOne(player, typeId) {
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    if (!inv) return false;
    for (let s = 0; s < inv.size; s++) {
      const it = inv.getItem(s);
      if (it && it.typeId === typeId) {
        if (it.amount <= 1) inv.setItem(s, undefined);
        else { it.amount -= 1; inv.setItem(s, it); }
        return true;
      }
    }
  } catch { /* inventory unavailable */ }
  return false;
}

function giveItem(player, typeId, amount = 1) {
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    if (!inv) return false;
    const leftover = inv.addItem(new mc.ItemStack(typeId, amount));
    return !leftover;
  } catch { return false; }
}

function isCreative(player) {
  try { return player.getGameMode?.() === 'creative' || player.getGameMode?.() === 'Creative'; } catch { return false; }
}

/** Face vector for a block face name. */
export function faceOffset(face) {
  switch (face) {
    case 'Up': return { x: 0, y: 1, z: 0 };
    case 'Down': return { x: 0, y: -1, z: 0 };
    case 'North': return { x: 0, y: 0, z: -1 };
    case 'South': return { x: 0, y: 0, z: 1 };
    case 'East': return { x: 1, y: 0, z: 0 };
    case 'West': return { x: -1, y: 0, z: 0 };
    default: return { x: 0, y: 1, z: 0 };
  }
}

/**
 * @param {{bridges:Map<string,any>, settings:object}} ctx
 */
export function registerItems(ctx) {
  const api = ctx;

  const placeBucket = (player, dimension, x, y, z) => {
    if (!placeSourceBlock(dimension, x, y, z)) {
      player.sendMessage('Not enough room to place realistic water here');
      return;
    }
    const bridge = api.bridges.get(dimension.id);
    if (bridge) {
      const f = bridge.solver.water;
      const i = f?.index(x, y, z) ?? -1;
      if (i >= 0) { f.vol[i] = 1; f.source[i] = 1; }
      bridge.invalidate(x, y, z);
    }
    if (!isCreative(player)) {
      consumeOne(player, BUCKET_ID);
      if (!giveItem(player, 'minecraft:bucket', 1)) {
        // never swallow the empty bucket: drop it if the inventory is full
        try { dimension.spawnItem(new mc.ItemStack('minecraft:bucket', 1), player.location); } catch { /* ignore */ }
      }
    }
  };

  /** The event fires once per hand; act on the first occurrence only. */
  const firstEvent = (ev) => ev.isFirstEvent !== false;

  try {
    mc.world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
      if (!firstEvent(ev)) return;
      const player = ev.player;
      const item = ev.itemStack;
      if (!item) return;
      const dimension = player.dimension;

      // No sand special case here: placing the sand item next to sand already
      // creates a realistic sand block, and the solver merges the layers. Doing
      // both would consume two blocks for one placement.
      if (item.typeId !== BUCKET_ID) return;

      // sneaking on our water: fill the bucket (pick the water up)
      if (player.isSneaking && (ev.block?.typeId === WATER_ID || ev.block?.typeId === SOURCE_ID)) {
        const loc = ev.block.location;
        try { ev.block.setType('minecraft:air'); } catch { return; }
        const bridge = api.bridges.get(dimension.id);
        if (bridge) {
          const f = bridge.solver.water;
          const i = f?.index(loc.x, loc.y, loc.z) ?? -1;
          if (i >= 0) { f.vol[i] = 0; f.source[i] = 0; }
          bridge.invalidate(loc.x, loc.y, loc.z);
        }
        // the bucket in hand stays; only the water was lifted
        return;
      }

      // normal use: pour a source block against the clicked face
      const off = faceOffset(ev.blockFace);
      const target = {
        x: ev.block.location.x + off.x,
        y: ev.block.location.y + off.y,
        z: ev.block.location.z + off.z
      };
      placeBucket(player, dimension, target.x, target.y, target.z);
    });
  } catch (e) {
    console.warn('[realistic-water] interact subscription failed', e?.message ?? e);
  }

  // pouring into open air (bucket used while looking at the sky)
  try {
    mc.world.afterEvents.itemUse.subscribe((ev) => {
      if (ev.itemStack?.typeId !== BUCKET_ID) return;
      const player = ev.source;
      if (!player || !player.isSneaking) return;
      const view = player.getViewDirection();
      const loc = player.location;
      const target = {
        x: Math.floor(loc.x + view.x * 1.6),
        y: Math.floor(loc.y + 1.0 + view.y * 1.6),
        z: Math.floor(loc.z + view.z * 1.6)
      };
      placeBucket(player, player.dimension, target.x, target.y, target.z);
    });
  } catch (e) {
    console.warn('[realistic-water] itemUse subscription failed', e?.message ?? e);
  }
}

/** Give the player the mod's starting kit (used by /rw:help on first join). */
export function giveKit(player) {
  giveItem(player, BUCKET_ID, 1);
  giveItem(player, SAND_ID, 16);
}

export { countItem, giveItem, consumeOne, readCell };
