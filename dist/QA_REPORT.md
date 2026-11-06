# QA report

Date of this run: 2026-11-05. Environment: headless Linux cloud VM (no GPU, no
Minecraft client, no Android device), Python 3 + numpy, Node.js 20+.

## 1. Checks that ran and passed

### 1.1 Solver / quantisation unit tests — `node tools/tests/run.mjs`

```
13 passed, 0 failed   (exit 0)
```

| Test | What it proves |
| --- | --- |
| volume is conserved exactly (no sources, no evaporation) | advection never creates or deletes water |
| a raised column flattens into the surrounding floor | pressure relaxation levels the surface |
| water falls to the floor under gravity | vertical transport |
| a solid wall stops lateral flow | no tunnelling through solids |
| springs refill to sourceFill and stay there | infinite springs stay full (fixed this run, see §4) |
| thin films evaporate after the stranded time | film/stranding sink works and only removes films |
| quantisation ports the original hysteresis | `targetAmount`/`targetLayers` dead-bands match the Java logic |
| granular pile avalanches and conserves sand | sand repose + conservation |
| sand sinks slower through water than through air | buoyancy/drag coupling |
| whitewater emits on fast, curling surface flow and not on still water | emission thresholds (traced from `potential.comp`/`g2p.comp`) |
| solver produces block changes and then settles (hysteresis) | write-back loop converges, no oscillation |
| field shift preserves water volume | field window movement is lossless |
| addEmitBox fills water and clearAll empties it | command/test helpers behave |

### 1.2 Structural validation — `python3 tools/validate.py`

```
PASS: all structural, identifier, reference and asset checks succeeded
json files parsed : 24
blocks            : 3 (24 permutations)
geometry models   : 25
items             : 1
particles         : 4
fogs              : 1
textures          : 5 (dimensions checked)
scripts           : 13 (node --check)
identifier refs   : 32
```

Covered: JSON parse, manifest header/module/dependency UUIDs (format + uniqueness),
`min_engine_version [1,26,2]`, script module `entry`, pack-to-pack dependency,
every asset identifier reference, block permutation uniqueness, geometry format and
per-face UVs, texture atlas references and PNG dimensions, `node --check` on all
13 scripts.

### 1.3 Package build — `python3 tools/build.py`

```
dist/RealisticWater-BP.mcpack         52.8 KiB   22 entries
dist/RealisticWater-RP.mcpack         35.4 KiB   21 entries
dist/RealisticWater-Bedrock.mcaddon   89.6 KiB   43 entries
mcaddon readable, 43 entries, testzip=None
BUILD OK
```

`testzip=None` means `zipfile.ZipFile.testzip()` found no CRC error; the archive was
re-opened and every member decompressed. The `.mcaddon` contains the complete BP
(`manifest.json` + scripts + data) and RP (`manifest.json` + models + textures +
particles + fog) at `RealisticWater-BP/` and `RealisticWater-RP/` respectively.

## 2. Checks that could NOT be run (no client, no device)

These are **not** passes. They are untested and must be verified on a device:

1. Importing the `.mcaddon` in the Android client.
2. Activating both packs on a world (pack dependency/order warnings).
3. Whether Minecraft accepts every content JSON (block components, 16 permutations,
   geometry, particles, fog) — parse-valid JSON is not proof of schema acceptance.
4. Content Log / script errors at runtime, Script API version availability.
5. Appearance: water colour/brightness, transparency, seams or z-fighting between
   neighbouring heights, foam/bubble/spray look, sand layer look.
6. Dynamics in game: pouring, pooling, waterfalls, obstacle flow, drying films,
   sand avalanches and underwater slumping.
7. Save / quit / reload persistence of water and sand levels.
8. Multiplayer (two clients, second player joining, `/rw:remove` as non-op).
9. Custom command registration vs the `/scriptevent rw:*` fallback.
10. Performance and memory on a phone (no FPS measurement was made at all — the
    report deliberately contains no FPS claims).
11. Automatic conversion of ordinary items (`adapters/vanilla.js`): a normal water
    bucket pour, a normally placed sand block, and the 320-cell / 8-block pond
    limit all need an in-game check (see checklist step 3).

## 3. Known risks (with what to look at first)

| Risk | Why | Mitigation in place |
| --- | --- | --- |
| Content error on a block component | Bedrock schema is stricter than JSON validity; e.g. `minecraft:geometry`, `minecraft:material_instances`, `replaceable` | all components use documented 1.26 forms; validator asserts the structure; failures surface in the Content Log |
| `@minecraft/server 2.1.0` unavailable on the device build | version must exist for 1.26.2 | manifest pins 2.1.0, which is the stable version for 26.2 custom commands |
| Custom commands not registering | `CustomCommandRegistry` is newer than most tutorials | `/scriptevent rw:<cmd>` implements the same operations |
| Low frame rate with large fields | per-tick JS work scales with field volume | quality presets, `bedrockBlockBudget`, `bedrockFieldRadius`; default radius 16 |
| Water looks flat/too uniform | no refraction/specular available | textured surface + alpha + foam; tune `rw_water_top.png` in `tools/gen_assets.py` |
| Fog stays pushed if the player teleports out | fog is a stack | `presentation.js` pops on exit and on respawn/dimension change |
| Chunk/field re-seed stutter on first join | seeding 26k cells at 1600 reads/tick | distance-ordered seeding, unseeded cells block flow |

## 4. Defects found and fixed during this port

1. **Springs drained to an equilibrium level** (test caught `0.66 vs 0.9`). The
   source cell lost volume to neighbours faster than the 5/s refill. Fixed by
   pinning spring cells to `sourceFill` both before transport and at the end of the
   step, matching `inflow.comp` (an infinite source keeps emitting and stays full).
2. **Non-conservative "numerical dust" discards** in `core/fluid.js`: cells below an
   epsilon were zeroed, which silently deleted volume. Removed; only film
   evaporation removes water now, and the conservation test asserts exactness.
3. **`displaceWater()` z-bound typo** wrote outside the field for the last z slice;
   bounds now clamp on all three axes.
4. **`main.js` had an undefined `export { TODO_NONE }`** (would abort module load)
   and a `PLAYER_TICK` temporal-dead-zone use; both removed/reordered.
5. **Validator false positives** on non-asset `rw:` strings (command names, block
   state names, dynamic-property keys). Those are now allow-listed instead of
   weakening the identifier check.
6. **Item `menu_category.group: itemGroup.name.bucket`** risked a content error;
   group removed, category `items` kept.
7. **Z-fighting between neighbouring water heights**: side faces are inset 0.05
   model units so two different heights never share a coplanar face.
8. **Water could leak into vanilla water cells**: `readCell` treated other liquids
   as open cells, so simulated water flowed into a `minecraft:water` block and was
   then lost when the write was refused. Non-air, non-simulated blocks are walls
   now.
9. **Water texture too bright/cyan** against the brief: base/light stops darkened
   (≈`#113747` → `#407986`) and the caustic mix biased low; no speckles added.

## 5. Manual test checklist for the device

1. Import `dist/RealisticWater-Bedrock.mcaddon`; confirm both packs appear.
2. New flat world, both packs active, no experiments; check Content Log is clean.
3. `/give @s rw:realistic_water_bucket`, use it on the ground → spring appears and
   keeps flowing; `/rw:stats` shows cells > 0.
4. `/rw:ball 5` on a slope → water runs downhill, pools, and settles (levels stop
   changing). `/rw:remove water` clears it.
5. Build a 1-block wall in the flow → water goes around, not through.
6. Drop water off a ledge → falling column, foam at the impact point, splash audio.
7. Place `rw:realistic_sand` 8 times on one block, then break the bottom → the pile
   avalanches; drop sand into a pool → it sinks slowly and slumps.
8. Stand in deep water → fog, slower movement; leave → fog clears.
9. Save, quit, re-enter → water/sand levels are where you left them.
10. Second device/player joins → both see the same water; non-op cannot use `/rw:*`.
11. `/rw:set filmFriction 60`, `/rw:quality low|ultra` → no errors, behaviour changes.
12. If commands are missing, repeat step 3 with `/scriptevent rw:ball 5`.
