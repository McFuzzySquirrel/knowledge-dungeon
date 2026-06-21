# Progress

Current state as of 2026-06-21. Phases map to `docs/PRD.md` §14.

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

- [x] Welcome screen (create/load subjects, archetype selection, data management)
- [x] Phaser dungeon scene with procedural generation (BFS layout, L-corridors, multi-floor)
- [x] Player movement (WASD/arrows), camera (zoom tweens, follow)
- [x] Room panel with phase-adaptive tabs (Topic/Notes/Artifact/Self-Check)
- [x] Note editor with structured sections (Summary/Key Points/Recall Question), live word count, Edit/Preview toggle
- [x] Deterministic note validation rubric (5 criteria, 0–2 scoring)
- [x] XP/progression engine (3 rank tiers, badges, streak bonus)
- [x] Artifact markdown generation from validated notes
- [x] Minimap and interactive full map view with teleport (cooldown-gated)
- [x] Three-phase loop (Creator → Scribe → Archaeologist) with phase state machine
- [x] 3 archetypes: Scholar (+quality), Cartographer (+cross-links), Archivist (+streak cap)
- [x] In-dungeon NPCs with phase-aware guidance text
- [x] Help overlay, settings modal, toast notifications

**Sign-off:** End-to-end flow: create subject → build mindmap → write notes → earn XP → unlock Archaeologist → review

---

## Phase 2: Village Hub & UX Polish (COMPLETE)

- [x] Village hub Phaser scene (36×30 tile world, 6 buildings, 5 portal slots)
- [x] 5 wandering NPCs with patrol paths + learning quotes
- [x] Keeper NPC with 10-stage quest-driven dialogue
- [x] 10-step onboarding quest (auto-advance steps 1–6, manual confirm steps 7–9)
- [x] Compass overlay (nearest portal/Keeper), directional signposts
- [x] HUD sidebar (stats, phase selector, quest log, theme picker, collapsible drawer on mobile)
- [x] Three color themes: Night, Arcade, Aurora
- [x] Touch/mobile controls (drag, pinch, tap, floating action buttons, bottomsheet panels)
- [x] Responsive layout (900px/600px/480px breakpoints)
- [x] Tutorial dungeon (3 rooms via Training Grounds)
- [x] Import/export data management (JSON for web, folder-level for Electron)
- [x] Decorative elements: trees, bushes, ponds, flowers, torches, benches, fountain, birds
- [x] First-run gameplay loop onboarding modal
- [x] Export reminder (30-min interval for web users)

**Sign-off:** New user can complete onboarding → create subject → enter dungeon → return to village → manage data

---

## Current state

The project is at the end of **Phase 2**. All core gameplay, village hub, quest system, and mobile support are implemented. The codebase has 150+ functional requirements as documented in `docs/PRD.md`.

### Build & quality status

| Check | Status |
|-------|--------|
| `npm run lint` | Passing |
| `npm run typecheck` | Passing |
| `npm test -- --run` | 23 unit tests passing |
| `npm run build:web` | Passing |
| `npm run build:electron` | Passing |
| `npm run check:bundle-size` | Passing |

### Up next — Phase 3: Visual Unification & Gameplay Depth

See `docs/PRD.md` §14 for full details. Phase 3 is split into three parallel tracks:

**3a. Visual UI Unification** (3-week sprint per `docs/research/ui-enhancements.txt`)
- Week 1: Define shared 5-color palette + single game font for React & Phaser
- Week 2: Re-skin HUD + all panels as in-game elements with consistent borders/shadows
- Week 3: Create 10–15 shared icons, style buttons/scrollbars/inputs as game assets

**3b. Atmosphere & Polish**
- Vignette overlay, screen/modal transitions, background music, sound effects
- Replace procedural player shapes with per-archetype sprite art

**3c. Gameplay Depth**
- 3+ new biomes, boss rooms at milestones, equippable loot, cross-subject achievements
