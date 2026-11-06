/**
 * Granular (sand) solver.
 *
 * The original mod runs sand as a second FLIP body with a stress tensor
 * (sand_stress.comp / sand_friction.comp / sand_scale.comp: yield stress =
 * sandFriction * pressure + sandCohesion, plus a friction-angle projection).
 * A full Mohr-Coulomb tensor solve is not affordable in 20 Hz JavaScript, so
 * this port keeps the same ingredients in reduced form:
 *
 *   - volume per cell (0..1), gravity driven vertical transport
 *   - angle-of-repose avalanching driven by the surface height difference,
 *     with the yield threshold derived from sandFriction and cohesion from
 *     sandCohesion (the same two settings the original exposes)
 *   - a lower repose angle and higher flow rate underwater (buoyancy + drag),
 *     matching how the original sand body behaves inside water
 *   - terminal settling speed and water-current drag (sand washes downstream)
 *   - sand that flows into a water cell displaces that water (handled by the
 *     caller through onEnteredWater)
 *
 * Pure module (no Bedrock imports).
 */
import { clamp01 } from './field.js';

const EPS = 1e-4;

/**
 * @param {import('./field.js').Field} f sand field (uses .sed)
 * @param {object} S settings
 * @param {number} dt seconds
 * @param {import('./field.js').Field|null} water water field for coupling
 * @param {(cellIndex:number, amount:number)=>void} [onEnteredWater]
 */
export function stepSand(f, S, dt, water, onEnteredWater) {
  const { nx, ny, nz, sed, solid, vx, vy, vz, active, activeCount } = f;
  const nxny = nx * ny;
  const g = S.gravity;
  const maxSpeed = Math.max(1, S.maxSpeed);

  // repose thresholds: sandFriction 0.7 -> ~35 deg slope; cohesive piles hold more
  const friction = clamp01(S.sandFriction);
  const reposeDry = clamp01(0.28 + friction * 0.55);          // ~0.66 at default
  const reposeWet = clamp01(0.18 + friction * 0.35);          // shallower underwater
  const cohesion = Math.max(0, S.sandCohesion);
  const flowRate = 1.6 * Math.max(0.1, S.sandStiffness * 8);   // per second
  const restSpeed = Math.max(0.01, S.sandRestSpeed);

  let movedCells = 0;
  let sandCells = 0;
  let maxSpeedSeen = 0;

  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    if (sed[i] <= 0) continue;

    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / nxny);
    const below = y > 0 ? i - nx : -1;
    const wet = water ? water.vol[i] > 0.25 : false;

    // ---- gravity -----------------------------------------------------------
    const supported = below < 0 || solid[below] === 1 || sed[below] >= 0.995;
    if (!supported) {
      // buoyancy: submerged grains accelerate at (1 - rho_w/rho_s) ~ 0.4 g
      vy[i] -= g * (wet ? 0.42 : 1.0) * dt;
      const terminal = wet ? 1.1 : maxSpeed;
      if (vy[i] < -terminal) vy[i] = -terminal;
    } else if (vy[i] < 0) {
      vy[i] = 0;
    }

    // ---- vertical transport -------------------------------------------------
    if (below >= 0 && solid[below] === 0) {
      let u = vy[i];
      if (u < 0) {
        let step = -u * dt;
        if (step > 0.9) { step = 0.9; u = -step / dt; vy[i] = u; }
        const cap = 1 - sed[below];
        if (cap > EPS) {
          const want = step * sed[i];
          const amt = want < cap ? want : cap;
          sed[i] -= amt;
          sed[below] += amt;
          if (amt > 0.02 && wet) onEnteredWater?.(below, amt);
        } else {
          vy[i] = 0;
        }
      }
    }

    // ---- angle of repose (avalanche) ---------------------------------------
    if (sed[i] <= 0) continue;
    const slope = wet ? reposeWet : reposeDry;
    const rate = flowRate * (wet ? 1.8 : 1.0);
    const neighbours = [
      x > 0 ? i - 1 : -1,
      x < nx - 1 ? i + 1 : -1,
      z > 0 ? i - nxny : -1,
      z < nz - 1 ? i + nxny : -1
    ];
    for (let k = 0; k < 4; k++) {
      const j = neighbours[k];
      if (j < 0 || solid[j] === 1) continue;
      const dh = sed[i] - sed[j];
      if (dh <= slope) continue;
      // cohesion holds small amounts together unless the pile is steep
      if (sed[i] < cohesion && dh < slope * 2.0) continue;
      const cap = 1 - sed[j];
      if (cap <= EPS) continue;
      let want = (dh - slope) * rate * dt;
      if (want > sed[i]) want = sed[i];
      if (want > cap) want = cap;
      if (want <= EPS) continue;
      sed[i] -= want;
      sed[j] += want;
      if (wet) onEnteredWater?.(j, want);
      if (sed[i] <= 0) break;
    }
    if (sed[i] <= 0) { sed[i] = 0; continue; }

    // ---- water current drag (sand washes downstream) -----------------------
    if (wet && water) {
      const drag = 0.35 * dt;
      const ux = water.vx[i], uz = water.vz[i];
      const speed = Math.hypot(ux, uz);
      if (speed > 0.15) {
        const dirX = ux >= 0 ? 1 : -1;
        const dirZ = uz >= 0 ? 1 : -1;
        const tx = x + (dirX > 0 ? 1 : -1);
        const tz = z + (dirZ > 0 ? 1 : -1);
        if (tx >= 0 && tx < nx && Math.abs(ux) > Math.abs(uz)) {
          const j = i + dirX;
          const cap = 1 - sed[j];
          if (solid[j] === 0 && cap > EPS) {
            const amt = Math.min(sed[i], cap, Math.abs(ux) * drag);
            sed[i] -= amt; sed[j] += amt;
            onEnteredWater?.(j, amt);
          }
        } else if (tz >= 0 && tz < nz) {
          const j = i + dirZ * nxny;
          const cap = 1 - sed[j];
          if (solid[j] === 0 && cap > EPS) {
            const amt = Math.min(sed[i], cap, Math.abs(uz) * drag);
            sed[i] -= amt; sed[j] += amt;
            onEnteredWater?.(j, amt);
          }
        }
      }
    }

    // ---- rest --------------------------------------------------------------
    const sp = Math.hypot(vx[i], vy[i], vz[i]);
    if (sp < restSpeed) { vx[i] = 0; vy[i] = 0; vz[i] = 0; }
    if (sp > maxSpeedSeen) maxSpeedSeen = sp;
    if (sed[i] < 1e-3) { sed[i] = 0; continue; }
    if (sed[i] > 1) sed[i] = 1;
    sandCells++;
    movedCells++;
  }

  return { maxSpeed: maxSpeedSeen, movedCells, sandCells };
}
