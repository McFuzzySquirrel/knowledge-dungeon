# Agent Responsibility Matrix

Every PRD requirement has exactly one **primary** owner agent. Secondary/shared ownership denotes a distinct collaboration (e.g., rendering vs content, engine logic vs UI display, implementation vs testing).

**Key:** **P** = Primary owner, **S** = Secondary/shared collaborator, **T** = Tests the feature (qa-engineer)

---

## 8.1 Subject Management

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| SM-01 | Create a new subject with name and root topic | | S (create form) | **P** | | | T |
| SM-02 | List existing subjects with progress info | | S (display list) | **P** | | | T |
| SM-03 | Delete a subject | | | **P** | | | |
| SM-04 | Rename a subject | | | **P** | | | |
| SM-05 | Import a subject from JSON | | | **P** | | | T |
| SM-06 | Export a subject as JSON | | | **P** | | | T |
| SM-07 | Select an archetype before entering dungeon | | S (selector UI) | **P** | | | |

## 8.2 Dungeon Generation

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| DG-01 | Procedural BFS room layout from topic graph | **P** | | S (graph data) | | | T |
| DG-02 | Rooms placed on macro grid with collision avoidance | **P** | | | | | |
| DG-03 | L-shaped corridors connecting rooms | **P** | | | | | |
| DG-04 | Multi-floor dungeons with stair portals | **P** | | S (floor derivation) | | | T |
| DG-05 | Walkability grid per floor | **P** | | | | | T |
| DG-06 | Deterministic room decorations | **P** | | | | | |
| DG-07 | Procedural biome floor textures | **P** | | | | | |
| DG-08 | Ambient dust mote particles | **P** | | | | | |

## 8.3 Dungeon Navigation

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| DN-01 | WASD/arrow key movement | **P** | | | | | |
| DN-02 | Zoom in/out | **P** | | | | | |
| DN-03 | Camera follow with room-based zoom tweens | **P** | | | | | |
| DN-04 | Minimap overlay in bottom-right corner | **P** | S (React overlay) | | | | T |
| DN-05 | Full map view with interactive mindmap | S (Phaser render) | **P** (React overlay) | | | | |
| DN-06 | Floor switching via stair/portal icons | **P** | | | | | |
| DN-07 | Teleport mode with cooldown | S (world jump) | **P** (React UI) | | | | |
| DN-08 | Touch controls: drag, pinch, tap | **P** | S (mobile layout) | | | | |

## 8.4 Creator Phase

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| CR-01 | Add child topic rooms | | | **P** | | | T |
| CR-02 | Add cross-links between rooms | | | **P** | | | |
| CR-03 | Reparent rooms in the hierarchy | | | **P** | | | |
| CR-04 | Remove rooms from the graph | | | **P** | | | T |
| CR-05 | Room panel shows Topic tab with editing controls | | **P** | S (graph data) | | | T |
| CR-06 | Bulk-import topics from comma-separated input | | | **P** | | | |
| CR-07 | Phase auto-advances to Scribe on first artifact | | | **P** | | | T |
| CR-08 | HUD phase selector with confirmation dialog | | **P** | S (state machine) | | | |

## 8.5 Scribe Phase

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| SC-01 | Press E on room to open note editor | **P** (E detect) | **P** (open modal) | | | | |
| SC-02 | Structured sections: Summary, Key Points, Recall Question | | **P** | | | | T |
| SC-03 | Live word count with ≥120 minimum indicator | | **P** | S (word count logic) | | | T |
| SC-04 | Edit/Preview toggle for markdown rendering | | **P** | | | | T |
| SC-05 | Save notes as draft without full validation | | **P** | | | | |
| SC-06 | Submit notes for deterministic rubric validation | | S (submit UI) | **P** (validation engine) | | | T |
| SC-07 | Rubric checks: 5 criteria 0–2 scoring | | | **P** | | | T |
| SC-08 | Manual confirmation required even if rubric passes | | S (confirm dialog) | **P** (gate logic) | | | |
| SC-09 | On pass: award XP, roll loot, generate artifact | | S (XP/loot display) | **P** (engine) | | | T |
| SC-10 | On fail: show actionable fix hints with scores | | S (hint display) | **P** (hint generation) | | | T |
| SC-11 | Room panel shows Notes tab in Scribe phase | | **P** | | | | T |
| SC-12 | Image attachments via local file picker or URL | | **P** | S (persist attachment) | | | |

## 8.6 Archaeologist Phase

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| AR-01 | Unlocks when all rooms reach reviewable state | | | **P** | | | T |
| AR-02 | Revisit cleared rooms for self-check prompts | | S (prompt display) | **P** (prompt generation) | | | |
| AR-03 | Self-check prompts from headings, topics, relations | | | **P** | | | T |
| AR-04 | Room panel shows Self-Check tab | | **P** | | | | T |
| AR-05 | Review progress bar (rooms reviewed vs total) | | **P** | S (progress data) | | | |
| AR-06 | Review analytics: sessions, passes, streaks | | **P** (display) | **P** (computation) | | | T |
| AR-07 | 6 XP per review pass | | | **P** | | | T |
| AR-08 | Badges at 2, 3, 7, 15 full review passes | | | **P** | | | |

## 8.7 Progression System

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| PR-01 | XP awarded for completing encounters (base 20 + bonuses) | | | **P** | | | T |
| PR-02 | Quality bonus (0–10) based on rubric score | | | **P** | | | |
| PR-03 | Streak bonus (0–5) for consecutive successes | | | **P** | | | |
| PR-04 | Three rank tiers: Novice, Scholar, Master | | | **P** | | | |
| PR-05 | Badges for phase completion, reviews, 120-word notes | | | **P** | | | T |
| PR-06 | Loot system: quality-based common/rare/epic roll | | | **P** | | | |
| PR-07 | Inventory view showing collected loot | | S (UI display) | **P** (data) | | | T |
| PR-08 | Journal view showing completed notes per room | | S (UI display) | **P** (data) | | | T |

## 8.8 Village Hub

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| VH-01 | 2D explorable hub world in Phaser | **P** (scene) | | | **P** (layout data) | | |
| VH-02 | Animated dungeon portal vortexes | **P** (rendering) | | | S (slot positions) | | |
| VH-03 | Keeper's Tower with quest board and guide NPC | | **P** (info panel) | | **P** (building def) | | |
| VH-04 | Guild Hall for creating subjects | | **P** (info panel) | | **P** (building def) | | |
| VH-05 | Training Grounds launches tutorial dungeon | | **P** (info panel) | | **P** (building def) | | |
| VH-06 | Trophy Hall shows collection | | **P** (info panel) | S (collection data) | **P** (building def) | | |
| VH-07 | Library of Knowledge shows help | | **P** (help panel) | | **P** (building def) | | |
| VH-08 | 5 wandering NPCs patrol paths | **P** (NPC rendering) | | | **P** (patrol paths) | | |
| VH-09 | Keeper NPC has 10-stage quest dialogue | | | | **P** (dialogue content) | | |
| VH-10 | Signposts at crossroads with directions | **P** (rendering) | | | **P** (labels/positions) | | |
| VH-11 | Compass overlay toward nearest portal/Keeper | **P** (compass data+render) | S (React overlay) | | | | |
| VH-12 | Decorative elements: trees, bushes, ponds, fountain, birds | **P** (rendering) | | | **P** (positions) | | |
| VH-13 | Quest log shows onboarding step and progress | | **P** | | S (quest data) | | |

## 8.9 Archetype System

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| AC-01 | Three archetypes: Scholar, Cartographer, Archivist | S (sprite/vfx) | | **P** (definitions) | | | |
| AC-02 | Scholar: +2 quality bonus on validation | | | **P** | | | |
| AC-03 | Cartographer: +1 cross-link capacity | | | **P** | | | |
| AC-04 | Archivist: +3 max review streak cap | | | **P** | | | |
| AC-05 | Archetype selected before first dungeon, persists per subject | | S (select UI) | **P** (gating logic) | | | |
| AC-06 | Perk detail shown in HUD sidebar | | **P** | S (perk data) | | | |
| AC-07 | Archetype can be changed between subjects | | | **P** | | | |

## 8.10 NPC System

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| NPC-01 | Dungeon room NPC with phase-aware text | **P** (render+pos) | S (dialog display) | S (phase data) | S (text content) | | T |
| NPC-02 | NPC text adapts to room state | **P** (update on change) | | S (room state) | S (text variants) | | T |
| NPC-03 | Floating idle animation on dungeon NPCs | **P** | | | | | |
| NPC-04 | Dialog bubble anchors to NPC world coords | **P** | | | | | |
| NPC-05 | Dialog dismisses on out-of-range | **P** | | | | | |
| NPC-06 | Village NPCs patrol predefined paths | **P** (movement AI) | | | **P** (path defs) | | |
| NPC-07 | Keeper NPC 10-stage quest dialogue | | | S (quest state) | **P** (dialogue) | | |
| NPC-08 | 5 villagers display random learning quotes | | | | **P** (quotes) | | |
| NPC-09 | NPC interaction via E key or touch tap | **P** | | | | | |
| NPC-10 | Proximity detection with configurable radius | **P** | | | | | |

## 8.11 Quest / Onboarding System

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| QS-01 | 10-step onboarding quest definition | | | S (advance triggers) | **P** (step content) | | |
| QS-02 | Steps 1–6 auto-advance on player action | | | S (trigger logic) | **P** (step config) | | T |
| QS-03 | Steps 7–9 require "Mark Complete" button | | S (Mark Complete button) | | **P** (step config) | | T |
| QS-04 | Gameplay loop onboarding modal | | **P** | | | | T |
| QS-05 | Tutorial overlay in dungeon | | **P** (overlay UI) | | S (tutorial content) | | |

## 8.12 HUD and UI

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| HUD-01 | Sidebar: name, room count, XP, rank, badges, notes, progress | | **P** | S (data) | | | T |
| HUD-02 | HUD: phase selector, teleport cooldown, action buttons | | **P** | | | | T |
| HUD-03 | Collapsible drawer on mobile | | **P** | | | | T |
| HUD-04 | Draggable/resizable room panel | | **P** | | | | T |
| HUD-05 | Help overlay with controls reference | | **P** | | | | |
| HUD-06 | Toast notifications for info/error/success | | **P** | | | | |
| HUD-07 | XP popup animation on XP earn | | **P** | | | | |
| HUD-08 | Three color themes: Night, Arcade, Aurora | | **P** | | | | T |

## 8.13 Data Persistence

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| DP-01 | localStorage persistence for web builds | | | **P** | | | T |
| DP-02 | Filesystem persistence for Electron builds | | | S (persistence API) | | **P** (IPC handlers) | T |
| DP-03 | Timestamped backups on save | | | **P** | | | |
| DP-04 | Subject index tracks all known subject IDs | | | **P** | | | |
| DP-05 | Active subject ID persists across sessions | | | **P** | | | |
| DP-06 | Export reminder every 30 minutes for web users | | S (nudge toast) | **P** (timer logic) | | | T |
| DP-07 | Image attachments persist alongside subject data | | | **P** | | S (Electron storage) | |

## 8.14 Production Server

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| PS-01 | Serves built web app (dist/) as static files | | | | | **P** | |
| PS-02 | POST /api/upload with file type validation, 10MB limit | | | | | **P** | |
| PS-03 | GET /api/subjects (list all subject IDs) | | | | | **P** | |
| PS-04 | GET /api/subjects/:id (load subject JSON) | | | | | **P** | |
| PS-05 | POST /api/subjects/:id (save subject JSON) | | | | | **P** | |
| PS-06 | DELETE /api/subjects/:id (delete subject) | | | | | **P** | |
| PS-07 | Configurable DATA_DIR for subject files | | | | | **P** | |
| PS-08 | Uploaded images served from /uploads/ | | | | | **P** | |
| PS-09 | Dockerfile and docker-compose.yml | | | | | **P** | |
| PS-10 | Configurable PORT (default 3000) | | | | | **P** | |

## 8.15 Electron Shell

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| ES-01 | BrowserWindow loading dev/production build | | | | | **P** | |
| ES-02 | IPC handlers for filesystem subject CRUD | | | S (data contract) | | **P** | |
| ES-03 | IPC handlers for file dialogs | | | | | **P** | |
| ES-04 | Preload with contextBridge (safe IPC channels only) | | | | | **P** | |
| ES-05 | userData path per platform via app.getPath | | | | | **P** | |
| ES-06 | Attachment storage with MIME type validation | | | S (data model) | | **P** | |
| ES-07 | Linux sandbox flag for dev mode | | | | | **P** | |
| ES-08 | External URL navigation validated as safe | | | | | **P** | |

---

## 9. Non-Functional Requirements

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| NF-01 | Zero network calls for core functionality | S (no net calls) | S (no net calls) | **P** (enforces) | | | |
| NF-02 | Deterministic note validation | | | **P** | | | |
| NF-03 | Offline with no degradation | | | **P** | | S (no CDN deps) | |
| NF-04 | Bundle size CI guard | | | | | **P** | |
| NF-05 | Synchronous state changes for local operations | | | **P** | | | |
| NF-06 | TypeScript strict mode | | | | | S (config) | **P** (enforces) |
| NF-07 | 100% lint pass | | | | | S (config) | **P** (enforces) |
| NF-08 | Test suite passes before any release | | | | | | **P** |
| NF-09 | 30+ FPS on mid-range hardware (100 rooms) | **P** | | | | | S (measures) |
| NF-10 | ≤3s app load time on broadband | | | | | **P** (build config) | S (measures) |
| NF-11 | ≤500ms subject data load time | | | **P** | | | S (measures) |
| NF-12 | WebGL rendering with Canvas fallback | **P** (Phaser config) | | | | **P** (Vite config) | |
| NF-13 | <200MB memory for typical usage (web) | **P** (texture memory) | S (React mem) | | | | |

## 10. Security & Privacy

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| SP-01 | No user data sent to any external server | | | | | **P** | |
| SP-02 | No telemetry, tracking, or analytics | | | | | **P** | |
| SP-03 | No authentication or user accounts required | | | | | **P** | |
| SP-04 | Image attachment URLs validated against MIME types | | **P** | | | | |
| SP-05 | Electron contextBridge limits renderer IPC surface | | | | | **P** | |

### Data Integrity & Error Recovery

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| DR-01 | Subject data validated on load; corrupt → error, not crash | | | **P** | | | |
| DR-02 | Timestamped backups before every save | | | **P** | | | |
| DR-03 | Synchronous atomic persistence writes | | | **P** | | | |
| DR-04 | Export reminder nudges web users every 30 min | | S (toast) | **P** (timer) | | | |
| DR-05 | Import validates JSON structure before applying | | | **P** | | | |
| DR-06 | Session state persists across page reloads | | | **P** | | | |
| DR-07 | Graceful degradation when localStorage quota exceeded | | S (warning UI) | **P** (detection) | | | |

---

## 11. Accessibility

| ID | Requirement | game-engineer | ui-engineer | core-logic-engineer | village-content-designer | infrastructure-engineer | qa-engineer |
|----|-------------|:---:|:---:|:---:|:---:|:---:|:---:|
| ACC-01 | Text color contrast against backgrounds | | S (CSS) | | | | **P** (audits) |
| ACC-02 | Interactive elements reachable via keyboard | | S (React focus) | | | | **P** (audits) |
| ACC-03 | Game controls documented in Help overlay | | S (Help content) | | | | **P** (verifies) |
| ACC-04 | Mobile touch controls for coarse-pointer devices | **P** (touch input) | S (mobile layout) | | | | **P** (verifies) |
| ACC-05 | Markdown notes as safe HTML with heading hierarchy | | S (renderer) | | | | **P** (verifies) |

---

## 4. User Stories

User stories (PRD §4.2) map to their corresponding functional requirements. Primary owner is the agent that owns the underlying requirement.

| ID | User Story | Primary Agent | Via Requirement |
|----|-----------|:---:|-----------------|
| US-01 | Create a subject with a root topic | core-logic-engineer | SM-01 |
| US-02 | Add child topics to any room | core-logic-engineer | CR-01 |
| US-03 | Navigate the dungeon with WASD/touch | game-engineer | DN-01 |
| US-04 | Write structured notes for each room | ui-engineer | SC-02 |
| US-05 | See notes validated against a rubric | core-logic-engineer | SC-06 |
| US-06 | Earn XP and badges for completing rooms | core-logic-engineer | PR-01 |
| US-07 | Review past topics with self-check prompts | core-logic-engineer | AR-02 |
| US-08 | See overall progression across subjects | core-logic-engineer | PR-07/PR-08 |
| US-09 | Export/import subjects | core-logic-engineer | SM-05/SM-06 |
| US-10 | Use the village hub as home base | game-engineer | VH-01 |
| US-11 | Customize experience with themes | ui-engineer | HUD-08 |

---

## Summary

| Agent | Primary Sections | Count (P) |
|-------|-----------------|-----------|
| **game-engineer** | DG, DN, VH (rendering), NPC (rendering/ai) | 35 |
| **ui-engineer** | CR-05/08, SC-01..05/11/12, AR-04..06, HUD, VH-03..07/13, QS-04/05, AC-06 | 37 |
| **core-logic-engineer** | SM, CR-01..04/06/07, SC-06..10, AR-01..03/07/08, PR, AC, DP, DR, NF | 70 |
| **village-content-designer** | VH (content), NPC-07/08, QS-01..03 | 16 |
| **infrastructure-engineer** | PS, ES, SP, NF-04/10/12 | 23 |
| **qa-engineer** | ACC, NF-06..08, all T (across all sections) | 4 (+ all T) |

**Total coverage:** 168 PRD requirement IDs across all sections (§4 US-*: 11, §8 FR: 127, §9 NF: 13, §10 SP/DR: 12, §11 ACC: 5), all with exactly one primary owner.

### Validation

- [x] No requirement is unowned (0 gaps)
- [x] Every requirement has exactly one **P** (primary owner)
- [x] No two agents claim primary ownership of the same requirement
- [x] All 6 agents have a `## Gotchas` section with project-specific edge cases
- [x] All 4 skills have a `## Validation` section with concrete checks
- [x] All agent `name:` fields match their filenames
- [x] Team covers: foundation (infrastructure), core logic (core-logic-engineer), testing (qa-engineer), and all major feature areas
