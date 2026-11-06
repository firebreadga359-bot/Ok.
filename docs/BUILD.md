# Building and verifying the port

Everything in the packs is generated from `tools/gen_assets.py` (JSON, geometry,
procedural textures) plus the hand-written scripts under
`RealisticWater/BP/scripts`. There is no editor project to keep in sync: change the
generator or a script, then rebuild.

## Requirements

* Python 3.10+ with `numpy` (texture generation) — `python3 -m pip install numpy`
* Node.js 20+ (script syntax check + solver tests)
* No Minecraft install is needed to build.

## Commands

```bash
python3 tools/gen_assets.py          # regenerate blocks/items/textures/geometry/particles/fog/lang
node tools/tests/run.mjs             # 13 solver/quantisation/whitewater tests
python3 tools/validate.py            # JSON, identifiers, UUIDs, geometry, textures, script syntax
python3 tools/build.py               # generate + validate + test + pack into dist/
```

`tools/build.py` runs the whole chain and fails on any validator or test failure.
Output:

```
dist/RealisticWater-BP.mcpack        behaviour pack
dist/RealisticWater-RP.mcpack        resource pack
dist/RealisticWater-Bedrock.mcaddon  both packs, ready to import
dist/README.md, TECHNICAL_REPORT.md, FEATURE_INVENTORY.md,
     UNSUPPORTED.md, QA_REPORT.md, BUILD.md, LICENSE_realistic-water.txt
```

## What the validator checks

* every JSON file parses;
* `manifest.json` headers/modules/dependencies: UUID format and uniqueness,
  `format_version`, `min_engine_version`, script module has `entry`, pack
  dependencies reference the other pack's UUID;
* every `identifier`/`rw:*` reference resolves to a declared block, item, particle,
  fog, sound or file (commands, dynamic-property keys and block-state names are
  allow-listed because they are not asset identifiers);
* geometry files: format version, bone/cube counts, per-face UV references present
  in the atlas;
* textures: referenced in `terrain_texture.json` / `item_texture.json`, file exists,
  PNG dimensions match the declared tile size;
* unique block permutations (`rw:level` 0..15, `rw:layers` 1..8);
* `node --check` on every script.

## Reproducibility

Textures are deterministic (fixed noise seeds in `gen_assets.py`); re-running the
generator produces byte-identical PNGs, so archive diffs only show real changes.
UUIDs are hard-coded in `gen_assets.py` and never regenerated.

## Notes

* `analysis/` holds the JAR, decompiled sources and the unpaid-onward inspection
  material; `tools/jdk` + `tools/vineflower` are only needed to re-do the
  decompilation. None of this is packaged.
* Do not add `node_modules` or source maps to the packs: `build.py` skips
  `.map`/`.pyc`/`__pycache__` and only packs `RealisticWater/BP` and
  `RealisticWater/RP`.
