/**
 * Simulation field: a dense box of block-sized cells holding fluid volume,
 * momentum and material flags.
 *
 * This replaces the original GPU buffers (cellDens/cellCount/vel faces) with
 * typed arrays that the script engine can iterate. Layout is x-major so that
 * neighbours along x are +-1 (cheapest axis).
 *
 * Pure module (no Bedrock imports) so the solver can be unit tested in Node.
 */

export const KIND_AIR = 0;
export const KIND_FLUID = 1;
export const KIND_SOLID = 2;

export class Field {
  /**
   * @param {number} minX @param {number} minY @param {number} minZ
   * @param {number} nx @param {number} ny @param {number} nz
   */
  constructor(minX, minY, minZ, nx, ny, nz) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.nx = nx; this.ny = ny; this.nz = nz;
    const n = nx * ny * nz;
    this.count = n;
    this.sx = 1;
    this.sy = nx;
    this.sz = nx * ny;

    /** fluid volume fraction 0..1 */
    this.vol = new Float32Array(n);
    /** granular volume fraction 0..1 (sand field only) */
    this.sed = new Float32Array(n);
    /** 1 = static solid (obstacle), 0 = free */
    this.solid = new Uint8Array(n);
    /** 1 = infinite spring / inflow source */
    this.source = new Uint8Array(n);
    /** cell-centred velocity, m/s */
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    /** thin-film dryness timer, seconds */
    this.dry = new Float32Array(n);
    /** per-cell material kind, mirrors cellFlags in the original shaders */
    this.kind = new Uint8Array(n);
    /** scratch: cell indices that hold material this step */
    this.active = new Uint32Array(n);
    this.activeCount = 0;

    this.minYTerrain = minY;
    this.maxYTerrain = minY + ny - 1;
  }

  /** @returns {number} flat index, or -1 when outside */
  index(x, y, z) {
    x -= this.minX; y -= this.minY; z -= this.minZ;
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return -1;
    return x + this.nx * (y + this.ny * z);
  }

  coordX(i) { return this.minX + (i % this.nx); }
  coordY(i) { return this.minY + (Math.floor(i / this.nx) % this.ny); }
  coordZ(i) { return this.minZ + Math.floor(i / (this.nx * this.ny)); }

  /** @returns {boolean} true when (x,y,z) is inside the field */
  contains(x, y, z) {
    return x >= this.minX && y >= this.minY && z >= this.minZ &&
      x < this.minX + this.nx && y < this.minY + this.ny && z < this.minZ + this.nz;
  }

  inBounds(i) { return i >= 0 && i < this.count; }

  isSolidAt(x, y, z) {
    const i = this.index(x, y, z);
    return i >= 0 ? this.solid[i] === 1 : true;
  }

  /** Total water volume in the field (for conservation tests / stats). */
  totalWater() {
    let s = 0;
    const v = this.vol;
    for (let i = 0; i < v.length; i++) s += v[i];
    return s;
  }

  totalSand() {
    let s = 0;
    const v = this.sed;
    for (let i = 0; i < v.length; i++) s += v[i];
    return s;
  }

  /** Rebuild the kind flags and active list after external edits. */
  rebuildActive() {
    const { vol, sed, solid, source, kind, active } = this;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const s = solid[i] === 1;
      const f = !s && (vol[i] > 1e-4 || sed[i] > 1e-4 || source[i] === 1);
      kind[i] = s ? KIND_SOLID : (f ? KIND_FLUID : KIND_AIR);
      if (f) active[n++] = i;
    }
    this.activeCount = n;
    return n;
  }

  /** Reset volume/velocity but keep solids/sources. */
  clearFluid() {
    this.vol.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.vz.fill(0);
    this.dry.fill(0);
    this.activeCount = 0;
  }

  clearSand() {
    this.sed.fill(0);
  }

  /** Copy the obstacle mask from a neighbour field (used by the sand sim). */
  copySolids(from, ignoreKinds) {
    this.solid.set(from.solid);
    if (ignoreKinds && from.vol) {
      // water is not an obstacle for sand: cells that only hold our water stay free
      for (let i = 0; i < this.count; i++) {
        if (this.solid[i] === 0 && from.vol[i] > 0.05) this.solid[i] = 0;
      }
    }
  }
}

/**
 * Cheap deterministic PRNG (mulberry32) used for particle jitter, matching the
 * role of hash()/rand() in the original shaders.
 */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}
