# Original mod inventory — `realistic-water-1.1.jar`

Everything below was extracted from the supplied JAR and decompiled with
Vineflower 1.10.1 (the classes are Java 25, class-file major version 69; the
decompiler was run on Temurin 21 and produced complete sources).

## Mod metadata (`fabric.mod.json`, `META-INF/MANIFEST.MF`)

| Field | Value |
| --- | --- |
| id / name / version | `realistic-water` / Realistic Water / `1.1` |
| author | Skaffy, licence "Custom License" (see `LICENSE_realistic-water`) |
| environment | `*` (server + client) |
| entrypoints | main `me.skaffy.RealisticWater`, client `me.skaffy.client.RealisticWaterClient` |
| dependencies | `fabricloader >=0.19.5`, `minecraft ~26.3`, `java >=25`, `fabric-api` |
| mixins | `realistic-water.mixins.json` (empty), `realistic-water.client.mixins.json` (8 client mixins) |
| build | Loom 1.18.2, Gradle 9.7.1, official mappings, split environment |

## Content registration (`me.skaffy.ModContent`, `me.skaffy.RealisticWater`)

* `FLOWING_REALISTIC_WATER` / `REALISTIC_WATER` — `FlowingFluid` pair.
* `REALISTIC_WATER_BLOCK` — `LiquidBlock` with an extra `infinite` boolean state
  (spring marker), no collision, replaceable, no loot, liquid, 100 hardness.
* `REALISTIC_WATER_BUCKET` — `BucketItem` with bucket remainder, stack size 1.
* `REALISTIC_SAND` — 8-layer block (`layers` 1..8), `RenderShape.INVISIBLE`
  (drawn by the shader), collision = `layers-1`, replaceable while < 8,
  pathfindable below 5 layers.
* Creative-tab injections: bucket after `water_bucket`, sand after `sand`.
* Networking: `WaterSyncPayload`, `SandSyncPayload`, `RemoveAllWaterPayload`
  registered serverbound; the server applies them **only** for the singleplayer
  owner or an operator (`isAuthority`).

## Fluid behaviour (`me.skaffy.fluid.RealisticWaterFluid`)

`FlowingFluid` subclass, but `tick()` is empty: vanilla spreading is disabled and
the GPU simulation owns transport. `canConvertToSource` false, slope distance 4,
drop-off 1, tick delay 5, explosion resistance 100, bucket fill/pickup sounds,
water-tag membership, `Level` fluid tag `data/minecraft/tags/fluid/water.json`.
`getLegacyLevel(fluidState)` maps amount → block `level`, plus the `infinite` flag.

## Client simulation — `me.skaffy.client.water`

| Class | Role |
| --- | --- |
| `WaterWorld` | singleton; owns regions, `sources` (springs), chunk scan queue, echo tracking, pending fills, flow sounds, renderer; steps 1–4 substeps per frame using `cfl`, `maxDt`, `maxStepsPerFrame`; merges overlapping regions, retires drained ones after 90 idle frames; writes block changes back (host only) with `targetAmount`/`targetLayers` hysteresis; `statsLine()`; `/water` command support |
| `WaterRegion` | one GPU simulation body: dense cell/face buffers, window planning against a `SolidCache`, box growth from `sources`, `readBack()` of the fill buffer, `patchSolid`, dispatch recording, `Fill` exposing `fullness()` and `blocksPerSecond()` |
| `PressureSolver` | multigrid V-cycle + conjugate-gradient pressure projection (`mg_*`, `cg_*` shaders), `cgIterations` / `mgCoarseSweeps` |
| `SurfaceMesher` | fine grid (`resolution × surfaceSubdivision`), z-buffer splat + signed-distance field + separable blur + optional sheet fill, then marching-tetrahedra vertices and quads (`nets_*`), indirect draw args |
| `WaterRenderer` | G-buffer front pass (`mesh_front`), droplet front, thickness accumulation (`mesh_thickness`, `droplet_thickness`), whitewater sprites, full-screen composite (SSR ray march, refraction, Beer-Lambert absorption, scattering, foam lace, under-water shading) |
| `SandRenderer` | sand iso-surface (`sand_mesh`) plus instanced sand grains (`grain.*`) |
| `SolidCache` | voxelises block collision shapes at simulation resolution, per-section cache, partial-shape bitmasks, chunk invalidation |
| `FlowSounds` | positional `WATER_AMBIENT` / splash / sand step sounds weighted by `Fill.blocksPerSecond()` within 24 blocks |
| `ClipRecorder` | frame capture to PNG or FFmpeg, fixed timestep, `/water render` |
| `WaterSettings` | ~110 static tunables (gravity, CFL, FLIP ratio, whitewater rates, film friction, optics absorb/scatter, sand friction/cohesion, colours…) |
| `WaterCommands` | `/water stats,pause,reload,ball,sand,remove,set,settings,render` |

## Rendering / engine integration

`me.skaffy.client.vk` wraps Vulkan directly (`Vk`, `VkBuf`, `VkTex`, `Program`,
`ComputeProgram`, `GraphicsProgram`, `Shaders`, `Sampler`, `Desc`). The mod
requires the Vulkan backend (`Vk.tryDevice()`, otherwise it tells the player to
switch graphics API). Mixins: `CameraMixin` (suppress vanilla fluid fog),
`ClientLevelMixin` (capture block updates, skip rebuilds for invisible swaths),
`FluidRendererMixin` (skip vanilla realistic-water tessellation),
`GameRendererMixin` (capture projection), `LevelRendererMixin` (draw the sim after
outline), `MinecraftMixin` + `DeltaTrackerTimerMixin` (clip clock, record frames),
`FrontendGpuDeviceAccessor` (grab the device).

## Shaders (`assets/realistic-water/shaders`)

* **Particle fluid (FLIP/PIC)**: `g2p.comp` (advection, collision, entity push,
  thin-film damping, stranding, whitewater emission), `p2g.comp` (splat velocity +
  density), `emit.comp`, `inflow.comp` (springs), `remove.comp`, `merge.comp`,
  `shift.comp`, `clear_box.comp`, `faces.comp` (velocity faces + gravity),
  `classify.comp` (solid/fluid/air from block counts), `extrapolate.comp`,
  `potential.comp` (trapped air curl, wave crest), `divergence.comp`,
  `project.comp`, `args.comp`, `probe.comp` (camera submergence),
  `blockfill.comp` + `sheet_fill.comp` (block-level fill/sheet smoothing).
* **Pressure solve**: `mg_flags0/coarsen/restrict/coarse/prolong/smooth`,
  `cg_init/dot/direction/apply/reduce/update`.
* **Surface**: `zb_splat`, `zb_field`, `blur`, `fine_clear`, `nets_vertices`,
  `nets_quads`, `mesh_args`.
* **Sand**: `sand_scale.comp`, `sand_stress.comp`, `sand_friction.comp`,
  `sand_strain.glsl`, `sand_shade.glsl`, `sand_mesh.frag`, `grain.vert/frag`.
* **Water shading**: `mesh.vert`, `mesh_front.frag`, `mesh_thickness.frag`,
  `particle.vert`, `droplet_front.frag`, `droplet_thickness.frag`,
  `whitewater.frag`, `composite.frag`, `fullscreen.vert`.
* **Shared**: `common.glsl` (uniform layout, grid addressing, hash/rand, normal
  packing), `gridsample.glsl`, `mg_common.glsl`, `mg_ops.glsl`.
* **Whitewater update**: `ww_update.comp` (bubble rise, foam follow, spray drag).

## Assets and data

`blockstates`, `items`, `models` (sand model = vanilla sand cube; water model =
vanilla water model), `lang/en_us.json`, `icon.png`, loot table for sand,
`data/minecraft/tags/fluid/water.json`.

## Key numeric behaviour worth preserving

* Simulation cell = 1/6 block (`WaterSettings.resolution = 6`), `surfaceSubdivision = 2`.
* Water amount is written back as 1..8 with hysteresis (`targetAmount`), sand as
  1..8 layers with `targetLayers`; springs are separate infinite blocks.
* Whitewater emission = energy curve × (30 × trapped-air + 45 × wave-crest) per
  second, capped at 12 per cell, life 1.5–4 s.
* Optics: absorption `(0.45, 0.12, 0.07)`, scattering `(0.03, 0.08, 0.11)`,
  density 0.5, refraction 0.15, roughness 0.06, specular 6.
* Sand: friction 0.7, cohesion 0.15, stiffness 0.12, rest speed 0.15,
  grain size 0.02, 6 grains per particle.
