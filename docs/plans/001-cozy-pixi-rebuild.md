# Cozy React and PixiJS Rebuild Implementation Plan

**Status:** in-progress
**Created:** 2026-09-24
**Plan owner:** Project maintainer
**Target file:** `docs/plans/001-cozy-pixi-rebuild.md`
**Supersedes after acceptance:** Relevant renderer decisions in `docs/adr/001-village-hub-and-visual-overhaul.md`

---

## 1. Purpose

This plan replaces the current Phaser-based presentation and UI with a warm, storybook-style experience built around React DOM and PixiJS 8 while preserving the application's learning model, persistence compatibility, and primary user flow.

The rebuild is intentionally divided into independently verifiable phases. Only one phase may be implemented at a time. A phase must pass its exit criteria and be explicitly accepted before the next phase begins.

The plan covers:

- A complete visual and interaction redesign.
- Replacement of Phaser with PixiJS 8.
- A redesigned village, dungeon, fishing activity, and learning flow.
- Adaptive learner assistance for primary- and secondary-school users.
- Working study statistics.
- Private progress sharing without a server or public profile.
- Lossless full-device backups, individual subject backups, and blank reusable templates.
- Device-local storage for learner content and image attachments.
- CC0-only new art and audio.
- Web, Chromebook, desktop-browser, and tablet/touch support.
- Deferred Electron packaging.

---

## 2. Locked Product Decisions

The following decisions are fixed unless the plan is explicitly revised before implementation begins.

### 2.1 Rendering and application stack

- React DOM remains responsible for application UI, forms, dialogs, navigation, maps, settings, data management, statistics, sharing, and accessible controls.
- PixiJS 8 is responsible for the village, dungeon, and fishing world presentation.
- Phaser remains available only as a temporary fallback during migration.
- Phaser is removed after a successful production cutover and soak period.
- PixiJS and world asset bundles must be lazy-loaded.
- Educational text and complex inputs must not be rendered exclusively inside PixiJS.
- PixiJS AccessibilitySystem may provide enhancement, but it cannot be the only route to any core action.

### 2.2 Product experience

- The visual direction is a warm storybook village rather than an arcade, horror, or high-neon dungeon.
- The product remains suitable for both primary- and secondary-school users without presenting separate child and teen applications.
- Assistance adapts locally and explainably; no exact age is collected.
- The village social layer consists of friendly NPCs, dialogue, quests, and shared spaces.
- No multiplayer, chat, networked NPC, public profile, cloud synchronization, or classroom account system is included.
- Social sharing means private, user-initiated share cards.
- Share cards always support local download and may use the operating system's Web Share API after a user action.

### 2.3 Data and privacy

- Learner content is stored locally on the device.
- Web image attachments are stored locally in IndexedDB and are no longer uploaded to `/api/upload` by the redesigned application.
- The application adds no analytics, tracking, or remote configuration service.
- External image URLs remain user-provided external content and are not silently downloaded into backups.
- Existing external-only attachments must be disclosed honestly when a backup cannot include their bytes.
- Electron bridge compatibility may remain temporarily, but Electron packaging is not a release gate for this plan.

### 2.4 Media licensing

- Every newly added image, animation frame, sound effect, music track, and font must be verified as CC0 1.0.
- Unverified legacy media must not enter the default PixiJS asset bundle.
- Every approved media asset must have recorded source, creator, source URL when available, license URL, retrieval or creation date, checksum, and modifications.
- If no suitable CC0 font is selected, the application must use a system font stack rather than introducing a non-CC0 font dependency.
- Remote Google Fonts are removed from the production UI.

### 2.5 Release targets

Primary release targets are:

- Web on Chromebook.
- Desktop browsers.
- Tablet portrait and landscape with touch as a first-class input.

Electron installers, signing, and release packaging are deferred.

---

## 3. Scope

### 3.1 Features that must be preserved or deliberately improved

- Subject creation, loading, templates, and activation.
- Tutorial entry and progression.
- Player archetype selection.
- Village hub, NPCs, dialogue, quests, and subject portals.
- Dungeon room navigation, floors, portals, minimap, full map, and teleport.
- Creator graph authoring.
- Scribe note drafting, validation, attachments, artifacts, badges, loot, and XP.
- Archaeologist artifact collection, self-check, review, and SM-2 scheduling.
- Inventory, badges, journal, progression, and rank.
- Fishing, fish collection, recall prompts, XP, and fishing badges.
- Study statistics.
- Private share cards.
- Full-device, subject, and template import/export.
- Keyboard, touch, and DOM-equivalent access to every core action.

### 3.2 Features that may be redesigned or deferred

- Current Night, Arcade, and Aurora themes are replaced by one coherent Cozy visual system.
- Persistent sidebars and modal-heavy layouts are replaced by contextual panels and bottom sheets.
- Make It Yours and new custom sprite editing are deferred.
- Existing custom sprite data must still be preserved in full-device backups so migration does not destroy user data.
- Electron packaging and installer work are deferred.
- Public social features and classroom synchronization are out of scope.

### 3.3 Explicit non-goals

- No gameplay server.
- No cloud accounts or cloud sync.
- No public profile or public share URL.
- No multiplayer or remotely synchronized NPCs.
- No LLM-generated answers or cloud-based learner profiling.
- No PixiJS note editor or data-management interface.
- No remote analytics or production telemetry.
- No proprietary or non-CC0 media.
- No large ECS framework or secondary game engine unless a measured requirement makes one necessary.

---

## 4. Current Architecture Anchors

The following seams should be preserved, moved, or replaced deliberately.

| Concern | Current source | Plan treatment |
| --- | --- | --- |
| Application routing | `src/ui/App.tsx:44-76`, `src/ui/App.tsx:101-107` | Replace screen composition while preserving Welcome, Village, and Game semantics. |
| Subject activation | `src/ui/hooks/useLoadSubjectFlow.ts:9-24` | Keep as the canonical activation path. |
| Subject orchestration | `src/store/subjectStore.ts:151-424` | Preserve actions; move presentation dependencies out. |
| Subject schema | `src/core/validation/persistence/types.ts:6-18`, `src/core/validation/persistence/types.ts:100-152` | Preserve `1.1.0`; keep product-format versions separate. |
| Graph and floors | `src/core/graph/navigation.ts:38-178` | Preserve domain semantics. |
| Dungeon layout | `src/game/systems/dungeonGenerator.ts:148-265` | Move to renderer-neutral layout location or re-export from one. |
| Note validation | `src/core/validation/notes/noteValidation.ts:265-337` | Preserve deterministic rules. |
| Review and SM-2 | `src/core/review/reviewDomain.ts:29-172`, `src/core/review/spacedRepetition.ts:91-189` | Preserve algorithms and move copy out of domain. |
| Persistence facade | `src/services/persistence/subjectPersistence.ts:109-187` | Refactor into repository facade and codecs. |
| Dungeon orchestration | `src/ui/screens/GameScreen.tsx:286-436` | Extract application commands and replace Phaser lifecycle. |
| Village orchestration | `src/ui/screens/VillageScreen.tsx:234-350`, `src/ui/screens/VillageScreen.tsx:613-1100` | Split into application controller and focused React views. |
| Phaser entry points | `src/game/createGame.ts:23-49`, `src/game/createVillageGame.ts:15-41` | Replace after parity is established. |
| Phaser scenes | `src/game/scenes/DungeonScene.ts`, `src/game/scenes/VillageScene.ts`, `src/game/scenes/FishingScene.ts` | Temporary reference implementations, then delete. |
| Fishing mechanics | `src/game/systems/fishingMechanics.ts:18-130` | Move pure logic to core; add explicit fishing context. |
| Fish collection | `src/core/fishing/fishCollectionService.ts:14-89` | Preserve and normalize around canonical catalog IDs. |
| Statistics | `src/services/sessionTracker.ts:67-220` | Replace with wired, idempotent event accounting. |
| Share export | `src/ui/utils/progressionShareExport.ts:31-209` | Split view model, renderer, and delivery. |
| Phaser build chunk | `vite.config.ts:73-92` | Remove during final cutover. |
| Phaser test mock | `vitest.setup.ts:4-20` | Remove after browser tests replace it. |

---

## 5. Core Flow and Behavior Contracts

### 5.1 Preserved main flow

1. Open the application and hydrate local data.
2. Continue an existing subject or create/load a new subject.
3. Select or confirm a player archetype and assistance preference.
4. Enter the village.
5. Enter a subject dungeon from its portal.
6. Author or revise the topic graph as a Creator.
7. Write, validate, save, and complete a Scribe note.
8. Collect the generated artifact.
9. Review the artifact as an Archaeologist.
10. Return to the village and continue another subject or activity.

### 5.2 Behavioral contracts

- Subject activation keeps session and progression subject IDs synchronized.
- The root room and direct-child floor model remains valid.
- Normal room travel remains separate from cooldown-limited teleport.
- Creator actions mutate the graph through the subject application layer.
- Scribe drafts are non-destructive and resumable.
- Passing note validation creates an artifact and grants progression exactly once.
- Artifact collection remains a separate Archaeologist world action.
- Review completion is recorded exactly once per room per pass.
- SM-2 values survive reload and backup.
- Fishing carries one explicit subject context from pond entry through catch resolution and persistence.
- Releasing a fish never mutates progression.
- Statistics count room, note, review, XP, and fishing events exactly once.
- Data imports never partially overwrite the active data generation.
- Every Pixi world action has a DOM-equivalent control.

### 5.3 Known defects that must not be carried forward

- Session tracking functions are not wired into real gameplay.
- Fishing eligibility, recall selection, and persistence may use different subject contexts.
- Fish catalog identity is discarded or represented inconsistently.
- Fish, XP, and badges are written through multiple non-transactional operations.
- Current backups omit authoritative progression, fish, sessions, and attachment bytes.
- Same-ID imports can overwrite subjects while leaving stale progression.
- Template metadata can contain attachment information that import later discards.
- A valid note can be resubmitted and award room-clear progression again.
- Review unlock rules are displayed but not consistently enforced.
- Interrupted review state can be lost on exit.
- Subject mastery and review streak metrics are inaccurate.
- Privacy documentation conflicts with web image uploads.
- The current typecheck command does not explicitly check all project references.
- The current test setup mocks Phaser and cannot validate real world behavior.

---

## 6. Target Architecture

```text
React DOM application shell
├── Home, onboarding, navigation, HUD, panels, dialogs
├── Note editor, full map, Data Center, Settings
├── Statistics and private share-card views
├── Renderer-neutral application controllers
├── Zustand stores and selectors
└── Storage repository
    ├── Legacy localStorage adapter during migration
    ├── IndexedDB generation adapter
    └── Electron bridge compatibility adapter

World host
├── Temporary Phaser adapter
└── PixiJS 8 adapter
    ├── Shared Application lifecycle
    ├── Shared input and camera systems
    ├── Village world
    ├── Dungeon world
    └── Fishing world

Domain and application core
├── Graph and navigation
├── Note validation
├── Artifacts
├── Progression
├── Review and spaced repetition
├── Fishing mechanics and collection
├── Statistics events
├── Adaptive assistance
└── Backup codecs and migrations
```

### 6.1 Renderer boundary

Introduce renderer-neutral world contracts containing:

- World models for rooms, corridors, floors, structures, NPCs, and player state.
- World events for room entry, interaction, floor transitions, artifact pickup, and NPC proximity.
- World commands for teleport, floor visibility, focus, room-state updates, and interaction triggering.
- Renderer lifecycle methods for resize, focus, pause, resume, and destruction.

Neither `src/core/` nor renderer-neutral application modules may import Phaser or PixiJS.

### 6.2 React and Pixi responsibility split

React DOM owns:

- Educational and instructional text.
- Forms, text editing, Markdown preview, settings, and dialogs.
- Minimap, full map, Data Center, statistics, and share previews.
- Keyboard and screen-reader alternatives for world actions.
- Contextual nearby-action controls.

Pixi owns:

- World rendering.
- Camera, navigation visuals, and renderer-local animation.
- Characters, structures, water, weather, lighting, and ambient effects.
- Visual proximity, selection, and interaction feedback.

---

## 7. Data Architecture

### 7.1 Storage-v2 generation model

Use IndexedDB for the redesigned web application. Store data under an `activeGeneration` pointer so migrations and restores can be staged atomically.

Recommended object stores:

- `meta`
- `subjects`
- `progression`
- `sessions`
- `preferences`
- `shortcuts`
- `assistance`
- `attachments`
- `customSprites`
- `recovery`
- `migrationReceipts`

A migration or restore must:

1. Read and validate source data without modifying it.
2. Write a complete new generation.
3. Compare record counts, relationships, and checksums.
4. Write a migration receipt.
5. Flip `activeGeneration` only after validation succeeds.
6. Retain the previous generation for rollback.
7. Mirror writes to legacy storage while the Phaser fallback remains available.

### 7.2 Migration sequence

1. Detect all current `knowledge-dungeon:*` and known legacy `kd-*` keys.
2. Read legacy data without changing it.
3. Validate all subjects.
4. Migrate subject schema `1.0.0` to `1.1.0`.
5. Normalize progression versions 1, 2, and 3 into one canonical representation.
6. Import sessions, preferences, shortcuts, locale, quest state, assistance-compatible defaults, custom sprite data, and recovery records.
7. Import available attachment bytes into IndexedDB.
8. Mark historical server-hosted attachments as external-only when their bytes cannot be recovered.
9. Stage the IndexedDB generation.
10. Run semantic validation and checksum comparison.
11. Write a migration receipt.
12. Activate the staged generation.
13. Begin dual writes during the rollback window.
14. If any step fails, leave the legacy generation active and show a recovery screen.

### 7.3 Data products

#### Full-device backup: `.kdbak`

A ZIP-based archive containing:

```text
manifest.json
state.json
attachments/<sha256>
custom-sprites/*
recovery/*
```

`state.json` includes all subjects, authoritative progression, fish, sessions, preferences, shortcuts, locale, quest state, assistance, custom sprite records, and migration receipts.

The import must preserve unknown app-owned fields and report unavailable external-only attachments. A failed import must not replace the active generation.

#### Individual subject backup: `.kdsubject`

A ZIP-based archive containing:

```text
manifest.json
subject.json
progression.json
sessions.json
assistance.json
attachments/*
```

The default import mode is **Create copy**, which remaps subject, room, edge, fish, session, and attachment identifiers. **Replace existing** must be explicit, destructive, and confirmed.

#### Blank reusable template: `.kdtemplate`

JSON containing only:

- Template name and description.
- Root topic.
- Room topics.
- Edge and cross-link structure.
- User-approved non-private tags.
- Optional biome preference.

Templates exclude notes, drafts, artifacts, validation, review state, SM-2 data, progression, fish, inventory, assistance history, original IDs, attachments, filenames, and private metadata.

The archive format must use a small audited open-source library selected during implementation. Do not hand-roll ZIP encoding or decoding.

---

## 8. Adaptive Assistance

The rebuilt application includes three assistance modes:

- **Off:** No proactive suggestions.
- **Gentle:** Short steps, stronger cues, examples, and more generous timing.
- **Standard:** Contextual hints after hesitation, repeated attempts, or low recall.

Assistance may use:

- Failed note-validation criteria.
- Repeated drafts.
- Graph structure and related topics.
- Review due dates and recall ratings.
- Fishing recall results.
- Aggregate local study behavior.

Assistance must not:

- Collect raw keystrokes.
- Infer sensitive traits.
- Leave the device.
- Generate answers automatically.
- Auto-confirm validation.
- Bypass progression or review rules.
- Change deterministic learning outcomes without showing why.

Every suggestion must be explainable and dismissible. Assistance state must be included in backups.

---

## 9. Private Sharing

The redesigned sharing system supports:

- Subject progress cards.
- Collection and badge cards.
- Fish collection cards.
- Study-statistics cards.

Requirements:

- Always provide a local PNG download.
- Use Web Share only after an explicit user action and only when `navigator.canShare` reports file support.
- Provide a preview before delivery.
- Let the user choose whether a subject name is visible.
- Exclude notes, internal IDs, room lists, and assistance history by default.
- Use only CC0-approved decorative assets and fonts.
- Surface unsupported, denied, cancelled, and failed sharing states.
- Add no upload endpoint, public URL, analytics, or sharing backend.

---

## 10. Accessibility, Performance, and License Gates

### 10.1 Accessibility

Every phase touching a user flow must preserve or improve:

- WCAG 2.2 AA target.
- Complete keyboard operation of the core flow.
- A DOM equivalent for every Pixi interaction.
- Minimum 44 by 44 CSS-pixel touch targets.
- No hover-only actions.
- Text contrast of at least 4.5:1.
- Non-text contrast of at least 3:1.
- No color-only state communication.
- Visible focus indicators.
- Dialog focus trapping, initial focus, Escape handling, and focus restoration.
- `prefers-reduced-motion` support in React and Pixi.
- Core operation at 200% zoom and a 320 CSS-pixel viewport.

### 10.2 Performance

Initial targets:

- Welcome initial JavaScript and CSS: no more than 300 KB gzip, excluding lazy renderer bundles.
- Any lazy JavaScript chunk: no more than 800 KB gzip.
- Total raw `dist`: retain the current 12 MB ceiling unless measured evidence justifies a change.
- A 100-room dungeon should target 60 FPS with p95 frame time below 20 ms on reference devices.
- Interaction acknowledgement under 100 ms.
- No material canvas or GPU memory growth over 20 world mount and unmount cycles.
- No eager Phaser or Pixi load on Welcome.
- Correct Pixi Application and asset-bundle teardown.
- Ticker pause while the document is hidden.
- Lower resolution and antialiasing profiles for constrained devices.

### 10.3 CC0 media

CI must reject any newly registered media that lacks:

- Stable asset ID and path.
- Creator or source.
- Source URL where applicable.
- Exact `CC0-1.0` license identifier.
- License URL.
- Retrieval or creation date.
- SHA-256 checksum.
- Modification record.

Unverified legacy assets may remain available to the legacy renderer during migration but must not be included in the default PixiJS bundle.

---

## 11. Feature Flags and Cutover

Planned build-time flags:

```text
VITE_WORLD_RENDERER=phaser|pixi
VITE_STORAGE_REPOSITORY=legacy|v2
VITE_PIXI_VILLAGE=true|false
VITE_PIXI_DUNGEON=true|false
VITE_PIXI_FISHING=true|false
VITE_COZY_VISUALS=true|false
VITE_ADAPTIVE_ASSISTANCE=true|false
VITE_DATA_PRODUCTS_V2=true|false
VITE_WEB_SHARE=true|false
```

Before cutover:

- Production defaults remain Phaser and legacy storage.
- Pixi paths run in CI and internal builds.
- Storage-v2 is staged and mirrored.
- New data products and assistance are opt-in.

At cutover:

- Pixi, storage-v2, Cozy visuals, data products, and Gentle assistance become defaults.
- Phaser and legacy storage remain available for one release cycle.
- The previous generation and mirror data remain recoverable.

Phaser is removed only after a seven-day soak and one successful release cycle.

---

## 12. Global Working Rules

1. Implement exactly one phase at a time.
2. Stop at the phase exit gate before beginning the next phase.
3. Do not combine renderer migration with unrelated data-format work unless the phase explicitly requires it.
4. Keep subject schema `1.1.0` during the renderer rebuild. Product and storage versions are separate.
5. Every migration must be versioned, idempotent, validated, non-destructive until final cleanup, and fixture-tested.
6. Do not log or place learner data in URLs, filenames, feature flags, or error reports.
7. Apply accessibility, touch, performance, and CC0 gates from the first affected phase.
8. Do not allow renderer imports into `src/core/` or renderer-neutral application modules.
9. Keep world assets lazy-loaded.
10. Make every persistence and progression operation idempotent and failure-aware.
11. Do not automatically delete legacy data.
12. Do not let Electron packaging block web release work.
13. Add newly discovered out-of-scope work to a follow-up list rather than expanding the active phase.
14. Record phase evidence before requesting acceptance.

### 12.1 Common verification gate

Every phase must run:

```bash
npm run lint
npm run typecheck
npm test
npm run build:web
npm run check:bundle-size
```

Additional phase-specific commands are listed in each phase.

---

## 13. Dependency Graph

```text
Phase 0 Baseline
   ↓
Phase 1 Flags, E2E, and quality rails
   ↓
Phase 2 Renderer-neutral contracts
   ↓
Phase 3 Storage-v2 foundation
   ↓
Phase 4 Storage cutover and local attachments
   ↓
Phase 5 Full-device backup
   ↓
Phase 6 Subject backup
   ↓
Phase 7 Blank template
   ↓
Phase 8 Cozy design and CC0 foundation
   ↓
Phase 9 PixiJS runtime host
   ↓
Phase 10 Asset bundles and audio
   ↓
Phase 11 Village world foundation
   ↓
Phase 12 Village social layer
   ↓
Phase 13 Dungeon world
   ↓
Phase 14 Creator flow
   ↓
Phase 15 Scribe flow
   ↓
Phase 16 Archaeologist flow
   ↓
Phase 17 Fishing
   ↓
Phase 18 Statistics
   ↓
Phase 19 Adaptive assistance
   ↓
Phase 20 Private share cards
   ↓
Phase 21 Accessibility and responsive audit
   ↓
Phase 22 Performance, memory, and offline hardening
   ↓
Phase 23 Production cutover and soak
   ↓
Phase 24 Remove Phaser and legacy renderer
```

---

## 14. One-Phase-at-a-Time Protocol

1. Select one phase only.
2. Confirm the previous phase is accepted and all prerequisites exist.
3. Create a clean starting checkpoint or explicitly account for existing worktree changes.
4. Run the baseline verification gate.
5. Restate the active phase objective, scope, non-goals, expected files, and rollback method.
6. Implement only the declared scope.
7. Run phase-specific verification.
8. Run the common verification gate.
9. Test the rollback path when a feature flag or staged generation is involved.
10. Record:
    - Files changed.
    - Commands run.
    - Device checks completed.
    - Migration result.
    - Bundle and performance result.
    - Known limitations.
    - Rollback procedure.
11. Set exactly one status:
    - `not-started`
    - `in-progress`
    - `blocked`
    - `verified`
    - `complete`
12. Pause after `verified` and request explicit acceptance.
13. On failure, return to the last verified checkpoint.
14. During the soak period, allow only privacy, data-loss, crash, security, or critical accessibility fixes.

---

## 15. Phase Summary

| Phase | Status | Objective |
| --- | --- | --- |
| 0 | verified | Freeze behavior and legacy compatibility fixtures. |
| 1 | not-started | Add flags, browser tests, accessibility scaffolding, and quality rails. |
| 2 | not-started | Extract renderer-neutral application contracts. |
| 3 | not-started | Build storage-v2 and migration infrastructure. |
| 4 | not-started | Cut over storage behind a flag and add local attachments. |
| 5 | not-started | Deliver full-device backup and restore. |
| 6 | not-started | Deliver individual subject backup and restore. |
| 7 | not-started | Deliver safe blank reusable templates. |
| 8 | not-started | Establish Cozy design tokens and the CC0 media gate. |
| 9 | not-started | Build the PixiJS runtime host. |
| 10 | not-started | Build asset bundles and functional audio. |
| 11 | not-started | Build the Pixi village world foundation. |
| 12 | not-started | Build village NPCs, quests, and redesigned panels. |
| 13 | not-started | Build the Pixi dungeon world and navigation. |
| 14 | not-started | Redesign the Creator flow. |
| 15 | not-started | Redesign the Scribe flow. |
| 16 | not-started | Redesign the Archaeologist flow. |
| 17 | not-started | Rebuild fishing in Pixi. |
| 18 | not-started | Wire and redesign study statistics. |
| 19 | not-started | Add local adaptive assistance. |
| 20 | not-started | Redesign private share cards. |
| 21 | not-started | Complete accessibility and responsive verification. |
| 22 | not-started | Complete performance, memory, and offline hardening. |
| 23 | not-started | Cut over production and complete the soak. |
| 24 | not-started | Remove Phaser and temporary migration infrastructure. |

---

# 16. Detailed Implementation Phases

## Phase 0: Baseline and Compatibility Fixtures

**Status:** verified
**Objective:** Freeze the current main flow and legacy data behavior before changing architecture.

### Prerequisites

None.

### Scope

- Define the golden path from Welcome through all three learning phases and back to Village.
- Capture subject schema `1.0.0` and `1.1.0` fixtures.
- Capture progression versions 1, 2, and 3.
- Inventory app-owned localStorage keys, custom sprite keys, quest state, and recovery data.
- Record current build sizes, route behavior, and control inventory.
- Add ADR `docs/adr/002-react-dom-pixijs-rebuild.md` documenting the new renderer and data decisions.
- Define intended behavior for current defects listed in this plan.

### Non-goals

- No production behavior changes.
- No dependency changes.
- No UI redesign.
- No storage migration.

### Expected files

- `docs/adr/002-react-dom-pixijs-rebuild.md`
- `tests/fixtures/persistence/`
- `tests/contracts/`
- `README.md`

### Deliverables

- Versioned legacy fixtures.
- Main-flow acceptance matrix.
- Legacy-key inventory.
- Build-size baseline.
- Accepted behavior-defect decisions.

### Verification

Run the common gate plus:

```bash
npm run build:web:profile
npm run check:bundle-size
```

### Verification evidence

Recorded on 2026-09-24:

- Focused characterization suite: 2 files and 20 tests passed.
- Full Vitest suite: 34 files and 254 tests passed.
- `npm run lint`, `npm run typecheck`, and `npm run build:web` passed.
- Production `npm run check:bundle-size` passed at 4,093,638 bytes across 105 files.
- `npm run build:web:profile` passed. The following profile bundle check reports the existing source-map-inclusive baseline of 28,397,913 bytes across 113 files, above the 12,000,000-byte raw ceiling. This is documented as a baseline limitation, not a production bundle result.
- The golden-flow, route/control, app-owned localStorage, build-size, and known-defect records are in `tests/contracts/phase-0-baseline.md`.
- Subject schema `1.0.0`/`1.1.0` and progression versions 1/2/3 use synthetic fixtures and deterministic characterization tests. No migration or learner data was modified.
- No production source, dependency, or build configuration changed. No new browser/device, accessibility, performance, privacy-network, or license gate was introduced in this documentation/test-only phase.

### Exit criteria

- Existing tests pass.
- Fixtures reproduce current import behavior.
- Golden flow is explicit and reviewable.
- No production code changes are included.

### Rollback

Revert documentation and test-only changes.

### Unlocks

Phase 1.

---

## Phase 1: Runtime Flags, Browser Tests, and Quality Rails

**Status:** not-started
**Objective:** Introduce safe cutover controls and browser-level test infrastructure while Phaser remains the default.

### Prerequisites

Phase 0 accepted.

### Scope

- Add typed build-time feature flags with documented defaults.
- Add Playwright projects for desktop Chromium, Chromebook viewport, tablet portrait, and tablet landscape.
- Add axe accessibility test scaffolding.
- Add a network-spy test proving the redesigned app makes no analytics or automatic upload requests.
- Correct `npm run typecheck` so application, Node, and Electron projects are checked intentionally.
- Add CI jobs for lint, typecheck, unit tests, browser smoke tests, and web build.
- Record build metadata used by later performance phases.

### Non-goals

- No Pixi implementation.
- No storage migration.
- No visual redesign.
- No user-facing debug switch.

### Expected files

- `package.json`
- `package-lock.json`
- `vite.config.ts`
- `playwright.config.ts`
- `src/config/runtimeConfig.ts`
- `src/config/featureFlags.ts`
- `tests/e2e/`
- `.github/workflows/ci.yml`

### Deliverables

- Flag matrix.
- Deterministic current-build E2E smoke suite.
- Browser accessibility harness.
- Privacy network test harness.
- Correct typecheck and CI commands.

### Verification

```bash
npm run test:e2e
npm run test:e2e -- --project=chromebook
npm run test:e2e -- --project=tablet
```

Run the common gate.

### Exit criteria

- Current production default still renders Phaser.
- E2E tests do not upload data.
- Every future flag has a default, owner phase, and rollback behavior.
- Typecheck covers the intended projects.

### Rollback

Revert tooling and leave all new flags disabled.

### Unlocks

Phases 2, 8, 9, and 19.

---

## Phase 2: Renderer-Neutral Application Contracts

**Status:** not-started
**Objective:** Move learning-flow orchestration out of `GameScreen`, `VillageScreen`, and Phaser scenes.

### Prerequisites

Phase 1 accepted.

### Scope

- Define world model, event, command, and renderer lifecycle interfaces.
- Extract commands for subject activation, room interaction, structure interaction, floor changes, artifact collection, review completion, return to Village, and entering or leaving fishing.
- Make `useLoadSubjectFlow` the only subject activation implementation.
- Move or re-export renderer-neutral dungeon layout, biome definitions, fishing mechanics, and fish collection logic.
- Adapt current Phaser scenes to the new contracts without changing gameplay.
- Add an import-boundary lint rule preventing renderer imports from core and application layers.

### Non-goals

- No Pixi implementation.
- No storage change.
- No UI redesign.
- No changed graph, note, or progression rules.

### Expected files

- `src/application/contracts/`
- `src/application/studyFlow.ts`
- `src/application/subjectActivation.ts`
- `src/core/layout/`
- `src/core/biomes/`
- `src/core/fishing/`
- `src/ui/hooks/useLoadSubjectFlow.ts`
- `src/ui/screens/GameScreen.tsx`
- `src/ui/screens/VillageScreen.tsx`
- `src/game/createGame.ts`
- `src/game/createVillageGame.ts`
- `eslint.config.js`

### Deliverables

- Renderer-neutral contracts.
- Shared application flow controller.
- Compatibility re-exports for old import paths.
- Contract tests for every current Phaser callback.

### Verification

Run the common gate plus:

```bash
npm run test:contracts
npm run test:e2e
```

### Exit criteria

- `src/core/` and `src/application/` contain no Phaser or Pixi imports.
- Existing user-visible behavior is unchanged.
- Phaser can be replaced solely through a renderer adapter.

### Rollback

Disable the new controller and return to the current screen orchestration.

### Unlocks

Phases 3 and 9.

---

## Phase 3: Storage-v2 Repository Foundation

**Status:** not-started
**Objective:** Build IndexedDB storage and migration infrastructure without making it the default.

### Prerequisites

Phase 2 accepted.

### Scope

- Select, review, and add a small audited open-source archive dependency for backup products.
- Define generation-based IndexedDB stores.
- Implement transactional repository APIs.
- Extract subject and progression validation and migration from UI-facing persistence.
- Implement idempotent subject `1.0.0` to `1.1.0` migration.
- Implement progression version 1, 2, and 3 normalization into one canonical representation.
- Build a legacy app-state reader with an explicit key allowlist.
- Preserve unknown fields and raw recovery records.
- Add attachment blob storage and checksum utilities.
- Add migration receipt and rollback-generation APIs.

### Non-goals

- No default storage cutover.
- No user-facing Data Center.
- No deletion of legacy keys.
- No renderer work.

### Expected files

- `src/services/persistence/v2/database.ts`
- `src/services/persistence/v2/repository.ts`
- `src/services/persistence/v2/schema.ts`
- `src/services/persistence/v2/migrations.ts`
- `src/services/persistence/v2/legacyReader.ts`
- `src/services/persistence/v2/validation.ts`
- `src/services/persistence/v2/archive.ts`
- `src/core/validation/persistence/types.ts`
- `src/store/progressionStore.ts`
- `package.json`
- `package-lock.json`

### Deliverables

- Hidden storage-v2 implementation.
- Migration fixtures and checksum utilities.
- Transaction rollback tests.
- Migration report model.
- External-only attachment report model.
- Canonical fish entry and fishing context types.

### Verification

Run the common gate plus:

```bash
npm run test:migrations
npm test -- tests/unit/subjectPersistence.test.ts
npm test -- tests/unit/fishCollectionService.test.ts
```

### Exit criteria

- Legacy fixtures migrate idempotently.
- A failed staged transaction leaves the active generation unchanged.
- Legacy keys remain byte-for-byte untouched.
- Progression and fish have one canonical representation.

### Rollback

Disable the unreferenced storage-v2 implementation.

### Unlocks

Phase 4.

---

## Phase 4: Storage Cutover and Local Attachments

**Status:** not-started
**Objective:** Route the existing persistence facade through storage-v2 behind a disabled-by-default flag.

### Prerequisites

Phase 3 accepted.

### Scope

- Replace module-load-time localStorage hydration with an explicit asynchronous application bootstrap.
- Hydrate subject, progression, preferences, shortcuts, and session stores before rendering.
- Route `subjectPersistence.ts` through the selected repository.
- Dual-write storage-v2 changes to the legacy mirror while Phaser remains the default.
- Store web image bytes in IndexedDB instead of posting to `/api/upload`.
- Preserve external attachment URLs without automatic background fetching.
- Preserve Electron bridge compatibility without adding Electron release requirements.
- Add migration preview, success, partial-attachment warning, and recovery states.

### Non-goals

- No final legacy-key deletion.
- No new archive product UI.
- No Pixi work.
- No automated external image downloading.

### Expected files

- `src/ui/App.tsx`
- `src/store/subjectStore.ts`
- `src/store/progressionStore.ts`
- `src/store/preferencesStore.ts`
- `src/store/shortcutStore.ts`
- `src/services/sessionTracker.ts`
- `src/services/persistence/subjectPersistence.ts`
- `src/services/persistence/v2/`
- `src/ui/components/NoteEditorModal.tsx`
- `server/index.js` only to ensure the new app does not depend on its upload API

### Deliverables

- Safe legacy-to-v2 migration.
- Device-local web attachments.
- Dual-readable and dual-writable compatibility period.
- Recovery UI for failed migration.
- Accurate privacy copy.

### Verification

Run the common gate plus:

```bash
npm run test:migrations
npm run test:privacy
npm run test:e2e
```

Manual checks:

- Import each legacy fixture into a clean browser profile.
- Refresh and verify all subjects and progression.
- Add a local image, refresh, and confirm it remains available offline.
- Confirm the new app sends no image upload request.

### Exit criteria

- No visible data loss in legacy fixtures.
- Migration can run repeatedly without duplication.
- Phaser rollback can still read mirrored changes.
- The redesigned app makes no learner-data upload request.

### Rollback

Set `VITE_STORAGE_REPOSITORY=legacy` and retain the staged generation for diagnosis.

### Unlocks

Phases 5, 6, and 7.

---

## Phase 5: Full-Device Backup Product

**Status:** not-started
**Objective:** Deliver a lossless full-device backup and restore flow.

### Prerequisites

Phase 4 accepted.

### Scope

- Implement `.kdbak` export and import.
- Include subjects, progression, fish, sessions, preferences, shortcuts, locale, quest state, assistance, custom sprites, attachments, and recovery records.
- Generate a manifest with counts, versions, and SHA-256 checksums.
- Add a Data Center shell with a full-backup tab and privacy explanation.
- Add local download.
- Add file inspection and an explicit destructive confirmation.
- Import into a new generation and retain the previous generation.

### Non-goals

- No cloud upload.
- No Web Share for backups.
- No subject-only filtering.
- No deletion of existing user data during import failure.

### Expected files

- `src/services/persistence/products/fullDeviceBackup.ts`
- `src/services/persistence/products/archiveValidation.ts`
- `src/ui/data/DataCenter.tsx`
- `src/ui/data/ImportPreview.tsx`
- `src/ui/data/RecoveryStatus.tsx`

### Deliverables

- `.kdbak` format specification.
- Round-trip full-state tests.
- Fresh-profile restore test.
- Data Center full-backup tab.

### Verification

```bash
npm run test:data
npm test -- tests/unit/subjectPersistence.test.ts
npm run test:e2e
```

Run the common gate.

### Exit criteria

- A populated storage-v2 state exports and restores with semantic equality.
- All available attachment bytes and custom sprite data survive.
- Corrupt archives never replace current data.
- External-only images are disclosed.

### Rollback

Hide the tab and disable import. The format is additive.

### Unlocks

Phase 6.

---

## Phase 6: Individual Subject Backup Product

**Status:** not-started
**Objective:** Move one subject and its associated learner state safely between devices.

### Prerequisites

Phase 5 accepted.

### Scope

- Implement `.kdsubject` export and import.
- Include the subject, progression, fish, filtered sessions, assistance, and attachments.
- Implement **Create copy** as the default import mode.
- Implement explicit **Replace existing** with destructive confirmation.
- Remap every ID and reference in copy mode.
- Preserve IDs in replace mode.
- Report missing or unavailable external-only attachments.

### Non-goals

- No global preferences or unrelated subjects.
- No cloud sync.
- No automatic replacement.

### Expected files

- `src/services/persistence/products/subjectBackup.ts`
- `src/services/persistence/products/idRemapping.ts`
- `src/ui/data/DataCenter.tsx`
- `src/ui/screens/WelcomeScreen.tsx`

### Deliverables

- `.kdsubject` specification.
- Copy and replace import flows.
- Subject backup tab.
- Collision and corrupt-archive tests.

### Verification

```bash
npm run test:data
npm run test:e2e
```

Run the common gate.

### Exit criteria

- A copied subject is independent and fully usable.
- A replaced subject matches the backup semantically.
- No unrelated subject or global setting changes.
- All ID references remain valid after copy import.

### Rollback

Hide the product and remove only staged import data.

### Unlocks

Phase 7.

---

## Phase 7: Blank Reusable Template Product

**Status:** not-started
**Objective:** Deliver a graph-only template workflow that cannot contain private learner data.

### Prerequisites

Phase 6 accepted.

### Scope

- Replace current template behavior that can retain attachment metadata.
- Define `.kdtemplate` JSON.
- Export graph structure and user-approved non-private tags only.
- Strip notes, artifacts, attachments, progression, review state, fish, assistance, original IDs, and file metadata.
- Import with fresh IDs and blank room state.
- Allow an optional template name, description, and destination subject name.

### Non-goals

- No note sharing.
- No media embedding.
- No private progress sharing.
- No preservation of original IDs.

### Expected files

- `src/services/persistence/products/subjectTemplate.ts`
- `src/services/persistence/subjectPersistence.ts`
- `src/ui/data/DataCenter.tsx`
- `src/ui/screens/WelcomeScreen.tsx`

### Deliverables

- `.kdtemplate` specification.
- Safe graph-only exporter.
- Fresh-ID template importer.
- Tests proving private fields are absent.

### Verification

```bash
npm run test:data
npm test -- tests/unit/subjectPersistence.test.ts
```

Run the common gate.

### Exit criteria

- A template contains no learner content, attachment metadata, or original IDs.
- Imported graph structure matches the export.
- Two imports create independent subjects.
- Templates import into Creator state with blank notes.

### Rollback

Retain the legacy template path behind the old UI until cutover.

### Unlocks

Phase 8.

---

## Phase 8: Cozy Visual System and CC0 Media Foundation

**Status:** not-started
**Objective:** Define the storybook visual language and make media licensing enforceable.

### Prerequisites

Phase 7 accepted.

### Scope

- Define warm parchment, moss, berry, ink, firelight, and high-contrast design tokens.
- Create rounded storybook panel, border, typography, spacing, and motion tokens shared by React and Pixi.
- Map existing theme preferences to the Cozy theme during migration.
- Remove production dependence on remote Google Fonts.
- Classify every existing asset as approved CC0, procedural, or legacy unverified.
- Add a machine-readable CC0 asset registry.
- Add a CI asset-license checker.
- Create procedural or CC0 placeholder assets for Pixi development.
- Define reduced-motion tokens and behavior.

### Non-goals

- No world renderer.
- No wholesale React component replacement.
- No final art production.
- No inclusion of unverified legacy assets in Pixi bundles.

### Expected files

- `src/theme/`
- `src/styles.css` and focused style modules
- `src/store/preferencesStore.ts`
- `public/assets/asset-licenses.json`
- `scripts/check-cc0-assets.mjs`
- `public/assets/CREDITS.md`
- `index.html`
- `package.json`

### Deliverables

- Shared Cozy token source.
- High-contrast token variant.
- Reduced-motion preference.
- CC0 registry and CI gate.
- Procedural development asset set.
- App renders without remote font requests.

### Verification

```bash
npm run test:licenses
npm run build:web
```

Perform manual contrast review for token combinations.

### Exit criteria

- New media cannot be added without CC0 metadata.
- The app renders without remote font requests.
- Legacy assets are separated from approved Pixi assets.
- Focus and state styling is visible without relying on color.

### Rollback

Set `VITE_COZY_VISUALS=false` and retain legacy renderer themes.

### Unlocks

Phases 9, 10, 11, 13, 17, and 20.

---

## Phase 9: PixiJS 8 Runtime Host

**Status:** not-started
**Objective:** Add a reusable PixiJS host while the world still uses the Phaser adapter.

### Prerequisites

Phase 8 accepted.

### Scope

- Add PixiJS 8.
- Implement `new Application()` followed by asynchronous `app.init()`.
- Configure responsive sizing, device pixel ratio, safe canvas insertion, renderer preference, and quality profiles.
- Add a private ticker, visibility pause, and reduced-motion behavior.
- Add correct teardown with `releaseGlobalResources` where appropriate.
- Add a test world with a sprite, keyboard action, pointer action, and DOM mirror.
- Keep Pixi in a lazy bundle.
- Add a build-time Phaser or Pixi renderer switch.

### Non-goals

- No Village, dungeon, or fishing implementation.
- No default renderer cutover.
- No use of Pixi for forms or dialogs.

### Expected files

- `src/renderers/pixi/runtime/PixiCanvas.tsx`
- `src/renderers/pixi/runtime/createPixiApplication.ts`
- `src/renderers/pixi/runtime/PixiWorldHost.tsx`
- `src/renderers/pixi/runtime/useWorldQuality.ts`
- `src/renderers/pixi/runtime/types.ts`
- `src/config/featureFlags.ts`
- `vite.config.ts`
- `package.json`
- `package-lock.json`

### Deliverables

- Renderer-neutral Pixi host.
- Dummy Pixi world.
- Lifecycle and resize tests.
- Phaser and Pixi build switch.
- Lazy Pixi chunk.

### Verification

```bash
VITE_WORLD_RENDERER=phaser npm run build:web
VITE_WORLD_RENDERER=pixi npm run build:web
npm run test:e2e
npm run check:memory
```

Run the common gate.

### Exit criteria

- Pixi does not load on Welcome.
- Repeated mount and unmount does not leak canvases or GPU resources.
- Keyboard and DOM action mirrors work with Pixi active.
- Pixi and Phaser builds both compile.

### Rollback

Set `VITE_WORLD_RENDERER=phaser`.

### Unlocks

Phase 10.

---

## Phase 10: CC0 Asset Bundles and Audio Foundation

**Status:** not-started
**Objective:** Provide safe, lazy asset and audio services for all Pixi worlds.

### Prerequisites

Phase 9 accepted.

### Scope

- Define Pixi asset bundles for common, village, dungeon, fishing, and share-card media.
- Use `Assets.load` and explicit bundle unloading.
- Validate custom sprite overrides and revoke blob URLs correctly.
- Replace the placeholder methods in `src/services/audioManager.ts:133-146` with real playback.
- Require a user gesture before playback.
- Add music volume, SFX volume, mute, and persisted audio preferences.
- Add accessible audio settings.
- Use only CC0-approved media.
- Provide procedural visual and audio fallbacks for optional missing assets.

### Non-goals

- No autoplay.
- No music composition workflow.
- No remote media dependency.
- No final world-specific asset production.

### Expected files

- `src/renderers/pixi/assets/assetManifest.ts`
- `src/renderers/pixi/assets/AssetLoader.ts`
- `src/services/audioManager.ts`
- `src/store/preferencesStore.ts`
- `src/ui/components/SettingsModal.tsx`
- `public/assets/asset-licenses.json`

### Deliverables

- Lazy Pixi bundles.
- Functional audio service.
- Audio settings and persistence.
- Asset failure and fallback tests.
- Bundle unloading behavior.

### Verification

```bash
npm run test:licenses
npm test -- tests/unit/preferencesStore.test.ts
npm run test:e2e
```

Manual checks:

- No audio plays before a user gesture.
- Mute and volume persist across routes.
- No remote media request occurs.
- Optional missing art or audio does not break the route.

Run the common gate.

### Exit criteria

- Every loaded media file is CC0-approved.
- Missing optional media does not break a route.
- Pixi textures and audio resources are released correctly.
- User audio controls are keyboard and screen-reader accessible.

### Rollback

Disable audio independently and retain procedural art fallbacks.

### Unlocks

Phases 11, 13, 17, and 20.

---

## Phase 11: Pixi Village World Foundation

**Status:** not-started
**Objective:** Replace the village Phaser world layer while preserving layout, structures, portals, and navigation.

### Prerequisites

Phase 10 accepted.

### Scope

- Render village paths, structures, decorations, dynamic subject portal slots, and player.
- Implement camera bounds, zoom, resize, spawn restoration, and world quality profiles.
- Implement keyboard movement, touch movement, tap interaction, and pinch zoom.
- Implement proximity events for structures.
- Replace per-frame React compass polling with an application-model event or throttled update.
- Port deterministic structure depth and portal-slot behavior.
- Keep panels and NPC business logic outside Pixi.

### Non-goals

- No redesigned dialogue or quest flow.
- No fishing presentation.
- No final Cozy asset set.

### Expected files

- `src/renderers/pixi/village/VillageWorld.tsx`
- `src/renderers/pixi/village/createVillageScene.ts`
- `src/renderers/pixi/village/VillageRenderer.ts`
- `src/renderers/pixi/input/WorldInputController.ts`
- `src/renderers/pixi/camera/CameraRig.ts`
- `src/data/villageLayout.ts`
- `src/ui/screens/VillageScreen.tsx`

### Deliverables

- Pixi village renderer.
- Shared input and camera controllers.
- Structure and portal event parity.
- Renderer-specific E2E tests.
- DOM nearby-action controls.

### Verification

```bash
VITE_PIXI_VILLAGE=true npm run test:e2e
npm run test:e2e -- --project=tablet
npm run check:memory
```

Run the common gate.

Manual checks:

- Approach every current static structure.
- Verify all six subject portal slots.
- Verify resize, portrait, and landscape.
- Verify keyboard and touch produce equivalent actions.

### Exit criteria

- Every current village structure is approachable and interactive.
- Touch and keyboard navigation are equivalent.
- Pixi Village can be disabled without affecting other routes.
- No current UI component imports Phaser types.

### Rollback

Set `VITE_PIXI_VILLAGE=false`.

### Unlocks

Phase 12.

---

## Phase 12: Village NPC Social Layer and Redesigned Panels

**Status:** not-started
**Objective:** Preserve the Keeper, wandering NPCs, quests, and social interactions using React DOM and Pixi.

### Prerequisites

Phase 11 accepted.

### Scope

- Render and animate all current village NPCs.
- Preserve NPC paths, greetings, random quotes, proximity, and dialogue cycling.
- Preserve quest order and context-aware Keeper dialogue.
- Split `VillageScreen` into focused HUD, structure panel, NPC dialogue, quest board, subject creation, stats, data, and settings launchers.
- Use Cozy side panels on wide screens and bottom sheets on touch devices.
- Replace scene-reference compass polling with a throttled or event-based model.
- Add a DOM quest overview and nearby-action list.
- Ensure verifiable quest actions advance from real application events rather than requiring unnecessary manual completion.

### Non-goals

- No fishing gameplay.
- No adaptive assistance.
- No multiplayer or networked NPC behavior.

### Expected files

- `src/renderers/pixi/village/VillageNpc.ts`
- `src/renderers/pixi/village/NpcController.ts`
- `src/ui/village/VillageHud.tsx`
- `src/ui/village/StructurePanel.tsx`
- `src/ui/village/NpcDialog.tsx`
- `src/ui/village/QuestBoard.tsx`
- `src/ui/village/CompassOverlay.tsx`
- `src/data/villageLayout.ts`
- `src/ui/screens/VillageScreen.tsx`

### Deliverables

- Full NPC social parity.
- Redesigned React village shell.
- DOM nearby-action controls.
- No animation-frame React updates caused by transient scene state.
- Focused Village component structure.

### Verification

```bash
npm run test:e2e
npm test -- tests/unit/RoomNpcDialog.test.tsx
```

Run the common gate.

Manual checks:

- Meet the Keeper.
- Walk away and confirm dialogue closes.
- Complete the tutorial through the village.
- Reach every structure using touch only.
- Complete a quest using keyboard and DOM controls.

### Exit criteria

- Quest and NPC dialogue behavior matches current data.
- No Pixi object is required to understand or invoke a village action.
- Village screens no longer directly import Phaser types.
- Dialogs and bottom sheets meet focus and touch-target requirements.

### Rollback

Disable Pixi Village while retaining shared React panels where compatible.

### Unlocks

Phase 13.

---

## Phase 13: Pixi Dungeon World and Navigation

**Status:** not-started
**Objective:** Replace the dungeon renderer without changing graph or floor semantics.

### Prerequisites

Phase 12 accepted.

### Scope

- Reuse deterministic `DungeonMap` output.
- Render rooms, corridors, doors, floor portals, state overlays, player, and camera.
- Port walkability and collision behavior into a pure movement controller.
- Preserve room entry, camera follow, auto-zoom, and pinch zoom.
- Preserve floor visibility and floor-entry portal behavior.
- Preserve room, floor, NPC, and artifact events through renderer-neutral contracts.
- Keep the React and SVG minimap and full map.
- Support touch tap-to-move, drag movement, WASD, and arrow keys.
- Provide a DOM nearby-action list and room navigation fallback.

### Non-goals

- No note editor or learning workspace.
- No artifact behavior change.
- No adaptive assistance.

### Expected files

- `src/renderers/pixi/dungeon/DungeonWorld.tsx`
- `src/renderers/pixi/dungeon/createDungeonScene.ts`
- `src/renderers/pixi/dungeon/DungeonRenderer.ts`
- `src/renderers/pixi/dungeon/WalkabilityController.ts`
- `src/renderers/pixi/dungeon/RoomNode.ts`
- `src/renderers/pixi/dungeon/CorridorLayer.ts`
- `src/core/graph/navigation.ts`
- `src/core/layout/dungeonGenerator.ts`
- `src/ui/components/Minimap.tsx`
- `src/ui/components/FullMapView.tsx`

### Deliverables

- Pixi dungeon renderer.
- Pure movement and collision controller.
- Renderer-independent floor and teleport commands.
- Navigation parity tests.
- Accessible DOM room navigation.

### Verification

```bash
VITE_PIXI_DUNGEON=true npm run test:e2e
npm test -- tests/unit/dungeonGenerator.test.ts
npm test -- tests/unit/graphNavigation.test.ts
npm run check:memory
```

Run the common gate.

Manual checks:

- Traverse a three-level subject.
- Verify up and down portals.
- Verify teleport cooldown behavior.
- Verify hidden-floor corridors cannot be crossed.
- Verify the full map can navigate every visible room.

### Exit criteria

- Room and floor navigation match current behavior.
- A 100-room subject remains traversable.
- Pixi Dungeon can be disabled independently.
- Every world interaction has a DOM equivalent.

### Rollback

Set `VITE_PIXI_DUNGEON=false`.

### Unlocks

Phase 14.

---

## Phase 14: Creator Learning-Flow Redesign

**Status:** not-started
**Objective:** Make subject mapping the first-class dungeon workspace while retaining graph mutations.

### Prerequisites

Phase 13 accepted.

### Scope

- Redesign the Creator room experience around current topic, related topics, graph structure, and next action.
- Preserve bulk child-topic creation.
- Preserve cross-links, reparenting, deletion, cascade behavior, and revalidation.
- Preserve map node repositioning as presentation-only local state.
- Move all mutations through the subject application layer.
- Keep graph editing in React, SVG, and DOM rather than Pixi.
- Add a DOM graph view and keyboard controls.
- Make player archetype differences affect actual tool prominence or behavior rather than unsupported claims.
- Preserve the transition recommendation into Scribe.

### Non-goals

- No note validation.
- No artifact or review work.
- No adaptive graph suggestions yet.

### Expected files

- `src/ui/study/creator/CreatorWorkspace.tsx`
- `src/ui/study/creator/TopicEditor.tsx`
- `src/ui/study/creator/GraphMap.tsx`
- `src/ui/components/RoomPanel.tsx`
- `src/ui/components/FullMapView.tsx`
- `src/ui/components/TagEditor.tsx`
- `src/store/subjectStore.ts`
- `src/core/graph/`

### Deliverables

- Redesigned Creator route.
- Shared phase-aware study shell.
- Graph mutation E2E coverage.
- No renderer-specific graph logic.
- Working tag and cross-link UI.

### Verification

```bash
npm test -- tests/unit/graphDomain.test.ts
npm test -- tests/unit/RoomPanel.test.tsx
npm run test:e2e
```

Run the common gate.

### Exit criteria

- A learner can create, link, reparent, tag, move, and delete rooms using keyboard or touch.
- Revalidation behavior remains unchanged.
- Phase transition is available at the intended point.
- No duplicate graph mutations occur under React StrictMode.

### Rollback

Retain the existing RoomPanel Creator view behind the phase flag.

### Unlocks

Phase 15.

---

## Phase 15: Scribe Encounter and Artifact Redesign

**Status:** not-started
**Objective:** Preserve note validation and progression while redesigning the writing experience.

### Prerequisites

Phase 14 accepted.

### Scope

- Create a focused Scribe encounter workspace.
- Preserve Summary, Key Points, and Recall Question requirements.
- Preserve draft saving, manual confirmation, deterministic validation, artifact generation, loot, badges, and XP.
- Move validation presentation into renderer-neutral view models.
- Keep editing, preview, formatting, image attachments, and checklists in React DOM.
- Make incomplete encounters visibly resumable.
- Add local image attachment preview and removal.
- Show artifact preview and collection state.
- Make room-clear rewards idempotent by room and valid-clear identity.
- Preserve guide NPC phase copy.

### Non-goals

- No adaptive assistance logic.
- No review phase.
- No automatic writing or automatic confirmation.

### Expected files

- `src/ui/study/scribe/ScribeEncounter.tsx`
- `src/ui/study/scribe/NoteComposer.tsx`
- `src/ui/study/scribe/ValidationSummary.tsx`
- `src/ui/study/scribe/ArtifactPreview.tsx`
- `src/ui/components/NoteEditorModal.tsx`
- `src/store/subjectStore.ts`
- `src/core/validation/notes/`
- `src/core/artifacts/`
- `src/core/progression/`

### Deliverables

- Redesigned Scribe flow.
- Shared encounter commands.
- Artifact collection event for Pixi Dungeon.
- Idempotent room-clear reward transaction.
- Local attachment integration.

### Verification

```bash
npm test -- tests/unit/noteValidation.test.ts
npm test -- tests/unit/artifactGenerator.test.ts
npm test -- tests/unit/NoteEditorModal.test.tsx
npm run test:e2e
```

Run the common gate.

### Exit criteria

- Existing validation output is unchanged.
- A valid note clears and rewards a room exactly once.
- An invalid note saves a draft without progression.
- Image attachment and preview work locally.
- Artifact generation and pickup remain separate actions.

### Rollback

Restore the existing modal as the Scribe view while retaining shared commands.

### Unlocks

Phase 16.

---

## Phase 16: Archaeologist Review and Progression Redesign

**Status:** not-started
**Objective:** Retain artifact collection, self-check, review passes, and SM-2 scheduling in a calmer review-first interface.

### Prerequisites

Phase 15 accepted.

### Scope

- Redesign review around current artifact, recall prompt, confidence or quality rating, next due date, and current pass progress.
- Preserve review finalization on panel close or explicit completion.
- Award review XP only once per room per pass.
- Preserve artifact pickup and collection.
- Preserve full-pass badges and unlock behavior.
- Enforce the intended review unlock consistently.
- Handle exit during an open review with a save, resume, or discard decision.
- Use the existing SM-2 implementation.
- Add keyboard and screen-reader alternatives for the full map and review controls.

### Non-goals

- No adaptive prioritization yet.
- No fishing recall integration yet.
- No replacement of the SM-2 algorithm.

### Expected files

- `src/ui/study/review/ArchaeologistWorkspace.tsx`
- `src/ui/study/review/RecallCard.tsx`
- `src/ui/study/review/ReviewProgress.tsx`
- `src/ui/components/InventoryBadgesPanel.tsx`
- `src/application/studyFlow.ts`
- `src/core/review/`
- `src/core/progression/`
- `src/ui/screens/GameScreen.tsx`

### Deliverables

- Redesigned Archaeologist route.
- Review command API.
- Complete golden-path E2E test.
- Artifact, NPC, and review-state parity in Pixi.
- Correct interrupted-review behavior.

### Verification

```bash
npm test -- tests/unit/reviewDomain.test.ts
npm test -- tests/unit/spacedRepetition.test.ts
npm test -- tests/unit/GameScreen.npcDialog.test.tsx
npm run test:e2e
```

Run the common gate.

### Exit criteria

- The full Creator to Scribe to Archaeologist path passes.
- Review pass and XP cannot be double-counted.
- SM-2 values survive reload and backup.
- Review unlocks behave consistently.
- Exiting during review does not silently lose committed work.

### Rollback

Use the previous Archaeologist panel and Phaser scene while retaining the command layer.

### Unlocks

Phase 17.

---

## Phase 17: Pixi Fishing Rebuild

**Status:** not-started
**Objective:** Port fishing to Pixi while preserving the familiar cast, bite, catch, keep, release, and recall loop.

### Prerequisites

Phase 16 accepted.

### Scope

- Extract a pure fishing state machine from `FishingScene`.
- Preserve idle, powering, casting, waiting, biting, reeling, caught, and missed states.
- Preserve seeded random behavior, catalog, rarity weights, power casting, bite detection, hook window, movement, and audio hooks.
- Carry one explicit pond, subject, player, and session context through the activity.
- Render water, shore, horizon, fish, rod, bobber, line, bucket, and ambient effects in Pixi.
- Keep instructions, catch result, recall, and collection controls in React DOM.
- Preserve keep and release behavior.
- Persist fish, XP, and badges through one idempotent operation.
- Record a distinct outcome when a fish is kept without recall material rather than treating it as a correct answer.
- Ensure release never mutates progression.
- Use canonical catalog IDs and subject IDs.
- Present the Fish Stand as a redesigned collection view.
- Add local recall-question navigation back to the relevant room.

### Non-goals

- No new fish species.
- No new currencies.
- No multiplayer fishing.
- No arbitrary changes to rarity probabilities without a separate product decision.

### Expected files

- `src/renderers/pixi/fishing/FishingWorld.tsx`
- `src/renderers/pixi/fishing/FishingController.ts`
- `src/renderers/pixi/fishing/createFishingScene.ts`
- `src/ui/fishing/FishingHud.tsx`
- `src/ui/fishing/FishingCatchPanel.tsx`
- `src/ui/components/FishingRecallModal.tsx`
- `src/ui/components/FishStandPanel.tsx`
- `src/core/fishing/`
- `src/game/systems/fishingMechanics.ts` compatibility re-export

### Deliverables

- Pure, tested fishing state machine.
- Pixi fishing renderer.
- Touch and keyboard parity.
- Idempotent catch transaction.
- Correct Fish Stand and collection behavior.
- Fishing browser E2E coverage.

### Verification

```bash
npm test -- tests/unit/fishingMechanics.test.ts
npm test -- tests/unit/fishingTypes.test.ts
npm test -- tests/unit/FishingRecallModal.test.tsx
npm test -- tests/unit/FishStandPanel.test.tsx
VITE_PIXI_FISHING=true npm run test:e2e
npm run check:memory
```

Run the common gate.

### Exit criteria

- A complete cast-to-catch-to-keep flow works using touch and keyboard.
- Recall questions use the same subject context as the catch.
- Fish, XP, and badges are awarded exactly once.
- Release and failed recall do not mutate progression.
- Returning to Village destroys fishing GPU resources cleanly.
- Collection counts use canonical catalog IDs and subject IDs.

### Rollback

Set `VITE_PIXI_FISHING=false`.

### Unlocks

Phases 18, 19, 20, and 21.

---

## Phase 18: Statistics and Session Lifecycle

**Status:** not-started
**Objective:** Make statistics accurate, durable, and useful through a redesigned dashboard.

### Prerequisites

Phase 17 accepted.

### Scope

- Start a session on canonical subject activation.
- End a session on subject change, return to Village, route unmount, `pagehide`, or reliable visibility transition.
- Record room visits, successful note submissions, review completions, XP awards, and fishing outcomes through centralized idempotent events.
- Avoid double counting under React StrictMode, retries, and repeated close events.
- Define local-date and daylight-saving behavior.
- Preserve study time, unique rooms visited, notes, reviews, XP, per-subject progress, daily activity, and review due or overdue metrics.
- Correct or rename room-clear streak and subject-mastery metrics.
- Redesign `StudyStatsPanel` around clear totals, subject cards, weekly activity, retention, and recent sessions.
- Show empty and restored states.
- Include statistics in backups.
- Add no remote analytics.

### Non-goals

- No cloud analytics.
- No cross-device telemetry.
- No opaque behavioral profiling.
- No public leaderboard.

### Expected files

- `src/services/sessionTracker.ts`
- `src/application/sessionLifecycle.ts`
- `src/store/statisticsStore.ts`
- `src/ui/components/StudyStatsPanel.tsx`
- `src/ui/village/VillageHud.tsx`
- `src/core/review/`

### Deliverables

- Wired session lifecycle.
- Idempotent statistics event model.
- Correct date handling.
- Redesigned statistics dashboard.
- Session migration and backup tests.

### Verification

```bash
npm test -- tests/unit/sessionTracker.test.ts
npm test -- tests/unit/StudyStatsPanel.test.tsx
npm run test:e2e
```

Run the common gate.

Manual checks:

- Complete one note and one review.
- Enter and leave the subject.
- Switch subjects.
- Background and restore the page.
- Reload and verify totals remain correct.

### Exit criteria

- Statistics are nonzero after real use.
- No duplicate sessions, XP, room, note, review, or fish events occur.
- Dates are internally consistent.
- Data survives reload, full backup, and subject backup.
- No network request carries statistics.

### Rollback

Disable statistics display while retaining collected records.

### Unlocks

Phases 19, 20, and 21.

---

## Phase 19: Adaptive Learner Assistance

**Status:** not-started
**Objective:** Add deterministic, local, explainable assistance across the learning and fishing flows.

### Prerequisites

Phase 18 accepted.

### Scope

- Add a renderer-neutral assistance engine.
- Use only local signals listed in the plan.
- Provide Off, Gentle, and Standard modes.
- Add assistance settings with a clear manual override.
- Add Creator suggestions for missing branches or meaningful cross-links.
- Add Scribe section scaffolds, related-topic links, and progressively stronger rubric hints.
- Add Archaeologist prioritization for due rooms and adjusted retrieval prompts after low recall.
- Add Fishing guidance and navigation after a missed recall question.
- Show why each suggestion appears.
- Allow dismissal without punitive effects.
- Include assistance state in all relevant backup products.
- Ensure identical state always produces identical suggestions.

### Non-goals

- No LLM or cloud service.
- No raw keystroke collection.
- No sensitive-trait inference.
- No automatic writing, answer confirmation, or validation bypass.
- No hidden change to deterministic validation.

### Expected files

- `src/core/assistance/assistanceEngine.ts`
- `src/core/assistance/types.ts`
- `src/store/assistanceStore.ts`
- `src/services/persistence/v2/assistanceRepository.ts`
- `src/ui/assistance/AssistanceCard.tsx`
- `src/ui/assistance/AssistanceSettings.tsx`
- Creator, Scribe, Archaeologist, and Fishing workspaces

### Deliverables

- Deterministic ranked-assistance model.
- Assistance settings and persistence.
- Integration across all retained flows.
- Backup and restore coverage.
- Explainability and dismissal UI.

### Verification

```bash
npm test -- tests/unit/assistanceEngine.test.ts
npm run test:privacy
npm run test:e2e
```

Run the common gate.

### Exit criteria

- Identical state always yields identical assistance.
- Assistance remains local and explainable.
- Off mode removes proactive suggestions.
- Suggestions never alter deterministic outcomes by themselves.
- Assistance survives backup and restore.
- No raw learner behavior leaves the device.

### Rollback

Set `VITE_ADAPTIVE_ASSISTANCE=false` and leave stored records untouched.

### Unlocks

Phase 20.

---

## Phase 20: Private Share Cards

**Status:** not-started
**Objective:** Retain private progress sharing with redesigned, privacy-conscious cards.

### Prerequisites

Phase 19 accepted.

### Scope

- Refactor `src/ui/utils/progressionShareExport.ts` to return a Blob and suggested filename rather than always downloading.
- Create subject-summary, collection, fish, and statistics card renderers.
- Add a preview before delivery.
- Let users choose visible subject name and metrics.
- Exclude notes, IDs, room lists, and assistance history by default.
- Always provide local PNG download.
- Use `navigator.canShare` and `navigator.share` only after an explicit action.
- Handle unsupported, denied, cancelled, and failed sharing states.
- Use canonical badge labels.
- Use only CC0-approved decorative assets and fonts.
- Add no server, public URL, analytics, or sharing backend.

### Non-goals

- No automatic sharing.
- No public profile.
- No private note sharing.
- No usage analytics.

### Expected files

- `src/ui/share/ShareCardDialog.tsx`
- `src/ui/share/renderShareCard.ts`
- `src/ui/share/shareCardPolicy.ts`
- `src/ui/utils/progressionShareExport.ts`
- `src/ui/components/InventoryBadgesPanel.tsx`

### Deliverables

- Cozy share-card templates.
- Preview and field-selection UI.
- Local PNG download.
- Explicit Web Share integration.
- Capability, cancellation, and privacy tests.

### Verification

```bash
npm test -- tests/unit/shareCards.test.ts
npm run test:privacy
npm run test:licenses
npm run test:e2e
```

Run the common gate.

### Exit criteria

- Local download works in every supported browser.
- Web Share runs only from a user click.
- Cancelling sharing causes no upload, error toast, or data mutation.
- No public card URL or sharing backend exists.
- Default cards contain no raw notes or hidden identifiers.
- All decorative assets are CC0-approved.

### Rollback

Set `VITE_WEB_SHARE=false` and retain local download.

### Unlocks

Phase 21.

---

## Phase 21: Accessibility and Responsive-Device Audit

**Status:** not-started
**Objective:** Prove the entire application is operable on Chromebook and tablet without canvas-only behavior.

### Prerequisites

Phases 11 through 20 accepted.

### Scope

- Audit Welcome, Village, Creator, Scribe, Archaeologist, Fishing, Statistics, Data Center, Settings, and share dialogs.
- Add a reusable accessible dialog with focus trap, initial focus, focus restoration, and Escape handling.
- Provide a DOM nearby-action surface for every Pixi interaction.
- Verify keyboard movement and non-canvas alternatives.
- Enforce 44 by 44 CSS-pixel touch targets.
- Verify safe-area handling, portrait, landscape, and 200% zoom.
- Complete `prefers-reduced-motion` support for React and Pixi.
- Remove serious automated accessibility violations.
- Perform ChromeVox and at least one touch-platform screen-reader review.
- Ensure no state is communicated by color alone.
- Test long localized labels and content expansion.

### Non-goals

- No new gameplay.
- No visual feature expansion.
- No requirement that Pixi AccessibilitySystem be the only accessibility route.
- No canvas-only fallback for core actions.

### Expected files

- `src/ui/components/AccessibleDialog.tsx`
- `src/ui/accessibility/`
- `src/renderers/pixi/runtime/`
- `src/ui/village/`
- `src/ui/study/`
- `src/ui/fishing/`
- `src/ui/data/`
- `src/styles/`
- `tests/a11y/`
- `tests/e2e/`

### Deliverables

- Automated accessibility suite.
- DOM equivalent for every world action.
- Keyboard and touch interaction scripts.
- Screen-reader verification record.
- Complete reduced-motion behavior.
- Responsive layout corrections.

### Verification

```bash
npm run test:a11y
npm run test:e2e -- --project=chromebook
npm run test:e2e -- --project=tablet
```

Run the common gate.

### Exit criteria

- Zero serious or critical automated accessibility violations.
- The complete learning path works through DOM controls and keyboard.
- Touch use does not depend on hover or precision gestures.
- Core layouts work at 200% zoom and a 320 CSS-pixel viewport.
- Reduced-motion mode has no continuous decorative movement.
- ChromeVox and the selected touch screen-reader script pass.

### Rollback

Revert individual accessibility fixes. No renderer or storage rollback is required.

### Unlocks

Phase 22.

---

## Phase 22: Performance, Memory, and Offline Hardening

**Status:** not-started
**Objective:** Meet the performance budgets while preserving local-first offline behavior.

### Prerequisites

Phase 21 accepted.

### Scope

- Lazy-load Pixi and each world bundle.
- Add asset and loading progress where needed.
- Profile 1-room, 10-room, and 100-room subjects.
- Optimize batching, texture count, render groups, culling, and object reuse based on measurements.
- Pool fishing effects and other frequently created visuals.
- Cap renderer resolution and antialiasing on constrained devices.
- Pause Pixi tickers while the document is hidden.
- Verify Application and asset teardown across route changes.
- Add a versioned service worker or equivalent static-shell cache for offline reload.
- Ensure the cache never contains subjects, notes, attachments, progression, statistics, or preferences.
- Replace raw-only bundle checks with route-aware gzip budgets while retaining the 12 MB raw total ceiling.
- Enforce the performance targets in this plan.

### Non-goals

- No WebGPU requirement.
- No unmeasured optimization.
- No caching of learner data.
- No visual downgrade based only on desktop benchmarks.

### Expected files

- `vite.config.ts`
- `scripts/check-bundle-size.mjs`
- `scripts/check-performance.mjs`
- `src/renderers/pixi/performance/`
- `src/services/offlineShell.ts`
- `public/manifest.webmanifest`
- `tests/performance/`
- Performance fixtures for 1, 10, and 100 rooms

### Deliverables

- Enforced route bundle budgets.
- 100-room performance fixture.
- Memory-leak regression test.
- Offline static-shell support.
- Device performance report.

### Verification

```bash
npm run check:bundle-size
npm run check:perf
npm run check:memory
npm run test:e2e
```

Run the common gate.

### Exit criteria

- Welcome and each lazy route meet transfer budgets.
- The 100-room dungeon meets the frame-time target.
- Repeated mount and unmount shows no material canvas or GPU growth.
- A previously loaded app reloads offline with local data intact.
- Static caches update without serving mixed-version assets.
- Service-worker inspection confirms no learner data is cached.

### Rollback

Revert the implementation while retaining performance tests and budgets.

### Unlocks

Phase 23.

---

## Phase 23: Production Cutover and Soak

**Status:** not-started
**Objective:** Make Pixi, Cozy visuals, storage-v2, data products, assistance, and Web Share the defaults with a tested rollback.

### Prerequisites

Phase 22 accepted.

All accessibility, performance, migration, backup, and CC0 gates pass.

At least one deployable Pixi release exists.

### Scope

- Set production defaults to Pixi, storage-v2, Cozy visuals, data products, Gentle assistance, and Web Share where supported.
- Retain Phaser and legacy-storage flags for one release cycle.
- Continue legacy mirror writes.
- Retain the previous storage generation.
- Run fresh-profile, legacy-migration, full-backup restore, subject-backup restore, and template-creation flows.
- Run all three learning phases.
- Run Village, NPC, quest, Fishing, Statistics, sharing, and Data Center flows.
- Run the complete Chromebook, tablet, accessibility, and performance matrix.
- Soak for at least seven days and one release cycle.
- Use no production telemetry.

### Non-goals

- No Phaser deletion.
- No legacy-key deletion.
- No remote configuration.
- No Electron packaging.
- No learner-data collection to evaluate the soak.

### Expected files

- `src/config/featureFlags.ts`
- Data Center and Settings release copy
- `README.md`
- `docs/UI.md`
- CI and deployment workflows

### Deliverables

- Pixi and storage-v2 production release.
- One-release rollback configuration.
- Soak report and issue summary.
- Updated privacy, backup, and user documentation.

### Verification

```bash
npm run release:verify
npm run test:e2e
npm run test:migrations
npm run test:data
npm run test:a11y
npm run test:perf
npm run test:licenses
npm run test:privacy
```

### Exit criteria

- All default-flag golden paths pass.
- No unresolved data-loss, privacy, security, or migration issue exists.
- Legacy rollback is tested.
- Fresh and migrated profiles behave identically.
- Network inspection confirms no application upload or analytics.
- Seven-day and one-release soak requirements are satisfied.

### Rollback

Restore Phaser and legacy-storage defaults while retaining storage-v2 generations and mirror data.

### Unlocks

Phase 24.

---

## Phase 24: Remove Phaser and Legacy Renderer

**Status:** not-started
**Objective:** Complete the renderer migration and remove temporary fallback infrastructure.

### Prerequisites

Phase 23 accepted.

The seven-day and one-release soak is complete.

A Pixi-only release remains available for deployment rollback.

### Scope

- Remove Phaser from `package.json` and `package-lock.json`.
- Delete:
  - `src/game/createGame.ts`
  - `src/game/createVillageGame.ts`
  - `src/game/scenes/DungeonScene.ts`
  - `src/game/scenes/VillageScene.ts`
  - `src/game/scenes/FishingScene.ts`
- Remove remaining Phaser behavior from procedural texture generation, custom sprite application, screen code, tests, and Vite configuration.
- Remove the temporary Phaser adapter.
- Remove renderer-selection flags when no deployment requires them.
- Replace the Phaser test mock with Pixi-aware browser and unit setup.
- Update README, UI guide, game guide, and ADR documentation.
- Keep Electron source or scripts only as deferred compatibility work.
- Remove Electron from mandatory web release verification.
- Retain the previous Pixi-only release for deployment rollback.

### Non-goals

- No Electron packaging, signing, or installer work.
- No reintroduction of Phaser as an emergency runtime fallback.
- No deletion of legacy learner data solely because Phaser source is removed.
- No new feature work.

### Expected files

- `package.json`
- `package-lock.json`
- `vite.config.ts`
- `vitest.setup.ts`
- Remaining `src/game/` compatibility files
- `README.md`
- `docs/UI.md`
- `docs/GAME-GUIDE.md`
- `docs/adr/001-village-hub-and-visual-overhaul.md`
- `docs/adr/002-react-dom-pixijs-rebuild.md`
- CI and deployment workflows

### Deliverables

- Phaser-free dependency and source tree.
- Pixi-only build and test suite.
- Updated architecture and user documentation.
- Final web release verification.

### Verification

```bash
npm run check:no-phaser
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:migrations
npm run test:data
npm run test:a11y
npm run test:licenses
npm run test:privacy
npm run check:perf
npm run check:memory
npm run build:web
npm run check:bundle-size
npm run release:verify
```

### Exit criteria

- No Phaser dependency, import, mock, scene, chunk, adapter, or active documentation claim remains.
- All automated and manual release gates pass.
- Electron packaging is not required for the web release.
- The previous Pixi-only release remains deployable.
- The project has one active world renderer: PixiJS 8.

### Rollback

Deploy the previous Pixi-only release. Do not restore Phaser after this phase.

### Unlocks

Project completion.

---

## 17. Final Definition of Done

### Architecture

- [ ] Phaser is absent from dependencies, source, tests, build configuration, and active documentation.
- [ ] PixiJS 8 is the sole world renderer and is lazy-loaded.
- [ ] React DOM owns educational text, forms, dialogs, maps, settings, statistics, sharing, and accessible controls.
- [ ] Core and application modules contain no renderer imports.
- [ ] `useLoadSubjectFlow` remains the canonical subject activation path.
- [ ] Electron packaging is deferred and outside the required web release path.

### Learning flow

- [ ] Create, load, template, tutorial, and subject entry flows work.
- [ ] Player archetype selection has real, supported behavior rather than misleading claims.
- [ ] Creator supports adding, linking, reparenting, tagging, moving, and deleting topics.
- [ ] Scribe supports drafts, deterministic validation, manual confirmation, local images, artifacts, and progression.
- [ ] Archaeologist supports artifact collection, self-check, review passes, ratings, and SM-2 scheduling.
- [ ] Returning to Village preserves subject and progression state.
- [ ] No action double-counts progression, review, statistics, or rewards.

### Data compatibility and products

- [ ] Existing subject `1.0.0` and `1.1.0` data migrate without loss.
- [ ] Existing progression versions migrate idempotently.
- [ ] Full-device backup restores all available app-owned state.
- [ ] Individual subject backup supports safe copy and explicit replace modes.
- [ ] Blank templates contain graph structure only and generate fresh IDs.
- [ ] Failed imports never modify the active generation.
- [ ] External-only legacy attachments are disclosed.
- [ ] Web attachments are stored locally and included in backups when available.
- [ ] Legacy data remains recoverable until an explicit later cleanup policy permits removal.

### Village, NPCs, fishing, and statistics

- [ ] All retained village structures and subject portals work.
- [ ] Keeper, wandering NPCs, dialogue, and quest progression work.
- [ ] Fishing, recall, fish persistence, collection, XP, and badges work with one explicit subject context.
- [ ] Gentle fishing assistance can extend timing and strengthen cues without changing standard rules.
- [ ] Sessions, room visits, notes, reviews, XP, and fish statistics are accurate.
- [ ] Statistics survive reload and backup and restore.

### Adaptive assistance

- [ ] Assistance is deterministic, local, explainable, and optional.
- [ ] It adapts in Creator, Scribe, Archaeologist, and Fishing.
- [ ] It never auto-writes answers, auto-confirms, or bypasses validation.
- [ ] No raw keystrokes or learner data leave the device.

### Privacy and sharing

- [ ] No account, cloud sync, public profile, analytics, remote configuration, or application upload endpoint exists in the redesigned app.
- [ ] External URLs are clearly external and user-provided.
- [ ] Share cards always offer local download.
- [ ] Web Share requires an explicit user action.
- [ ] Default cards expose no raw notes or hidden identifiers.

### Accessibility and devices

- [ ] WCAG 2.2 AA automated checks have zero serious or critical violations.
- [ ] Every Pixi action has a DOM equivalent.
- [ ] The core flow works entirely through keyboard and DOM controls.
- [ ] Touch targets are at least 44 by 44 CSS pixels.
- [ ] Core layouts pass at 200% zoom and a 320 CSS-pixel viewport.
- [ ] Reduced-motion behavior is complete.
- [ ] Chromebook, tablet portrait and landscape, ChromeVox, and a touch screen reader pass manual verification.

### Performance and offline behavior

- [ ] Welcome initial JavaScript and CSS are at most 300 KB gzip.
- [ ] Each lazy JavaScript chunk is at most 800 KB gzip.
- [ ] The 100-room dungeon meets the p95 frame-time target.
- [ ] No material memory growth occurs over repeated route cycles.
- [ ] Previously loaded static assets remain available offline.
- [ ] Offline caches contain static assets only and never learner data.

### CC0 media

- [ ] Every new art and audio file is verified as CC0.
- [ ] Every media file has source, license URL, date, checksum, and modification metadata.
- [ ] Unverified legacy assets are absent from the default Pixi bundle.
- [ ] CI rejects missing, non-CC0, or unregistered media.

### Release and rollback

- [ ] The complete web release verification passes.
- [ ] Fresh, migrated, restored, and template-created profiles pass E2E.
- [ ] The previous Pixi-only release remains deployable after Phaser removal.
- [ ] Documentation identifies Pixi as the sole renderer and Electron packaging as deferred.

---

## 18. Deferred Follow-Up Work

These items are intentionally not required to complete this plan:

- Electron packaging and signing.
- New custom sprite editing.
- Public sharing profiles or cloud synchronization.
- Multiplayer or classroom collaboration.
- Additional languages beyond completing the current localization foundation.
- New fish species or deeper fishing progression.
- Additional art themes.
- Native mobile applications.

Any deferred item requires a separate approved plan before implementation begins.
