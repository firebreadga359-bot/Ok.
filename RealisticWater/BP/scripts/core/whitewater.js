/**
 * Whitewater emission.
 *
 * Port of the emission half of the original GPU pipeline:
 *   potential.comp  - per-cell "trapped air" (curl of the velocity field next to
 *                     static walls) and "wave crest" (relative velocity against
 *                     the density gradient on surface cells)
 *   g2p.comp        - emitWhitewater(): amount = energyCurve *
 *                     (wwTrappedAirRate * trapped + wwWaveCrestRate * crest) * dt,
 *                     capped per cell and per particle
 *   ww_update.comp  - type selection: 0 = bubble (rises), 1 = foam (follows the
 *                     surface flow), 2 = spray (ballistic)
 *
 * The Bedrock port turns those emissions into custom particle effects instead of
 * GPU billboards; the thresholds, rates and energy curve are the original ones.
 *
 * Pure module (no Bedrock imports).
 */
import { makeRng } from './field.js';

function curve(v, lo, hi) {
  return Math.max(0, Math.min(1, (v - lo) / Math.max(hi - lo, 1e-6)));
}

/**
 * @param {import('./field.js').Field} f water field
 * @param {object} S settings
 * @param {number} dt
 * @param {Float32Array} acc per-cell emission accumulator (field.count)
 * @param {Array<{x:number,y:number,z:number,vx:number,vy:number,vz:number,type:number,life:number}>} out
 * @param {number} budget max particles this tick
 * @param {number} tick monotonic counter (seeds the RNG)
 */
export function emitWhitewater(f, S, dt, acc, out, budget, tick) {
  if (!S.whitewater || budget <= 0) return 0;
  const { nx, ny, nz, vol, solid, vx, vy, vz, active, activeCount } = f;
  const nxny = nx * ny;
  const rng = makeRng(0x9e3779b9 ^ (tick * 2654435761));
  const cellLimit = Math.max(1, S.wwCellLimit | 0);
  const maxPerCell = Math.max(1, S.wwMaxPerParticle | 0);
  let spawned = 0;

  for (let a = 0; a < activeCount && spawned < budget; a++) {
    const i = active[a];
    if (vol[i] <= 0.02) continue;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / nxny);

    // surface only (potential.comp: surface = a face neighbour is air)
    let surface = false;
    let nearStaticWall = false;
    for (let k = 0; k < 6; k++) {
      const j = k === 0 ? (x < nx - 1 ? i + 1 : -1)
        : k === 1 ? (x > 0 ? i - 1 : -1)
          : k === 2 ? (y < ny - 1 ? i + nx : -1)
            : k === 3 ? (y > 0 ? i - nx : -1)
              : k === 4 ? (z < nz - 1 ? i + nxny : -1)
                : (z > 0 ? i - nxny : -1);
      if (j < 0) { surface = true; nearStaticWall = true; continue; }
      if (solid[j] === 1) { nearStaticWall = true; continue; }
      if (vol[j] <= 1e-4) surface = true;
    }
    if (!surface) { acc[i] = 0; continue; }

    // curl of the cell-centred velocity (potential.comp)
    const xm = x > 0 ? i - 1 : i, xp = x < nx - 1 ? i + 1 : i;
    const ym = y > 0 ? i - nx : i, yp = y < ny - 1 ? i + nx : i;
    const zm = z > 0 ? i - nxny : i, zp = z < nz - 1 ? i + nxny : i;
    const dydx = (vy[xp] - vy[xm]) * 0.5;
    const dzdx = (vz[xp] - vz[xm]) * 0.5;
    const dxdy = (vx[yp] - vx[ym]) * 0.5;
    const dzdy = (vz[yp] - vz[ym]) * 0.5;
    const dxdz = (vx[zp] - vx[zm]) * 0.5;
    const dydz = (vy[zp] - vy[zm]) * 0.5;
    const cx = dydz - dzdy;
    const cy = dzdx - dxdz;
    const cz = dxdy - dydx;
    const curl = Math.hypot(cx, cy, cz);
    const trapped = nearStaticWall ? 0 : curl;

    // crest: relative velocity against the surface gradient
    const gx = vol[xp] - vol[xm];
    const gy = vol[yp] - vol[ym];
    const gz = vol[zp] - vol[zm];
    const glen = Math.hypot(gx, gy, gz);
    let crest = 0;
    if (glen > 1e-3) {
      const mx = (vx[xp] + vx[xm] + vx[yp] + vx[ym] + vx[zp] + vx[zm]) / 6;
      const my = (vy[xp] + vy[xm] + vy[yp] + vy[ym] + vy[zp] + vy[zm]) / 6;
      const mz = (vz[xp] + vz[xm] + vz[yp] + vz[ym] + vz[zp] + vz[zm]) / 6;
      const rx = vx[i] - mx, ry = vy[i] - my, rz = vz[i] - mz;
      crest = Math.max(0, -(rx * gx + ry * gy + rz * gz) / glen);
    }

    const speed = Math.hypot(vx[i], vy[i], vz[i]);
    const energy = 0.5 * speed * speed;
    const iTA = curve(trapped, S.wwTrappedAirMin, S.wwTrappedAirMax);
    const iWC = curve(crest, S.wwWaveCrestMin, S.wwWaveCrestMax);
    const iK = curve(energy, S.wwEnergyMin, S.wwEnergyMax);
    let amount = iK * (S.wwTrappedAirRate * iTA + S.wwWaveCrestRate * iWC) * dt;
    if (amount <= 0) { acc[i] = 0; continue; }

    acc[i] += amount;
    let count = Math.floor(acc[i]);
    if (count <= 0) continue;
    if (count > maxPerCell) count = maxPerCell;
    if (spawned + count > budget) count = budget - spawned;
    acc[i] -= count;

    for (let k = 0; k < count; k++) {
      const life = S.wwFoamLifeMin + rng() * Math.max(0, S.wwFoamLifeMax - S.wwFoamLifeMin);
      // type: spray for fast surface flow, foam for cresting, bubble for trapped air
      let type = 1;
      if (speed > S.wwSprayThreshold && iWC > 0.35) type = 2;
      else if (speed < S.wwBubbleThreshold && iTA > 0.4) type = 0;
      out.push({
        x: f.minX + x + 0.15 + rng() * 0.7,
        y: f.minY + y + 0.55 + rng() * 0.4,
        z: f.minZ + z + 0.15 + rng() * 0.7,
        vx: vx[i] * (0.55 + rng() * 0.5),
        vy: vy[i] * 0.4 + (type === 2 ? 1.2 + rng() : 0.15),
        vz: vz[i] * (0.55 + rng() * 0.5),
        type,
        life
      });
      spawned++;
    }
    if (spawned >= budget) break;
  }
  return spawned;
}

/** Curl magnitude per cell, for /rw:stats diagnostics. */
export function totalEnergy(f) {
  let e = 0;
  const { vol, vx, vy, vz } = f;
  for (let i = 0; i < f.count; i++) {
    if (vol[i] <= 0) continue;
    e += 0.5 * (vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]) * vol[i];
  }
  return e;
}
