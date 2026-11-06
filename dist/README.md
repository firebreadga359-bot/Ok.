# Realistic Water — Minecraft Bedrock port (26.2 / 1.26.2)

A simulation-based port of the Fabric mod **Realistic Water 1.1** by *Skaffy*
(https://github.com/sskaffy/Realistic-Water) to **Minecraft Bedrock Edition 26.2**,
targeting **Android**. This is a **modified port**, not the original mod, and it is
distributed under the original mod's licence (see `LICENSE_realistic-water.txt`).

It is **not** a texture pack. The water you see is the state of a running
volume-conserving fluid solver: water is transported, pooled, spilled, dropped,
drained and evaporated by the solver every tick, and the result is written back
into custom block states as a 16-step surface height. Sand is a second granular
solver with an angle of repose, cohesion and buoyancy/drag underwater. Whitewater,
flow audio and underwater fog are driven by the same simulation data.

## Install (Android)

1. Copy `dist/RealisticWater-Bedrock.mcaddon` to the device.
2. Tap it and choose **Open with Minecraft** (or import from *Settings → Storage →
   Resource/Behaviour packs* while the file is in `games/com.mojang`), then wait for
   *Import complete*.
3. Create or edit a world:
   * **Behaviour packs** → activate `Realistic Water (Bedrock port) BP`
   * **Resource packs** → activate `Realistic Water (Bedrock port) RP`
   * No experiments are required (the port uses stable Script API features).
4. Enter the world. You should see `Realistic Water port active` in the content log.

Individual packs are also provided: `dist/RealisticWater-BP.mcpack` and
`dist/RealisticWater-RP.mcpack` (the `.mcaddon` contains both).

## First steps

No commands are needed for the basics:

* Pour with a **normal water bucket** → the poured cell becomes a spring and the
  connected pool (up to 320 blocks within 8 blocks of the pour) starts simulating.
  Oceans and big lakes are left alone on purpose.
* Place **normal sand** → that block becomes realistic sand and joins the granular
  solver. Using normal sand on an existing realistic sand block stacks a layer.

The dedicated items still exist and behave the same way:

```
/give @s rw:realistic_water_bucket
/give @s rw:realistic_sand 16
```

* Right-click a block with the **bucket** → pours a **spring** that keeps feeding
  water. Sneak + right-click a realistic water block → fills the bucket back.
* Place **Realistic Sand** repeatedly on the same block to build up to 8 layers;
  piles avalanche, sink through water and get washed downstream.
* `/rw:ball 4` drops a 4×4×4 water body in front of you; `/rw:sand 3` drops sand.
* `/rw:stats` shows live solver numbers, `/rw:help` lists everything.

### Commands

| Command | Effect |
| --- | --- |
| `/rw:stats` | cells, field size, substeps, max speed, whitewater count |
| `/rw:pause` | pause/resume the simulation (persisted) |
| `/rw:reload` | re-read water/sand blocks around you into a fresh field |
| `/rw:ball [size]` | drop a cube of water (default 3) |
| `/rw:sand [size]` | drop a cube of sand (default 2) |
| `/rw:remove water\|sand\|all` | delete simulated blocks in the field |
| `/rw:set <name> <value>` | change any solver setting (see `/rw:settings`) |
| `/rw:quality low\|medium\|high\|ultra` | field size / budget presets |
| `/rw:help` | command list |

If custom commands are unavailable on your build, every operation works through
`/scriptevent rw:<command> [args]`, e.g. `/scriptevent rw:stats`.

### Settings worth knowing

`gravity`, `maxSpeed`, `sourceFill` (spring fill fraction), `filmDepth` /
`filmFriction` / `strandedTime` (how thin films cling to the ground before
evaporating), `flipRatio` (momentum carried between substeps), `cgIterations`
(pressure relaxation sweeps), `whitewater` and the `ww*` thresholds, `sandFriction`
/ `sandCohesion` / `sandStiffness`, `bedrockFieldRadius` / `bedrockFieldHeight`
(simulated area around you), `bedrockBlockBudget` (custom-block writes per tick),
`bedrockParticleBudget`, `bedrockEntityPhysics`, `bedrockUnderwaterFog`.

All original `WaterSettings` names are accepted by `/rw:set`, so a value you used
in the Java mod (`/water set filmFriction 60`) has a direct equivalent
(`/rw:set filmFriction 60`).

## What this port can and cannot do

Implemented with real simulation: volume transport, pooling, waterfalls, splashes,
obstacle flow, springs, thin-film stranding/evaporation, whitewater (bubbles/foam/
spray), granular sand with repose and water coupling, buoyancy/drag feedback on
players, flow audio, underwater fog, block persistence across save/reload,
multiplayer via server-authoritative scripts.

Not possible in a Bedrock add-on: GPU compute shaders, Vulkan access, custom draw
passes, screen-space refraction/reflection/thickness, per-pixel absorption or
marching-cubes surfaces, and the original's 6-cells-per-block FLIP grid. Those
require engine modification; see `docs/UNSUPPORTED.md` for the full list with
reasons, and `docs/TECHNICAL_REPORT.md` for the feature-by-feature mapping.

## Documentation

* `docs/ANDROID_INSTALL.md` — step-by-step Android install, first run and troubleshooting
* `docs/FEATURE_INVENTORY.md` — what the original JAR contains
* `docs/TECHNICAL_REPORT.md` — original feature → Bedrock implementation mapping
* `docs/UNSUPPORTED.md` — what cannot be reproduced, and why
* `docs/QA_REPORT.md` — what was actually tested, what could not be
* `docs/BUILD.md` — reproducing the build
