# Asset Credits

The SVG sprites and tilesets under this directory are original lightweight
placeholders authored for the
[`repo-dungeon`](https://github.com/McFuzzySquirrel/repo-dungeon) project and
copied here for Knowledge Dungeon. See that project's
[`public/assets/CREDITS.md`](https://github.com/McFuzzySquirrel/repo-dungeon/blob/main/public/assets/CREDITS.md)
for the original source and licensing notes.

## Currently shipped

- `sprites/player.svg` — generic fallback player marker.
- `sprites/player-hero.svg` — used for the **Scholar** archetype.
- `sprites/player-explorer.svg` — used for the **Cartographer** archetype.
- `sprites/player-archivist.svg` — used for the **Archivist** archetype.
- `sprites/signpost.svg` — drawn at the spawn (root) room.
- `sprites/npc-scribe.svg` — reserved for future "Scribe" encounter art.
- `sprites/objects/readme-scroll.svg` — used as the welcome-screen logo.
- `sprites/objects/artifact-loot.svg` — collectible loot icon shown on rooms
  with a completed final-pass artifact (archaeologist phase).
- `sprites/objects/stairs-up.svg`, `sprites/objects/stairs-down.svg` —
  portal markers placed on the parent / child-floor entry rooms when the
  in-game scene hides other floors. Press `E` to traverse.
- `sprites/objects/bookshelf.svg`, `sprites/objects/brazier.svg`,
  `sprites/objects/scroll-pile.svg` — decor sprites sprinkled
  deterministically into RPG-mode rooms.
- `tilesets/ancient-library.svg`, `tilesets/lost-archive.svg`,
  `tilesets/deep-dungeon.svg` — RPG-mode floor backgrounds, cycled
  deterministically per floor so each floor reads as a distinct location.

All assets are intended as temporary visual stand-ins and may be replaced
with production-quality CC0 / CC-BY packs later. See
[`docs/CUSTOMIZATION.md`](../../docs/CUSTOMIZATION.md) for instructions on
swapping these for your own art.
