# Android install & first run

Short version: import `RealisticWater-Bedrock.mcaddon`, turn **both** packs on for
the world, then give yourself the bucket. The pack adds no water to the world by
itself — water only exists where you pour it or drop it with a command.

## Install

1. Copy `dist/RealisticWater-Bedrock.mcaddon` to the phone (Downloads is fine).
2. Open it with a file manager → **Open with Minecraft**. Wait for *Import
   complete* (a toast). Tapping twice is harmless.
   *If nothing opens:* move the file to `Download/`, then in Minecraft use
   **Settings → Storage → Behaviour packs** and import from there. Android 11+
   file managers may need "all files access" to reach
   `Android/data/com.mojang.minecraftpe/files/games/com.mojang/`.
3. Open the world you want (or create one), **Edit → Behaviour packs** →
   activate *Realistic Water (Bedrock port) BP*.
4. In the same screen **Resource packs** → activate *Realistic Water (Bedrock
   port) RP*. The BP depends on the RP's UUID, so do the RP too, not instead.
5. No experiments are needed. Leave "Beta APIs" off unless another pack needs it.
6. Enter the world. Chat should show
   `Realistic Water loaded. Try /rw:help or /scriptevent rw:help` once.

## First run (no commands needed)

1. Pour water with a **normal water bucket** on open ground. The poured cell
   becomes a spring and the connected pool starts flowing.
2. Place **normal sand**. That block becomes realistic sand: it settles, avalanches
   and slumps underwater.
3. In creative, open the inventory and search `Realistic`: the water block, the
   sand block, the spring, the bucket and the physics converter are all there. No
   `/give` and no commands are needed to get them.
4. Optional: `/rw:stats` shows live cells/levels — the fastest proof the solver is
   running. `/rw:help` lists the remaining tools (`/rw:set`, `/rw:quality`,
   `/rw:reload`, `/rw:remove`).
5. Oceans and lakes are deliberately left as vanilla water; a bucket pour converts
   a pool of up to 320 blocks within 8 blocks of the pour.

## When the packs import but nothing appears

Work down this list; each step tells you which layer is failing.

| Symptom | Check | Fix |
| --- | --- | --- |
| No packs in the world's pack list | Import actually finished? | Re-tap the `.mcaddon`; check **Settings → Storage** for the two pack names |
| BP listed but greyed out / auto-disabled | RP not active | Activate the RP first, then the BP |
| World was made before importing | Pack list was fixed at creation | Edit the world and activate both packs, or make a new world |
| No chat message on join, `/rw:stats` does nothing | Script module isn't running | Confirm Minecraft is **26.2 or newer** (`min_engine_version` 1.26.2); older clients refuse the pack silently |
| `/rw:*` unknown command, but `/scriptevent rw:stats` works | Custom command registry unavailable on this build | Use `/scriptevent rw:<command> [args]` for everything |
| `/rw:stats` says `no simulation yet` | Nothing to simulate yet, or you are outside the field | Pour water with the bucket, or place the Realistic Water block from the inventory; the field follows you and seeds within ~1 s |
| Nothing visible after pouring | Block behind the clicked face is solid | Aim at open air/grass and use again; the pack replies `Not enough room to place realistic water here` |
| A small splash vanished after ~1.5 s | By design: thin films strand and evaporate (`strandedTime`) | Use the bucket (infinite spring) or the Realistic Water Spring block for water that persists |
| Normal bucket water stays vanilla | Body larger than 320 blocks, or the chunk wasn't loaded at pour time | Pour into a smaller pool, or place the Realistic Water block from the inventory instead |
| Normal sand stays vanilla | Sand was placed by a non-player source (structure, dispenser) | Only player-placed sand converts; break and replace it |
| Blocks/items not in the Creative inventory | Search "Realistic" in the inventory search tab | They are filed under *Nature* (water, sand, spring) and *Items* (bucket, converter); scroll those groups if the search box misses them |
| Water/piles left from an older import | Field cache is stale | `/rw:reload` |
| Heavy stutter | Field volume too large for the device | `/rw:quality low`, or `/rw:pause`, or `/rw:remove all` |

## Read the log

Enable **Settings → Creator → Enable Content Log GUI** (or the Content Log file),
then re-enter the world. Expected lines from this pack, prefixed
`[realistic-water]`:

* `Realistic Water port active. Commands: 10 help lines` — script module loaded.
* `custom command registry unavailable; use /scriptevent rw:*` — fallback mode.
* `simulation field allocated, seeding from world` — first field created.
* `command registration failed <name> …` — that command needs the fallback.
* `world loaded, realistic water ready` — reload path is fine.

Anything else (content errors about `rw:*` blocks, `blocks.json`, geometry or
particles) is a pack-content problem; report the exact line.

## Block physics

1. Craft the converter (8 iron ingots around 1 redstone in a 3x3 grid), or take
   it from the creative inventory (search "Converter").
2. Place it, hold any block (stone, wool, sand, gold...), and **use** the
   converter. The block is thrown forward as a physics body.
3. Punch a body with an **empty hand** to shove it; light blocks fly, heavy ones
   barely move.
4. Drop one into simulated water: wool, planks and ice float, sand and stone sink.

Airborne bodies are drawn by a full-size proxy cube that slides smoothly between
blocks (stone, sand, dirt, wood, metal, wool, ice or leaves material), and the
exact block is placed when it lands. If you ever see bodies step block by block
instead, the proxy entity did not load: re-import both packs, make sure the
resource pack is active, then check `/rw:diag` - it reports `mode=smooth` or
`mode=blocks`.

## If literally nothing happens

Run `/rw:diag`. It prints one line per subsystem marked `OK` or `FAIL` plus the
engine error, the water field size, unseeded cell count and the physics body
count. If every line says OK but there is no water, pour a normal water bucket
while standing on open ground inside a loaded chunk. Version 1.2 fixed the bug
that stopped the whole script from starting, which is why earlier builds could
look completely dead.
