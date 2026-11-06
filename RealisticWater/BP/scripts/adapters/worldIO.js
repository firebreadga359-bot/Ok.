/**
 * World bridge: seeds the solver from the world, applies its results back as
 * block states, and keeps a block cache so the solver never has to call the
 * engine for the same cell twice.
 *
 * Responsibilities map to the original mod as follows:
 *   - SolidCache.java            -> per-cell cache + section invalidation
 *   - WaterWorld.scanChunk       -> distance-ordered seeding queue
 *   - WaterWorld.syncBlocks      -> budgeted write queue with echo suppression
 *   - WaterWorld.Echoes          -> this.echo (ignore our own block updates)
 */
import {
  WATER_ID, SOURCE_ID, SAND_ID, readCell, writeWaterLevel, writeSandLayers, log
} from './bedrock.js';

const CELL_STRIDE = 1;

export class WorldBridge {
  /**
   * @param {import('@minecraft/server').Dimension} dimension
   * @param {import('../core/solver.js').Solver} solver
   * @param {object} settings
   */
  constructor(dimension, solver, settings) {
    this.dimension = dimension;
    this.solver = solver;
    this.S = settings;
    this.kind = dimension.id;

    /** @type {Map<string, object>} */
    this.cache = new Map();
    /** @type {Map<string, number>} echo of values we just wrote */
    this.echo = new Map();
    /** @type {Uint8Array|null} */
    this.seeded = null;
    this.seedOrder = null;
    this.seedPointer = 0;
    this.center = null;
    this.tick = 0;
    this.pendingWrites = 0;
  }

  static key(x, y, z) { return `${x},${y},${z}`; }

  /** Allocate / recenter the field around a position. Returns true when reseeded. */
  ensureField(px, py, pz) {
    const S = this.S;
    const R = Math.max(4, S.bedrockFieldRadius | 0);
    const H = Math.max(8, S.bedrockFieldHeight | 0);
    const nx = 2 * R + 1;
    const ny = H;
    const nz = 2 * R + 1;
    const cx = Math.floor(px);
    const cz = Math.floor(pz);
    const minY = Math.floor(py) - Math.floor(H * 0.55);
    const minX = cx - R;
    const minZ = cz - R;

    if (!this.solver.water) {
      this.solver.allocate(minX, minY, minZ, nx, ny, nz);
      this.resetSeeding();
      return true;
    }

    const f = this.solver.water;
    // drift correction: shift the whole solution when the player nears the edge
    const margin = Math.max(2, Math.floor(R * 0.35));
    let dx = 0, dy = 0, dz = 0;
    if (px - f.minX < margin) dx = Math.floor(px - f.minX) - margin;
    else if (f.minX + nx - px < margin) dx = Math.ceil(px - (f.minX + nx)) + margin;
    if (pz - f.minZ < margin) dz = Math.floor(pz - f.minZ) - margin;
    else if (f.minZ + nz - pz < margin) dz = Math.ceil(pz - (f.minZ + nz)) + margin;
    if (py - f.minY < 4) dy = Math.floor(py - f.minY) - 4;
    else if (f.minY + ny - py < 4) dy = Math.ceil(py - (f.minY + ny)) + 4;

    if (dx === 0 && dy === 0 && dz === 0) return false;

    dx = Math.max(-R, Math.min(R, dx));
    dy = Math.max(-H + 4, Math.min(H - 4, dy));
    dz = Math.max(-R, Math.min(R, dz));
    if (dx === 0 && dy === 0 && dz === 0) return false;

    this.solver.shift(dx, dy, dz);
    this.shiftSeeds(dx, dy, dz);
    this.cache.clear(); // coordinates changed under the cache
    this.echo.clear();
    return true;
  }

  resetSeeding() {
    const f = this.solver.water;
    if (!f) return;
    const n = f.count;
    this.seeded = new Uint8Array(n);
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    // distance order from the field centre so the player's neighbourhood is live first
    const cx = f.minX + f.nx * 0.5;
    const cy = f.minY + f.ny * 0.5;
    const cz = f.minZ + f.nz * 0.5;
    const dist = new Float32Array(n);
    for (let z = 0; z < f.nz; z++) {
      for (let y = 0; y < f.ny; y++) {
        for (let x = 0; x < f.nx; x++) {
          const i = x + f.nx * (y + f.ny * z);
          const wx = f.minX + x + 0.5 - cx;
          const wy = (f.minY + y + 0.5 - cy) * 1.4;
          const wz = f.minZ + z + 0.5 - cz;
          dist[i] = wx * wx + wy * wy + wz * wz;
        }
      }
    }
    Array.prototype.sort.call(order, (a, b) => dist[a] - dist[b]);
    this.seedOrder = order;
    this.seedPointer = 0;
    // unseeded cells stay blocked until read, so water can never flood terrain
    this.solver.water.solid.fill(1);
    this.solver.sandField.solid.fill(1);
    this.solver.water.vol.fill(0);
    this.solver.sandField.sed.fill(0);
  }

  shiftSeeds(dx, dy, dz) {
    const f = this.solver.water;
    if (!f || !this.seeded) { this.resetSeeding(); return; }
    const old = this.seeded;
    const next = new Uint8Array(f.count);
    const nx = f.nx, ny = f.ny, nz = f.nz;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const t = x + nx * (y + ny * z);
          const sx = x + dx, sy = y + dy, sz = z + dz;
          if (sx < 0 || sy < 0 || sz < 0 || sx >= nx || sy >= ny || sz >= nz) continue;
          next[t] = old[sx + nx * (sy + ny * sz)];
        }
      }
    }
    this.seeded = next;
    this.seedPointer = 0;
    // newly exposed cells are unknown: block them until seeded
    const w = this.solver.water;
    for (let i = 0; i < f.count; i++) {
      if (!next[i]) { w.solid[i] = 1; this.solver.sandField.solid[i] = 1; }
    }
    this.cache.clear();
    this.echo.clear();
  }

  /** Read a cell through the cache. */
  read(x, y, z) {
    const k = WorldBridge.key(x, y, z);
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    const cell = readCell(this.dimension, x, y, z);
    this.cache.set(k, cell);
    return cell;
  }

  invalidate(x, y, z) {
    this.cache.delete(WorldBridge.key(x, y, z));
  }

  /** Does the cache key hold one of our blocks (echo suppression)? */
  isEcho(k, value) {
    const v = this.echo.get(k);
    if (v === undefined) return false;
    const fresh = this.tick - v.tick < 30;
    if (!fresh) { this.echo.delete(k); return false; }
    return Math.abs(v.value - value) <= 1;
  }

  markEcho(x, y, z, value) {
    this.echo.set(WorldBridge.key(x, y, z), { value, tick: this.tick });
  }

  /**
   * Seed up to `budget` cells from the world, nearest first.
   * @returns {number} cells seeded
   */
  seed(budget) {
    const f = this.solver.water;
    const sf = this.solver.sandField;
    if (!f || !this.seeded || !this.seedOrder) return 0;
    let done = 0;
    let guard = 0;
    const limit = Math.max(0, budget | 0);
    while (done < limit && this.seedPointer < this.seedOrder.length && guard < this.seedOrder.length) {
      const i = this.seedOrder[this.seedPointer++];
      guard++;
      if (this.seeded[i]) continue;
      const x = f.minX + (i % f.nx);
      const y = f.minY + (Math.floor(i / f.nx) % f.ny);
      const z = f.minZ + Math.floor(i / (f.nx * f.ny));
      const cell = this.read(x, y, z);
      done++;
      if (!cell) continue; // leave blocked

      this.seeded[i] = 1;
      f.solid[i] = cell.solid || cell.isSand ? 1 : 0;
      sf.solid[i] = cell.solid ? 1 : 0;
      f.source[i] = cell.source ? 1 : 0;
      f.vol[i] = cell.isWater ? Math.max(0, Math.min(1, (cell.level + 1) / 16)) : 0;
      sf.sed[i] = cell.isSand ? Math.max(0, Math.min(1, (cell.layers ?? 8) / 8)) : 0;
      this.solver.lastLevel[i] = cell.isWater ? cell.level : -1;
      this.solver.lastLayers[i] = cell.isSand ? (cell.layers ?? 8) : 0;
    }
    return done;
  }

  /** Remaining cells to seed (for progress reporting). */
  seedRemaining() {
    if (!this.seeded) return 0;
    let n = 0;
    for (let i = 0; i < this.seeded.length; i += CELL_STRIDE) if (!this.seeded[i]) n++;
    return n;
  }

  /** Apply the solver's block changes, respecting the per-tick budget. */
  applyChanges(changes) {
    const f = this.solver.water;
    if (!f) return 0;
    const budget = Math.max(1, this.S.bedrockBlockBudget | 0);
    let applied = 0;

    for (let k = 0; k < changes.water.length && applied < budget; k++) {
      const i = changes.water[k];
      if (!this.seeded || !this.seeded[i]) continue;
      const x = f.minX + (i % f.nx);
      const y = f.minY + (Math.floor(i / f.nx) % f.ny);
      const z = f.minZ + Math.floor(i / (f.nx * f.ny));
      const level = changes.waterLevels[k];
      if (writeWaterLevel(this.dimension, x, y, z, level)) {
        this.markEcho(x, y, z, level);
        this.cache.set(WorldBridge.key(x, y, z),
          level < 0
            ? { solid: false, isSand: false, isWater: false, level: -1, source: false }
            : { solid: false, isSand: false, isWater: true, level, source: false });
        applied++;
      }
    }

    for (let k = 0; k < changes.sand.length && applied < budget; k++) {
      const i = changes.sand[k];
      if (!this.seeded || !this.seeded[i]) continue;
      const x = f.minX + (i % f.nx);
      const y = f.minY + (Math.floor(i / f.nx) % f.ny);
      const z = f.minZ + Math.floor(i / (f.nx * f.ny));
      const layers = changes.sandLayers[k];
      if (writeSandLayers(this.dimension, x, y, z, layers)) {
        this.markEcho(x, y, z, layers);
        this.cache.set(WorldBridge.key(x, y, z),
          layers <= 0
            ? { solid: false, isSand: false, isWater: false, level: -1, source: false }
            : { solid: false, isSand: true, isWater: false, layers, level: -1, source: false });
        applied++;
      }
    }

    this.pendingWrites = Math.max(0, changes.water.length + changes.sand.length - applied);
    this.tick++;
    if (this.cache.size > 90000) this.cache.clear();
    return applied;
  }

  /** React to an external block change: refresh one cell and notify the solver. */
  onBlockChanged(x, y, z, previousId, newId) {
    const k = WorldBridge.key(x, y, z);
    this.cache.delete(k);
    const f = this.solver.water;
    if (!f) return;
    const i = f.index(x, y, z);
    if (i < 0 || !this.seeded || !this.seeded[i]) return;
    const cell = readCell(this.dimension, x, y, z);
    if (!cell) return;
    f.solid[i] = cell.solid || cell.isSand ? 1 : 0;
    this.solver.sandField.solid[i] = cell.solid ? 1 : 0;
    f.source[i] = cell.source ? 1 : 0;
    if (cell.isWater) {
      // player placed or removed our water manually: adopt the block volume
      if (!this.isEcho(k, cell.level)) {
        f.vol[i] = Math.max(0, Math.min(1, (cell.level + 1) / 16));
        this.solver.lastLevel[i] = cell.level;
      }
    } else if (previousId === WATER_ID || previousId === SOURCE_ID) {
      if (!this.isEcho(k, -1)) { f.vol[i] = 0; this.solver.lastLevel[i] = -1; }
    } else if (!cell.isSand) {
      f.vol[i] = 0;
    }
    if (cell.isSand) {
      this.solver.sandField.sed[i] = Math.max(0, Math.min(1, (cell.layers ?? 8) / 8));
      this.solver.lastLayers[i] = cell.layers ?? 8;
    } else if (previousId === SAND_ID) {
      this.solver.sandField.sed[i] = 0;
      this.solver.lastLayers[i] = 0;
    }
  }

  /** Water volume at a world position, used by presentation/entity physics. */
  waterVolumeAt(x, y, z) {
    const f = this.solver.water;
    if (!f) return 0;
    const i = f.index(Math.floor(x), Math.floor(y), Math.floor(z));
    if (i < 0 || !this.seeded || !this.seeded[i]) return 0;
    return f.vol[i];
  }
}

export function bridgeLog(...args) { log(...args); }
