# Progress

Current state as of 2026-06-21. Phases map to `docs/PRD.md` §14.

---

## Current state

The project is at the end of **Phase 4**. All Phase 4 features were implemented and then refined through playtesting. The codebase has 195+ functional requirements as documented in `docs/PRD.md`.

### Build & quality status

| Check | Status |
|-------|--------|
| `npm run lint` | Passing (0 errors) |
| `npm run typecheck` | Passing (0 errors) |
| `npm test -- --run` | 120 tests passing (24 test files) |
| `npm run build` | Passing |

### Up next — Phase 5: Quality & Scale

See `docs/PRD.md` §14 for full details. Phase 5 includes:
- Performance optimization for large subjects (100+ rooms)
- Accessibility audit and improvements (keyboard nav, screen reader support for UI)
- Keyboard shortcut customization
- Comprehensive error recovery (corrupt subject data, persistence failures)
- Localization / i18n support (i18next or similar)

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
- [x] Boss room system (`src/game/systems/bossRooms.ts`) — boss encounters at every 5th floor with 5 unique boss types, XP/loot multipliers, guaranteed rare+ loot
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

---

## Phase 4: Advanced Features (COMPLETE)

### 4a. Spaced Repetition (SM-2 Algorithm)

- [x] Created `src/core/review/spacedRepetition.ts` — full SM-2 algorithm implementation with quality ratings 0-5, ease factor computation, interval scheduling, next review dates, consecutive correct tracking
- [x] Extended `RoomMetadata` with SM-2 fields: `sm2QualityResponse`, `sm2EaseFactor`, `sm2IntervalDays`, `sm2NextReviewDate`, `sm2ConsecutiveCorrect`
- [x] Extended `ReviewAnalyticsSnapshot` with SM-2 scheduling stats: `overdueReviewCount`, `averageEaseFactor`, `dueTodayCount`
- [x] Updated `summarizeReviewAnalytics` to compute SM-2 statistics from room metadata
- [x] Integrated SM-2 into `recordReviewPass` in subjectStore — automatic state updates based on quality rating
- [x] Schema version bump from '1.0.0' to '1.1.0' with migration defaults in persistence layer
- [x] Import/export supports both schema versions with automatic migration
- [x] 35 exhaustive unit tests in `tests/unit/spacedRepetition.test.ts`

### 4b. Markdown Editor Enhancements

- [x] Created `src/ui/utils/markdownHighlight.ts` — tokenizes markdown text (headings, bold, italic, code, links, images, lists) for syntax highlighting
- [x] Created `src/ui/utils/markdownAutocomplete.ts` — context-aware suggestion engine with syntax snippets, section headers, and trigger-based suggestions
- [x] Updated `NoteEditorModal.tsx` — added overlay-based syntax highlighting behind the textarea, auto-complete dropdown with keyboard navigation (ArrowUp/Down, Enter, Tab, Escape)
- [x] Added CSS for `.md-editor-wrapper`, `.md-highlight-overlay`, `.md-autocomplete`, and associated tokens

### 4c. Custom Biome per Subject

- [x] Added `biome?: string` field to `DungeonMetadata` in persistence types
- [x] Added `biome?` to `RootDungeonInitInput` in graph types
- [x] Updated `createRootDungeon` to accept and persist biome
- [x] Added biome selector dropdown in WelcomeScreen subject creation form (all 9 biomes available)
- [x] Wired selected biome through `initSubject` → `createRootDungeon` → `DungeonMetadata`
- [x] Wired biome from `snapshot.dungeon.biome` through GameScreen to DungeonScene's `floorBiomeOverride`

### 4d. Subject Templates & Sharing

- [x] Created `exportSubjectAsTemplate()` — exports subject as a reusable template (strips notes/artifacts, preserves graph structure)
- [x] Created `createSubjectFromTemplate()` — instantiates a new subject from a template JSON with fresh IDs and empty room states
- [x] Added "Export as template" buttons per subject in WelcomeScreen data tab
- [x] Added "Create from template" button and file input in WelcomeScreen data tab

### 4e. Study Statistics Dashboard

- [x] Created `src/services/sessionTracker.ts` — logs session start/end times, rooms visited, notes submitted, reviews completed, XP earned
- [x] Session persistence to localStorage with 500-record cap
- [x] Aggregate stats: total sessions, study time, average session length, daily streaks, per-subject breakdowns
- [x] Created `src/ui/components/StudyStatsPanel.tsx` — full statistics dashboard modal with overview cards, activity summary, subject progress, review/retention stats, recent sessions, per-subject breakdown
- [x] Added CSS for `.study-stats-panel`, `.stats-overview`, `.stats-card`, `.stats-section`, `.stats-row`

### 4f. Tag System

- [x] Added `tags?: string[]` to `RoomMetadata` in persistence types
- [x] Added `tagIndex?: Record<string, string[]>` to `DungeonMetadata`
- [x] Created `src/core/graph/tagDomain.ts` — tag index rebuilding, normalization, set/add/remove operations, cross-subject room search by tag
- [x] Added tag management methods to subjectStore: `setRoomTags`, `addRoomTag`, `removeRoomTag`, `getAllTags`
- [x] Created `src/ui/components/TagEditor.tsx` — inline tag assignment with chips, input, and removal
- [x] Created `TagNavigation` component for cross-subject tag-based room linking
- [x] Added CSS for `.tag-editor`, `.tag-chip`, `.tag-input`, `.tag-navigation`

**Files created:**
- `src/core/review/spacedRepetition.ts` — SM-2 algorithm
- `tests/unit/spacedRepetition.test.ts` — 35 exhaustive tests
- `src/ui/utils/markdownHighlight.ts` — syntax highlighting tokenizer
- `src/ui/utils/markdownAutocomplete.ts` — auto-complete suggestion engine
- `src/services/sessionTracker.ts` — session logging and stats computation
- `src/ui/components/StudyStatsPanel.tsx` — statistics dashboard UI
- `src/ui/components/TagEditor.tsx` — tag editor and cross-subject navigation
- `src/core/graph/tagDomain.ts` — tag domain logic

**Files modified:**
- `src/core/validation/persistence/types.ts` — SM-2 fields, tags, biome, tagIndex, schema v1.1.0
- `src/core/review/types.ts` — extended ReviewAnalyticsSnapshot
- `src/core/review/reviewDomain.ts` — SM-2 stats computation in summarizeReviewAnalytics
- `src/core/review/index.ts` — export spacedRepetition
- `src/core/graph/types.ts` — biome in RootDungeonInitInput
- `src/core/graph/graphDomain.ts` — biome persistence in createRootDungeon
- `src/core/graph/index.ts` — export tagDomain
- `src/store/subjectStore.ts` — SM-2 in recordReviewPass, tag management methods, biome in initSubject
- `src/services/persistence/subjectPersistence.ts` — schema migration v1.0.0→v1.1.0, template export/import
- `src/ui/components/NoteEditorModal.tsx` — syntax highlighting overlay, auto-complete dropdown
- `src/ui/screens/WelcomeScreen.tsx` — biome selector, template export/import
- `src/ui/screens/GameScreen.tsx` — wire biome to dungeon scene
- `src/styles.css` — syntax highlighting, auto-complete, stats panel, tag system CSS
- `eslint.config.js` — argsIgnorePattern for _ prefix

### Phase 4 Review Refinements

After initial Phase 4 implementation, the following issues were fixed during playtesting:

- [x] **Format button replaces auto-complete** — The auto-complete dropdown overlapped note panel actions. Replaced with a "Format" toolbar button that opens a panel of markdown formatting buttons (bold, italic, code, link, image, list, headings, quote, HR). Buttons insert syntax at cursor or wrap selected text.
- [x] **Floor mechanic fix** — Biome override was lost during floor transitions and teleports. Fixed by making `floorBiomeOverride` sticky in `DungeonScene.applyFloorVisibility()` (only updates when explicitly provided) and forwarding `biomeId` in all `setFloorVisibility` calls (floor transition + `syncFloorForRoom`).
- [x] **Always show WelcomeScreen on startup** — Removed auto-redirect to village when subjects exist. Added "Continue to Village" button to WelcomeScreen header for quick access.
- [x] **Biome selector in village** — Added biome dropdown to the "Create New Subject" modal in the village. Added biome changer to dungeon portal info panel (change an existing subject's theme without recreating it).
- [x] **Biome visual distinction** — Added `wallTint` and `corridorColor` to each biome palette. Room walls and corridor strokes now change color per biome instead of being hardcoded slate/blue. Previously only floor tiles differed between biomes.
- [x] **Village welcome proximity-based** — Welcome message now appears when the player walks near the `sign-entrance` waypoint and auto-hides when moving away. Removed the one-time timed popup.
- [x] **Boss mechanic wired in** — Boss room system was defined but never integrated. Wired `isBossFloor` check into `NoteEditorModal` defeat flow. Changed milestone interval from 10 to 5 floors for better accessibility.
- [x] **NPC dialog anchored to NPC head** — Changed anchor point from NPC sprite center to top (`npc.y - displayHeight/2`). Reduced dialog gap from 18px to 8px for tighter placement.
- [x] **Game guide** — Created `docs/GAME-GUIDE.md` and wired into in-game Library panel.

**Files modified in review:**
- `src/ui/components/NoteEditorModal.tsx` — format panel + boss wiring
- `src/ui/utils/markdownAutocomplete.ts` — removed redundant section suggestions
- `src/ui/screens/GameScreen.tsx` — biome forwarding in floor transitions
- `src/game/scenes/DungeonScene.ts` — sticky biome override + `lightenHex` + NPC anchor fix + biome wall/corridor colors
- `src/game/systems/proceduralTextures.ts` — wallTint + corridorColor per biome, `getBiomePalette` export
- `src/ui/App.tsx` — removed auto-redirect to village
- `src/ui/screens/WelcomeScreen.tsx` — "Continue to Village" button
- `src/ui/screens/VillageScreen.tsx` — biome in create modal + dungeon panel, proximity welcome, library guide tab
- `src/ui/components/RoomNpcDialog.tsx` — tightened dialog gap
- `src/game/systems/bossRooms.ts` — interval changed to 5
- `src/styles.css` — format panel styles
- `docs/PROGRESS.md` — updated
- `docs/GAME-GUIDE.md` — created
