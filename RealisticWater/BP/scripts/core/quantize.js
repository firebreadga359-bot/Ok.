/**
 * Volume -> block level quantisation.
 *
 * The original mod wrote a 1..8 fluid amount back into the world
 * (WaterSyncPayload.stateFor / WaterWorld.targetAmount) and 1..8 sand layers with
 * targetLayers(). Both functions are ported here with the same hysteresis so a
 * body of water does not flicker between adjacent block levels every tick.
 *
 * Bedrock water blocks carry 16 visual levels (rw:level 0..15); the sim keeps the
 * 8-step hysteresis of the original and maps it to the finer visual grid.
 */

/** Fluid amount (1..8) for a 0..1 fill fraction - port of WaterWorld.targetAmount. */
export function targetAmount(fill, current) {
  let target;
  if (fill >= 0.8) target = 8;
  else if (fill >= 0.12) target = Math.min(7, Math.max(1, Math.round(fill * 8)));
  else target = 0;

  if (current > 0 && target === 0 && fill > 0.05) return current;
  if (current === 0 && target > 0 && fill < 0.2) return 0;
  if (current > 0 && target > 0 && current < 8 && target < 8 && Math.abs(target - current) <= 1) return current;
  return target;
}

/** Sand layers (0..8) for a 0..1 fill fraction - port of WaterWorld.targetLayers. */
export function targetLayers(fill, speed, current) {
  const raw = fill * 8;
  if (speed > 1.5 && raw > current) return current;
  const target = raw < 0.5 ? 0 : Math.min(8, Math.max(1, Math.round(raw)));
  if (current > 0 && target === 0 && raw > 0.25) return current;
  if (current > 0 && target > 0 && Math.abs(raw - current) < 0.75) return current;
  return target;
}

/** Amount (0..8) -> Bedrock visual level (0..15). 8/8 maps to the full 15 level. */
export function amountToLevel(amount) {
  if (amount <= 0) return -1; // means "air"
  if (amount >= 8) return 15;
  return Math.max(0, Math.min(15, Math.round((amount / 8) * 15)));
}

/** Bedrock visual level (0..15) -> amount (1..8). */
export function levelToAmount(level) {
  if (level < 0) return 0;
  if (level >= 15) return 8;
  return Math.max(1, Math.min(8, Math.round((level / 15) * 8)));
}

/** Volume fraction -> visual level directly (finer than the 8-step world state). */
export function volumeToLevel(vol) {
  if (vol <= 0.004) return -1;
  const level = Math.round(Math.min(1, vol) * 15);
  return level < 0 ? 0 : level;
}

/** Sand volume -> layer block state 1..8 (0 = no block). */
export function volumeToLayers(vol) {
  if (vol <= 0.03) return 0;
  return Math.min(8, Math.max(1, Math.round(vol * 8)));
}
