# Technical report — Java mod feature → Bedrock implementation

Target: **Minecraft Bedrock Edition 26.2** (internal version `1.26.2`; Bedrock
keeps the `1.26.xx` numbering inside manifests). Android first, single player
first, multiplayer through the same server-side scripts.

## 1. Architecture

```
BP/scripts/
  core/            pure JavaScript, no engine imports (unit tested in Node)
    settings.js    WaterSettings port + Bedrock additions + quality presets
    field.js       typed-array simulation field (replaces GPU buffers)
    fluid.js       water solver (volume transport, momentum, relaxation, films)
    sand.js        granular solver (repose, cohesion, buoyancy, current drag)
    whitewater.js  trapped-air/crest/energy emission (potential.comp + g2p.comp)
    quantize.js    targetAmount/targetLayers hysteresis + level mapping
    solver.js      field ownership, substeps, quantisation, stats
  adapters/        all @minecraft/server access
    bedrock.js     block ids, safe reads/writes, replaceable list
    worldIO.js     SolidCache/scan/sync/Echoes equivalents
    presentation.js particles, flow audio, fog, entity impulses
    commands.js    /rw:* custom commands + /scriptevent rw:* fallback
    items.js       bucket, spring placement, sand layer stacking
  main.js          wiring, per-dimension tick loop, block events
```

The simulation is **server-side**, so single-player, LAN and dedicated servers all
behave the same and the world state is authoritative. The Java mod ran the solver
on the client and only used the network to push block states; Bedrock add-ons have
no client script runtime, so the roles invert: the server simulates and writes
custom block states, which all clients render.

## 2. Fluid solver

Original: FLIP/PIC particles on a 6-per-block MAC grid, multigrid + CG pressure
projection, 1–4 GPU substeps per frame (`cfl = 2`, `maxDt = 0.025`).

Port: volume-conserving cellular fluid on **block-sized cells** with per-cell
momentum, 1–5 substeps per game tick of at most `maxDt = 0.025 s`:

1. **Gravity / support**: unsupported cells accumulate downward velocity;
   supported cells lose upward velocity. Springs are pinned to `sourceFill`
   (inflow.comp).
2. **Pressure gradient**: horizontal acceleration from the volume head difference
   (`stiffness · g · Δ(volume)`), wall drag when a solid is adjacent, thin-film
   friction (`filmFriction = 40`) when the cell is a film over solid ground
   (the `waterFilm()` logic of `g2p.comp`).
3. **Advection**: donor-cell transport along x, z, then y, CFL-clamped to 0.85 of a
   cell per substep. Every transfer moves `min(volume, free capacity)`, so volume
   is conserved **exactly** (asserted by `tools/tests/run.mjs`); blocked transfers
   bleed velocity instead of deleting volume.
4. **Pressure relaxation**: N weighted Gauss-Seidel sweeps (`cgIterations`, default
   5) equalise supported neighbours. This replaces the multigrid/CG solve: same
   role (make the free surface level), far cheaper, and it cannot diverge.
5. **Films**: cells thinner than `filmDepth` on the ground go through
   `strandedTime` and then evaporate slowly; this is the only volume sink.

That yields pooling, sloshing, spill-over, waterfall columns, flow around
obstacles, spring-fed pools and drying films from actual transported volume.

## 3. Sand solver

Original: second FLIP body with a stress tensor (`sand_scale`, `sand_stress`,
`sand_friction`: yield stress = `sandFriction · pressure + sandCohesion`, plus
friction-angle projection).

Port: granular volume per cell with:

* gravity, terminal settling speed, `sandRestSpeed` rest clamp;
* **angle of repose** from `sandFriction` (`repose = 0.28 + 0.55·friction`, so
  ≈35° at the default 0.7) with `sandCohesion` holding small piles together;
* **buoyancy + drag underwater**: 0.42 g effective acceleration, 1.1 m/s terminal
  velocity, shallower wet repose and 1.8× flow rate — the ported equivalent of the
  original's submerged sand body slumping further and settling slowly;
* **current drag**: submerged sand is pushed downstream by water velocity;
* sand entering a water cell calls `displaceWater()`, which pushes that water to
  free neighbours so water is not silently deleted.

## 4. Block-state quantisation

Original: `WaterWorld.targetAmount(fill, current)` and `targetLayers(fill, speed,
current)` decide the 1..8 world amount with dead-bands, then `WaterSyncPayload`
writes `LiquidBlock.LEVEL` (8 = full) and `RealisticSandBlock.LAYERS`.

Port: the same two functions exist verbatim in `core/quantize.js` and are unit
tested. Continuous volume is mapped onto **16 visual water levels** (`rw:level`
0..15 → surface at `(level+1)/16` of a block) with a 0.6-level dead-band in
`solver.js`, and onto **8 sand layers** (`rw:layers`). Block writes are budgeted
(`bedrockBlockBudget`, 320/tick by default) and echoed so the resulting block
events are not mistaken for player edits (`WaterWorld.Echoes` equivalent).

## 5. Rendering mapping

| Original | Bedrock port |
| --- | --- |
| Marching-tetrahedra iso-surface from the particle density (`nets_*`, `zb_*`, `blur`) | 16-step water geometry (`geometry.rw_water_h0..h15`), one permutation per level; sides inset 0.05 model units to avoid coplanar z-fighting between neighbours |
| Screen-space thickness buffer for depth | Not available; depth impression comes from stacked cells, alpha 0.83 surface texture and the pushed underwater fog |
| SSR reflection + sky reflection + Lambert/GGX sun highlight (`composite.frag`) | Not available; the surface texture carries a low-amplitude interference pattern instead of specular reflections (documented in UNSUPPORTED) |
| Refraction of the scene colour (`waterA.z`) | Not available |
| Beer-Lambert absorption / single scattering (`absorb`, `scatter`) | Underwater `fogs/underwater.json` pushed with `/fog` while the camera is inside simulated water; colour `#0E3A4A`, 16-block range |
| Under-water surface shading from below, Snell's window | Not available; fogged surface only |
| Whitewater billboards (`whitewater.frag`) + `ww_update.comp` types | Custom particles `rw:foam`, `rw:bubble`, `rw:spray` spawned from `core/whitewater.js` emission (same thresholds/energy curve) |
| Droplet quads (`droplet_front/thickness`) | Not implemented (needs depth tests); spray particles approximate droplets |
| Sand iso-surface + instanced grains (`sand_mesh.frag`, `grain.*`) | 8-layer sand block geometry with a procedural grain texture + `rw:sand_dust` particles when sand moves |
| Flow audio (`FlowSounds.java`) | `dimension.playSound('liquid.water' / 'random.splash')` weighted by per-cell speed within 24 blocks, throttled to every 3 ticks |
| Camera fog override (mixin) | `/fog @s push rw:underwater rw_underwater` (and `remove` when leaving) |

Water is **not** animated by a flipbook texture anywhere: surface height, foam and
audio all come from `field.vol` / velocity. Textures only add colour and fine
detail on top of the geometry.

## 6. Blocks, items, commands

| Original | Port |
| --- | --- |
| `realistic_water` fluid + `LiquidBlock` with `infinite` | `rw:realistic_water` (16 levels, no collision, replaceable) + `rw:realistic_water_source` (infinite spring) |
| `realistic_water_bucket` (`BucketItem`) | `rw:realistic_water_bucket` item; script pours a spring, sneak-use refills, vanilla bucket returned |
| `realistic_sand` (8 layers) + `BlockItem` | `rw:realistic_sand` layered block with generated loot table |
| `/water stats,pause,reload,ball,sand,remove,set,settings` | `/rw:stats`, `/rw:pause`, `/rw:reload`, `/rw:ball`, `/rw:sand`, `/rw:remove`, `/rw:set`, `/rw:settings`, `/rw:quality`, `/rw:help` through `CustomCommandRegistry` (stable API) and `/scriptevent rw:*` fallback |
| `/water render` (ClipRecorder) | Not ported (no render hook); see UNSUPPORTED |
| `WaterSyncPayload`/`SandSyncPayload`/`RemoveAllWaterPayload` | Not needed: server-side simulation writes block states directly; removal is `/rw:remove` |

Ordinary items work too: `adapters/vanilla.js` converts a **normal water bucket**
pour (the poured cell becomes a spring, the connected body of vanilla water within
8 blocks, up to 320 cells, becomes `rw:realistic_water` with levels derived from
`liquid_depth`) and every **normally placed `minecraft:sand`** block (replaced with
`rw:realistic_sand`, 8 layers). Convertered cells are adopted by the live field
immediately, so nothing waits for a re-seed; larger water bodies (oceans) are left
vanilla on purpose. Vanilla water and lava are treated as walls by `readCell`, so
simulated water can never flow into a cell it cannot replace and be deleted.

`/rw:set` accepts every original `WaterSettings` name. Values with no Bedrock
meaning (`resolution`, `surfaceSubdivision`, `renderMaxStepsPerFrame`, `ffmpeg`,
`renderFreezeWorld`) are accepted for compatibility but documented as inert.

## 7. Persistence, multiplayer, performance

* **Persistence**: the world blocks *are* the state (`rw:level` / `rw:layers`).
  On load, `WorldBridge` seeds the field from a distance-ordered queue of block
  reads; a 33×24×33 field (≈26k cells) fills in ~16 ticks at 1600 reads/tick.
  Unseeded cells are treated as solid, so water can never leak into unknown
  terrain. Settings are stored in a world dynamic property.
* **Saving/reloading** therefore restores the water level of every block; the
  solver re-derives velocity (zero on load) and continues.
* **Multiplayer**: one solver per dimension, ticking on the server; all players in
  that dimension share it. Field follows the player nearest its centre.
* **Cost control**: `bedrockBlockBudget`, `bedrockParticleBudget`,
  `bedrockMaxActiveCells` (advisory), plus quality presets that only change field
  size/particle/iteration counts. No claim of a measured FPS figure is made — see
  QA_REPORT for what was and was not measured.

## 8. Deliberate deviations

1. Cell size is 1 block (original: 1/6 block). Sub-block detail cannot be
   rendered by Bedrock block geometry, and a 6³/block particle grid is far beyond
   the 20 Hz script budget.
2. Pressure solve is Gauss-Seidel relaxation instead of multigrid + CG.
3. No per-pixel shading; optics are approximated by texture + fog.
4. Sand uses a reduced Mohr-Coulomb model (repose + cohesion + buoyancy), not a
   full stress tensor with friction-plane projection.
5. Entity coupling is a light drag/buoyancy impulse, because custom blocks are not
   fluids to the Bedrock physics engine.

## 7. Block physics converter (port addition)

This feature does not exist in the Java mod; it was requested after the port, so
it is mapped by capability rather than from a class.

| Port piece | Purpose |
| --- | --- |
| `rw:physics_converter` block + `recipes/physics_converter.json` | player-facing converter (8 iron + 1 redstone) |
| `core/physics.js` `massOf()` | per-block mass table (kg) with substring rules and a 1500 kg fallback |
| `core/physics.js` `PhysicsWorld` | sub-stepped integrator: gravity, drag, ground friction, restitution, motion accumulator, cell-by-cell movement, stacking, sleep, impact records |
| Archimedes term | `vy += g*dt*waterDensity*volume/mass`, so blocks under 1000 kg float and heavier ones sink |
| `adapters/physics.js` | world grid adapter: `tryMove` writes the real block, clears the water cell it enters, invalidates the bridge cache; splash/impact presentation; entity damage from impact energy; `/rw:physics` API; `rw:bodies` persistence |
| `DEFAULT_PHYSICS` | gravity 24, max 55 m/s, punch impulse 3000 N*s, 8 cells/tick anti-tunnel cap |

Deliberate limits: one block per body (no soft-body deformation or rotation),
grid-snapped motion (Bedrock cannot move a custom block smoothly from script),
and at most 120 persisted bodies.
