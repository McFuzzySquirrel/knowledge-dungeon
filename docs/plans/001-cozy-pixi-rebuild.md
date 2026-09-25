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
- Web on Linux, macOS, and Windows host environments, plus Chromebook, desktop-browser, and tablet/touch support.
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

### 2.5 Release targets and web support contract

The primary release is one static web application served over HTTPS. It must be
usable in supported browser environments on Linux, macOS, and Windows, with
Chromebook/ChromeOS, desktop, and tablet form factors treated as separate
support dimensions. Tablet portrait and landscape with touch remain
first-class input targets.

Browser-engine support is separate from host-OS support. The initial automated
engine targets are Chromium, Firefox, and WebKit. A branded-browser claim such
as Edge or Safari requires evidence from that browser or an explicitly
documented manual check. Playwright WebKit is WebKit evidence, not a claim
about every Safari release. Vite's legacy targets are transpilation floors, not
automatic runtime-support evidence.

A support claim means that the same production web artifact passes the
approved core-flow checks on the stated host/browser matrix. It does not mean
that every operating-system version, distribution, device, or browser patch is
certified. Evidence must identify the OS, architecture, browser, version,
channel, viewport, input mode, and whether the check used emulation or a
physical device.

Electron installers, signing, and native release packaging remain deferred.
They are separate compatibility work and are not prerequisites for web
compatibility, web builds, Pages deployment, or web release acceptance.

### 2.6 Browser compatibility versus native packaging

A web compatibility result means that a static web build was loaded and
exercised in a browser on a host operating system. It does not build, sign,
install, or launch an Electron executable and does not exercise an Electron
filesystem bridge.

`package:electron:*`, `electron-builder`, and desktop release workflows are
separate compatibility work. Electron source may remain in the common
typecheck as a source-compatibility check; that typecheck is not Electron
packaging. GitHub-hosted `*-latest` runners are representative test
environments, not exhaustive certification of every OS version or
distribution.

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

### 10.4 Cross-platform web compatibility gate

Cross-platform verification uses a staged matrix so pull requests remain
useful without hiding release risk:

- **Pull-request lanes:** the existing Linux/Chromium viewport matrix, plus
  representative Linux/Firefox, macOS/WebKit, and Windows/Edge smoke lanes.
- **Release lanes:** Linux/Chromium and Firefox; macOS/Chromium, Firefox, and
  WebKit; Windows/Chromium, Firefox, and Edge. The exact browser channels and
  versions are recorded with each run.
- **Manual device evidence:** at least one physical Chromebook with ChromeVox,
  one physical macOS Safari check, one iPad or Android touch-platform
  screen-reader check, one Windows desktop browser check, and one Linux desktop
  check.

Phase 1A establishes the compatibility lanes and evidence format; the physical
checks are completed in the later accessibility, performance, and cutover
phases before a release claim is made. Every automated lane must test the same
production web artifact, or an explicitly
reproducible artifact with recorded hashes. Tests must record OS, architecture,
browser/channel/version, viewport, device scale factor, input mode, and
renderer mode. Synthetic fixtures only are allowed; no learner data, request
body, credential, or private URL may enter reports.

The approved matrix is machine-readable in `tests/e2e/support-matrix.ts` and
drives the Playwright projects in `playwright.config.ts`. The current-build and
cross-engine suites stay separate: `npm run test:e2e` runs the Phase 1
Phaser/axe/privacy suite in the four Chromium viewport projects, and
`npm run test:e2e:compat` builds and records the artifact once before running
`tests/e2e/compatibility.spec.ts` in the four named compatibility projects.
`scripts/web-artifact-manifest.mjs` records and verifies the shared artifact
identity. `.github/workflows/ci.yml` owns the pull-request compatibility lanes
alongside the Phase 1 viewport suite, and
`.github/workflows/compatibility.yml` is restricted to the scheduled and manual
release-candidate lanes so a pull-request run never builds a second artifact.

Viewport and touch emulation are form-factor evidence, not physical-device or
operating-system certification. Playwright WebKit must be labeled WebKit, and
Edge channel runs must be labeled Edge. Native Electron packaging and installer
workflows do not satisfy this web-compatibility gate.

The staged lanes are a quality rail, not a promise that every browser/OS patch
or distribution is certified. Support claims are limited to the documented
matrix and its recorded evidence.

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
Phase 1A Cross-platform web compatibility rails
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
| 0 | complete | Freeze behavior and legacy compatibility fixtures. |
| 1 | complete | Add flags, browser tests, accessibility scaffolding, and quality rails. |
| 1A | complete | Establish Linux, macOS, Windows, and browser-engine compatibility rails. |
| 2 | complete | Extract renderer-neutral application contracts. |
| 3 | complete | Build storage-v2 and migration infrastructure. |
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

**Status:** complete
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
- The maintainer accepted Phase 0 on 2026-09-24, so its status advanced from `verified` to `complete`. At that checkpoint, Phase 1 remained `not-started` until separately requested; its current status is recorded in this plan.

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

**Status:** complete
**Objective:** Introduce safe cutover controls and browser-level test infrastructure while Phaser remains the default.

### Prerequisites

Phase 0 accepted on 2026-09-24.

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

### Verification evidence

Recorded on 2026-09-25:

- `npm ci --ignore-scripts` passed. `npm run lint`, `npm run typecheck`, and `npm test` passed after the clean install; Vitest reported 35 files and 260 tests.
- `npm run test:e2e` passed all 12 tests across `desktop-chromium` (1440x900), `chromebook` (1366x768), `tablet` (834x1112 portrait), and `tablet-landscape` (1112x834 landscape). The exact `chromebook` and `tablet` commands passed 3 tests each, and the explicit `tablet-landscape` command passed 3 tests.
- The production-preview smoke test starts the current synthetic tutorial, verifies a non-zero Phaser canvas, requires the `vendor-phaser` chunk, rejects Pixi script requests, and blocks unexpected network traffic. No analytics, telemetry, remote-configuration, API, upload, WebSocket, or non-static request was observed. Known legacy Google Font requests were blocked and recorded for the Phase 8 font-removal work; no request body, query, header, or learner data was captured.
- Axe runs WCAG 2.0/2.1 A/AA and WCAG 2.2 AA tags on Welcome. No new serious or critical violation was introduced. One pre-existing serious contrast node, `.welcome-checklist-status--done`, remains explicitly recorded for the later accessibility audit.
- `npx tsc -b --dry --verbose` lists `tsconfig.app.json`, `tsconfig.node.json`, and `tsconfig.electron.typecheck.json`; `npm run typecheck` therefore checks application, Node/config, and Electron source intentionally. Electron packaging remains deferred.
- `npm run build:web` and `npm run check:bundle-size` passed. Production `dist` is 4,093,638 bytes across 105 files (3.90 MB), with the existing Phaser chunk retained. `npm run record:build-metadata` passed and recorded 105 files, 1,136,039 summed per-file gzip bytes, and 11 JS/CSS chunks in the ignored `artifacts/build-metadata.json` artifact.
- All valid feature-flag overrides compile. An invalid `VITE_WEB_SHARE=maybe` build fails during Vite configuration with a sanitized error. The nine documented flags default to Phaser, legacy storage, and all future booleans false; each records an owner phase and rollback behavior.
- No storage migration, renderer migration, learner-data change, new media, or deployment occurred. Chromium viewport/touch emulation is not physical-device verification; full accessibility remediation, remote-font removal, performance enforcement, and memory/offline gates remain assigned to their later phases.
- This verified checkpoint intentionally records the current Linux/Chromium baseline only. Broader Linux/macOS/Windows and browser-engine evidence is assigned to Phase 1A and the later release gates.
- The maintainer accepted Phase 1 on 2026-09-25, so its status advanced from `verified` to `complete` and Phase 1A became the next authorized phase.

### Exit criteria

- Current production default still renders Phaser.
- E2E tests do not upload data.
- Every future flag has a default, owner phase, and rollback behavior.
- Typecheck covers the intended projects.

### Rollback

Revert tooling and leave all new flags disabled.

### Unlocks

Phase 1A.

---

## Phase 1A: Cross-Platform Web Compatibility Rails

**Status:** complete
**Objective:** Extend the verified Phase 1 quality rails across representative Linux, macOS, and Windows browser environments without changing the renderer, storage architecture, or learner data model.

### Prerequisites

Phase 1 verified and accepted on 2026-09-25.

### Scope

- Define and document the approved web support matrix, separating host OS, browser engine, branded-browser channel, and form factor.
- Add named Playwright projects for Chromium, Firefox, WebKit, and a Windows Edge channel while preserving the existing Linux/Chromium Chromebook and tablet projects.
- Add a bounded compatibility smoke suite and an explicit `npm run test:e2e:compat` command that uses the production web artifact.
- Add pull-request CI lanes for representative coverage: Linux/Chromium and Firefox, macOS/WebKit, and Windows/Edge.
- Add scheduled or release-candidate lanes for Linux Chromium/Firefox, macOS Chromium/Firefox/WebKit, and Windows Chromium/Firefox/Edge.
- Record OS, architecture, browser/channel/version, viewport, input mode, renderer mode, and artifact identity in sanitized reports.
- Keep the existing current-build Phaser smoke suite separate from the cross-engine compatibility suite.
- Synchronize the README and ADR with the support contract and the verified Phase 1 status.

### Non-goals

- No Pixi implementation or renderer migration.
- No storage migration or persistence behavior change.
- No visual redesign or user-facing compatibility switch.
- No Electron installer, signing, or native packaging requirement.
- No claim that emulation is physical-device or operating-system certification.

### Expected files

- `playwright.config.ts`
- `package.json`
- `package-lock.json`
- `.github/workflows/ci.yml`
- `.github/workflows/compatibility.yml`
- `tests/e2e/compatibility.spec.ts`
- `tests/e2e/support-matrix.ts`
- `docs/plans/001-cozy-pixi-rebuild.md`
- `docs/adr/002-react-dom-pixijs-rebuild.md`
- `README.md`

### Deliverables

- Documented Linux/macOS/Windows and browser-engine support matrix.
- Staged pull-request and release-candidate CI lanes.
- Cross-engine production-artifact smoke reports with no learner data.
- Manual physical-device verification plan for later release gates.
- Synchronized current status and support documentation.

### Verification

```bash
npm run test:e2e:compat
npm run test:e2e
npm run test:e2e -- --project=chromebook
npm run test:e2e -- --project=tablet
npm run test:e2e -- --project=tablet-landscape
```

Run the common gate.

### Implemented design (status is `complete`)

The implementation and all declared Phase 1A exit criteria passed. The maintainer
explicitly accepted the verified checkpoint on 2026-09-25, so Phase 1A is
`complete`. Phase 2 remains `not-started` and requires separate authorization.

- **Machine-readable matrix.** `tests/e2e/support-matrix.ts` is the single source
  for the approved web support dimensions. Host operating system, browser engine,
  branded-browser channel, form factor, viewport, device scale factor, input
  mode, evidence class, and allowed CI lane are separate fields, and every lane
  carries a bounded claim plus an explicit does-not-prove list. Emulation,
  engine builds, branded channels, and physical devices are distinct evidence
  classes. `playwright.config.ts` generates its projects from the matrix, so a
  project cannot drift from the support contract.
- **Named projects.** The four verified Phase 1 projects (`desktop-chromium`,
  `chromebook`, `tablet`, `tablet-landscape`) are preserved with their existing
  viewports, device scale factors, and touch settings and remain bound to
  `currentBuild.spec.ts`. Four compatibility projects were added: `compat-chromium`,
  `compat-firefox`, `compat-webkit` (WebKit engine evidence, not Safari
  certification), and `compat-edge` (Microsoft Edge stable channel, branded-browser
  evidence). Each project is bound to exactly one spec file, so `npm run test:e2e`
  cannot multiply the current-build suite across compatibility projects.
- **Bounded compatibility suite.** `tests/e2e/compatibility.spec.ts` runs through
  `npm run test:e2e:compat` (build, record the artifact identity, then run the four
  compatibility projects) and `npm run test:e2e:compat:recorded` (preview-only,
  used by CI lanes). It uses only the synthetic tutorial subject, the default
  Phaser renderer, static-only network observation, and sanitized evidence.
  `tests/e2e/compat-evidence.ts` reduces every request to bounded categories and
  counts, so headers, query strings, fragments, request bodies, credentials,
  hostnames, ports, and private URLs never reach an observation, an aggregate, a
  failure message, or an evidence record; non-loopback HTTP(S) traffic is blocked
  before it can leave the test browser. Compatibility projects use `trace: 'off'`
  with no failure screenshot or video, and CI compatibility jobs upload only the
  allowlisted sanitized JSON evidence. Each run writes
  `artifacts/compatibility-evidence/<run-id>/<project>--<test>.json` with a run
  identifier shared by every worker of that run, plus `hostExecution`
  (`ci` or `local-host`), `deviceEvidence: emulated`, and `physicalDevice: false`,
  one record per test, per run, and per project, and records the actual host OS
  and architecture, runner image, browser engine/channel/version, project,
  viewport, device scale factor, input mode with observed touch capability,
  renderer mode, evidence classification, and artifact identity. The run
  identifier combines UTC date, seconds, milliseconds, and a short per-process
  discriminator, so two invocations cannot overwrite each other's records.
  `tests/e2e/compat-evidence.test.ts` exercises the failure paths with synthetic
  sentinels in a query, fragment, header, body, credential, and private URL.
- **Honest lane selection.** A lane never reports passing evidence on a host it is
  not approved for: a locally inapplicable lane is explicitly skipped and logged as
  not selected evidence, and the same mismatch fails the lane on a runner. An
  unavailable browser build on an approved host fails the lane instead of producing
  a green run with skipped tests, and the declared host is asserted through
  `KD_COMPAT_EXPECT_HOST`.
- **One artifact per complete CI run.** Playwright only ever previews an existing
  `dist` tree; the package scripts and the single build job in each workflow own
  the build and record steps. `scripts/web-artifact-manifest.mjs` records and
  verifies a deterministic `sha256-tree-v1` identity of the `dist` tree using Node
  built-ins only, and verifies manifest integrity as well: symlinks and special
  files are rejected, a malformed or incomplete manifest is rejected, the recorded
  tree digest is recomputed from the recorded file entries, and the recorded file
  count, byte total, and entrypoint must match those entries before the recomputed
  build is compared with the recorded identity. `verify --json` always returns
  sanitized structured output rather than a raw exception. The suite independently
  re-verifies the tree identity and compares the served `index.html` bytes with
  the recorded manifest entrypoint hash. A clean rebuild with the sprite manifest
  unchanged reproduced the same tree hash, but the current build is not guaranteed
  to be bit-reproducible because `scripts/generate-sprite-manifest.mjs` embeds a
  `generatedAt` timestamp; that is the reason lanes consume one uploaded artifact.
  "One artifact" means one artifact per complete CI run, never one global
  artifact shared across unrelated workflow runs.
- **Staged CI lanes.** Pull-request lanes live in `.github/workflows/ci.yml`, whose
  `web-build` job is the single build, record, and upload point; the Phase 1
  `browser-smoke` viewport suite and the four representative compatibility lanes
  (Linux/Chromium, Linux/Firefox, macOS/WebKit, Windows/Edge) both download that
  same artifact and verify its recorded identity, and neither rebuilds.
  `.github/workflows/compatibility.yml` has no pull-request trigger, so it never
  creates a second artifact in a pull-request run; it builds and records once on a
  weekly schedule and on demand, and its eight release-candidate cells (Linux
  Chromium/Firefox, macOS Chromium/Firefox/WebKit, Windows Chromium/Firefox/Edge)
  download and verify that same artifact. Every browser or compatibility lane job
  prints the runner image and version when GitHub exposes
  `ImageOS`/`ImageVersion`, and the evidence records it along with the actual
  browser, Node, and toolchain versions.
  `tests/e2e/support-matrix.test.ts` parses both workflows and fails if the matrix,
  the Playwright projects, or the lanes disagree, if a lane is missing, if a lane
  job does not depend on its workflow's build job, if any job other than the build
  job runs `build:web`, if a compatibility job uploads anything outside the
  allowlisted evidence path, or if a lane's host, project, or browser install
  mapping is wrong. The authorized merge refreshed the Pages
  `/knowledge-dungeon/` deployment, but these lanes test the `/` preview artifact;
  validating the deployed base path remains a Phase 23 target. No lane builds,
  signs, packages, launches, or downloads the Electron runtime. The
  `electron` package remains an unchanged dev dependency for the deferred desktop
  path, and the Phase 1A web jobs install with `npm ci --ignore-scripts`, which
  skips its postinstall runtime download.
- **Later physical-device gates.** The matrix records the manual gates that no
  automated lane can satisfy: one physical Chromebook with ChromeVox, one physical
  macOS Safari check, one physical iPad or Android touch-platform screen-reader
  check, one physical Windows desktop browser check, and one physical Linux desktop
  browser check. Phase 21 and Phase 23 must complete them before a release claim.

### Known limitations and evidence boundaries

- Automated evidence was collected on GitHub-hosted runner images. It is not
  physical-device, ChromeOS, distribution, GPU, or assistive-technology
  certification.
- Playwright WebKit is engine evidence, not a Safari release, macOS version, or
  iOS claim. The macOS Safari physical check remains a later manual gate.
- The Edge lane is branded-channel evidence for Microsoft Edge
  `154.0.4258.37` on the recorded Windows runner only. It is not evidence for
  other Edge channels, hosts, or Chromium-based browsers.
- The Windows Chromium lane recorded runner image `win25-vs2026`
  `20260907.229.1`, while the Windows Firefox and Edge lanes recorded
  `20260922.246.2`. The evidence preserves the actual difference; the
  `windows-latest` label remains a mutable representative runner, not an
  operating-system certification.
- GitHub reported non-blocking Node.js 20 deprecation annotations for
  `actions/checkout@v4`, `actions/setup-node@v4`, and artifact actions, plus the
  announced `ubuntu-latest` migration beginning 2026-10-19. No Phase 1A job
  failed for either condition. Updating those action/runtime pins is deferred
  infrastructure maintenance rather than new phase scope.
- The physical Chromebook, macOS Safari, touch-platform screen-reader, Windows
  desktop, and Linux desktop checks remain assigned to the later accessibility,
  performance, and cutover phases.

### Verification evidence

Recorded on 2026-09-25:

- The pre-change baseline passed `npm run lint`, `npm run typecheck`, 35 Vitest
  files / 260 tests, `npm run build:web`, `npm run check:bundle-size`, and all 12
  Phase 1 browser tests across the four existing Chromium viewport projects.
- The Phase 1A common gate passed after implementation: `npm run lint`,
  `npm run typecheck`, `npm test` with 38 files / 313 tests, `npm run build:web`,
  and `npm run check:bundle-size` at 4,093,638 bytes across 105 files. The
  production build remains 3.90 MB, and `npm run record:build-metadata` recorded
  1,136,039 summed per-file gzip bytes across 11 JavaScript/CSS chunks.
- `npm run test:e2e:compat` completed with four passing host-applicable tests and
  four explicitly not-selected host-inapplicable tests. Linux Playwright Chromium
  153.0.8010.12 and Firefox 155.0 each passed the artifact-identity and default
  Phaser/static-network checks at 1280x800, DSF 1, pointer/keyboard input. The
  macOS-only WebKit and Windows-only Edge projects produced no local evidence.
- `npm run test:e2e` passed all 12 preserved Phase 1 tests. The explicit
  `chromebook`, `tablet`, and `tablet-landscape` commands each passed three tests.
  The existing single allowed Welcome contrast exception remained the only
  serious automated accessibility finding; no new serious or critical violation
  was introduced.
- The final locally recorded production artifact used
  `sha256-tree-v1:543f0db91677061fb4ca7d85fddcb806f4e5d75cd0404587a73e923a93dcd913`,
  105 files, and 4,093,638 bytes. Its recorded and served `index.html` hashes
  matched. Final preview-only Chromium and Firefox runs passed four tests with no
  static-network violations, no WebSocket attempts, a non-zero Phaser WebGL
  canvas, the Phaser chunk observed, and no Pixi chunk. One known legacy Google
  Font stylesheet request was blocked and recorded only as a sanitized category.
- GitHub Actions PR run `36151192587` for PR #49 passed lint, typecheck, unit tests,
  web build/bundle, the preserved Chromium viewport suite, and all four required
  representative compatibility lanes. Sanitized evidence recorded:
  Linux x64 on Ubuntu 24 with Chromium 153.0.8010.12; Linux x64 with Firefox
  155.0; macOS arm64 on the macOS 26 runner image with Playwright WebKit 26.6;
  and Windows x64 on the Windows runner image with Microsoft Edge 154.0.4258.37.
  Every lane verified and served the same production artifact identity
  `sha256-tree-v1:5322e2e0b1908a770334f1356c2207ec9160c1c93da096b38e56376dd3e8bc69`,
  observed the default Phaser renderer, recorded no network-policy violations or
  WebSocket attempts, and classified the runner as emulated rather than physical.
  WebKit remained engine evidence rather than Safari certification, and the Edge
  user agent contained the expected branded Edge token.
- PR #49 merged as `16a6234a0254eda9f2fa7bff6154bb98baa92694`. Main CI run
  `36154945682` passed every lint, typecheck, unit, build, viewport, and
  representative compatibility job. GitHub Pages deployment run `36154945457`
  succeeded, and the deployed URL returned the expected `Knowledge Dungeon`
  document title.
- Manually dispatched release-candidate run `36155452532` on `main` passed the
  shared-artifact build and all eight cells: Linux Chromium 153.0.8010.12 and
  Firefox 155.0; macOS arm64 Chromium 153.0.8010.12, Firefox 155.0, and WebKit
  26.6; Windows x64 Chromium 153.0.8010.12, Firefox 155.0, and Microsoft Edge
  154.0.4258.37. Every cell verified and served the same production artifact
  identity
  `sha256-tree-v1:654e81ad08e0bd9e6b3e3ef7d45c4219d571a3917735e64d15f0d2e28db666bf`,
  recorded default Phaser rendering with a non-zero canvas, no Pixi chunk, no
  network-policy violations, and no WebSocket attempts.
- Manifest integrity, failure-path privacy, and matrix/workflow contract tests
  passed within the full 313-test suite. The manifest checks cover modified,
  added, removed, renamed, malformed, duplicate, invalid-path, digest, count,
  entrypoint, missing-build, and symlink cases using isolated temporary data.
- No migration, persistence, learner-data, renderer, visual, media, feature-flag,
  or application behavior changed. No dependency, Electron package/installer,
  analytics, telemetry, or upload was introduced. Changes were committed and
  pushed as the explicitly authorized PR #49 checkpoint; PR #49 then merged and
  the explicitly authorized GitHub Pages deployment succeeded.
- **Verification result:** all Phase 1A exit criteria pass. The four representative
  PR lanes and all eight release-candidate cells passed on their declared hosts,
  each complete CI run used and verified one shared production artifact, evidence
  remained sanitized and synthetic-only, and no Electron package or installer was
  required. The maintainer accepted the verified checkpoint on 2026-09-25, so
  Phase 1A is `complete`.

### Exit criteria

- The existing Linux/Chromium viewport projects continue to pass.
- Every required representative pull-request compatibility lane passes.
- The full approved release matrix is defined, reproducible, and recorded.
- Compatibility results use the same production artifact or documented reproducible hashes.
- Emulation, browser-engine, branded-browser, and physical-device evidence are clearly distinguished.
- No Electron package or installer is required for the web result.

### Rollback

Remove the additional browser projects and CI lanes while retaining the existing Phase 1 Chromium smoke. Feature-flag defaults, production behavior, and learner data remain unchanged.

### Unlocks

Phase 2.

---

## Phase 2: Renderer-Neutral Application Contracts

**Status:** complete
**Objective:** Move learning-flow orchestration out of `GameScreen`, `VillageScreen`, and Phaser scenes.

### Prerequisites

Phase 1A accepted.

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

### Known limitations and evidence boundaries

- This is a refactor and contract phase. It produced no new runtime behavior, so
  it adds no new device, accessibility, performance, privacy, or license gate
  of its own; the preserved Phase 1 and Phase 1A gates remain the evidence.
- Automated evidence was collected on Linux with Playwright Chromium across
  the four existing viewport projects. It is not physical-device, macOS,
  Windows, WebKit, Edge, GPU, or assistive-technology evidence, and no new
  compatibility claim is made here.
- Renderer neutral is proven mechanically for `src/core/` and
  `src/application/`, and for `src/ui/`, which now names no engine type. The
  Phaser scenes still reach outward into `@/ui/utils/editableElement`,
  `@/services/customSprites`, and `@/services/audioManager`; that coupling is
  pre-existing and is not a core or application layer import.
- Archetype content (`PLAYER_CLASSES`, `getPlayerSpritePath`) is still declared
  in `src/game/systems/playerClasses.ts` and imported by the UI and the session
  store. It imports no renderer, so the boundary rule is satisfied, but the
  `PlayerClassId` union is mirrored into the contract with a compile-time
  parity guard rather than being moved.
- `FishingWorldModel.subjectId` is carried but not yet authoritative;
  `handleKeepFish` still resolves the subject from progression-store key order.
- `createWorldEventSink` is part of the contract but is not yet adopted by the
  Phaser host, which calls the projected scene callbacks directly.
- The adapter filenames contain the string `phaser`, so the existing
  `manualChunks` rule (`id.includes('phaser')`) routes them into the
  `vendor-phaser` chunk. That is why the index chunk fell from 438.30 kB to
  341.83 kB while the Phaser chunk rose from 1,199.71 kB to 1,303.19 kB. It is
  harmless while Phaser is the eagerly loaded default, and Phase 9 should
  revisit the chunk rule when a second renderer exists.

### Verification evidence

Recorded on 2026-09-25:

- The pre-change baseline passed `npm run lint`, `npm run typecheck`, 38 Vitest
  files / 313 tests, `npm run build:web`, `npm run check:bundle-size` at
  4,093,638 bytes across 105 files, and all 12 Phase 1 browser tests.
- The Phase 2 common gate passed after implementation: `npm run lint`,
  `npm run typecheck`, `npm test` with 43 files / 448 tests, `npm run
  build:web`, and `npm run check:bundle-size` at 3.92 MB across 105 files. The
  exact production total is 4,107,377 bytes, a +13,739-byte (+0.34%) delta
  against the 4,093,638-byte baseline, with the file count unchanged. The
  `vendor-phaser` chunk is still emitted.
- `npm run test:contracts` passed 7 files / 155 tests, up from the 2 files /
  20 tests the script inherited. `npm run test:e2e` passed all 12 preserved
  tests across `desktop-chromium` (1440x900), `chromebook` (1366x768),
  `tablet` (834x1112 portrait), and `tablet-landscape` (1112x834 landscape),
  including the real-Phaser-canvas and static-only-network assertions and the
  axe WCAG 2.2 AA scan. The single recorded pre-existing Welcome contrast
  exception remained the only allowed serious finding; no new serious or
  critical violation was introduced.
- **Exit criterion 1 — no Phaser or Pixi imports in core or application.**
  `rg -n "from '(phaser|pixi\.js)|@pixi/|from '@/game/" src/core src/application`
  returns no matches. `eslint.config.js` now carries a
  `no-restricted-imports` boundary block for `src/core/**` and
  `src/application/**` forbidding `phaser`, `phaser/**`, `pixi.js`,
  `pixi.js/**`, `@pixi/*`, `@pixi/**`, `@/game`, `@/game/*`, `@/game/**`,
  `**/../game`, and `**/../game/**`, including type-only imports. The rule was
  proven to fire for a value import, a type-only import, and a nested `.tsx`
  probe in both layers before the probes were deleted, and the resolved ESLint
  config for `src/game/**`, `src/ui/**`, `src/store/**`, `src/services/**`,
  `tests/**`, and the JS block is unchanged. A non-lint test gate in
  `tests/contracts/phase-2-import-boundary.test.ts` fails independently of
  ESLint and carries a positive control proving its detector works.
- **Exit criterion 2 — user-visible behavior unchanged.** The learning flow
  moved out of `GameScreen` and `VillageScreen` into
  `src/application/studyFlow.ts` with every side effect injected; `createGame`
  and `createVillageGame` now return a renderer adapter instead of a
  `Phaser.Game`. Rendered markup, class names, aria labels, toast copy, scene
  options, input, camera, art, and timing are unchanged. 135 new contract
  tests pin the extracted behavior against the pre-refactor code, including the
  verbatim toast strings, the floor-change fallbacks, the teleport cooldown
  gate, the return-to-village ordering, every village structure route, and the
  fishing mount guard. Manual Chromium checks against the preview build drove
  the real dungeon canvas, a floor change through the map view, the village
  compass and fishing-pond panel, and a full fishing round trip with no page or
  console errors.
- **Exit criterion 3 — Phaser replaceable solely through an adapter.** The
  neutral contract lives in `src/application/contracts/`
  (`world.ts`, `events.ts`, `commands.ts`, `renderer.ts`), the three world
  models and the `WorldRenderer` lifecycle plus the dungeon, village, and
  fishing capability ports are bound by `src/game/adapters/`, and every
  `Phaser.*` token in `src/` is now inside `src/game/**`.
  `rg -n "from 'phaser'|@pixi/" src/ui` returns no matches. A future Pixi host
  would add adapter modules beside the Phaser ones and swap the two
  `createGame*` seams. The `onReady` readiness subscription the screens use is
  an adapter addition beyond the published `WorldRenderer.isReady()` poll; if
  a Pixi host needs it, the contract should absorb it.
- **Deliverable: single subject activation.** `src/application/subjectActivation.ts`
  is the only implementation; `useLoadSubjectFlow` is a thin wrapper, and the
  two village paths that previously inlined `loadSubject` plus separate store
  writes now route through it. The training-gate path now also sets the
  progression active subject at activation time where it previously relied on a
  `GameScreen` mount effect; the value, the persisted result, and the resulting
  user-visible state are identical because the write is the same id and
  idempotent. `App.tsx` boot hydration is a deliberate load-then-clear and was
  not converted.
- **Deliverable: compatibility re-exports.** `src/game/systems/dungeonGenerator.ts`,
  `dungeonTypes.ts`, `bossRooms.ts`, `fishingTypes.ts`, and `fishingMechanics.ts`
  remain as `export *` shims onto their `src/core` originals, asserted by
  identity rather than by re-reading values. The moved modules are
  byte-equivalent to `HEAD` apart from import paths and header comments, and the
  biome split leaves the palette, seed string, tile size, and draw order intact
  so a generated floor texture stays pixel-identical.
- **Renderer-neutral domain code relocated.** Dungeon layout moved to
  `src/core/layout/`, fishing catalog, mechanics, and collection to
  `src/core/fishing/`, and the biome data to `src/core/biomes/`; the Phaser
  drawing of `ensureBiomeFloorTexture` stayed on the renderer side.
- Two review findings were returned to the implementer and fixed before
  verification. The compile-time parity guards originally resolved to `never`,
  which is a legal declaration and enforced nothing; they now use a
  constrained `AssertTrue<...>` form and fail `tsc` at the guard itself. The
  fishing enter path originally cleared village UI state before the
  world-mounted guard; the guard now runs first, restoring the pre-refactor
  behavior for both the Phaser structure branch and the Cast Line button.
- One defect was found by the contract-test gate and fixed: three first-party
  scene imports still resolved the moved modules through the compatibility
  shims instead of `src/core`. The import-path-only change is behavior-neutral.
- No migration, storage, schema, or legacy key was touched; legacy keys remain
  byte-for-byte unmodified. No dependency was added. No analytics, telemetry,
  upload, sync, or new network call was introduced, and the e2e static-network
  assertion still passes. No learner data appears in any fixture, test, log, or
  new file: every Phase 2 test fixture is synthetic and self-describing, and the
  only URL used is the reserved `example.invalid` host. No new image,
  animation, sound, music, or font was added, so the CC0 media gate is not
  triggered in this phase. The change was then committed and merged as the
  explicitly authorized checkpoint below.
- **Verification result:** all three Phase 2 exit criteria pass. The renderer
  boundary is mechanically enforced and proven to bite, the extracted
  behavior is pinned by 135 new contract tests plus the preserved 313 unit
  tests, and Phaser is now reachable only through `src/game/adapters/` and the
  two `createGame*` seams. The maintainer accepted the verified checkpoint and
  the rollback deviation on 2026-09-25, so Phase 2 is `complete`.
- **Rollback deviation, accepted.** The written rollback says "disable
  the new controller and return to the current screen orchestration." No
  runtime flag was added, so the controller is unconditional and the rollback
  is a source revert. A runtime toggle would require keeping the old inline
  orchestration and the new controller in the tree indefinitely, which is the
  duplication the contract tests exist to remove. The phase is
  behavior-preserving and fully test-covered, so a revert is the complete
  rollback. The maintainer accepted this deviation on 2026-09-25. If a runtime
  toggle is wanted later, it is its own scoped change and must not reintroduce
  the duplicated orchestration.
- **Checkpoint and merge evidence.** Commit `b0b4103` (`refactor: add phase 2
  renderer-neutral application contracts`) was pushed to `phase-2-contracts` and
  merged as pull request #51. Pull-request run `36172422237` passed all nine
  jobs: Lint, Typecheck, Unit Tests, Web Build and Bundle, Browser Smoke
  (Chromium Matrix), and all four representative compatibility lanes
  (`pr-linux-chromium`, `pr-linux-firefox`, `pr-macos-webkit`,
  `pr-windows-edge`). PR #51 merged as `7fa042b`. Main CI run `36173015528`
  then passed the same nine jobs, and GitHub Pages deployment run
  `36173015515` succeeded; the deployed URL returned HTTP 200 with the expected
  `Knowledge Dungeon` document title. The compatibility lanes continue to
  describe GitHub-hosted runner images as emulated, representative, and
  synthetic; no new browser, host, device, or assistive-technology claim was
  made, and the physical-device gates remain assigned to the later phases.
  Rollback is now `git revert 7fa042b`, or a reset to the Phase 1A checkpoint
  `d69579c`. Four untracked local files, `.opencode/ocv-debug.log`,
  `.opencode/opencode.json`, `.opencode/tui.json`, and
  `.opencode/viz-skin.json`, are session tool and plugin configuration and were
  deliberately excluded from the commit; the tracked `.opencode/agents/*.md`
  specialist definitions remain in the repository.
- **Post-merge CI defect, found and fixed.** The first main-branch run after the
  merge, `36174106655`, failed Unit Tests on
  `tests/unit/FishStandPanel.test.tsx` with a missing `(Deleted Subject)` node.
  The cause is a pre-existing race, not the phase change: that test waited for
  `listSubjectIds` to have been **called** and then asserted synchronously on
  text that only appears after the promise resolves and the component
  re-renders. A slower runner lost that window. It is reproducible by deferring
  the mocked resolution by a few milliseconds and does not reproduce locally,
  which is why it passed pull-request run `36172422237` and the earlier main
  runs. The test now waits for the rendered output, matching the wait the
  sibling test in the same file already used; both original assertions are
  preserved and no assertion was weakened. The fix was verified to hold under
  the same deferral that reproduced the failure, and the full 448-test suite
  passed three consecutive local runs. The same anti-pattern remains in the
  file's empty-state test, where it is currently not reachable because that
  branch renders before the load resolves; it is a follow-up candidate, not a
  failure.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-09-25. The status advanced from `verified` to `complete` on
2026-09-25, when the maintainer accepted the verified checkpoint. Phase 4
remains `not-started` and requires separate authorization.

#### What was built

- **Archive dependency.** `fflate` `^0.8.3` (MIT, zero dependencies) is the
  runtime ZIP library; `fake-indexeddb` `^6.2.5` (Apache-2.0) is the test-only
  IndexedDB shim, because `jsdom` implements no IndexedDB. The selection, the
  measured size, the license URLs, and the rejected `jszip` and `client-zip`
  candidates are recorded in the "Phase 3 archive dependency selection" section
  of ADR `002`. `jszip` was rejected for a dual `MIT OR GPL-3.0-or-later`
  identifier, four stale dependencies, ~8x the tree-shaken size, and a
  `new Function` in its shipped bundle; `client-zip` is write-only and cannot
  read a learner-picked archive.
- **Storage-v2 tree**, `src/services/persistence/v2/` (~5.9k lines, unreferenced
  by the app graph): `schema.ts` (store names, the three separate version
  constants, report models), `database.ts` (open/upgrade, `meta` pointer, clock
  and id injection), `repository.ts` (transactional stage/validate/activate/
  rollback/prune), `validation.ts` (per-record validators plus relationship
  checks with `error`/`warning` severity), `migrations.ts` (plan §7.2 sequence,
  receipts, activation, rollback), `legacyReader.ts` (read-only, closed key
  allowlist), `archive.ts` (`fflate/browser` with zip-slip, member, byte, and
  ratio defenses), `checksum.ts` (canonical JSON plus pure-TypeScript SHA-256).
- **Renderer-neutral core**: `src/core/validation/persistence/subjectValidation.ts`
  and `subjectMigration.ts` (one transform, explicit unknown-field policy),
  `src/core/progression/canonicalProgression.ts` (the single canonical
  progression), `src/core/fishing/fishingContext.ts` (canonical fish entry and
  explicit fishing context). `subjectPersistence.ts` and `progressionStore.ts`
  were refactored onto these with no change to their exported API or observable
  behavior.
- **Legacy key allowlist**: 22 entries derived from the Phase 0 inventory,
  exported as `LEGACY_STORAGE_KEY_ALLOWLIST`, with `LEGACY_KEY_EXCLUSIONS`
  documenting three deliberate refusals — the test-only
  `knowledge-dungeon:subjects:index` spelling, and the `kd-subject*` keys that
  belong to `scripts/capture-screenshots.mjs` rather than production source.
  The reader is structurally read-only: it takes a `ReadOnlyLegacyStorage` and
  the tests trap every mutating `Storage` method.
- **Migration report and external-only attachment report**: codes, counts,
  severity, version identifiers, opaque ids, and checksums only. No filename,
  URL, subject name, topic, or note appears in either.
- **`npm run test:migrations`** was added as `vitest run tests/migrations`. The
  suite is 12 files / 296 tests.

#### Defects found in review and fixed before verification

The implementation was reviewed twice by `qa-engineer` and once by the
orchestrator, all against the actual diff and real execution rather than
completion claims. Six defects were found and fixed:

1. **The live legacy progression key received a wrong `subjectId`.**
   `cloneDefaultSubjectProgression` returned a record carrying
   `subjectId: '__legacy__'`, so every subject with no stored record was written
   with a foreign id inside its own record. Confirmed by running the real store.
2. **The default write path's persisted shape changed.** `savePersistedBySubject`
   had begun serializing through the canonical serializer, so
   `knowledge-dungeon:v1:progression` gained `kind`, `sourceVersion`,
   `activeSubjectId`, `legacyBucketSubjectId`, and an `extraFields` wrapper. That
   would have broken the phase's "source revert of unreferenced code" rollback
   and encroached on Phase 4's dual-write deliverable. The legacy mirror now
   writes the exact pre-phase v3 shape.
3. **`sha256Hex` was not SHA-256 for input lengths ≡ 55 (mod 64).** The padding
   expression added a spare 64-byte block, producing a valid digest of a
   different message. An independent 0–200 byte sweep against `node:crypto`
   diverged at 55, 119, and 183. This affected every record checksum, the
   generation `contentChecksum`, receipt checksums, attachment `contentHash`,
   and the session `eventId` — and would have invalidated the plan §7.3
   `attachments/<sha256>` contract. **The gate was green anyway**: the boundary
   test asserted only the `/^[0-9a-f]{64}$/` shape, and the Web Crypto
   cross-check used four inputs that all dodged the broken lengths. Fixed to
   `Math.ceil((len + 9) / 64) * 64`; an independent 0–1000 byte sweep is now
   clean and the published NIST vectors for `""` and `"abc"` match.
4. **The store and the migration did not produce one canonical progression.** The
   migration passed `createId: () => 'migrated-unknown'`, which ignored the
   prefix and collapsed every unidentified loot and gear item onto a single id.
   The existing comparison test could not see this because it handed the
   store's id factory to the migration's normalizer. Fixed to a prefix-honouring
   per-run counter, with a test that compares the **persisted** migration records
   to the store's own hydration for all six progression fixtures.
5. **Five gates passed vacuously** and were repaired: a stage-order test compared
   an exported constant to a copy of itself; a "no mutating storage method" test
   handed the migration the trap storage so it never held the real
   `localStorage`; a fixture constant aliased another constant; a
   store↔migration comparison shared an id factory; and two tests named
   "idempotently" each opened a second *fresh* database, which proves
   determinism rather than idempotency.
6. **`deleteRecords` over-reported `removed`**, adding `subjects.length` on top
   of a count that already included it, so the value was inflated by the
   generation's entire subject count and was non-zero for a no-op delete.

Two further items from QA's list were fixed in the same pass: re-running a
migration with an already-active `generationId` is now a no-op success rather
than a false recovery report; an abandoned `staged` generation is reclaimed on
the next run of the same migration; `putRecords`, `deleteRecords`, and
`writeMigrationReceipt` commit data and the `meta` descriptor in one
transaction; and a failure inside staging now reports `stage-records` instead of
the previous stage.

#### Declared default-behavior change requiring maintainer sign-off

The legacy `knowledge-dungeon:v1:progression` write now **preserves unknown
app-owned fields**, where the pre-phase build dropped them on every rewrite.
This is additive and a pre-phase reader ignores the extra keys, but it is a real,
permanent difference in the learner's progression file. It is required by plan
§7.3 ("must preserve unknown app-owned fields") and by the known defect that
current normalization drops unknown fields, so it is kept deliberately rather
than reverted. QA measured it against a clean `git worktree` of the pre-phase
`HEAD` across six scenarios: three are byte-identical (fresh subject, room clear,
v2 hydration) and two differ **only** by the preserved fields
(`legacyOnlyField`; `qaUnknownField` and `anotherUnknown`). A representative
fresh-subject payload is byte-identical:
`{"version":3,"bySubject":{"subject-qa-fresh":{"xpTotal":0,"rank":"Novice","badges":[],"inventory":[],"equippedItems":[],"collectedNotes":[],"streakCount":0,"subjectsMastered":0,"roomsCleared":0,"reviewPasses":0,"artifacts":0,"bossesDefeated":0,"fishCollection":[]}},"crossSubjectAchievements":[]}`.
`tests/migrations/qaLegacyByteComparison.test.ts` pins all six cases.

#### Commands run and results

Pre-change baseline, then the phase gate, then an independent orchestrator
re-run of the whole gate:

| Command | Result |
| --- | --- |
| `npm run lint` | pass, 0 errors 0 warnings |
| `npm run typecheck` | pass |
| `npm test` | pass — 55 files / 744 tests (baseline 43 / 448) |
| `npm run test:migrations` | pass — 12 files / 296 tests |
| `npm test -- tests/unit/subjectPersistence.test.ts` | pass — 1 file / 4 tests |
| `npm test -- tests/unit/fishCollectionService.test.ts` | pass — 1 file / 22 tests |
| `npm test -- tests/contracts` | pass — 7 files / 155 tests |
| `npm run build:web` | pass |
| `npm run check:bundle-size` | pass — `Total dist size: 3.92 MB across 105 files` |
| `npx playwright test tests/e2e/currentBuild.spec.ts` | pass — 12 tests across the four Chromium viewport projects |

The orchestrator ran `lint`, `typecheck`, `test`, `test:migrations`, both focused
suites, `build:web`, and `check:bundle-size` as one chain with exit code 0.

#### Exit-criteria evidence

- **Legacy fixtures migrate idempotently.** All six progression fixtures and all
  five valid subject fixtures migrate. Re-running the same `generationId` after
  activation is a no-op success that does not re-stage, does not steal the
  pointer from a newer generation, and leaves records, descriptor, and receipt
  byte-identical. Different-id and triple runs hold, and the previously active
  generation is retained as `superseded`. The injected `generationId` and `now`
  are the documented non-idempotent axes; with a fixed clock the generated ids
  and payload bytes are stable. The generation `contentChecksum` is a function
  of the injected clock rather than of the source data, because SM-2 defaults,
  recovery capture times, preference timestamps, and assistance timestamps are
  all stamped with it; the underlying legacy payload bytes are identical across
  runs at different times. That is a disclosed limitation, not a data risk.
- **A failed staged transaction leaves the active generation unchanged.** All six
  repository-level failure points were injected independently, and each leaves
  the `activeGeneration` pointer unflipped, **zero** records across all ten
  generation-scoped stores (verified by raw `getAllKeys`, not through the
  repository's own read API), an absent descriptor, a byte-identical previous
  generation, and a subsequent migration that still succeeds. `stageGeneration`
  is a single transaction spanning all eleven stores; QA mutation-proved the
  assertion bites by splitting it back into two.
- **Legacy keys remain byte-for-byte untouched.** A byte-exact comparison over
  the real `window.localStorage` (every key, exact string, insertion order, and
  absence of new keys) across a full migration, seeded with corrupt JSON, an
  empty value, a surrogate-pair value, both quarantine families, a v1 flat
  payload, and a ghost index entry. A storage that throws on every mutating
  method, and a spy on the actual `Storage` object's `setItem`/`removeItem`/
  `clear`, both record zero calls. Re-verified across a failed-then-successful
  run that exercises the new discard write path.
- **Progression and fish have one canonical representation.** The migration
  persists exactly what the store hydrates for all six progression fixtures, with
  generated ids that are prefix-correct and unique within a record. Fish catalog
  identity survives deserialize → canonicalize → round trip; `resolveFishCatalogId`
  was attacked with case-only names, surrounding and non-ASCII whitespace, a
  `catalogId` that disagrees with the name, an id with no separator, a separator
  at position 0, an empty name, names that slugify to empty, and an unknown fish,
  and is deterministic and idempotent in every case. The legacy `FishEntry` stays
  constructible without a `catalogId` so every existing producer and fixture is
  unaffected.

#### Gates confirmed beyond the exit criteria

- **Privacy.** A distinctive synthetic marker was planted as the subject name,
  room topic, note body, attachment filename, and alt text. It never appears in
  `MigrationReport`, `externalOnlyAttachments`, `LegacyReadReport`,
  `MigrationReceiptValue`, `GenerationDescriptor`, `ValidationProblem`,
  `report.recovery`, or `validateGenerationRecords` output. Exact key sets are
  asserted per report, not merely absence of the marker. Recorded limitation:
  `StorageV2Error.details` accepts a string, so `toReport()` is safe because
  every current call site passes only codes, counts, and ids — not because the
  type prevents a future leak. A stricter code map is a Phase 4 hardening item.
- **Renderer boundary.** The Phase 2 `no-restricted-imports` rule was extended to
  `src/services/persistence/v2/**`. It was proven to bite twice with planted
  probes (a `phaser` value import and a relative `../../../../game/createGame`),
  both detected and then deleted, so the gate cannot be reported as vacuously
  green. `src/core/{fishing,progression,validation}` import nothing from
  `src/ui`, `src/store`, `src/services`, or `src/game`.
- **Not in the app graph.** An independent breadth-first walk from
  `src/main.tsx` (84 modules visited) reaches zero storage-v2 modules, and no
  file under `src/` outside the v2 tree imports one. `fflate` is imported by
  exactly one file, `archive.ts`, via the explicit `fflate/browser` subpath the
  ADR records as necessary. The built `dist` contains zero occurrences of twelve
  storage-v2 and `fflate` markers, including `discardStagedGeneration`,
  `recomputeDescriptor`, and `mergeEnvelopes`. `DEFAULT_RUNTIME_CONFIG`
  `storageRepository` is still `'legacy'` and the `vendor-phaser` chunk is still
  emitted.
- **Determinism.** Fake timers restricted to `Date`, a `Math.random` spy, and a
  `fetch` stub that throws all record zero consultations across a full migration;
  moving the system clock 32 years between two runs produced byte-identical
  records; a static scan of all nine modules found no clock, randomness, or
  network use. Note for future maintainers: `vi.useFakeTimers()` **without**
  `toFake: ['Date']` deadlocks any test touching `fake-indexeddb`.
- **Hostile archives.** Independently attacked with zip-slip (`../`, `a/../../`,
  a deep traversal) on both write and a raw-`fflate`-built archive, absolute and
  UNC and drive-letter paths, backslash separators in three spellings, control
  characters, an over-long path, `.`, an empty name, duplicates, five
  `Object.prototype` names, member-count overflow, a 4 MiB ratio bomb rejected
  three ways, zero-length and non-UTF-8 members, six truncation fractions, random
  bytes, and a bare end-of-central-directory record. Every hostile input is
  rejected with a typed error, and a two-member archive whose second member
  escapes the root yields no partial extraction.
- **E2E unchanged.** The 12-test current-build suite still passes across
  `desktop-chromium`, `chromebook`, `tablet`, and `tablet-landscape`, including
  the non-zero Phaser canvas assertion, the static-only network assertion, and
  the axe WCAG 2.2 AA scan with the single pre-existing Welcome contrast
  exception still the only allowed serious finding. No new network, upload,
  analytics, or telemetry path was introduced.

#### Performance and bundle result

`dist` is **4,111,129 bytes across 105 files**, against the 4,107,377-byte Phase
2 baseline: **+3,752 bytes (+0.09%)** with the file count unchanged. The delta is
entirely in `index.js` (+2,463) and `index-legacy.js` (+1,289) and comes from
the three new core modules the phase mandates — `canonicalProgression.ts`,
`subjectValidation.ts`, and `subjectMigration.ts` — replacing the in-store
normalizers. Tree-shaking is working: the storage-v2-only serializer and the
migration half of the subject validator are provably absent from the bundle.
This is a declared new baseline. It sits far below the plan §10.2 raw `dist`
ceiling of 12 MB and far below the 300 KB gzip Welcome budget (the `index` chunk
is 97.57 kB gzip), and the figure is a **pre-cutover** measurement, not a
prediction of Phase 4, where the v2 tree and `fflate` enter the app graph for
the first time. Accessibility, memory, and offline results are unchanged: this
phase adds no user-facing surface, so the Phase 1 and Phase 1A gates remain the
evidence.

#### Known limitations and evidence boundaries

- All storage-v2 tests run on `fake-indexeddb` under `jsdom`. Real-browser
  IndexedDB transaction semantics, cross-tab concurrent migration,
  `versionchange`/`blocked` upgrade behavior, quota exhaustion during staging,
  and per-origin `localStorage` key ordering are all unverified. `fake-indexeddb`
  is single-threaded and more forgiving about transaction auto-commit than
  Chrome, Firefox, or WebKit. `pruneGenerations` issues `store.delete()` inside a
  `getAllKeys` `onsuccess` handler, which is the spec-correct pattern but is not
  browser-verified. These need Playwright evidence against the real build.
- Automated evidence is Linux with Playwright Chromium across the four existing
  viewport projects. No new browser, host, device, or assistive-technology claim
  is made, and the physical-device gates stay assigned to Phases 21 and 23.
- `archive.ts` is a codec only. It does not define the `.kdbak` or `.kdsubject`
  member layout, the `manifest.json` schema, import semantics, or identifier
  remapping; `DataProductManifest` is declared but unused. Phases 5–7 own those.
- The `attachments` store uses `meta:` / `blob:` record-id prefixes in one store
  rather than a second store, because the plan fixes the store list.
- **Deferred to Phase 4** (found, recorded, deliberately not fixed here):
  migration-report problems tagged `severity: 'error'` do not block activation,
  so either the severity naming or the blocking rule is misleading;
  `ProgressionRecordValue` writes one record per subject and copies the full
  `crossSubjectAchievements` array into each; `onStage` and
  `forceValidationFailure` are test seams living in production code paths;
  `discardStagedGeneration` has no "abandoned orphan" concept and its status
  check is not in the same transaction as its deletes, which is safe single-tab
  and unsafe cross-tab; the same-`generationId` no-op can report `migrated` with
  `activated: false` for a generation that is still only `staged`, so a caller
  reading only `status` could conclude a device is migrated when its data is
  unreachable; `stageGeneration` only upserts, so a direct repository caller
  re-staging with a subset leaves a stale record (the migration discards first,
  so the migration path is unaffected); `describeUnsafeArchivePath('.')` accepts
  the extraction root; `writeArchive` reports an `Object.prototype` member name
  as a duplicate (use `Object.hasOwn`); legitimate ZIP directory entries such as
  `attachments/` are rejected as `empty-segment`, so a `.kdbak` written by
  another tool would fail to import; `progressionSourceVersions` is hard-coded to
  `1` regardless of record count; the per-subject `ProgressionRecordValue` is
  not a fixed point of the canonical normalizer, and
  `validateProgressionRecord`'s normalizer call discards its result;
  `LegacyKeyReport.keyId` embeds the subject id for dynamic key families, which
  is clean in `MigrationReport` today but would leak a subject name in a
  log-safe report if a `dungeonId` were ever slug-derived from a subject title;
  and `subjectPersistence.migrateToV11` now takes one `nowIso` for the document
  where the pre-phase code re-read the clock per room.
- No migration was run against real learner data and no learner data exists
  anywhere in the new code, fixtures, reports, or tests. Every fixture is
  synthetic and self-describing; the only URL is the reserved `example.invalid`
  host.
- No user-facing behavior, route, or rendered markup changed. The one declared
  exception is the unknown-field preservation described above.

#### Files

Created: `src/services/persistence/v2/{schema,database,repository,validation,migrations,legacyReader,archive,checksum}.ts`,
`src/core/validation/persistence/{subjectValidation,subjectMigration}.ts`,
`src/core/progression/canonicalProgression.ts`, `src/core/fishing/fishingContext.ts`,
`tests/migrations/` (12 files + a support helper).
Modified: `src/services/persistence/subjectPersistence.ts`,
`src/store/progressionStore.ts`, `src/core/fishing/{fishingTypes,fishCollectionService}.ts`,
`src/core/validation/persistence/{index,types}.ts`, `eslint.config.js`,
`package.json`, `package-lock.json`, `docs/adr/002-react-dom-pixijs-rebuild.md`.
Test-only additions: `fflate` and `fake-indexeddb` dependencies, and the
`test:migrations` script.

#### Rollback

Disable the unreferenced storage-v2 implementation. Nothing in the app graph
imports `src/services/persistence/v2/**`, so the rollback is a source revert of
`schema.ts`, `database.ts`, `repository.ts`, `validation.ts`, `migrations.ts`,
`legacyReader.ts`, `archive.ts`, and `checksum.ts`, the
`tests/migrations/` suite, and the `test:migrations` script. The three
renderer-neutral core modules and the two behavior-preserving refactors stay: the
live legacy key keeps the pre-phase v3 shape, `VITE_STORAGE_REPOSITORY` remains
`'legacy'`, and no data is touched. Reverting the core modules as well would
return `subjectPersistence.ts` and `progressionStore.ts` to their pre-phase
in-file normalizers, which is the complete rollback for the whole phase.

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
**Objective:** Prove the entire application is operable across the approved web OS/browser/device matrix, including Chromebook and tablet, without canvas-only behavior.

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
- Run the approved web compatibility smoke on Linux, macOS, and Windows across representative Chromium, Firefox, WebKit, and Edge lanes.
- Run accessibility checks on at least one Chromium and one non-Chromium lane for each supported OS family.
- Keep viewport/touch emulation distinct from physical Chromebook, tablet, desktop, and operating-system verification.
- Record actual Safari, Edge, ChromeVox, and touch-screen-reader evidence separately from automated Playwright evidence.

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
- `tests/e2e/compatibility.spec.ts`

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
npm run test:e2e:compat
npm run test:e2e -- --project=chromebook
npm run test:e2e -- --project=tablet
npm run test:e2e -- --project=tablet-landscape
```

Run the common gate.

### Exit criteria

- Zero serious or critical automated accessibility violations.
- The complete learning path works through DOM controls and keyboard.
- Touch use does not depend on hover or precision gestures.
- Core layouts work at 200% zoom and a 320 CSS-pixel viewport.
- Reduced-motion mode has no continuous decorative movement.
- ChromeVox and the selected touch screen-reader script pass.
- Every required OS/browser compatibility cell passes the core-flow smoke.
- The full learning path remains keyboard- and DOM-operable in the selected accessibility cells.
- Viewport emulation is not reported as physical Chromebook or tablet verification.
- Actual Safari, Edge, ChromeVox, and touch-screen-reader evidence is clearly distinguished from automated Playwright evidence.

### Rollback

Revert individual accessibility fixes. No renderer or storage rollback is required.

### Unlocks

Phase 22.

---

## Phase 22: Performance, Memory, and Offline Hardening

**Status:** not-started
**Objective:** Meet the performance budgets while preserving local-first offline behavior across the approved web OS/browser matrix.

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
- Run route-load, memory, and offline-shell smoke across the approved OS/browser matrix using the same production artifact.
- Add service-worker-enabled compatibility projects without globally relaxing the privacy network policy.
- Run expensive frame-time and memory measurements on declared reference environments, with browser, OS, hardware, and GPU information recorded.
- Report browser/OS differences as measurements rather than hiding them behind one desktop benchmark.

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
- `tests/e2e/compatibility.spec.ts`
- `tests/e2e/offline.spec.ts`
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
npm run test:e2e:compat
npm run test:e2e:offline
```

Run the common gate.

### Exit criteria

- Welcome and each lazy route meet transfer budgets.
- The 100-room dungeon meets the frame-time target.
- Repeated mount and unmount shows no material canvas or GPU growth.
- A previously loaded app reloads offline with local data intact.
- Static caches update without serving mixed-version assets.
- Service-worker inspection confirms no learner data is cached.
- The approved OS/browser matrix passes route-load and offline-shell checks.
- Reference performance measurements record the browser, OS, hardware, and GPU environment.
- Browser and OS differences are reported with measurements rather than hidden behind a single desktop benchmark.

### Rollback

Revert the implementation while retaining performance tests and budgets.

### Unlocks

Phase 23.

---

## Phase 23: Production Cutover and Soak

**Status:** not-started
**Objective:** Make Pixi, Cozy visuals, storage-v2, data products, assistance, and Web Share the defaults with a tested rollback across the approved web OS/browser matrix.

### Prerequisites

Phase 22 accepted.

All accessibility, performance, migration, backup, and CC0 gates pass.

Phase 1A compatibility rails and the approved OS/browser matrix pass.

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
- Run the approved Linux/macOS/Windows browser matrix against the production Pages artifact and its base path.
- Repeat critical default and rollback flows on the physical device set defined by the compatibility contract.
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
- `docs/adr/002-react-dom-pixijs-rebuild.md`
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
npm run test:e2e:compat
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
- The production Pages artifact passes the approved Linux/macOS/Windows browser matrix.
- Physical-device checks cover the required Chromebook, touch-platform, macOS/Safari, Windows, and Linux representative set.
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
- [ ] The approved Linux, macOS, and Windows web support matrix passes on the production artifact.
- [ ] Chromium, Firefox, WebKit, Edge, and Safari evidence is labeled by actual browser/channel and not inferred from emulation.
- [ ] Physical-device checks cover representative Chromebook, macOS/Safari, Windows, Linux, and touch-platform devices.

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
- [ ] The approved OS/browser compatibility matrix is part of web release acceptance and does not require Electron packaging.
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
