# Realistic Water — Bedrock port (source tree)

This folder is the source of the Bedrock port of **Realistic Water 1.1** by Skaffy.
The importable package is built into `../dist/`.

```
RealisticWater/
  BP/                     behaviour pack
    manifest.json         min_engine_version 1.26.2, @minecraft/server 2.1.0
    blocks/               rw:realistic_water (16 levels), .._source, rw:realistic_sand (8 layers)
    items/                rw:realistic_water_bucket
    loot_tables/blocks/   sand drops
    texts/                en_US.lang (pack + content names)
    scripts/
      core/               pure simulation (settings, field, fluid, sand, whitewater, quantize, solver)
      adapters/           @minecraft/server glue (bedrock, worldIO, presentation, commands, items)
      main.js             tick loop, events, startup/scriptevent registration
  RP/                     resource pack
    manifest.json
    blocks.json           sound/material assignment
    models/blocks/        generated water + sand geometry
    textures/blocks|items procedural PNGs + atlases
    particles/            rw_foam, rw_bubble, rw_spray, rw_sand_dust
    fogs/underwater.json  rw:underwater
    texts/en_US.lang
  LICENSE_realistic-water.txt
```

Read `../docs/README.md` for installation, `../docs/TECHNICAL_REPORT.md` for the
feature mapping and `../docs/QA_REPORT.md` for what was tested.
