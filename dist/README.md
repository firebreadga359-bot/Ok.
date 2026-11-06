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

## Block physics: the converter

The add-on also ships a **Physics Converter** block (`rw:physics_converter`,
crafted from 8 iron ingots around a redstone core, or `/give @s rw:physics_converter`).
Use it while holding any block: one of that block leaves your hand and becomes a
physics body thrown where you look. Punch a body with an empty hand to shove it.

Airborne bodies are drawn by a full-size proxy cube that is interpolated between
blocks every tick, so they fly and fall smoothly; the proxy wears the block's
material (stone, sand, dirt, wood, metal, wool, ice, leaves). When a body comes to
rest the proxy is removed and the **exact block** is placed, so what you end up
with is the real block. Every block keeps its own mass in kg:

| block | mass | in water |
| --- | --- | --- |
| white wool | 40 kg | floats |
| oak planks | 600 kg | floats |
| ice | 917 kg | floats |
| sand | 1.6 t | sinks |
| stone | 2.6 t | sinks fast |
| iron block | 7.9 t | sinks very fast |
| gold block | 19.3 t | sinks very fast |

- a hit delivers 3000 N*s, so `dv = impulse / mass`: wool flies, gold barely moves;
- water is 1000 kg/m3, so anything lighter floats up when it lands in simulated
  water and displaces that water (foam + splash);
- a fast heavy impact hurts entities in the cell it hits (capped at 6 damage);
- bodies stack, slide with friction and stop being simulated once at rest;
- `/rw:physics on` makes every block you place a body, `convert` converts the
  block you look at, `clear` removes all bodies;
- `/rw:diag` lists every subsystem with OK/FAIL, which is the first thing to run
  when something does not appear.
