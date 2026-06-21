# Progress

Current state as of 2026-06-21. Phases map to `docs/PRD.md` §14.

---

## Current state

The project is at the end of **Phase 3**. All Phase 3 tracks (visual unification, atmosphere/polish, gameplay depth) have been implemented. The codebase has 170+ functional requirements as documented in `docs/PRD.md`.

### Build & quality status

| Check | Status |
|-------|--------|
| `npm run lint` | Passing (0 errors) |
| `npm run typecheck` | Passing (0 errors) |
| `npm test -- --run` | 96 tests passing (23 test files) |
| `npm run build` | Passing |

### Up next — Phase 4: Advanced Features

See `docs/PRD.md` §14 for full details. Phase 4 includes:
- Spaced repetition scheduling for Archaeologist reviews (SM-2 algorithm)
- Study statistics dashboard (time spent, rooms per session, retention trends)
- Subject templates and sharing (via import/export of JSON)
- Tag system for cross-subject topic linking
- Custom biome/theme per subject
- In-game markdown editor enhancements (syntax highlighting, auto-complete)

---

## Phase 0: Foundation (COMPLETE)

- [x] Project scaffold (Vite + React + Phaser + Zustand + TypeScript + Electron)
- [x] ESLint (9.x), Vitest (4.x), CI/CD configuration
- [x] Core domain logic ported from mindmap-dungeon (graph, note validation, progression, artifacts, review)
- [x] Persistence layer (localStorage + Electron filesystem bridge)
- [x] 23 unit tests covering core domain logic

**Sign-off:** `npm run lint`, `npm run typecheck`, `npm test -- --run`, `npm run build:web`

---

## Phase 1: Core Game Loop (COMPLETE)

See PRD for full details. All core gameplay implemented.

---

## Phase 2: Village Hub & UX Polish (COMPLETE)

See PRD for full details. Village hub, onboarding, mobile support implemented.

---

## Phase 3: Visual Unification & Gameplay Depth (COMPLETE)

### 3a. Visual UI Unification

- [x] Shared 5-color palette (`src/theme/colors.ts`) — Wood & Stone theme with stone/gold/moss/ink/shadow, applied as CSS custom properties and exported for Phaser use
- [x] Shared game font (`src/theme/typography.ts`) — Cinzel (fantasy serif) loaded via Google Fonts, applied to all headings, HUD labels, panel titles
- [x] CSS custom properties updated to use unified palette colors across all themes
- [x] Game-asset button styling (`.game-btn-primary` — stone-textured with gold borders)
- [x] Parchment-style input fields (`.game-input` — dark background with stone border, gold focus glow)
- [x] Shared panel border style (`.game-panel` — 2px stone border with gold trim inset)
- [x] 15 shared icons (`src/theme/icons.ts`) — chest, map, book, gear, sword, potion, shield, scroll, key, crown, star, heart, compass, torch, crystal — all as inline SVG data URLs usable in both React and Phaser
- [x] Themed scrollbars (stone/gold colored in all browsers)
- [x] Icon button utility class

### 3b. Atmosphere & Polish

- [x] Vignette overlay (`.vignette-overlay` — radial gradient + inset box-shadow for dungeon atmosphere)
- [x] Screen transition classes (`.screen-transitioning`, `.screen-fade-overlay`)
- [x] Modal slide-up, backdrop fade, panel slide-in animations (already existed, consolidated)
- [x] Audio infrastructure (`src/services/audioManager.ts`) — full audio manager service with BGM/SFX toggles, volume control, track management, placeholder hooks for future audio files
- [x] Per-archetype sprite art — already existed (player-hero.svg, player-explorer.svg, player-archivist.svg loaded by DungeonScene)
- [x] Screen fade overlay class for scene transitions

### 3c. Gameplay Depth

- [x] 4 new biomes added to `src/game/systems/proceduralTextures.ts` (deepForest, frozenTundra, crystalCaverns, sunkenSwamp) — total now 9 biomes
- [x] Boss room system (`src/game/systems/bossRooms.ts`) — boss encounters at every 10th floor with 5 unique boss types, XP/loot multipliers, guaranteed rare+ loot
- [x] Equippable loot/gear system (`src/core/progression/lootSystem.ts`) — 4 equip slots (head, body, accessory, weapon), 12 unique equipable items across 3 rarities, stat bonuses (quality, XP, streak), roll system based on quality score
- [x] Cross-subject achievements (`src/core/progression/achievements.ts`) — 12 meta-achievements tracking progress across all subjects (masteries, notes, XP, rooms, reviews, artifacts, bosses, badges)
- [x] Progression store v3 — incorporates equipped items, extended per-subject stats, cross-subject achievement tracking
- [x] Equip/unequip methods with slot management in progression store

**Files created:**
- `src/theme/colors.ts` — shared palette
- `src/theme/typography.ts` — font configuration
- `src/theme/icons.ts` — 15 shared icons
- `src/theme/index.ts` — barrel export
- `src/services/audioManager.ts` — audio infrastructure
- `src/game/systems/bossRooms.ts` — boss encounter system
- `src/core/progression/lootSystem.ts` — equippable loot/gear
- `src/core/progression/achievements.ts` — cross-subject achievements

**Files modified:**
- `src/styles.css` — unified palette, font, vignette, scrollbars, game-asset styles, boss banner, achievement toast, equip slot styles
- `src/game/systems/proceduralTextures.ts` — 4 new biomes (9 total)
- `src/core/progression/types.ts` — EquippableLootItem, CrossSubjectProgress, Achievement types
- `src/core/progression/index.ts` — exports new modules
- `src/store/progressionStore.ts` — v3 persistence, equipped items, cross-subject achievements, equip/unequip methods
- `eslint.config.js` — ignore .agents/ directory
