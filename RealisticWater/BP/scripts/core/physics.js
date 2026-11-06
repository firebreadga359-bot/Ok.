/**
 * Block-scale rigid body physics.
 *
 * Every converted block becomes a 1x1x1 body with its own real mass in kg, so
 * the same integrator gives stone, wool, ice and gold completely different
 * behaviour: a punch barely moves 19 t of gold but launches 40 kg of wool,
 * anything under 1000 kg floats when it lands in simulated water (water density
 * is 1000 kg/m3), and heavy fast bodies transfer enough energy to hurt entities.
 *
 * Bedrock cannot render a moving block with sub-block precision, so bodies move
 * on the block grid: velocity is continuous (m/s), the body consumes whole cells
 * from its motion accumulator, and each cell step is a real block move in the
 * world. That keeps the physics honest - what you see is the actual block - while
 * still giving momentum, bounce, friction, stacking and buoyancy.
 *
 * Pure module: no Bedrock imports, unit tested in tools/tests.
 */

/** Water density in kg/m^3. A 1 m^3 water cell weighs 1000 kg. */
export const WATER_DENSITY = 1000;

/** Measured-ish densities of common blocks, in kg per block. */
const MASS_EXACT = {
  'minecraft:air': 0,
  'minecraft:water': 1000,
  'minecraft:sand': 1600,
  'minecraft:red_sand': 1600,
  'minecraft:gravel': 1700,
  'minecraft:stone': 2600,
  'minecraft:cobblestone': 2400,
  'minecraft:mossy_cobblestone': 2300,
  'minecraft:deepslate': 2900,
  'minecraft:cobbled_deepslate': 2900,
  'minecraft:dirt': 1300,
  'minecraft:coarse_dirt': 1300,
  'minecraft:grass_block': 1300,
  'minecraft:podzol': 1200,
  'minecraft:mycelium': 1200,
  'minecraft:farmland': 1200,
  'minecraft:dirt_with_roots': 1200,
  'minecraft:clay': 1500,
  'minecraft:terracotta': 1900,
  'minecraft:ice': 917,
  'minecraft:packed_ice': 917,
  'minecraft:blue_ice': 917,
  'minecraft:frosted_ice': 900,
  'minecraft:snow_block': 300,
  'minecraft:obsidian': 3000,
  'minecraft:crying_obsidian': 3000,
  'minecraft:netherrack': 2000,
  'minecraft:end_stone': 2500,
  'minecraft:glass': 2500,
  'minecraft:tinted_glass': 2500,
  'minecraft:iron_block': 7870,
  'minecraft:gold_block': 19300,
  'minecraft:copper_block': 8960,
  'minecraft:diamond_block': 3510,
  'minecraft:emerald_block': 2760,
  'minecraft:netherite_block': 20000,
  'minecraft:oak_log': 700,
  'minecraft:oak_planks': 600,
  'minecraft:spruce_log': 650,
  'minecraft:birch_log': 640,
  'minecraft:white_wool': 40,
  'minecraft:hay_block': 300,
  'minecraft:tnt': 1000,
  'minecraft:anvil': 7000,
  'minecraft:bookshelf': 500,
  'minecraft:melon_block': 900,
  'minecraft:pumpkin': 500,
  'minecraft:sponge': 200,
  'minecraft:slime_block': 1100,
  'minecraft:honey_block': 1400,
  'minecraft:amethyst_block': 2650,
  'minecraft:calcite': 2700,
  'minecraft:tuff': 2300,
  'minecraft:moss_block': 400,
  'minecraft:mud': 1700,
  'minecraft:soul_sand': 1400,
  'minecraft:magma': 2600,
  'minecraft:bamboo_block': 350,
  'rw:realistic_sand': 1600
};

/** Substring rules for everything not listed exactly (specific first). */
const MASS_RULES = [
  ['netherite', 20000], ['gold', 19300], ['copper', 8900], ['iron', 7800],
  ['anvil', 7000], ['diamond', 3510], ['emerald', 2760], ['quartz', 2650],
  ['amethyst', 2650], ['deepslate', 2900], ['obsidian', 3000], ['glass', 2500],
  ['stone', 2600], ['brick', 2000], ['terracotta', 1900], ['gravel', 1700],
  ['sand', 1600], ['clay', 1500], ['dirt', 1300], ['mud', 1700],
  ['ice', 917], ['wool', 40], ['leaves', 80], ['log', 700], ['wood', 650],
  ['planks', 600], ['stairs', 500], ['slab', 300], ['snow', 300], ['hay', 300],
  ['moss', 400], ['sponge', 200], ['bamboo', 350], ['carpet', 30]
];

/** Material classes used by the visual proxy entity (see adapters/physics.js). */
export const BODY_CLASSES = ['stone', 'dirt', 'sand', 'wood', 'metal', 'wool', 'ice', 'leaves'];

/** Which proxy texture an airborne body uses, chosen from its block id. */
export function bodyClass(typeId) {
  const id = String(typeId ?? '').replace('minecraft:', '');
  if (/wool|carpet/.test(id)) return 'wool';
  if (/leaves/.test(id)) return 'leaves';
  if (/ice/.test(id)) return 'ice';
  if (/plank|log|wood|fence|barrel|chest|bamboo|bookshelf/.test(id)) return 'wood';
  if (/iron|gold|copper|netherite|diamond|emerald|anvil|metal|cauldron|chain/.test(id)) return 'metal';
  if (/sand|gravel/.test(id)) return 'sand';
  if (/dirt|grass|mud|clay|podzol|farmland|mycelium|moss|soul_soil/.test(id)) return 'dirt';
  return 'stone';
}

/** Mass in kg for a block type id. Unknown blocks get a neutral 1500 kg. */
export function massOf(typeId) {
  const id = String(typeId ?? '');
  if (Object.prototype.hasOwnProperty.call(MASS_EXACT, id)) return MASS_EXACT[id];
  const bare = id.startsWith('minecraft:') ? id.slice(10) : id;
  for (const [needle, mass] of MASS_RULES) {
    if (bare.includes(needle)) return mass;
  }
  return 1500;
}

/** Human-readable mass + what that mass means in water. */
export function massLabel(mass) {
  const kg = Math.round(mass);
  const tons = (kg / 1000).toFixed(kg % 1000 === 0 ? 0 : 1);
  const amount = kg >= 1000 ? `${tons} t` : `${kg} kg`;
  const behaviour = mass < WATER_DENSITY ? 'floats' : (mass < 1800 ? 'sinks slowly' : 'sinks fast');
  return `${amount} (${behaviour})`;
}

/** Tunables; overridable per world (settings live in core/settings.js). */
export const DEFAULT_PHYSICS = {
  gravity: 24,          // blocks/s^2 (2.5 g: game-feel, not a physics lecture)
  maxSpeed: 55,         // blocks/s, hard clamp
  airDrag: 0.15,        // 1/s
  waterDrag: 5.5,       // 1/s at full submersion
  restitution: 0.22,    // bounce of stone-ish bodies
  friction: 0.5,        // ground drag 1/s
  sleepSpeed: 0.35,     // m/s below which a supported body counts as at rest
  sleepTicks: 8,
  maxCellsPerTick: 8,   // anti-tunnel cap
  punchImpulse: 3000,   // N*s delivered by an unarmed hit
  damageEnergy: 24000,  // J above which an impact can hurt entities
  maxDamage: 6
};

export class PhysicsWorld {
  /**
   * @param {{grid?: object, config?: object}} opts
   *   grid.tryMove(body, from, to) -> boolean   (engine permission + block write)
   *   grid.isSolid(x, y, z) -> boolean           (immovable world geometry)
   *   grid.waterAt(x, y, z) -> number            (simulated water volume 0..1)
   */
  constructor(opts = {}) {
    this.grid = opts.grid ?? {};
    this.cfg = { ...DEFAULT_PHYSICS, ...(opts.config ?? {}) };
    /** @type {object[]} */
    this.bodies = [];
    /** @type {Map<string, number>} cell -> body id */
    this.byCell = new Map();
    /** @type {Array<{x:number,y:number,z:number,speed:number,mass:number,energy:number,typeId:string}>} */
    this.impacts = [];
    /** @type {Array<{x:number,y:number,z:number,volume:number}>} */
    this.splashes = [];
    this.nextId = 1;
    this.ticks = 0;
    this.removed = [];
  }

  static key(x, y, z) { return `${x},${y},${z}`; }

  /** Create a body occupying cell (x,y,z). Does not write the block itself. */
  spawn({ typeId, states, x, y, z, vx = 0, vy = 0, vz = 0 }) {
    const mass = massOf(typeId);
    const body = {
      id: this.nextId++,
      typeId,
      states: states ?? {},
      x: Math.floor(x), y: Math.floor(y), z: Math.floor(z),
      vx, vy, vz,
      ax: 0, ay: 0, az: 0,
      mass,
      restitution: this.cfg.restitution,
      friction: this.cfg.friction,
      onGround: false,
      submerged: 0,
      age: 0,
      rested: 0,
      sleeping: false,
      /** true once at rest: the adapter swaps the visual proxy for the real block */
      settled: false
    };
    this.bodies.push(body);
    this.byCell.set(PhysicsWorld.key(body.x, body.y, body.z), body.id);
    return body;
  }

  bodyAt(x, y, z) {
    const id = this.byCell.get(PhysicsWorld.key(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (id === undefined) return undefined;
    return this.bodies.find(b => b.id === id);
  }

  remove(id) {
    const i = this.bodies.findIndex(b => b.id === id);
    if (i < 0) return false;
    const [body] = this.bodies.splice(i, 1);
    const key = PhysicsWorld.key(body.x, body.y, body.z);
    if (this.byCell.get(key) === id) this.byCell.delete(key);
    return true;
  }

  clear() {
    const n = this.bodies.length;
    this.bodies.length = 0;
    this.byCell.clear();
    this.impacts.length = 0;
    this.splashes.length = 0;
    return n;
  }

  /** Wake a body that something moved from outside. */
  wake(body) {
    if (!body) return;
    body.sleeping = false;
    body.rested = 0;
  }

  /**
   * Apply a punch. Impulse is divided by mass, so the same hit that nudges an
   * anvil sends wool flying - that is the point of per-block weight.
   * @returns {number} resulting speed in m/s
   */
  push(body, dir, impulse = this.cfg.punchImpulse) {
    if (!body) return 0;
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dv = Math.min(14, impulse / Math.max(1, body.mass));
    body.vx += (dir.x / len) * dv;
    body.vy += Math.max(0.15, (dir.y / len) * dv);
    body.vz += (dir.z / len) * dv;
    this.wake(body);
    return Math.hypot(body.vx, body.vy, body.vz);
  }

  /** Content of one physics step. dt is seconds (a game tick is 0.05). */
  step(dt) {
    if (!this.bodies.length) { this.ticks++; return this.bodies.length; }
    const h = Math.max(0.001, Math.min(dt, 0.05));
    const sub = 2;
    const s = h / sub;
    const c = this.cfg;

    for (const body of this.bodies) {
      if (body.sleeping) continue;
      body.age += h;
      for (let k = 0; k < sub; k++) this._integrate(body, s);

      const slow = Math.abs(body.vx) < c.sleepSpeed &&
        Math.abs(body.vy) < c.sleepSpeed && Math.abs(body.vz) < c.sleepSpeed;
      if (slow && body.onGround) {
        if (++body.rested >= c.sleepTicks) {
          body.sleeping = true;
          body.settled = true;
          body.vx = body.vy = body.vz = 0;
        }
      } else {
        body.rested = 0;
      }

      if (body.y < -70 && !body.dead) { body.dead = true; this.removed.push(body); }
    }

    if (this.removed.length) {
      for (const body of this.removed) this.remove(body.id);
      this.removed.length = 0;
    }
    this.ticks++;
    return this.bodies.length;
  }

  _integrate(body, dt) {
    const c = this.cfg;
    const water = this.grid.waterAt
      ? Math.max(0, Math.min(1, this.grid.waterAt(body.x, body.y, body.z) || 0))
      : 0;
    body.submerged = water;

    // A grounded body must not keep accumulating gravity: otherwise its vertical
    // speed never drops below the sleep threshold and it jitters forever.
    body.onGround = this._supported(body);
    // Suppress gravity only for a body already at rest on the ground. A body that
    // is still travelling downward must keep its speed so the landing registers
    // an impact and bounces; zeroing it here made blocks hover one cell up.
    const restingContact = body.onGround && body.vy <= 0 && body.vy > -c.sleepSpeed;
    if (restingContact) {
      body.vy = 0;
      body.ay = 0;
    } else {
      body.vy -= c.gravity * dt;
    }

    if (water > 0.02) {
      // Archimedes: buoyant acceleration = g * (displaced water mass / body mass)
      const buoyancy = (WATER_DENSITY * water) / Math.max(1, body.mass);
      body.vy += c.gravity * dt * buoyancy;
      const damp = 1 / (1 + c.waterDrag * water * dt);
      body.vx *= damp; body.vy *= damp; body.vz *= damp;
    } else {
      const damp = 1 / (1 + c.airDrag * dt);
      body.vx *= damp; body.vz *= damp;
      if (body.onGround) {
        const ground = 1 / (1 + c.friction * 6 * dt);
        body.vx *= ground;
        body.vz *= ground;
      }
    }

    const speed = Math.hypot(body.vx, body.vy, body.vz);
    if (speed > c.maxSpeed) {
      const f = c.maxSpeed / speed;
      body.vx *= f; body.vy *= f; body.vz *= f;
    }

    body.ax += body.vx * dt;
    body.ay += body.vy * dt;
    body.az += body.vz * dt;

    body.onGround = this._supported(body);

    let budget = c.maxCellsPerTick;
    // order matters: vertical first so a body lands before it slides
    const order = body.vy <= 0 ? ['y', 'x', 'z'] : ['y', 'x', 'z'];
    while (budget-- > 0) {
      let moved = false;
      for (const axis of order) {
        if (this._axisMove(body, axis)) moved = true;
      }
      if (!moved) break;
    }

    body.onGround = this._supported(body);
  }

  _supported(body) {
    if (!this.grid.isSolid) return false;
    return !!this.grid.isSolid(body.x, body.y - 1, body.z);
  }

  _axisMove(body, axis) {
    const accKey = axis === 'x' ? 'ax' : axis === 'y' ? 'ay' : 'az';
    const velKey = axis === 'x' ? 'vx' : axis === 'y' ? 'vy' : 'vz';
    const acc = body[accKey];
    if (Math.abs(acc) < 1) return false;
    const dir = Math.sign(acc);
    const from = { x: body.x, y: body.y, z: body.z };
    const to = { x: body.x, y: body.y, z: body.z };
    to[axis] += dir;

    if (this._tryMove(body, from, to)) {
      body[axis] = to[axis];
      body[accKey] -= dir;
      return true;
    }

    const speed = Math.abs(body[velKey]);
    body[accKey] = 0;
    if (speed > 2.5) this._impact(body, from, speed);

    if (axis === 'y') {
      if (dir < 0) {
        body.onGround = true;
        body.vy = speed > 3 ? speed * body.restitution : 0;
      } else {
        body.vy = -speed * body.restitution;
      }
    } else {
      body[velKey] = -body[velKey] * body.restitution * 0.4;
    }
    return false;
  }

  _tryMove(body, from, to) {
    const key = PhysicsWorld.key(to.x, to.y, to.z);
    const occupant = this.byCell.get(key);
    if (occupant !== undefined && occupant !== body.id) return false; // stacks on other bodies

    const water = this.grid.waterAt
      ? Math.max(0, this.grid.waterAt(to.x, to.y, to.z) || 0)
      : 0;

    if (this.grid.tryMove && !this.grid.tryMove(body, from, to)) return false;

    const oldKey = PhysicsWorld.key(from.x, from.y, from.z);
    if (this.byCell.get(oldKey) === body.id) this.byCell.delete(oldKey);
    this.byCell.set(key, body.id);
    if (water > 0.05) this.splashes.push({ x: to.x, y: to.y, z: to.z, volume: water });
    return true;
  }

  _impact(body, cell, speed) {
    const energy = 0.5 * body.mass * speed * speed;
    this.impacts.push({
      x: cell.x, y: cell.y, z: cell.z,
      speed, mass: body.mass, energy, typeId: body.typeId
    });
    return energy;
  }

  statsLine() {
    if (!this.bodies.length) return 'physics bodies 0';
    let fastest = 0, heavy = 0;
    for (const b of this.bodies) {
      const s = Math.hypot(b.vx, b.vy, b.vz);
      if (s > fastest) fastest = s;
      if (b.mass > heavy) heavy = b.mass;
    }
    return `physics bodies ${this.bodies.length} (asleep ${this.bodies.filter(b => b.sleeping).length}), ` +
      `fastest ${fastest.toFixed(1)} m/s, heaviest ${heavy} kg`;
  }
}
