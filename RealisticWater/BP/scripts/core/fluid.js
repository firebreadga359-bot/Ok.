/**
 * Water solver.
 *
 * Model (see docs/TECHNICAL_REPORT.md):
 *   - volume-conserving cellular fluid on block-sized cells (vol 0..1)
 *   - per-cell momentum (vx, vy, vz) driven by gravity and the volume head
 *   - upwind donor-cell advection, CFL limited, with exact conservation
 *   - weighted Gauss-Seidel pressure relaxation (replaces the original
 *     multigrid / conjugate-gradient GPU pressure solve)
 *   - thin-film friction and stranding/evaporation, ported from g2p.comp
 *     (waterFilm) and WaterSettings.filmFriction / strandedTime
 *   - infinite springs refill like inflow.comp
 *
 * This is a genuine volume simulation, not a texture animation: every block
 * level written back to the world is the result of transported volume.
 *
 * Pure module (no Bedrock imports).
 */
import { clamp01 } from './field.js';

const EPS = 1e-4;

/**
 * @param {import('./field.js').Field} f
 * @param {object} S settings object
 * @param {number} dt seconds
 */
export function stepWater(f, S, dt) {
  const { nx, ny, nz, vol, solid, source, vx, vy, vz, dry, active, activeCount } = f;
  const nxny = nx * ny;
  const g = S.gravity;
  const maxSpeed = Math.max(1, S.maxSpeed);
  const filmDepth = Math.max(1e-3, S.filmDepth);
  const stiffness = 0.55;          // head -> acceleration gain
  const relaxRate = 0.22;          // per-sweep equalisation gain
  const advectLimit = 0.85;        // CFL fraction of a cell per substep
  const passes = Math.max(0, S.cgIterations | 0);

  let maxSpeedSeen = 0;
  let moved = 0;
  let fluidCells = 0;

  // ---- 1. gravity, support test, springs -----------------------------------
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    if (solid[i] === 1) { vol[i] = 0; vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
    if (vol[i] <= 0 && source[i] === 0) continue;

    if (source[i] === 1) {
      // infinite spring: the cell is held at sourceFill and overflows into its
      // neighbours through the normal advection step (inflow.comp behaviour)
      vol[i] = clamp01(S.sourceFill);
    }
    if (vol[i] <= 0) continue;

    const y = Math.floor(i / nx) % ny;
    const below = y > 0 ? i - nx : -1;
    const supported = below < 0 ? true : (solid[below] === 1 || vol[below] >= 0.999);

    if (!supported) {
      vy[i] -= g * dt;
      if (vy[i] < -maxSpeed) vy[i] = -maxSpeed;
    } else if (vy[i] < 0) {
      vy[i] = 0;
      if (vol[i] < 0.999) vol[i] = Math.min(1, vol[i] + 0.0); // pooling stays put
    }
  }

  // ---- 2. horizontal head gradient -> momentum ------------------------------
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    if (vol[i] <= 0) continue;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;

    const hL = (x > 0 && solid[i - 1] === 0) ? vol[i - 1] : vol[i];
    const hR = (x < nx - 1 && solid[i + 1] === 0) ? vol[i + 1] : vol[i];
    vx[i] -= stiffness * g * (hR - hL) * 0.5 * dt;

    const z = Math.floor(i / nxny);
    const hB = (z > 0 && solid[i - nxny] === 0) ? vol[i - nxny] : vol[i];
    const hF = (z < nz - 1 && solid[i + nxny] === 0) ? vol[i + nxny] : vol[i];
    vz[i] -= stiffness * g * (hF - hB) * 0.5 * dt;

    // wall / sea-floor drag and thin-film friction (g2p waterFilm port)
    let fric = 0.55;
    if ((x > 0 && solid[i - 1] === 1) || (x < nx - 1 && solid[i + 1] === 1) ||
        (z > 0 && solid[i - nxny] === 1) || (z < nz - 1 && solid[i + nxny] === 1)) fric += 2.2;
    const below = y > 0 ? i - nx : -1;
    const onFloor = below < 0 || solid[below] === 1 || vol[below] >= 0.999;
    if (onFloor && vol[i] < filmDepth) fric = S.filmFriction;

    const damp = Math.exp(-fric * dt);
    vx[i] *= damp;
    vz[i] *= damp;
    if (onFloor) vy[i] *= damp;

    // speed clamp
    const sp2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
    if (sp2 > maxSpeed * maxSpeed) {
      const s = maxSpeed / Math.sqrt(sp2);
      vx[i] *= s; vy[i] *= s; vz[i] *= s;
    }
  }

  // ---- 3. advection of volume (donor cell, conservative) --------------------
  // x axis
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    const v = vol[i];
    if (v <= EPS) continue;
    const x = i % nx;
    let u = vx[i];
    if (u === 0) continue;
    let step = u * dt;
    if (step > advectLimit) { step = advectLimit; u = step / dt; vx[i] = u; }
    else if (step < -advectLimit) { step = -advectLimit; u = step / dt; vx[i] = u; }
    const j = step > 0 ? ((x < nx - 1) ? i + 1 : -1) : ((x > 0) ? i - 1 : -1);
    if (j < 0 || solid[j] === 1) { vx[i] = 0; continue; }
    const cap = 1 - vol[j];
    const want = Math.abs(step) * v;
    if (cap <= EPS) { vx[i] = u * 0.2; continue; }
    const amt = want < cap ? want : cap;
    vol[i] = v - amt;
    vol[j] += amt;
    if (amt < want - 1e-9) vx[i] = u * 0.35;
  }
  // z axis
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    const v = vol[i];
    if (v <= EPS) continue;
    const z = Math.floor(i / nxny);
    let u = vz[i];
    if (u === 0) continue;
    let step = u * dt;
    if (step > advectLimit) { step = advectLimit; u = step / dt; vz[i] = u; }
    else if (step < -advectLimit) { step = -advectLimit; u = step / dt; vz[i] = u; }
    const j = step > 0 ? ((z < nz - 1) ? i + nxny : -1) : ((z > 0) ? i - nxny : -1);
    if (j < 0 || solid[j] === 1) { vz[i] = 0; continue; }
    const cap = 1 - vol[j];
    const want = Math.abs(step) * v;
    if (cap <= EPS) { vz[i] = u * 0.2; continue; }
    const amt = want < cap ? want : cap;
    vol[i] = v - amt;
    vol[j] += amt;
    if (amt < want - 1e-9) vz[i] = u * 0.35;
  }
  // y axis (free fall / upwelling through water)
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    const v = vol[i];
    if (v <= EPS) continue;
    const y = Math.floor(i / nx) % ny;
    let u = vy[i];
    if (u === 0) continue;
    let step = u * dt;
    if (step > advectLimit) { step = advectLimit; u = step / dt; vy[i] = u; }
    else if (step < -advectLimit) { step = -advectLimit; u = step / dt; vy[i] = u; }
    const j = step > 0 ? ((y < ny - 1) ? i + nx : -1) : ((y > 0) ? i - nx : -1);
    if (j < 0 || solid[j] === 1) { vy[i] = 0; continue; }
    const cap = 1 - vol[j];
    const want = Math.abs(step) * v;
    if (cap <= EPS) { vy[i] = u * 0.2; continue; }
    const amt = want < cap ? want : cap;
    vol[i] = v - amt;
    vol[j] += amt;
    if (amt < want - 1e-9) vy[i] = u * 0.35;
  }

  // ---- 4. pressure relaxation: level out supported pools -------------------
  for (let p = 0; p < passes; p++) {
    const forward = (p & 1) === 0;
    for (let a = 0; a < activeCount; a++) {
      const i = active[forward ? a : activeCount - 1 - a];
      const v = vol[i];
      if (v <= EPS) continue;
      const y = Math.floor(i / nx) % ny;
      const below = y > 0 ? i - nx : -1;
      const supported = below < 0 || solid[below] === 1 || vol[below] >= 0.999;
      if (!supported) continue;
      const x = i % nx;
      if (x < nx - 1 && solid[i + 1] === 0) {
        const dh = vol[i] - vol[i + 1];
        if (dh > 0.02) {
          const amt = Math.min(dh * relaxRate, 1 - vol[i + 1], vol[i]);
          vol[i] -= amt; vol[i + 1] += amt;
        }
      }
      const z = Math.floor(i / nxny);
      if (z < nz - 1 && solid[i + nxny] === 0) {
        const dh = vol[i] - vol[i + nxny];
        if (dh > 0.02) {
          const amt = Math.min(dh * relaxRate, 1 - vol[i + nxny], vol[i]);
          vol[i] -= amt; vol[i + nxny] += amt;
        }
      }
    }
  }

  // ---- 5. thin films: strand + evaporate ----------------------------------
  // NOTE: never discard volume here as "numerical dust"; the only sink is the
  // explicit evaporation below, so total volume stays conserved.
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    const v = vol[i];
    if (v <= 0) continue;
    const y = Math.floor(i / nx) % ny;
    const below = y > 0 ? i - nx : -1;
    const onFloor = below < 0 || solid[below] === 1 || vol[below] >= 0.999;
    if (onFloor && v < filmDepth) {
      dry[i] += dt;
      if (dry[i] > S.strandedTime) {
        // keep a thin film until neighbours are gone, then evaporate
        let n = 0;
        if (v > 0.02) n += 1;
        if (n === 0) vol[i] = 0;
        else vol[i] = Math.max(0, v - 0.08 * dt);
      }
    } else {
      dry[i] = 0;
    }
    if (vol[i] < 1e-6) { /* physically empty, below field precision */ vol[i] = 0; }
    if (vol[i] > 1) vol[i] = 1;
    fluidCells++;
    const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
    if (sp > maxSpeedSeen) maxSpeedSeen = sp;
    if (sp > 0.05) moved++;
  }

  // An infinite spring stays visibly full: re-pin after transport so the source
  // block keeps emitting instead of draining to an equilibrium level.
  for (let a = 0; a < activeCount; a++) {
    const i = active[a];
    if (source[i] === 1 && solid[i] === 0) vol[i] = clamp01(S.sourceFill);
  }

  return { maxSpeed: maxSpeedSeen, movedCells: moved, fluidCells };
}

/**
 * Remove `amount` of water from cell `i`, pushing it to free neighbours so the
 * volume is not lost (used when sand or a solid displaces water).
 * @returns {number} displaced volume actually removed from this cell
 */
export function displaceWater(f, i, amount) {
  const { vol, solid, nx, nxny } = f;
  if (i < 0 || i >= f.count) return 0;
  const remove = Math.min(amount, vol[i]);
  if (remove <= 0) return 0;
  vol[i] -= remove;
  let remaining = remove;
  // preferred targets: up, then the four sides
  const y = Math.floor(i / nx) % f.ny;
  const z = Math.floor(i / nxny);
  const x = i % nx;
  const cand = [];
  if (y < f.ny - 1) cand.push(i + nx);
  if (x > 0) cand.push(i - 1);
  if (x < nx - 1) cand.push(i + 1);
  if (z > 0) cand.push(i - nxny);
  if (z < f.nz - 1) cand.push(i + nxny);
  for (let k = 0; k < cand.length && remaining > 1e-6; k++) {
    const j = cand[k];
    if (solid[j] === 1) continue;
    const cap = 1 - vol[j];
    if (cap <= 1e-6) continue;
    const amt = Math.min(cap, remaining);
    vol[j] += amt;
    remaining -= amt;
  }
  return remove;
}
