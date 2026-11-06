/**
 * Simulation settings.
 *
 * Names and defaults mirror me.skaffy.client.water.WaterSettings from the
 * original Java mod wherever the value has a meaning in the Bedrock solver.
 * Extra settings (bedrock-only) are prefixed with `bedrock` and documented as
 * additions rather than ports.
 *
 * Pure module: no @minecraft/server import, so it can be unit tested in Node.
 */

/** @typedef {'low'|'medium'|'high'|'ultra'} QualityName */

const DEFAULTS = {
  // ---- original WaterSettings (ported) ----
  resolution: 1,            // Bedrock cells are block-sized; original used 6 sub-cells/block
  boxMargin: 6,             // cells of margin around the water body
  cfl: 2.0,
  maxDt: 0.025,             // 40 Hz substep ceiling
  maxStepsPerFrame: 4,      // simulation substeps per game tick
  cgIterations: 5,          // -> pressure relaxation sweeps in the Bedrock solver
  extrapolationLayers: 4,
  flipRatio: 0.99,          // -> momentum retention
  volumeCorrection: 2.0,
  maxSpeed: 40.0,
  gravity: 9.81,
  whitewater: true,
  wwTrappedAirRate: 30.0,
  wwWaveCrestRate: 45.0,
  wwEnergyMin: 1.0,
  wwEnergyMax: 6.0,
  wwTrappedAirMin: 2.0,
  wwTrappedAirMax: 14.0,
  wwWaveCrestMin: 0.4,
  wwWaveCrestMax: 2.5,
  wwFoamLifeMin: 1.5,
  wwFoamLifeMax: 4.0,
  wwBubbleBuoyancy: 2.5,
  wwBubbleDrag: 0.6,
  wwSprayDrag: 0.4,
  wwSprayThreshold: 3.0,
  wwBubbleThreshold: 6.0,
  wwMaxPerParticle: 4,
  wwCellLimit: 12,
  filmFriction: 40.0,
  filmDepth: 0.08,
  sheetFill: false,
  sheetSmoothing: 2.0,
  strandedTime: 1.5,
  strandedNeighbors: 12,
  surfaceSubdivision: 1,    // original: 2 (marching-cubes subdivision); Bedrock: 16 levels/cell
  surfaceKernel: 3.0,
  surfaceRadius: 0.9,
  surfaceIso: 0.5,
  dropletThreshold: 0.35,
  nearCull: 0.05,
  particleRadius: 0.4,
  thicknessScale: 1.0,
  refraction: 0.15,
  absorbR: 0.45,
  absorbG: 0.12,
  absorbB: 0.07,
  scatterR: 0.03,
  scatterG: 0.08,
  scatterB: 0.11,
  scatterDensity: 0.5,
  underwaterFog: 0.1,
  surfaceSmoothing: 0.6,
  detailStrength: 0.4,
  detailScale: 6.0,
  detailSpeed: 1.4,
  roughness: 0.06,
  specular: 6.0,
  wetDarkening: 0.3,
  filmShading: 0.25,
  wwRadius: 0.012,
  wwMaxPixels: 2.5,
  foamCoverage: 1.2,
  foamSize: 3.0,
  foamBubbleSize: 0.05,
  bubbleAlpha: 0.25,
  sprayAlpha: 0.35,
  sourceFill: 0.9,
  bucketMakesSource: false,
  flowSounds: true,
  flowSoundVolume: 1.0,
  sandFriction: 0.7,
  sandCohesion: 0.15,
  sandFrictionIterations: 8,
  sandStiffness: 0.12,
  sandFlipRatio: 0.95,
  sandVolumeCorrection: 1.5,
  sandRestSpeed: 0.15,
  sandMinCellCount: 1,
  sandSurfaceIso: 0.5,
  sandSurfaceSmoothing: 0.6,
  sandGrainSize: 0.02,
  sandGrainsPerParticle: 6,
  sandGrainSpread: 0.45,
  sandGrainMinPixels: 0.7,
  sandColorR: 0.86,
  sandColorG: 0.79,
  sandColorB: 0.6,
  sandColorVariation: 0.2,
  sandAo: 0.6,
  sandSounds: true,

  // ---- Bedrock-only additions (not in the Java mod) ----
  /** How far (blocks) the simulation field tracks a player. */
  bedrockFieldRadius: 16,
  /** Vertical extent of the field around the player. */
  bedrockFieldHeight: 24,
  /** Max custom-block writes per game tick (anti-lag budget). */
  bedrockBlockBudget: 320,
  /** Max cells that may be simulated per tick (active volume cap). */
  bedrockMaxActiveCells: 30000,
  /** Sections (16^3) read per tick when scanning the world. */
  bedrockScanSectionsPerTick: 2,
  /** Foam/spray particles spawned per tick, globally. */
  bedrockParticleBudget: 90,
  /** Apply buoyancy/drag impulses to entities standing in simulated water. */
  bedrockEntityPhysics: true,
  /** Push the underwater fog definition while the camera is submerged. */
  bedrockUnderwaterFog: true,
  /** Play flow/splash sounds from moving water. */
  bedrockFlowSounds: true,
  /** Pause the whole simulation (kept in world data). */
  paused: false
};

/** Runtime settings object (mutated by /rw:set). */
export const settings = { ...DEFAULTS };

/** Immutable copy of the original defaults, used by /rw:settings reset and tests. */
export const DEFAULTS_FROZEN = Object.freeze({ ...DEFAULTS });

/**
 * Quality presets. The highest preset is the default; these only trade field
 * size / particle counts / iteration counts, never the simulation model itself.
 */
export const PRESETS = {
  low: {
    bedrockFieldRadius: 10,
    bedrockFieldHeight: 16,
    bedrockBlockBudget: 140,
    bedrockMaxActiveCells: 7000,
    bedrockScanSectionsPerTick: 1,
    bedrockParticleBudget: 30,
    cgIterations: 2,
    maxStepsPerFrame: 2
  },
  medium: {
    bedrockFieldRadius: 12,
    bedrockFieldHeight: 20,
    bedrockBlockBudget: 220,
    bedrockMaxActiveCells: 12500,
    bedrockScanSectionsPerTick: 1,
    bedrockParticleBudget: 55,
    cgIterations: 3,
    maxStepsPerFrame: 3
  },
  high: {
    bedrockFieldRadius: 16,
    bedrockFieldHeight: 24,
    bedrockBlockBudget: 320,
    bedrockMaxActiveCells: 26000,
    bedrockScanSectionsPerTick: 2,
    bedrockParticleBudget: 90,
    cgIterations: 5,
    maxStepsPerFrame: 4
  },
  ultra: {
    bedrockFieldRadius: 20,
    bedrockFieldHeight: 28,
    bedrockBlockBudget: 480,
    bedrockMaxActiveCells: 47000,
    bedrockScanSectionsPerTick: 3,
    bedrockParticleBudget: 140,
    cgIterations: 8,
    maxStepsPerFrame: 5
  }
};

/** @param {QualityName} name */
export function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return false;
  Object.assign(settings, preset);
  return true;
}

const INT_KEYS = new Set();
const FLOAT_KEYS = new Set();
const BOOL_KEYS = new Set();
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (typeof v === 'boolean') BOOL_KEYS.add(k);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && k !== 'gravity' && k !== 'cfl' && k !== 'filmDepth' &&
        k !== 'sandRestSpeed' && k !== 'sandStiffness' && k !== 'sandCohesion' &&
        k !== 'sandGrainSize' && k !== 'volumeCorrection' && k !== 'sandVolumeCorrection' &&
        k !== 'flipRatio' && k !== 'sandFlipRatio' && k !== 'surfaceIso' && k !== 'sandSurfaceIso' &&
        k !== 'sheetSmoothing' && k !== 'surfaceSmoothing' && k !== 'sandSurfaceSmoothing' &&
        k !== 'maxDt' && k !== 'refraction' && k !== 'thicknessScale') {
      INT_KEYS.add(k);
    } else {
      FLOAT_KEYS.add(k);
    }
  }
}

/** Is `name` a settable setting? */
export function isSetting(name) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, name);
}

export function settingNames() {
  return Object.keys(DEFAULTS).sort();
}

/**
 * Set a setting from a command string, with the same coercion behaviour as
 * WaterSettings.set() (int/float/boolean).
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function setSetting(name, raw) {
  if (!isSetting(name)) return { ok: false, error: `unknown setting '${name}'` };
  const current = settings[name];
  if (typeof current === 'boolean') {
    const v = String(raw).toLowerCase();
    if (v !== 'true' && v !== 'false') return { ok: false, error: `${name} expects true/false` };
    settings[name] = v === 'true';
    return { ok: true, value: settings[name] };
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return { ok: false, error: `${name} expects a number` };
  let v = num;
  if (INT_KEYS.has(name)) v = Math.round(num);
  if (name === 'wwMaxPerParticle' || name === 'wwCellLimit' || name === 'maxStepsPerFrame' ||
      name === 'cgIterations' || name === 'sandFrictionIterations' || name === 'strandedNeighbors' ||
      name === 'bedrockBlockBudget' || name === 'bedrockParticleBudget' || name === 'bedrockMaxActiveCells' ||
      name === 'bedrockScanSectionsPerTick' || name === 'bedrockFieldRadius' || name === 'bedrockFieldHeight') {
    v = Math.max(0, Math.round(v));
  }
  if (name === 'gravity') v = Math.max(0, Math.min(v, 40));
  if (name === 'maxSpeed') v = Math.max(0.5, Math.min(v, 200));
  if (name === 'maxStepsPerFrame') v = Math.max(1, Math.min(v, 10));
  if (name === 'cgIterations') v = Math.max(0, Math.min(v, 24));
  if (name === 'bedrockFieldRadius') v = Math.max(6, Math.min(v, 48));
  if (name === 'bedrockFieldHeight') v = Math.max(8, Math.min(v, 64));
  settings[name] = v;
  return { ok: true, value: settings[name] };
}

/** Serialise settings for world dynamic properties. */
export function serializeSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (settings[k] !== DEFAULTS[k]) out[k] = settings[k];
  }
  return JSON.stringify(out);
}

/** Load settings previously produced by serializeSettings(). */
export function loadSettings(json) {
  Object.assign(settings, DEFAULTS);
  if (!json) return;
  let data;
  try { data = JSON.parse(json); } catch { return; }
  if (!data || typeof data !== 'object') return;
  for (const [k, v] of Object.entries(data)) {
    if (!isSetting(k)) continue;
    if (typeof DEFAULTS[k] === 'boolean' && typeof v === 'boolean') settings[k] = v;
    else if (typeof DEFAULTS[k] === 'number' && typeof v === 'number' && Number.isFinite(v)) settings[k] = v;
  }
}
