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
VITE_AUDIO_ENABLED=true|false
VITE_CREATOR_WORKSPACE=true|false
VITE_SCRIBE_ENCOUNTER_WORKSPACE=true|false
VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=true|false
```

`VITE_PIXI_FISHING` was added in Phase 17. It gates the PixiJS fishing pond behind the
existing village fishing-pond launcher, and — like every flag except audio — it is a
cutover gate whose production default is the pre-phase behaviour (`false`). It selects which
world a cast enters, not what counts as a catch: the state machine, the canonical catalog
and subject ids, the catch transaction, and the keep, release, and recall rules are
unchanged by it. `build:web:pixi-fishing` sets only this flag and leaves
`VITE_WORLD_RENDERER=phaser`, which is why the renderer chunk boundary has a
`pixiFishing` check of its own; the phase's rollback is `VITE_PIXI_FISHING=false`, which
returns the same launcher to the Phaser `FishingScene`.

`VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` was added in Phase 16. It gates the redesigned
Archaeologist review workspace behind the existing room-panel review view, and — like every
flag except audio — it is a cutover gate whose production default is the pre-phase behaviour
(`false`). It selects which view a learner sees, not what counts as a review pass: the review
command layer, the SM-2 scheduling, and the review-pass reward are unchanged by it.

`VITE_SCRIBE_ENCOUNTER_WORKSPACE` was added in Phase 15. It gates the redesigned Scribe
encounter workspace behind the existing NoteEditorModal, and — like every flag except
audio — it is a cutover gate whose production default is the pre-phase behaviour
(`false`). It selects which view a learner sees, not what counts as a valid note.

`VITE_CREATOR_WORKSPACE` was added in Phase 14. It gates the redesigned Creator workspace behind
the existing RoomPanel Creator view, and — like every flag except audio — it is a cutover gate
whose production default is the pre-phase behaviour (`false`).

`VITE_AUDIO_ENABLED` was added in Phase 10 and is the one flag here that is not a
cutover gate. Every other flag switches an existing behaviour to a new one, so its
production default is the pre-phase behaviour. Audio has no pre-phase behaviour to
preserve — Phase 10 builds the service — so the flag gates its *use* rather than its
arrival, and its production default is `true`. It is the mechanism the plan's Phase 10
rollback line requires. The distinction is declared as data in `NON_CUTOVER_FLAG_KEYS`
in `src/config/featureFlags.ts` so the exception is one reviewed list rather than a
quiet hole, and the three gates that assert "no flag defaults on" now assert "no
*cutover* flag defaults on" against that list.

Before cutover:

- Production defaults remain Phaser and legacy storage.
- Pixi paths run in CI and internal builds.
- Storage-v2 is staged and mirrored.
- New data products and assistance are opt-in.
- Audio is on by default and can be disabled independently.

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
| 4 | complete | Cut over storage behind a flag and add local attachments. |
| 5 | complete | Deliver full-device backup and restore. |
| 6 | complete | Deliver individual subject backup and restore. |
| 7 | complete | Deliver safe blank reusable templates. |
| 8 | complete | Establish Cozy design tokens and the CC0 media gate. |
| 9 | complete | Build the PixiJS runtime host. |
| 10 | complete | Build asset bundles and functional audio. |
| 11 | complete | Build the Pixi village world foundation. |
| 12 | complete | Build village NPCs, quests, and redesigned panels. |
| 13 | complete | Build the Pixi dungeon world and navigation. |
| 14 | complete | Redesign the Creator flow. |
| 15 | complete | Redesign the Scribe flow. |
| 16 | complete | Redesign the Archaeologist flow. |
| 17 | complete | Rebuild fishing in Pixi. |
| 18 | complete | Wire and redesign study statistics. |
| 19 | complete | Add local adaptive assistance. |
| 20 | complete | Redesign private share cards. |
| 21 | complete | Complete accessibility and responsive verification. |
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

#### Checkpoint and merge evidence

Recorded on 2026-09-26. The phase was committed and pushed as the explicitly
authorized checkpoint, opened as pull request #52, and reviewed again by CI.

- Commit `4241a4f` (`feat: add phase 3 storage-v2 repository foundation`) was
  pushed to `phase-3-storage-v2`. 36 files, +14,384 / −238, working tree clean.
  `main` was deliberately not written to, because the lint, typecheck, unit,
  build, viewport, and compatibility gates live on pull requests in this
  repository.
- **Pull-request run `36188860682` failed Unit Tests on 5 tests in
  `tests/migrations/qaHardening.test.ts` and `tests/migrations/qaRoundTwo.test.ts`,
  all with `TypeError: Failed to execute 'digest' on 'SubtleCrypto': 2nd
  argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView`.**
  Lint and Typecheck passed. This was a **test-helper** defect, not a
  production defect: the helpers passed `bytes.buffer.slice(...)` to
  `crypto.subtle.digest`.
- **Root cause, reproduced rather than assumed.** CI pins **Node 20** in
  `.github/workflows/ci.yml` while local development runs Node 22. Under jsdom
  the test realm and Node's crypto realm differ, so `.buffer.slice(...)`
  produces a cross-realm `ArrayBuffer`. Node 20's `SubtleCrypto` validates its
  argument with an `instanceof` chain and rejects it; Node 22 accepts the same
  value. A `node:vm` probe run under both runtimes confirmed exactly that
  divergence, which is why the suite was green locally and red only in CI.
- **Fix:** the helpers now pass `new Uint8Array(bytes)`, which copies the
  view's elements into the current realm, is accepted on Node 20 and Node 22
  and in every browser, and preserves the slice semantics the "hashes a
  `Uint8Array` view over its own slice" test depends on. No production code
  changed. Both call sites and the reference comment were updated; the
  comment now names the Node 20 versus Node 22 divergence rather than
  describing it loosely.
- **Evidence the fix works on the failing runtime:** the full 55-file / 744-test
  suite was re-run under `node@20` and passed, having failed there before the
  change, and also passes under the local Node 22.
- **Environment caveat carried forward:** every local gate in this phase ran on
  Node 22.22.2, but CI runs Node 20. The two runtimes differ in at least one
  place that mattered here. A green local gate is therefore not by itself
  evidence of a green CI run, and any future phase that depends on a Node
  built-in, Web Crypto, or a cross-realm object type must be verified under
  Node 20 as well. This is a tooling and verification gap, not a product one.
- The phase was not merged on a red run. Follow-up commit `ecfddb3` (`fix: make
  the Web Crypto checksum cross-check portable to Node 20`) was pushed to the
  same branch; it changed two QA test helpers and the plan, and no production
  code.
- **Pull-request run `36189936366` then passed all nine jobs:** Lint, Typecheck
  (App, Node, Electron), Unit Tests, Web Build and Bundle, Browser Smoke
  (Chromium Matrix), and the four representative compatibility lanes
  `pr-linux-chromium`, `pr-linux-firefox`, `pr-macos-webkit`, and
  `pr-windows-edge`.
- **PR #52 merged as `f0092e2`** (squash). **Main CI run `36190475179`** passed
  the same nine jobs, and **Pages deployment run `36190475069`** succeeded.
- Every lane continued to classify its runner as emulated, representative, and
  synthetic. No new browser, host, device, or assistive-technology claim was
  made, and the physical-device gates remain assigned to Phases 21 and 23.
- Rollback is now `git revert f0092e2`, or a reset to the Phase 2 checkpoint
  `5345493`.

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

**Status:** complete
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
### Verification evidence

Recorded on 2026-09-26. The status advanced from `verified` to `complete` on
2026-09-26, when the maintainer accepted the verified checkpoint. Phase 5
remains `not-started` and requires separate authorization.

#### What was built

- **Explicit asynchronous application bootstrap.** `src/application/bootstrap.ts`
  owns hydration, with every store effect injected through a 30-member
  dependency bag, and follows a read-then-commit discipline: read everything into
  a plan without touching a store, then commit preferences → shortcuts →
  progression → subject snapshot → session/progression active id in one
  synchronous step. `src/main.tsx` awaits it before `createRoot().render()`.
  Module-load `localStorage` reads are gone from `progressionStore`,
  `preferencesStore`, `shortcutStore`, and `sessionTracker`, replaced by explicit
  `hydrate*` entry points.
- **Repository routing behind the flag.** `repositorySelection.ts` is the single
  decision point; `subjectPersistence.ts` keeps its exact exported API and routes
  reads and writes. With the flag off, storage-v2 is never opened — proven in a
  real browser with `indexedDB.databases()`.
- **Dual-write.** `dualWrite.ts` runs the mirror only after the primary succeeds,
  so the legacy key can never be ahead of storage-v2. Covered: subject save,
  subject delete, subject index, progression, preferences, shortcuts, sessions,
  attachment bytes. The active-subject pointer is deliberately excluded, because
  it must stay synchronously readable while stores hydrate and a rollback build
  reads the same key.
- **Device-local attachment bytes.** `attachmentBytes.ts` stores image bytes in a
  dedicated IndexedDB database with a real SHA-256 content hash, and the bytes are
  copied into a fresh `ArrayBuffer` so a later mutation of the caller's buffer
  cannot change what was hashed. Object URLs are revoked when the editor re-runs
  or closes. External attachments store `availability: 'external-only'`,
  `contentHash: null`, and no bytes, and are never fetched.
- **Migration state UI.** `MigrationStateSurface.tsx`, `migrationStateCopy.ts`,
  and `useModalFocus.ts` render the six `MigrationStateKind` values mounted from
  `App.tsx`. Copy lives as pure data, so a wording change cannot alter which
  control appears. Only `recovery-required` uses a dialog; the rest are polite
  live-region panels that never trap focus.
- **Verification rails.** `npm run test:privacy` (a source-level and unit-level
  privacy gate with its own non-vacuity floors and a planted positive control),
  a `storage-v2-browser` Playwright lane bound to a new `tests/e2e/storageV2.spec.ts`
  against a flagged build, and `npm run test:node20` to run the suite under the CI
  Node major.

#### Declared default-build behavior changes

Three changes affect the **default** build and need maintainer sign-off.

1. **Boot no longer writes.** Pre-phase, `App.tsx` called `loadSubject(active)` on
   boot, which rewrote the legacy subject key and created a
   `knowledge-dungeon:backup:<id>` record on every boot. Hydration is now
   read-only. Verified: a seeded default build boots with every `localStorage`
   key byte-identical, in the same insertion order, and no backup key. This was
   required — the storage-v2 lane asserts the legacy subject key is unchanged
   across a migration, and a read must not mutate. The only difference is on
   disk, in the direction of "boot no longer modifies the learner's data".
2. **The web image path no longer uploads, in either mode.** `NoteEditorModal`'s
   `FormData` + `fetch('/api/upload')` is gone; bytes go to the device-local
   store. The Phase 4 exit criterion is that the redesigned app makes no
   learner-data upload request, and the known defect is that the Welcome copy
   contradicted the upload path, so this was not flag-gated: a flag-gated upload
   would have left the false claim live in the default build. The Electron bridge
   path is unchanged in code and the server route is retained for compatibility.
3. **Two user-facing statements had to change because the change made them
   false.** The Welcome privacy paragraph and the note-editor images hint. The
   privacy paragraph is now branch-accurate: it names IndexedDB for image
   attachments on the web and the desktop host's own disk on Electron, does not
   present `localStorage` as where everything lives, makes no absolute
   "nothing leaves your device" claim, and discloses that external image bytes
   cannot be retrieved.

A fourth, smaller: a subject payload the subject index does not name is now
preserved as a `recovery` record with `kind: 'unindexed-subject'` plus a
disclosure, instead of being carried as a `subjects` record. The bytes are
preserved verbatim, the subject set stays equal to the one this build can open,
and the two repositories therefore agree. This was the implementer's deliberate
reversal of the review's proposed direction; the orchestrator accepted it,
because making the legacy reader start seeing unindexed payloads would have been
a default-build behavior change this phase forbids.

#### Defects found in review and fixed before verification

Reviewed three times by `qa-engineer` and repeatedly by the orchestrator, always
against the actual diff and real execution. The phase was **not** accepted on its
first or second pass. Four blockers, all found by review rather than by the
implementation's own suite:

1. **The flagged build lost all progression on every reload, then wrote the loss
   to the legacy mirror.** `progressionEnvelopeFrom` emitted no `version`, so
   `normalizeProgressionRecord` classified the storage-v2 reader's own output as a
   v1 flat record: one empty record for the active subject, the real map buried in
   `extraFields`, achievements dropped. The next ordinary action then persisted
   that empty progression to both repositories. Runtime witness: the app's own
   Statistics dialog showed `Total XP 23` and one badge in the default build and
   `Total XP 0` and no Badges section in the flagged build, on the same device.
2. **The write side had the identical defect.** `publishProgressionToActiveGeneration`
   normalized an unversioned envelope, so progression earned after migration was
   never persisted while the legacy mirror held it. Fixed in the *function*,
   because its parameter is `unknown` and only the writer can guarantee the shape;
   a caller-side fix would have left it one forgotten argument away from the same
   silent corruption. `sourceVersion` semantics were decided explicitly: it is
   the shape the writer read, so it is the current version, and the arriving
   legacy shape is recorded once by the migration in
   `report.progressionSourceVersions`.
3. **A device with custom-sprite data could never migrate.** The store is keyed
   by `spritePath`, but the migration emits up to three records per path
   (`override`, `anim`, `original`), which collapsed onto one primary key while
   the descriptor counted the pre-collapse array, so `validateGeneration` refused
   with `count-mismatch`. Fixed with a kind-aware record id; the count validation
   was **not** loosened.
4. **A first-time learner was told their data had been migrated.** A device whose
   only key is `knowledge-dungeon:locale` — written by the i18next detector on a
   brand-new install — was classified as having source data, so every new learner
   on the flagged build saw "the update finished … 0 subjects" and a generation
   was staged and activated for nothing. Fixed with a companion
   `hasNoLearnerContent` predicate: a key the app writes on its own initiative is
   a marker, a key only a learner action writes is content. Preferences were
   deliberately classified as content, because its presence means a learner chose
   a theme.

Two UI findings were also closed: the disclosed-problems path rendered
`problem.code` and `problem.scope` raw while the recovery path sanitised, and
`Dismiss` stayed live during an in-flight action so a learner could hide the state
their own action was about to return.

#### Commands run and results

The orchestrator ran the common gate and both phase-specific e2e suites
independently, as one chain, with exit code 0.

| Command | Result |
| --- | --- |
| `npm run lint` | pass, 0 errors 0 warnings |
| `npm run typecheck` | pass |
| `npm test` | pass — 82 files / 1121 tests, **0 failures** (Phase 3 baseline 55 / 744) |
| `npm run test:privacy` | pass — 6 files / 34 tests |
| `npm run test:migrations` | pass — 15 files / 369 tests |
| `npm run test:e2e` | pass — 12 tests across the four Chromium viewport projects |
| `npm run test:e2e:storage` | pass — 9 tests on the flagged build |
| `npm run build:web` | pass |
| `npm run check:bundle-size` | pass — `Total dist size: 4.12 MB across 125 files` |
| `npm run test:node20` | pass — 82 files / 1121 tests, identical to Node 22 |

`npm test` was additionally run **three consecutive times** by the implementer
and the failure identities were byte-identical, which matters because this
repository has twice been bitten by an intermittent gate.

#### Exit-criteria evidence

- **No visible data loss in legacy fixtures.** Every subject, room, note,
  validation state, artifact, attachment, badge, XP, fish, session, preference,
  shortcut, locale, quest, custom-sprite and recovery record was compared across
  the two repositories, attacking unknown fields, corrupt JSON, an index entry
  with no payload, a payload with no index entry, unrecoverable local attachment
  bytes, an external attachment, a v1 flat progression, a v3 progression with
  unknown fields, a deliberately truncated subject, and all of them at once. The
  legacy key set is byte-identical before and after.
- **Migration can run repeatedly without duplication.** Three sequential runs
  stage, activate, and write a receipt exactly once each, counted through a
  proxy rather than inferred; one receipt, one subject, one session. An
  interrupted run is reclaimed and retried cleanly, and a run after the active
  generation advanced does not steal the pointer. The browser lane covers two
  tabs migrating concurrently, one generation, one receipt.
- **Phaser rollback can still read mirrored changes.** With the flag on, subject,
  progression, preferences, shortcuts, sessions and attachment bytes are all
  readable after switching to `legacy`, and the mirrored progression is the
  pre-Phase-4 v3 document. Mirror failures from a quota-throwing and a throwing
  `localStorage` leave the primary write intact and are reported rather than
  swallowed. With the flag off, `indexedDB.databases()` proves no storage-v2
  database was ever created.
- **The redesigned app makes no learner-data upload request.** An independent
  browser probe drove the real UI through Welcome, the tutorial, a room panel and
  the actual `+ Add image` file control in **both** builds: 62 requests, 60
  same-origin static reads, 2 off-origin static reads of the pre-Cozy Google
  Fonts stylesheet, **0** app-endpoint, **0** non-GET, **0** WebSocket. The image
  produced exactly 2 requests, both same-origin lazily loaded scripts; the bytes
  were never a request, and they are in the device-local store with a SHA-256
  matching Node's, durable across a reload and mirrored into the generation. The
  source-level gate walks 108 modules from `src/main.tsx` and reports zero
  findings, with a planted positive control proving the walker bites.

#### Gates beyond the exit criteria

- **Privacy.** A distinctive synthetic marker planted as subject name, room
  topic, note body, attachment filename and alt text never appears in any report,
  receipt, descriptor, or validation output. `StorageV2Error.details` is enforced
  at construction: only `[A-Za-z0-9._-]{1,64}` with no trailing `.xxxx`, and the
  thrown `TypeError` names the key, never the value.
- **Renderer boundary.** The Phase 2 rule still covers `src/core/**`,
  `src/application/**` and `src/services/persistence/v2/**`, proven to bite with
  two planted probes.
- **Lazy boundary.** The default entry chunk contains **zero** storage-v2 or
  `fflate` markers: `knowledge-dungeon-storage-v2`, `activeGeneration`,
  `discardStagedGeneration`, `recomputeDescriptor`, `mergeEnvelopes`,
  `knowledge-dungeon-attachments` all absent, and the storage-v2 modules remain
  separate dynamic-import chunks. The 20 new files in `dist` are those lazy
  chunks and their legacy twins.
- **Accessibility.** axe-core reports zero violations on both the panel and the
  dialog. All controls measure 44px minimum height in all three live themes;
  the dialog takes initial focus, Tab and Shift+Tab both wrap, Escape closes, and
  focus is restored. Contrast was measured per theme and every rendered panel
  text is at least 7.04:1. The surface does not overflow at 320 CSS px or at a
  640 px viewport. The sub-44 px window during the shared 250 ms modal animation
  is bounded to about 40 ms and absent under `prefers-reduced-motion`.
- **Default build unchanged.** `tests/unit/defaultBuildRendering.test.tsx`
  passes unmodified and pins the four Welcome tabs, `Start Tutorial`, the setup
  checklist, the disabled `Enter Dungeon`, and the absence of `generation`,
  `storage-v2`, `migrat`, `recovery-required` and `external-only` in the rendered
  text.

#### Performance and bundle result

Raw `dist` is **4,315,447 bytes across 125 files**, against the Phase 3 baseline
of 4,111,129 bytes / 105 files: **+204,318 bytes (+4.97%)**, with +20 files. The
20 files are the lazily loaded `migrations`, `migrationState`, `attachmentBytes`
and `deviceAttachments` chunks and their `-legacy-` twins. The 125 MB / 12 MB raw
ceiling is not at risk.

Welcome initial JS + CSS, measured by the orchestrator from the default build:
**201,251 bytes gzip excluding the eagerly loaded Phaser chunk**, inside the plan
§10.2 300 KB budget. Including it the total is 549,797 bytes, because
`src/ui/App.tsx` statically imports `GameScreen`, which pulls Phaser in eagerly.

**This is a pre-existing breach that plan §10.2 explicitly forbids** ("no eager
Phaser or Pixi load on Welcome"), and `tests/e2e/currentBuild.spec.ts` currently
**asserts the opposite of the plan** by requiring the Phaser vendor chunk to load.
Phase 3's evidence reported only the entry chunk and so did not surface it. It is
recorded here as a finding, not fixed: the fix is lazy-loading the renderer host,
which is Phase 9's work. Phase 3's `index` chunk figure of 97.57 kB gzip becomes
106,441 bytes in this build; the entry chunk still carries no storage-v2 code.

#### Known limitations and evidence boundaries

- **The storage-v2 browser lane is Linux/Chromium at an emulated viewport only**,
  and it disclaims accessibility evidence. No Firefox, WebKit, or Edge; no
  physical Chromebook with ChromeVox; no touch-platform screen reader; no
  physical device. Those gates stay assigned to Phases 21 and 23.
- **Genuinely simultaneous** two-tab migration is covered with two live
  IndexedDB handles, not two browser processes inside one write transaction:
  Chromium will not open a second connection's request while another holds a
  pending read-write transaction, and holding a lock from a third page deadlocks.
  A real cross-tab **interleave** is proven in a browser; the truly-contended
  lock case is not.
- **The note editor's file picker is not driven end to end by the wired lane's
  original design.** QA moved the real `+ Add image` path into the wired lane and
  deleted the unwired probe, so the evidence now exists in a lane that passes in
  CI. A `window` test hook was deliberately not added, because it would
  reintroduce the production seam this phase removed.
- **No real screen reader, real touch device, or physical 200 % browser zoom.**
  Every ARIA role, live region, and accessible name is asserted structurally and
  by axe-core but has not been heard. The 200 % claim is a 640 CSS-px viewport.
- **Migration preview is not reachable today.** `migrateLegacyState` reports only
  `migrated`, `partial`, `recovery-required` and `no-source-data`; `preview` comes
  from `buildMigrationPreview` for a future Data Center screen, so no start
  control can currently appear. The affordance is wired and tested as a mount
  point. The recovery dialog's Escape being unavailable during a retry means a
  never-settling promise would leave a learner stuck; the only producer today
  cannot return one.
- **Two hand-maintained transcriptions** exist for the UI's copy vocabulary: 40
  problem codes and 15 scopes, generated from the core's union declarations and
  pinned by a test that parses those declarations, so divergence is loud rather
  than silent. If the v2 tree ever exports a runtime array, the copy module
  should import it instead.
- **A pre-existing, font-metric-dependent 320 px overflow in the Welcome screen**
  reproduces with the migration surface absent (339 px scroll width at a 320 px
  viewport) and is absent at 640 px. Not caused by this phase; a Phase 21
  responsive follow-up.
- **Recorded follow-ups, deliberately not fixed here:** a test-planting
  declaration is a file-level list written by the planting suite, so a dishonest
  declaration could still grant cover (mitigated by the declared-directory
  constraint, the live-marker requirement, fail-closed parsing, and four attack
  tests); the `qaHardening` allowlist gate does not assert every allowlisted file
  still imports storage-v2; `DEFAULT_SHORTCUT_KEYS` is a second declaration of the
  shortcut defaults, pinned by a test; a code-shaped-but-unknown disclosed code
  renders as `3 not an objects (subject)`, which is cosmetic and only occurs
  outside the vocabulary; the `StorageV2Error` filename rule refuses a subject id
  ending in `.v1` but does not treat a 6+ character trailing segment as a
  filename, so it is a heuristic rather than a proof; the Phase 3 follow-ups
  carried forward unchanged (`.` as an archive path, `Object.prototype` duplicate
  members, rejected ZIP directory entries, `progressionSourceVersions`,
  `ProgressionRecordValue` not a fixed point, `LegacyKeyReport.keyId` embedding
  the subject id, `stageGeneration` upsert-only on a direct subset re-stage).
- **Electron packaging was not exercised** and remains a compatibility concern,
  not a web release gate. The bridge path is tried first on every facade call
  exactly as before.
- No learner data exists in any source, fixture, test, report, log, or evidence
  file added by this phase. Every fixture is synthetic and self-describing; the
  only URL host is the reserved `example.invalid`.

#### Files

Created: `src/application/bootstrap.ts`,
`src/services/persistence/v2/{repositorySelection,dualWrite,attachmentBytes,migrationState,appState,appRepository}.ts`,
`src/services/persistence/deviceAttachments.ts`,
`src/ui/components/{MigrationStateSurface,migrationStateCopy}.tsx|.ts`,
`src/ui/hooks/useModalFocus.ts`,
`.env.storage-v2`, `playwright.storage-v2.config.ts`,
`tests/privacy/`, `tests/phase4/`, `tests/e2e/{storageV2.spec.ts,storage-v2-lane.ts}`,
and nine new test files under `tests/unit/` and `tests/migrations/`.
Modified: `src/main.tsx`, `src/ui/App.tsx`, `src/ui/components/NoteEditorModal.tsx`,
`src/ui/screens/WelcomeScreen.tsx`, `src/styles.css`,
`src/store/{progressionStore,preferencesStore,shortcutStore,subjectStore}.ts`,
`src/services/{sessionTracker.ts,persistence/subjectPersistence.ts}`,
`src/services/persistence/v2/{repository,migrations,schema,validation,legacyReader}.ts`,
`package.json`, `tsconfig.node.json`, `.github/workflows/ci.yml`, `README.md`, and
ten pre-existing test files.
Scripts added: `test:privacy`, `test:node20`, `build:storage-v2-flagged`,
`record:web-artifact:storage-v2`, `verify:web-artifact:storage-v2`,
`test:e2e:storage`, `test:e2e:storage:recorded`.

#### Rollback

Set `VITE_STORAGE_REPOSITORY=legacy` and retain the staged generation for
diagnosis. The default build already is that configuration, so the rollback is a
build-time flag with no code change: the legacy repository remains authoritative,
every dual-written key is readable, and a stale `staged` generation is invisible
to every read path and reclaimable. Two declared changes are **not** reversible by
the flag, because they affect the default build and are deliberate: boot no longer
writes a `knowledge-dungeon:backup:<id>` record, and the web image path no longer
uploads. Rolling either back is a source revert.

### Unlocks

Phases 5, 6, and 7.

---

## Phase 5: Full-Device Backup Product

**Status:** complete
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

### Verification evidence

Recorded on 2026-09-26. The status advanced from `verified` to `complete` on
2026-09-26, when the maintainer accepted the verified checkpoint. Phase 6
remains `not-started` and requires separate authorization.

#### What was built

- **`.kdbak` export and import** in `src/services/persistence/products/fullDeviceBackup.ts`,
  and a read-only `archiveValidation.ts` that every archive byte passes through
  before anything is staged. The layout is the plan's §7.3 layout unchanged:
  `manifest.json`, `state.json`, `attachments/<sha256>`, `custom-sprites/*`,
  `recovery/*`. Every record value is carried **verbatim** — no normalization, no
  re-derivation, no field-picking — so unknown app-owned fields survive at every
  level. Attachment members are content-addressed, so two identical payloads
  collapse to one.
- **The manifest** is a closed twelve-key set at format version 1: `product`,
  `formatVersion`, `storageGenerationFormatVersion`, `subjectSchemaVersion`,
  `createdAt`, `memberCount`, `totalBytes`, `contentChecksum`, `recordCounts`,
  `attachmentBytes`, `externalOnlyAttachments`, `members`. The three version
  fields are separate contracts read from three different production constants
  and each is refused on its own; `formatVersion` and `storageGenerationFormatVersion`
  are integers and `subjectSchemaVersion` is a semver string, so one field
  structurally cannot hold all three. `members[]` omits `manifest.json` because a
  member cannot contain its own digest.
- **The Data Center** in `src/ui/data/{DataCenter.tsx,ImportPreview.tsx,RecoveryStatus.tsx}`,
  mounted from the existing Welcome `data` tab when `VITE_DATA_PRODUCTS_V2` is
  true. Local download only: `Blob` → object URL → anchor → revoke.
- **Verification rails**: `npm run test:data` (nine gates), a fresh-profile
  restore Playwright lane with its own CI step, and `build:storage-v2-data-products`
  so the owner flag reaches a flagged build without editing `.env.storage-v2`.

#### Three decisions the implementer made that the orchestrator accepted

1. **`keepPreviousGeneration` is a documented no-op; retention is unconditional.**
   A boolean whose false value would mean "delete the generation I just replaced"
   is a boolean with no safe false value. QA later confirmed retention holds across
   three successive restores. The echoed field was corrected so it reports the
   outcome rather than the request.
2. **The importer adopts the archive's own `sourceGenerationId`** when the label is
   free on the device, so the migration receipts the archive carries keep naming the
   generation they belong to. When it is not free, a fresh label is minted. QA
   verified eleven hostile labels — path traversal, absolute, drive letter,
   4096 characters, emoji, RTL override, leading space — are never adopted and never
   reach a member path.
3. **No migration receipt is minted for a restore.** `MigrationReceiptValue` is
   typed `fromStorage: 'legacy-localstorage'`, so a receipt claiming a legacy
   migration would be untrue. The archive's receipts are restored and the mismatch
   is disclosed rather than repaired, because recomputing them would forge a record
   of a migration this device never performed.

#### Defects found in review and fixed before verification

Reviewed adversarially by `qa-engineer`, which added a nine-file, 104-test
independent suite sharing no code with the phase's own rails, plus two browser
measurement harnesses. The phase was **not** acceptable on its first pass.

- **BLOCKER — a learner could take a backup they could never restore.** The
  archive reader refused on the **total** migration problem count while reporting
  the **blocking** count, so a record with warnings only threw an error whose
  `problemCount` was `0`. A device holding `subject-1.1.0-minimal.json` — which the
  current importer accepts and which `validateGeneration` reports `ok` with the
  single warning `missing-phase-state` — exported successfully, and that archive
  was then always refused. The reader and the importer, halves of one product,
  disagreed about whether a warning is a refusal. Fixed to refuse only on blocking
  problems, through the single declared policy (`MIGRATION_BLOCKING_POLICY` /
  `isActivationBlocking`) rather than a locally re-derived rule, and the other
  validators in the module were audited for the same mistake. The orchestrator
  reproduced the exact scenario independently: `activated: true`, subject
  restored.
- **An `Object.prototype` key was adoptable as a database generation label.** The
  member-name rule already refused those names; the generation-label rule did not.
  With receipts present the restore then failed; with none, a generation named
  `constructor` became the active pointer. The reader's own
  `isPrototypeMemberName` now gates both requested and minted labels.
- **The module's determinism claim was false.** fflate stamps each ZIP entry from
  `Date.now()` at two-second resolution, so two exports of the same generation
  under the same injected clock differed. The claim was made true by passing an
  `mtime` derived from the injected clock, and the test proves it by asserting the
  header's DOS word at dates the wall clock is not at, so it is not
  load-sensitive.
- **A repointed receipt still described the source device.** Now disclosed through
  `migrationReceiptRepointed` and `receiptProvenanceNote`.
- **A test-planting hole and a stale CI exemption** were closed in the same pass:
  the planting exemption was narrowed from a directory to the exact planted file
  list with fail-closed parsing, and the data-products CI step's
  `continue-on-error: true` was removed with its now-false justification, and the
  gate inverted to assert the **absence** of the exemption.

Three gates were edited in place by the implementer rather than only added to.
Each carries an in-file `RAIL CHANGE` / `RAIL FIX` note, and QA judged every one
**stronger or neutral**, naming the load-bearing assertion that survived in each
case. QA found no weakened assertion anywhere in the phase.

#### Checkpoint and merge evidence

Recorded on 2026-09-26.

- Commits `312c3b1` (the phase) and `c852d71` (a gate fix, below) were pushed to
  `phase-5-data-products`, branched from the merged Phase 4 commit so its pull
  request carried only Phase 5's 57 paths. PR #55 merged as `2a391e8`. Main CI run
  `36248621822` passed all ten jobs, including the `Browser (Storage v2 Flagged
  Build)` lane, and the Pages deployment run succeeded.
- **Phase 4 merged first**, as PR #54, squash commit `0814113`, with all ten jobs
  green on pull-request run `36222938056` and on main run `36244099937`. The
  local `main` was then moved to the squashed commit and the Phase 5 branch
  rebased onto it, because a squash leaves the pre-squash commit outside
  `main`'s history and a Phase 5 branch based on it would have re-shown Phase
  4's entire diff.
- **The first pull-request run, `36244611639`, failed Unit Tests on exactly one
  test** — and it was a gate defect, not a product defect. QA's
  `tests/phase5/privacy.test.ts` scanned `artifacts/compatibility-evidence` and
  asserted it held at least one file. `artifacts/` is gitignored, so a clean
  checkout has no such directory, the walk found nothing, and the assertion
  failed. The test had passed locally only because 71 directories of leftover
  run output existed on the maintainer's machine, where it scanned 452 files
  from unrelated runs; on CI, the environment that actually uploads evidence, it
  scanned zero. It therefore **failed where it mattered and passed where it did
  not**, which is the worst shape a privacy gate can have.
- The fix, in `c852d71`, makes the always-running assertion verify the property
  from evidence the test **builds itself**, to the lane's own declared record
  shape read from `tests/e2e/data-products-lane.ts` and the path builder in
  `tests/e2e/compat-evidence.ts`, written to a temporary tree laid out like the
  real allowlisted root and removed in a `finally` that asserts the tree is
  gone. A drift gate compares the record's key set for equality against the
  lane's declared interface. Three negative controls mutate one field each and
  require the scanner to report a learner marker, a non-reserved host, and an
  absolute home path, each verified by mutation. The real-directory scan is kept
  but demands no count, reports `present`/`filesFound`/`unreadable`/`findings` on
  stdout every run, and asserts that absence is caused by the gitignore rule — so
  "there was nothing to scan" became a stated fact with a stated cause instead
  of an unexamined pass. No skip and no early return.
- **This qualifies the phase's stability claim.** The three consecutive
  byte-identical local `npm test` runs reported above were identical, but one of
  the 103 files was green only because of untracked local state. The count is
  now 103 files / **1422** tests, because one environment-dependent test became
  three. The fix was verified under the failing condition: with `artifacts/`
  moved aside the suite passes 103 / 1422 and reports `present=false
  filesFound=0`; with it restored, `present=true filesFound=452`.
- `tests/phase5/seam.test.ts` also reads `dist/` for two built-artifact
  assertions, but guards with `existsSync` and demands no count, so it cannot
  fail on a fresh checkout. Measured and deliberately left alone: fixing it would
  mean building `dist` inside a unit test, and its property is already covered in
  CI by `build:web`, `check:bundle-size` and `currentBuild.spec.ts`. Recorded as
  a coverage note, not a false pass.
- Every lane continues to classify its runner as emulated, representative, and
  synthetic. No new browser, host, device, or assistive-technology claim was
  made, and the physical-device gates remain assigned to Phases 21 and 23.
- Rollback is now `git revert 2a391e8`, or a reset to the Phase 4 checkpoint
  `0814113`.

#### Commands run and results

The orchestrator ran the common gate, both phase-specific gates, the focused
suite, and all three browser lanes independently, as one chain, with exit code 0.

| Command | Result |
| --- | --- |
| `npm run lint` | pass, 0 errors 0 warnings |
| `npm run typecheck` | pass |
| `npm test` | pass — 103 files / 1420 tests, 0 failures (Phase 4 baseline 82 / 1121) |
| `npm run test:data` | pass — 9 files / 99 tests |
| `npm run test:privacy` | pass — 6 files / 34 tests |
| `npm run test:migrations` | pass — 15 files / 373 tests |
| `npm test -- tests/unit/subjectPersistence.test.ts` | pass — 1 file / 4 tests |
| `npm run test:node20` | pass — 103 files / 1420 tests, identical to Node 22 |
| `npm run build:web` | pass |
| `npm run check:bundle-size` | pass — `Total dist size: 4.26 MB across 132 files` |
| `npm run test:e2e` | pass — 12 tests across the four Chromium viewports |
| `npm run test:e2e:storage` | pass — 9 tests on the flagged build |
| `npm run test:e2e:data-products:full` | pass — 4 tests, fresh-profile restore |

`npm test` was run **three consecutive times** and produced byte-identical
results, which matters because this repository has twice been bitten by an
intermittent gate. `tests/data/suiteIntegrity.test.ts` asserts that **no** live
registered reproduction remains, so the 24 that shipped as `it.fails` are all now
live assertions and none can be deleted to make a count true.

#### Exit-criteria evidence

- **A populated storage-v2 state exports and restores with semantic equality.**
  A device nastier than the rails' own fixture — four subjects including one with
  no rooms and one with exactly one, the Phase 0 unknown-fields fixture
  re-identified, unicode and emoji in a name, topic, note and tag, unknown fields on
  a record, the snapshot, the dungeon, an edge, a room, a validation state, a note,
  an inventory item, a fish, an attachment, a sprite, a recovery record and a
  session; attachments that share a payload, differ only in their last byte, are
  256 KiB, are `external`-source with bytes, or declare a hash their bytes do not
  satisfy; a sprite body that is not valid JSON; a recovery payload that does not
  parse — round-trips with **zero field differences** across all nine record
  stores. The comparator is proven able to fail, including on a single flipped byte
  inside binary. Two carve-outs exist and both are disclosed: a record whose bytes
  disagree with its declared hash, and an already-`external-only` record, both
  become external-only with a null hash.
- **All available attachment bytes and custom sprite data survive.** Five blobs
  element by element with digests cross-checked against Node `crypto` and Web
  Crypto, a 256 KiB payload byte-identical, and three sprite bodies byte-identical
  including one that is not valid JSON and one full of member-name
  metacharacters.
- **Corrupt archives never replace current data.** The phase's rails cover fifteen
  cases; QA wrote twelve more of its own, including five *consistently* corrupt
  archives where every recomputable checksum was recomputed. Every one was refused
  with a typed `StorageV2Error` and sanitized details, the device fingerprint —
  pointer, every record value **and its bytes**, every descriptor, and the whole
  ordered legacy `localStorage` — byte-identical, and a good import lands
  afterwards. The fingerprint is proven able to move on a single edited field and
  on a single flipped attachment byte.
- **External-only images are disclosed.** An all-external archive, an orphan byte
  member beside a disclosed record, and a disclosure histogram that disagrees with
  the state: no fabricated hash anywhere, the import still succeeds, and the
  disclosure reaches the learner in words — "Image 1 of 2", with a reason
  sentence — carrying no digest, no id, no URL and no filename.

#### Gates beyond the exit criteria

- **No learner data in the manifest, member paths, errors, reports or evidence.**
  A marker planted as subject name, room topic, note, attachment filename and alt
  text appears in none of them. `state.json` necessarily contains learner data —
  it is a backup — so the claim is scoped to the manifest, member paths, reports
  and evidence, and stated that way.
- **Default build genuinely unchanged.** `VITE_DATA_PRODUCTS_V2` defaults to
  `false`; `tests/unit/defaultBuildRendering.test.tsx` is unmodified; the 12-test
  default-build suite passes; and a browser probe against the default `dist` could
  not find the Data Center control at all.
- **Accessibility, measured independently by QA in Chromium.** Zero text-contrast
  failures and zero non-text failures across all four themes, zero touch targets
  under 44 px at 1280×900, 320×640 and 200 % zoom, no horizontal overflow in the
  Data Center at 320 px, `prefers-reduced-motion` yielding zero animated elements
  and `data-kd-motion="reduced"`, a focus indicator at 6.52:1 measured with a real
  Tab press, and a dialog with `aria-modal`, `aria-labelledby` and
  `aria-describedby` set, initial focus inside, 8/8 tab steps contained, Escape
  closing, and focus restored to the opener. QA also **reproduced** the CSS
  specificity defect the implementer reported and fixed — the shell's
  `:root[data-graphics='rpg'] button` really did outrank the Data Center's own
  rules, and the doubled class really does win.
- **The destructive confirmation is provably load-bearing.** After a real archive
  is read, the device's active generation is read, then every control outside the
  dialog plus the dismiss button are pressed in turn, re-reading the pointer after
  each — unchanged every time. The dialog's `onEscape` is `null` while a restore is
  in flight, so it is genuinely not dismissible mid-operation.
- **Retention is measured, not claimed.** The restore lane plants a sentinel record
  in the target's prior generation through a real IndexedDB transaction, then
  requires the prior descriptor to be found, its status to be `superseded`, its
  sentinel present, and its record count unchanged. QA separately confirmed that
  deleting a real retained generation makes every retention assertion fail.
- **Node 20.** 103 files / 1420 tests, identical to Node 22. The `test:node20`
  affordance added in Phase 4 paid for itself: a Phase 5 loop test failed under
  Node 20 contention purely for want of a timeout budget, not a moved assertion.

#### Performance and bundle result

Raw `dist` is **4,463,882 bytes across 132 files**, against the Phase 4 baseline
of 4,315,447 / 125: **+148,435 bytes (+3.4%)**, +7 files. All 7 are the Data
Center's lazy chunks and their `-legacy-` twins.

Welcome initial JS + CSS is **201,931 bytes gzip** excluding the eagerly loaded
Phaser chunk, inside the 300 KB budget, and the pre-existing eager-Phaser breach
recorded in Phase 4's evidence is unchanged.

**The default build ships the Phase 5 product without ever loading it:** 72,238
bytes raw / 23,553 gzip across 4 files, because the flag guard is a runtime `if`
rather than a build-time `define`, so the bundler cannot prune the chunks. At run
time the flag-off build executes none of it, and the product's own gate asserts the
durable property — the product modules are **lazily reachable, never eagerly
imported**, and no non-product module in the graph reaches the ZIP codec eagerly.
The arithmetic is decisive against the plan's budgets: the chunks are 0.34 % of the
raw `dist` ceiling and are not "initial" at all. Removing the bytes would need
build-time dead-code elimination, which is a bundle decision for Phase 7 or 8.

#### Known limitations and evidence boundaries

- **A real screen reader was never used.** Every ARIA role, live region, accessible
  name and focus behaviour is a DOM or `aria-*` measurement, and several were
  measured in Chromium, but nothing here is VoiceOver, NVDA, or ChromeVox
  evidence. The plan's manual device checks — a Chromebook with ChromeVox, an
  iPad or Android touch-platform screen reader, a Windows desktop browser — remain
  outstanding and stay assigned to Phases 21 and 23.
- **No physical touch device, no real browser zoom, and Chromium only.** The 44 px
  measurements are layout rectangles at emulated viewports, and 200 % is emulated
  as a 640 CSS-pixel viewport. No Firefox, WebKit, or Edge. Contrast, target size
  and focus were Chromium-only across four themes.
- **Cross-tab and quota behaviour during a restore was not measured in a browser**;
  the evidence there rests on `fake-indexeddb` and the two storage-v2 lane
  patterns, and Phase 4's limitations on that shim all still apply.
- **`npm run test:e2e:data-products` is preview-only** and only passes when `dist`
  was last built by `build:storage-v2-data-products`; against a default `dist` it
  fails with a missing-control timeout rather than saying the artifact is wrong.
  Use the `:full` variant. QA agrees this is a real trap; a one-line assertion on
  the recorded manifest's `dataProductsV2` would remove it and is a follow-up.
- **CI no longer exercises the flagged build with `VITE_DATA_PRODUCTS_V2` off.**
  One build per run means the data-products build is a superset of the storage-v2
  build, so the Phase 4 lane's product-free property is now verified only by the
  local `test:e2e:storage` script. Recorded as a real loss, traded for a single
  build.
- **The storage-v2 generation roll-up checksum does not cover attachment bytes** —
  `canonicalJsonStringify` serializes an `ArrayBuffer` as `{}`. QA quantified the
  consequence: two states with different attachment bytes **can** share a
  `contentChecksum`. It **cannot** be used to make a restore accept the wrong bytes
  (a member must hash to its own name, and a record is only given bytes through a
  member named by its declared hash) or to refuse the right bytes (a record whose
  declared hash names no member is disclosed, not refused). The archive boundary is
  closed; the exposure is **silent in-device attachment-byte corruption** being
  invisible to storage-v2's own validation. A Phase 4/22 hardening item.
- **The export does not guard against being handed a `staged` generation.** It
  succeeds, the archive is internally consistent, and it restores onto a device
  that does not hold the label. The one wrong thing is that such an archive carries
  a receipt with `status: 'activated'` for a migration that never activated.
- **The active-subject pointer is carried in the archive and reported as
  `restoredActiveSubjectId` but never applied**, and the UI says so in as many
  words. No migration receipt is minted for a restore. Both are deliberate and both
  are stated on screen.
- **A pre-existing 200 % overflow in the Welcome shell** (the masthead at 685 px in
  a 640 px viewport), separate from the Phase 4 record of a font-metric-dependent
  320 px overflow. The Data Center itself never overflows. A Phase 21 responsive
  follow-up.
- **High-contrast / forced-colors mode is not handled** by the Data Center, which
  relies on its own tokens rather than a forced-colours media query. A Phase 8
  decision.
- **Recorded follow-ups, deliberately not fixed:** the `.gitignore` bare `data/`
  rule that silently made `tests/data/` and `src/ui/data/` untrackable (both fixed
  with negations and both asserted by `git check-ignore`, so they cannot regress);
  `scripts/build-flagged-data-products.mjs` is not typechecked; the retention probe
  depends on a real record-id and index structure, so a storage-v2 schema change
  would fail it with a retention error rather than a probe error; and the
  `keepPreviousGeneration` field, though now truthful, still invites a caller to
  believe the request is negotiable.
- No learner data exists in any source, fixture, test, report, log, or evidence
  file added by this phase. Every fixture is synthetic and self-describing; the
  only URL host is the reserved `example.invalid`.

#### Files

Created: `src/services/persistence/products/{fullDeviceBackup,archiveValidation}.ts`,
`src/ui/data/{DataCenter.tsx,ImportPreview.tsx,RecoveryStatus.tsx,dataCenter.css}`,
`tests/data/` (9 gates + 11 support), `tests/unit/{dataCenter,fullDeviceBackupProduct}.test.tsx`,
`tests/e2e/{dataProductsRestore.spec.ts,data-products-lane.ts,data-products-lane.test.ts}`,
`playwright.data-products.config.ts`, `scripts/build-flagged-data-products.mjs`.
Modified: `src/services/persistence/v2/archive.ts`, `src/ui/screens/WelcomeScreen.tsx`,
`src/store/progressionStore.ts`'s consumer surfaces, `eslint.config.js`,
`package.json`, `tsconfig.node.json`, `.gitignore`, `README.md`,
`.github/workflows/ci.yml`, and ten pre-existing test files (Phase 4's
`qaHardening`, Phase 4's `storage-v2-lane` pair, and six `tests/data/` rails plus
`localDownloadOnly` and `suiteIntegrity`).

#### Rollback

Hide the tab and disable import; the format is additive. Concretely: with
`VITE_DATA_PRODUCTS_V2=false` the Data Center never renders and the product's
chunks are never fetched, the legacy import/export path is untouched, and no
`.kdbak` is read or written.

**CORRECTED 2026-09-27 — the original claim in this section was false.** It read
"Because retention is unconditional, a device that has already restored a backup
keeps its previous generation readable, so the rollback loses nothing." Retention
*is* unconditional and the previous generation *is* still readable **by id**, but on
the next boot the legacy migration stages a fresh generation from the `localStorage`
mirror and flips `activeGeneration` over it — so **no reader follows the restored
generation at all**, and the restore's effect becomes invisible. The rollback
therefore *does* lose the restore. See "A cross-phase durability defect" in the
Phase 7 evidence for the measured mechanism, the three affected products, and the
fix. Do not rely on the original wording.

### Unlocks

Phase 6.

---

## Phase 6: Individual Subject Backup Product

**Status:** complete
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

### Verification evidence

Recorded on 2026-09-27. The maintainer explicitly accepted the verified checkpoint on
2026-09-27, so Phase 6 is `complete`. Phase 7 remains `not-started` and requires
separate authorization.

#### What was built

- **`.kdsubject` export and import** in `src/services/persistence/products/subjectBackup.ts`,
  and `idRemapping.ts` for copy-mode identifier remapping as a pure, standalone
  function. The layout is the plan's §7.3 layout unchanged: `manifest.json`,
  `subject.json`, `progression.json`, `sessions.json`, `assistance.json`,
  `attachments/<sha256>`. Attachment members are content-addressed, so two identical
  payloads collapse to one. The `fflate` codec, the archive-member vetting, the
  prototype-name rule, the manifest checksum format, the per-record validators, and the
  `MIGRATION_BLOCKING_POLICY` refusal rule are all **reused** from Phase 5 rather than
  forked. Fish live inside `ProgressionRecordValue.bySubject[...].fishCollection`, so
  `progression.json` carries them, and a gate proves it rather than asserting it.
- **A staged, never-in-place import.** A subject import is a *partial* generation
  change, unlike Phase 5's whole-generation replace, so plan §5.2's "never partially
  overwrite the active data generation" and §7.1's pointer model are satisfied by
  reading the active generation, carrying every unrelated record over byte-for-byte,
  staging a new generation, comparing counts/relationships/checksums, validating,
  activating, and retaining the previous generation unconditionally. `putRecords` on
  the live generation appears nowhere; `discardStagedGeneration` runs on every failure
  path.
- **Manifest**: a closed 13-key set with no identifier of any kind, three separate
  version contracts each refused on its own and cross-checked between the manifest and
  all four documents, and a content-free constant file name.
- **Data Center subject-backup tab** in `src/ui/data/{SubjectBackupTab,ConfirmDialog,productAccess}.tsx`,
  alongside a real two-tab tablist, a shared confirmation dialog, and both new
  disclosure surfaces rendered. Reached by lazy `import()` only.
- **Verification rails**: 8 new gates in `tests/data/` (the suite is now 18 files /
  192 tests), an independent 11-file / 110-test suite in `tests/phase6/` sharing no
  code or fixture with the phase's own, and a committed Playwright lane
  (`playwright.subject-product.config.ts`, port 43181, 5 tests) with a gating CI step
  inside the existing `storage-v2-browser` job so the flagged artifact is still built
  exactly once.

#### The phase was not acceptable on its first pass

`qa-engineer` reviewed it adversarially and returned **not acceptable** with a CRITICAL
finding that refuted an exit criterion. The orchestrator reproduced the root cause in
the source before acting on the report.

- **BLOCKER — a cross-device replace destroyed another subject's entire progression.**
  `ProgressionRecordValue` carries both `subjectId` and `bySubject`, and the canonical
  legacy v3 shape is a *single* envelope whose `bySubject` map held every subject on
  the device. The replace filtered on `record.subjectId !== target`, so a record whose
  `bySubject` also held a bystander's notes, fish, XP and streak was dropped wholesale
  and replaced with the archive's — which, from a *different* device, carries only the
  exported subject. `BETA`'s subject record survived, `BETA`'s sessions survived, and
  `BETA`'s progression ceased to exist anywhere, with nothing reported: the
  `destroyedRecordCounts` unit is *records*, and a bystander vanishing from inside one
  record is invisible to it. The on-device path was masked by luck, because a same-device
  export carries the foreign entry. Plan §5.3's "Same-ID imports can overwrite subjects
  while leaving stale progression" is the defect class, and the product was reproducing
  it. The fix is a `bySubject`-aware merge in both modes: the target's own key is the
  archive's wholesale, a foreign key is never destroyed and never merged, a conflict
  keeps the device's newer value, and all three outcomes are counted. QA then attacked
  it seven ways, including the direction of loss, and confirmed that a dirtied target is
  still replaced wholesale while a bystander in the *same record* survives.
- **HIGH — a copy import forked another subject's fish and note identities.** The
  foreign `bySubject` key was carried verbatim correctly, but the *nested* fish/note/loot
  ids inside every key were rewritten, so the device ended up holding two identities for
  one fish, and `progressionEnvelopeFrom`'s last-writer-wins flatten picked between them
  by **sorting on a minted opaque subject id**. The winning record was an accident of
  ordering, chosen by neither the learner nor the product. Now scoped to the key being
  remapped.
- **HIGH — the storage-v2 checksum chain was blind to attachment bytes.** Phase 5 had
  already recorded this exposure; Phase 6 is the first product to lean on the *generation*
  checksum comparison for a **partial merge**, which is what made it load-bearing.
  `canonicalJsonStringify` had a `Uint8Array` branch and no `ArrayBuffer` branch, so a
  blob's bytes serialised as `{}` and two generations differing only in attachment bytes
  shared a `contentChecksum`. Fixed with a realm-safe digest form plus a validator that
  recomputes `sha256(bytes)`. QA upheld the decision not to bump the generation format
  (value shape unchanged, checksum is derived state, no generation has shipped) after
  confirming no code path compares a retained generation's *stored* checksums against a
  current-rule recomputation — the rollback path reads records, not their historical
  checksums.
- Three smaller findings: `relativePath` was protected on a **false premise** (the
  Electron writer puts a room id in it as a whole path segment); the residual-reference
  count was documented as covering ids in object *keys* when it does not; and
  `DungeonMetadata.dungeonId` was an undeclared subject-id location. All three are fixed
  or, for the second, corrected to tell the truth about an accepted gap. A fourth, the
  product's own doc comment claiming the sanitized preview cannot name the archive's
  subject, was false whenever there is a disclosure; the same false claim in the tab was
  corrected too. The disclosure itself was ruled **acceptable** — it is Phase 5's own
  `ExternalOnlyAttachmentReport`, §7.3 requires reporting *which* attachments are
  unavailable, and it carries no name, topic, note, filename or URL.

Two gate assertions became *weaker by one step* when the tab landed, because "the Phase 6
modules are absent from the application graph" stopped being true for the good reason. QA
upheld the replacements after planting a **canary static import** and confirming five
gates — including its own — turn red, then reverting. The replacements state the real
property ("no `static`/`require` edge from outside the product tree, and exactly two
named `dynamic` callers"), and the "exactly two" clause is *stronger* than the absence
assertion ever was, because it also fails if a third legitimate lazy caller appears.

#### Commands run and results

The orchestrator ran the common gate, the phase-specific gates, all three browser lanes,
and the rollback path independently.

| Command | Result |
| --- | --- |
| `npm run lint` | pass, 0 errors 0 warnings |
| `npm run typecheck` | pass |
| `npm test` | pass — 125 files / 1673 tests, 0 failures (Phase 5 baseline 103 / 1422) |
| `npm run test:data` | pass — 18 files / 192 tests (baseline 9 / 99) |
| `npm run test:privacy` | pass — 6 files / 34 tests |
| `npm run test:migrations` | pass — 15 files / 373 tests |
| `npm run build:web` | pass |
| `npm run check:bundle-size` | pass — `Total dist size: 4.38 MB across 134 files` |
| `npm run test:e2e` | pass — 12 tests across the four Chromium viewports |
| `npm run test:e2e:data-products:full` | pass — 4 tests, Phase 5 fresh-profile restore |
| `npm run test:e2e:subject-product:full` | pass — 5 tests, the new Phase 6 lane |

#### Exit-criteria evidence

- **A copied subject is independent and fully usable.** The same `.kdsubject` imported
  **twice** onto one device — the strongest form, since the first copy's ids are then on
  the destination — yields 5 subjects with all eight identifier classes pairwise
  disjoint, and the two copies' minted ids disjoint from each other. Every declared
  reference resolves *inside* its own copy: rooms keys against their own `roomId`, root
  room, all four `DungeonMetadata` room references, `tagIndex` values, `notePath` and
  `artifactPath` whole segments, `roomsVisited`, `collectedNotes`, fish `subjectId`,
  snapshot attachment ids, and blob records against their metadata hashes. Mutating the
  source afterwards — topic, note path, root room, a new room — leaves the copy
  byte-identical. The copy is then read back, **exported again**, and that
  second-generation archive re-imported as a third working subject. Proven in a real
  browser too: real IndexedDB, a second fresh context, disjoint subject and room ids,
  XP carried, the source device unchanged.
- **A replaced subject matches the backup semantically.** Proven after first *destroying*
  the device's copy, so the comparison cannot pass vacuously: ids preserved
  (`idMapping === []`, `identifiersRemapped === 0`), the record verbatim, progression
  `bySubject` deep-equal, every session and attachment byte-equal, blob bytes equal to
  the real bytes with `storedAt` re-stamped. The refusal ladder holds with the device
  byte-identical after each: unconfirmed replace, no target, a target that is not the
  archive's subject, a target the device does not hold.
- **No unrelated subject or global setting changes.** **This criterion was refuted once
  and now holds.** Every unrelated store is carried forward byte-for-byte; a refused
  import leaves the whole device fingerprint — pointer, every record value *and its
  bytes*, every descriptor, ordered legacy `localStorage` — byte-identical, and a
  fingerprint is proven able to move on a single flipped byte. The bystander-progression
  loss described above was the one real escape and is closed, attacked seven ways,
  including two and three replaces in sequence (still byte-identical, every generation
  still validating). The one **deliberate** deviation is disclosed rather than hidden:
  the new generation carries no `migrationReceipts`, because a receipt is a statement
  about the generation that holds it and storage-v2 refuses a generation whose receipts
  name another. The previous generation retains them byte-for-byte, and no receipt is
  minted for an import, following the Phase 5 precedent that `fromStorage` is typed
  `'legacy-localstorage'`.
- **All ID references remain valid after copy import.** Proven for all 25 declared
  locations plus the whole-token sweep of every remaining string. Two **disclosed**
  limits: an id held in an undeclared object *key* is carried verbatim and, by design,
  not swept and not counted (the header says so); and `relativePath` addresses a file in
  the Electron `userData` tree the copy did not move, so it is carried verbatim *and
  disclosed* through a new count-only `verbatimDisclosures` channel. No field in the
  current domain holds a real reference in an undeclared key.

#### Gates beyond the exit criteria

- **No learner data** in the manifest, member paths, file names, error details,
  disclosures, or reports. Six markers planted as subject name, room topic, note,
  attachment file name, alt text and tag, hunted in the manifest bytes, every leaf at
  every depth, every member name, the download file name, the export result, the whole
  serialised import result, and **every refusal** across the corruption matrix. The only
  URL host anywhere is the reserved `example.invalid`.
- **Default build genuinely unchanged, and the rollback path measured.** With
  `VITE_DATA_PRODUCTS_V2=false` a fresh Chromium context on Welcome issued **14
  requests, none of them a product chunk**, and `.kd-data-center` was **not in the DOM**
  with only the 7 shell tabs present. No product code marker appears in any of the nine
  files `index.html` names, including the `nomodule` legacy entry, whose static closure
  reaches no product or storage chunk.
- **Accessibility, measured independently in Chromium.** Zero axe violations on the
  subject tab itself, with and without the open confirmation. Both Data Center tabs
  measure 44.0 px and 45.7 px with `min-height: 44px` resolved, and no control inside
  `.kd-data-center` is under 44 px. Dialog: `role="dialog"`, `aria-modal`, labelled and
  described, initial focus inside, **12/12** Tab and Shift+Tab hops contained, Escape
  closing, focus restored to the opener. Tablist and mode radio groups both
  arrow-key-operable. `prefers-reduced-motion` yields 0 animated elements in the
  subtree. Zero horizontal overflow at 320, 480 and 640 px.
- **The destructive path is unreachable by accident, in layers.** The mode group is
  disabled unless the archive's own subject id exists on this device; the choice lives
  *inside* the dialog and is re-asserted to `copy` on every file choice; the confirm
  handler re-checks `mode === 'replace'` in the handler, not only in `disabled`; there is
  no `<form>`, no text field and no key handler on the file input; and in copy mode none
  of the product's three destructive fields is even in the request. A browser run measured
  the copy radio `checked` on open and the replace radio never checked, and the replace
  radio disabled on a fresh profile and enabled on one holding the archive's subject.
- **Determinism.** Byte-identical under a fixed clock, proven in the ZIP DOS headers at
  a date the wall clock is not at. The limitation is disclosed and is inherent: a DOS
  timestamp is local time, so determinism is per-timezone while the *content* is
  deterministic everywhere.

#### Performance and bundle result

Raw default `dist` is **4,596,884 bytes across 134 files**, against the Phase 5 baseline
of 4,463,882 / 132: **+133,002 bytes (+3.0%)**, +2 files — the new product chunk and its
`-legacy-` twin.

**The default build ships the Phase 6 product without ever loading it**: 277,629 bytes
raw across 9 product chunks, because the guard is a runtime `if` rather than a
build-time `define`. The arithmetic decides it against the plan's budgets — 6.0 % of the
raw `dist` ceiling, and not "initial" at all, as the measured 14-request trace shows. A
byte ceiling in the product-chunk gate was raised from 200 KiB to 320 KiB; QA upheld it
only after confirming the new direct property assertion is load-bearing and
non-vacuous, and after closing a real gap the implementer left — a rename of any of the
five source markers would have made the assertion silently check nothing.

#### Known limitations and evidence boundaries

- **Replace fidelity has no browser evidence.** The lane deliberately does not drive the
  destructive mode, because an unattended test performing a destructive replace against a
  seeded device has "the test destroyed its own fixture" as a failure mode. That path is
  covered against a real repository in `tests/data` — which is exactly where the blocker
  lived.
- **The 320 px overflow is real, and it is pre-existing Welcome shell, not Phase 6.**
  The first report attributed it to the Data Center; QA could not reproduce it, and the
  cause turned out to be **subject-name length** — `#welcome-panel-subjects` has a 299 px
  min-content in `.welcome-main`'s flex row, giving 367 px of overflow at 320 px with a
  78-character name and **0 with a short one**. Both engineers then reproduced it
  independently, on the flag-off build where the Phase 6 tab does not exist, with the
  overflow identical whether or not the Data Center is open. Plan §10.1's 320 px
  requirement is therefore **not met by the application as a whole**. On acceptance the
  maintainer routed this to the Welcome-surface owner as a **tracked follow-up outside
  Phase 6** (plan §12 rule 13), rather than deferring it to Phase 21, so it is fixed and
  gated before the later accessibility audit depends on it. **The first fix was
  incomplete**, and only the first CI run after acceptance proved it — see the follow-up
  record below.
- **Copy mode doubles the device-global assistance store, unboundedly, and the counters
  report 0 while it happens.** Each copy import appends the archive's whole assistance
  store with minted ids, as byte-identical duplicates with no natural key to deduplicate
  on; a device that takes N copies holds N+1 records. The *behaviour* predates the fix;
  what the fix made worse is that `foreignState`'s assistance counters read 0 and
  `carriedForwardStores` omits `assistance`, so a reader concludes the store was
  untouched. No data is destroyed and nothing on the device changes, so this is not an
  exit-criteria blocker — but it breaches plan §12 rule 10's idempotence, it matters at
  Phase 19 where that store starts being read for behaviour, and **the counters must not
  report 0 for something that happened**. Named follow-up before Phase 19.
- **One LOW reporting imprecision:** a stale `DungeonMetadata.dungeonId` is counted in
  both `verbatimDisclosures` and `unresolvedReferenceCount`, so a screen adding the two
  over-counts by one. Each channel's documented meaning is individually true. No data
  effect.
- **One INFO copy defect in `RecoveryStatus.tsx`:** the preserved-assistance sentence
  reads "1 … **were** kept" and drops the noun at both numbers. Every sibling clause is
  correct. No privacy, data, or accessibility impact.
- **The checksum digest form is not injective.** A plain object shaped like the
  `{"__bytes__":…}` form serialises to the same text. Harmless, and verified rather than
  assumed: no untrusted path can create it, because blobs are store records never parsed
  from an archive document and the reader builds `bytes` from ZIP member bytes; and if one
  ever reached a generation it would be refused as `blob-without-bytes` at `error`
  severity. Recorded where the module's "a checksum can never be ambiguous" claim
  otherwise holds.
- **All browser evidence is emulated Chromium on Linux**, one viewport, against the
  flagged build. No Firefox, WebKit, Edge, ChromeOS, or physical device. The plan's §10.4
  manual checks — a Chromebook with ChromeVox, an iPad or Android touch screen reader, a
  macOS Safari check — remain outstanding and stay assigned to Phases 21 and 23. Nothing
  here is VoiceOver, NVDA, or ChromeVox evidence.
- **Not verified:** memory across world mount/unmount cycles (out of scope, Phase 22);
  two-tab, concurrent-writer, quota exhaustion and blocked `versionchange` behaviour; the
  real-device behaviour of the Electron attachment path; and the corrupt-archive matrix
  in a browser, since the lane refuses three hostile inputs while the 22-name matrix and
  the consistently-corrupt family are `tests/data` only. The implementer's 22 new
  regression cases were confirmed to exist, be registered, and pass, but were not
  independently re-derived assertion by assertion — QA's own 13 cases in the same area
  are the independent check on the *behaviour*.
- **No learner data** exists in any source, fixture, test, report, log, or evidence file
  added by this phase. Every fixture is synthetic and self-describing.
- The product's filter-and-replace import was **not** the accepted design; the
  `bySubject`-aware merge in `mergeProgressionForReplace` and `mergeAssistanceForReplace`
  is, and both are exported and pure so the rule can be tested directly.

#### Files

Created: `src/services/persistence/products/{subjectBackup,idRemapping}.ts`,
`src/ui/data/{SubjectBackupTab.tsx,ConfirmDialog.tsx,productAccess.ts}`,
`playwright.subject-product.config.ts`, `tests/data/support/{nastySubject,subjectArchive,sharedProgressionDevice,importGraph}.ts`,
8 `tests/data/subject*.test.ts` gates, `tests/unit/subjectBackupTab.test.tsx`,
`tests/e2e/{subjectProductRoundTrip.spec.ts,subject-product-lane.ts,subject-product-lane.test.ts}`,
`tests/phase6/` (11 files / 110 tests).
Modified: `src/services/persistence/products/{archiveValidation,fullDeviceBackup}.ts`
(shared seams extracted, behaviour byte-identical), `src/services/persistence/v2/{checksum,validation}.ts`
(the attachment-byte checksum fix), `src/ui/data/{DataCenter,ImportPreview,RecoveryStatus}.tsx`
and `dataCenter.css`, `src/ui/screens/WelcomeScreen.tsx`, and nine existing gates.
`src/services/persistence/v2/archive.ts` is **byte-identical to HEAD** — a change there
was started and reverted, and the codec boundary is untouched.

#### Rollback

Hide the product and remove only staged import data. Concretely: with
`VITE_DATA_PRODUCTS_V2=false` the Data Center renders neither tab, `.kd-data-center` is
absent from the DOM, and **no product chunk is ever requested** — measured at 14 total
requests and an empty product-chunk list. The legacy import/export path is untouched and
no `.kdsubject` is read or written.

**CORRECTED 2026-09-27 — the original claim in this section was false.** It read
"Because retention is unconditional, a device that has already imported a subject
backup keeps its previous generation readable, so the rollback loses nothing." The
measured truth is worse: a `.kdsubject` copy is written to the active storage-v2
generation **only**, and on the next boot the legacy migration stages a fresh
generation from the `localStorage` mirror and flips the pointer, so the copy
disappears from every surface and is **stably lost, not a cache** — confirmed in a
real browser across two reloads. See "A cross-phase durability defect" in the
Phase 7 evidence. A failed import is still safe: it leaves a staged generation that
is discarded rather than activated.

### Unlocks

Phase 7.

#### Tracked follow-up, worked after acceptance: the 320 CSS-pixel Welcome overflow

Recorded on 2026-09-27, the same day Phase 6 was accepted. This is **follow-up work
outside the phase** under plan §12 rule 13; Phase 6 stayed closed and this was not
folded into Phase 7. Owner: `ui-engineer`, as the React DOM shell's owner.

- **The defect.** `#welcome-panel-subjects` has a **299.2 px min-content** inside
  `.welcome-main`'s 278 px flex column, and a subject name is learner text of unbounded
  length rendered in several places on that screen. The page overflowed at 320 CSS px
  by **254 px with a 78-character name** and **527 px with a 122-character one**, with
  12 named offenders. A 29-character *spaced* name overflows 0 px, because a name with
  spaces has a min-content equal to its longest word — which is precisely why the first
  report blamed the Data Center and the second could not reproduce it at all.
- **The fix** is 72 additive lines in `src/styles.css`, scoped to the Welcome shell's
  own boxes: `min-width: 0` on the grid and flex items that carry the name, and
  `overflow-wrap: anywhere` on the controls and paragraphs that render it. `anywhere`
  rather than `break-word` is load-bearing and not a style preference — only `anywhere`
  lowers an element's *intrinsic minimum size*, and the entire defect was a min-content
  floor. The learner's name is never shortened: it wraps, every character stays readable
  and selectable, and nothing in the data changes.
- **The touch targets went with it.** The same measurement found **16** controls under
  44 px in the Welcome shell, not the 11 first reported — 35 px tabs, 31 px buttons, a
  37 px input, a 39 px select, and an 18 px `<summary>` row. `ui-engineer` judged this
  in scope because it is the same shape as the overflow fix and the Data Center already
  established the pattern, and took it to **0** across all four tabs (49 shortfalls
  before). One further rule block sets `min-height` on the skip link, which is the
  first focusable control a keyboard learner meets.
- **The gate is committed and has real teeth.** Two tests in
  `tests/e2e/currentBuild.spec.ts`, which the existing `browser-smoke` CI job already
  runs against the shared production artifact, so **no new build and no new project**:
  the four matrix-sanctioned Chromium projects narrow the viewport *inside* a test,
  because a project's job is to supply the engine and the plan names the width. Both
  traps that produced the earlier misdiagnosis are closed in the test rather than by
  discipline — the wait refuses a zero-width element, the page is settled before every
  reading, a **forced offender is injected before each reading and must be reported**,
  and the sweep must have measured more than 50 elements so an empty pass cannot occur.
  `tests/e2e/welcome-narrow-viewport.test.ts` adds 10 wiring tests, including that the
  sanctioned project set is still exactly the original four.
- **Independently verified by the orchestrator**, not taken on report: reverting
  `src/styles.css` to `HEAD`, rebuilding, and re-running turns **both** tests red with
  the defect measured in the failure message — `scrollWidth 574 exceeds clientWidth 320`,
  12 offenders, `Expected: 0 / Received: 254`, and 16 named sub-44px controls. Restoring
  the file turns them green again. The gate fails on the unfixed layout and passes only
  on the fix.
- **A number that was wrong in both directions and is now settled.** The originally
  reported 53 px at 29 characters does not reproduce on the current build; the 299.2 px
  min-content is real but is the *empty-device* floor, and the fix collapses it to 278,
  so the fit is now structural rather than coincidental on page padding. The load-bearing
  cases are the unbreakable 78- and 122-character tokens.
- **Deliberately left tracked:** the rest of the application shell's touch targets (HUD,
  room panel, modals, settings, note editor) are unmeasured and very likely have their
  own 35 px controls — that is a larger audit belonging with the Phase 8 visual system;
  `.kd-data-center .kd-technical summary` declares `min-height: 32px` below §10.1, read
  from the stylesheet and not measured, because it renders only after an import outcome
  that no automated lane reaches; browser `Ctrl+=` zoom is not driven, though a 640 CSS-px
  window yields a 320 CSS-px layout viewport so the gate covers that half of §10.1 by
  identity; and a 122-character *spaced* name was not tested, the token cases being
  stricter.
- Gate result after the fix: `npm test` **126 files / 1683 tests**, `test:data` 18 / 192,
  `npm run test:e2e` **20 passed** (12 before), `check:bundle-size` 4.39 MB / 134 files,  and on a freshly built flagged artifact `test:e2e:storage` 9, `test:e2e:data-products` 4,
  `test:e2e:subject-product` 5. The Phase 6 product lanes are unaffected by the shell
  change, which is what the one-artifact-per-run discipline is for.

#### The gate was not sufficient, and CI proved it

Recorded 2026-09-27, after the phase was accepted and the branch pushed. The claim
above — that the 320 CSS-pixel requirement was met — **was not true when it was
written**, and the first CI run on the branch is what established that. Both
corrections are recorded here rather than left in the pull request, because an
evidence record that overstates what was verified is worse than one that admits a
gap.

- **The first fix did not remove the font dependence, and the gate could not see
  that.** The gate passed locally in all four projects and failed on CI in all four,
  on the *no-subject* case, with `documentElement.scrollWidth 336` against
  `clientWidth 320` and the biome select at 198 px as the widest offender. A native
  `<select>`'s intrinsic min-content width is its widest `<option>`'s **rendered text**,
  so it scales with the font's average character width: measured at 320 px the select
  is 182–188 px under Inter, Times and Arial giving zero overflow, and 207 px under
  monospace giving 26 px, with the runner's 198 px between this machine's 188 and
  monospace's 207. The biome row — a `white-space: nowrap` label plus a `flex: 1`
  select inside a grid whose single implicit column is `auto` — meant the row's
  min-content became the **track** floor, which the first fix's `min-width: 0` could
  not reach. `overflow-wrap: anywhere` was never involved: there is no long text in
  that case. **This is learner-facing rather than a CI artifact**, because plan §2.4
  keeps remote Google Fonts until Phase 8 and so every learner is on a system font
  stack today; the gate passed locally only because this machine's fallback is narrow
  enough.
  Two candidate fixes were measured and rejected first: `select { min-width: 0 }` is a
  **no-op** here, because the floor is the track and not the select, and
  `max-width: 100%` is circular, resolving against a parent that the select itself
  sizes. The fix clamps every single-column grid track in the shell to
  `minmax(0, 1fr)`, removes `nowrap` from the biome label, and clamps the `repeat()`
  card tracks with `min(100%, N)` — a `minmax(Npx, 1fr)` floor is likewise unreachable
  by `min-width: 0` and was the same latent bug one media query away. A
  `.welcome-field-grid` class exists because `grid-template-columns` cannot be
  expressed as an inline style, and a wiring gate fails if anyone inlines the property
  or drops the class.
- **The gate is now font-deterministic**, which the first version was not: it
  reported on whatever fonts the host happened to have, which is exactly why it
  passed here and failed there. It now measures six declared metric sets, all naming
  generic families so they resolve on any host, as a cross product with the subject
  name lengths — 30 readings per project — and one set is deliberately the *narrow*
  control so the sweep cannot pass by asserting only that everything blew up. The
  forced-offender control, the settle logic, the greater-than-50 measured-element
  guard and the no-subject case are all kept.
- **Independently verified beyond the declared matrix:** zero overflow and zero
  offending elements at 320 px under monospace 26 px and 32 px, fonts substantially
  wider than any in the sweep, with the select settling onto its 44 px floor.
- **A limit found while verifying, recorded rather than hidden:** at **240 px**,
  *below* the width §10.1 names, overflow returns — 37 px as-shipped and up to 78 px
  under monospace 32 px. The 320 px requirement is met with real headroom, but the
  layout does not keep scaling below it.
- **An ablation that corrects the earlier claim.** Removing `overflow-wrap: anywhere`
  restores 527–1299 px of overflow even as-shipped, so **that** rule was carrying the
  original 78/122-character defect and `min-width: 0` was not. The earlier record
  credited both. `min-width: 0` is kept as an independent second barrier and is not
  claimed to be currently required. Separately, the select's `min-width: 44px` is
  load-bearing for the **touch target** rather than the overflow: without it the
  select collapses to 26 px in a state that has **no overflow at all**, which the
  overflow gate alone could never have caught.

#### A second gate defect, found by the same CI run

The Unit Tests job failed on the first push with `125 passed | 1 failed`, all seven
failures in `tests/phase6/lazyBoundary.test.ts`, as `ENOENT` on `dist/assets` and
`dist/index.html`. `dist` is gitignored, so a clean CI checkout has no `dist/`, and
`assetNames()` called `readdirSync` unguarded behind an `expect(HAS_BUILD).toBe(true)`.
The comment above that assertion read *"Stated rather than skipped, so a run without
a build cannot report a pass it did not earn"* — the intent was right and the code did
the opposite: on a checkout with no build it **failed**, which is how it skipped.

The direction is safe, and the distinction matters: unlike Phase 5's privacy gate,
which was green locally for the wrong reason, this one was **red on CI and green
locally**, so it never produced a false pass. But it blocked `Web Build and Bundle`,
`Browser Smoke`, the storage-v2 flagged build and all four compatibility lanes, so
the built-artifact properties it exists to check were not verified on CI at all.

The fix follows the precedent `tests/phase5/seam.test.ts` already set — guard on
`existsSync`, assert a **positive statement** about the observed state, and return —
and keeps the original intent, which the precedent alone does not deliver: the absence
is **proved to be the gitignore rule's doing** by parsing the pattern out of
`git check-ignore -v`, that assertion is itself shown to **discriminate** by running
the same call against a tracked file git must report as not ignored, and the absence
is stated once per run with counts and its cause so "there was nothing to measure"
becomes a stated fact with a stated cause rather than an unexamined pass. The five
marker presence check that closes the real gap left by the raised byte ceiling keeps
all three of its assertions verbatim. Verified under both conditions — `dist` present
and `dist` moved aside — and with a **negative control**: with the product chunks
deleted from `dist`, three assertions still fail, so the guard suppresses exactly the
absence of a build and nothing else.

#### Three environment-dependent gates, and what that pattern is worth

Phase 5 shipped a gate that was green locally for the wrong reason. This phase
produced three that were **red on CI and green locally**: the two above, and the
font-metric overflow. All three failed in the safe direction — in the environment that
actually matters, rather than passing quietly where it did not — and all three found
either a real defect or a real gate defect. None produced a false pass, and none can
now: the two gates are guarded with stated absences and proven non-vacuous, and the
layout gate measures a declared font matrix instead of the host's fonts. The remaining
exposure is the recorded one: browser evidence here is emulated Chromium on Linux, and
the physical-device checks in §10.4 stay assigned to Phases 21 and 23.

#### CI evidence

- Branch `phase-6-subject-backup`, PR #56. First run `36303051250` failed Unit Tests on
  the gate defect above. Second run `36304039100` failed `Browser Smoke (Chromium
  Matrix)` in all four projects on the font-metric overflow, and passed the other nine
  jobs. Third run **`36306567000` passed all ten**: Lint, Typecheck, Unit Tests, Web
  Build and Bundle, Browser Smoke (Chromium Matrix), Browser (Storage v2 Flagged
  Build), and the four representative compatibility lanes for Linux/Chromium,
  Linux/Firefox, macOS/WebKit and Windows/Edge.
- The product's own gates are unchanged by any of the three fixes. After the final
  one: `npm test` **126 files / 1690 tests** (the font matrix adds seven wiring-gate
  tests), `test:data` 18 / 192, `npm run test:e2e:recorded` **20 passed**,
  `check:bundle-size` 4.39 MB / 134 files, and on one freshly built flagged artifact
  `test:e2e:storage` 9, `test:e2e:data-products` 4, `test:e2e:subject-product` 5. The
  tabpanel track change touches the box the Data Center mounts inside, so the product
  lanes were re-run rather than assumed.
- Default `dist` is 4,598,462 bytes across 134 files.

---

## Phase 7: Blank Reusable Template Product

**Status:** complete
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

### A cross-phase durability defect found in Phase 7 review

Recorded 2026-09-27, during Phase 7 verification. This is **not** a Phase 7 defect;
it is a Phase 4 seam that Phase 7 exposed, and it invalidates recorded claims in the
Phase 5 and Phase 6 evidence, which are corrected in place above. It is recorded here
because Phase 7's review is where it was found and measured.

**The defect.** A write that reaches the active storage-v2 generation **only** is
silently discarded on the next page load. The boot path runs the legacy migration on
**every** boot. On a fresh device the first boot takes the `no-source-data`
short-circuit and `ensureInitialGeneration` creates a generation whose `source` is
`initial`. On the second boot the device *has* `localStorage` content, so the
already-migrated guard — which requires an existing generation with
`source === 'legacy-migration'` **and** a `LEGACY_MIGRATION_ID` receipt — does not
fire. The migration therefore **stages a brand-new generation from the stale
`localStorage` mirror, validates it, writes a receipt, and flips `activeGeneration`
to it**, superseding the generation the product wrote into. No reader follows a
superseded generation, so the product's write is invisible.

**Measured, by the orchestrator independently of the reviewer, in Chromium against
the flagged build:**

| stage | active pointer | `gen-initial-0001` |
| --- | --- | --- |
| boot 1, fresh profile | `gen-initial-0001` (`source: initial`) | 0 subjects |
| a subject is created through the Welcome form | `gen-initial-0001` | 1 subject |
| **boot 2** | **`gen-migration-0001`** | **`superseded`**, 1 subject stranded |
| boot 3 | `gen-migration-0001` | `superseded` |

**It affects all three data products**, confirmed by the reviewer in a browser on the
same build:

- **`.kdtemplate` (Phase 7)** — an imported template subject is listed in-session and
  gone after one reload, stably, with no UI route to recover it. Exit criterion 4,
  "templates import into Creator state with blank notes", therefore holds **in-session
  only**.
- **`.kdsubject` (Phase 6, already accepted)** — a "Create copy" subject is lost
  identically on reload.
- **`.kdbak` (Phase 5, already accepted) — the worst case.** A restore is silently
  *undone* on the next load: the active generation reverts to the one built from the
  pre-restore mirror, so **a subject the learner deleted by restoring comes back**.

**Why it survived two accepted phases.** No browser test created a subject through
the Welcome form, performed a product write, reloaded, and asserted the subject was
still listed. The unit gates read the active generation directly, which is exactly
the generation that later gets superseded, so they cannot see it.

**Ownership and the fix.** Plan §7.1 step 7 makes the dual-write obligation Phase 4's,
and the files are Phase 3/4 (`src/services/persistence/v2/migrations.ts`, and possibly
`bootstrap.ts`). Owner: `core-logic-engineer`, Phase 4. Two defensible options:

- **Option A (smaller, recommended):** make the migration's idempotency guard recognise
  an already-migrated **device** rather than an already-migrated **generation id** — if
  a `LEGACY_MIGRATION_ID` receipt exists anywhere in the registry, re-running must be a
  no-op, which is what the existing guard already intends but cannot express because it
  keys on `generationId`. One condition, touches no product, fixes all three at once.
- **Option B (broader):** route the storage-v2 product writes through `writeThrough`
  in `subjectPersistence.ts`, as `saveSubjectSnapshot` already does, restoring §7.1's
  dual-write for every product at the cost of re-opening the legacy mirror Phase 4
  narrowed on purpose.

**Mandatory regression test for whoever fixes it:** a browser test that creates a
subject through the Welcome form, performs each of the three product writes, reloads,
and asserts every subject is still listed — plus a `.kdbak` restore case asserting a
deleted subject does **not** come back. It does not exist for any of the three.

**Status: FIXED on 2026-09-27, on the maintainer's instruction, and independently
re-verified.** See the Phase 7 verification evidence below. The two corrected rollback
sections above are the durable record of what the claim was and why it was wrong.

### Verification evidence

Recorded 2026-09-27. The maintainer explicitly accepted the verified checkpoint on
2026-09-27, so Phase 7 is `complete`. Phase 8 remains `not-started` and requires
separate authorization.

#### What was built

- **`.kdtemplate` is JSON, not an archive.** §7.3 opens "**JSON** containing only:",
  and the "audited library, do not hand-roll ZIP" sentence constrains the two products
  that *are* archives. No codec was added and no dependency was added. `archive.ts`'s
  header wrongly claimed to serve three products and is corrected, with a gate now
  enforcing the absence. To make "no ZIP" structural rather than documentary,
  `isPrototypeMemberName` moved into a new leaf, `v2/prototypeNames.ts`, so the product's
  closure cannot reach `fflate`; `archiveValidation.ts` and `archive.ts` both re-export it,
  so no existing import path and no Phase 5/6 behaviour changed.
- **The format is an allowlist, not a denylist.** The exporter reads exactly six things
  from a snapshot — room topics, approved tags, and the four graph fields — and there is
  no `...room` spread and no walk that copies an un-enumerated field. A denylist would
  be the wrong shape here, because plan §7.3 requires the `.kdbak` import to *preserve
  unknown app-owned fields*: a denylist would carry every unknown field into a
  shareable file, invisibly, because the field would look like one the build knows. The
  Phase 0 unknown-fields fixture is re-identified, each field carrying a distinct
  marker.
- **Rooms are addressed by array index, never by id.** That is the "no original IDs"
  mechanism, not a filter. Room order is a function of content — BFS from the root,
  siblings by `(topic, tags)`, then unreachable rooms, then a residual tiebreak.
- **Approval is a falsifiable step, not a claim.** `approvedTags` and `approvedBiome`
  are parameters with no self-supplying default, and a room's own tags are intersected
  with the approved list, so an unapproved tag cannot reach the file even by accident.
  The export result carries the exact normalised list that is *in the file* — a
  measurement of the document rather than a boolean the reader cannot check.
- **The cutover.** `WelcomeScreen.tsx` was the only caller of the legacy leaking
  `exportSubjectAsTemplate` / `createSubjectFromTemplate`; it now has none, and the
  product *refuses* a legacy document whole rather than half-importing one. The legacy
  pair is retained verbatim for the documented rollback, with both function bodies
  byte-identical to `8eb2587`. Delegation was rejected for a real reason: a static
  import would make the product eagerly reachable and break its own boundary gate, and
  a dynamic import cannot serve two synchronous functions whose only caller this phase
  may not change.
- **`SubjectTemplateTab.tsx`**, the third Data Center tab, with the browser finding two
  real defects: a first-run device with no subjects crashed the whole Data Center
  (`found[0].subjectId` on an empty list — jsdom never saw it because every fixture
  stages subjects), and a bounded room list dropped the root topic because ordering by
  topic put `room topic N` before `root`.

#### The phase was not acceptable until the cross-phase defect was fixed

Independent review (`tests/phase7/`, 9 files / 95 tests, no shared code or fixture with
the phase's own gates) could not break the exporter, the importer, the format, or the
privacy claims, and proved the first three exit criteria. It found the fourth held
**in-session only**, and traced it to the cross-phase durability defect recorded above.
The maintainer ordered that fixed before accepting the phase.

#### The durability fix

`decideDeviceMigration(evidence)` is a pure exported function. The rule: **a device
holding a reachable generation — anything whose status is not `staged` — has already
moved off the legacy keys, so re-running must be a no-op.** It is placed after
`hasNoLearnerContent` and after the existing per-generation-id guard, and before the
reclaim and stage. A new report status `already-migrated` reports `activated: false`,
`stagedGenerationId: null` and the found receipt, so a skip is never reported as a move.

The reviewer **corrected its own earlier recommendation**, and that is worth recording:
its proposed "if a `LEGACY_MIGRATION_ID` receipt exists anywhere, skip" rule **would not
have fixed the defect**, because the `hasNoLearnerContent` short-circuit writes no
receipt, so the defect device has none. The implemented rule is the generalisation that
actually closes it.

Verified independently by the orchestrator: neutering the guard and rebuilding turns
**4 of 6** tests in the new browser lane red, with the pointer moving
`gen-initial-0001 → gen-migration-0001` in every case and the `.kdbak`-deleted subject
back in the active generation. Restored, 6/6 green. The lane has teeth.

**The trade, stated rather than hidden.** Once a device holds a reachable generation the
legacy mirror is no longer migrated from. A learner who rolls back to a legacy build,
creates a subject there, and returns will keep it in the mirror, where the rollback build
finds it, and it will not be merged into storage-v2. The reviewer constructed exactly
this case and measured it, and judged the trade correct: the old behaviour "recovered"
that subject by superseding the live generation and losing every product write, so the
fix trades an unrecoverable loss of product data for a recoverable availability gap in a
rollback scenario. A device with **no** reachable generation still migrates, and the
reviewer measured the same mirror arriving in the active generation there.

**The regression test whose absence let two phases ship broken:** a committed browser
lane, `tests/e2e/reloadPersistence.spec.ts`, that creates a subject through the Welcome
form, performs each of the three product writes, reloads, and asserts every subject is
still listed and loadable — and for `.kdbak`, that a subject the restore **deleted does
not come back**. It is a gating step in the existing `storage-v2-browser` job with **no
new build**, so one-artifact-per-run still holds.

#### Exit-criteria evidence

- **A template contains no learner content, attachment metadata, or original IDs.**
  **Proven.** The document's key set is asserted for **equality** against a list written
  from §7.3 rather than from the product's own constants, at all four levels; every leaf
  is walked; 31 planted private strings appear nowhere in the file. The Phase 0 fixture
  is re-identified with fresh markers: its topics are the only topics present, and its
  `preserve-this-synthetic-*` fields, biome, ids, note, artifact, path, filename, alt
  text and URL are all absent. *No original IDs* is proven by **byte identity** across a
  different subject id, a permutation of all four room ids, reversed insertion order, and
  three disjoint id alphabets. The reviewer attacked the documented ordering residual with
  the hardest twin it could build and the bytes were still identical.
- **Imported graph structure matches the export.** **Proven** as **isomorphism**, not
  counts: the parent of every room, the relation and `createdByPhase` of every edge, and
  the root, compared once from the document and once from the minted subject. A graph
  with an orphan the root cannot reach round-trips exactly, and re-exporting the stored
  subject reproduces the file byte-for-byte.
- **Two imports create independent subjects.** **Proven** by disjointness *and*
  mutability: mutating the first import's note, name and `tagIndex` leaves the second
  intact. A generator that can only return taken ids is refused rather than used.
- **Templates import into Creator state with blank notes.** **Proven durably.** Every
  room is `Created` with empty note, null artifact, no attachments, zero review passes,
  blank SM-2 and validation defaults, and `phaseState: 'CreatorActive'`. The reviewer
  re-measured this in its **own** browser probe rather than trusting the implementer's
  lane, since the lane and the fix shared an author: **31 checks across three reloads,
  all passing**, with the pointer never moving, the imported subject present under the
  same id each time, both surfaces listing it, and a second import on the
  already-migrated device also surviving.

#### Gates beyond the exit criteria

- **Hostile input:** 45 cases, all refused with a typed `StorageV2Error`, a reason from a
  closed set — at least 12 distinct reasons observed, so a product that refused
  everything for one reason would fail — and sanitised details. Prototype-named keys were
  inserted by **raw JSON surgery**, because a JS object literal sets the prototype and
  `JSON.stringify` drops it, which would have made the naive case vacuous. The whole
  device is fingerprinted before and after all 45 and is byte-identical, with the
  fingerprint proven able to move.
- **No learner data** in the manifest, file name, error strings, or disclosure copy. The
  download name is the constant and carries no subject name, template name, or year.
  Measured in a browser: feeding the picker a file whose topic, tag, note and name are
  distinct markers, then a legacy document, then a non-JSON file, the **page never
  contains the file's topic, name, tag or note**.
- **Accessibility, measured in a real browser:** 44 px minimum on every control, **zero**
  axe violations at any impact scoped to the Data Center, a three-tab tablist with
  wrap-around and roving `tabindex`, a dialog holding focus across 14 consecutive Tab
  presses with Escape restoring focus to the opener, reduced motion honoured, and **zero**
  horizontal overflow at 320 CSS px across all six declared font metric sets — with a
  deliberately injected 900 px offender proving the sweep can see overflow.
- **Bundle:** 4.48 MB / 140 files, +91.3 KiB over the 4.39 MB / 134 baseline, all of it
  the new tab and the product's own 17.7 kB chunk plus its `-legacy` twin. The entry
  chunk's static imports are exactly runtime, types, Phaser and React; the only reference
  to the product anywhere is a `dynamic` import **inside the Data Center chunk**, and
  opening the template tab still fetches no product chunk. A flag-off build fetched 7
  chunks with no product chunk, no storage-v2 chunk and no Data Center tab at all.

#### A second evidence-integrity defect, found and fixed

The reviewer found that the **artifact-identity gate was self-referential**: the manifest
is recorded *from the same `dist`* the lane then serves, so it could not detect a stale
`dist`. A workspace holding a `dist` from an older revision with a manifest recorded from
it passed step 1 and then failed the lane, meaning a green browser lane proved only that
`dist` matched a manifest recorded from `dist` — it could not tie evidence to source.
This repository has now been bitten three times by a gate that passed for the wrong
reason, so it was fixed before this evidence was recorded.

The manifest now carries a `sha256-git-tracked-v1` **source identity** beside the
unchanged `sha256-tree-v1` tree identity, and `MANIFEST_SCHEMA_VERSION` is 2. It hashes
the **content** of `git ls-files` entries, so it is stable across a rebuild, changes when
source changes, is blind to `dist/`, `artifacts/` and untracked files by construction, and
CRLF-normalises text so a Windows lane can verify a Linux-built manifest. Commit sha was
rejected as insufficient, because a dirty worktree would report a sha that does not
describe the tree.

**Verified independently by the orchestrator:** with `dist` **byte-for-byte unchanged**,
adding one line to a tracked source file makes `verify` fail with
`source-does-not-match-recorded-artifact` and the same tree digest — proving the source
check is not a proxy for the tree hash. A **boundary worth recording**: the identity
covers *tracked* files, so an untracked source file is invisible to it. That is correct
on CI, where everything is committed, and it is why a worktree full of uncommitted work
still verifies. The precise claim is that the manifest is **not older than the current
tracked source**; nothing outside a build can prove which source produced a given `dist`.

#### Commands run and results

| Command | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | pass — **144 files / 1987 tests** (Phase 6 merged baseline 126 / 1690) |
| `npm run test:data` | pass — 25 files / 319 tests |
| `npm run test:migrations` | pass — 15 files / 374 tests |
| `npm run build:web` | pass |
| `npm run check:bundle-size` | pass — `Total dist size: 4.48 MB across 140 files` |
| `npm run build:storage-v2-data-products` | pass — entrypoint `sha256 3779df1d…` |
| `npm run record:web-artifact:storage-v2` | pass — `sha256-tree-v1 db0d846c…`, `sha256-git-tracked-v1 …` |
| `npm run test:e2e:reload-persistence:recorded` | pass — 6 tests, the new lane |
| `npm run test:e2e:subject-product:recorded` | pass — 5 tests |
| `npm run test:e2e:data-products:recorded` | pass — 4 tests |
| `npm run test:e2e:storage:recorded` | pass — 9 tests |
| `npm run test:e2e` | pass — 20 tests across the four Chromium viewports |

#### Known limitations and evidence boundaries

- **The guard's trade is part of the product's contract.** A subject created on a rollback
  build after the device has moved on is not auto-merged into storage-v2. The module
  header says so; **no user-facing surface says so.** Carried to Phase 8.
- **A corrupt `localStorage` mirror on a device that has already moved on is now silently
  ignored** rather than producing a recovery screen. The reviewer measured this and
  judged the direction correct — a recovery screen makes the bootstrap select the legacy
  repository, so the app would read the *stale* mirror — but it is a behaviour change, now
  pinned by a test so it cannot change by accident.
- **`recovery-required` is not dead but is genuinely narrowed:** every failure stage now
  sits after the guard, so it requires a device with no reachable generation. The reviewer
  injected a throw at each of seven stages and measured the path alive on that shape.
- **The `staged`-generation reclaim no longer runs on a moved-on device**, by design — a
  skip must not end in a delete — so such a device relies on `pruneGenerations` for
  storage. Carried to Phase 8.
- **The per-run evidence JSON in three specs records the tree identity but not the source
  hash.** The gate is fully enforced without it, so this is a follow-up for auditability
  rather than a hole.
- **Chromium only**, one viewport, against the flagged build. No Firefox, WebKit, Edge,
  ChromeOS, or physical device; the plan's §10.4 manual checks stay assigned to Phases 21
  and 23. Nothing here is VoiceOver, NVDA, or ChromeVox evidence. Non-ASCII, emoji, RTL
  and 400-character topics were not measured in the layout sweep, whose markers are ASCII.
- **Two-tab concurrency is unmeasured.** The new guard reads `listGenerations()`,
  `readActiveGenerationId()` and `listMigrationReceipts()` in a `Promise.all` — three
  reads that are not one snapshot. A second tab staging a generation between them could
  in principle produce a decision taken from a mixed view. The reviewer did not construct
  it and claims neither safety nor danger.
- The `.kdtemplate` specification exists as a module header and type declarations, not a
  README section, and the product has no browser lane of its own — the reload-persistence
  lane covers its durability and the data-products lane covers the tab. `.kdbak` and
  `.kdsubject` are in the same position, so this matches precedent, but Phase 7's
  deliverable list names the specification explicitly.
- **A pre-Phase-7 template file cannot be imported by the new product** — refused as
  `legacy-template-format-refused`, because that document carries exactly the forbidden
  fields. Intentional, and a learner who exported with an older build must re-export.
  Worth a release note.

#### Files

Created: `src/services/persistence/products/subjectTemplate.ts`,
`src/services/persistence/v2/prototypeNames.ts`, `src/ui/data/SubjectTemplateTab.tsx`,
`playwright.reload-persistence.config.ts`, `tests/data/support/templateSubject.ts`,
7 `tests/data/template*.test.ts` gates, `tests/unit/{subjectTemplateTab,legacyMigrationDeviceGuard}.test.{tsx,ts}`,
`tests/e2e/reloadPersistence.spec.ts`, `tests/e2e/reload-persistence-lane{.ts,.test.ts}`,
`tests/phase7/` (9 files / 95 tests).
Modified: `src/ui/data/{DataCenter,RecoveryStatus,productAccess}.tsx`, `dataCenter.css`,
`src/ui/screens/WelcomeScreen.tsx` (the cutover),
`src/services/persistence/v2/{migrations,migrationState,schema}.ts`,
`src/services/persistence/{subjectPersistence,products/archiveValidation,products/idRemapping}.ts`,
`package.json`, `tsconfig.node.json`, `README.md`, `.github/workflows/ci.yml`, and
thirteen existing test files — seven of them with in-file `RAIL CHANGE` notes that the
reviewer examined individually and judged **justified and mostly stronger**; the
`specifics` are recorded under the durability fix above.

#### Checkpoint and merge evidence

Recorded 2026-09-27.

- PR #57, branch `phase-7-template`, four commits squashed to **`f978a11`**. The
  commits are `feat:` for the product, `fix:` for the cross-phase durability defect,
  `fix:` for the artifact-manifest source identity, and `docs:` for this evidence —
  the `feat`/`fix`/`docs` split the repo has used since Phase 1.
- **Four CI failures on the way, all in the first three runs, and all of them mine or
  our gates rather than the product.** They are recorded because the count is the
  finding, not because each was interesting on its own:
  1. `36303051250` — `tests/phase6/lazyBoundary.test.ts` read a gitignored `dist/`
     and hard-failed on a clean checkout, blocking the four build-carrying jobs.
  2. `36304039100` — the 320 px Welcome gate failed in all four projects. The gate
     was right and the layout was wrong: the biome `<select>`'s intrinsic width is
     its widest option's *rendered text*, so the row's min-content became the grid
     track floor and the page overflowed on any host whose fallback font is wider
     than the maintainer's.
  3. `36339302131` — `tests/phase7/{cutover,gateDirections}.test.ts` shelled out to
     `git show 8eb2587:<path>`; `actions/checkout@v4` has no `fetch-depth` at any of
     its eight call sites, so CI's depth-1 clone did not have the object.
  4. A wall-clock flake QA found while sweeping, not a CI failure: a 5 s default
     timeout on a test that measured 0.8 s idle and 7.1 s loaded.
- **Every one was red on CI and green locally** — the safe direction, and none ever
  produced a false pass. That is a property of the failures, not of the designs: each
  gate depended on state a clean checkout does not have, and each was written by
  someone reasoning on a machine that had all of it. The ones in this PR are now
  hermetic by construction. The reliable detector for the next one remains the CI run
  itself, which is the argument for keeping the branch-and-review loop rather than
  batching phases.
- Final run `36344137351` passed all ten jobs: Lint, Typecheck, Unit Tests, Web Build
  and Bundle, Browser Smoke (Chromium Matrix), Browser (Storage v2 Flagged Build), and
  the four representative compatibility lanes.
- **The two corrected rollback sections in Phase 5 and Phase 6 are the durable record
  of what those claims were and why they were wrong.** A recorded rollback that is
  untrue is worse than an admitted gap, and the reason it was untrue is the defect
  this phase surfaced.
- Rollback for the phase itself is a source revert to `8eb2587`. **The durability fix
  must not be reverted with it:** it corrects a defect in the migration guard that
  predates every data product, and reverting it would reinstate silent data loss on
  every boot.

#### Carried to Phase 8

1. **The migration guard's trade is not stated to any learner surface.** Once a device
   holds a reachable generation the legacy mirror is no longer migrated from, so a
   subject created on a **rollback build** afterwards is not merged into storage-v2.
   It is recoverable by the rollback build, and the alternative was strictly worse —
   but the module header documents this and **no user-facing surface does**. The
   orchestrator's own first reading was that the trade was acceptable as-is and needed
   no UI; on reflection that was too quick, because a contract a learner can hit
   belongs somewhere they can read it, not in a source comment.
2. **`pruneGenerations` reliance is unmeasured.** A skip must not end in a delete, so
   a device accumulating abandoned `staged` generations now depends on pruning, and
   how often that runs in a real session was not measured.
3. **`.kdtemplate` has no README specification section**, though the deliverable list
   names it. `.kdbak` and `.kdsubject` are in the same position, so it matches
   precedent rather than departing from it.

#### Rollback

Retain the legacy template path behind the old UI until cutover — **done**. The legacy
pair is retained verbatim, both bodies byte-identical to `8eb2587`, with no application
caller. The product refuses a legacy document whole, and never writes a legacy key under
any request shape. With `VITE_DATA_PRODUCTS_V2=false` the Data Center renders no tab at
all, so a flag-off build offers **no** template feature rather than the leaking one. The
product is reached only by `dynamic` import, so no product chunk is fetched before the
tab is opened.

The durability fix is independent of the flag and is **not** rolled back with it: it
corrects a defect in the migration guard that predates every data product. Rolling it
back would reinstate silent data loss on every boot.

### Unlocks

Phase 8.

---

## Phase 8: Cozy Visual System and CC0 Media Foundation

**Status:** complete
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

### Known limitations and evidence boundaries

- **`cc0-approved` is zero, and that is the honest answer rather than a gap.** All
  90 pre-existing media files are `legacy-unverified`: 10 were imported from
  `repo-dungeon`, whose credits page names no CC0 identifier, creator, per-file
  source URL, or checksum, and 80 were first committed by in-repository feature
  commits against an MIT-licensed project. MIT is not `CC0-1.0`, so there is no
  verified grant to record, and inventing one would be a false license claim in a
  file that ships. Phase 10's bundle sets must therefore be newly authored or
  genuinely CC0; re-licensing the 90 legacy assets is a copyright-holder decision,
  not a build step.
- **A fourth classification, `repository-authored`, was added** for two
  non-media files (`CREDITS.md` and the registry itself). The plan's three classes
  are a media taxonomy, so calling an MIT-licensed repository file
  `cc0-approved` would be a false CC0 claim and calling it unverified would be
  false too. The checker enforces `media: false` on that class, and a media file
  must be one of the three plan classes.
- **`--font-game` now renders in a system stack instead of Cinzel.** Removing the
  remote Google Fonts `@import` is required by the second exit criterion, and
  shipping a font binary was not justified in this phase. The *behaviour* is
  verified (no fetch, no `@font-face`, no web-font fallthrough); whether the Cozy
  visual direction reads well in the shipping typeface is a design review that has
  not happened.
- **The reduced-motion mechanism is Cozy-scoped.** `prefers-reduced-motion` is
  fully honoured when `VITE_COZY_VISUALS=true`; with the flag off, 22 elements in
  the legacy stylesheet still transition. Phase 8's scope bullet is to *define*
  reduced-motion tokens and behavior, and un-scoping a universal `*` override onto
  a 5,900-line legacy stylesheet is the wholesale-replacement risk the phase
  non-goals avoid. The residual legacy gap is follow-up work for Phase 21.
- **`cozy-parchment` is not reachable from the settings picker.** The legacy
  `resolveInitialColorTheme` has always collapsed the persisted `light` and
  `sepia` aliases to `dark`, so no screen emits `data-theme="light"`; the
  parchment recipe is therefore in the same position as the legacy block it
  replaces. The recipe, its CSS wiring, and its worst case (4.66:1 text, 3.21:1
  non-text) are tested either way. The theme-picker owner must either expose those
  aliases as real choices or drop the recipe.
- **`borderHairline` is a documented WCAG 1.4.11 exemption, not a passing pair**
  (1.65:1 against its panel). It is the only `decorative` token and is used only on
  panel dividers; every boundary a learner must identify uses `borderControl` at
  or above 3:1. A test asserts `borderHairline` never lands on an interactive
  element.
- **The token stylesheet is a checked-in generated artifact**, not a build step.
  The token data lives in TypeScript, `src/styles/cozy-tokens.css` is generated
  from the emitter, and a test compares them byte-for-byte, so drift is a test
  failure rather than a silent divergence. A build step would remove the file from
  the drift surface.
- **The page-surface bridge needs `:has()`.** `data-theme` lives on a `.ui-skin`
  descendant while the document background is on `<body>`. Every browser in the
  plan matrix supports it; below that, the document-level Cozy surface applies,
  which is a coherent warm surface rather than a legacy colour.
- **The Welcome budget measurement excludes the `nomodule` ES5 bundle** and the
  lazy `vendor-phaser-*` and `polyfills-legacy-*` chunks. The `nomodule` bundle is
  the same application re-emitted at ES5, so counting it would count the app
  twice; counting it would put the total at about 322.6 KiB, which would need a
  plan change rather than a script change.
- **The 320-pixel and 200 % zoom gates are measured on the Welcome shell**, which
  is what the existing Phase 1 gate covers. Village, dungeon, and fishing screens
  are not exercised by either, and the Cozy 44-pixel minimum applies to
  `.ui-skin` controls on all screens.
- **No physical-device evidence.** There is no Chromebook with ChromeVox, no
  macOS Safari, no iPad or Android touch screen reader, and no Windows or Linux
  desktop in this environment. Plan section 10.4's manual device evidence is
  produced in the later accessibility, performance, and cutover phases. All
  browser evidence here is headless Chromium and is form-factor evidence, not
  operating-system certification. The Firefox, WebKit, and Edge lanes were not run
  for this phase.
- **The reduced-motion Pixi contract has no consumer yet.** `resolveMotionProfile`
  is verified as a source-level contract and by the shipped suite, but no Pixi
  host exists in this build, so the Pixi half of the plan 10.1 requirement is a
  contract awaiting Phase 9.
- **Pre-existing, not introduced here and not in scope:** `dist/index.html`
  carries a `modulepreload` for `vendor-phaser-*`, which the Phase 1 E2E test
  asserts is requested, against the plan 10.2 "no eager Phaser or Pixi load on
  Welcome" target. This belongs to the phase that owns the renderer cutover.

### Verification evidence

Recorded on 2026-09-28. The status advanced from `in-progress` to `verified`.

**Merge evidence.** PR #58, branch `phase-8-cozy-and-cc0`, two commits squashed to
`0a2ecc9`. The pull-request run `36449655352` passed all eleven jobs, and the
post-merge `main` run `36450524382` passed all eleven again, including the four
cross-engine compatibility lanes. `Deploy Web to GitHub Pages` ran `36450524329`
on the same commit. The phase was split into the two independently reversible
halves the plan implies — the CC0 media gate, which touches nothing a learner
sees, and the Cozy visual system, which is the only part a learner can see — and
each commit was verified independently by checking it out into a detached worktree
and running the gate there, rather than trusting an authoring tree.

**Three of this phase's own gates would have been red on CI.** Verifying a commit
against a clean checkout of that commit, rather than against the working tree it
was written in, is what found it, and the same defect class Phase 7's own merge
record already names had recurred. `qa-verification.test.ts` baselined the legacy
theme blocks with `git show HEAD:src/styles.css`, so once the change was committed
`HEAD` *was* the new stylesheet and the gate compared the file against itself,
finding zero changed lines in `:root` where the no-remote-font criterion requires
exactly three; it was additionally slicing at magic line offsets valid only for
the pre-Phase-8 layout, so that pass was structurally incapable of being right.
`welcome-budget-measure.test.ts` stripped only an absolute `/tmp` path while the
script prints the entry document relative to the repository root, so from any
checkout not directly under `/tmp` the per-run temp name survived and two
measurements of identical bytes compared unequal; the suite had only ever been run
from a tree under `/tmp`, so the shape CI uses was never exercised. Both are fixed
against committed fixtures with no git dependency and no path-shape dependency, two
assertions got tighter rather than looser, and `qa-hermeticity.test.ts` now guards
the class so the next one fails in the suite rather than on a run.

**One unreproduced failure is recorded rather than dismissed.** Commit one showed
four failures on one of seven clean-checkout runs and could not be reproduced in
six subsequent runs; which tests failed was never captured, because the loop that
observed it read only the summary line. It did not recur on the branch tip across
four consecutive runs, nor on either the pull-request or the post-merge `main` run,
so it is not known to affect the merged state. It is recorded because a gate that
is green on demand is not a gate, and the failure mode — a clean-checkout run
passing while an authoring tree hides a defect — is exactly the one this phase
otherwise closed.

Recorded and not fixed, because it predates this phase:
`tests/phase5/seam.test.ts` asserts a file is unmodified via
`git status --porcelain`, which is safe on a CI runner's clean tree and red in a
developer tree where that file is locally edited. It is the same defect class in
its working-tree form.

#### Baseline before Phase 8

Lint clean, typecheck clean, 1991 tests across 144 files passing, `dist` 4.48 MB
across 140 files, Welcome initial JavaScript and CSS 196.37 KB gzip excluding lazy
renderer bundles.

#### Files

- `src/theme/cozyTokens.ts`, `cozyColor.ts`, `cozyCss.ts`, `cozyScope.ts`,
  `motion.ts`, `legacyThemeMap.ts` (new); `typography.ts`, `colors.ts`, `index.ts`
  (modified)
- `src/styles/cozy-tokens.css` (generated), `cozy.css`, `state-signals.css` (new)
- `src/styles.css`, `src/store/preferencesStore.ts`, `index.html` (modified)
- `eslint.config.js` (modified: `src/theme/**` added to `RENDERER_NEUTRAL_LAYERS`)
- `public/assets/asset-licenses.json`, `public/assets/cozy/*.svg` (new);
  `public/assets/CREDITS.md` (rewritten)
- `scripts/check-cc0-assets.mjs`, `scripts/generate-cozy-placeholders.mjs`,
  `scripts/check-welcome-budget.mjs` (new)
- `package.json` (`test:licenses`, `check:budget:welcome`), `.github/workflows/ci.yml`
  (`asset-licenses` job, Welcome budget step)
- `tests/phase8/` (new, 17 files), `tests/e2e/currentBuild.spec.ts` (remote-font
  assertion)

#### Commands

```text
npm run lint                  exit 0
npm run typecheck             exit 0
npx tsc -b --force            exit 0
npm test                      161 files / 3411 tests passed
npm run build:web             built in 42.26s
npm run check:bundle-size     4.69 MB across 147 files
npm run test:licenses         PASSED, 99 entries, 97 checksums, pixi-default=6
npm run check:budget:welcome  198.96 KiB of 300.00 KiB (101.04 KiB headroom)
npx playwright test tests/e2e/currentBuild.spec.ts   20 passed
```

`npx tsc -b --force` is reported alongside the incremental run on purpose: the
incremental `tsc -b` was independently observed reporting success after a prior
run that had errors, so the forced run is the one that counts.

#### Device checks

None. No physical device was available; see the evidence boundaries above.

#### Migration and data result

No learner-data migration and no data-product change. Phase 8 touches no
persistence code. `src/store/preferencesStore.ts` gains theme-mapping selectors
only and adds no store field and no persisted key, so a flag-off and a flag-on
device read the same `localStorage` and an existing preference hydrates to exactly
what it produced before the phase.

The CC0 registry is 99 entries: 0 `cc0-approved`, 7 `procedural`, 90
`legacy-unverified`, 2 `repository-authored`. 97 checksums are recomputed from the
bytes on disk on every run. The six procedural placeholders in
`public/assets/cozy/` regenerate byte-identically from
`scripts/generate-cozy-placeholders.mjs`, are Pixi-eligible, carry no SMIL and no
CSS animation, and are proven inert under `prefers-reduced-motion`.

#### Bundle and performance result

| | baseline | now | delta |
| --- | --- | --- | --- |
| raw `dist` | 4.48 MB / 140 files | 4.69 MB / 147 files | +0.21 MB |
| Welcome initial JS+CSS gzip | 196.37 KB | 198.96 KiB | +2.6 KiB |
| Welcome headroom to 300 KiB | 103.63 KB | 101.04 KiB | -2.6 KiB |
| Welcome initial JavaScript | 103.5 KB gzip | 103.55 KB gzip | +0.05 KB |

The entire raw-size increase is provenance text and placeholder art: the 164 KB
registry, the 9.7 KB placeholder set, and a larger `CREDITS.md`. The initial-payload
increase is the inlined Cozy stylesheet, and **0 KB** of token data reaches the
Welcome JavaScript. The 300 KiB budget is now a committed, gating check rather than
an unenforced target.

#### Accessibility result

- **Contrast.** The declared token pairs were recomputed with an implementation
  written from the WCAG 2.x specification rather than the project's own
  `cozyContrastRatio`, validated against the spec's anchors (`#ffffff`/`#000000` =
  21.0000, `#ffffff`/`#7f7f7f` = 4.0041, `#ffffff`/`#767676` = 4.5422), across all
  4 themes x 2 contrast variants. **520 of 520 pairs pass**, 0 below threshold.
  Worst text 4.66:1 and worst non-text 3.21:1, both in `cozy-parchment` default
  against `surfaceSunken`. All 128 ratios written in source comments were
  cross-checked against the recomputed minimums and none disagreed.
- **Manual contrast review** was performed in a real browser across the five-surface
  stack, the muted-on-sunken chip, the recorded Phase 1 defect, the selection chip,
  the focus ring against each surface, and the selection strip side by side. It
  found the one combination worth re-reviewing — `accentSoft` used as 11-15 px text
  — which was then reclassified and its parchment values corrected, and it is what
  showed the default-path selection strip to be indistinguishable.
- **axe** (WCAG 2.0/2.1/2.2 A/AA) on Welcome: the default artifact reports exactly
  the one recorded serious `color-contrast` exception,
  `.welcome-checklist-status--done`, unchanged from the Phase 1 baseline. The
  `VITE_COZY_VISUALS=true` artifact reports **0** serious or critical violations,
  so the recorded defect is fixed behind the flag.
- **Focus and state.** 44 tab stops walked in a real browser: every one carries a
  visible indicator, every one matches `:focus-visible`, none is below 44x44, in
  both flag states at 1280 px and 320 px. The selected Welcome tab and the pressed
  phase card each differ from their unselected siblings by at least one non-colour
  signal in the **default** artifact, measured as `font-weight 400 -> 700` plus a
  3 px inset bar, and additionally a `border-width 1px -> 2px` on the card.
- **320 CSS pixels and 200 % zoom.** Horizontal overflow 0 px in both flag states,
  measured both as `documentElement.style.zoom = 2` and as a true 640x400 viewport.
- **Reduced motion.** `REDUCED_MOTION_SCALE`, every duration, and every travel are
  exactly `0` under the Cozy scope, verified in-browser. See the limitation above
  for the legacy path.

#### License result

- **New media cannot be added without CC0 metadata.** Verified by 45 independent
  negative cases plus 103 automated tests, each proven to fail against the
  pre-fix code. The gate covers media present under `public/assets/`, media present
  under `src/`, and media named by a module under `src/` through relative,
  aliased, dynamic-`import()`, and stylesheet `url()` references. The extension
  vocabulary is closed in both directions, and a `media: false` declaration whose
  bytes open with a known media container signature is refused, so a real image
  cannot be smuggled in by renaming it.
- **Legacy separation.** No `legacy-unverified` asset can reach `pixi-default` by
  declaring membership, by setting `pixiEligible`, by relocating its entry under a
  bundle path, by moving the file itself into the bundle directory, or by adding a
  new bundle whose paths cover the legacy tree. A file that reaches the bundle
  directory without a registry entry is refused, so the separation cannot be
  defeated by omission. All 90 legacy assets still ship in `dist` for the legacy
  renderer, which plan 10.3 explicitly permits, and `pixi.js` is not a dependency
  and is not installed, so no Pixi runtime exists that could load them.
- **The registry is machine-readable and self-checking**, published at
  `/assets/asset-licenses.json`. It contains only paths, ids, license facts,
  checksums, and commit references; it carries no email-shaped value, no UUID, and
  no credential, and the checker's failure output prints only ids, paths, field
  names, and closed-enum classes.

#### Gate integrity

Each gate added by this phase was proven bound and able to fail by mutation:
the `asset-licenses` job against 7 workflow mutations, the Welcome budget step
against 8, the renderer-neutral layer against 7 `eslint.config.js` mutations and
end-to-end with a real `import Phaser from 'phaser'` inside `src/theme/`, and the
QA verification file against 8 mutations. The remote-font assertion was proven by
injecting a synthetic Google Fonts stylesheet link into the built artifact and
observing the shipped spec fail with a count and a resource type and **no
hostname**. The single-production-build invariant of plan 2.5 and 10.4 holds:
`ci.yml` contains exactly one `npm run build:web` and one production artifact
upload, and the license job installs nothing and builds nothing.

#### Rollback

`VITE_COZY_VISUALS=false` and retain legacy renderer themes. Verified by building
all three states: flag-off and unset are behaviourally identical (the default
resolution is `false` either way and the unmatchable literal `data-cozy-visuals`
cannot satisfy the `[data-cozy-visuals='true']` scope), and flag-on is the build
that activates Cozy, with the computed `--cozy-c-surface-page` becoming `#191410`
and the bridged `--accent-soft` becoming the Cozy value. The four legacy theme
blocks are byte-identical to `HEAD` except for three font-stack declarations in
`:root`, which the no-remote-font criterion requires. Neither project-level gate
references the flag: the license gate and the budget gate were run with the flag
`true` and `false` and produced identical output and exit codes.

One rollback caveat is recorded honestly: the unscoped state-signal layer is a
deliberate flag-off delta required by the fourth exit criterion, so rolling the
flag back restores the previous colour, geometry, focus ring, and motion, but not
the two state shapes.

### Rollback

Set `VITE_COZY_VISUALS=false` and retain legacy renderer themes.

### Follow-up work recorded by this phase

The maintainer accepted Phase 8 on 2026-09-28, so its status advanced from
`verified` to `complete`, and Phase 9 became the next authorized phase. On the same
instruction the two renderer-consumer items below were **folded into Phase 9's
scope** rather than deferred, because a renderer author meets them on the first day
of that phase and the fixes are additive and non-breaking. The remaining items stay
deferred and are routed to their owning phase.

**Folded into Phase 9 (authorized there, not deferred):**

- Numeric mirrors for the CSS-string scale tokens (`COZY_RADIUS`, `COZY_SPACE`,
  `COZY_BORDER_WIDTH`, `COZY_FOCUS`, `COZY_FONT_SIZE`, `COZY_LINE_HEIGHT`,
  `COZY_FONT_WEIGHT`) and a four-number curve tuple for `COZY_MOTION_EASING`, so a
  renderer does not `parseFloat` CSS units out of a renderer-neutral module. Today
  only `COZY_TOUCH_TARGET_MIN` is numeric, which shows the pattern was intended and
  applied once. Generate the mirrors from the existing string tables so there is
  still one source of truth, and keep the string tables for CSS.
- `resolveMotionProfile`'s `durationMs` returning `0` rather than `undefined` for an
  unknown name, so a host that computes a duration name from data cannot produce
  `NaN` seconds.

**Deferred to a later phase:**

- `src/game/scenes/FishingScene.ts` lines 597 and 635 keep a
  `"'Cinzel', Georgia, serif"` canvas `TextStyle` literal, and three Phaser scenes
  carry eight `'Inter, system-ui, sans-serif'` literals. None causes a fetch, but
  they will render inconsistently under Cozy, and the two hard-coded `fontSize`
  and `color` values beside the Cinzel literals are not Cozy tokens.
  `canvasFontFamily('display')` is the intended replacement. For Phase 17.
- The non-colour state signals were added only to the two controls the exit
  criterion was judged against. Ten other legacy selected or pressed controls on
  other screens still differentiate by colour alone, and each is one line in
  `src/styles/state-signals.css`. For Phase 21.
- The legacy reduced-motion gap recorded above. For Phase 21.
- `tests/data/localDownloadOnly.test.ts` and `tests/privacy/uploadBoundary.test.ts`
  plant scratch state under `src/` (`src/__data_gate_probe__/`,
  `src/__privacy_probe__/`). The license gate now reads bytes and reachability
  rather than name shapes, so it is correct, but any future rule that scans `src/`
  for a property those probes violate will hit the same wall. A declared scratch
  root outside `src/` would remove the class of problem.
- `src/theme/colors.ts` and `src/theme/icons.ts` remain unfrozen legacy modules.
  The Phase 8 freeze guarantee covers the Cozy token core only.
- The `FORBIDDEN_RENDERER_IMPORT_MESSAGE` in `eslint.config.js` names only two of
  the six renderer-neutral layers, so the message points a developer tripping it in
  `src/theme/` at the wrong trees.
- `cozy-parchment` reachability: the theme-picker owner must either expose the
  `light` and `sepia` aliases as real choices or drop the parchment recipe.
- The generated `src/styles/cozy-tokens.css` is a checked-in artifact. A build step
  would remove it from the drift surface; it needs an npm script and a CI decision.
- A design review of the Cozy typeface direction, since `--font-game` now renders in
  a system stack rather than Cinzel.

### Unlocks

Phases 9, 10, 11, 13, 17, and 20.

---

## Phase 9: PixiJS 8 Runtime Host

**Status:** complete
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
- Add numeric mirrors for the Cozy scale tokens and a four-number easing curve, so
  the host consumes numbers rather than parsing CSS units. Folded in from Phase 8
  on the maintainer's instruction: a renderer author meets these on the first day
  of this phase, and the additions are non-breaking. Generate the mirrors from the
  existing string tables so `src/theme/` keeps one source of truth.
- Make `durationMs` return `0` rather than `undefined` for an unknown name, so a
  host that computes a duration from data cannot produce `NaN` seconds. Folded in
  from Phase 8 on the same instruction.

### Non-goals

- No Village, dungeon, or fishing implementation.
- No default renderer cutover.
- No use of Pixi for forms or dialogs.
- No asset bundle or audio work; that is Phase 10.
- No visual change to the legacy Phaser scenes.

### Expected files

- `src/renderers/pixi/runtime/PixiCanvas.tsx`
- `src/renderers/pixi/runtime/createPixiApplication.ts`
- `src/renderers/pixi/runtime/PixiWorldHost.tsx`
- `src/renderers/pixi/runtime/useWorldQuality.ts`
- `src/renderers/pixi/runtime/types.ts`
- `src/theme/cozyTokens.ts` (numeric scale mirrors, additive)
- `src/theme/motion.ts` (easing curve tuple, unknown-name duration fallback)
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
- Numeric Cozy scale mirrors and easing curve, consumed by the host without
  `parseFloat`.

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
- The host reads Cozy geometry, typography, and motion as numbers, with no CSS-unit
  parsing in renderer code, and an unknown motion name yields a zero duration rather
  than `NaN`.

### Known limitations and evidence boundaries

- **`check:memory` is a build-level preflight, not a leak measurement**, and says so
  on every run, including a passing one. It establishes no eager renderer load and
  the 800 KiB gzip lazy-chunk ceiling, both as properties of the artifact. The
  20-cycle claim belongs to the browser lane instead.
- **The browser lane is Chromium-only and a software rasteriser.** The WebGL2
  context it obtains is real — Chromium logs a GL driver readback during the run —
  but in a headless Linux container it is SwiftShader, not hardware GPU. There is no
  Firefox, WebKit or Edge evidence for either lane, and no physical-device result.
  Plan §10.4's manual device evidence is produced in the later accessibility,
  performance and cutover phases.
- **The lane cannot measure GPU texture or buffer memory**, because no headless API
  reports either. What it asserts is the release-side equivalent: every one of the 20
  released renderers had its WebGL context explicitly lost at teardown. The lane's
  `doesNotProve` list states this in the repository rather than only in a report.
- **One monotonically rising signal in the run is deliberately not gated.** Chromium's
  own `Nodes` estimate climbs about 5 nodes per cycle. The probe retains every
  PixiJS `Application` in an array, which is the likely explanation, but the lane
  **cannot distinguish probe retention from a real leak** on that counter. The
  JavaScript heap figure is quantised to exactly the same value in all 21 samples
  and carries no information at all. Both are recorded rather than gated, because a
  linear leak and a bounded cache are indistinguishable in an estimate that moves
  by tens between samples, and no gate should be built on a coin flip.
- **A real PixiJS 8.21.0 defect was found, and the shipped matrix is unaffected.**
  `CanvasObserver._attachObserver` registers a `Ticker.shared` listener when there
  is no `ResizeObserver` and never sets the `_tickerAttached` flag its own `destroy`
  tests, so the listener is unremovable. Reproduced in a real browser at **+1 per
  application, linear, with the global, and +0 without it**. `destroy()` does null
  the renderer's fields before the listener is left behind, so what accumulates is an
  emptied shell and one listener slot per application, bounded rather than a growing
  retention of GPU state. Every browser in the support matrix has had
  `ResizeObserver` since 2018, so this affects jsdom and pre-13.1 Safari only. Both
  lanes assert `ResizeObserver` presence at renderer construction as a production
  precondition, so a runtime without it fails loudly instead of leaking quietly. The
  product does not monkey-patch the global, and the defect should be filed upstream.
- **A canvas action routes through the host or it does not happen.** The first build
  of this phase had the scene calling its own action verb, so a pointer press changed
  the world and the DOM mirror — the only place a screen-reader user learns that it
  changed — never heard about it. The fix inverts the dependency: the host passes
  the dispatcher to the scene, so no path can activate without publishing. The
  guarantee is pinned by the type, by a source scan proving no other call site
  exists, and by a browser lane that clicks the canvas. The source scan is a scan,
  and is described as one.
- **A Pixi scene must be presented before a pointer press can hit it**, because
  PixiJS hit-tests against world transforms a never-rendered scene has not finished
  computing. Both browser altitudes wait for presentation, and any Phase 11 test that
  clicks a canvas affordance must do the same.
- **The Pixi build is a screen-level switch.** On the flagged artifact the game screen
  is the Phase 9 test world, not the dungeon, and the existing HUD is not shown.
  Phase 9 forbids implementing the dungeon, and the existing game screen returns
  nothing Pixi-shaped, so there was no smaller switch that did not pretend a dungeon
  existed.
- **The `high` quality profile renders identically to `balanced`.** That is
  deliberate: a difference with no measured budget behind it would be a claim rather
  than a decision. The profile exists so a caller can name the choice and so a later
  measurement can give it content.
- **The lane hard-fails on a missing artifact rather than skipping**, on the grounds
  that a green run which measured nothing is the failure the gate exists to prevent.
  In CI the artifact is downloaded and identity-verified immediately before the lane,
  so reaching that state means the upload or download chain broke. It is a refusal
  to certify, not a coverage gap, and the recorded identity check means the lane
  cannot pass against a stale artifact.
- **The test world's surface height is a judgement**, not a measurement of intent.
  Once a resize defect was fixed the surface settled at 42 CSS pixels, which left the
  scene's own read-out drawn outside the visible area. It is 220 pixels now, the
  smallest round number above what the scene's layout needs. Phase 11 replaces this
  screen with the Village viewport at the same seam.
- **Two specifier forms remain unmatched by the ESLint renderer-boundary rule**:
  `../../src/renderers/...` and `../../src/game/...`, which walk up past the root and
  back down, share no prefix with the tree they reach. Nobody writes that form and the
  identical mistake through the alias is refused, and both are recorded in the
  repository as reported limitations rather than only in a report.
- **`playwright.subject-product.config.ts` and several lane declaration files are in
  no `tsconfig` project**, so ESLint's type-aware rules do not reach them. The new
  canvas-pointer config is placed under `tests/e2e/` precisely so it and the
  declaration it reads are covered by the same project.

### Verification evidence

Recorded on 2026-09-28. The status advanced from `in-progress` to `verified`.

#### Baseline before Phase 9

Lint clean, `tsc -b --force` clean, 3420 tests across 162 files, `dist` 4.69 MB across
147 files, Welcome initial JavaScript and CSS 199.06 KiB gzip, license gate green on
99 registry entries.

#### Files

- `package.json`, `package-lock.json` (`pixi.js@^8.21.0`), `vite.config.ts` (chunk
  audit), `scripts/check-memory.mjs` + `.d.mts`, `.github/workflows/ci.yml`,
  `eslint.config.js`
- `src/renderers/pixi/runtime/{types,cozyWorldTheme,worldEnvironment,pixiInitOptions,createPixiApplication,createPixiWorldHost,useWorldQuality}.ts`,
  `runtime/{PixiCanvas,PixiWorldHost}.tsx`,
  `testworld/{createTestWorld.ts,TestWorldActions.tsx}`
- `src/theme/cozyNumbers.ts` (new), `src/theme/{cozyTokens,motion,index}.ts`
- `src/ui/App.tsx` (the dynamic import under the flag)
- `tests/e2e/{pixi-memory-lane.ts,pixiMemory.spec.ts,playwright.pixi-memory.config.ts,playwright.pixi-pointer.config.ts}`,
  `tests/phase9/**` (20 files), `tests/phase9/browser/pixi-canvas-pointer.spec.ts`

#### Commands

```text
npm run lint                              exit 0
npm run typecheck                         exit 0
npx tsc -b --force                        exit 0
npm test                                  184 files / 3806 tests passed
npm run build:web                         built in 40.62s, vendor-pixi: 0 chunks
npm run check:bundle-size                 4.69 MB across 147 files
npm run check:budget:welcome              199.06 KiB of 300.00 KiB
npm run check:memory                      passed; PixiJS reported NOT measured on this artifact
npm run test:licenses                     PASSED, 99 entries, 0 media under src/
VITE_WORLD_RENDERER=phaser npm run build:web    exit 0, vendor-pixi: 0 chunks
VITE_WORLD_RENDERER=pixi  npm run build:web    exit 0, vendor-pixi: 1 chunk, 0 entry-reachable
npm run test:e2e                          20 passed (4 Chromium viewport projects)
npm run test:e2e:pixi-memory:recorded     8 passed
npm run test:e2e:pixi-pointer:recorded    3 passed
```

`npx tsc -b --force` is reported alongside the incremental run on purpose. The
incremental build has been observed reporting success after a run that had errors,
twice in this phase alone — it hid seven real type errors in the chunk audit and one
in the lane's wiring test — so the forced run is the one that counts.

#### Exit criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Pixi does not load on Welcome | met | The default build emits **no** Pixi chunk, and `grep -i pixi` over `dist/assets/*.js` finds only the pre-existing flag-name strings and one error sentence. A static-import mutation fails the build with `Statically reachable Pixi chunk(s)`. `VITE_WORLD_RENDERER=" pixi "` fails loudly rather than falling through. |
| Repeated mount and unmount leaks nothing | met | 8/8 lane tests. 21 samples over 20 cycles: canvas count exactly 1 at every sample, every previous cycle's canvas detached with its context explicitly lost, PixiJS application retention exactly 1, backing store constant. |
| Keyboard and DOM mirrors work with Pixi active | met after a blocker fix | 3/3 pointer lane tests plus the memory lane's mirror test. A canvas press now reaches the mirror, which it did not before the fix. |
| Pixi and Phaser builds both compile | met | Both build. The default and `phaser` artifacts are the same 147 files; the only difference is 58 bytes, localised to Vite serialising a defined `import.meta.env` key, with no behavioural difference. |
| Cozy geometry, typography and motion read as numbers | met | No `parseFloat` or unit-stripping anywhere in `src/renderers/**`. Verified in a real browser: declared durations honoured, and `durationMs` returns `0`, a number rather than `NaN`, for unknown names, inherited keys, empty and padded strings, `null`, `undefined`, `NaN` and a symbol. |

#### Accessibility result

- The DOM mirror is generated from the same `WorldAction[]` the world declares, so a
  Pixi interaction cannot exist without a DOM control. Measured at 1440×900, 320×640
  and 200 % zoom: two controls in declaration order, both ≥44 CSS pixels, both
  labelled, `Enter` and `Space` operable, the world's own shortcut working with focus
  off the mirror, and the canvas `aria-hidden` and not a focus stop.
- Reduced motion is asserted from compositor pixels: changed area falls from 5,138
  pixels to 848 while the state change survives, and both runs are pixel-stable while
  idle. The status sentence changes to a words-not-an-icon statement.
- **The blocker this phase shipped and closed was an accessibility defect**: a
  pointer press changed the world and the `aria-live` status did not, so it went
  stale and then jumped to a count the learner never observed. The screen's own copy
  claiming every canvas action has a control here was false in the shipped build.
- No `prefers-reduced-motion` change, focus loss, or state-signal regression.

#### Bundle and performance result

| | baseline | default now | phaser | pixi |
| --- | --- | --- | --- | --- |
| `dist` | 4.69 MB / 147 | 4.69 MB / 147 | 4.69 MB / 147 | 5.78 MB / 151 |
| Welcome initial JS+CSS | 199.06 KiB | 199.06 KiB | 199.06 KiB | 199.30 KiB |
| `vendor-pixi` | absent | absent | absent | 535 kB raw / 153.65 KiB gzip, lazy |
| `PixiWorldHost` | absent | absent | absent | 29 kB raw / 11.05 KiB gzip, lazy |

The default production build is unchanged: same file count, same budget, and **no
Pixi bytes at all** rather than a lazily-unfetched chunk. The router's comparison is
`raw === 'pixi'`, which the bundler folds, so the dead branch and its dynamic import
are deleted from the default build. The Pixi chunk is 153.65 KiB gzip against the
800 KiB ceiling.

#### Privacy and license result

No learner data, telemetry, upload, or external network in the Pixi path or its
evidence. The eight evidence files were audited: the complete key set is 86 numeric
counters and technical labels, with no subject, note, attachment, statistic,
progression or preference field, and no absolute path or URL. The lane blocks every
non-loopback origin before the application runs. The CI upload is sanitized JSON
only, under an allowlist, and the lanes' own output directories sit outside it with
that asserted. `test:licenses` stays green and the host adds no media: the test world
draws procedurally.

One new category of host metadata is recorded unsanitized: the raw
`WEBGL_debug_renderer_info` string, which on a physical runner is a GPU device
string in a 14-day artifact. That is host data, not learner data, so plan rule 6 does
not cover it, and it is noted here rather than assumed benign.

#### Rollback

`VITE_WORLD_RENDERER=phaser`. Verified: the explicit-phaser build and the default
build emit the same 147 files after hash normalisation, both report `vendor-pixi: 0
chunks`, and `npm run test:e2e:recorded` passes 20/20 against the explicit-phaser
build, identical to the default. The 58-byte difference is localised to Vite
serialising a defined `import.meta.env` key and changes no behaviour. The production
default is still `phaser` and `FEATURE_FLAG_MATRIX.worldRenderer.productionDefault`
is unchanged at `ownerPhase: 9`.

#### Gate integrity

Every gate was proven able to fail, by mutation where the gate is structural and by
reverting the fix where it is behavioural. The build audit fired on the first
attempt and on a three-hop variant. `check:memory` fires on an eager Pixi chunk, an
oversized renderer chunk, no renderer chunk, no `assets/` tree, a dangling reference,
and now an unknown renderer family. The memory lane refuses to skip and refuses to
pass against a stale artifact. **The pointer lane was shown red on the real defect**:
reverting one line in the scene — calling its own action verb instead of the host's
dispatcher — turned two of its three tests red with `the first canvas click did not
reach the mirror`, against the same artifact, before being restored.

Hermeticity was checked directly, because the Phase 8 guard scans only `tests/phase8`:
no Phase 9 gate depends on the checkout's git history, on where the checkout lives, or
on a `dist/` that may not exist. The only gate that needs a build is `check:memory`,
and it is a build-level gate run immediately after a build. The lane's refusal to skip
is the opposite of the Phase 8 defect: it cannot pass against a stale artifact.

One load-bearing CI invariant was found to have **no test attached** and now has one:
the Pixi-flagged build overwrites the `web-build` runner's `dist` after the production
artifact is uploaded, which is safe only because every consumer downloads the
artifact. A new assertion pins the ordering and proves the window between the upload
and the Pixi build contains no `dist` reader.

#### Merge evidence

The maintainer accepted the verified checkpoint on 2026-09-29, so Phase 9 is
`complete` and Phase 10 remains `not-started` and requires separate authorization.

PR #59, branch `phase-9-pixi-host`, four commits squashed to `5ef98dd`. The pull-request run `36529308416` passed all eleven jobs and the
post-merge `main` run `36530601431` passed all eleven again, including the four
cross-engine compatibility lanes. `Deploy Web to GitHub Pages` ran `36530601425` on
the same commit. The phase was committed as one commit rather than split, and the
reason is recorded below with the two blockers.

**Three of the four defects this phase shipped were in its gates, and CI found all
three.** That is the finding, and it is a change from Phase 8 rather than a repeat
of it. Phase 8's three near-misses were green locally and red on CI because they
depended on state a clean checkout does not have. Phase 9's first three red runs were
different: they were gates that were correct in isolation and wrong about the thing
they were composed with, and two of them were introduced by fixes for earlier
defects.

The first was a guard for a real diagnostics problem. A missing artifact made the
lane reach a `vite preview` of a directory that was not there, which Playwright
reports as a 180-second webServer timeout. Changing the module-scope `console.warn` in
the lane config to a `throw` fixed the diagnosis and broke `npm test`, because the
lane's own wiring gate imports that config module to assert its shape — so importing
it became fatal in any checkout without a build, including the `unit-tests` job,
which has none and never should. The check now lives in the command, where it runs
only when a person or CI invokes a lane: a missing artifact costs 41 milliseconds and
one sentence, and the config module is importable again. This is the Phase 8 defect
class reintroduced while fixing something else, which is worth recording because it is
what a local-only verification loop produces.

The second was in the CI wiring this phase added. `actions/download-artifact` extracts
*into* the working directory rather than replacing what is there, so the flagged
artifact's download merged into the production tree the earlier download had left
behind: two builds emitting the same logical chunk names with different content
hashes, and a 179-file tree that was neither artifact. The identity gate caught it
and refused to measure it before anything was measured, which is the property worth
keeping, and the tree is now replaced explicitly. This was not a pre-existing defect
rediscovered — the gap was created by the change, because Phase 9 is what put a second
artifact into a job that already had one.

The third was the preflight script written to fix the first, shipped with TypeScript
syntax — `} as const;` and a parameter annotation — in a file Node loads as an ES
module. `scripts/` is in no `tsconfig` project and `scripts/**` is in ESLint's ignore
list, so neither gate could see it, and the only thing that could was running it. The
cause was procedural and is recorded because it is the second time this phase: the
lane command was rewritten to `<preflight> && playwright test ...`, the config was
checked, the wiring assertions were checked, and the full unit suite was run — and
the composed command was never executed. The lane had been run 8/8 and 3/3, but
*before* the preflight existed in front of it. A composed command is a new artifact
and has to be run rather than inferred from its parts. A `node --check` assertion now
guards it, because a syntax error in a preflight is a red run naming a Node stack
trace instead of the missing artifact it exists to describe.

**The two blockers the phase's own browser lanes found are recorded above** — a Pixi
world that had never mounted, and a canvas press that never reached the DOM mirror.
Neither was visible to a unit test, and the second is why the phase was not split:
separate lanes from the host would have produced a first commit that was green,
reviewed, and merging a world that had never rendered.

**The suite is flaky, and it is not this phase's to have caused.** Three consecutive
identical runs on an unmodified tree gave eight failed, five failed and zero failed,
every failure in `tests/data/*` Phase 5, 6 and 7 gates that this phase does not touch.
The Phase 7 merge record already names a wall-clock flake found while sweeping. It
did not redden any of the four CI runs on this branch or the post-merge run, and it is
recorded here rather than fixed opportunistically inside a renderer phase, because a
data gate failing in a renderer PR is a distraction and a real fix needs its own
investigation.

Recorded and not fixed, because it predates this phase:
`tests/phase5/seam.test.ts` asserts a file is unmodified via `git status --porcelain`,
which is safe on a CI runner's clean tree and red in a developer tree where that file
is locally edited.

The PixiJS 8.21.0 `CanvasObserver` defect recorded above should be filed upstream: it
is a real leak in a dependency, reproduced at +1 per application in a real browser,
and the only reason it is not a problem here is that every browser in the support
matrix has provided `ResizeObserver` since 2018. That is a property of the shipped
matrix, not of the code, and it will not stay true if the matrix moves.

### Rollback

Set `VITE_WORLD_RENDERER=phaser`.

### Unlocks

Phase 10.

---

## Phase 10: CC0 Asset Bundles and Audio Foundation

**Status:** complete
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

- Every loaded media file is CC0-approved. **See "The first exit criterion" below
  — this phase does not satisfy it literally, and that is a plan-wording question
  for the maintainer rather than a fix.**
- Missing optional media does not break a route.
- Pixi textures and audio resources are released correctly.
- User audio controls are keyboard and screen-reader accessible.

### Rollback

Disable audio independently and retain procedural art fallbacks.

Implemented as `VITE_AUDIO_ENABLED=false`. This is the one flag in the matrix that is
not a cutover gate, and the reasoning is recorded in the plan's flag section and in
`src/config/featureFlags.ts`: a flag that gates a behaviour change defaults to the
pre-phase behaviour, and audio has no pre-phase behaviour to default to. Turning it
off disables audio and nothing else — no media is unloaded, no data is migrated, and
the procedural art fallbacks are untouched, which is what the rollback line requires.
The procedural fallback path is not behind the flag at all, so a build with audio
disabled still renders every world.

### Unlocks

Phases 11, 13, 17, and 20.

### What was built

The audio half and the asset half are separate services with a deliberately narrow
seam, and the reason is worth stating because it is the phase's main design decision.

**No media file is shipped.** `npm run test:licenses` reports `cc0-approved: 0`, and
Phase 8 recorded why: all 90 pre-existing media files are `legacy-unverified`, so a
bundle may only be filled with newly authored or genuinely CC0 media. Shipping audio
binaries or world art in this phase would have violated the CC0 rule and the explicit
non-goal "no final world-specific asset production". So:

- **Audio is synthesised.** `src/services/audio/` is eight modules. `audioRecipes.ts`
  holds one recipe per track and per SFX as pure data; `proceduralAudioProvider.ts`
  renders them with oscillators and gain envelopes through the Web Audio API. That
  is honest `procedural` provenance — generated by committed code, so no third-party
  licence attaches. `fileAudioProvider.ts` is the path for genuinely CC0 audio later:
  it resolves through an **injected** resolver, has **no `fetch` of its own** (three
  privacy gates enumerate every network call site by exact path, and a fetch here
  would have made the audio service a second way for an off-origin URL to enter), and
  soft-fails to the procedural recipe on all four of its documented failure shapes.
- **The five world bundles are declared and empty.** `pixi-default` holds the six
  Phase 8 procedural placeholders and is the only bundle with members. `common`,
  `village`, `dungeon`, `fishing`, and `share-card` declare their keys and their
  procedural fallback recipes and carry no files. That is the non-goal, and both the
  manifest and the registry say so in those words rather than leaving a reader to
  guess whether it is unfinished.

`AssetLoader.ts` holds no engine import at all; everything reaches PixiJS through a
`PixiAssetRuntime` port whose only binding is in `createPixiApplication.ts`. That
keeps the file count of `pixi.js` importers in the renderer tree at two, which
`tests/phase9/pixi-host-boundary.test.ts` pins, and it makes reference counting,
ownership, and the diagnostics testable with no GPU, DOM, or network.

The decisions worth a reviewer's attention, because each was a real fork:

- **Reference counting is taken before the in-flight check**, so a second caller is a
  second holder rather than a second load, and `loadBundle` is deliberately not
  `async` so a joining caller receives the identical promise object.
- **Required and optional members take different load paths.** `Assets.loadBundle`
  rejects on its first failure, which would take the required members down with an
  optional one. Required members go through the bundle; optional members are loaded
  individually. `loadBundle` therefore never rejects on a media condition — it
  resolves with `ok: false`. It rejects only for an unknown bundle id and an
  unshippable manifest, both bugs with no media in them.
- **Texture ownership is split.** Pixi-loaded textures are destroyed by
  `Assets.unloadBundle`, and the loader never touches them again, because a second
  `destroy(true)` is a use-after-free. Procedural fallbacks are loader-owned and
  destroyed directly. Because `unloadBundle` destroys a bundle as a unit, a release
  with any live lease is deferred until the last `retainTexture` release.
- **Diagnostics are bounded and carry no paths.** One record per
  `(bundleId, key, kind)` with a counter: 50 repeated failures produce 6 records with
  `count: 50` and 6 log lines. Records hold a bundle id, a key, a closed `kind`, and a
  count — never a path, URL, or caught message.

`audioManager.ts` keeps the entire Phase 3 public surface so the six legacy
`FishingScene` call sites keep compiling, and adds `muted` (distinct from the two
per-bus toggles, and a master-gain assignment so unmuting restores a running track
rather than restarting it), `setMuted`/`toggleMuted`, `applyPreferences`, `unlock`,
and `dispose`. The five preference fields persist additively: a device that stored
only `colorTheme` hydrates to the documented audio defaults, and a rollback build
ignores the new keys. Hostile stored values — wrong type, `NaN`, out of range — are
coerced to the default rather than trusted, because `localStorage` is writable by hand
and an out-of-range value that reached an `AudioParam` would not be a volume.

The settings surface is `AudioSettingsTab.tsx`, a fourth tab in `SettingsModal`. It
imports no service at all, which is what makes it structurally incapable of unlocking
audio from a click — the gesture gate stays in one place by construction rather than
by discipline. Two choices there are deliberate and a reviewer may disagree: the
volume sliders are never disabled when their bus is off, because that removes a
control from the tab order exactly when a learner with music off may want to set a
level for next time; and `aria-valuemin`/`max`/`now` are written out even though a
native range derives them, because a value that is only checkable in a real browser
quietly stops being checked.

### The first exit criterion

> Every loaded media file is CC0-approved.

**This phase does not satisfy it literally, and the reason is not a shortcut.**

First, the literal reading is vacuous: `createAssetLoader`, `createPixiAssetRuntime`,
and `playBgm` have **zero production callers**. No route in any build requests any
bundle, and the only `playSfx` call site in the application is `FishingScene.ts`, a
Phaser scene. The browser lane's network evidence confirms it: across the whole
journey the resource types are `document`, `image`, `script`, `stylesheet`, and
`xhr` — no `font`, no `media`. So no media file loads at all in this phase, and
"every loaded media file is CC0-approved" is true over an empty set.

Second, and more useful, the criterion and the registry's own policy **disagree in
wording**. The plan sentence names `cc0-approved`. `policy.pixiBundleRule` admits
`cc0-approved` **or** `procedural`, and `classificationRules["cc0-approved"]` says in
as many words that no entry carries that class today. The `pixi-default` bundle's six
members are `procedural`. So the gate the phase actually runs passes, and the
sentence a reviewer reads names one of the two classes the design admits as though it
were the only one.

The recommended amendment, for the maintainer to accept or reject:

> Every media file loaded into a Pixi asset bundle is either `cc0-approved` in the
> media registry or `procedural` — generated by a committed script, so no
> third-party licence attaches.

This was **not** applied unilaterally, and no classification was changed to make the
criterion pass. `cc0-approved` remains 0.

The second, related fact worth stating plainly: three of the four exit criteria
describe code paths no user reaches today. That is defensible — the worlds arrive in
Phases 11, 13, 17, and 20 — but it means this phase's verification is of a service
rather than of a route, and a later phase must wire it.

### Verification evidence

Recorded on 2026-09-29, on Linux with Playwright Chromium, against the working tree.
The pre-change baseline, run by the orchestrator before any delegation on a clean
tree, was `npm run lint` 0, `npm run typecheck` 0, `npm test` **184 files / 3808
tests**, `npm run build:web` 0, `npm run check:bundle-size` **4.69 MB across 147
files**, and `npm run test:licenses` 99 entries with `pixi-default=6`.

- The common gate passed after implementation: `npm run lint` 0, `npm run typecheck`
  0, `npm test` **195 files / 4016 tests**, `npm run build:web` 0, and
  `npm run check:bundle-size` **4.75 MB across 147 files** — **+59,244 bytes
  (+1.20 %)** against the baseline, with the file count unchanged.
- `npm run test:licenses` passed: 99 registered entries (procedural=7
  legacy-unverified=90 repository-authored=2), 97 checksums recomputed, bundles
  `pixi-default=6 common=0 village=0 dungeon=0 fishing=0 share-card=0`, 0 media
  files and 0 media references under `src/`, and the new cross-check reporting
  `Bundle ids cross-checked against src/renderers/pixi/assets/assetManifest.ts: 6
  agree`.
- `npm test -- tests/unit/preferencesStore.test.ts` passed, together with
  `tests/unit/audioManager.test.ts`, `tests/unit/fileAudioProvider.test.ts`, and
  `tests/unit/audioSettingsTab.test.tsx`.
- `npm run test:e2e` is the plan's listed command; the phase-specific browser lane
  is `npm run test:e2e:phase10-media:full`, and **14/14 passed in 1.2 min**.

**All four manual checks are now mechanical gates, not prose**, which is stronger than
the plan asked for:

1. *No audio plays before a user gesture.* Verified against the production artifact
   through the real Settings panel: operating every audio control and moving both
   sliders constructs **no** `AudioContext` attributable to the audio service, with
   `oscillatorsStarted: 0` and `bufferSourcesStarted: 0`. The positive half, against
   the real module with a real `AudioContext` and a trusted `page.mouse.click`:
   `unlocked` false → true, `bgmPlaying` false → true, contexts 0 → 1, oscillators
   started 0 → 6, context state `running`.
2. *Mute and volume persist across routes.* Verified with `["true","17","83"]`
   through the real modal, the real store, and the real `localStorage` key — surviving
   two route changes **and** a full page reload. The stored payload is asserted to
   contain the audio fields *and* the pre-existing `colorTheme`, so the additive keys
   are proven not to have displaced anything.
3. *No remote media request occurs.* 72 requests across the whole journey:
   `offOrigin: []`, `fonts: []`, `media: []`. Non-vacuity is asserted, so a journey
   that made nothing would not pass.
4. *Optional missing art does not break a route.* Verified by aborting every
   `/assets/cozy/*.svg` request, with `attemptedCount: 6` asserted **before** the
   outcome so the failure is a real one. All six fall back, the canvas still renders,
   zero unhandled page errors, and six bounded failure records carrying only
   `{bundleId, count, key, kind}`.

Exit criteria 2, 3, and 4, measured in a real browser:

- **Missing optional media** — met, but only after a defect was found and fixed. See
  below.
- **Resources released** — met with limitations. 20 load/render/release cycles over a
  real WebGL2 context: live GPU-backed sources `[1,1,1,…,1]`, no monotonic growth,
  with a non-vacuity control first (6 bundles loaded and deliberately not released
  moved the count `1 → 7`, then `7 → 1` after release). Audio: live source nodes
  `5 → 0` after `dispose()`, context `running → closed`. These are **counts, not
  bytes** — no browser API reports texture memory or audio device memory.
- **Keyboard and screen-reader accessible** — met for the automated and semantic
  claims, **not** for screen-reader behaviour. 0 serious/critical violations in the
  panel at all four viewport projects, 5 controls measured with 0 under 44px, full
  keyboard operation. One pre-existing whole-page contrast violation
  (`.hud-stat-subtle`) is present on the game screen with the modal closed, before the
  Audio tab is opened; it is recorded as a single named signature so the exception
  cannot widen by silence.

### Defect found and fixed during verification

**`createFallbackTexture()` threw a `TypeError` in every real browser.** The Phase 9
runtime assigned to `CanvasRenderingContext2D.prototype.canvas`, which is a getter-only
accessor in every browser in the support matrix; the module is an ES module, so it is
strict mode and the throw was not swallowed.

```
TypeError: Cannot set property canvas of #<CanvasRenderingContext2D> which has only a getter
```

Measured blast radius in real Chromium, against the shipped runtime:
`createFallbackTexture` threw, `getTexture` threw, and `loadBundle` **rejected** — for
`common` and for `pixi-default` with all six assets 404'd. So the procedural fallback,
which exists precisely so a missing asset cannot break a route, was the thing that
broke the route, on every call. This is the single most important finding of the
phase, and it was found by the browser lane, not by a unit test.

**Why every unit test missed it:** `vitest.setup.ts` replaces
`HTMLCanvasElement.prototype.getContext` with a plain object literal. A plain object
has a *writable* `canvas` data property, so the assignment that throws in a browser
succeeds under jsdom. The stub was written for Phaser and silently removed the only
property whose descriptor *shape* mattered. `tests/phase10/browser-shape-parity.test.ts`
now installs a real platform descriptor and gates the regression.

### Cross-phase gate edits, and why each was necessary

This phase required editing **eight** gates belonging to earlier phases. None was
weakened, and the reasons are recorded because a reviewer should be able to check each
one rather than take it on trust.

| Gate | Change | Why it was unavoidable |
|---|---|---|
| `tests/phase8/cozy-flag-gating.test.ts` (2) | "exactly three keys" → "the three legacy keys plus exactly these five Phase 10 audio keys" | The assertion was a closed list of the preference payload, and this phase adds five fields to it. It stays a closed list, so a sixth field fails deliberately. |
| `tests/unit/preferencesStore.test.ts` (5) | Same closed-list widening | Same. |
| `tests/phase5/seam.test.ts`, `tests/phase6/lazyBoundary.test.ts`, `tests/data/phase5FlagDefault.test.ts` | "no flag defaults on" → "no **cutover** flag defaults on", asserted against `NON_CUTOVER_FLAG_KEYS` | The plan's rollback line requires audio to be disableable independently, which means a kill switch defaulting on. Carving out `['audioEnabled']` three times would have let the exception spread; one named reviewed list cannot. A new flag defaulting on still fails all three. |
| `tests/data/subjectProductBoundary.test.ts`, `tests/data/templateProductBoundary.test.ts`, `tests/unit/runtimeConfig.test.ts` | Closed flag list widened from nine names to ten | Adding the tenth flag. Still closed. |
| `tests/phase9/pixi-host-boundary.test.ts` | "no renderer module names an asset file" → "the **only** one that does is the Phase 10 manifest, and every file it names is registry-admitted, Pixi-eligible, and a bundle member" | The gate's own title predicted this hand-off ("because Phase 10 owns those"). The rule is narrowed to one exact path and made **stronger** — the original allowed no namer at all, the new one allows exactly one and holds it to the registry inside the same gate. |

The ADR now carries a dated amendment for the tenth flag. The Phase 1 evidence record
at line 884 still says "the nine documented flags default to … all future booleans
false"; that sentence is left unedited deliberately, because it is a dated observation
of what Phase 1 found, and rewriting a historical record to match a later phase would
be falsifying it.

### The CI wiring, and a change that needs the maintainer's sign-off

The Phase 10 browser lane is wired into the `browser-smoke` job, and the placement is
forced rather than chosen. It runs **before** the "Discard the production dist" step
and before the Pixi-flagged download, because the lane previews the *production*
artifact; a step placed after the clear would preview a flagged tree while its own
preflight and first test verified production identity — a green run describing
something other than what it claims. `tests/phase9/pixi-pointer-lane-wiring.test.ts`
independently requires that nothing at all run between the clear and the download.
Local cost measured at 80 seconds end to end; budget ~2–3 min on a two-core runner.
Nothing extra was added: no build, no second download, no second browser install.

The wiring gate was then found to be **vacuous** — it asserted only that the string
`browser-smoke:` exists, which was already true — and was rebuilt to gate the step
itself: it exists, runs the exact npm script, is neither exempt nor skipped, adds no
build/download/install/`npm ci`, and sits inside the production window. Eleven checks
are proven non-vacuous by **19 mutations**, each asserted to be rejected, and a
completeness assertion means a check added later without a mutation fails the gate.

**One change in that wiring is beyond the phase's own scope and needs a decision.** The
`browser-smoke` job timeout was raised from 20 to 25 minutes. The reasoning is
evidence-destroying failure rather than cost: a job-level timeout *cancels* the job,
which would destroy the two Pixi lanes' already-collected measurements and skip the
`if: always()` evidence upload, converting a reportable red test into a lost run. It
is a one-line revert.

### Known limitations and evidence boundaries

- **No screen reader, no assistive technology, no sound device, and no physical
  device** were available. Nothing in this record is a screen-reader result, a
  physical-device result, or a hearing result. The semantics were verified; what any
  screen reader *announces* was not. The lane's own limitation list is asserted by
  content in its wiring gate, so it cannot quietly shrink.
- **Chromium only**, on Linux. No Firefox, WebKit, Edge, macOS, iPad, or Android.
- **The audio-module browser checks ran against a Vite dev server on the same checkout,
  not the minified production chunk**, because the built artifact does not export its
  modules, so a previewed page cannot call `playSfx`. The *negative* half of the
  gesture check — the half that matters most — is on the production artifact through
  the real Settings panel. The lane records this in its own `doesNotProve` and a
  wiring-gate assertion holds the wording. No debug global was added to the
  application to make the test possible.
- **The texture-release evidence is instrumentation**, not a browser byte count, and
  the world-mount half of "textures are released" is the Phase 9 memory lane's
  subject — no Phase 10 route mounts a Pixi world.
- **`retainCustomSpriteUrl` has no production caller.** It is the mechanism for "never
  revoke a blob URL while a texture is still using it", and the first caller that can
  express a lease is a Phase 11 world scene. `tests/phase10/phase11-hooks.test.ts`
  asserts it still has no caller, so when Phase 11 wires it, the test fails and whoever
  wires it reads the contract first.
- **`createAssetLoader`, `createPixiAssetRuntime`, and `playBgm` have no production
  caller.** Defensible, and stated above, but it means this phase verifies a service
  rather than a route.
- **A path-traversal defect was found and fixed in the manifest's own validator**: a
  character-class check admitted `.` and `..`, so `assets/../../etc/passwd` passed.
  It is now a per-segment check with a test.
- **A blob-URL leak was found and fixed**: a `retired`/`revoked` conflation meant **no
  blob URL was ever revoked on any exit path**. This is the class of defect the exit
  criterion is written about, and it was live until the browser work found it.
- **The `E-BUNDLE-DRIFT` check reads `ASSET_BUNDLE_IDS` from source text** and fails
  closed, so a restructured constant is a finding rather than a silent pass. It is a
  textual contract, unlike the registry's other checks.
- **Three pre-existing i18n defects were found and not fixed**, being in the file the
  settings surface shares: `settings.makeItYours` is rendered but registered in no
  locale, and `settings.resetDefaults` is called twice with two different fallbacks so
  its `aria-label` says less than intended. Both are a maintainer call rather than a
  drive-by inside a media phase.
- **The suite is flaky and it is not this phase's to have caused.** Phase 9 recorded
  a wall-clock flake in `tests/data/*`; the Phase 5 seam gate that asserts a file is
  unmodified via `git status --porcelain` is red in a developer tree where that file is
  locally edited, and still is.
- **The `browser-smoke` job timeout raise and the run-time result of the new CI step
  are ungated** — a gate reads `ci.yml` as text and cannot see whether a step ran or
  whether a red lane failed the job. That is only observable in CI history.
- The Vite dev server logs a `%VITE_COZY_VISUALS% is not defined` warning on every
  page. It is a dev-surface warning only, affects no assertion, and is outside this
  phase.

### Merge evidence

The maintainer accepted the verified checkpoint on 2026-09-29, so Phase 10 is
`complete` and Phase 11 remains `not-started` and requires separate authorization.

The phase is committed as a single commit, for the same reason Phase 9 was: a split
would produce a first commit that is green and reviewable while merging half a phase.
Here the split point would have been sharper still, because the CI job raises the
`browser-smoke` timeout and the browser lane is what justifies raising it — a first
commit containing the timeout bump with no lane to spend it on is a bare unexplained
change to a shared workflow, and a second commit removing it is a second red run of
every gate in the job.

**Two questions were open at the moment of acceptance and neither was answered, so
neither was applied.** The exit-criterion wording amendment recommended above is
still open, and the `browser-smoke` timeout raise is still in the tree as described.
Both are recorded here rather than resolved silently, because the first one is the
reason the first exit criterion is annotated as unmet in this document and the second
one is a change to a shared CI setting that outlives the phase.

The pull-request number, the branch, the CI run ids, and whether the phase was
squashed are recorded here once the branch is pushed and the pull request is merged.
Until then the evidence in this section is **pre-merge local evidence only**, and the
Phase 9 record is the precedent for what replaces it.

---

## Phase 11: Pixi Village World Foundation

**Status:** complete
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

### Verification evidence

Recorded on 2026-09-30. The status advanced from `in-progress` to `verified` after the
maintainer accepted the village-scoped reading of the fourth exit criterion (see
"Exit-criteria assessment" below); `GameScreen.tsx` is deferred to Phase 13. The work
shipped in commit `ed1f09f`; at the moment this evidence was first written it was still
uncommitted.

The maintainer then accepted the `verified` checkpoint on 2026-09-30, and the status
advanced to `complete`, unblocking Phase 12. The accepted exit-criteria scope carries
forward into Phase 12's rollback boundary. The uncommitted-work caveat this paragraph
originally recorded was resolved when Phase 12 shipped its work in commit `4944032`; at
that checkpoint the Phase 11 village renderer was committed alongside it, so neither
phase carries uncommitted work into Phase 13.

#### Baseline before Phase 11

Working tree clean at `4070e71` (Phase 10 complete). Lint clean, typecheck clean, 195
test files / 4016 tests passed, `dist` 4.75 MB across 147 files, `check:bundle-size`
green.

#### Files

- New renderer modules: `src/renderers/pixi/camera/CameraRig.ts`,
  `src/renderers/pixi/input/WorldInputController.ts`,
  `src/renderers/pixi/village/{createVillageScene.ts,VillageRenderer.ts,VillageWorld.tsx}`.
- `src/data/villageLayout.ts` (renderer-neutral depth/proximity/path/spawn helpers,
  +242 lines), `src/game/scenes/VillageScene.ts` (consumes the extracted data only,
  −56 lines).
- `src/ui/screens/VillageScreen.tsx` (build-time `VITE_PIXI_VILLAGE === 'true'` switch,
  dynamic Phaser factory, lazy `VillageWorld`, throttled compass).
- `vite.config.ts` (additive `pixiVillage` chunk gate), `package.json`
  (`build:web:pixi-village`), `.env.example`.
- Tests: `tests/phase11/**` (5 files) and deliberate updates to
  `tests/phase9/{pixi-host-boundary,renderer-chunk-boundary,renderer-switch}.test.ts`
  and `tests/e2e/currentBuild.spec.ts`.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       200 files / 4081 tests passed
npm run build:web                              exit 0, vendor-pixi: 0 chunks (default)
npm run check:bundle-size                      4.75 MB across 149 files
npm run build:web:pixi-village                 exit 0, lazy VillageWorld + vendor-pixi, 0 entry-reachable
npm run check:memory (default)                 passed; PixiJS NOT measured on this artifact
npm run check:memory (flagged)                 passed; Pixi lazy, within the 800 KiB ceiling
VITE_PIXI_VILLAGE=true npm run test:e2e        24 passed (desktop-chromium, chromebook, tablet, tablet-landscape)
npm run test:e2e -- --project=tablet           6 passed (default build; Phaser village)
```

#### Device checks

All browser evidence is Chromium (the four Phase-1 viewport projects). `tablet` and
`tablet-landscape` run with touch emulation. No Firefox, WebKit, Edge, or physical
device evidence is produced here; those belong to the compatibility and Phase 21 gates.

#### Migration/data result

None. Phase 11 changes no storage, schema, or migration; the subject schema stays
`1.1.0`. The only persisted read/write is the pre-existing one-shot `kd-village-spawn`
localStorage key, read and cleared exactly once per mount.

#### Performance/accessibility/license result

- Chunk audit: the flagged build emits `vendor-pixi` (573 kB / 166 kB gzip) and
  `VillageWorld` (57 kB / 20 kB gzip) as lazy chunks, none statically reachable from the
  entry. The default build emits zero Pixi chunks.
- `check:memory` is a build-level preflight and does not measure mount/unmount cycles.
- The village surface keeps the Phase 9 accessibility pattern: `aria-hidden`
  non-focusable canvas, a labelled ≥44 px keyboard-operable interact control, a polite
  status sentence in words, no colour-only state;
  `tests/phase11/village-world-dom.test.tsx` pins it. A village-specific axe scan is not
  run here.
- License: no media is added or loaded; the village is drawn procedurally. The CC0 gate
  is unaffected and no `legacy-unverified` file enters a bundle.

#### Exit-criteria assessment

1. Every current village structure is approachable and interactive — mechanism proven
   (`tests/phase11/village-scene.test.ts` approach + interact against the shared
   `VILLAGE_MAP`/`getDungeonPortalSlots` data); an exhaustive walk of all ~70 structures
   is not automated.
2. Touch and keyboard navigation are equivalent — proven at the controller level
   (drag ≡ WASD, tap ≡ interact, pinch ≡ zoom), in the scene, and keyboard end-to-end in
   the browser; a real touch gesture against the village is not driven in-browser.
3. Pixi Village can be disabled without affecting other routes — proven: the default and
   `VITE_PIXI_VILLAGE=false` builds emit no Pixi chunk, mount the Phaser village, and
   request no Pixi script.
4. No current UI component imports Phaser types — met for the village route.
   `VillageScreen.tsx` names no Phaser type and reaches `@/game/createVillageGame` only
   through a dynamic `import()`; the new gate in
   `tests/phase9/pixi-host-boundary.test.ts` enforces this. `src/ui/screens/GameScreen.tsx`
   (the Phaser dungeon route, migrated in Phase 13) still statically imports
   `@/game/createGame` and `PhaserDungeonRenderer`; it is the single enumerated exception.
   On 2026-09-30 the maintainer accepted the village-scoped reading: the criterion governs
   the migrated village UI, and `GameScreen.tsx` migrates in Phase 13. The exception is
   pinned by the gate, so no second file can join it without a red run.

#### Known limitations

- NPCs are deferred to Phase 12 by the plan's non-goals; the Pixi scene accepts the
  `onNpc*` callbacks but never emits them, so the Pixi village has no NPC dialogue.
- Custom-sprite blob leasing (`retainCustomSpriteUrl`) is left unwired in Phase 11; the
  Phase 10 marker gate still passes deliberately.
- The village is drawn procedurally (Graphics/Text); there is no final Cozy asset set, so
  custom sprite overrides do not appear in the Pixi village yet.
- `check:memory` does not measure the village's runtime mount/unmount cycles or GPU
  residency; that runtime measurement exists only for the Phase 9
  `VITE_WORLD_RENDERER=pixi` test-world lane.
- Fishing on the Pixi village path is Phase 17; `isMounted()` is false so `enterFishing`
  no-ops rather than failing.

#### Rollback

Set `VITE_PIXI_VILLAGE=false` (or leave it unset). The default build mounts the Phaser
village unchanged, emits no Pixi chunk, and makes no Pixi request; verified by
`npm run build:web` and `npm run test:e2e -- --project=tablet`.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-02. `in-progress` -> `verified`. The maintainer accepted the
`verified` checkpoint on 2026-10-02, so the status advanced to `complete` and Phase 13
became the next authorized phase. The implementation shipped in commit `4944032`, which
supersedes the "no commit has been made" state that was true when this evidence was first
written.

#### Baseline before Phase 12

Working tree clean at `fac4c85` (Phase 11 complete). Lint clean, typecheck clean, 200
test files / 4081 tests passed, `dist` 4.75 MB across 149 files, `check:bundle-size`
green, 0 `vendor-pixi` chunks on the default build.

#### Files

- Contract: `src/application/contracts/villageNpc.ts` (new), `renderer.ts` (+`readNpcSnapshot`,
  `invokeAction`, `VillageNpcHost`), `index.ts`.
- Renderer: `src/renderers/pixi/village/{VillageNpc,NpcController}.ts` (new);
  `createVillageScene.ts`, `VillageRenderer.ts`, `VillageWorld.tsx`, and
  `src/game/{scenes/VillageScene.ts,adapters/phaserVillageRenderer.ts}`.
- UI: `src/ui/village/**` (18 files), `src/ui/screens/VillageScreen.tsx` 1798 -> 809 lines.
- Tests: `tests/phase12/**` (7 files), `tests/e2e/currentBuild.spec.ts` (+1349/-1).
- Gates updated by enumeration, never loosened: `tests/phase9/{pixi-host-boundary,
  qa-independent-verification}.test.ts`, `tests/contracts/phase-2-adapter-lifecycle.test.ts`,
  `tests/data/localDownloadOnly.test.ts`.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       208 files / 4306 tests passed
npm run build:web                              exit 0, vendor-pixi: 0 chunks (default)
npm run check:bundle-size                      4.80 MB across 149 files
npm run test:licenses                          PASSED, 99 entries, 6 bundle ids agree
npm run test:e2e (default)                     32 passed / 12 skipped x10 consecutive
VITE_PIXI_VILLAGE=true npm run test:e2e        36 passed / 12 skipped
```

Acceptance bar: **10 consecutive green default-lane e2e runs — met 10/10**, verified against
all 10 raw logs. The Pixi spec defect that caused a prior 9/10 bar was a real assertion error
(`fishing-pond` asserted a canvas teardown, but fishing shares the village's Phaser canvas),
now `swaps-scene`; the corrected spec passed 40/40.

#### Device checks

Chromium only, the four Phase-1 viewport projects. `tablet`/`tablet-landscape` touch-emulated.
Verified in-browser: 6 NPCs on the live Pixi stage; wander ~44 px/s against `NPC_SPEED = 45`;
keyboard-only traversal reaches an enabled row and opens a panel without touching the canvas;
quest-scripted dialogue reaches the DOM on both lanes. No Firefox, WebKit, Edge, or physical
device evidence — those belong to Phase 21.

#### Migration/data result

None. No storage, schema, or migration change; subject schema stays `1.1.0`. `localStorage`:
`kd-village-spawn` (unchanged) and a literal `'1'` fishing-hint flag.

#### Performance/accessibility/license result

- Default build emits **0** `vendor-pixi` chunks; Pixi chunks stay lazy and entry-unreachable.
- `check:memory` passes both lanes but is a build-level preflight only — canvas count over 20
  mount/unmount cycles and GPU residency are **not** measured. Plan section 10.2 is unverified.
- License gate PASSED; no media added (0 files under `src/`), 90 `legacy-unverified` entries
  correctly excluded from every bundle.
- Privacy: 0 `console.*`, 0 network calls, 0 off-origin requests in Phase 12 files. The fishing
  live region is a **fixed literal with no interpolation**, so the privacy guarantee is the
  pinned literal.
- Accessibility: side panels do not steal focus (a panel opened by walking must not rip a
  keyboard user out of the world); sheets move and restore focus, trap Tab, and honour Escape;
  44px targets asserted in three spellings; no colour-only state.

#### Exit-criteria assessment

1. **Quest and NPC dialogue matches current data** — met. Verified against `VILLAGE_MAP` for
   the Keeper (10 quest steps) and a wanderer (quotes pool). Line selection has exactly one
   owner (the application layer); the renderers no longer select lines.
2. **No Pixi object is required to understand or invoke a village action** — met on the Pixi
   lane, keyboard-only verified in-browser. Recorded scope reading: the DOM cannot *move* the
   player, only invoke; rows exist only within proximity.
3. **Village screens no longer directly import Phaser types** — met for the village route.
   `VillageScreen.tsx` reaches Phaser only through a dynamic `import()`; `src/ui/village/**`
   has zero Phaser or Pixi imports. `GameScreen.tsx` remains the enumerated exception until
   Phase 13.
4. **Dialogs and bottom sheets meet focus and touch-target requirements** — met for everything
   Phase 12 introduced. Seven pre-existing HUD controls remain under 44px (see limitations).

#### Defects found and fixed during the phase

- **Renderer dialogue was a dead field.** Both renderers computed `VillageNpcSnapshot.dialogue`
  quest-agnostically; nothing read it. Line-selection policy existed in three disagreeing places.
  Fixed by narrowing the contract and making the application layer the single caller.
- **Silent no-op on the Pixi path.** `VillageWorld.tsx` forwarded only the base port, leaving
  nearby-action rows permanently disabled. Compiled cleanly; caught by reading an `aria-live`
  sentence in a browser. Both renderers now `extend VillageNpcHost`, so it fails `typecheck`.
- **Optional members are invisible to the Phase 9 gate.** Its regex could not match `?`-suffixed
  members, so the two new port members were unenumerated. Regex hardened; proved strictly
  stronger (same mutation green before, red after).
- **`fishing-pond` asserted a canvas teardown it never performs** (see Commands).
- Two empty-string/deep-freeze defects in the contract's pure functions, both pinned.

#### Known limitations

- Pixi-lane **fishing is inert**: `readPhaserHandle()?.fishing?.()` is undefined and
  `isMounted()` is false, so a pond row does nothing. Pinned by a `GAP (Phase 17)` test marked
  "must be inverted in Phase 17, do not relax".
- `isMounted()` checks for a *handle*, not a fishing host, so a handle carrying no `fishing()`
  would publish the signal and start nothing. A trap in Phase 17's path; left unfixed (outside
  authorised scope).
- Seven pre-existing HUD controls under 44px inside a surface Phase 12 declares a
  `role="dialog"`; the fish-catch and welcome overlays have no Escape.
- The app layer uses `Math.random()` inline — the `NpcRandomness.quoteIndex` injection seam was
  removed, so a component test asserts pool membership rather than an exact quote string.
- Two-agent structural risk: concurrent agents share one mutable worktree, `dist/`, and port
  43173. This produced misleading numbers twice. **Serialize builds.** `dist` is single-slot:
  always `rm -rf dist && npm run build:web` before a lane, or a Pixi artifact will be tested as
  the default build.
- Deferred: the `src/__privacy_probe__` race (only 2 files contend, not 6, and it could not be
  reproduced in 8 attempts) to `infrastructure-engineer`.

#### Rollback

Set `VITE_PIXI_VILLAGE=false` (or leave it unset). The default build mounts the Phaser village
unchanged and emits no Pixi chunk. The `src/ui/village/**` panels are renderer-neutral and are
retained either way, which is what the plan's "retaining shared React panels where compatible"
requires. Note the Phaser lane is now the *better*-covered lane: 10/10 stable against the
Pixi lane's single run.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-03. `not-started` -> `in-progress` -> `verified` -> `complete`. The
maintainer authorized commit and push after the N1 remediation round. No commit existed
when this evidence was first written; the work shipped in the commit recorded below.

#### Baseline before Phase 13

Working tree clean at `07f60c8` (Phase 12 accepted). Lint clean, typecheck clean, 208 test
files / 4306 tests passed, `dist` 4.80 MB across 149 files, 0 `vendor-pixi` chunks on the
default build, CC0 gate PASSED.

#### Files

- New renderer: `src/renderers/pixi/dungeon/{WalkabilityController.ts,createDungeonScene.ts,RoomNode.ts,CorridorLayer.ts,DungeonRenderer.ts,DungeonWorld.tsx}`.
- Runtime seam: `src/renderers/pixi/runtime/types.ts` (+`WorldSceneInit.publishState?`),
  `createPixiWorldHost.ts` (hands the scene the same hoisted `publishState` closure).
- UI: `src/ui/screens/GameScreen.tsx` (+344/-126 net) now selects its renderer by build-time
  flag through two dynamic `import()`s.
- Tests: `tests/phase13/**` (5 files); `tests/e2e/currentBuild.spec.ts` extended.
- Gates: `tests/phase9/pixi-host-boundary.test.ts`, strengthened by enumeration only.
- Build: `vite.config.ts` (additive `pixiDungeon` chunk gate), `package.json`
  (`build:web:pixi-dungeon`), `.env.example`.
- `src/game/adapters/phaserDungeonRenderer.ts`, `src/game/createGame.ts`,
  `src/core/graph/navigation.ts`, `src/core/layout/dungeonGenerator.ts`,
  `src/ui/components/Minimap.tsx`, and `FullMapView.tsx` are **unchanged**. No renderer-neutral
  contract was redesigned; the Phase 2 dungeon port and `dungeon:*` events proved sufficient.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       213 files / 4410 tests passed
npm run build:web                              exit 0, vendor-pixi: 0 chunks (default)
npm run check:bundle-size                      4.80 MB across 153 files
npm run build:web:pixi-dungeon                 exit 0, vendor-pixi: 1 chunk, 0 entry-reachable
npm run check:memory (flagged)                 passed, 4 chunks / 2 families, no eager Pixi
npm run test:licenses                          PASSED, 99 entries, dungeon=0 files
VITE_PIXI_DUNGEON=true npm run test:e2e        32 passed / 12 skipped (4 viewports)
npm run test:e2e (default)                     32 passed / 12 skipped
npm test -- tests/unit/dungeonGenerator.test.ts     6 passed
npm test -- tests/unit/graphNavigation.test.ts      2 passed
```

#### Device checks

Chromium only, the four Phase-1 viewport projects; `tablet`/`tablet-landscape`
touch-emulated. No Firefox, WebKit, Edge, or physical-device evidence — those belong to
Phase 21. Every number above was reproduced independently by the verifier and again by the
orchestrator, including three mutation probes (below).

#### Migration/data result

None. No storage, schema, or migration change; subject schema stays `1.1.0`. No
`services/` or `core/validation/` file was touched.

#### Performance/accessibility/license result

- Default build emits **0** `vendor-pixi` chunks and the Phaser dungeon arm is deleted
  outright; the flagged build keeps both `DungeonWorld` (67 kB) and `vendor-pixi` lazy with
  0 entry-reachable edges. The village and dungeon switches are independent: `vendor-phaser`
  survives on the flagged dungeon build.
- **Plan section 10.2 frame time and the 20 mount/unmount cycles remain UNVERIFIED and must
  not be claimed.** `check:memory` says so itself. See the limitation below on why the lane
  cannot currently be pointed at the dungeon.
- License gate PASSED; 0 media files and 0 media references under `src/` — the dungeon is
  drawn procedurally, as the village is.
- Accessibility: `aria-hidden` canvas; every control carries `aria-describedby` → hint +
  a visible polite status sentence; refused controls are `disabled` **and** state why in
  visible text (a disabled button is not focusable, so a reason carried only in
  `aria-describedby` would be unreachable exactly when it matters); ≥44 px targets; no
  colour-only state; reduced motion honoured at mount.

#### Exit-criteria assessment

1. **Room and floor navigation match current behavior** — met. The walkability mask is a
   line-for-line faithful port of `DungeonScene.rebuildActiveWalkable`/`isWalkableAt`,
   independently diffed against the Phaser source, including the "both corridor endpoints or
   nothing" rule. Floor visibility, portal targets, and the cooldown stay owned by
   `createStudyFlowController` and `computeFloorVisibility`; the renderer never decides.
2. **A 100-room subject remains traversable** — met, and now pinned geometrically rather
   than by request count. A tile-level BFS flood over `buildActiveWalkability` on a real
   `generateDungeonMap` output (100 rooms, 99 corridors, 198 doors, 229,500 mask cells)
   reaches 100/100 room centres unfiltered and on the root floor, with a non-vacuity control:
   hiding every room but the root collapses the reachable set to exactly `['root']`.
3. **Pixi Dungeon can be disabled independently** — met, proven three ways rather than by a
   flag constant: build shape (0 Pixi chunks by default, `vendor-phaser` still present on the
   flagged build), a distinct `pixiDungeon` chunk gate in `vite.config.ts`, and a browser lane
   that detects the mounted world from the DOM and fails if it disagrees with the flag.
4. **Every world interaction has a DOM equivalent** — met except for two actions recorded as
   a Phase 14 gap below (guide conversation, artifact pickup). Tap/keys, drag, interact,
   ascend, descend, zoom in/out, and travel-to-room all have DOM routes, and the room list
   plus the React/SVG full map remain in React.

#### Defects found and fixed during the phase

- **`rendererRef` was never written on the Pixi lane**, so `setFloorVisibility`,
  `teleportToRoom`, and the rest were silently inert — a floor change that changed nothing.
  Found because the browser lane reported a 3-vs-4 disagreement between drawn rooms and DOM
  room rows. The same Phase 12 defect class.
- **Zoom order bug in the new scene**: the zoom tween resolved before `camera.addZoom`, so
  the tween pulled zoom back and the button did nothing.
- **`readState()` was dead in production.** `PixiDungeonRenderer` had no `onState` member,
  so the port structurally could not deliver state to the DOM; `Ascend`/`Descend` were
  permanently enabled and silently did nothing, while tests asserted sentences ("No stairs up
  in this room") that no learner ever heard. The module header claimed the opposite of the
  code. Fixed by adding `onState` plus a republish after every capability call, rendering
  availability as one published sentence so the `disabled` attribute and the announced words
  cannot disagree.
- **Walking published nothing**, so the floor-navigation controls and their visible sentence
  went stale after moving on foot, and the stale sentence was false — a learner walking into a
  room with stairs was told there were none. Invisible to every gate because the tutorial
  root floor has no portals. Fixed with `WorldSceneInit.publishState?`, wired to the same
  hoisted closure, called only on the room-change and wheel branches of `update()`.
- Three tests were vacuous or self-policing and were replaced: an action-id test whose two
  "ends" were the same module; a constants check that never read the Phaser source it claimed
  to police (now line-scans it, and was proven to go red when `PLAYER_SPEED` drifted); and a
  "parity" test whose header described two recorders when only one existed.

#### Known limitations

- **Guide dialogue and artifact pickup have no DOM route.** Interaction radii are 28 px and
  22 px; the guide's chosen anchor sits ~46 px from room centre and the artifact marker is
  lifted 30 px, and spawn/teleport place the player at centre. This is **parity-correct** —
  `src/game/scenes/DungeonScene.ts:141` and `:691` use the same radii against the same
  geometry — so it is preserved behaviour, not a regression, but criterion 4 is not literally
  met for these two verbs. **Owned by Phase 14**, which builds the dungeon workspace.
- **The plan-10.2 memory lane cannot currently be pointed at the dungeon.**
  `scripts/require-pixi-lane-artifact.mjs` hardwires `build:web:pixi` →
  `VITE_WORLD_RENDERER=pixi`, which renders the Phase 9 *test world*; and
  `DungeonWorld`'s mount deps exclude reduced motion, so the lane's cycle mechanism would not
  remount it. Nothing in the product navigates back to Welcome from the dungeon either. Until
  a dungeon-targeted lane exists, "no canvas/GPU growth over 20 cycles" is uncheckable by
  anyone. **Blocks a Phase 14 performance claim, not this phase's acceptance.**
- Frame time at 100 rooms is unmeasured. A tutorial-scale reading (16.6 ms mean, 16.7 ms p95)
  is vsync-bound at 3 rooms and is not 100-room evidence.
- **There is no differential Phaser-vs-Pixi parity test**, and one cannot be built against the
  flow port: it has two members that both engines implement structurally, so two doubles would
  behave identically. The walkability arithmetic is instead pinned by reading the Phaser
  source directly.
- A brief fail-open window before the first publish leaves all five controls enabled for a few
  ms after mount. The choice is deliberate and documented: an unknown action is not a disabled
  one, and the control must stay reachable until the scene says otherwise.
- **Walking due north cannot leave the root room** — the 16 px collider is sampled at four
  inset corners, so the player straddles two columns and pins on its own doorway; the east
  corridor works unaided. Also parity with Phaser. Follow-up for the generator/content owner,
  not this phase.
- Seven pre-existing sub-44 px HUD controls recorded in Phase 12 are unchanged.

#### Rollback

Set `VITE_PIXI_DUNGEON=false` (or leave it unset). Verified: the default artifact emits 0 Pixi
chunks, mounts the Phaser dungeon, requests no Pixi script, and `npm run test:e2e` passes
32/12. `FEATURE_FLAG_MATRIX.pixiDungeon` keeps its Phase 1 default of `false`, and the
`vite.config.ts` gate is additive and optional.

### Exit criteria

### Rollback

Set `VITE_PIXI_DUNGEON=false`.

### Unlocks

Phase 14.

---

## Phase 14: Creator Learning-Flow Redesign

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-03. `not-started` -> `in-progress` -> `verified` -> `complete`. The maintainer
accepted the verified checkpoint, and the phase was committed as `aff3281` and pushed to `origin/main`.
The original text recorded the phase as not yet committed, pushed, or deployed; that statement was true
when written and is superseded by that commit. Phase 15 has since been accepted and committed as
`b756d34`.

#### Baseline was red before this phase began, and was fixed first

`npm test` at `d446b3c` (Phase 13 accepted, tree clean) failed: `tests/migrations/archive.test.ts`
*"is byte-stable for identical input"*, 1 failed / 4409 passed.

**The test was wrong, not the product.** `writeArchive` is documented as deliberately *not*
byte-stable without an explicit `mtime` (`archive.ts`: *"Omitted means 'now' ... A caller that needs
a reproducible archive must pass it, because the clock is not the caller's data and this module
deliberately has no clock of its own"*), and fflate's own source is
`f.mtime == null ? Date.now() : f.mtime`. The test omitted `mtime` — the one input the module
excludes — and passed only while both `zipSync` calls shared a tick, going red under parallel load.

Reproducibility where it matters is intact and unaffected: both backup products stamp one
injected-clock `mtime` across every member (`fullDeviceBackup.ts`, `subjectBackup.ts`, clamped by
`archiveMemberTimeFrom`). Replaced with two tests that pin the contract from both sides. Proven
deterministic over 5 consecutive runs.

**Phase 13's recorded evidence is therefore not reproducible** — it claims 213 files / 4410 tests
passed, and this phase reproduced identical totals with this one test red. Per the maintainer's
instruction that evidence was left untouched; it is flagged here instead.

#### Files

- **Flag** (`infrastructure-engineer`): `src/config/{runtimeConfig,featureFlags}.ts`,
  `.env.example`, `tests/unit/runtimeConfig.test.ts`, and two closed-list gates
  (`tests/data/{subjectProductBoundary,templateProductBoundary}.test.ts`) that enumerate the matrix.
- **Command contract** (`core-logic-engineer`): `src/application/contracts/commands.ts` (+7
  `graph/*` commands), `src/application/creatorGraphCommands.ts`,
  `src/store/creatorGraphCommands.ts`, `src/store/subjectStore.ts` (+`commitSubjectSnapshot`).
- **Contract tests** (`qa-engineer`): `tests/unit/creatorGraph.{commands,revalidationParity,propagationFallback}.test.ts`,
  `tests/contracts/creator-graph-store-parity.test.ts`, and two support fixtures.
- **Creator workspace** (`ui-engineer`): `src/ui/study/` — `StudyShell.tsx`, `StudyControls.tsx`,
  `controlIds.ts`, `study.css`, `creator/{CreatorWorkspace,TopicEditor,GraphMap,creatorViewModel,creatorTools,graphLayout,useCreatorGraphActions}.tsx|ts`,
  `guide/GuideConversation.tsx`; `src/ui/components/{RoomPanel,TagEditor}.tsx`.
- **Phase 14 tests**: `tests/phase14/` (3 files + fixture), 1204 lines.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       220 files / 4543 tests passed
npm run build:web                              exit 0 (default; flag absent from env)
VITE_CREATOR_WORKSPACE=true npm run build:web  exit 0 (flag inlined as "true")
npm run check:bundle-size                      4.90 MB across 153 files (was 4.80 MB)
npm run test:e2e (default build)               32 passed / 12 skipped (4 viewports)
npm run test:licenses                          PASSED, 99 entries, 0 media under src/
npm run test:privacy                           6 files / 34 tests passed
npx vitest run tests/phase14/                  3 files / 48 tests passed
npx vitest run tests/unit/graphDomain.test.ts  11 passed
npx vitest run tests/unit/RoomPanel.test.tsx   passed (rollback lane)
```

#### Device checks

Chromium only, the four Phase-1 viewport projects; `tablet`/`tablet-landscape` touch-emulated. No
Firefox, WebKit, Edge, or physical-device evidence — those belong to Phase 21. Touch targets are
asserted ≥44 px in `tests/phase14/` and by the existing 320-pixel e2e lane, but **no real touch
device was used.**

#### Migration/data result

None. No storage, schema, or migration change; subject schema stays `1.1.0`. `src/services/` was
not touched.

#### Performance/accessibility/license result

- **No plan-10.2 performance claim is made.** Phase 13 recorded that the memory lane cannot be
  pointed at the dungeon, and Phase 14 adds no lane that could be pointed at the Creator workspace.
  Frame time and memory over mount/unmount cycles are **UNVERIFIED** and must not be claimed.
  Bundle grew 4.80 -> 4.90 MB (+0.10 MB) for ~3.8k lines of React/SVG; the workspace ships in both
  flag states because `RoomPanel` imports it statically, so the flag switches rendering, not
  presence.
- License gate PASSED, 0 media files and 0 media references under `src/`. No new assets.
- Accessibility: refusals are `disabled` **and** carry visible text, never `aria-describedby`
  alone; async outcomes announce through one `role="status" aria-live="polite"` channel in
  `StudyShell`; pre-condition refusals deliberately do *not* use the live region (announcing on
  arrival is noise); no colour-only state; ≥44 px targets.
- Privacy: no console output anywhere in `src/ui/study/**`; `test:privacy` green.

#### Exit-criteria assessment

1. **Create, link, reparent, tag, move, delete by keyboard or touch** — met. Every verb has a DOM
   route with no pointer requirement, covered in `tests/phase14/`. Node repositioning stays
   presentation-only local state.
2. **Revalidation unchanged** — met and pinned. 9 tests assert the four graph commands flip
   `ArtifactCollected -> NeedsRevalidation` on hand-computed room sets while the three tag commands
   leave every status alone (the pre-Phase-14 store's tag actions ran no propagation; that
   asymmetry is preserved deliberately, not fixed). 4 more pin that a propagation refusal falls
   back to the unpropagated dungeon instead of aborting.
3. **Phase transition available at the intended point** — met; Scribe handoff retained behind the
   same `rooms.length >= 3` condition.
4. **No duplicate mutations under StrictMode** — met. `tests/phase14/creator-strictmode.test.tsx`
   counts store writes per verb rather than renders, and covers the mounted/re-render case.

#### Non-vacuity evidence

Every repair was reverted to confirm it goes red, then restored:

| Probe | Result |
| --- | --- |
| Revert the stranded-view fix in `RoomPanel` | cascade-delete test red |
| Revert the `linkRefusal` cross-link case | related-row test red |
| Re-freeze the test harness snapshot prop | reparent-row test red |

The `qa-engineer` ran 5 further mutation probes of its own, including flipping the revalidation
fixture's `phaseState` (4 propagation tests red, 3 tag tests correctly stayed green).

**Two probes caught my own bad fixes.** The first attempt at the related-topics tests was wrong
(`openRegion` was not the cause) and the `linkRefusal` fix was initially covered by nothing; the
probe is what revealed that before it shipped.

#### Defects found and fixed during the phase

- **A cascade delete stranded the learner.** `RoomPanel` early-returned a legacy panel reading
  *"Walk into a room to inspect it"* when the focused room was gone, so deleting the room you were
  on left a dead view with no route back into the graph — and in the Creator phase there is nothing
  to walk to. `CreatorWorkspace` already had a correct root fallback that was unreachable because
  `RoomPanel` returned first. Fixed by keeping the workspace mounted with a `null` focus.
- **The related-topics row offered a control that could only fail.** Every row in that list is
  already connected by construction, but `linkRefusal` was set only for subtopic pairs, so
  cross-link rows got an enabled button whose only possible outcome was `EDGE_ALREADY_EXISTS`.
  Where a refusal did apply, the button was omitted with no explanation while the reparent case
  showed one. Both halves fixed.
- **Three comments and tests asserted things the code did not do**: `commands.ts` claimed *"nothing
  under `src/ui/**` calls a graph domain function directly"* (four files do — reads, not
  mutations); `creatorGraphCommands.ts` claimed persistence failures *"still reject"* (true for the
  four graph commands, false for the three tag commands); a test expected a heading of `Vectors`
  where Matrices' parent is the root; a test named *"dispatches once"* asserted
  `not.toHaveBeenCalled()`. All corrected.
- **A test harness froze the snapshot** as a prop, so the workspace never re-rendered after a
  mutation. `GameScreen` subscribes live, so the product was right and the harness was wrong.

#### Known limitations

- **No plan-10.2 performance or memory evidence** (above). Unchanged from Phase 13.
- **Tag-command write-failure divergence.** The store's tag actions wrap `await persist` in the
  same `try` as the domain call, so a failed write is swallowed into `lastError` and the action
  resolves; `applyTag` awaits `commit` outside its `try`, so the command rejects. The command form
  is kept on purpose: `ok: true` beside a failed write would be a typed lie. Making the store reject
  too would turn the rollback lane's `void addRoomTag(...)` into unhandled rejections, so it is
  **not this phase's change to make**. Pinned as a known divergence in
  `creator-graph-store-parity.test.ts` and documented in the module header. **Needs an owner.**
- **`dungeon.tagIndex` is never rebuilt after a cascade delete**, so it serves dangling room ids to
  any consumer that does not cross-check `snapshot.rooms`. Pre-existing domain gap, now enshrined
  by the parity contract. Harmless today; a trap for a future consumer.
- **The archetype changes tool prominence only.** The Cartographer gets graph and links open on
  arrival with cross-link leading; the Scholar gets topic and tools. No suggestion engine was built
  — `TopicSuggestionInput` remains declared-and-unused, and "no adaptive graph suggestions yet" is a
  Phase 14 non-goal. Scholar's and Archivist's perks remain unimplemented text in `playerClasses.ts`
  and are **still owed** by Phases 15 and 16.
- **Domain refusals are unreachable through the UI**, because every control derives its options
  from `linkCandidates`/`reparentCandidates`. Good defence in depth, but it means the
  "refused command" path has no browser-reachable case.
- Chromium only, emulated touch only (above). Phase 13's seven sub-44 px HUD controls are unchanged.
- **The memory lane still cannot target the dungeon** (Phase 13), and Phase 14 adds no lane.

#### Rollback

Verified in both directions, in built artifacts rather than by flag constant. The default build's
inlined `import.meta.env` carries no `VITE_CREATOR_WORKSPACE`, so `parseBoolean` returns the
default `false` and `RoomPanel` renders the untouched pre-Phase-14 Creator view against the
pre-Phase-14 store actions. `VITE_CREATOR_WORKSPACE=true npm run build:web` inlines
`VITE_CREATOR_WORKSPACE:"true"` and the same parser returns `true`. `FEATURE_FLAG_MATRIX.creatorWorkspace`
defaults to `false` and is **not** in `NON_CUTOVER_FLAG_KEYS`. `npm run test:e2e` on the restored
default build passes 32/12.

An earlier reading of the minified bundle appeared to show `creatorWorkspace:!1` in the flag-on
build; that is `DEFAULT_RUNTIME_CONFIG`, which correctly stays `false`. The parsed value was
confirmed from the inlined env object and the parse call site.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-03. `not-started` -> `in-progress` -> `verified` -> `complete`. The maintainer
accepted the verified checkpoint, and the phase was committed as `b756d34` and pushed to `origin/main`.
The original text recorded the phase as not yet committed, pushed, or deployed; that statement was true
when written and is superseded by that commit. Phase 16 has since been accepted and committed as
`ade1f78`.

Phase 14 was `verified` and awaiting acceptance; the maintainer's instruction to execute Phase 15
is recorded here as acceptance of that checkpoint.

#### Baseline

Green at `aff3281` before any change: `npm run lint`, `npm run typecheck`, and `npm test` at
**220 files / 4543 tests** — identical to Phase 14's recorded totals, so Phase 14's evidence is
reproducible. No baseline repair was needed this phase.

#### Files

- **Ledger** (`core-logic-engineer`): `src/core/progression/roomClearRewards.ts` (355 lines) +
  `index.ts` export.
- **Encounter commands** (`core-logic-engineer`): `src/application/encounterCommands.ts` (641),
  `src/store/encounterCommands.ts` (119), `src/application/contracts/commands.ts` (+102, four
  `encounter/*` members with derived payload aliases).
- **Scribe view model** (`core-logic-engineer`): `src/ui/study/scribe/scribeViewModel.ts` (501).
- **Reward wiring** (`core-logic-engineer`): `src/store/progressionStore.ts` (+97).
- **Workspace** (`ui-engineer`): `src/ui/study/scribe/{ScribeEncounter,NoteComposer,ValidationSummary,ArtifactPreview}.tsx`,
  `useScribeEncounterActions.ts`, `scribe.css`; `src/ui/study/{controlIds,StudyControls,StudyShell}.ts(x)`;
  `src/ui/screens/GameScreen.tsx`.
- **Pixi artifact event** (`game-engineer`): `src/renderers/pixi/dungeon/{dungeonArtifact,createDungeonScene,DungeonWorld,RoomNode,DungeonRenderer}` (+480 net).
- **Flag** (`infrastructure-engineer`): `src/config/{runtimeConfig,featureFlags}.ts`, `.env.example`,
  `tests/unit/runtimeConfig.test.ts`, two closed-list gates.
- **Tests**: `tests/phase15/` (5 files + fixture, 69 tests), `tests/phase15-qa/` (9 files, 66 tests),
  `tests/phase14/study-shell-boundary.test.ts` (6), `tests/unit/{roomClearRewards,encounterCommands,scribeViewModel,pixiDungeonArtifactRule}.test.ts`
  + `pixiDungeonArtifactCollection.test.tsx`.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       240 files / 4801 tests passed   (was 220 / 4543)
npm run build:web                              exit 0
npm run check:bundle-size                      4.97 MB across 153 files (was 4.90 MB)
npm run test:e2e                               32 passed / 12 skipped (4 viewports, Chromium)
npm run test:licenses                          PASSED, 99 entries, 0 media under src/
npm run test:privacy                           6 files / 34 tests passed
npx vitest run tests/unit/noteValidation.test.ts     4 passed
npx vitest run tests/unit/artifactGenerator.test.ts  1 passed
npx vitest run tests/unit/NoteEditorModal.test.tsx   7 passed
npx vitest run tests/phase13/                   5 files / 102 tests passed
```

#### Where the ledger lives, and why

Inside the canonical per-subject progression record's preserved unknown-app-owned-field carrier
(`extraFields`) under the static key `roomClearRewardLedger`. Rejected: a new storage-v2 store (a
data-format change, outside this phase), `RoomMetadata` (subject schema stays `1.1.0`), and a
separate `localStorage` key (no migration, no generation membership, no backup membership).

`src/core/progression/canonicalProgression.ts` and `src/services/persistence/v2/validation.ts` are
**byte-identical to `aff3281`** — verified, not asserted. The unknown-field machinery already
round-trips the value through the legacy mirror, the storage-v2 generation, both backup products,
and subject-copy ID remapping. QA independently confirmed a real `.kdbak` round trip, a
`.kdsubject` export/copy-import with `roomId` remapping, zero validation problems, and a real
`exportSubjectTemplate` output containing neither the ledger key nor the clear identity.
`CURRENT_SCHEMA_VERSION` stays `1.1.0`.

Identity = FNV-1a digest over the room id, its direct neighbours, and every edge touching either —
exactly the set `propagateRevalidationAfterGraphMutation` can reach, which QA verified is one hop.

#### Exit-criteria assessment

1. **Existing validation output unchanged** — met. `src/core/validation/notes/` and
   `src/core/artifacts/` are untouched (`git status` empty for both), so the output cannot have
   changed. `NoteEditorModal.test.tsx` and `noteValidation.test.ts` pass unchanged.
2. **A valid note clears and rewards a room exactly once** — met. Three submissions diff the whole
   progression record to exactly one award; submissions 2 and 3 report
   `awarded:false, duplicate:true, xpGained:0`. Same-tick double dispatch awards once. Suppression
   survives a real page load (`resetModules` + re-hydrate). A graph mutation *inside* the
   propagation window awards again (`roomsCleared === 2`); one *outside* it does not.
3. **An invalid note saves a draft without progression** — met. Five draft submissions leave the
   entire progression value byte-identical; `kind:'draft'`, `progression:null`,
   `artifactMarkdown:null`. The dangerous ordering (clear, then write an invalid note) also holds.
4. **Image attachment and preview work locally** — met against real `fake-indexeddb`: bytes
   round-trip byte-for-byte, the resolved source is a `blob:` URL, no `externalUrl`, and
   `fetch`/`XMLHttpRequest`/`sendBeacon` are never touched. Removal deletes bytes and metadata.
5. **Artifact generation and pickup remain separate actions** — met. A clear writes the artifact
   and leaves `collectedNotes` empty; the pickup control is offered only when
   `artifact.canCollect`; an unbound pickup rejects rather than reporting success.

#### Non-vacuity evidence

Every repair was reverted to confirm it goes red, then restored. All reverted; the working tree is
the intended one.

| Probe | Result |
| --- | --- |
| Remove the suppression branch in `decideRoomClearReward` | 8 tests red across 3 files |
| Identity -> constant `clear-deadbeef` | 3 red |
| Identity -> hash the room id only | 2 red, incl. `P3` |
| `runNoteSubmit` supplies a constant identity | 2 red |
| Identity hashes every edge (window-insensitive) | 2 red |
| Revert the `sessionStore` import direction | 2 red in the boundary test |
| Make the boundary test's `plantProbe()` a no-op | 1 red (its control asserts `existsSync`) |
| Inject a real `fetch('/api/upload', FormData)` into `NoteComposer` | privacy gate red, naming the file |
| Swap the seed/insert effect order | 5 QA probes red + the implementers' own test |
| `grep -rn "awardRoomClear" src/ui/` | one code path only, in the rollback modal |

#### Defects found and fixed during the phase

- **The signpost insertion silently discarded every insert.** `ScribeEncounter`'s seed effect runs
  *after* its child `NoteComposer`'s (React runs child effects first), so the composer appended the
  pending text and the parent immediately overwrote `sections` from `room.noteText` — while still
  draining the one-shot token. `NoteEditorModal` never had this bug because both effects are in one
  component, declared seed-then-insert. Fixed by hoisting both effects into `ScribeEncounter` in
  that order.
- **`tests/phase14/study-shell-boundary.test.ts` never existed.** `StudyShell.tsx` has claimed since
  Phase 14 that this file holds the boundary. Nothing enforced it, so Phase 15's new
  `src/ui/study/scribe/**` was equally unenforced. Written in Phase 15, and it immediately found a
  real violation below.
- **The study surface was transitively renderer-coupled.** `src/store/sessionStore.ts` imported
  `PlayerClassId` from `@/game/systems/playerClasses`, putting `src/game/**` in the closure of every
  `src/ui/study/**` module that reads `GamePhase` from that store. The canonical declaration is the
  neutral one in `@/application/contracts/world`, and `playerClasses.ts` already asserts its own
  duplicate matches it. One import line fixed it; `git diff` confirms it is the only change to that
  file.
- **A learner could be told a false sentence.** `awarded:false` covers three causes — ledger repeat,
  progression refusal, and *no active progression subject at all* — but the feedback layer branched
  on `!awarded` alone, so a clear that was never awarded was announced as "already rewarded". Now
  keyed on `duplicate`, with a distinct sentence for the other cases.
- **Two specialists could not run the gate** (no shell in their sessions). One shipped a build-
  breaking type error (`SCRIBE_CONTROL_IDS.composerMode`) and an entirely unexecuted test file. The
  orchestrator ran the gate; 7 type errors and 2 failing test files were fixed.
- **A test that could never go green.** QA's D1 test copied the buggy branch into the test body and
  asserted on the copy. Rewritten to render the real workspace and assert the real sentence, with a
  control test proving a genuine repeat still says "already rewarded".

#### Known limitations

- **No plan-10.2 performance or memory evidence.** Unchanged from Phases 13 and 14. `check:memory`
  is a build-level preflight; it measures no frame time, heap growth, or GPU texture. The memory
  lane still cannot be pointed at this surface. Frame time and memory over mount/unmount cycles are
  **UNVERIFIED** and must not be claimed.
- **Chromium only, and no e2e spec visits the Scribe surface.** `test:e2e` is 32 passed / 12 skipped
  across four viewports. **No 320px, 200%-zoom, reduced-motion, or axe evidence for the redesigned
  workspace** — the automated axe lane runs on the Welcome view only. No Firefox, WebKit, or Edge
  evidence; Phase 21 owns it.
- **The rollback lane double-awards and restructures notes.** `NoteEditorModal` still calls
  `awardRoomClear` with no clear identity (`roomsCleared === 2` on two valid submits), and on a
  resubmission its `extractNoteSections` reads the composer's own outer headings as body text, so the
  learner's `## Summary` / `## Key Points` / `## Recall Question` structure is lost while the prose
  survives. Both are pre-Phase-15 behavior in the lane Phase 15's scope line told it to preserve.
  The new workspace does neither. **Needs an owner: core-logic-engineer, post-cutover.**
- **`room.artifactMarkdown` can never be byte-stable across a resubmission.** The clear branch of
  `submitNote` regenerates it with a fresh `generatedAtIso`. Pre-Phase-15, out of scope here,
  recorded rather than changed.
- **`EncounterNoteDraftOutcome.validation` carries one undeclared key** (`artifactMarkdown`),
  because `runNoteSubmit` assigns the whole `submitNote` result. Harmless for named-field consumers;
  a trap for `Object.keys` or exact comparison.
- **`host-vs-domain pickup gate.** `GameScreen` now passes a named `HOST_PERMITS_ARTIFACT_PICKUP`
  constant instead of `phase === 'archaeologist'`, because the domain's `collectArtifact` tests only
  `room.artifactMarkdown` and has no phase test — the host, not the domain, was what stranded the
  Scribe-phase pickup. QA verified `src/renderers/**` contains no phase comparison and cannot learn
  the study vocabulary.
- **Bundle grew 4.90 -> 4.97 MB (+0.07 MB)**. The workspace is statically imported by `GameScreen`
  in both builds (verified in minified output), so the flag selects at runtime and the bytes ship
  with the flag off — correct for rollback, and it is the size increase.
- **Possible flake, not attributed to Phase 15.** `tests/privacy/uploadBoundary.test.ts` failed once
  when run alongside two suites that plant probe directories inside `src/`; it did not reproduce in 9
  subsequent identical runs, nor in `test:privacy`, nor in the full `npm test`.

#### Rollback

Verified in built artifacts rather than from the flag constant. The default build inlines
`import.meta.env` with **no `VITE_SCRIBE_ENCOUNTER_WORKSPACE` value**, so `parseBoolean` returns the
default `false` and `GameScreen` renders `NoteEditorModal`; `VITE_SCRIBE_ENCOUNTER_WORKSPACE=true
npm run build:web` inlines the value and renders `ScribeEncounterDialog`.
`FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.productionDefault === false` and it is **not** in
`NON_CUTOVER_FLAG_KEYS`. QA confirmed the rollback lane end to end **unmocked**: the modal renders as
`dialog[name="Note editor"]`, an invalid note saves a composed draft with zero progression, a valid
confirmed note clears and generates an artifact, and the journal stays empty.

As in Phase 14, the flag's *identifier* survives in the bundle inside `RUNTIME_FLAG_ENV_KEYS` and
`DEFAULT_RUNTIME_CONFIG` reads `scribeEncounterWorkspace:!1` in both builds. What differs is the
inlined **value**; that is the safe default literal, not the parse result.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-03. `not-started` -> `in-progress` -> `verified` -> `complete`. The maintainer
accepted the verified checkpoint, and the phase was committed as `ade1f78` and pushed to `origin/main`.
The original text recorded the phase as not yet committed, pushed, or deployed; that statement was true
when written and is superseded by that commit. The maintainer's instruction to execute Phase 17 is
recorded here as acceptance of this checkpoint; Phase 17 has since been accepted and committed as
`a6d8b70`.

Phase 15 was `verified` and awaiting acceptance; the maintainer's instruction to execute Phase 16
is recorded here as acceptance of that checkpoint. The Phase Summary row for 15 said
`not-started` and was stale; it is corrected, as was 16's own row.

#### Baseline

Green at `b756d34` before any change: `npm run lint`, `npm run typecheck`, `npm test` at
**240 files / 4801 tests**, `npm run build:web`, `npm run check:bundle-size` at
**4.97 MB / 153 files**. Identical to Phase 15's recorded totals, so Phase 15's evidence is
reproducible. No baseline repair was needed.

#### Files

- **Ledger** (`core-logic-engineer`): `src/core/review/reviewPassRewards.ts` (438),
  `src/core/review/reviewPasses.ts` (311+), `src/core/review/interruptedReviewSession.ts` (247),
  `src/core/review/index.ts`.
- **Command layer** (`core-logic-engineer`): `src/application/reviewCommands.ts` (665),
  `src/store/reviewCommands.ts` (67), `src/application/contracts/commands.ts` (+123, five
  `review/*` members with derived payload aliases).
- **Flow** (`core-logic-engineer`): `src/application/studyFlow.ts` (+371),
  `src/store/progressionStore.ts` (+156), `src/core/review/spacedRepetition.ts` (+24).
- **Workspace** (`ui-engineer`): `src/ui/study/review/{ArchaeologistWorkspace,RecallCard,ReviewProgress,reviewViewModel,useReviewActions}.ts(x)` + `review.css` (423); `src/ui/study/{controlIds,StudyShell}.ts(x)`;
  `src/ui/components/{RoomPanel,FullMapView,HelpOverlay}.tsx`; `src/ui/screens/GameScreen.tsx`;
  `src/ui/village/villageStudyFlow.ts`.
- **Copy** (`village-content-designer`): `src/ui/components/RoomNpcDialog.tsx`,
  `src/data/gameGuide.ts`, `src/data/villageLayout.ts`, `src/store/sessionStore.ts` (one quest
  hint), `docs/GAME-GUIDE.md`.
- **Renderer** (`game-engineer`): **zero lines changed** under `src/renderers/**` or
  `src/game/**`. Parity was verified, not assumed.
- **Flag** (`infrastructure-engineer`): `src/config/{runtimeConfig,featureFlags}.ts`,
  `.env.example`, plan section 11.
- **Tests**: `tests/phase16/` (16 files), plus re-pins of
  `tests/contracts/phase-2-study-flow.test.ts` and `tests/unit/GameScreen.npcDialog.test.tsx`.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       256 files / 5029 tests passed   (was 240 / 4801)
npm run build:web                              exit 0
npm run check:bundle-size                      5.06 MB across 153 files (was 4.97 MB)
npm run test:e2e                               32 passed / 12 skipped (4 viewports, Chromium)
npm run test:licenses                          PASSED, 99 entries, 0 media under src/
npm run test:privacy                           6 files / 34 tests passed
npx vitest run tests/unit/reviewDomain.test.ts     3 passed
npx vitest run tests/unit/spacedRepetition.test.ts 41 passed
npx vitest run tests/unit/GameScreen.npcDialog.test.tsx 6 passed
npx vitest run tests/contracts/phase-2-study-flow.test.ts 52 passed
npx vitest run tests/phase16/                 16 files / 219 tests passed
npx vitest run tests/phase15/                 5 files / 69 tests passed
npx vitest run tests/phase13/                 5 files / 102 tests passed
```

#### Where the ledger lives, and why

In the canonical per-subject progression record's preserved unknown-app-owned-field carrier
(`extraFields`), under `reviewPassRewardLedger` beside Phase 15's `roomClearRewardLedger`. Same
three rejected alternatives, same reasoning.

**The subject record's carrier was rejected on evidence, not taste**, and that finding matters
beyond this phase: `withRooms` in `src/store/subjectStore.ts` rebuilds every snapshot as
`{ dungeon, rooms }`, so an unknown top-level key dies on the next room write, and
`migrateToV11` is configured `unknownTopLevelFields: 'drop'`. `JSON.stringify` round-trips such a
key in isolation, which is exactly the trap — it looks right in a test and vanishes in the app.
The interrupted-review marker is in the same carrier for the same reason.

**No canonical-progression version change.** `src/core/progression/canonicalProgression.ts` and
`src/services/persistence/v2/validation.ts` are **byte-identical to `b756d34`** — verified by
`git diff --stat` and by matching `git hash-object` against `git rev-parse b756d34:<path>`, not
asserted. `CURRENT_SCHEMA_VERSION` stays `1.1.0`; `src/core/validation/persistence/` has an empty
diff. No migrations, no new storage stores.

**Identity = (app-minted room id, integer pass number), `rpass-<8 hex>`.** The obvious identity —
(room, `reviewPassCount`) — is wrong in exactly the case this ledger exists for, because
`reviewPassCount` is written by an **async** subject-store call, so it does not move within the
tick that decides the award. The pass number is `fullReviewPasses + 1` over reviewable rooms from
the pre-increment analytics: stable across every room in one pass, identical across same-tick
duplicates, different next pass. A test pins that entries carry exactly four keys and that no
topic, note, artifact, or subject name can reach an entry or a digest input.

#### Exit-criteria assessment

1. **The full Creator to Scribe to Archaeologist path passes** — **partially met.** Creator (Phase
   14) and Scribe (Phase 15) are untouched and green. The Archaeologist path is covered at flow
   level (`tests/phase16/studyFlowReview.test.ts`), store level
   (`reviewCommandStoreBinding.test.ts`), and real-screen level
   (`review-marker-publication.test.tsx`, `dungeon-review-signal-parity.test.ts`). **No browser
   e2e spec visits it** — see *Unmet deliverable*.
2. **Review pass and XP cannot be double-counted** — met, after the orchestrator caught a defect
   QA's 24 probes had missed. See *Defects found*.
3. **SM-2 values survive reload and backup** — met. Reload was covered; the **backup half was
   only an inherited argument**, so QA wrote `tests/phase16/review-backup-round-trip.test.ts`: a
   real `.kdbak` export imported into a second empty device, and a real `.kdsubject` export
   imported with `replace`. Both assert the SM-2 numbers round-trip **and** that the restored
   ledger still returns `already-awarded` for the awarded `(room, 1)` while still permitting
   `(room, 2)`.
4. **Review unlocks behave consistently** — met. `canReviewRoom` delegates to
   `evaluateReviewUnlock`, the same function `RoomPanel` renders, so the displayed and enforced
   rules are one call. A locked room arms nothing and says why.
5. **Exiting during review does not silently lose committed work** — met. `returnToVillage`
   re-saves the durable marker and announces it; `review/session-discard` is the explicit other
   choice; `session-resume` reports whether a marker existed.

#### Defects found and fixed during the phase

- **A double award on the most natural sequence, which 24 non-vacuity probes missed.** Rating a
  room, clicking **Complete this review pass**, then closing the room panel — the sequence the
  workspace's own copy describes — paid **twice**. `awardReviewPass` increments `reviewPassCount`,
  so if the explicit completion is the room that *finished* a full pass, `fullReviewPasses`
  advances, and the panel-close route re-derives pass N+1, an identity the ledger has never seen.
  No test performed that sequence, so no probe could catch it; the orchestrator wrote one and it
  failed. Fixed by guarding `finalizePendingReview` on the durable marker, which
  `awardReviewPass` clears in the same record write as the award. Removing the guard turns **4**
  tests red (`tests/phase16/panelCloseAfterExplicitReview.test.ts`), verified independently.
- **The "once per room per pass" test was a mock artifact.** `GameScreen.npcDialog.test.tsx`
  stubbed `summarizeReviewAnalytics: () => ({ fullReviewPasses: 0 })` over a **one-room** dungeon.
  On one reviewable room `fullReviewPasses = trunc(1/1) = 1`, so the second finalize was a
  *genuine* pass-2 review that correctly paid again. The test never tested the domain. Fixed with
  a multi-room fixture, the stub deleted, and a positive control: after a suppressed second close,
  a **different** room in the same pass still awards. Without it, "the total did not move" would
  pass against a flow that never awards.
- **The Phase 2 contract fixture was asserting the defect this phase exists to fix.** Its six
  review tests cleared 1 of 4 rooms — a state `RoomPanel` simultaneously labelled "Clear every
  room encounter to unlock full review mode" — and asserted that the review armed, finalized,
  awarded 25 XP, toasted, and evaluated badges. Re-pinned with a separate unlocked fixture;
  `makeSnapshot()` is untouched for its ~45 other consumers.
- **The learner could be told a false sentence.** `describeReviewRefusal` hardcoded
  `${totalRooms}/${totalRooms}`, correct only at the default ratio of 1; at `0.5` on ten rooms it
  said "unlocks at 10/10". Now derived with `ceil`, and pinned by a test that *asks*
  `evaluateReviewUnlock` for the smallest unlocking count at five ratios and asserts the printed
  threshold equals it.
- **The workspace claimed every room was the root topic.** `StudyShell` renders an empty
  breadcrumb as "This is the root topic.", and the workspace passed `breadcrumb: []` and
  `floor: <subject name>` unconditionally. The sentence was unreachable from every workspace once
  a real breadcrumb is derived, so it was corrected at the shell as well — `breadcrumbRoomIdsByRoomId`
  is inclusive of the room, so an empty list can only mean "no room here".
- **A pass could be completed twice through two different labels.** `UNRATED_REVIEW_QUALITY` was
  not "unrated"; it is a real 3 that writes SM-2 state, and the panel-close route passes it
  unconditionally, so "Closing the room panel does the same thing" and "counts this pass **if** you
  rated it" were both false. Renamed to `CLOSED_WITHOUT_RATING_QUALITY` and every surrounding
  sentence made unconditional, with the 3 interpolated from the constant so copy cannot drift.
- **A manual that described controls the shipping build does not render.** The in-app guide and the
  room guide both gained sentences about the 0–5 rating, save, and resume, none of which exist
  with `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false`. Both are now **flag-aware**, reading
  `runtimeConfig` once at module scope exactly as `RoomPanel` does, so each lane's copy is true of
  the lane it is rendered in.
- **`docs/GAME-GUIDE.md` is a hand-maintained copy of `src/data/gameGuide.ts` with no generator**,
  despite the source file's "Auto-generated" header. The Phase 3 section is now mirrored with both
  lane variants recorded. **Nothing will regenerate the `.ts` from the `.md`, so the next person
  who assumes it will silently revert the fix.**
- **Three documented behaviours did not exist.** The guide promised a 0–5 rating (there was no
  control, and `StudyFlowStorePort.recordReviewPass` was declared one-argument so 3 was the only
  reachable rating); it promised a **review streak** (there is none — `longestReviewStreak` is
  hard-coded `0` and `currentReviewStreak` is fed the *note-quality* streak); and it attributed
  the unlock to the *phase* (which is ungated) rather than to the *review*.
- **A fake store re-implemented production behaviour.** `studyFlowReview.test.ts`'s fake performed
  the marker clear itself, so the test "a marker left by an interrupted review does not survive its
  own completion" asserted the fake and would have passed against a broken store. Deleted as
  redundant with the real-store test, and the fake now says so in a comment.
- **A test passed for the wrong reason.** `studyFlowReview.test.ts`'s "the refusal is enforced on
  finalize too" completed a review first, so the second call was suppressed by the **duplicate**
  rather than the **unlock** — it stayed green with the unlock check removed. Rewritten against a
  never-completed room and the flow's own sentence; removing the check now turns it red.

#### Non-vacuity evidence

Twenty-four probes from QA, all reverted (`git diff --stat` identical before and after; a
sha256-checked harness aborted on any mismatch). Every one but two went red:

| Probe | Result |
| --- | --- |
| Remove the ledger consultation in `awardReviewPass` | RED 3/36 |
| `hasReviewPassReward` always `false` | RED 7/33 |
| Pass number -> constant `1` | RED 2/82 |
| Remove the unlock check in `roomInteract` | RED 1/82 |
| Remove the `returnToVillage` save branch | RED 1/26 |
| Remove the `extraFields` marker write | RED 3/32 |
| Remove the `already-awarded` early return | RED 2/36 |
| `CLOSED_WITHOUT_RATING_QUALITY` 3 -> 4 | RED 1/50 (copy constant follows) |
| `deriveReviewPassIdentity` -> a constant | RED 1/29 |
| Remove the `!duplicate` gate on the SM-2 write | RED 1/64 |
| Report pre-increment instead of post-increment pass progress | RED 2/89 |
| Drop the ledger write inside `awardReviewPass` | RED 2/38 |
| Remove the unlock refusal from `requireReviewableRoom` | RED 1/106 |
| Ledger written under a renamed carrier key | RED 1/35 |
| Drop `review.passComplete` from `finalizePendingReview` | RED 17/77 |
| `daysSinceReviewDue` always `0` | RED 5/65 |
| `canReviewRoom` always allows | RED 4/54 |
| `GameScreen` reviewed filter -> `reviewPassCount > 1` | RED 4/9 |
| `DungeonRenderer.setReviewedArtifactRooms` body emptied | RED 2/8 |
| `dungeonArtifact.ts` gains a `@/store` import | RED 3/8 |
| Revert the Phase 2 re-pin | RED 1/52 |
| Revert the npcDialog re-pin | RED 1/6 |
| **Remove the marker guard in `finalizePendingReview`** (orchestrator) | **RED 4/6** |
| Remove the flow's own `canReviewRoom` from `finalizePendingReview` | RED 1 (was GREEN; fixed) |

**Two probes were GREEN and are recorded as findings, not suppressed:** the fake-store finding and
the wrong-reason finding above. Both are now resolved.

#### The two test files other agents changed, and the ruling

- **`tests/data/localDownloadOnly.test.ts`** — legitimate, and now strictly stronger. QA restored
  the old assertion verbatim and measured it: `everySourceModule()` enumerates **248 code modules**
  while the walk reaches **248 paths of which 12 are non-code** (9 stylesheets, 2 locale JSONs,
  `src/styles.css`), so `paths.length < all.length` was comparing two different populations and was
  literally false. The replacement compares 236 code against 248 code — a true proper-subset claim
  — and adds two constraints: every reached path is under `src/`, and every non-code path is
  `.css` or `.json`.
- **`tests/phase14/study-shell-boundary.test.ts`** — a strengthening. The five modules of
  `src/ui/study/review/**` are named individually rather than globbed.
- **`tests/phase8/qa-verification.test.ts`'s `LEGACY_TAIL_LINES` pin** — worked around, not
  relaxed: `src/styles.css` is byte-identical to `b756d34` and the new stylesheet is colocated at
  `src/ui/study/review/review.css`. **Caveat:** that file therefore sits outside the Phase 8
  no-remote-font scan, which reads `src/styles.css` only. Checked by hand — no `url(`,
  `@font-face`, or `https?://`.

#### Unmet deliverable

- **"Complete golden-path E2E test" is not met.** `grep` over `tests/e2e/**` for
  `ArtifactCollected|finalPass|recordReviewPass|archaeologist|Defeat Encounter` returns nothing: no
  spec visits a cleared room, a room panel, or the review surface. Three reasons it is not a small
  fix: `test:e2e` builds the **default** artifact, whose inlined `import.meta.env` has no
  `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` key, so a new spec would drive the **rollback** panel and
  `ArchaeologistWorkspace` is not in that artifact at all; covering it needs a flagged build lane
  with a recorded artifact identity, the shape of `test:e2e:compat` and `test:e2e:pixi-memory`;
  and the plan's phrase is the full three-phase path, which means driving three note-writing
  encounters through a real Phaser dungeon, where the existing specs already take 1–2 minutes per
  viewport on player movement alone. Phases 14 and 15 recorded the identical gap. **Needs an
  owner: qa-engineer, with the next flagged Playwright lane.**

#### Known limitations

- **No performance or memory evidence.** `check:memory` is a build-level preflight measuring no
  frame time, heap, or GPU texture; it was not run and is not presented as evidence. **Frame time
  and mount/unmount memory over 20 cycles are UNVERIFIED** for this surface, unchanged from Phases
  13–15.
- **Accessibility evidence is semantics only.** The review surface has jsdom component coverage for
  roles, `aria-labelledby`/`describedby`, the radio group, region maps, focus targets, and
  44-pixel inline styles. `npm run test:e2e` runs 11 specs across four Chromium viewports and the
  automated axe lane runs on the **Welcome view only**. **No 320px, 200%-zoom,
  `prefers-reduced-motion`, screen-reader, or Firefox/WebKit/Edge evidence** for this surface, and
  none is claimed. `check:budget:welcome` was not re-measured. Phase 21 owns that audit.
- **Bundle grew 4.97 -> 5.06 MB (+0.09 MB)**, 153 files unchanged, and identical in both lanes.
  `RoomPanel` statically imports `ArchaeologistWorkspace`, so the bytes ship with the flag off —
  correct for rollback, and it is the size increase.
- **The panel-close route ignores the learner's rating, deliberately.** It must work with no
  rating control on screen at all, which is exactly the rollback lane. The residual cost is stated
  in three files: a learner who rates a room 5 and closes the panel is recorded as a 3, and their
  schedule drifts toward "correct with serious difficulty". Unifying the routes was analysed and
  **is not a one-line change** — when the explicit completion is the room that *finished* a pass,
  the close re-derives N+1, which is why the marker guard now exists instead.
- **The unbound-host lane cannot be guarded.** The marker guard is gated on
  `reviewSessionDurable()`, so the Phase 2 contract harness keeps its pre-Phase-16 behaviour byte
  for byte — and would still double-award. Unavoidable without breaking that contract, and
  unreachable in the app: of the two `createStudyFlowController` hosts, `villageStudyFlow` binds an
  all-no-op dungeon UI so `closeInfoPanel` is never dispatched, leaving `GameScreen` as the only
  reachable path. **Every reachable host is repaired.**
- **`summarizeReviewAnalytics` and `summarizeReviewPassProgress` still disagree under a partial
  clear.** The former divides by *reviewable* rooms, the latter reports the displayed pair over
  *all* rooms. Phase 16 changed no displayed number; it centralised the derivation and named the
  divergence. **The HUD denominator is still wrong on a partially-cleared dungeon. Needs an owner:
  Phase 18, with the dashboard change.**
- **The interrupted-review marker is single-slot per subject** — interrupting room B while room A's
  is open replaces A's. `session-resume` reports `waitingForRoomId` so a surface can say so.
- **`review/session-save` records the rating beside the marker but never applies it.** A resumed
  review shows the saved rating; SM-2 moves only on completion.
- **Follow-up work found and deliberately not done** (plan working rule 13): the Archivist
  archetype's "Higher self-check cap during review phase" in `gameGuide.ts` and `StructurePanel.tsx`,
  and `archivistDesc` "+3 max review streak cap" in `en.json`/`es.json` — no caller passes
  `maxPromptCount` for room review prompts and there is no max-streak cap. Also the guide's Study
  Statistics bullet "Review streaks", `Rooms per session`, and `Retention trends`, none of which
  `StudyStatsPanel` renders. **Needs an owner: village-content-designer with Phase 18.**
- **Possible flake, not attributed to Phase 16.** `tests/e2e/currentBuild.spec.ts` "the default
  village build moves the player with the arrow keys" failed once in the `chromebook` viewport
  across one of three full runs. It passed in isolation and in the immediately following full run
  (32 passed / 12 skipped, matching QA's recorded result). Timing-sensitive village movement,
  unrelated to the review surface.

#### Rollback

Verified in **built artifacts**, not from the flag constant. The default build inlines
`import.meta.env` with **no** `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` key, so `normalizedRawValue`
returns `{present:false}` and `parseBoolean` takes the default `false`;
`VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=true npm run build:web` inlines the value and reaches
`ArchaeologistWorkspace`. `FEATURE_FLAG_MATRIX.archaeologistReviewWorkspace.productionDefault ===
false` and it is **not** in `NON_CUTOVER_FLAG_KEYS` (which remains exactly `['audioEnabled']`). The
pre-Phase-16 notes-tab body is preserved verbatim in the `else` arm of one ternary in `RoomPanel`.
`tests/phase16/review-rollback-award.test.tsx` pins that the branch control
`#archaeologist-pass-complete` is absent from the DOM and that the rollback lane still finalizes
and awards.

**Correcting an earlier assumption:** the rollback lane is **not** a double-pay risk. All three
`src/` call sites of `progressionStore.awardReviewPass` forward the identity, and
`finalizePendingReview` derives it itself via `review/pass-complete` — so the rollback lane *is*
deduplicated, pinned by the rollback test. The identity-less unconditional award is real but is a
different thing: a caller invoking `awardReviewPass()` with **no argument**, which the documented
carve-out preserves for the Phase 15 note-submit lane. That distinction is now pinned as a fact
about the store, because conflating the two is how a later phase comes to believe its rollback
double-pays.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-04. `not-started` -> `in-progress` -> `verified` -> `complete`. The maintainer
accepted the verified checkpoint, and the phase was committed as `a6d8b70` and pushed to `origin/main`.
The original text recorded the phase as not yet committed, pushed, or deployed; that statement was true
when written and is superseded by that commit. Phase 18 was `not-started` at that checkpoint and
requires separate authorization.

Phase 16 was `verified`, accepted, committed as `ade1f78`, and pushed. The maintainer's instruction
to execute Phase 17 is recorded here as acceptance of that checkpoint.

#### Baseline

Green at `ade1f78` before any Phase 17 change: `npm run lint` 0, `npm run typecheck` 0,
`npm test` **256 files / 5029 tests**, `npm run build:web` 0, `npm run check:bundle-size`
**5.06 MB / 153 files**. No baseline repair was needed.

#### Files

- **State machine and transaction** (`core-logic-engineer`): `src/core/fishing/fishingStateMachine.ts`
  (1141), `src/core/fishing/catchRewards.ts` (954), `src/application/fishingCommands.ts` (991),
  `src/store/fishingCommands.ts` (194), `src/application/contracts/commands.ts` (+191),
  `src/store/progressionStore.ts` (+274 then +60 comment correction), `src/core/fishing/fishingContext.ts`
  (+14/−2).
- **Renderer** (`game-engineer`): `src/renderers/pixi/fishing/{createFishingScene.ts 1575,
  FishingController.ts 512, FishingWorld.tsx 329}`, `src/ui/screens/PixiFishingLane.tsx` (created,
  later grown), `src/ui/village/villageStudyFlow.ts` (+84). Later, the village position capability:
  `src/application/contracts/renderer.ts` (+57), `src/renderers/pixi/village/{createVillageScene,
  VillageRenderer,VillageWorld}`, `src/game/{scenes/VillageScene,adapters/phaserVillageRenderer}`.
- **DOM** (`ui-engineer`): `src/ui/fishing/{FishingHud.tsx 514, FishingCatchPanel.tsx 156,
  fishingHudPort.ts, fishingHudCopy.ts, fishingSession.ts, fishingRecallNavigation.ts, fishing.css}`,
  `src/ui/screens/{useVillageFishing.tsx, PixiFishingLane.tsx}`,
  `src/ui/components/{FishingRecallModal, FishStandPanel}` rewritten, `src/ui/study/controlIds.ts`
  (+`FISHING_CONTROL_IDS`), `src/ui/village/villagePlayerPosition.ts` (new).
- **Lane and build** (`infrastructure-engineer`): `tests/e2e/{fishing-lane.ts, fishing-harness.ts,
  fishing-lane.test.ts, fishing.spec.ts, fishingRollback.spec.ts, playwright.fishing.config.ts,
  playwright.fishing-rollback.config.ts}`, `scripts/require-fishing-lane-artifact.mjs`,
  `vite.config.ts` (+49/−8), `package.json` (+9), `.github/workflows/ci.yml` (+8 steps).
- **Tests**: `tests/phase17/` — 16 files; plus rewritten `tests/unit/{FishingRecallModal,
  FishStandPanel}.test.tsx`.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       273 files / 5509 tests passed   (was 256 / 5029)
npm run build:web                              exit 0
npm run build:web:pixi-fishing                 exit 0
npm run check:bundle-size                      default 5.15 MB / 153 files · flagged 6.35 MB / 157 files
npm run test:e2e                               32 passed / 12 skipped (4 viewports, Chromium)
npm run test:e2e:fishing:full                  10 passed — 8 consecutive green runs total
npm run test:e2e:fishing:rollback              4 passed
npm run test:privacy                           6 files / 34 tests passed
npm run test:licenses                          PASSED, 99 entries, 0 media under src/
npx vitest run tests/unit/fishingMechanics.test.ts / fishingTypes / FishingRecallModal / FishStandPanel   4 files, 73 tests
npx vitest run tests/phase11/                  64 passed
npx vitest run tests/phase12/ 13/ 14/ 15/ 16/  568 passed
```

#### The catch identity, and why each component is in it

`catch-` + FNV-1a32 over `(contextId, catalogId, castNumber)`.

- **Not the fish entry id.** `createFishId` is `Date.now()` + `Math.random()` — neither
  deterministic nor injectable, so it cannot key an awarded-once guard.
- **Not a renderer-held ordinal.** A reload loses it and the retry pays twice. `castNumber` is
  minted by the state machine at `release` and never rewound, so it survives losing the renderer.
- **Each component earns its place:** without `contextId` two ponds' first catches collide; without
  `catalogId` cast 3 of a Carp and cast 3 of a Trout collide; without `castNumber` **two Carp in one
  session collide**, which is the common case.

**Placement:** the canonical per-subject progression record's `extraFields`, under
`catchRewardLedger`, beside the Phase 15 and Phase 16 ledgers. A fourth option was rejected and
documented: *inside the fish collection array* — the natural home, rejected because a released fish
and a failed recall must write **nothing**, so the carrier would exist only for the one outcome that
already left a trace.

**Write ordering:** `decideCatchReward` is one pure function and `progressionStore.recordCatch` writes
the fish entry, XP, rank, badges, and ledger in **one `set` of one record**. A declined outcome
returns before any `set` and before any `Math.random`, so a release is not even a re-save of an
unchanged record. *Not* atomic, and stated: cross-subject achievements (one `set` each, after the
record, as in Phases 15 and 16), and the renderer dying between catch and keep.

**Keep-without-recall pays zero XP.** The fish is kept and still counts toward all four badges. Three
reasons: XP is paid for learning evidence everywhere else and there is no learning event here; the
eligibility gate *requires* a cleared room, so paying in exactly the no-material case would reward
skipping the work that produces material; and `FSH_XP_PER_CORRECT_ANSWER` would be lying at the one
place a reader looks — so it keeps its name and is only ever paid for a correct answer. The rate
lives in `CATCH_XP_BY_OUTCOME` rather than in `progression/types.ts`, because the rollback lane's
`awardFishingXp` reads that constant.

#### Exit-criteria assessment

1. **A complete cast-to-catch-to-keep flow works using touch and keyboard** — met. `tests/e2e/fishing.spec.ts`
   drives the full flow **keyboard-only** (20.0 s) and again **pointer-only** (19.6 s), in a real
   browser, through the real DOM controls.
2. **Recall questions use the same subject context as the catch** — met. One explicit
   `FishingContext`, minted at pond entry, enforced at the commit boundary by
   `requireMatchingSession`; a mismatch is `{ code: 'SUBJECT_CONTEXT_MISMATCH' }`, and the commit
   writes to `context.subjectId`, never to `activeSubjectId`. Previously three different derivations
   disagreed, including a literal `'village'` fallback and a write to the active subject carrying a
   different `subjectId` field.
3. **Fish, XP, and badges are awarded exactly once** — met. Previously three non-transactional
   writes with no guard at all; `awardFishingXp` paid twice on a double dispatch.
4. **Release and failed recall do not mutate progression** — met, by rule rather than by accident.
   Both were previously separate `setState` calls that happened to award nothing; the tests diff the
   **entire** progression value with sorted-key JSON, not "XP did not change".
5. **Returning to Village destroys fishing GPU resources cleanly** — met **in jsdom**: 4 mount/unmount
   cycles leave `canvases = 0`, net window listeners `= 0`, `stage.children = 0`, `tickerRunning = false`,
   `app.ticker === null`. **GPU bytes, live WebGL contexts, and frame time are UNVERIFIED** — no jsdom
   API reports them.
6. **Collection counts use canonical catalog IDs and subject IDs** — met. `FishStandPanel` counted with
   `f.id.split(':')[0]`; it now goes through `resolveFishCatalogId` / `countCanonicalCatalogTypes`, and
   groups history by `subjectId`.

#### Deliverables and Non-goals

All six deliverables are met, including **fishing browser E2E coverage** — which Phases 14, 15, and
16 could not deliver, because `test:e2e` builds the default artifact in which the new surface is not
present. Phase 17 built a **separate flagged lane** with a recorded artifact identity, which is the
first time a phase's new surface has browser evidence.

All four Non-goals hold, verified as byte-identity against `ade1f78`: **no new fish species**
(`FISH_CATALOG` still 8 entries), **no new currencies**, **no multiplayer**, **no change to rarity
probabilities** (`FISH_RARITY_WEIGHTS` still 65/28/7).

#### Defects found and fixed during the phase

Fourteen, of which these are the ones that changed behaviour:

- **A double award on the most natural sequence, which 24 probes had missed.** Rating a room, clicking
  **Complete this review pass**, then closing the panel paid twice: `awardReviewPass` increments
  `reviewPassCount`, so when the explicit completion is the room that *finished* a full pass, the
  panel close re-derives pass N+1, an identity the ledger has never seen. (Carried from Phase 16's
  review flow, where the equivalent guard is now in place; recorded here because the same reasoning
  governs the catch identity.)
- **The Pixi fishing lane never mounted at all.** `hostRef.current` was assigned only inside the
  `useEffect` guarded by `session !== null`, while `session` was set only by calling
  `hostRef.current.enter(...)`. The ref was therefore never assigned, `resolveFishingHost`'s Pixi-first
  `??` fell through to Phaser, and the pond chunk was built and never fetched. Measured in the browser:
  0 fishing-chunk requests, 0 `.fishing-hud`, 0 `.pixi-fishing-world`. **Only the e2e lane found this.**
- **A reachable pond with every control permanently disabled.** The HUD's port subscribed on the
  commit where `session` first became non-null, while the `Suspense` boundary was still showing its
  fallback, so the subscription landed on a null handle and the HUD sat on its idle readout for the
  rest of the session — with `hasClearedRooms` true and no error anywhere. Fixed with a zero-output
  marker inside the boundary, because React attaches every `useImperativeHandle` in the layout phase,
  which precedes every `useEffect`.
- **A learner was told "You have started fishing" after leaving the pond.** `FishingScene`'s only two
  exits both stop the scene and wake the village inside a `Phaser.Game` the DOM cannot see, and report
  nothing. Only the Pixi host could report it, so on the **rollback** lane the announcement never
  cleared. Fixed with a `finishFishingSession` option on the one dispatch every exit route funnels
  through; verified by probe in a real browser.
- **A keep with no recall material was recorded as a correct answer**, awarding
  `FSH_XP_PER_CORRECT_ANSWER` — a constant whose own name says what it is for.
- **A failed recall awarded full XP by accident**, because it reached the same handler through a path
  that happened not to award. Now a rule.
- **Fish catalog identity was discarded.** `addFish` derived the id prefix from the **display name**
  and never set `catalogId`, so identity survived only because every catalogue name happens to slug to
  its own id — a coincidence between two files, not a contract.
- **The review rollback lane's `f.id.split(':')[0]` counting** worked by the same accident.
- **Three subject-context derivations disagreed**, one of them a literal `'village'` as a subject id.
- **`pullRecallQuestion` still uses `Math.random()`** and ignores the file's own `createSeededRng`.
  Called once per catch, so a catch's question is fixed at catch time rather than re-rolled per render
  — the substantive half of the fix. **Recorded as follow-up rather than changed**, because threading
  an `rng` parameter changes an existing public signature for a caller outside this phase.
- **Two stale comments claimed `VillageScreen.handleKeepFish` was the rollback lane** for three store
  actions that **no production caller uses any more**. Corrected, with the grep evidence.
- **`FishStandPanel`'s dialog comment claimed an `aria-label` it does not have** (it uses
  `aria-labelledby`). The `aria-labelledby` is right and was kept.
- **`addFish`'s `?? 3` default and `CLOSED_WITHOUT_RATING_QUALITY` are two decisions that happen to
  agree**, recorded as such with an explicit "change both in one commit" warning.

#### Non-vacuity evidence

Every probe below was reverted and the restore verified by sha256. **One probe came back green and is
reported as a vacuous probe, not as a finding** — see the note under the table.

| Probe | Result |
| --- | --- |
| `hasCatchReward` -> always `false` (suppression disabled) | **RED** 7 failed / 62 passed |
| `hasCatchReward` -> always `true` | **RED** 27 failed / 42 passed |
| `kept-without-recall` pays `FSH_XP_PER_CORRECT_ANSWER` | **RED** 7 failed / 386 passed |
| Village position read cached in a field (the stale-read bug) | **RED** 3 failed / 17 passed |
| Village position read -> constant `{0,0}` (a lying read) | **RED** 2 failed / 18 passed |
| Remove the whole `review.passComplete` from `finalizePendingReview` (Phase 16) | **RED** 17/77 |
| Pixi village read -> `lastPoi` angle/distance | **RED** 3 Pixi tests |
| Phaser village read -> constant `{0,0}` | **RED** 3 Phaser tests |
| Render filter -> `reviewPassCount > 1` | **RED** 4/9 |
| Renderer boundary given a planted `@/store` import | **RED** 3/8 |
| Phaser readPoi pattern (a cached field) applied to the position | **RED** 3, "expected null" |
| Lane: walk shrink near the burst | **RED** 2 tests |
| Lane: aim tie-break bit removed | **RED** |
| Lane: stall-counter movement reset removed | **RED** |
| Lane: summary read after the dialog closes | **RED** |
| Lane: discard step removed | **RED** 3 tests |
| Contract member list gate (`gridX`, `gridY`, the new read) | **RED**, correctly |

**A vacuous probe, reported rather than hidden.** A first attempt to remove the Pixi village position
read patched nothing — the replacement string did not match the file — and reported **64 passed**. A
green probe is only evidence if it actually removed something, so the two real probes above were run
instead. Recorded because "my probe went green" is exactly the moment a reviewer should check.

Three further **vacuous assertions** were found and closed during the phase, all of the same family:

- `expect(NaN).toBe(NaN)` passes, because `toBe` is `Object.is`. A Fish Stand stat published as
  `"{caught} of {total}"` was read with `Number(...)`, so every before/after comparison of it was a
  tautology that could not fail.
- An assertion made **one line after** the harness had clicked "Close the fish collection", so no run
  in the lane's history could ever have satisfied it.
- A gate that asserted a **re-implementation** of the harness loop's arithmetic, which `&& false` on
  the harness would have survived. The gates now assert the harness *contains* the branch.

#### The flaky walk, and why it was fixed on the product side

The lane swung **7–9 of 10** across identical runs. The harness walked the village by aiming each leg
at a structure's **centre** while pressing from wherever the learner happened to be — measured
**30.8 px and 41.6 px** off on a 48 px tile, up to 0.9 of a tile — and the next leg then aimed a
25-tile heading from a position it was never at. One instrumented run: **212 polls with a correct
heading, never saw the pond row once, and walked off the map.**

Two harness-side fixes were implemented and **rejected on evidence**: a press-distance gate (timed out
all ten tests; the failures were not monotonic — presses at 32 and 45.1 px landed, losses at 38.9 and
47.9 — so no cut-off separates them) and press-at-closest-approach (cost five of ten tests, because
the nearby list is sampled and a waiting walk loses the ring between readings). An overshoot reversal
landed, was mutation-verified, and was then **deleted** once the walk could see itself: a heading
derived from the learner's own tile points back at the target the instant they pass it, so there was
nothing left to reverse.

**The actual fix was the missing product fact.** The village published a *distance* to each nearby
structure and never a *position*. `readPlayerGridPosition?(): WorldGridPosition | null` was added to
`VillageRendererCapabilities` and implemented on both scenes — **computed on read, never cached**,
because a cached position is correct for the frame that produced it and wrong the moment it is read
outside it — and `data-village-player` now publishes it on the screen root. The harness re-aims from
it every burst.

`ui-engineer` **refused to publish the attribute until the renderer could source it**, on the stated
grounds that a test-visible attribute which lies is worse than one that is absent. That is the correct
call and it is why the attribute went live only after the renderer landed.

**The lane is green because the walk is correct, not because it got lucky: 8 consecutive 10/10 runs**
(6 by the implementing agent, 2 re-confirmed by the orchestrator), zero skips.

#### Rollback

Verified in **built artifacts**, not from the flag constant.

| | default (`build:web`) | flagged (`build:web:pixi-fishing`) |
| --- | --- | --- |
| `FishingWorld-*` chunks | **0** | 2 (55.7 kB + 55.2 kB) |
| `vendor-pixi-*` chunks | **0** | 2 |
| `vendor-phaser-*` chunks | 2 | 2 |
| dist | 5.15 MB / 153 files | 6.35 MB / 157 files |

`src/game/scenes/FishingScene.ts` is **byte-identical to `ade1f78`**, so the rollback lane is
untouched code, not a re-implementation. `npm run test:e2e:fishing:rollback` drives the default
artifact through the village fishing pond to the Phaser `FishingScene` and is **4/4**, including a
proof of life after `Escape` — the learner walks out of the 48 px approach radius, walks back, and the
row reappears at a new distance.

`FEATURE_FLAG_MATRIX.pixiFishing.productionDefault === false`, `ownerPhase: 17`, and it is **not** in
`NON_CUTOVER_FLAG_KEYS` (which remains exactly `['audioEnabled']`). `vite.config.ts` now fails the
build if a `VITE_PIXI_FISHING=true` config does not emit the pond chunk, so a dead lane cannot ship.

#### Known limitations

- **Frame time and GPU memory are UNVERIFIED.** `check:memory` is a build-level preflight and says so
  in its own `NOT MEASURED` list — it reads a build, not a browser, and cannot count canvases over 20
  mount/unmount cycles. Teardown was measured in jsdom only.
- **Two live renderers tick at once** on the fishing lane: the pond overlays the village, so both
  applications run. A deliberate trade — the alternative destroys the village's camera and NPC
  conversation — and its cost is **unquantified**.
- **The fishing world is not in the pixi-memory lane's `VITE_WORLD_RENDERER` switch**, so a 20-cycle
  browser measurement of this world does not exist anywhere yet. Phase 22 owns it.
- **Accessibility evidence is semantics plus browser reach, not measurement.** Real 44×44 targets, real
  keyboard flow, real dialog focus management, and a real 320 px-safe layout are asserted. **Contrast
  ratios, on-screen touch-target size, 200 % zoom, `forced-colours`, and axe are UNVERIFIED** — jsdom
  computes no colours and no layout. Phase 21 owns that audit.
- **Chromium only.** `test:e2e:compat` and the Firefox/WebKit/Edge lanes were not run for this surface.
  Phase 21 owns cross-browser.
- **A species is no longer visually distinct.** `FishingScene` switched texture per catalogue entry; the
  legacy SVGs are `legacy-unverified` and CC0-inadmissible, so the pond draws one silhouette tinted by
  rarity and the species is named in DOM from `catalogId`. A visible change, taken deliberately.
- **The on-canvas instructional text is gone.** `FishingScene` drew a hint line, a `Power: ████░░░░`
  read-out, and a "Return to Village" button on the canvas. The Pixi pond draws a shape-only meter and
  no words; all of it is DOM. Correct per plan 6.2, and a visible change.
- **The rollback lane is not in CI.** `browser-smoke`'s production window is closed at both ends by two
  **existing** gates that together permit exactly one production-artifact lane. Putting the fishing
  rollback there means relaxing a working gate, so it was left out rather than forced. Options for the
  maintainer: widen that window and re-assert it for the Phase 10 lane's own boundary, add it to the
  nightly `compatibility.yml`, or leave it local.
- **Follow-up work found and deliberately not done** (plan working rule 13): `pullRecallQuestion`
  should take an `rng`; `addFish`, `awardFishingXp`, and `checkFishingBadges` now have **no production
  caller** and should be either deleted or kept with a decision recorded;
  `tests/phase8/qa-verification.test.ts`'s `src/styles.css` scan does not cover the new colocated
  `review.css` / `fishing.css` sheets (checked by hand — no `url(`, `@font-face`, or remote reference);
  and the Phase 6/7 archetype-perk strings that promise a self-check cap and a review-streak cap which
  do not exist.

#### Gates other agents changed, and the rulings

| Gate | Ruling |
| --- | --- |
| `tests/privacy/support/appGraph.ts` `TEST_OWNED_SOURCE_DIRECTORIES` 1 -> 4 entries | **Legitimate.** Phase 14/16/17 plant probe files on the real filesystem as positive controls; parallel workers were reading each other's probes as real offenders. |
| `tests/phase4/plantingExemptionAdversarial.test.ts` exact pin | **Legitimate and intent-preserving.** It now pins all four names exactly and asserts each is a live directory, so the list still cannot grow silently. |
| `tests/e2e/pixi-memory-lane.test.ts`, `tests/phase9/pixi-pointer-lane-wiring.test.ts` download count 2 -> 3 | **Legitimate**, and each additionally pins the three artifact **names**. |
| `tests/e2e/phase10-media-lane.test.ts` renamed + mutation retargeted | **Legitimate.** Its purpose is that the Phase 10 lane adds none of these lanes, and it still does; the mutation was retargeted so it fails for the same reason. |
| `tests/phase9/qa-independent-verification.test.ts` contract member list +3 | **Legitimate.** The gate exists to catch exactly this, and its own comment predicted a third optional member would leave it green. |
| `tests/phase17/fishing-flag-boundary.test.ts` two assertions inverted | **Legitimate.** Both recorded a *gap*; the gap is now closed, so the assertions became gates rather than being left contradicting the implementation. |
| `tests/phase12/village-fishing-signal.test.tsx` KNOWN LIMITATION replaced | **Legitimate.** The replaced test named Phase 17 and said it would fail then. It failed, which is the signal working. |
| `src/ui/village/villageStudyFlow.ts` `PlayerClassId` re-pointed to the neutral contract | **Legitimate.** Otherwise the lane's host contract dragged `src/game/**` into the DOM fishing closure. Same move Phase 16 recorded for `GamePhase`. |
| `tests/phase17/village-player-position.test.ts` "imports nothing but React and the village map" | **Rewritten, not weakened.** The shared `readSpecifiers` cannot tell a type-only import from a value one. The test now asserts the **runtime** import set exactly, asserts the contract import is `import type` by form, and asserts no `@/renderers` specifier in either reading — which is the property the original comment stated. |

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-05. `not-started` -> `in-progress` -> `verified` -> `complete`. The maintainer
accepted the verified checkpoint on 2026-10-05 and instructed that Phase 19 follow, so Phase 18 is
`complete`. The phase was committed as `b110d85` and pushed to `origin/main`. The text originally
recorded the phase as not yet committed, pushed, or deployed; that statement was true when written and
is superseded by that commit. **Not deployed** - no deployment was performed or authorized.

Phase 19 was authorized at the same time and is opened by this documentation commit, so the Phase 18
feature commit contains Phase 18 work and the Phase 14-17 status corrections only.

#### Baseline

Green at `a6d8b70` before any Phase 18 change: `npm run lint` 0, `npm run typecheck` 0, `npm test`
**273 files / 5509 tests**, `npm run build:web` 0, `npm run check:bundle-size` **5.15 MB / 153
files**. No baseline repair was needed.

#### Commands

```text
npm run lint                                   exit 0
npm run typecheck                              exit 0
npm test                                       289 files / 5923 tests passed, 0 it.fails
npm run build:web                              exit 0
npm run check:bundle-size                      5.27 MB / 153 files   (was 5.15 MB / 153)
npm run test:privacy                           6 files / 34 tests passed
npm run test:licenses                          PASSED, 99 entries, 0 media under src/
npm test -- tests/unit/sessionTracker.test.ts    37 passed   (previously matched NO file, exit 0)
npm test -- tests/unit/StudyStatsPanel.test.tsx  14 passed   (previously matched NO file, exit 1)
npm run test:e2e                               34 passed / 14 skipped / 0 failed  (4.0m)
TZ=UTC npx vitest run tests/phase18/ + sessionTracker   387 passed
```

The two plan-named unit commands were **vacuous before this phase** - neither file existed, and
`npm test --` exited 0 on the missing `sessionTracker` path. They are now real gates.

#### What the phase actually found

The plan listed "session tracking functions are not wired into real gameplay" as a known defect. It
was worse than unwired: `startSession`, `endCurrentSession`, `trackRoomVisit`, `trackNoteSubmission`,
`trackReviewCompletion` and `trackXpEarned` had **zero production callers**. Every `track*` opened with
`if (!currentSession) return`, nothing ever set `currentSession`, and only `computeSessionStats` (a
read) was live. Statistics were structurally guaranteed to be zero.

Six further defects were confirmed at source before any code was written:

1. **UTC day keys** - `sessionTracker.ts:263` used `.toISOString().slice(0, 10)`, so a learner studying
   at 23:30 CET was credited to the next day.
2. **The streak subtracted `86_400_000` ms** - `:289` and `:298`, which is 23 or 25 hours across a
   daylight-saving transition.
3. **`generateId()` was `Date.now()` + `Math.random()`** - the identity Phase 17 had already rejected
   for the catch ledger.
4. **`endCurrentSession`'s storage-v2 branch was a read-modify-write race** - two concurrent ends each
   pushed onto their own read and the second save dropped the first session.
5. **`isSessionRecord` only checked `sessionId` was a string** - and a restored backup is untrusted
   input.
6. **"Rooms visited" was per-session unique then summed** (`:214`, `:279`), so it was not the unique
   count the plan names.

#### The blocker: the shipping lane recorded nothing

`qa-engineer` browser-confirmed the first fix against the default `dist`: a completed tutorial note
produced `xpTotal: 27`, `roomsCleared: 1`, **`extraFields: null`**, session **`notesSubmitted: 0`,
`xpEarned: 0`**. The phase's own scope item - "record successful note submissions, XP awards" - was
not happening on the lane that ships.

Cause: `progressionStore.ts:1287-1295` and `:1321` wrote statistics only under `clear !== undefined`.
`clear` is the Phase 15 valid-clear identity, and `NoteEditorModal.tsx:260` - what the default build
renders, since `VITE_SCRIBE_ENCOUNTER_WORKSPACE` defaults `false` - supplied **no identity at all**,
not even a `roomId`. The original coupling was deliberate and documented: it kept the rollback lane's
records free of an `extraFields` key they "have never had". The phase reversed that trade explicitly,
because the shipping lane recording nothing is the worse outcome.

**The trap, and why it was one problem rather than two.** Plan §5.3 lists "a valid note can be
resubmitted and award room-clear progression again" as a known defect, and Phase 15 fixed it *using*
the clear identity as the awarded-once key. `NoteEditorModal` is precisely the lane that can resubmit.
Supplying statistics without an equivalent guard would have re-opened the double count on the very
lane that ships.

The fix mints `deriveNoteSubmissionSourceIdentity({ roomId })` -> `csub-<fnv1a32>`, derived **in the
store** rather than in the modal, so there is no second implementation of a domain decision to drift.
The guard *is* the statistics ledger (`decideNoteSubmission` -> `already-recorded`): "this submission
was counted" and "this submission was paid" are one durable fact in the same record write as the XP.
The decisive probe reverted **only** the guard while keeping the write, and 5 tests went red including
`expected 2 to be 1`.

Browser result after the fix, from the default `dist`:

```text
session:  { ..., "notesSubmitted":1, "reviewsCompleted":0, "xpEarned":26 }
prog:     { "xpTotal":26, "roomsCleared":1, "streakCount":1,
            "statisticsEventLedger":{"version":1,"events":[
              {"kind":"xp-award","source":"note-submission","amount":26,"localDate":"2026-10-05"},
              {"kind":"note-submission","roomId":"tut-note","xpAwarded":26}]}}
```

`localDate 2026-10-05` against `recordedAt ...T22:21Z` is correct: the host is `Africa/Johannesburg`.

**Accepted trade, stated plainly.** On the default lane a room now pays **once per subject ever**, not
once per graph generation. Under-paying is a reporting question; re-paying is the defect Phase 15
exists to close. The command lane keeps per-generation granularity.

#### A second defect found while verifying the first

`deriveNoteSubmissionSourceIdentity` did not validate its input, so `roomId: ''` and `roomId: '   '`
minted two **distinct** identities. The registered reproduction was wrong in an instructive way: the
note rows were not 2, they were **0** - `readStatisticsEventLedger` already routed a note event's
`roomId` through the same trim and dropped the row, while `writeStatisticsEventsToFields`' own
read-modify-write silently discarded it and **kept its `xp-award` sibling**. The ledger reported
**54 XP for two rooms that did not exist**, with no submission behind any of it. Both halves close by
refusing to mint the identity; the check lives in core so a future caller inherits it.

#### The 32-bit digest is a one-way door - ruling

Recorded because it closes, not opens. The persisted note event carries `roomId` but **not**
`clearIdentity`, so `deriveStatisticsEventId` **cannot be recomputed from data already on disk**.
Widening 32 -> 64 bits would re-key every room already cleared on the default lane and **pay each one
a second time**, re-opening the exact defect this phase exists to close, on every existing device,
with no migration available.

The standing decision is to **leave it at 32 bits**, on these grounds: the prefixes make the *token*
spaces provably disjoint (`deriveRoomClearIdentity` only ever emits `clear-`, this rule only `csub-`),
so cross-lane identity collision is impossible by construction; the residual is the ordinary birthday
risk over two distinct tokens in one lane, about `1.2e-6` at 100 rooms and reaching `1e-2` only near
9,292 rooms on a single device; the threat model is the module's own - no adversary, one device,
accidental duplicates only - so FNV-1a-32's non-cryptographic nature is irrelevant; the failure
direction is safe, since a collision can suppress an award but never double-count; and it is
diagnosable, because each note event carries its `roomId`. This is the last moment a widening would be
free, and the risk it removes is two orders of magnitude smaller than the risk it would add.

The cheap enabler, if the option is ever wanted, is to persist the source token on the event (a ledger
version bump), which turns a future widening into a recomputable migration instead of a replay. Not
shipped: it changes the stored shape for a hypothetical need.

#### Exit-criteria assessment

1. **Statistics are nonzero after real use** - met, browser-confirmed on the default artifact. Note
   and XP events nonzero, both session counters nonzero, `xpEarned` equal to the amount the action
   independently reported.
2. **No duplicate sessions, XP, room, note, review, or fish events** - met. Nine attacks on the
   awarded-once guard (triple resubmit, double dispatch, resubmit after a real reload, subject switch
   and back, two closes plus double `pagehide`, two different rooms, the display counter, the no-room
   fallback). "No write at all" on a rejected resubmit is measured three independent ways with the
   *first award* as the positive control: `localStorage.setItem` not called, `bySubject` the same
   object, `Math.random` not called. All five session end-triggers are idempotent, and a 20-way
   concurrent storage-v2 write race converges.
3. **Dates are internally consistent** - met. Local calendar keys; DST measured in `America/New_York`
   (1380 and 1500-minute days); the whole phase suite re-run under `TZ=UTC` because GitHub runners are
   UTC and one earlier test was vacuous there.
4. **Data survives reload, full backup, and subject backup** - met. The statistics ledger rides
   `.kdbak` and `.kdsubject` byte-for-byte into a *different* device; a failed import leaves the whole
   device byte-identical and a good import still works.
5. **No network request carries statistics** - met. A whole recorded session makes zero network and
   zero console calls, and no statistics identifier reaches any recorder, manifest string or member
   name. A planted `fetch('...collector.invalid...')` and a planted `console.warn` both turn the suite
   red.

#### Manual checks from the plan

| Check | Status |
| --- | --- |
| Complete one note | Automated, real browser, default artifact. |
| Complete one review | **NOT done in a browser.** The Archaeologist lane sits behind the room panel and was not reached. Unit-level only: the real `awardReviewPass` is driven and asserts one completion per pass identity. |
| Enter and leave the subject | Automated. |
| Switch subjects | Automated (attack 4: the second subject's record has `xpTotal 0` and no ledger). |
| Background and restore the page | `pagehide` and `visibilitychange` are unit- and jsdom-proven; **no browser evidence** that `pagehide` is the only reliably-fired close event. |
| Reload, totals remain correct | Automated (attack 3: fresh modules, fresh singletons, same keys, guard holds). |

#### Non-vacuity evidence

Probes were run by all three agents, each reverting one decision, observing RED, restoring, and
verifying by checksum. Reported honestly rather than counted:

- **`core-logic-engineer` declared two of its own probes PARTIAL.** Noon-anchored date arithmetic means
  `addLocalDays`' behavioural tests cannot distinguish it from the millisecond variant, so only a
  structural gate can; it measured 33,120 date/zone samples to establish that a noon-anchored ms walk
  equals calendar construction. It also reported that a first probe came back green because the
  replacement string had not matched, and re-ran the real probe instead.
- **`qa-engineer` reported six first-attempt green probes, named five as its own harness faults**, and
  replaced them. Two are honest negatives: one mutation removed nothing at all, and one browser lane is
  insensitive to the same-subject guard because the deterministic id plus the keyed merge converge
  either way.
- **`ui-engineer` reported a probe that came back green because its regex was case-sensitive**, fixed it
  to `/i`, and re-probed to RED.
- **A vacuous test caught in the phase's own suite**: a day-key assertion wrapped in
  `if (localDay !== utcDay)` asserted nothing on a UTC host - which is what GitHub runners are. Its
  replacement was verified non-vacuous by running it under `TZ=UTC`, and the *pre-rewrite* body was run
  under `TZ=UTC` against the broken implementation to prove it had asserted nothing.
- **A second vacuous test in the same suite** built `writeByFirst`/`writeBySecond` locally and asserted
  on arrays the test itself constructed, measuring nothing about production code. Replaced with a real
  20-way concurrent race against a real generation.

#### Gates other agents changed, and the rulings

| Gate | Ruling |
| --- | --- |
| `tests/privacy/uploadBoundary.test.ts` line 134, count proxy -> set difference | **Legitimate and intent-preserving.** Measured: `walkAppGraph` 277, `allFirstPartyModules` 277, but `unreachedCount 11` against `extrasCount 11` - the counters never measured the same set, and the margin had collapsed to zero. The comment claims "the graph is a proper subset of the tree"; the assertion tested that as a count coincidence. Replaced with the set difference, proved RED in **both** directions: a walker that globs `src/`, and a resolver that reaches too little (caught by the untouched `>= 60` check). |
| `tests/phase16/reviewCommandStoreBinding.test.ts` exact key list +`statisticsEventLedger` | **Legitimate.** Still an exact sorted list, so it cannot grow silently. |
| `tests/unit/roomClearRewards.test.ts` exact key list +`statisticsEventLedger` | **Legitimate, with a note.** It asserts the ledger's *presence* on the legacy mirror but not its contents at that site; contents are covered by `tests/phase18/progressionStatisticsEvents.test.ts` and the new data-product gates. |
| `tests/unit/appBootstrap.test.ts` two new no-op deps | **Legitimate as written, and that was the problem.** Nothing asserted `commitPlan` called them - deleting both lines would have left ~5,900 tests green with the dashboard recording nothing. Closed by `statisticsBootstrapWiring.test.ts`. |
| `tests/migrations/qaLegacyByteComparison.test.ts` case 5 rewritten | **Legitimate, and it closed a gap.** The old case called the store the way **no production caller does**, naming neither a room nor a clear identity, so it stayed green straight through the blocker. A fixture pinning the old shape was asserting the bug. Case 5b retains the no-room rollback shape. |
| `tests/migrations/legacyWriteShape.test.ts`, `tests/phase15-qa/qaArtifactRewriteRuling.test.tsx`, `qaRollbackLane.test.tsx` | **Legitimate.** `qaArtifactRewriteRuling` had measured the lanes' divergence as "the rollback lane still double-awards... documented, expected" - that is the double-submit trap, written down as acceptable. |

#### Rollback

`src/ui/study/stats/studyStatsGate.ts`. A panel-level gate, per the maintainer's decision: **no new
build-time flag.** `src/config/featureFlags.ts` and `NON_CUTOVER_FLAG_KEYS` (still exactly
`['audioEnabled']`) are untouched and the three "no cutover flag defaults on" gates pass unmodified.
The module's only import specifier is `react`, asserted structurally with comments stripped. With the
gate off the dashboard and every subject card are gone, a real dismissible dialog remains, and the
progression record, the sessions key and the serialised snapshot are **byte-for-byte** identical; the
figures are then re-read from the snapshot, not the DOM, because with the dashboard hidden there are
no rows to read and asserting against `null` would be unfailable. In the HUD the Stats control becomes
`aria-disabled` with a **visible** note and its click handler is removed.

#### Known limitations and UNVERIFIED

- **A review pass was never completed in a real browser.** The Archaeologist lane sits behind the room
  panel. Unit-level only. Plan §5.1's step 9 is not browser-proven for statistics.
- **Touch viewports are skipped for the lifecycle.** The Phaser dungeon does not deliver its interact
  key on `tablet` / `tablet-landscape`, so the lane skips there with the reason recorded in the test.
  Passing on two projects by asserting less on the other two would be a weaker gate dressed as a green
  one. The guard is proven there in jsdom only.
- **Fishing outcomes are not browser-covered** - the pond is behind `VITE_PIXI_FISHING` and absent from
  the default artifact.
- **Archive restore for the statistics ledger is proven only in `fake-indexeddb`**, not a real browser.
- **Contrast, real touch-target size, 200% zoom, 320px, `prefers-reduced-motion`, forced-colours and
  screen-reader announcement order are UNVERIFIED.** jsdom computes no colours and no layout. The new
  stylesheet introduces no literal colour and uses `var(--cozy-s-font-body, system-ui, ...)`, but the
  token *is* the claim. Phase 21 owns the real audit.
- **The reconciliation sentence was confirmed in the built bundle by grep and in jsdom, not read on
  screen in Chromium.**
- **The no-`roomId` fallback lane still pays and is not counted** - `roomsCleared` moves while the
  dashboard reports nothing. Pre-Phase-18 behaviour on a call shape `tests/phase15/**` and the
  byte-comparison fixtures depend on. The shipping lane no longer uses it; a test asserts the number so
  a future change is a visible diff.
- **The xp-award residue on a hypothetically affected device is unaddressed.** Nothing can create it
  now. Removing it needs either a stored pairing key (a schema bump) or a same-millisecond heuristic
  prune in every device's read path whose failure mode is dropping a *real* XP row. Deliberately not
  done for data whose existence is unproven - no ordinary device can reach it, though a hand-edited
  `.kdsubject` carrying an empty room id is theoretically unblocked.
- **`writeStatisticsEventsToFields` round-trips through the reader**, so an event the reader rejects is
  silently dropped while its sibling survives. Unreachable for any non-blank room, and for blank rooms
  now that the identity is refused. Named, not changed.
- **Chromium only.** `test:e2e:compat` and the Firefox/WebKit/Edge lanes were not run for this surface.
  Phase 21 owns cross-browser.
- **A load-sensitive timeout risk**: `tests/phase14/study-shell-boundary.test.ts`'s planted-probe
  positive control takes ~3.8s against a 5s default. It is **not** deterministic - it passes alone in
  4.85s - but this phase added 414 tests of contention. Worth watching in CI.
- One full run during the phase ended with a single failure whose name was **not captured**; it was not
  reproduced in five subsequent clean runs. Not claimed as a known flake.

#### Follow-up work found and deliberately not done (working rule 13)

- Widen the statistics digest, if ever, only after persisting the source token - see the ruling above.
- `daysUntilReview` / `daysSinceReviewDue` in `spacedRepetition.ts` still divide by `86_400_000`, so
  SM-2 and the dashboard compute review due/overdue differently. The dashboard is right; Phase 16
  pinned the SM-2 rule as intentional, so changing it is a decision, not a drive-by fix.
- The subject-copy ID remapper rewrites `roomsVisited` but not room ids *inside* any of the four ledgers.
- `addFish`, `awardFishingXp` and `checkFishingBadges` have no production caller and should be deleted
  or kept with a decision recorded.
- `tests/phase8/qa-verification.test.ts` scans three fixed stylesheet paths and does not cover the eight
  colocated sheets. Checked by hand - the new sheet has no `url(`, `@font-face` or remote reference.
- The Phase 6/7 archetype-perk strings promise a self-check cap and a review-streak cap that do not exist.
- The fishing rollback lane is still absent from CI; the maintainer has not ruled on the three options.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-05. `not-started` -> `in-progress` -> `verified` -> `complete`. The maintainer
authorized the commit and push, and the phase was committed as `bbb142e` and pushed to `origin/main`.
**Not deployed** - no deployment was performed or authorized.

**Accepted by the maintainer on 2026-10-05**, with the two open questions answered at the same time:

1. **The flagged `VITE_ADAPTIVE_ASSISTANCE` Playwright lane is deferred to Phase 21.** Phase 21 already
   runs the accessibility and responsive audit across the matrix, so it acquires the lane inside work it
   must do anyway. Until then the honest browser result for assistance stays **absence under the false
   production default**, which is a real and checked result, not a missing one. Phase 21 inherits the
   work: a record/verify step, a preflight script, a Playwright project and config, a spec, and CI wiring.
2. **`deps.setDualWriteSink` and `deps.setSessionSource` remain unwired.** The maintainer did not
   authorize installing them. The Phase 18 defect stays **pinned by behavioural spies rather than
   fixed**, and remains carried forward as open work.

The text originally recorded the phase as not yet committed, pushed, or deployed; that statement was
true when written and is superseded by that commit. The text originally recorded acceptance as pending
and Phase 20 as not started; that too was true when written and is superseded by this acceptance.

#### Baseline

Green at `4c47c0f` before any Phase 19 change: `npm run lint` 0, `npm run typecheck` 0, `npm test`
**289 files / 5923 tests**, `npm run build:web` 0, `npm run check:bundle-size` **5.28 MB / 153
files**, `npm run check:budget:welcome` **263.77 KiB / 300.00 KiB**. No baseline repair was needed.

#### Commands

```text
npm run lint                                    exit 0
npm run typecheck                               exit 0
npm test                                        308 files / 6306 tests passed   (was 289 / 5923)
npm run build:web                               exit 0
npm run build:web:assistance                    exit 0
npm run check:bundle-size                       5.37 MB / 162 files   (was 5.28 / 153)
npm run check:budget:welcome                    266.40 KiB / 300.00 KiB   (was 263.77)
npm run test:privacy                            6 files / 34 tests passed
npm run test:licenses                           PASSED, 99 entries, 0 media under src/
npm test -- tests/unit/assistanceEngine.test.ts   41 passed   (previously matched NO file, exit 0)
npm run test:e2e                                34 passed / 14 skipped / 0 failed  (3.7m)
```

The plan's named unit command was **vacuous before this phase**: `tests/unit/assistanceEngine.test.ts`
did not exist and `npm test --` on it exited 0 without running anything.

#### What the phase actually found

**HIGH - the engine was not time-zone independent, and the defect travelled in an archive.**
`assistanceEngine.ts`'s own header claimed *"Compared by UTC epoch, so the host time zone cannot change
the answer."* That was false. `Date.parse` reads an offset-less ISO date-time as **local** time,
`toAssistanceRoom` accepted such a value, and **no validator in `src/` rejected one** - so a
`.kdsubject` carried it verbatim. Measured across five zones, one archive and one `nowIso`:

| zone | `daysUntilDue('2026-03-17T04:00:00', ...)` | `Z`-suffixed control |
| --- | --- | --- |
| UTC, America/New_York | **1** (not due) | 1 |
| Asia/Kolkata, Australia/Adelaide, Pacific/Chatham | **0** (due now) | 1 |

End to end the ranked result differed: **1 suggestion under UTC, 3 under Kolkata**, adding
`archaeologist.due-room` at priority 40 and `device.due-today`. Two devices, one archive, different
assistance. Found by `qa-engineer` attacking the determinism claim; three other agents had signed the
engine off.

Fixed by routing every timestamp through one parser, `readUtcEpochMs`, which accepts an explicit
offset (or a date-only value, UTC by specification) and reads an offset-less date-time as **UTC wall
clock**; everything else is `null`. `Date.parse`'s legacy parser is host-local too -
`'March 17, 2026 04:00:00'` diverged across all five zones - so the rule is by shape, not by marker.

**The reject-option was considered and declined**, and the reasoning is recorded because it is the more
interesting half. A refused due date is not one missing card: `archaeologistDueRoomRule` and
`deviceReviewsDueRule` would stop speaking about that room until a review rewrote the field, so the
learner permanently loses both the prioritisation and the device summary it feeds. A UTC reading is
wrong by at most one offset, identically on every device, and self-corrects on the next review. The
residual cost is stated rather than assumed away: a foreign tool that wrote its own local wall clock
is now read as UTC. Migration cost is zero - this is a read-time interpretation, and no stored value
is rewritten.

**MEDIUM - two evidence keys whose names did not match their values.** Found by
`village-content-designer` trying to write honest copy, and it refused to paper over either:

- `evidence.rooms-cleared` carried a **hardcoded literal `1`** under `graph-no-branch`, so a learner
  with an unstarted five-room subject was shown "1 room cleared" - a false claim about their own
  progress, on the one surface whose entire purpose is to be trustworthy.
- `evidence.overdue-rooms` carried **days** under `review-due` and a **room count** under
  `device-reviews-due`. No phrasing is both specific and true.

The content designer's response was to degrade the wording - "Rooms" instead of "Rooms cleared",
"Past due", grammatically incomplete but true under both - which is the correct instinct and the wrong
place to stop. Fixed at source: `evidence.subject-rooms` now carries the room count, and
`evidence.overdue-days` / `evidence.overdue-rooms` are split by unit. "Rooms cleared" is now true
everywhere it appears. The invariant is now written on `ASSISTANCE_EVIDENCE_KEYS`: **one key, one
unit - a key's noun is the unit its value is counted in, and a row with no honest key is omitted, not
re-labelled.**

**HIGH - the default build eagerly fetched a feature whose flag was `false`.** The DOM integration
became the first importer of the engine, and `vite.config.ts`'s `feature-assistance` `manualChunks`
group took its shared dependencies with it: `assistanceStore` -> `zustand` ->
`use-sync-external-store` -> **React**, which the entry also needs. Rolldown hoisted React into the
group, `index -> feature-assistance` became a **static** edge, and Vite wrote a `modulepreload` for it.
`dist/index.html` shipped a 10.28 KiB counted preload for a feature that could never fire, and Welcome
went **263.77 -> 272.50 KiB**, spending 24% of the remaining headroom.

Root cause verified from a dump of the emitted `chunk.modules`, not attributed: the group held **17
modules of which 4 were assistance code**. `vendor-react` simultaneously shrank 57.50 -> 55.28 KiB,
which is the same two React modules moving - both are back. The group was deleted and replaced with a
**module-membership plus reachability census**: with the flag on, both load-bearing modules must be in
the **fetchable** closure (`imports` + `dynamicImports`); with it off, no lane module may be in the
**static** closure. Welcome returned to **266.40 KiB**, `dist/index.html` now contains **zero**
references to any assistance chunk, and the flagged build costs **0.01 KiB** against the default - the
flag is free on Welcome. The whole DOM stage costs **+2.61 KiB** against the pre-phase baseline.

**HIGH - the Settings modal offered configuration for a feature that could not appear.**
`SettingsModal.tsx` listed the `assistance` tab in a **static** array, un-gated. With the production
default `false`, a learner could open Settings, switch assistance to Gentle, and then see no assistance
anywhere - because the flag is build-time and no runtime action can change it. That reads as a broken
feature, and it is the mirror of the failure the `false` default exists to prevent. Now gated on
`runtimeConfig.adaptiveAssistance` through a pure `visibleSettingsTabs(tabs, flagEnabled)`, with the
full `SETTINGS_TABS` array kept separate from the visible list so a later edit cannot silently trim it.

**MEDIUM - `findSubjectIdForRoom` read `subjects` in the caller's order**, flipping `action.subjectId`
when two subjects shared a room id. Now sorted by code unit. Its comment had claimed `tests/phase19/`
"pins the multi-subject case explicitly" and the function appeared in **no test in the repository** -
the same failure class as the evidence keys, where the next person words the comment instead of the
engine.

#### Exit-criteria assessment

1. **Identical state always yields identical assistance** - met, and it is the criterion jsdom can
   actually prove. Proved over a corpus by byte comparison, under UTC, `Asia/Kolkata`,
   `America/New_York` and `Pacific/Chatham`, with a guard that `process.env.TZ` took effect. The
   cross-zone divergence above was found by attacking this, not by reading it.
2. **Assistance remains local and explainable** - met. Every suggestion carries a `reasonCode` the
   content designer worded from its documented trigger, plus evidence rows of counts only. The
   catalogue is 32 keys in `en` and `es`, with parity asserted **in both directions**.
3. **Off mode removes proactive suggestions** - met structurally, not by filtering. Three layers:
   `ProactiveAssistanceMode = Exclude<AssistanceMode,'off'>` makes `mode:'off'` a **typecheck error**,
   asserted negatively with `@ts-expect-error`; the function throws; and `evaluatedRuleKinds` reports
   which rules actually executed. A **filter-based** Off would pass every other observable test -
   probe P07 reverts to exactly that and only the trace catches it. `ui-engineer` proved the four
   silent states are indistinguishable from absence, asserting `container.innerHTML === ''` **byte-
   identical** across flag-off, mode-off and no-suggestions, behind a positive control that must render
   a real card first.
4. **Suggestions never alter deterministic outcomes by themselves** - met, proven structurally four ways
   of increasing strength: the engine's runtime closure is `src/core/` only; no suggestion member is a
   function, checked recursively; a full before/after fingerprint of progression, subject, sessions,
   **every storage-v2 generation store** and every non-assistance `localStorage` key is unchanged
   across 50 mode changes and 10 dismissals, with a **baseline-substance assertion** so an empty
   fingerprint cannot pass; and `dismissalCount` is **not an input to `rankAssistance` at all**, so
   non-punitive dismissal is a type-level fact rather than a review request. `dismissSuggestion()`
   takes **no argument**, so there is nowhere for a suppression to live.
5. **Assistance survives backup and restore** - met. `.kdbak` and `.kdsubject` byte-for-byte into a
   different device; three corruptions leave the device byte-identical; validation accepts well-formed
   and rejects hostile records.
6. **No raw learner behaviour leaves the device** - met. A whole recorded session makes zero network
   and zero console calls; no room id, subject id, topic, prose, keystroke or trait reaches any record,
   archive member, manifest string, filename, URL or log. Planted `fetch('...collector.invalid...')` and
   `console.warn` both turn the suite red.

#### Gates changed, and the rulings

| Gate | Ruling |
| --- | --- |
| `tests/privacy/uploadBoundary.test.ts` (Phase 18) | Confirmed at Phase 18; unchanged here. |
| `tests/phase17/fishingPhaseInvariants.test.ts` - `dualWrite.ts` left a byte-identity list | **Legitimate, and strengthened twice.** It now permits exactly one added union member and requires that removing that line reproduce the baseline byte-for-byte, while `records.ts` and `generations.ts` remain byte-identical - so the property the original list protected (no new store or generation member) stays **absolute**. QA mutation-tested all four directions and found the comment **overclaimed**: reordering the union is GREEN. The comment was corrected to a measured statement. |
| `tests/phase4/uiSurfaceAudit.test.tsx` - whole-list equality of seven seams | **Legitimate, and the pair holds the boundary.** This one is a **net reduction in strictness** and is recorded as such. It asserts every Phase 4 seam is still present, **no `ui/` entry** (the gate's own subject, now asserted directly and exactly), and a `length >= 8` non-vacuity floor. QA measured that adding a bogus **non-UI** entry passes it - the strictness it gave up - while `qaHardening`'s "the only importers of storage-v2 outside the v2 tree are the declared seams" goes RED. The whole-list equality's real job was enforcing that the registry means something, and that invariant lives in the authoritative registry. |
| `tests/migrations/qaHardening.test.ts` - one additive seam entry | **Legitimate.** Additive with a per-entry justification, and `qa-engineer` found the justification was **unenforced** - nothing iterated `.values()`, so an entry added with `''` passed. Now enforced, with a uniqueness rule that mutation proved **wrong rather than the data**: the three dual-writing stores legitimately share one reason, so the rule was removed and the reason recorded. |
| `tests/unit/audioSettingsTab.test.tsx` - whole-list tab equality broke | **Not amended, and that is the ruling.** The break was legitimate - Phase 19 added a Settings tab - but the repair belonged in the **product**. With the tab gated on the flag, the default tablist is the original four again and the gate passes **23/23 unchanged**, still a whole-list equality. |
| `tests/phase19/assistanceNonVacuity.test.ts` P17 residue gate | **Legitimate.** It failed while four agents worked concurrently, because its permitted list named paths other owners had not yet created. Extended to the exact 14 paths rather than prefixes, and the list is now complete for the phase. |

#### Non-vacuity evidence

Five owners ran probes; every one verified green **before** mutating, and restored with checksum
verification. Reported rather than counted:

- **Two probes declared PARTIAL.** `core-logic-engineer` found that noon-anchored date arithmetic makes
  its behavioural tests unable to distinguish it from a millisecond variant, and measured 33,120
  date/zone samples to establish why.
- **Three vacuous probes found in Phase 18's own engine tests**, including a `MAXIMAL_SIGNALS` built
  with `Object.fromEntries` over same-keyed maps that kept only the last value, silently weakening every
  "Off produced nothing" assertion.
- **`core-logic-engineer` reported two probes it could not make go red** with the structural reason: one
  rule's candidates are per-room and key-deduplicated so no input order can change them, and a
  fractional-score mutation cancelled because the clamp is applied twice per candidate.
- **`qa-engineer` reported six first-attempt green probes**, named five as its own harness faults, and
  replaced them; two are honest negatives. It also **measured rather than assumed** that
  `expect(f).toBe(-b)` and a `forward + backward === 0` sum both fail under the same mutation, and
  declined to credit either with more than it earns.
- **`ui-engineer` disclosed that four probes read as vacuous at baseline and were harness bugs** -
  `perl -0pi -e 's/^…/'` anchors `^` to the start of the *file*, so three mutations silently no-opped.
  Rewritten in Python with an applied-verification step that now hard-fails an invalid probe.
- **`ui-engineer` reported two probes vacuous and deleted the code they guarded** rather than writing
  tests for it. The `activeTab` clamp protected a state no input could reach, since the state is
  written only by clicking a *rendered* tab. The clamp and `resolveActiveSettingsTab` were removed: an
  unobservable branch that *looks* defensive is worse than no branch.
- **A vacuous test caught in its own closure scanner**: a type-stripping regex was over-greedy and
  deleted a whole import statement, erasing a real `react` edge. An erased edge is an unmeasured one,
  which is the dangerous direction for a "reaches no writer" gate.
- **A silent vacuity caught by reasoning**: an assertion that `evidence.overdue-rooms` is *absent* for a
  room due now would have kept passing after the key split - for the wrong reason, since that arm no
  longer emits it at all.

#### Rollback

`VITE_ADAPTIVE_ASSISTANCE=false`, the flag this phase's owner entry already declared. Verified rather
than assumed: with the flag off, `dist/index.html` contains **zero** references to any assistance
chunk, the Settings tab is absent, `AssistanceSlot` returns `null` before the `lazy()` boundary, and the
card region renders nothing. Stored records are left untouched, and re-enabling restores the same
numbers. `src/config/featureFlags.ts` and `runtimeConfig.ts` are **byte-identical to `HEAD`** and
`NON_CUTOVER_FLAG_KEYS` remains exactly `['audioEnabled']`.

The dead-lane guard means the reverse failure is now impossible too: a `build:web:assistance` that
contained no assistance code is a **red build**, not a green lane. Before this phase a configured lane
could verify nothing - which is exactly how Phase 17's fishing lane reported green while its host
published nothing.

#### Known limitations and UNVERIFIED

- **No browser evidence of the feature existing.** `npm run test:e2e` runs the default artifact, where
  the flag is `false`, so the honest browser result is **absence**: no assistance UI appears, no
  assistance code is fetched, nothing breaks. That is a real result and it is what the `false` default
  exists to make checkable. `build:web:assistance` now works, but **no flagged Playwright lane was
  built**, so nothing has observed a suggestion rendering in a real browser.
- **Touch viewports skip the lifecycle lane**, as in Phase 18: the Phaser dungeon does not deliver its
  interact key on `tablet` / `tablet-landscape`, and the reason is recorded in the test.
- **Contrast, real rendered touch-target size, 200% zoom, 320 CSS-pixel viewport, screen-reader
  announcement order, and forced-colours are UNVERIFIED.** jsdom computes no colours and no layout.
  Phase 21 owns the audit.
- **Chromium only.** No compatibility lane was run for this surface.
- **Archive restore for the assistance record is proven in `fake-indexeddb`**, not a real browser.
- **`device.due-today` is dark in Standard mode.** It fires in Gentle; Standard needs the `study`
  aggregate, which this phase does not supply, and `study` was deliberately **not** wired because doing
  so would break the structural property that the card imports no store at all. Standard's
  `active-study-days` and `rooms-cleared` evidence rows therefore read 0. A named scope boundary, not
  an oversight.
- **`bumpSignals` is not idempotent** - a retried call adds twice. Accepted on the stated ground that
  these numbers only raise a priority and no suggestion can write; QA verified the ceiling holds and
  absurd signals saturate rather than reaching arbitrary priority. A retry is not reachable through the
  shipping path, whose write queue serialises.
- **`readUtcEpochMs` reads a foreign tool's local wall clock as UTC.** Deterministic and identical on
  every device, off by that tool's offset. The UTC assumption is justified from what this app writes
  and is **not** empirically validated against real third-party writers.
- **One observed flake**, `assistanceAdvisoryBoundary` byte-identity, failed once in a combined run and
  passed in isolation and two later wide runs. Not reproduced, cause unknown.
- **Two e2e failures during the phase did not reproduce in a clean tree** and are recorded as
  contamination from concurrent edits, which is what `qa-engineer` suspected but could not prove while
  three agents were writing.

#### Follow-up work found and deliberately not done (working rule 13)

- **`deps.setDualWriteSink` and `deps.setSessionSource` are declared, defaulted, and never called** in
  `bootstrap.ts`. This is the same defect class Phase 18 shipped, caught again here and pinned by
  behavioural spies that assert the zeros are measurements rather than a broken spy. Installing them
  changes storage-v2 behaviour on lanes nothing has tested. **RULED 2026-10-05: not authorized, stays
  open.**
- **Build the flagged assistance lane, or defer it to Phase 21** - **RULED 2026-10-05: deferred to
  Phase 21.** It requires a record/verify step, a preflight script, a Playwright project and config, a
  spec, and CI wiring; Phase 21 acquires it inside the accessibility audit it already has to run.
- `findSubjectIdForRoom` is now sorted, but the multi-subject case is only covered by a test added in
  this phase; the shipping room-id factory's uniqueness is what keeps it MEDIUM rather than HIGH, and
  that assumption is unpinned outside this phase.
- Systemic brittleness: **three whole-list-equality gates broke on legitimate list growth in two
  phases** (`qaHardening`, `uiSurfaceAudit`, `audioSettingsTab`). Two were repaired by asserting the
  property instead of the membership; the third was repaired in the product. Worth a deliberate pass.
- The content designer's unit gate keys off a hand-listed set of eight count keys - the one part of
  that gate a human maintains, deliberately, because a new count key means someone picked a unit.
- The bootstrap composite read restates ~14 lines of the store's documented merge rule; exporting
  `readAssistanceWithSource` from the store would collapse it.
- Carried from Phase 18 and still open: the 32-bit statistics digest is a one-way door; `daysUntilReview`
  still divides by `86_400_000` while the dashboard disagrees with it; the subject-copy ID remapper does
  not rewrite room ids inside any of the four ledgers; eight colocated stylesheets sit outside the
  Phase 8 font scan; and the fishing rollback lane is still absent from CI.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-06. `not-started` -> `in-progress` -> `verified` -> `complete`. Committed as `35694d9`
and **not pushed**; **not deployed** - no deployment was performed or authorized. **Accepted by the
maintainer on 2026-10-06**, who also ruled that `playwright.config.ts` is left byte-identical to `HEAD`
and the two Pixi village walk tests' ~53s intrinsic variance against a 180s timeout is carried to
Phase 22 rather than fixed by raising the timeout in this phase.

#### Baseline

Green at `23a0e0f` before any Phase 20 change: `npm run lint` 0, `npm run typecheck` 0, `npm test`
**308 files / 6306 tests**, `npm run build:web` 0, `npm run check:bundle-size` **5.37 MB / 162 files**,
`npm run check:budget:welcome` **266.40 KiB / 300.00 KiB**, `npm run test:licenses` PASSED (99 entries,
`share-card=0`, 0 media under `src/`), `npm run test:privacy` **6 files / 34 tests**. No baseline repair
was needed.

#### Commands

```text
npm run lint                                        exit 0
npm run typecheck                                   exit 0
npm test                                            316 files / 6626 tests passed
npm run build:web                                   exit 0
npm run build:web:share                             exit 0
npm run check:bundle-size                           5.42 MB / 167 files   (was 5.37 / 162)
npm run check:budget:welcome                        266.32 KiB / 300.00 KiB   (was 266.40)
npm run test:licenses                               PASSED, share-card=0, 0 media under src/
npm run test:privacy                                6 files / 34 tests passed
npm test -- tests/unit/shareCards.test.ts           non-vacuous; the file did not exist before this phase
npx vitest run tests/unit/shareCards.test.ts tests/phase20/
                                                    111 policy + renderer/dialog/delivery/panel lanes
npm run test:e2e                                    34 passed / 14 skipped / 0 failed (3.5m)
```

**The plan's named unit command was vacuous before this phase**: `tests/unit/shareCards.test.ts` did not
exist, so `npm test --` on it exited 0 having run nothing - the identical failure Phase 19 found with
`tests/unit/assistanceEngine.test.ts`. Creating the file is a deliverable.

#### What the phase actually found

**HIGH - the privacy gate refused the learner's own subject name.** `isDeniedField` tested for the
substring `room`, which is how it catches the minted id `room-7f3a` - and which also silently dropped
four legitimate names a learner chose: `Room acoustics`, `Room 101 calculus`, `My bedroom notes`,
`A study room for two`. The `subject` and `session` rules already required an identifier marker; `room`
was the only one of the three that did not, and that asymmetry was the bug. `visibleShareCardSubjectName`
routes the subject name through this gate, so a learner studying rooms got a card with **no subject
name**, for no privacy benefit: the string identifies nothing. Fixed by `isRoomIdentifier`, which keeps
three ways a value names a room *as an identifier* (a marker beside the word, a camel-glued marker, a
path token) and drops the one that caught prose. **37 identifier shapes still refused, 22 prose values
now allowed**, and the two tables cannot satisfy each other by construction - `made on 2026-10-05` sits
in the identifier table to break any "spaced values are prose" patch.

**HIGH - a raw internal identifier was rendered as a badge's name.** `InventoryBadgesPanel.tsx` had a
`BADGE_LABELS` map covering **one** badge of eleven, and `badgeLabel` fell back to
`BADGE_LABELS[badgeId] ?? badgeId` - so `CreatorPhaseComplete`, `ArchaeologistReviewPass15` and
`FshMasterAngler` were displayed **as the badge's name**, and the detail card printed a
`<dt>Badge ID</dt>` row read by nothing. All eleven now resolve through `canonicalBadgeLabel`; the
local table is gone. An unknown id renders `Unrecognised badge` rather than the id, and omission was
rejected with a reason: the tab header counts every badge held, so a silently shorter list would
disagree with the number above it.

**MEDIUM - the renderer was about to delete two rows from every card.** The content designer's authored
label `"Rooms in the dungeon"` is not a declared field, so the value gate refused it - and
`renderShareCard`'s own header records that filtering labels in the renderer had once deleted **both**
room rows from every subject-summary card, caught by a row-count test. The labels were safe only because
one module happened to decline to filter. The repair was made **in the rule rather than by adding an
exemption**: a declared label and a learner's subject name are the same kind of string, so a gate
needing an exemption for one needs it for both, and an exemption list is a second mechanism the next
rule change quietly defeats. After the fix all 17 labels pass with zero special-casing.

**MEDIUM - four gates broke on legitimate Phase 20 growth, and three were repaired by asserting the
property instead of the membership.** `tests/phase19/assistanceNonVacuity.test.ts` P17 compared
`git status` against a hardcoded permit list of Phase 19 paths; its property is *"this file wrote
nothing"*, which is a statement about a **difference between two moments**, not an absolute set of
paths. It now snapshots the tree at module load and compares after every probe, and additionally
reports **removed** paths - the old one-sided filter would have scored a probe that *deleted* a file as
clean. Measured: evaluating the **old** predicate against a planted stray file in `src/ui/assistance/`
returns `[]`, so the old gate would have **passed** it. This is the fourth instance of the systemic
item Phase 19 already recorded. `tests/data/localDownloadOnly.test.ts` was scoped to name the permitted
`navigator.share` call sites with **exact counts** rather than deleted, `mailto:` remains unscoped, and
every `src/ui/data/` file is still checked with no exemption.

**MEDIUM - the build lane would have verified nothing if written the Phase 17 way.** `build:web:share`
turns on one flag and no renderer, so a Pixi-chunk check reports on a switch nobody set. The lane is
therefore found by **module membership plus reachability**, with three named load-bearing modules, and
the dead-lane guard makes a flagged build containing no share code a **red** build. All three checks
were seen red on real builds before being believed.

#### Gates changed, and the rulings

| Gate | Ruling |
| --- | --- |
| `tests/phase19/assistanceNonVacuity.test.ts` P17 (Phase 19) | **Legitimate break, and this is the systemic fix.** Compared the wrong thing - an absolute path list instead of a before/after difference. Replaced the comparison, kept the `expect(...).toEqual([])`, added a `removed` direction and a checksum assertion the header had claimed but never made. Provably **more** sensitive than the gate it replaces. |
| `tests/data/localDownloadOnly.test.ts` (Phase 5) | **Legitimate break, scoped not deleted.** `DECLARED_SHARE_CALL_SITES` names the permitted `file:rule` pairs with exact counts, and a new test proves the filter rejects a third occurrence, an undeclared rule in a declared file, and an undeclared file. `mailto:` never scoped; positive control untouched. |
| `tests/unit/InventoryBadgesPanel.test.tsx` and `tests/phase20/shareCardPanel.test.tsx` | **Legitimate breaks; both re-pointed at a stronger property.** The old gate asserted a control named by `new RegExp(badgeId)` - it **required** the ids on screen. It now asserts one control per badge named by its published label, no id anywhere in the tab, **and control count equal to id count** so hiding rows cannot satisfy it. |
| `tests/phase20/infraShareBuildLane.test.ts` font walk | **Legitimate, narrowed.** The walk covered gitignored `artifacts/`, where a Playwright trace embeds a `.ttf`, so any e2e run made it red about something the artifact does not ship. `artifacts/` excluded; a font planted under `src/` still fails 2 assertions. |

#### Non-vacuity evidence

Five owners ran probes. Every probe was verified green before mutation and restored with checksum
verification. Reported rather than counted:

- **`core-logic-engineer` reported 15 probes, of which 2 failed first attempt and were fixed rather
  than credited.** One `isDeniedField` call in `splitSelection` was proven **unreachable** and deleted;
  a widened per-kind table left a "every field is reachable" gate green because widening does not make
  a field unreachable. It also found its **own harness** reporting all 15 green because it grepped for
  vitest's `×` glyph - and the default reporter prints neither glyph nor `FAIL`, only `1 failed (1)`.
- **`core-logic-engineer` reported probe P8 cannot fire, with the structural reason.** After the room
  rule was corrected, **no declared field is denied by any shape rule**, so the allowlist short circuit
  is currently redundant. It was **kept anyway**: it is the guarantee the next blunt rule must satisfy,
  and deleting it would let that rule deny the vocabulary silently.
- **`ui-engineer` deleted a second filter rather than leaving it.** `renderShareCard` and
  `visibleShareCardRows` each had a `mayFieldAppearOnCard` call; making one permissive changed nothing,
  so one could never fire. The duplicate was removed - the same defect shape Phase 19 removed.
- **`ui-engineer` reported P13 first went green because the mutated module became unparseable** and
  vitest reports an uncollectable file as *skipped* with exit 0. Now paired edits plus a rule that a
  run with no passing test and no failure is a collection loss.
- **`village-content-designer` found the `room` false positive by trying to write honest copy** and
  refused to paper over it by renaming rooms to chambers. Independently confirmed by the orchestrator.
- **`qa-engineer` invalidated its own first proof.** A stray file planted *before* module load is
  correctly in the baseline, so the gate passed. Residue must appear *during* the run.
- **`qa-engineer` corrected a harness fact three of the four previous owners had repeated**: an
  uncollectable file does **not** exit 0 here - a syntax error gives `Test Files 1 failed (1)`, exit 1.
  The real silent-skip is a mistyped `-t`, which reports `1 skipped`.
- **`ui-engineer` fixed a latent crash found by the Map conversion**: `BADGE_DESCRIPTIONS['constructor']`
  returned `Object.prototype.constructor`, so `??` never fired and React received a function as a child.
- **`ui-engineer` disclosed a real coverage gap**: a fishing-badge probe did not fire because its first
  test covered only one of two branches. Parameterised, re-probed.

#### Exit-criteria assessment

1. **Local download works in every supported browser** - met for the configured matrix, **Chromium
   only** for this surface. No compatibility lane was run; Phase 21 owns the matrix.
2. **Web Share runs only from a user click** - met, and proved structurally rather than by assertion.
   Injecting `navigator.share` into the dialog's mount effect turned **9 tests red** across 2 files. A
   test asserting "no call on mount" would be the Phase 19 filter-based-Off shape, which passes every
   observable test while the trace catches it; the gate counts invocations across the lifecycle.
3. **Cancelling sharing causes no upload, error toast, or data mutation** - met. `AbortError` is
   classified as cancellation, not failure, with **distinct wording**. A before/after fingerprint of
   every storage-v2 generation store and every non-share `localStorage` key, with a
   baseline-substance assertion so an empty fingerprint cannot pass. **Assessed by QA for structure but
   not independently re-measured.**
4. **No public card URL or sharing backend exists** - met for the web artifact. Corrected on QA's own
   initiative: `server/index.js` **does** carry a `multer` `POST /api/upload`, pre-existing at `940fa04`,
   referenced by nothing in `src/` and nothing in `dist/`. The accurate claim is that the web artifact
   cannot reach one, not that none exists.
5. **Default cards contain no raw notes or hidden identifiers** - met. QA drove `renderShareCard`
   against a recording canvas and read the strings actually passed to `fillText`: across all four
   kinds **no drawn string contains any canonical badge id**, with a positive control proving the
   labels *are* drawn, so "no id" is not vacuously true.
6. **All decorative assets are CC0-approved** - met **trivially and deliberately**: `share-card=0`,
   **0 media files and 0 media references under `src/`**, and **no font file exists anywhere in the
   repository**. The card is drawn procedurally from Cozy tokens, so there was nothing to license.

#### Rollback

`VITE_WEB_SHARE=false`, the flag this phase's owner entry already declared. **Verified rather than
assumed**: the default `dist/index.html` contains **zero** case-insensitive references to any share
chunk, the three lane modules are `0 statically reachable from the entry`, no `canShare` or `.share(`
appears anywhere in the artifact, and the legacy local PNG download path is **intact and deliberately
not** declared a lane module - gating it would invert the rollback. Stored records are untouched.

#### Known limitations and UNVERIFIED

- **Contrast and real rendered touch-target size are UNVERIFIED.** jsdom computes no colours and no
  layout; the recording canvas says so itself. The 44px assertions are inline-style floors, not
  measured boxes. **Phase 21 owns the audit.**
- **Cards are English-only.** Every word a Spanish-reading learner sees on a card today is English.
  Structural, not a preference: importing a locale JSON into `src/core/share/**` turns the domain
  boundary gate red, and switching the module to emit keys is an API change to four exports other
  owners are written against, not a content edit. **Phase 21.**
- **Chromium only** for this surface. No compatibility lane was run.
- **The `navigator.share` payload's PNG bytes are synthetic** in jsdom, which has no PNG encoder. No
  test asserts real image content, and the Web Share `AbortError` is one the test's own spy throws.
  Real-browser cancellation is Phase 22/23 evidence.
- **A room id inside prose passes the value gate** (`room7f3a`, `My room-7f3a notes`,
  `the room was loud`). Structurally harmless - `ShareCardBuildInput` has no parameter a note body could
  arrive in - but recorded rather than assumed away.
- **`showroom-physics` is still refused**, by the pre-existing minted-id-tail branch that also refuses
  `room-7f3a`. Widening it would trade the module's central guarantee. Recorded as a test, not fixed in
  passing.
- **`suggestShareFileName` slugifies the learner's chosen subject name into the filename.** Opt-in and
  self-authored, but disclosed - a filename travels further than a card.
- **A badge id typed into the name field is drawn**, because the gate is a shape gate and that string is
  the learner's own visible text. Correct, and recorded so a later reader does not call it a leak.
- **Two Playwright walk-timeout failures during verification did not reproduce.** QA observed 7
  failures in two Pixi village walk tests under 4-project concurrency while **both passed
  individually** and **HEAD passed under the same load**. `playwright.config.ts` is `fullyParallel:
  false` and byte-identical to HEAD, so the extra concurrency was not ours. The final
  `npm run test:e2e` under the project's own config was **34 passed / 14 skipped / 0 failed**, matching
  the Phase 19 baseline. **Maintainer ruling 2026-10-06: leave the config alone** and carry the
  timeout's ~53s intrinsic variance against a 180s timeout to Phase 22.
- **One phase-commit-time cost**: making `shareCardContent` eagerly reachable costs **+0.57 KiB**
  gzip on Welcome (265.75 -> 266.32) because a static import cannot tree-shake a module-level `new Map`.
  **0 bytes** of it land in any lazily-loaded product chunk.
- **Six gate timeouts were raised** on four pre-existing files (`localDownloadOnly`, `phase5FlagDefault`,
  `study-shell-boundary`, `uploadBoundary`) - 20s each - because they are slow build-dependent gates,
  not because their assertions changed.

#### Follow-up work found and deliberately not done (working rule 13)

- **The `server/index.js` `POST /api/upload` endpoint** is pre-existing and out of Phase 20's scope,
  but it is a real upload path in a project whose safety constraint is "no automatic upload". Phase 23
  cutover should rule on it explicitly.
- **Two more instances of the whole-list-equality brittleness** Phase 19 recorded: `shareCardPanel`'s
  chunking gate had to be narrowed because a static import of `shareCardContent` violates it, and
  `InventoryBadgesPanel.test.tsx` hardcoded the JS *identifier* `SCRIBE_CENTURY_120_BADGE_ID` where
  the id *value* belonged - one character-level slip, five failures. **Phase 22/23 candidate.**
- `isDeniedField`'s shape rules are a blunt instrument that had to be corrected once already. A
  declarative list of identifier patterns would be a better long-term shape.
- Carried from Phase 19 and still open: `deps.setDualWriteSink` / `deps.setSessionSource` remain
  declared, defaulted and never called (ruled: not authorized). The flagged
  `VITE_ADAPTIVE_ASSISTANCE` Playwright lane is **deferred to Phase 21** by maintainer ruling. The
  32-bit statistics digest is a one-way door; `daysUntilReview` still disagrees with the dashboard;
  the subject-copy ID remapper does not rewrite room ids inside the four ledgers; eight colocated
  stylesheets sit outside the Phase 8 font scan.

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

**Status:** complete
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

### Verification evidence

Recorded on 2026-10-06. `not-started` -> `in-progress` -> `verified` -> `complete`. Committed and pushed
to `origin/main`; **not deployed** - no deployment was performed or authorized.

**Accepted by the maintainer on 2026-10-06.** The acceptance covers the phase's **automated** criteria.
It does **not** discharge the five manual gates: physical Chromebook, physical tablet, ChromeVox, touch
screen reader, and real Safari/Edge remain **UNVERIFIED**, and the four macOS/Windows engine-family pairs
remain **NOT MET**. Rather than being softened into a pass, they are carried forward as **release
blockers for Phase 23**, which must not claim a release while they are open. The discharge kit exists to
close them.

#### Baseline

Green at `35694d9` before any Phase 21 change: `npm run lint` 0, `npm run typecheck` 0, `npm test`
**316 files / 6626 tests**, `npm run build:web` 0, `npm run check:bundle-size` **5.42 MB / 167 files**,
`npm run check:budget:welcome` **266.32 KiB / 300.00 KiB**, `npm run test:licenses` PASSED,
`npm run test:privacy` **6 files / 34 tests**. No baseline repair was needed.

`npm run test:a11y` **did not exist**. Creating it is a deliverable of this phase.

#### Commands

```text
npm run lint                                        exit 0
npm run typecheck                                   exit 0
npm test                                            329 files / 6928 tests passed
npm run build:web                                   exit 0
npm run check:bundle-size                           5.43 MB / 167 files
npm run check:budget:welcome                        267.86 KiB / 300.00 KiB   (was 266.32; accepted as-is)
npm run test:licenses                               PASSED, 0 media under src/
npm run test:privacy                                6 files / 34 tests passed
npm run test:a11y                                   44 expected / 0 unexpected / 4 skipped
                                                    exit 3, verdict COVERAGE: INCOMPLETE
npm run test:e2e                                    34 passed / 14 skipped
npm run test:e2e:compat                             4 passed / 4 skipped
npm run test:e2e -- --project=chromebook            9 passed / 3 skipped
npm run test:e2e -- --project=tablet                8 passed / 4 skipped
npm run test:e2e -- --project=tablet-landscape      8 passed / 4 skipped
npm run check:manual-verification                   exit 0, 0/5 discharged
flagged assistance lane (playwright.assistance)     4 passed
default assistance lane (absence)                   3 passed
```

#### What the phase actually found

**HIGH - a critical ARIA violation on a surface the audit had never looked at.** Settings carried
`<button role="radio" aria-checked=... aria-pressed=...>`. `aria-pressed` is a *button* state, so each
control claimed to be a radio **and** a toggle button at once. Fixed by choosing the role the control
actually is - a radio in a `radiogroup` - and then adding the keyboard contract that role promises and
the markup never had: roving tabindex, arrows that move *and* select, `Home`/`End`, wrap-around.
`aria-pressed` is now written **nowhere**, not conditionally omitted, so a later edit that reaches for
it fails the audit. A consequence nobody had noticed: three CSS selectors keyed on
`[aria-pressed='true']` matched **nothing** afterwards, so the selected theme and language would have
had no styling at all.

**HIGH - one Escape closed two dialogs, and Tab containment was broken the same way.** On a touch
viewport the village HUD renders as a `sheet` and Settings opens above it. Both registered a
**capture-phase** `keydown` on `document`; the drawer registered first, so its handler dismissed and
unmounted the HUD column *before* the dialog's handler ran - and the dialog's restore target was by then
**disconnected**, so focus went to the drawer toggle. Tab was the same defect: focus oscillated
`['drawer', 'settings']`. Fixed in `useModalFocus` with a module-scoped **stack**, so only the topmost
scope acts. **`AccessibleDialog`, `VillageHud`, `SettingsModal` and `useVillageSurfaceMode` are
byte-identical to baseline** - the fix needed no caller change, which is the design's main claim. The
rejected alternative is recorded with its reason: *nearest-in-DOM-wins* answers the opposite way the
moment a dialog is portalled, because DOM depth here is a styling artefact; open order is a property of
what the learner did.

**HIGH - the recall question was unreachable on the shipping renderer.** Pressing the nearby-action row
reaches `studyFlow.enterFishing` through `structureInteract` **without** passing through `castFrom`, so
`structureIdRef.current` is `null`, `beginFishing` returns early, and the learner is told *"This catch
has no open pond session, so the question cannot be asked."* Only the pond panel's `Cast Line` minted a
session. Worse than first reported: `pixiFishing`'s production default is `false`, so the default build
uses the **Phaser** pond, whose adapter ignores `handlers.pondId` - the Pixi lane's `onSessionStarted`
backstop that masks this **does not exist on the artifact a learner downloads**. The question was
unreachable by keyboard, by touch, and by `E`. The first proposed fix - wrapping `flow.enterFishing` in
the screen - **did not work**, and its own test caught it: `structureInteract` calls its own module-local
`enterFishing`, so the wrapper never saw the broken route. The fix is at the single door every route
uses, `onBeforeStructureInteract`.

**MEDIUM - six dialogs had no focus management at all.** `SettingsModal`, `NoteEditorModal`,
`FullMapView`, `MakeItYoursModal`, `GameplayOnboardingModal` and `HelpOverlay` declared `role="dialog"`
with **no** hook: a keyboard learner could Tab out of Settings into the page behind, and **HelpOverlay
could not be left by keyboard at all** - whose own copy claims "`?` toggles this overlay". Two of the
six put the role on the **backdrop**, not the dialog. `AccessibleDialog` was built as a thin wrapper over
the existing `useModalFocus` rather than rewriting twenty working dialogs.

**MEDIUM - the new focus component's first version shipped a bug for one test run.**
`AccessibleDialog` fell `label` through to the `labelledBy` branch, producing an `aria-labelledby`
pointing at nothing. Caught by the second run of the test written for exactly that.

**MEDIUM - a dead keyboard route.** `FishingHud`'s `CHARGE_KEYS` omitted `'Space'`, which **both**
renderer normalizers accept. On any platform reporting `key === 'Space'` the learner held the space bar
and nothing happened, while the canvas route worked. The test now reads the spellings **out of the
renderer normalizers' own source**, so a fourth spelling added to the renderer without being added here
is red.

**MEDIUM - the village had no keyboard route to zoom at all**, pointer-only twice over (wheel and
pinch). Now two buttons plus a read-out (`Zoom is now one and a quarter times normal.`) reading the
newly exposed `readCameraState()`, hidden until a world exists so the Phaser rollback lane answers `null`
honestly.

**MEDIUM - reduced motion was set while the movement continued, three times.** The village and dungeon
cameras eased toward the player under reduced motion, and a caught fish's glyph grew into the bucket.
All three are the Phase 19 *filter-based-Off* shape: a flag that is set while the loop still runs.
Cameras cannot be fixed by scaling - `motion.scale` cannot express moving a whole viewport - so the lerp
was removed rather than shortened. One loop is deliberately **not** suppressed, pinned by a test: a
villager's patrol is **world state**, because `readNpcSnapshot` and `selectNearbyTargets` measure
against it, so freezing it would strand learners out of range and delete the nearby-action rows Phase 12
exists to provide.

**MEDIUM - a blocking e2e regression introduced by this phase's own dialog migration.** Moving
`GameplayOnboardingModal` to `AccessibleDialog` dropped `aria-label="Gameplay onboarding"`; the dialog is
now named from its heading. Four lanes located it by the old name, so the dismissal never fired, the
onboarding backdrop stayed mounted, and it **intercepted pointer events** over the Note editor -
`chromebook` and `desktop-chromium` failed deterministically. **The one-line revert was considered and
rejected**: `AccessibleDialog` documents that `aria-labelledby` on the heading is preferred so the name
cannot drift from what the learner reads, and that writing both is the defect it exists to prevent. The
name change was correct; the **lanes** were stale. They now use a stable `data-testid`, with the real
accessible name asserted **once**, in one place, so naming is still gated without welding four lanes to
onboarding copy.

**MEDIUM - the a11y audit's own probes contained two vacuous assertions.** One waited on
`body[data-world]`, an attribute that exists **only** on the village screen root and can **never** be set
on `body` - an expected-red dressed as a failure. One asserted `role="tabpanel"` count `1` both before
and after a tab swap: the count was **invariant across the interaction it claimed to verify**, because
`hidden` removes inactive panels from the accessibility tree either way. Both replaced, every bare
`getByRole` in the file narrowed, and the general rule recorded: **a count assertion is only evidence if
the count changes when the behaviour it names changes.**

**MEDIUM - touch form factors were not being audited at all.** `openVillage` waited for
`[data-village-nearby="true"]` to be *visible*, but on a coarse/hoverless pointer `useVillageSurfaceMode`
returns `sheet` and `VillageHud` **unmounts the entire column**. Village and Settings were therefore
**unscanned on both tablet cells**. Checked before deciding: that toggle is the **only** route to both
surfaces on touch, so the drawer **is** how a touch learner gets there - the probe now presses the real
labelled toggle, branching on the toggle's presence rather than the form factor. Surface coverage is now
reported **per cell** and folds into the verdict as incompleteness, not failure.

**LOW - four exact-count CI gates were hardened instead of bumped a fifth time.** Adding the assistance
artifact moved `download-artifact` counts 3 -> 5 in four files. Extending the literals would have been
the fourth growth of the same number; Phase 19 recorded three such gates breaking on legitimate list
growth and Phase 20 hit two more. Six assertions now go through one declaration of the property - *every
transfer is a named step, it is declared, transfers run in declared order, every download after the
first has its own `rm -rf dist`* - so a sixth artifact, an **unnamed** step, a missing discard, or a
transposition each fail.

#### Gates changed, and the rulings

| Gate | Ruling |
| --- | --- |
| `tests/phase8/qa-verification.test.ts` (5 assertions) | **Legitimate break, and strengthened.** It pinned `src/styles.css` byte-for-byte against a pre-Phase-8 fixture plus a SHA-256. Freezing that digest at a Phase-21 baseline would have replaced *"identical to the pre-Phase-8 legacy system"* with *"identical to whatever it was last reviewed as"* - the exact property the file exists to prevent. Now states 13 enumerated `was`/`now` pairs, each asserted to occur exactly once and reverted before comparison; any other edit in those 5,813 lines still fails. |
| `tests/e2e/{pixi-memory-lane,fishing-lane,phase10-media-lane}.test.ts`, `tests/phase9/pixi-pointer-lane-wiring.test.ts` | **Legitimate break, replaced by the property.** Six exact-count assertions became one shared transfer audit, proven sensitive to a sixth, an unnamed, a missing-discard and a transposed transfer. |
| `tests/phase12/village-panels.test.tsx`, `tests/unit/audioSettingsTab.test.tsx` | **Legitimate break.** Both read `aria-pressed` off controls that are now honest radios; re-pointed at `role`/`aria-checked` plus the one-tab-stop and non-colour-mark properties the role adds. |
| `tests/phase12/village-shell-split.test.ts` | **Legitimate break, and the product took the gate's side.** The composition-root budget was heading to 949; `useVillageZoomReader` was extracted and rationales moved to the modules that own them, bringing it to **898**. Not raised. |
| `tests/data/localDownloadOnly.test.ts`, `tests/phase19/assistanceNonVacuity.test.ts` | **Red during the phase, green in a clean run.** Both fail when another writer changes the tree mid-run. Verified by running each alone. Contamination, not regression. |

#### Non-vacuity evidence

Every owner probed; each probe was green before mutation and restored with checksum verification.
Reported rather than counted:

- **`game-engineer` caught three of its own probes nearly shipping a vacuous test.** `user.keyboard('{ }')`
  on an **unfocused** element delivers no keydown, so a charge test asserted `toHaveBeenCalledTimes(1)`
  against a call that could never happen. 30 frames x 100 ms is **exactly two** 1500 ms bob periods, so
  comparing endpoints reported "still" for a bob moving every frame between them. And a camera clamp
  pinned the centre at the same value under both motion profiles, so the easing assertion could not
  fail. All three rewritten, each with the reason.
- **`ui-engineer` proved the Escape fix by mutation, and one probe was only trustworthy after
  instrumenting `focusin`** - the first Tab test passed pre-fix because the dialog's own repair masked
  the transient. Rewritten to assert from a **middle** control, plus a wrap-around case.
- **`infrastructure-engineer` verified its harness could see a failure three times, and each time the
  green was a lie**: `--reporter=basic` is an unresolvable *reporter* (a startup error, not a test
  failure); a duplicate import made an unparseable file report as *"1 failed | no tests"*; and an exit-3
  proof initially read `FAILED` only because a `/tmp` config cannot resolve `@playwright/test`.
- **`infrastructure-engineer` retracted a wrong inference rather than shipping it.** It first concluded
  the e2e failures were a Phase 20 regression, then found the comparison had pitted 1 project against 4.
  Corrected to: both walk tests pass individually, and HEAD passes under the same 4-project load.
- **A runner count defect was found while validating another count.** `perProjectCounts`
  **double-counted skipped tests** - a cell with one skip printed `skipped 2` while the report's own
  stats said 1. Fixed with a regression test and a red proof (guard 1 / pre-fix 2).
- **The schema validator was proven to discriminate, not merely to reject.** A genuine manual record
  exits 0 with 1/5 discharged; a wrong schema version, an `emulated-viewport` evidence class, and a
  record deriving a manual gate from the `tablet` cell each exit 1 with a named reason.
- **The assistance preflight is non-vacuous because the obvious discriminator is wrong.** Both builds
  emit `AssistanceRegion-*.js` and `assistanceStore-*.js`, and the census reports `2/2 declared path(s)
  fetchable` for **both** - so a chunk-presence check would pass on a default `dist/`. What differs is
  the compiled constant, so the preflight reads that out of the emitted bytes.
- **`ui-engineer` fixed a real bug its own gate found**: an assertion matched its own prose documenting
  the defect it prevents - fixed by comment-stripping, the same lesson the Phase 19 file needed.

#### Exit-criteria assessment

1. **Zero serious or critical automated accessibility violations** - met **on the cells that ran**:
   **44 expected / 0 unexpected / 4 skipped**, 3/3 surfaces on every cell. Both genuine violations were
   fixed and neither was silenced; the one recorded pre-existing exception
   (`.welcome-checklist-status--done`) is untouched and no exception list was extended.
2. **The complete learning path works through DOM controls and keyboard** - met and **inventoried per
   world**: every canvas interaction in village, dungeon and fishing now has a keyboard-reachable DOM
   equivalent with an accessible name. The two gaps found were real - village zoom had no keyboard route
   at all, and fishing's charge control was dead on `key === 'Space'`.
3. **Touch use does not depend on hover or precision gestures** - met, and the audit now actually
   reaches the touch surfaces, because the drawer path is the only route on touch.
4. **Core layouts work at 200% zoom and a 320 CSS-pixel viewport** - **partially verified.** The
   properties that *produce* overflow are asserted and a real long-label overflow was found and fixed in
   the theme picker. **Real layout at 200% zoom is not measured** - jsdom computes no layout.
5. **Reduced-motion mode has no continuous decorative movement** - met for every decoration, with one
   documented exception (villager patrol, which is world state) pinned by a test. Proved by a tick
   counter that does not advance, not by a boolean.
6. **ChromeVox and the selected touch screen-reader script pass** - **NOT DISCHARGED. UNVERIFIED.**
7. **Every required OS/browser compatibility cell passes the core-flow smoke** - **NOT MET.**
   `compat-chromium` and `compat-firefox` pass; `compat-webkit` and `compat-edge` are
   `host-not-approved` on Linux; and the four macOS/Windows engine-family pairs are unmet by ruling.
8. **The full learning path remains keyboard- and DOM-operable in the selected accessibility cells** -
   met on `desktop-chromium`, `chromebook`, `tablet`, `tablet-landscape`, `compat-chromium`,
   `compat-firefox`.
9. **Viewport emulation is not reported as physical Chromebook or tablet verification** - met
   **mechanically, not by prose**: no matrix cell claims `physical-device-manual`, the discharge kit can
   record **only** that class, and a record derived from an emulated cell is rejected by name.
10. **Actual Safari, Edge, ChromeVox and touch-screen-reader evidence is distinguished from automated
    Playwright evidence** - met as a **structure**. The distinction exists, is enforced, and defaults to
    UNVERIFIED. **No such evidence has been gathered.**

#### The discharge kit (deliverable)

The plan asks for a screen-reader verification record and keyboard/touch scripts, and requires actual
Safari, Edge, ChromeVox and touch-screen-reader evidence to be recorded separately from automated
evidence. This container has none of that hardware, so the phase produced the **kit** rather than the
evidence:

- `tests/e2e/PHASE21-MANUAL-VERIFICATION.md` - a written procedure per gate: what to do, what to
  observe, what counts as a pass, and a JSON template. Gate 2 documents the drawer path explicitly,
  because on touch the HUD column does not exist until the toggle is pressed.
- `tests/e2e/manual-verification.ts` + `manual-verification-record.json` - a fixed schema, five entries,
  all `unverified`.
- `scripts/check-manual-verification.mjs` - one line per gate, defaulting to UNVERIFIED; a `discharged`
  verdict requires a full nine-field attestation, and an emulated cell cannot be promoted.
- Appendix A: the keyboard-only path through Welcome -> Village -> Creator -> Scribe -> Archaeologist ->
  Statistics -> Fishing -> Data Center -> Settings -> share dialog. Appendix B: the three worlds' DOM
  mirrors.

#### Rollback

Revert individual accessibility fixes. No renderer or storage rollback is required. Every change is
additive except three `camera.follow`+`update` pairs that now branch, and the modal-focus stack, which
`AccessibleDialog` reaches without any caller change.

#### Known limitations and UNVERIFIED

- **Five manual gates are UNDISCHARGED**: physical Chromebook, physical tablet, ChromeVox, touch screen
  reader, and real Safari/Edge. They are recorded UNVERIFIED and the discharge kit exists to close them.
  The maintainer accepted this phase on its automated criteria and carried these forward as **release
  blockers for Phase 23** - see the acceptance note above. They are not discharged by acceptance.
- **The four macOS/Windows engine-family pairs are NOT MET** by maintainer ruling, rather than an
  unverified claim being entered.
- **`compat-webkit` and `compat-edge` never ran** - `host-not-approved` on Linux. `support-matrix.ts`
  was **not** edited to force them.
- **Real layout at 200% zoom and 320 CSS pixels is not measured**, and **measured box size is not
  verified** for touch targets - the 44px checks are declarations. The theme picker is the one control
  whose floor lives in a stylesheet, and its test says so.
- **Villager patrol continues under reduced motion, by decision** - it is world state, and freezing it
  would strand learners out of range and delete the nearby-action rows.
- **Three of the five assistance surfaces still have no browser evidence.** The flagged lane observes the
  **fishing** surface rendering a real suggestion with its reason and dismiss control, and the default
  lane observes its **absence**. `creator`, `scribe` and `archaeologist` sit behind their own
  `productionDefault:false` workspace flags that `build:web:assistance` does not set, so reaching them
  needs a composite-flag artifact or a product decision.
- **`assistanceStore-*.js` is fetched on Welcome on every build**, including the production default,
  because `runBootstrap` awaits `loadAssistanceStore()` unconditionally. Not counted by
  `check:budget:welcome`, but a real per-launch fetch. Phase 22.
- **The a11y runner needed a `spawnSync` fix** before a red gate could tell a reader *why* without
  opening a JSON artifact.
- **`COZY_LEGACY_VARIABLE_BRIDGE` still has no shared key table with the renderer's `normalizeKey`**,
  so one test reads the renderers' source rather than importing them.
- **Five pre-existing `text-overflow: ellipsis` sites** are enumerated with a per-site verdict and gated
  against a sixth; four are on surfaces Phase 21 does not own.
- **`ScribeEncounter` hand-rolls its own focus containment** - correct today, and the one surface whose
  keyboard contract can drift from the other nineteen. Named and gated as follow-up.
- **The two Pixi village walk tests still carry ~53s of intrinsic variance** against a 180s timeout.
  Ruled: `playwright.config.ts` stays byte-identical to `HEAD`; Phase 22 owns it. They passed in the
  final runs.
- **Welcome is 267.86 KiB of 300.00** (32.14 KiB headroom), up 1.54 KiB for two axe fixes, six dialogs
  given focus management, the zoom controls and read-out, three reduced-motion fixes and the focus
  stack. Accepted as-is by maintainer ruling; lazy-loading `VillageScreen`/`GameScreen` was the recovery
  route and was declined as a route-loading architecture decision.

#### Follow-up work found and deliberately not done (working rule 13)

- The **feature-lane census has now been generalised twice** (`auditFeatureLane`) and six CI-wiring
  gates were hardened rather than bumped. The remaining hand-maintained lists - the lane path roles, the
  manual `GATES` list, the a11y surface list - are the same class and worth a deliberate pass.
- **`aria-modal="false"` on the village drawer and HUD** is deliberate (the world stays usable behind
  them), but they are non-modal dialogs that now share the focus stack. Worth a second look when
  Phase 22 touches the surface mode.
- Carried from Phase 20: three colocated stylesheets sit outside the Phase 8 font scan; the
  `Inter`-not-bundled finding is fixed for cards only.
- Carried from Phase 19 and still open: `deps.setDualWriteSink` / `deps.setSessionSource` are declared,
  defaulted and never called (ruled: not authorized). The 32-bit statistics digest is a one-way door;
  `daysUntilReview` still disagrees with the dashboard; the subject-copy ID remapper does not rewrite
  room ids inside the four ledgers.

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

**Carried from Phase 21 and NOT discharged by its acceptance:** the five manual accessibility gates
(physical Chromebook, physical tablet, ChromeVox, touch screen reader, real Safari/Edge) and the four
macOS/Windows engine-family compatibility pairs. Phase 23 must not claim a release while they are open;
`tests/e2e/PHASE21-MANUAL-VERIFICATION.md` is the procedure that closes them and
`npm run check:manual-verification` reports them one line per gate.

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
