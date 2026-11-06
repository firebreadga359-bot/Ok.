# Features that cannot be reproduced in a Bedrock add-on

Bedrock add-ons are data packs plus a sandboxed JavaScript API. They cannot load
native libraries, execute Java bytecode, hook the renderer, or create GPU work.
The following parts of Realistic Water 1.1 therefore have **no** faithful
equivalent; what the port does instead is listed next to each. Nothing here is
silently dropped: where a visual approximation exists it is listed in
`TECHNICAL_REPORT.md`.

## Engine / rendering

| Original feature | Why it is impossible on Bedrock Android | What the port does |
| --- | --- | --- |
| Custom Vulkan device + compute pipelines (`vk/*`, `Vk.tryDevice`) | Add-ons have no GPU API. There is no supported way to submit compute or graphics work, and the Android client offers no renderer plug-in point. | All simulation runs on the CPU in script; no GPU claims are made. |
| Compute-shader FLIP particle fluid at 6 cells/block | Requires tens of thousands of particles per body plus GPU buffers; the Script API cannot reach them, and simulating them in JS at 20 Hz is not viable. | Block-cell volume solver with momentum (see report). |
| Marching-tetrahedra iso-surface (`nets_vertices`, `nets_quads`) | Custom block geometry is fixed at build time; there is no per-frame mesh submission. | 16 pre-built surface heights per cell (1/16-block steps) with inset sides. |
| Screen-space refraction, thickness buffer, SSR reflections, GGX sun highlight, Beer-Lambert absorption, Snell's window, wet darkening (`composite.frag`, `mesh_thickness.frag`) | These need full-screen passes with scene colour/depth access. No custom shaders or render targets are available to add-ons. | Deep low-contrast water textures, alpha blending, pushed fog, foam particles. No reflection/refraction is claimed. |
| `droplet_front` / `droplet_thickness` splash droplets with depth test | Needs a depth-tested billboard pass. | `rw:spray` particles approximate splashes. |
| Sand iso-surface + instanced grains (`sand_mesh.frag`, `grain.vert/frag`) | No per-frame instanced rendering. | 8-layer sand geometry with procedural grain texture, plus `rw:sand_dust` particles when moving. |
| Client-side mixins (camera fog, level render, projection capture, fluid renderer skip, frame recorder) | Mixins are Java bytecode injection. | Fog is applied with `/fog`; nothing else needs a hook. |
| `ClipRecorder` (`/water render`, PNG/FFmpeg capture) | No frame access, no file system, no FFmpeg. | Removed. |
| Vanilla fluid fog suppression (`CameraMixin`) | Not reachable. | The water block is not a vanilla fluid, so vanilla water fog never triggers anyway. |

## Simulation fidelity

| Original feature | Limitation | Port behaviour |
| --- | --- | --- |
| FLIP/PIC particles with P2G/G2P transfers | Not affordable in JS at 20 Hz for a useful volume. | Volume transport on a block grid; momentum per cell (`flipRatio` scales how much momentum survives a substep). |
| Multigrid V-cycle + conjugate-gradient projection | Too expensive per tick in script. | 2–8 Gauss-Seidel relaxation sweeps (`cgIterations`). |
| Full Mohr-Coulomb sand stress tensor with friction-plane projection (`sand_stress.comp`, `sand_friction.comp`) | Needs a 6-component stress field and 8 friction iterations per cell. | Reduced model: angle of repose from `sandFriction`, `sandCohesion`, buoyancy/drag, terminal velocity. Not claimed as a stress-tensor port. |
| 6 sub-cells per block | Block geometry cannot display sub-block volumes. | 1 cell = 1 block, 16 rendered heights. |
| Per-frame 60–240 Hz stepping with interpolation | Bedrock scripts tick at 20 Hz. | 1–5 substeps per tick at ≤25 ms each. |
| Solver follows arbitrarily large water bodies (regions merge/absorb) | Field is bounded for CPU cost. | Movable field (`bedrockFieldRadius`/`Height`, presets up to 41×28×41); volume outside the field is not simulated. |
| Entities displace the fluid and are pushed by it (`g2p.comp` collisions) | Custom blocks are not fluid to the physics engine. | Light drag + buoyancy impulse on players (`bedrockEntityPhysics`); no swimming/drowning/boat physics. |
| Vanilla water interactions: buckets, ice, sponges, conduits, waterlogged blocks, farmland, lava/basalt generation, fishing, potions, mob pathing water checks | The custom fluid is not `minecraft:water`. | The bucket item and the sand/water blocks work with each other; vanilla water logic does not see the custom fluid. |
| `/water render`, `ffmpeg` setting, `renderFreezeWorld` | No render pipeline access. | Accepted by `/rw:set` for compatibility, inert. |

## Explicit non-claims

* A `.mcaddon` cannot execute Java bytecode, replace the Bedrock renderer, load
  native libraries, or enable Vulkan compute. This port does none of that.
* No FPS improvement or GPU acceleration is claimed. All timing numbers in
  `QA_REPORT.md` are structural/Node measurements, not in-game FPS.
* In-game behaviour was **not** executed here: there is no Minecraft client and no
  Android device in this environment. See `QA_REPORT.md` for the exact list of
  checks that were impossible and the manual checklist to run.
