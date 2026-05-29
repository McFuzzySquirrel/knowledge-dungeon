# Knowledge Dungeon

A local-first, offline-friendly **study dungeon-crawler** built on the
[`repo-dungeon`](https://github.com/McFuzzySquirrel/repo-dungeon) engine,
fed by the **mindmap-driven learning concept** from
[`mindmap-dungeon`](https://github.com/McFuzzySquirrel/mindmap-dungeon).

You author a *subject* as a mindmap of topic-rooms, then walk into each room
and defeat its encounter by writing structured notes that pass deterministic
quality gates. Defeated rooms drop loot, XP, and a generated artifact. When
every room is cleared, the **Archaeologist** phase unlocks self-check prompts
and review-streak tracking.

## Screenshots

### Home / subject management

![Welcome screen showing phase selection, class selection, saved subject browsing, and admin section](./docs/assets/ui/welcome-screen.png)

The home screen is where you:

- choose the current phase and study archetype
- create a new subject from a root topic
- browse previously created subjects by **name** and room count
- refresh the local subject list before jumping back in
- access desktop-only admin/export helpers from the Admin section

### In-dungeon study view

![Main game shell with HUD, minimap, dungeon view, and room panel](./docs/assets/ui/game-screen.png)

Once a subject is loaded, the in-dungeon view keeps the study loop visible in one place:

- HUD for phase, progression, current floor, map, home, and help
- HUD teleport spell for floor/room jumps with cooldown tracking
- Phaser dungeon canvas for movement and room navigation
- minimap and room panel for topic context, breadcrumbs, portals, and creator edits
- the room panel splits travel options into **connected topics on this
  floor** and **travel to related floors** (with a one-click `← Back to <parent>`
  shortcut) so deep mindmaps stay navigable
- the full **Map** overlay (<kbd>M</kbd>) defaults to a per-floor view that
  greys out unrelated floors and renders the parent entry room as a dashed
  blue portal — toggle **Show current floor only** off to see the whole
  mindmap at once
- encounter notes accept lightweight Markdown (links, bold, italic, code,
  bullets) with a live Edit/Preview toggle
- during the **Archaeologist** phase, every room that has produced an
  artifact is marked with a loot-chest icon on the dungeon canvas so
  cleared topics are easy to revisit
- the **Graphics style** toggle (Welcome screen header and Help overlay)
  switches between the mind-map view and an RPG dungeon view at any
  time — the dungeon, full map, and minimap all re-skin together while
  saved subjects stay untouched

## Tech stack

- React 19, Phaser 3, Zustand
- Vite 8, TypeScript 5
- Electron 42 (desktop), electron-builder for mac / win / linux
- Vitest + Testing Library for unit tests
- ESLint 9 (flat config)

## The three phases

| Phase | Mode | What you do |
| ----- | ---- | ----------- |
| **Creator** | Architect | Author the dungeon by bulk-adding topic-rooms, reparenting them, and editing the mindmap. |
| **Scribe** | Explore | Walk into rooms and submit notes that pass the validation rubric. |
| **Archaeologist** | Review | Once every room is cleared, revisit artifacts and self-check prompts. |

## Getting started

```bash
npm install
npm run dev               # web dev server
npm run electron          # web build + Electron shell
```

Other useful scripts:

```bash
npm run lint
npm run typecheck
npm run test              # vitest --run
npm run build:web         # production web bundle
npm run check:bundle-size # bundle-size guard used in CI
npm run package:electron  # local Electron package (no signing)
```

## Building an Electron install package

The commands below produce a distributable installer in the `release/` folder.

**Prerequisites**

- `npm install` already run
- On **macOS**, code-signing requires an Apple Developer certificate in your
  Keychain; without one, omit `--mac dmg` targets or set
  `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- On **Windows** (cross-compilation from another OS is not supported by
  NSIS), signing requires a `CSC_LINK` / `CSC_KEY_PASSWORD` code-signing
  certificate; unsigned builds work without those env vars.

**Platform-specific commands**

| Target | Command |
|--------|---------|
| Current platform only (unpacked, no installer — fast for testing) | `npm run package:electron` |
| macOS `.dmg` + `.zip` | `npm run package:electron:mac` |
| Windows NSIS installer + `.zip` | `npm run package:electron:win` |
| Linux `.AppImage` + `.deb` | `npm run package:electron:linux` |
| All three platforms at once | `npm run package:electron:full` |

**Step-by-step (example: macOS)**

```bash
# 1. Install dependencies
npm install

# 2. Build web assets and the Electron main process
npm run build:electron

# 3. Package into a distributable (output goes to release/)
npm run package:electron:mac
```

The finished installer appears under `release/` as
`Knowledge Dungeon-<version>-mac-<arch>.dmg` (and a `.zip` companion).
Open the `.dmg`, drag the app to `/Applications`, and launch it normally.

> **Linux `.deb` only** (no `.AppImage`): replace step 3 with
> `npm run package:electron:linux`.
> **Linux `.AppImage` only**: use `npm run package:electron:linux:appimage`.

## Controls

| Action | Keyboard | Touch |
| ------ | -------- | ----- |
| Move   | `W A S D` / arrows | On-screen D-pad |
| Interact (open encounter / mark reviewed) | `E` | `Interact` button |
| Toggle help | `?` | — |

## UI docs

- [UI walkthrough with screenshots](./docs/UI.md)
- [Customization: adding images, where subjects are saved, and desktop export helpers](./docs/CUSTOMIZATION.md)

## Project structure

```
src/
  core/                  # ported mindmap-dungeon domain
    graph/               # subject graph CRUD + revalidation
    validation/notes/    # deterministic note validation
    validation/persistence/ # shared domain types
    progression/         # XP/rank/badge engine
    artifacts/           # markdown artifact generator
    review/              # archaeologist phase logic
  game/                  # Phaser scenes + systems
  store/                 # Zustand stores (session, subject, progression)
  services/persistence/  # localStorage + Electron bridge
  electron/              # main + preload (Electron only)
  ui/                    # React shell: welcome, HUD, room panel, modals
tests/unit/              # Vitest unit tests
docs/                    # PRD + progress notes
```

## Persistence

- **Electron**: subjects are written to
  `<userData>/dungeon-data/<subject-id>/dungeon.json`, with timestamped
  backups under `.backups/`. The home-screen **Admin** section can open the
  subjects root or export either the full subjects directory or an individual
  subject folder for migration between machines.
- **Web**: subjects fall back to `localStorage`; import/export is supported
  via the persistence facade.

## Why this exists

`repo-dungeon` had great gameplay but its content provider (GitHub
repositories) was the wrong fit for studying.
`mindmap-dungeon` had the right learning loop but the wrong tech stack for
the maintainer&rsquo;s preferences. Knowledge Dungeon keeps **repo-dungeon&rsquo;s
engine and shell** verbatim and swaps its content provider for
**mindmap-dungeon&rsquo;s subject-graph domain model**.

## License

MIT — see [`LICENSE`](./LICENSE).
