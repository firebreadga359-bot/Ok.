/**
 * Presentation layer: particles, flow audio, underwater fog and entity physics.
 *
 * Original counterparts:
 *   whitewater.frag / particle.vert / ww_update.comp -> foam/bubble/spray particles
 *   FlowSounds.java                                  -> position based flow audio
 *   composite.frag absorption + scatter              -> pushed fog definition
 *   g2p.comp entity collision/buoyancy               -> impulses on entities
 */
import { PARTICLE, FOG_ID, log } from './bedrock.js';

export class Presentation {
  constructor() {
    /** @type {Map<string, {underwater:boolean, players:Set<string>}>} */
    this.dimensionState = new Map();
    this.fogged = new Set();
    this.soundCooldown = 0;
  }

  /** Spawn the solver's whitewater particles (budgeted). */
  spawnWhitewater(dimension, particles) {
    if (!particles || particles.length === 0) return 0;
    let n = 0;
    for (const p of particles) {
      const id = p.type === 0 ? PARTICLE.bubble : (p.type === 2 ? PARTICLE.spray : PARTICLE.foam);
      try {
        dimension.spawnParticle(id, { x: p.x, y: p.y, z: p.z });
        n++;
      } catch {
        // particle identifiers can be missing on very old packs; stop trying
        break;
      }
    }
    return n;
  }

  /**
   * Flow audio, ported from FlowSounds.onFill(): cells with enough speed and
   * fullness near the listener emit ambient water / splash sounds, weighted by
   * the flow speed.
   */
  flowAudio(dimension, solver, players, settings) {
    if (!settings.flowSounds || !settings.bedrockFlowSounds) return;
    if (this.soundCooldown-- > 0) return;
    this.soundCooldown = 3;
    const f = solver.water;
    if (!f) return;
    for (const player of players) {
      let weight = 0;
      let fast = 0;
      /** @type {Array<[number,number,number,number]>} */
      const candidates = [];
      const loc = player.location;
      const R = 16;
      for (let dz = -R; dz <= R; dz += 2) {
        for (let dy = -8; dy <= 8; dy += 2) {
          for (let dx = -R; dx <= R; dx += 2) {
            const x = Math.floor(loc.x + dx), y = Math.floor(loc.y + dy), z = Math.floor(loc.z + dz);
            const i = f.index(x, y, z);
            if (i < 0) continue;
            const v = f.vol[i];
            if (v < 0.06) continue;
            const speed = Math.hypot(f.vx[i], f.vy[i], f.vz[i]);
            if (speed < 0.4) continue;
            candidates.push([x, y, z, speed]);
            weight += Math.min(speed / 1.5, 2.0);
            if (speed >= 4.0) fast++;
          }
        }
      }
      if (candidates.length === 0) continue;
      const scale = settings.flowSoundVolume;
      let count = Math.floor(Math.min(weight * 0.012, 3.0));
      if (Math.random() < Math.min(weight * 0.012, 3.0) - count) count++;
      for (let k = 0; k < count; k++) {
        const c = candidates[(Math.random() * candidates.length) | 0];
        const loud = Math.min(c[3] / 1.5, 1.0);
        try {
          dimension.playSound('liquid.water', { x: c[0] + Math.random(), y: c[1] + Math.random(), z: c[2] + Math.random() },
            { volume: (0.45 + 0.45 * loud) * scale, pitch: 0.5 + Math.random() });
        } catch { /* sound id unavailable */ }
      }
      let impacts = Math.floor(Math.min(fast * 0.03, 1.0));
      if (Math.random() < Math.min(fast * 0.03, 1.0) - impacts) impacts++;
      for (let k = 0; k < impacts; k++) {
        const c = candidates[(Math.random() * candidates.length) | 0];
        try {
          dimension.playSound('random.splash', { x: c[0] + Math.random(), y: c[1] + Math.random(), z: c[2] + Math.random() },
            { volume: 0.25 * scale, pitch: 0.8 + Math.random() * 0.4 });
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Underwater fog: the resource pack ships a fog definition, pushed with
   * /fog when the camera is inside simulated water (the original replaced the
   * vanilla fog through a Camera mixin and its own absorption in composite.frag).
   */
  updateFog(players, bridge, settings) {
    if (!settings.bedrockUnderwaterFog) return;
    for (const player of players) {
      const id = player.id;
      const eye = player.getHeadLocation();
      const inside = bridge.waterVolumeAt(eye.x, eye.y, eye.z) > 0.55;
      const was = this.fogged.has(id);
      if (inside && !was) {
        try {
          player.runCommand(`fog @s push ${FOG_ID} rw_underwater`);
          this.fogged.add(id);
        } catch (e) {
          // fog command unavailable (older build): remember so we do not spam
          this.fogged.add(id);
          log('fog push failed', e?.message ?? e);
        }
      } else if (!inside && was) {
        try { player.runCommand('fog @s remove rw_underwater'); } catch { /* ignore */ }
        this.fogged.delete(id);
      }
    }
  }

  /**
   * Very light buoyancy/drag for entities standing in simulated water.
   * The Java mod got entity displacement from its GPU solver; Bedrock's custom
   * blocks are not real fluids, so this restores the missing physical feedback.
   */
  entityPhysics(dimension, bridge, players, settings) {
    if (!settings.bedrockEntityPhysics) return;
    for (const player of players) {
      const loc = player.location;
      const v = bridge.waterVolumeAt(loc.x, loc.y, loc.z);
      if (v <= 0.45) continue;
      let vel;
      try { vel = player.getVelocity(); } catch { continue; }
      // drag only; buoyancy is left to the player unless they are deep inside
      const drag = 0.05;
      try {
        player.applyImpulse({
          x: -vel.x * drag, y: -vel.y * drag + (v > 0.8 ? 0.012 : 0), z: -vel.z * drag
        });
      } catch { /* impulse unsupported */ }
    }
  }

  /** Sand dust when sand is moving (stand-in for the original grain shader). */
  spawnSandDust(dimension, solver, budget) {
    const f = solver.sandField;
    if (!f || budget <= 0) return 0;
    let n = 0;
    for (let i = 0; i < f.count && n < budget; i += 7) {
      if (f.sed[i] <= 0.2) continue;
      const sp = Math.hypot(f.vx[i], f.vy[i], f.vz[i]);
      if (sp < 0.6) continue;
      const x = f.minX + (i % f.nx);
      const y = f.minY + (Math.floor(i / f.nx) % f.ny);
      const z = f.minZ + Math.floor(i / (f.nx * f.ny));
      try {
        dimension.spawnParticle(PARTICLE.dust, { x: x + 0.5, y: y + 0.6, z: z + 0.5 });
        n++;
      } catch { break; }
    }
    return n;
  }
}
