/**
 * Solver orchestration: owns the water and sand fields, runs substeps, and turns
 * the continuous solution into block-level changes with hysteresis.
 *
 * Replaces WaterWorld/WaterRegion stepping from the original mod (which ran 1-4
 * GPU substeps per frame). Time is driven by the game tick here: each tick runs
 * up to `maxStepsPerFrame` substeps of at most `maxDt` seconds, exactly like the
 * original's fixed-step loop.
 *
 * Pure module (no Bedrock imports), unit tested in tools/tests.
 */
import { Field, makeRng } from './field.js';
import { stepWater, displaceWater } from './fluid.js';
import { stepSand } from './sand.js';
import { emitWhitewater } from './whitewater.js';
import { volumeToLevel, volumeToLayers } from './quantize.js';

export class Solver {
  constructor(settings) {
    this.S = settings;
    /** @type {Field|null} */
    this.water = null;
    /** @type {Field|null} */
    this.sandField = null;
    this.lastLevel = null;   // Int8Array of written water levels (-1 = air)
    this.lastLayers = null;  // Uint8Array of written sand layers (0 = none)
    this.acc = null;         // Float32Array whitewater accumulator
    this.particles = [];
    this.stats = {
      steps: 0, dt: 0, waterCells: 0, sandCells: 0, maxSpeed: 0,
      whitewater: 0, cellCount: 0, box: null, tick: 0
    };
    this._rng = makeRng(12345);
    this.time = 0;
  }

  /** Create or resize the fields. Returns true when the fields were (re)created. */
  allocate(minX, minY, minZ, nx, ny, nz) {
    const w = this.water;
    if (w && w.minX === minX && w.minY === minY && w.minZ === minZ &&
        w.nx === nx && w.ny === ny && w.nz === nz) return false;
    this.water = new Field(minX, minY, minZ, nx, ny, nz);
    this.sandField = new Field(minX, minY, minZ, nx, ny, nz);
    this.lastLevel = new Int8Array(nx * ny * nz).fill(-1);
    this.lastLayers = new Uint8Array(nx * ny * nz);
    this.acc = new Float32Array(nx * ny * nz).fill(0);
    return true;
  }

  /**
   * Move the field box by an integer offset, preserving the overlapping volume.
   * Used when the player walks away: the simulation state travels with the
   * volume instead of being thrown away (the original merged/split regions the
   * same way).
   */
  shift(dx, dy, dz) {
    const old = this.water;
    if (!old || (dx === 0 && dy === 0 && dz === 0)) return false;
    const nx = old.nx, ny = old.ny, nz = old.nz;
    const f = new Field(old.minX + dx, old.minY + dy, old.minZ + dz, nx, ny, nz);
    const s = new Field(f.minX, f.minY, f.minZ, nx, ny, nz);
    const lastLevel = new Int8Array(f.count).fill(-1);
    const lastLayers = new Uint8Array(f.count);
    const acc = new Float32Array(f.count);

    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const src = x + nx * (y + ny * z);
          const tx = x - dx, ty = y - dy, tz = z - dz;
          if (tx < 0 || ty < 0 || tz < 0 || tx >= nx || ty >= ny || tz >= nz) continue;
          const dst = tx + nx * (ty + ny * tz);
          f.vol[dst] = old.vol[src];
          f.vx[dst] = old.vx[src];
          f.vy[dst] = old.vy[src];
          f.vz[dst] = old.vz[src];
          f.dry[dst] = old.dry[src];
          f.source[dst] = old.source[src];
          f.solid[dst] = old.solid[src];
          s.sed[dst] = this.sandField.sed[src];
          s.solid[dst] = this.sandField.solid[src];
          lastLevel[dst] = this.lastLevel[src];
          lastLayers[dst] = this.lastLayers[src];
          acc[dst] = this.acc[src];
        }
      }
    }
    this.water = f;
    this.sandField = s;
    this.lastLevel = lastLevel;
    this.lastLayers = lastLayers;
    this.acc = acc;
    return true;
  }

  /** Reset the written-state shadow so the next step rewrites all levels. */
  invalidateWrites() {
    if (this.lastLevel) this.lastLevel.fill(-1);
    if (this.lastLayers) this.lastLayers.fill(0);
  }

  /**
   * Run one game tick of simulation.
   * @param {number} tickDt seconds since the last tick (usually 0.05)
   * @returns {{water:number[], sand:number[], waterLevels:number[], sandLayers:number[]}}
   *   flat index lists plus their new block levels/layers
   */
  step(tickDt) {
    const S = this.S;
    const f = this.water;
    const sf = this.sandField;
    if (!f || !sf) return { water: [], sand: [], waterLevels: [], sandLayers: [] };
    if (S.paused) return { water: [], sand: [], waterLevels: [], sandLayers: [] };

    f.rebuildActive();
    sf.rebuildActive();

    const steps = Math.max(1, Math.min(10, S.maxStepsPerFrame | 0));
    const dt = Math.max(0.001, Math.min(tickDt / steps, S.maxDt));
    let maxSpeed = 0;

    for (let k = 0; k < steps; k++) {
      const w = stepWater(f, S, dt);
      if (w.maxSpeed > maxSpeed) maxSpeed = w.maxSpeed;
      const s = stepSand(sf, S, dt, f, (cell, amount) => {
        displaceWater(f, cell, amount);
      });
      if (s.maxSpeed > maxSpeed) maxSpeed = s.maxSpeed;
      this.time += dt;
    }

    // whitewater
    if (S.whitewater) {
      this.particles.length = 0;
      emitWhitewater(f, S, tickDt, this.acc, this.particles, Math.max(0, S.bedrockParticleBudget | 0), this.stats.tick);
    }

    // ---- quantise back to block levels -------------------------------------
    const waterChanges = { idx: [], levels: [] };
    const sandChanges = { idx: [], layers: [] };
    const { vol, solid } = f;
    const lastLevel = this.lastLevel;

    // only cells that hold water or where water just left need a write
    for (let i = 0; i < f.count; i++) {
      const v = vol[i];
      let level = volumeToLevel(v);
      if (solid[i] === 1) level = -1;
      const prev = lastLevel[i];
      if (prev >= 0 && level >= 0) {
        // hysteresis: 0.6 of a level of deadband, like the original targetAmount
        const raw = v * 15;
        if (Math.abs(raw - prev) < 0.6) level = prev;
      }
      if (level !== prev) {
        lastLevel[i] = level;
        waterChanges.idx.push(i);
        waterChanges.levels.push(level);
      }
    }

    const sed = sf.sed;
    const lastLayers = this.lastLayers;
    for (let i = 0; i < sf.count; i++) {
      let layers = volumeToLayers(sed[i]);
      if (sf.solid[i] === 1) layers = 0;
      if (layers !== lastLayers[i]) {
        lastLayers[i] = layers;
        sandChanges.idx.push(i);
        sandChanges.layers.push(layers);
      }
    }

    // stats
    let waterCells = 0, sandCells = 0;
    for (let i = 0; i < f.count; i++) {
      if (vol[i] > 0.004) waterCells++;
      if (sed[i] > 0.03) sandCells++;
    }
    this.stats.steps = steps;
    this.stats.dt = dt;
    this.stats.waterCells = waterCells;
    this.stats.sandCells = sandCells;
    this.stats.maxSpeed = maxSpeed;
    this.stats.whitewater = this.particles.length;
    this.stats.cellCount = f.count;
    this.stats.box = { minX: f.minX, minY: f.minY, minZ: f.minZ, nx: f.nx, ny: f.ny, nz: f.nz };
    this.stats.tick++;

    return {
      water: waterChanges.idx,
      waterLevels: waterChanges.levels,
      sand: sandChanges.idx,
      sandLayers: sandChanges.layers
    };
  }

  /** Fill a sphere/cube of water or sand (ports /water:ball and /water:sand). */
  addEmitBox(minX, minY, minZ, maxX, maxY, maxZ, material) {
    const f = this.water;
    if (!f) return 0;
    let n = 0;
    for (let z = Math.floor(minZ); z < Math.ceil(maxZ); z++) {
      for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
        for (let x = Math.floor(minX); x < Math.ceil(maxX); x++) {
          const i = f.index(x, y, z);
          if (i < 0 || f.solid[i] === 1) continue;
          if (material === 'SAND') {
            this.sandField.sed[i] = 1;
          } else {
            f.vol[i] = 1;
            f.source[i] = 0;
          }
          n++;
        }
      }
    }
    this.invalidateWrites();
    return n;
  }

  /** Empty every simulated cell, optionally only one material. */
  clearAll(material) {
    const f = this.water;
    if (!f) return 0;
    let n = 0;
    if (material !== 'SAND') {
      for (let i = 0; i < f.count; i++) if (f.vol[i] > 0) { f.vol[i] = 0; n++; }
      f.source.fill(0);
    }
    if (material !== 'WATER') {
      for (let i = 0; i < this.sandField.count; i++) {
        if (this.sandField.sed[i] > 0) { this.sandField.sed[i] = 0; n++; }
      }
    }
    this.invalidateWrites();
    return n;
  }

  statsLine() {
    const s = this.stats;
    const box = s.box;
    const size = box ? `${box.nx}x${box.ny}x${box.nz}` : '-';
    return `water cells ${s.waterCells}, sand cells ${s.sandCells}, field ${size}, ` +
      `steps ${s.steps} x ${(s.dt * 1000).toFixed(1)}ms, vmax ${s.maxSpeed.toFixed(2)} m/s, ` +
      `whitewater ${s.whitewater}`;
  }
}
