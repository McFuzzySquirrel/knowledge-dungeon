# Knowledge Dungeon

## 1. Overview

**Product Name:** Knowledge Dungeon
**Summary:** A local-first, mindmap-driven dungeon crawler for studying. Each subject (e.g. "Linear Algebra") becomes a dungeon whose rooms are topic-nodes in a user-authored mindmap. To "defeat" a room, the player writes structured notes that pass a deterministic quality rubric. Defeated rooms drop XP, loot, and a generated artifact. Once every room is cleared, the Archaeologist phase unlocks self-check prompts and review-streak tracking. The game begins in a Dungeon Village hub world where players create subjects, select their archetype, meet the guide NPC, view their collection, and enter dungeon portals.
**Target Platform:** Web (Vite) and Desktop (Electron 42)
**Key Constraints:** Fully local-first - no network calls required. Desktop persists to filesystem; web falls back to localStorage. Zero AI grading - all validation deterministic and auditable.

---

## 2. Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-06-21 | - | Initial comprehensive PRD from existing codebase |
| 1.1 | 2026-06-21 | - | Added NPC/Archetype requirement groups, per-component AC, expanded NFRs, error recovery, server/Electron sections; restructured Phase 3 per UI research |

---

## 3. Goals and Non-Goals

### 3.1 Goals
- Provide a gamified study tool that motivates structured note-taking through dungeon-crawler mechanics
- Enable users to create, navigate, and study subject mindmaps in an immersive top-down 2D game world
- Offer a three-phase learning loop: author content (Creator), study and take notes (Scribe), review and reinforce (Archaeologist)
- Maintain a persistent village hub that gives context, guidance, and a sense of place
- Keep all data local-first with no dependency on cloud services
- Ensure all note validation is deterministic, reproducible, and transparent to the user

### 3.2 Non-Goals
- Multi-user or cloud sync (no accounts, no server-side persistence)
- Server-side AI assistance or AI grading
- Tauri shell (Electron only for desktop builds)
- Multiplayer or real-time collaboration
- Native mobile apps (mobile-web responsive only)

---

## 4. User Stories / Personas

### 4.1 Personas

| Persona | Description | Key Needs |
|---------|-------------|-----------|
| Student | Studying a structured subject (e.g., Linear Algebra, History) and wants to organize knowledge | Create subject mindmaps, take structured notes, track progress, review for exams |
| Lifelong Learner | Self-studying a topic in their free time | Quick setup, gamification for motivation, ability to review and reinforce over time |
| Power User | Deeply engaged with many subjects, wants full control | Export/import data, organize complex mindmaps, track detailed analytics |

### 4.2 User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| US-01 | Student | Create a subject with a root topic | I can start building my knowledge map | Must |
| US-02 | Student | Add child topics to any room | I can expand my mindmap hierarchically | Must |
| US-03 | Student | Navigate the dungeon with WASD/touch | I can explore my subject visually | Must |
| US-04 | Student | Write structured notes for each room | I can capture and organize my knowledge | Must |
| US-05 | Student | See my notes validated against a rubric | I know my notes meet quality standards | Must |
| US-06 | Student | Earn XP and badges for completing rooms | I stay motivated to keep studying | Must |
| US-07 | Student | Review past topics with self-check prompts | I reinforce my knowledge over time | Must |
| US-08 | Student | See my overall progression across subjects | I can track my learning journey | Should |
| US-09 | Student | Export/import my subjects | I can back up or transfer my data | Should |
| US-10 | Student | Use the village hub as my home base | I get context and guidance before entering dungeons | Should |
| US-11 | Student | Customize my experience with themes | I can study in a visually comfortable environment | Could |

---

## 5. Research Findings

### Technology Choices

The tech stack was inherited from `repo-dungeon`, a sibling project, to maximize code reuse and developer familiarity:

| Technology | Version | Rationale |
|-----------|---------|-----------|
| React | 19.x | Industry-standard UI framework for overlays, modals, HUD |
| Phaser | 3.87.x | Mature 2D game engine with WebGL/canvas rendering, scene management, input handling |
| Zustand | 4.5.x | Minimal, TypeScript-first state management - lighter than Redux, simpler than Context |
| Vite | 8.x | Fast dev server, native ESM, excellent TypeScript support, plugin ecosystem |
| TypeScript | 5.6.x | Type safety across the entire codebase |
| Electron | 42.x | Cross-platform desktop packaging with filesystem access |
| Vitest | 4.x | Fast, Vite-native test runner with Jest compatibility |
| ESLint | 9.x | Flat config, modern linting |

### Version Currency

| Technology | PRD Version | Latest Available | Status |
|-----------|-------------|-----------------|--------|
| Phaser | 3.87.x (package.json) | 4.2.0 | Behind - v4 is a major upgrade with new renderer; migration requires planning |
| Zustand | 4.5.x (package.json) | 5.0.14 | Behind - v5 has breaking changes; stable path forward |
| TypeScript | 5.6.x (package.json) | 6.0.3 | Behind - minor breaking changes in v6 |
| React | 19.x (package.json) | 19.2.7 | Current patch behind |
| Vite | 8.x (package.json) | 8.0.16 | Current patch behind |
| Electron | 42.x (package.json) | 42.4.1 | Current patch behind |
| Express | 5.x (package.json) | 5.x (no minor tracked) | Current; actively maintained |
| Multer | 2.x (package.json) | 2.x (no minor tracked) | Current; actively maintained |

Upgrading Phaser, Zustand, or TypeScript to latest major versions is not required for current development but should be tracked as technical debt. The pinned versions in `package.json` are stable and fully supported.

### Design Principles
- **Local-first**: All data persists locally. No accounts, no cloud sync, no telemetry.
- **Deterministic validation**: Every XP delta, quality bonus, and badge award is reproducible from the same inputs. No AI or randomization in grading.
- **Procedural generation**: Dungeon layouts, floor textures, and room decorations are deterministic from the topic graph seed.
- **Phaser for game world, React for UI shell**: Game rendering (dungeon, village) in Phaser; all HUD, modals, overlays in React overlaid on top.

---

## 6. Concept

### 6.1 Core Loop / Workflow

```
Village Hub
  ├── Create Subject (name + root topic)
  ├── Select Archetype (Scholar / Cartographer / Archivist)
  ├── Enter Dungeon Portal
  │   └── PHASE 1: Creator
  │       ├── Add rooms / child topics to build mindmap
  │       └── Optionally add cross-links and restructure
  │   └── PHASE 2: Scribe (auto-unlocked after first artifact)
  │       ├── Explore dungeon room by room
  │       ├── Press E to open encounter → write structured notes
  │       ├── Notes validated against rubric (≥120 words, 3 sections)
  │       └── On pass: earn XP + loot + artifact markdown
  │   └── PHASE 3: Archaeologist (unlocked when all rooms cleared)
  │       ├── Revisit rooms for self-check prompts
  │       ├── Answer prompts to earn review XP
  │       └── Track review streaks
  └── Return to Village (view trophies, check quests, manage data)
```

### 6.2 Success / Completion Criteria
- A subject is "mastered" when all rooms have been cleared in Scribe phase and fully reviewed in Archaeologist phase
- Subject achieves `SubjectMastered` phase state
- User has collected all available badges for that subject

---

## 7. Technical Architecture

### 7.1 Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| UI Framework | React | 19.x |
| Game Engine | Phaser | 3.87.x |
| State Management | Zustand | 4.5.x |
| Build Tool | Vite | 8.x |
| Language | TypeScript | 5.6.x |
| Desktop Shell | Electron | 42.x |
| Test Runner | Vitest | 4.x |
| Linter | ESLint | 9.x |
| Server (prod) | Express | 5.x |
| DOM Testing | Testing Library | Latest |

### 7.2 Project Structure

```
src/
├── core/                      # Domain logic (ported from mindmap-dungeon)
│   ├── graph/                 # Subject graph CRUD + revalidation
│   ├── validation/
│   │   ├── persistence/       # Shared domain types
│   │   └── notes/             # Deterministic note validation engine
│   ├── progression/           # XP/rank/badge engine
│   ├── artifacts/             # Markdown artifact generator
│   └── review/                # Archaeologist phase logic
├── game/                      # Phaser scenes + systems
│   ├── scenes/
│   │   ├── DungeonScene.ts    # Dungeon crawler scene (1653 lines)
│   │   └── VillageScene.ts    # Village hub scene (914 lines)
│   └── systems/
│       ├── dungeonGenerator.ts # BFS room layout generation
│       ├── playerClasses.ts    # 3 study archetypes
│       └── proceduralTextures.ts # Biome floor generators
├── store/                     # Zustand stores
│   ├── subjectStore.ts
│   ├── sessionStore.ts
│   ├── progressionStore.ts
│   └── preferencesStore.ts
├── services/
│   ├── persistence/           # localStorage + Electron bridge
│   └── electronBridge/
├── electron/                  # Electron main + preload
├── data/                      # Static game data
│   ├── villageLayout.ts       # Village map definition
│   └── tutorialSubject.ts     # 3-room tutorial
└── ui/
    ├── App.tsx                # Root component + screen routing
    ├── screens/
    │   ├── WelcomeScreen.tsx   # Create/load subjects
    │   ├── VillageScreen.tsx   # Village hub + HUD
    │   └── GameScreen.tsx      # Dungeon game shell
    ├── components/             # 20+ UI components
    ├── hooks/                  # Custom hooks
    └── utils/                  # Utilities
```

### 7.3 Key APIs / Interfaces

| Interface | Location | Description |
|-----------|----------|-------------|
| `SubjectSnapshot` | `src/core/validation/persistence/types.ts` | Full subject data: metadata + rooms |
| `DungeonMetadata` | `src/core/validation/persistence/types.ts` | Subject-level state (phase, name, ids) |
| `RoomMetadata` | `src/core/validation/persistence/types.ts` | Per-room state (notes, artifacts, validation) |
| `NoteValidationResult` | `src/core/validation/notes/types.ts` | Rubric scores, pass/fail, fix hints |
| `ProgressionState` | `src/core/progression/types.ts` | XP, rank, badges, inventory |
| `subjectStore` | `src/store/subjectStore.ts` | Zustand store for subject CRUD |
| `sessionStore` | `src/store/sessionStore.ts` | Zustand store for active screen/phase |
| `progressionStore` | `src/store/progressionStore.ts` | Zustand store for XP/badges |
| `preferencesStore` | `src/store/preferencesStore.ts` | Theme, graphics preferences |
| `subjectPersistence` | `src/services/persistence/subjectPersistence.ts` | Save/load/export persistence facade |

---

## 8. Functional Requirements

### 8.1 Subject Management

| ID | Requirement | Priority |
|----|-------------|----------|
| SM-01 | User can create a new subject with a name and root topic | Must |
| SM-02 | User can see a list of existing subjects on the welcome screen with progress info | Must |
| SM-03 | User can delete a subject | Must |
| SM-04 | User can rename a subject | Should |
| SM-05 | User can import a subject from JSON | Should |
| SM-06 | User can export a subject as JSON | Should |
| SM-07 | User can select an archetype before entering a dungeon | Must |

### 8.2 Dungeon Generation

| ID | Requirement | Priority |
|----|-------------|----------|
| DG-01 | Dungeon layout is procedurally generated from the topic graph using BFS | Must |
| DG-02 | Rooms are placed on a macro grid with collision avoidance | Must |
| DG-03 | Corridors connect rooms with L-shaped paths | Must |
| DG-04 | Dungeon supports multiple floors with stair portals | Must |
| DG-05 | Walkability grid restricts player movement to visible rooms | Must |
| DG-06 | Room decorations (bookshelves, braziers, chests) are placed deterministically | Must |
| DG-07 | Procedural floor textures are generated per biome | Must |
| DG-08 | Ambient particle effects (dust motes) render in the dungeon | Should |

### 8.3 Dungeon Navigation

| ID | Requirement | Priority |
|----|-------------|----------|
| DN-01 | Player moves with WASD or arrow keys | Must |
| DN-02 | Player can zoom in/out | Must |
| DN-03 | Camera follows the player with room-based zoom tweens | Must |
| DN-04 | Minimap shows floor layout in bottom-right corner | Must |
| DN-05 | Full map view shows interactive mindmap with teleport | Must |
| DN-06 | Player can switch floors via stair/portal icons | Must |
| DN-07 | Teleport mode allows clicking a room on the full map to jump there (with cooldown) | Must |
| DN-08 | Touch controls: drag to move, pinch to zoom, tap to interact | Must |

### 8.4 Creator Phase

| ID | Requirement | Priority |
|----|-------------|----------|
| CR-01 | User can add child topic rooms to any existing room | Must |
| CR-02 | User can add cross-links between rooms | Must |
| CR-03 | User can reparent rooms in the topic hierarchy | Must |
| CR-04 | User can remove rooms from the graph | Must |
| CR-05 | Room panel shows Topic tab with graph editing controls when in Creator phase | Must |
| CR-06 | User can bulk-import topics from comma-separated input | Should |
| CR-07 | Phase auto-advances to Scribe when the first artifact is collected | Must |
| CR-08 | HUD shows phase selector with confirmation when switching mid-progress | Must |

### 8.5 Scribe Phase

| ID | Requirement | Priority |
|----|-------------|----------|
| SC-01 | Player can press E on a room to open the note editor | Must |
| SC-02 | Note editor provides structured sections: Summary, Key Points, Recall Question | Must |
| SC-03 | Note editor shows live word count and minimum requirement (≥120 words) | Must |
| SC-04 | Note editor includes Edit/Preview toggle for markdown rendering | Must |
| SC-05 | User can save notes as draft without full validation | Must |
| SC-06 | User can submit notes for validation against deterministic rubric | Must |
| SC-07 | Validation checks: section completeness, concept coverage, link references, recall question quality, clarity | Must |
| SC-08 | User must manually confirm submission even if rubric passes | Must |
| SC-09 | On pass: award XP, roll for loot, generate artifact markdown | Must |
| SC-10 | On fail: show actionable fix hints with scores | Must |
| SC-11 | Room panel shows Notes tab when in Scribe phase | Must |
| SC-12 | User can attach images to notes (local file picker or external URL) | Should |

### 8.6 Archaeologist Phase

| ID | Requirement | Priority |
|----|-------------|----------|
| AR-01 | Archaeologist phase unlocks when all rooms are in a reviewable state | Must |
| AR-02 | User can revisit cleared rooms for self-check prompts | Must |
| AR-03 | Self-check prompts are generated from room headings, topics, and relations | Must |
| AR-04 | Room panel shows Self-Check tab in Archaeologist phase | Must |
| AR-05 | Review progress bar shows rooms reviewed vs total | Must |
| AR-06 | Review analytics track session count, full passes, streaks | Should |
| AR-07 | 6 XP awarded per review pass | Should |
| AR-08 | Badges awarded at 2, 3, 7, 15 full review passes | Should |

### 8.7 Progression System

| ID | Requirement | Priority |
|----|-------------|----------|
| PR-01 | XP is awarded for completing encounters (base 20 + bonuses) | Must |
| PR-02 | Quality bonus (0–10) based on rubric score | Must |
| PR-03 | Streak bonus (0–5) for consecutive successful submissions | Should |
| PR-04 | Three rank tiers: Novice (0–299), Scholar (300–799), Master (800+) | Must |
| PR-05 | Badges for completing each phase, review milestones, and 120-word notes | Must |
| PR-06 | Loot system: quality-based roll (common/rare/epic) | Should |
| PR-07 | Inventory view shows collected loot | Should |
| PR-08 | Journal view shows completed notes per room | Should |

### 8.8 Village Hub

| ID | Requirement | Priority |
|----|-------------|----------|
| VH-01 | Village is a 2D explorable hub world rendered in Phaser | Must |
| VH-02 | Dungeon portals appear for each created subject with animated vortex effect | Must |
| VH-03 | Keeper's Tower houses the quest board and guide NPC | Must |
| VH-04 | Guild Hall allows creating new subjects | Must |
| VH-05 | Training Grounds launches the 3-room tutorial dungeon | Must |
| VH-06 | Trophy Hall shows collection (badges, artifacts, journal entries, dungeon count) | Must |
| VH-07 | Library of Knowledge shows controls reference and gameplay explanation | Must |
| VH-08 | 5 wandering NPCs with learning quotes patrol village paths | Must |
| VH-09 | Keeper NPC has 10-stage quest-driven dialogue | Must |
| VH-10 | Wayfinding signposts at crossroads show directions to buildings | Must |
| VH-11 | Compass overlay points toward nearest portal or Keeper | Must |
| VH-12 | Decorative elements: trees, bushes, ponds, flowers, torches, benches, fountain, birds | Should |
| VH-13 | Quest log shows current onboarding step and progress | Must |

### 8.9 Archetype System

| ID | Requirement | Priority |
|----|-------------|----------|
| AC-01 | Three archetypes available: Scholar, Cartographer, Archivist | Must |
| AC-02 | Scholar archetype grants +2 quality bonus on note validation | Must |
| AC-03 | Cartographer archetype grants +1 cross-link capacity per room | Must |
| AC-04 | Archivist archetype grants +3 max review streak cap | Must |
| AC-05 | Archetype is selected before first dungeon entry and persists per subject | Must |
| AC-06 | Archetype perk detail is shown in the HUD sidebar | Must |
| AC-07 | Archetype can be changed between subjects independently | Should |

### 8.10 NPC System

| ID | Requirement | Priority |
|----|-------------|----------|
| NPC-01 | Each dungeon room has an NPC with phase-aware guidance text | Must |
| NPC-02 | NPC text adapts to room state (Created/Visited/Cleared/Reviewable) | Must |
| NPC-03 | NPC has floating idle animation in the dungeon scene | Must |
| NPC-04 | NPC dialog bubble anchors to NPC world coordinates | Must |
| NPC-05 | Dialog dismisses when player moves out of interaction range | Must |
| NPC-06 | Village NPCs patrol predefined paths | Must |
| NPC-07 | Keeper NPC has 10-stage quest-driven dialogue in the village | Must |
| NPC-08 | 5 wandering village NPCs display random learning quotes on interaction | Must |
| NPC-09 | NPC interaction via E key (keyboard) or touch tap (mobile) | Must |
| NPC-10 | Proximity detection with configurable interaction radius | Should |

### 8.11 Quest / Onboarding System

| ID | Requirement | Priority |
|----|-------------|----------|
| QS-01 | 10-step onboarding quest guides new players: Intro → Meet Keeper → Create Subject → Visit Training → Pick Archetype → Enter Dungeon → Clear Room → Write Note → Review Artifact → Complete | Must |
| QS-02 | Steps 1–6 advance automatically on action | Must |
| QS-03 | Steps 7–9 require manual "Mark Complete" on the quest board | Must |
| QS-04 | First-run gameplay loop onboarding modal explains Creator/Scribe/Archaeologist | Should |
| QS-05 | Tutorial overlay provides in-dungeon hints during the tutorial | Should |

### 8.12 HUD and UI

| ID | Requirement | Priority |
|----|-------------|----------|
| HUD-01 | Sidebar HUD shows: subject name, room count, XP, rank, badges, notes count, review progress | Must |
| HUD-02 | HUD includes phase selector, teleport cooldown, action buttons | Must |
| HUD-03 | HUD is collapsible drawer on mobile | Must |
| HUD-04 | Room panel is draggable/resizable with phase-adaptive tabs | Must |
| HUD-05 | Help overlay shows controls reference | Must |
| HUD-06 | Toast notifications for info/error/success | Should |
| HUD-07 | XP popup animation when XP is earned | Should |
| HUD-08 | Three color themes: Night (dark), Arcade (colorful), Aurora | Should |

### 8.13 Data Persistence

| ID | Requirement | Priority |
|----|-------------|----------|
| DP-01 | All subject data persists to localStorage in web builds | Must |
| DP-02 | All subject data persists to filesystem in Electron builds | Must |
| DP-03 | Timestamped backups are created on save | Should |
| DP-04 | Subject index tracks all known subject IDs | Must |
| DP-05 | Active subject ID persists across sessions | Must |
| DP-06 | Export reminder nudges web users every 30 minutes | Should |
| DP-07 | Image attachments persist alongside subject data | Should |

### 8.14 Production Server

The production Express server provides a self-hosted deployment option for the web build, with server-side persistence and image upload.

| ID | Requirement | Priority |
|----|-------------|----------|
| PS-01 | Server serves the built web app (`dist/`) as static files | Must |
| PS-02 | Server exposes `POST /api/upload` for image attachment uploads with file type validation (png, jpg, webp, gif, svg) and 10MB size limit | Must |
| PS-03 | Server exposes `GET /api/subjects` to list all subject IDs | Must |
| PS-04 | Server exposes `GET /api/subjects/:id` to load a subject's JSON data | Must |
| PS-05 | Server exposes `POST /api/subjects/:id` to save a subject's JSON data | Must |
| PS-06 | Server exposes `DELETE /api/subjects/:id` to delete a subject | Must |
| PS-07 | Subject data persists to a configurable `DATA_DIR` on the filesystem | Must |
| PS-08 | Uploaded images are served from `/uploads/` path | Must |
| PS-09 | Dockerfile and docker-compose.yml provided for containerized deployment | Should |
| PS-10 | Server runs on configurable `PORT` (default 3000) | Should |

### 8.15 Electron Shell

| ID | Requirement | Priority |
|----|-------------|----------|
| ES-01 | Electron main process creates a BrowserWindow loading the Vite dev server (dev) or built files (production) | Must |
| ES-02 | IPC handlers expose filesystem operations: save/load/delete/list subjects to `userData/dungeon-data/` | Must |
| ES-03 | IPC handlers expose file dialogs for import/export and folder selection | Must |
| ES-04 | Electron preload script uses `contextBridge` to expose only safe IPC channels to the renderer | Must |
| ES-05 | Subject data root determined by `app.getPath('userData')` per platform | Must |
| ES-06 | Image attachments saved alongside subject data with MIME type validation | Must |
| ES-07 | Linux dev mode disables sandbox flags for compatibility | Should |
| ES-08 | External URL navigation validated as safe (https/http only) before opening | Must |

---

## 9. Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF-01 | All data stored locally - zero network calls for core functionality | Must |
| NF-02 | Note validation is fully deterministic - same input always produces same result | Must |
| NF-03 | Application runs offline with no degradation | Must |
| NF-04 | Bundle size monitored via CI guard (scripts/check-bundle-size.mjs) | Must |
| NF-05 | All state changes are synchronous with no loading states for local operations | Should |
| NF-06 | TypeScript strict mode across entire codebase | Must |
| NF-07 | 100% lint pass with ESLint flat config | Must |
| NF-08 | Test suite passes before any release | Must |
| NF-09 | Dungeon rendering maintains 30+ FPS on mid-range hardware (integrated GPU) for subjects up to 100 rooms | Should |
| NF-10 | Initial app load time ≤ 3 seconds on broadband connection (web) | Should |
| NF-11 | Subject data load time ≤ 500ms for subjects up to 100 rooms | Should |
| NF-12 | Phaser canvas rendering uses WebGL with automatic Canvas fallback | Should |
| NF-13 | Memory usage stays under 200MB for typical usage (web build) | Should |

---

## 10. Security and Privacy

| ID | Requirement | Priority |
|----|-------------|----------|
| SP-01 | No user data is sent to any external server | Must |
| SP-02 | No telemetry, tracking, or analytics are collected | Must |
| SP-03 | No authentication or user accounts are required | Must |
| SP-04 | Image attachment URLs validated against MIME types | Should |
| SP-05 | Electron context bridge limits renderer to safe IPC calls | Must |

The application collects, stores, and transmits zero user data externally. Everything remains on the user's local machine. There are no network calls for core functionality. Image attachments are validated by MIME type before display. The Electron preload script uses contextBridge to expose only safe filesystem operations to the renderer process.

### Data Integrity & Error Recovery

| ID | Requirement | Priority |
|----|-------------|----------|
| DR-01 | Subject data is validated on load; corrupt data shows a descriptive error rather than crashing | Must |
| DR-02 | Timestamped backups created before every save (Electron: filesystem; web: retained in memory for session) | Should |
| DR-03 | Persistence writes are synchronous and atomic - partial writes do not leave subjects in an unrecoverable state | Must |
| DR-04 | Export reminder nudges web users to back up data every 30 minutes | Should |
| DR-05 | Import validates JSON structure before applying; rejects malformed input with actionable feedback | Should |
| DR-06 | Session state (active subject, phase, UI preferences) persists across page reloads | Must |
| DR-07 | Application degrades gracefully when localStorage quota is exceeded (web) - warns user and suggests export | Should |

---

## 11. Accessibility

| ID | Requirement | Priority |
|----|-------------|----------|
| ACC-01 | Text in UI elements uses sufficient color contrast against backgrounds | Should |
| ACC-02 | Interactive elements are reachable via keyboard where feasible | Should |
| ACC-03 | Game controls documented in the Help overlay | Must |
| ACC-04 | Mobile touch controls provided for coarse-pointer devices | Must |
| ACC-05 | Markdown notes rendered as safe HTML with proper heading hierarchy | Should |

The application is primarily a game with keyboard/touch controls, limiting full screen reader compatibility. The React UI shell (HUD, modals, dialogs) uses semantic HTML where practical. The game world itself requires visual-spatial navigation.

---

## 12. User Interface / Interaction Design

### Screen Flow

```
WelcomeScreen
  ├── Subject list (create / load / delete subjects)
  ├── Archetype selector (Scholar / Cartographer / Archivist)
  ├── Data management (import/export/admin)
  └── Navigate → VillageScreen

VillageScreen
  ├── Phaser village scene (explorable hub world)
  ├── React HUD sidebar (quest log, dungeon list, theme picker)
  ├── Building interaction (create subject, view trophies, help, tutorial)
  └── Enter dungeon portal → GameScreen

GameScreen
  ├── Phaser dungeon scene (top-down dungeon crawler)
  ├── React HUD sidebar (stats, phase selector, action buttons)
  ├── Room panel (Topic / Notes / Artifact / Self-Check tabs)
  ├── Modal overlays (note editor, full map, inventory, help, settings)
  └── Return to village → VillageScreen
```

### Key Interaction Patterns
- **E key** (keyboard) or **sword button** (mobile) to interact with rooms/NPCs
- **WASD/arrows** (keyboard) or **drag** (touch) for movement
- **Scroll wheel/pinch** for zoom
- **Tab system** in room panel adapts to current phase
- **Draggable/resizable** room panel
- **Modal overlays** for full-screen tasks (editing notes, viewing map)

### Theming
Three themes: Night (dark background, light text), Arcade (colorful, high saturation), Aurora (muted, nature-inspired). Applied via CSS custom properties on `data-theme` attribute.

### Mobile Adaptations
- HUD collapses to drawer on <900px width
- Floating action buttons (interact, zoom)
- Bottom-sheet room panel on small screens
- Touch interact button replaces E key
- Responsive CSS with `dvh` units

---

## 13. System States / Lifecycle

### Phase State Machine

```
SubjectCreated
    ↓ (user creates subject)
CreatorActive
    ↓ (first artifact collected - auto-advance)
CreatorComplete
    ↓ (user can still edit, but Scribe is active)
ScribeActive
    ↓ (partial rooms cleared)
ScribePartial
    ↓ (all rooms cleared)
ScribeComplete
    ↓ (auto-unlock when 100% cleared)
ArchaeologistUnlocked
    ↓ (first review)
ArchaeologistActive
    ↓ (all rooms fully reviewed)
SubjectMastered
```

### Application Lifecycle States
- **Loading**: Initial app bootstrap, subject data loaded from persistence
- **Active**: User interacting with the app (village, dungeon, welcome)
- **Saving**: Subject data written to persistence (synchronous, instant)
- **Error**: Persistence failure, invalid subject data, UI error toasts
- **Unloading**: Session state saved before tab close / app quit

---

## 14. Implementation Phases

The following phases describe work already completed. All phases 0–5 are complete.

Each phase is independently shippable and adds standalone value. Completion criteria verify the phase delivers its intended outcomes before proceeding to the next.

### Phase 0: Foundation (COMPLETE)
- [x] Project scaffold (Vite + React + Phaser + Zustand + TypeScript + Electron)
- [x] ESLint, Vitest, CI/CD configuration
- [x] Core domain logic ported from mindmap-dungeon (graph, validation, progression, artifacts, review)
- [x] Persistence layer (localStorage + Electron bridge)
- [x] 23 unit tests covering core domain logic

**Completion criteria:**
- [x] `npm run lint` and `npm run typecheck` pass
- [x] Core domain tests all pass
- [x] App skeleton renders in browser

### Phase 1: Core Game Loop (COMPLETE)
- [x] Welcome screen (create/load subjects, archetype selection)
- [x] Phaser dungeon scene with procedural generation
- [x] Player movement, camera, zoom
- [x] Room panel with phase-adaptive tabs
- [x] Note editor with structured sections and live validation
- [x] XP/progression engine and badge system
- [x] Artifact generation from validated notes
- [x] Minimap and full map view with teleport
- [x] Three-phase loop (Creator → Scribe → Archaeologist)

**Completion criteria:**
- [x] User can create subject, navigate dungeon, write notes, earn XP
- [x] Full Creator → Scribe → Archaeologist cycle works end-to-end
- [x] Notes pass deterministic validation; artifacts generate

### Phase 2: Village Hub & UX Polish (COMPLETE)
- [x] Village hub Phaser scene with buildings, NPCs, portals, decorations
- [x] Quest/onboarding system (10-step quest)
- [x] Compass, signposts, HUD sidebar
- [x] Three color themes
- [x] Touch/mobile controls and responsive layout
- [x] Help overlay, settings modal, toast notifications
- [x] Import/export data management
- [x] Tutorial dungeon (3 rooms)

**Completion criteria:**
- [x] Village hub renders with all buildings, NPCs, portals, decorations
- [x] New users can complete 10-step onboarding quest
- [x] Touch controls work for mobile gameplay
- [x] Import/export round-trips preserve data

### Phase 3: Visual Unification & Gameplay Depth (COMPLETE)

The UI enhancement plan follows the research in `docs/research/ui-enhancements.txt`. The phase is split into three parallel tracks: visual unification, atmosphere, and gameplay depth.

#### 3a. Visual UI Unification

Implements the research recommendations from `docs/research/ui-enhancements.txt` items 1–4, 6.

**Week 1 - Color & Font:**
- [x] Define a single 5-color palette (Dark Fantasy or Wood & Stone tone)
- [x] Apply palette as CSS custom properties in React app
- [x] Use same hex codes for Phaser dungeon sprites, text, and HUD overlays
- [x] Choose one primary game-style font (pixel or fantasy serif)
- [x] Load font in both React (globally via CSS) and Phaser (via CSS font-face)
- [x] Set explicit `fontFamily` on all Phaser text objects to match React

**Week 2 - UI Re-skin:**
- [x] Style HUD sidebar as an in-game panel (themed background texture, trim)
- [x] Apply consistent border style (2px solid / 9-patch / unified rounded) to all React panels, modals, tooltips
- [x] Recreate same border style on Phaser in-game UI panels
- [x] Collapse less-used HUD features into secondary menu to reduce clutter
- [x] Use tooltips and icons instead of inline text on game canvas

**Week 3 - Shared Assets:**
- [x] Create or source 10–15 shared UI icons (chest, map, book, gear, sword, potion, etc.)
- [x] Use same icons in both React components and Phaser scene (shared sprite sheet)
- [x] Style React buttons as game elements (stone button, parchment scroll, etc.)
- [x] Theme scrollbars and input fields to match dungeon aesthetic

**Completion criteria:**
- [x] React and Phaser share a unified color palette (same hex codes)
- [x] Single font renders consistently in both UI shell and game canvas
- [x] All panels and modals use consistent border/shadow language
- [x] 10–15 shared icons in active use across both systems
- [x] HUD, buttons, scrollbars, inputs styled as game elements

#### 3b. Atmosphere & Polish

- [x] Add subtle vignette effect around screen edges via CSS (`box-shadow` inset or `radial-gradient`)
- [x] Fade transitions between screens (welcome → village → dungeon)
- [x] Slide/fade transitions for modal open/close
- [x] Background music: ambient dungeon tracks, village hub ambiance
- [x] Sound effects: UI click, room encounter, XP earn, artifact collect, NPC interaction
- [x] Visual polish: replace procedural player shapes with per-archetype sprite art
- [x] Sprite art for key items (loot chest, artifact, portal)

**Completion criteria:**
- [x] Vignette renders over both Phaser canvas and React UI consistently
- [x] Screen and modal transitions are smooth (no hard cuts)
- [x] Audio plays correctly in all game contexts (dungeon, village, UI)
- [x] Visual assets replace procedural shapes for player and key objects

#### 3c. Gameplay Depth

- [x] Additional biome types and room decor variety (at least 3 more beyond current 5, total ≥8)
- [x] Boss rooms at subject milestones (every 10 rooms, special large encounter with bonus XP/loot)
- [x] Enhanced loot system with equippable items that modify XP or quality bonuses
- [x] Achievement system tracking cross-subject milestones (e.g., "Master 3 subjects", "Write 100 notes")

**Completion criteria:**
- [x] At least 8 total biomes available, visually distinct
- [x] Boss rooms provide unique encounters with bonus rewards
- [x] Equippable items affect gameplay stats and persist per subject
- [x] Achievements unlock and display across subjects

### Phase 4: Advanced Features (COMPLETE)
- [x] Spaced repetition scheduling for Archaeologist reviews (SM-2 algorithm or简化)
- [x] Study statistics dashboard (time spent, rooms per session, retention trends)
- [x] Subject templates and sharing (via import/export of JSON)
- [x] Tag system for cross-subject topic linking
- [x] Custom biome/theme per subject
- [x] In-game markdown editor enhancements (syntax highlighting, auto-complete)

**Completion criteria:**
- [x] Spaced repetition schedules review prompts based on user performance
- [x] Dashboard shows meaningful study statistics (time spent, rooms per session, retention)
- [x] Subject templates are importable/exportable and preserve all data
- [x] Tags link topics across subjects with cross-subject navigation
- [x] Users can customize biome per subject independently
- [x] In-game markdown editor supports syntax highlighting and auto-complete

### Phase 5: Quality & Scale (COMPLETE)
- [x] Performance optimization for large subjects (100+ rooms)
- [x] Accessibility audit and improvements (keyboard nav, screen reader support for UI)
- [x] Keyboard shortcut customization
- [x] Comprehensive error recovery (corrupt subject data, persistence failures)
- [x] Localization / i18n support (i18next or similar)

**Completion criteria:**
- [x] 100-room subject maintains 30+ FPS on mid-range hardware
- [x] UI is operable via keyboard alone (excluding Phaser game canvas)
- [x] Keyboard shortcuts are configurable via settings UI
- [x] Corrupt subject data shows recovery options, not a crash
- [x] At least one additional locale (e.g., Spanish or French) is functional

---

## 15. Testing Strategy

| Level | Scope | Tools / Approach |
|-------|-------|------------------|
| Unit Tests | Core domain logic (graph, validation, progression, artifacts, review) | Vitest - 23 existing tests |
| Component Tests | React UI components (HUD, RoomPanel, NoteEditor, etc.) | Vitest + Testing Library |
| Integration Tests | State transitions, persistence round-trips | Vitest with mock stores |
| Manual / Exploratory | End-to-end user experience (create subject → clear rooms → review) | Playtesting via `npm run dev` |
| Cross-Platform | Web (Chrome, Firefox, Safari) + Electron (macOS, Windows, Linux) | Manual matrix testing |

### Key Test Scenarios
1. Create subject → add child rooms → navigate dungeon → write notes → earn XP
2. Full phase cycle: Creator → Scribe → Archaeologist → SubjectMastered
3. Village hub: create subject via Guild Hall → enter portal → return
4. Persistence: save subject → reload page → verify data intact
5. Note validation: passing and failing rubric cases
6. Mobile: touch controls, responsive layout, bottomsheet panel
7. Export/import subject data across web and Electron

---

## 16. Analytics / Success Metrics

No telemetry is collected. Success is evaluated through:
- Manual playtesting and user feedback
- Code quality metrics (test coverage, lint/typecheck pass rate, bundle size)
- Community engagement via GitHub issues and contributions

---

## 17. Acceptance Criteria

### 17.1 Subject Management
- [ ] User can create a subject with a name and root topic
- [ ] User can see a list of existing subjects with progress info on the welcome screen
- [ ] User can delete subjects
- [ ] User can rename subjects
- [ ] User can import and export subjects as JSON

### 17.2 Dungeon Generation & Navigation
- [ ] Dungeon is procedurally generated from the topic graph using BFS placement
- [ ] Rooms connect via L-shaped corridors with walkability grid
- [ ] Multiple floors with stair portals function correctly
- [ ] Minimap and full map view render floor layout accurately
- [ ] Teleport mode allows jumping to any room (with cooldown)

### 17.3 Creator Phase
- [ ] User can add child topic rooms, cross-links, reparent, and remove rooms
- [ ] Room panel shows Topic tab with graph editing controls
- [ ] Phase selector in HUD switches between phases with confirmation
- [ ] Phase auto-advances to Scribe when first artifact is collected

### 17.4 Scribe Phase
- [ ] Note editor provides Summary / Key Points / Recall Question sections with live word count
- [ ] Notes pass deterministic rubric validation (section completeness, concept coverage, link references, recall question quality, clarity)
- [ ] Manual confirmation required before submission
- [ ] On pass: XP awarded, loot rolled, artifact markdown generated
- [ ] On fail: actionable fix hints shown
- [ ] Image attachments supported (local file picker or external URL)

### 17.5 Archaeologist Phase
- [ ] Phase unlocks when all rooms reach reviewable state
- [ ] Self-check prompts generate from room headings, topics, and relations
- [ ] Review progress bar tracks rooms reviewed vs total
- [ ] Review analytics track session count, full passes, streaks

### 17.6 Progression System
- [ ] XP awarded on encounter completion (base 20 + quality bonus 0–10 + streak bonus 0–5)
- [ ] Three rank tiers: Novice (0–299), Scholar (300–799), Master (800+)
- [ ] Badges awarded for phase completion, review milestones, and 120-word notes
- [ ] Loot system rolls common/rare/epic items based on quality score

### 17.7 Village Hub
- [ ] All buildings render: Keeper's Tower, Guild Hall, Training Grounds, Trophy Hall, Library
- [ ] Dungeon portals appear per subject with animated vortex effect
- [ ] 5 wandering NPCs patrol paths with learning quotes
- [ ] Keeper NPC delivers 10-stage quest-driven dialogue
- [ ] Wayfinding signposts show directional information
- [ ] Compass overlay points toward nearest portal or Keeper
- [ ] Decorative elements render: trees, bushes, ponds, flowers, torches, benches, fountain, birds

### 17.8 Archetype System
- [ ] All 3 archetypes (Scholar, Cartographer, Archivist) provide distinct gameplay bonuses
- [ ] Archetype selected before first dungeon entry and persists per subject

### 17.9 NPC System
- [ ] Dungeon NPCs show phase-aware guidance text per room state
- [ ] Village NPCs have patrol paths and interaction dialogs
- [ ] NPC interaction via E key (keyboard) or tap (mobile)

### 17.10 Quest / Onboarding
- [ ] 10-step onboarding quest guides new users from intro to completion
- [ ] Steps 1–6 advance automatically; steps 7–9 require manual confirmation
- [ ] First-run gameplay loop modal explains Creator/Scribe/Archaeologist

### 17.11 HUD and UI
- [ ] Sidebar HUD shows subject name, room count, XP, rank, badges, notes count, review progress
- [ ] HUD includes phase selector, teleport cooldown, action buttons
- [ ] HUD is collapsible drawer on mobile (<900px width)
- [ ] Room panel is draggable/resizable with phase-adaptive tabs
- [ ] Help overlay, settings modal, toast notifications work correctly
- [ ] Three color themes: Night, Arcade, Aurora

### 17.12 Data Persistence
- [ ] Subjects persist across sessions (localStorage for web, filesystem for Electron)
- [ ] Import/export round-trips preserve all subject data
- [ ] Active subject ID persists across reloads
- [ ] Session state (phase, UI preferences) restored on reload

### 17.13 Mobile Support
- [ ] Mobile touch controls work for core gameplay (movement, interaction, navigation)
- [ ] Responsive layout adapts at 900px, 600px, and 480px breakpoints
- [ ] Floating action buttons replace keyboard shortcuts on touch devices

### 17.14 Production Server
- [ ] Server serves built web app on configurable port
- [ ] Image upload API accepts valid file types and rejects invalid ones
- [ ] Subject CRUD API (list, read, write, delete) functions correctly
- [ ] Docker container builds and runs with persistent data volume

### 17.15 Electron Shell
- [ ] Desktop build opens BrowserWindow and loads the app
- [ ] IPC handlers save/load/delete subjects to `userData/dungeon-data/`
- [ ] File dialogs work for import/export workflows
- [ ] Preload script exposes only safe IPC channels via contextBridge

### 17.16 Build & Quality
- [ ] All unit tests pass (`npm test -- --run`)
- [ ] Lint passes with zero errors (`npm run lint`)
- [ ] Typecheck passes with zero errors (`npm run typecheck`)
- [ ] Application builds for web (`npm run build:web`) and Electron (`npm run build:electron`)
- [ ] Bundle size stays under CI guard threshold (`npm run check:bundle-size`)

---

## 18. Dependencies and Risks

### 18.1 Dependencies

| Dependency | Type | Risk if Unavailable | Mitigation |
|------------|------|---------------------|------------|
| React 19 | npm | UI layer non-functional | Pinned in package.json; version active until ~2028 |
| Phaser 3.87 | npm | Game rendering non-functional | Mature library with long support; could fall back to Canvas API |
| Zustand 4.5 | npm | State management broken | Minimal library; trivial to replace with useReducer or Jotai |
| Vite 8 | npm | Dev/build tooling broken | npm install; cached in CI |
| Electron 42 | npm | Desktop build broken | Web build always available as fallback |
| TypeScript 5.6 | npm | Type checking broken | Can fall back to JavaScript if needed |
| Vitest 4 | npm | Tests can't run | Temporary; tests still valid JS |

### 18.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Phaser + React reconciliation issues (game state vs UI state) | Low | Medium | Zustand as single source of truth; careful separation of concerns |
| Performance degradation with large subjects (100+ rooms) | Medium | Medium | Virtualized room panel, canvas rendering scales naturally |
| Electron filesystem path differences across platforms | Low | Low | Covered by Electron's `app.getPath('userData')` |
| Browser localStorage limits (5–10 MB) for large subjects | Low | Medium | Export reminders; selective data pruning; Electron path avoids this |
| Breaking changes in Phaser 4 release | Low | Low | Stay on Phaser 3 until ecosystem stabilizes |

---

## 19. Future Considerations

| Item | Description | Potential Version |
|------|-------------|-------------------|
| Multi-user / Cloud Sync | Sync subjects across devices with optional cloud backend | v3+ |
| Server-side AI Assistance | AI-powered note suggestions, summary generation | v3+ |
| Tauri Shell | Replace Electron with Tauri for smaller desktop builds | v3+ |
| Native Mobile Apps | React Native or Capacitor wrapper for iOS/Android | v4+ |
| Collaborative Mindmaps | Real-time collaborative editing of subject graphs | v4+ |
| WebSocket Multiplayer | Explore dungeons together with friends | v4+ |

---

## 20. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should the tutorial be skippable for returning users? | Yes - show only on first subject creation |
| 2 | Should Archaeologist phase use spaced repetition intervals? | Not yet - manual review only; consider adding in Phase 4 |
| 3 | Should there be a daily login streak bonus? | Not yet - considered for future gamification pass |
| 4 | Should Phaser 3 be upgraded to Phaser 4? | Not now - v3.87 is stable; evaluate migration when v4 ecosystem matures |
| 5 | Should Zustand 4.5 be upgraded to Zustand 5? | Not now - v4.5 is stable; plan migration before adding new store features |

---

## 21. Glossary

| Term | Definition |
|------|------------|
| Room | A topic node in the subject mindmap; represents one concept to study |
| Subject | A complete dungeon covering one area of study (e.g., "Linear Algebra") |
| Encounter | The act of writing notes for a room to "defeat" it |
| Artifact | Generated markdown summary of a completed encounter |
| XP | Experience points earned for completing encounters and reviews |
| Badge | Achievement awarded for milestones (phases completed, word counts, review passes) |
| Archetype | Player class that provides a passive bonus: Scholar, Cartographer, or Archivist |
| Phase | One of three gameplay modes: Creator, Scribe, Archaeologist |
| Floor | A sub-level of a dungeon; subjects can span multiple floors |
| Biome | Procedural visual theme applied to floor textures |
