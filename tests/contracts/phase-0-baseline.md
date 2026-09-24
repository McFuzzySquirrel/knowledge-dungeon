# Knowledge Dungeon rebuild — Phase 0 baseline

**Review date:** 2026-09-24
**Plan:** `docs/plans/001-cozy-pixi-rebuild.md`, Phase 0 (lines 660–723)
**Artifact status:** test/documentation baseline only. It freezes current behavior and records known gaps; it does not claim that Phase 1 or any later rebuild phase is implemented.

## Scope and evidence rules

This artifact is a reviewable record of the current application and persistence
surface. The source of truth for the characterization tests is the current
on-disk implementation, especially:

- `src/ui/App.tsx`, `src/ui/screens/WelcomeScreen.tsx`,
  `src/ui/screens/VillageScreen.tsx`, and `src/ui/screens/GameScreen.tsx`
- `src/store/sessionStore.ts`, `src/store/subjectStore.ts`, and
  `src/store/progressionStore.ts`
- `src/services/persistence/subjectPersistence.ts`,
  `src/services/errorRecovery.ts`, `src/services/sessionTracker.ts`, and
  `src/services/customSprites.ts`
- `src/core/validation/persistence/types.ts` and the existing unit tests under
  `tests/unit/`

The new tests under `tests/contracts/` characterize **current** importer,
raw-loader, and progression hydration behavior. They do not define storage-v2
behavior. The fixtures under `tests/fixtures/persistence/` are synthetic and
contain no learner records.

## 1. Golden-path acceptance matrix

The current application uses in-memory screen state rather than URL routes.
`App` selects `welcome`, `village`, or `game`; `game` additionally requires a
loaded snapshot, a selected archetype, and an active subject. The phase is one of
`creator`, `scribe`, or `archaeologist`.

| Step | Current route/state | Current phase | Current action/control | Expected current result | Existing test coverage |
| --- | --- | --- | --- | --- | --- |
| Welcome → subject | `welcome` (`activeScreen`) | `creator` by default; tutorial sets `scribe` | `Create / Load` tab; enter subject name/root topic; `Create new subject`; select an existing subject; `Start Tutorial` | Creating or selecting a subject persists/selects it. `Start Tutorial` creates/imports the tutorial subject, selects Scholar, loads and synchronizes the tutorial subject, and enters `game`. | `tests/unit/WelcomeScreen.test.tsx` (`allows creating...`, `requires explicit enter confirmation...`, `associates imported subject...`); `tests/unit/App.test.tsx`; `tests/unit/subjectPersistence.test.ts`. There is no direct current test assertion for the `Start Tutorial` click. |
| Welcome → setup | `welcome` | User-selected `creator`, `scribe`, or `archaeologist` | `Player Setup` tab; phase cards; `Scholar`, `Cartographer`, or `Archivist` card; `Enter Dungeon` | `Enter Dungeon` requires both a selected existing subject and a selected archetype. It loads and synchronizes that subject through the canonical subject flow, then enters `village`. | `tests/unit/WelcomeScreen.test.tsx` (`requires explicit enter confirmation`, `associates imported subject...`); `tests/unit/App.test.tsx` |
| Welcome → Village | `welcome` then `village` | Any current phase | `Continue to Village` | The button appears whenever at least one existing subject is present. It does not require a selected subject or archetype, does not load or synchronize a subject, clears the village-spawn handoff, and enters `village`. | `tests/unit/App.test.tsx` verifies the button appears with existing subjects; `tests/unit/WelcomeScreen.test.tsx` covers selected-subject entry gates. There is no direct assertion of the no-gate Continue click. |
| Village → Creator | `village` → `game` | `creator` | Walk with WASD/arrows or touch; `E`/touch `Interact`; `Info`/`I`; Room panel `Topic` tools; `Add child rooms`, parent controls, delete/cross-link tools | Room interaction opens the room information path. Creator actions mutate the graph through the subject store and persist the snapshot. The root/floor navigation model is represented by the current Phaser scene. | `tests/unit/graphDomain.test.ts`; `tests/unit/graphNavigation.test.ts`; `tests/unit/RoomPanel.test.tsx`; `tests/unit/GameScreen.npcDialog.test.tsx` (callback-level interaction). These are not actual Phaser/Pixi browser tests. |
| Creator → Scribe | `game` | `creator` → `scribe` | HUD phase button `Scribe`; `Switch to Scribe` nudge; or the portal entry path | The phase changes without a storage-v2 migration. Scribe interaction opens the note editor for the focused room. | `tests/unit/Hud.test.tsx`; `tests/unit/GameScreen.npcDialog.test.tsx`; current phase state is covered, but no complete route-to-editor browser test exists. |
| Scribe | `game` | `scribe` | `E`/touch interaction; Note editor `Edit`, `Preview`, section chips, `Checks`, `Images`, confirmation checkbox, save/submit | An incomplete note is saved as a resumable draft. A valid note updates the room, creates an artifact, and currently calls room-clear progression. The world artifact callback is a separate collection action. | `tests/unit/NoteEditorModal.test.tsx`; `tests/unit/noteValidation.test.ts`; `tests/unit/artifactGenerator.test.ts`; `tests/unit/importedSubjectArtifacts.test.ts`; callback coverage exists in `GameScreen.npcDialog.test.tsx`. |
| Scribe → Archaeologist | `game` | `scribe` → `archaeologist` | HUD phase button `Archaeologist`; cleared-room `Artifact`/`Self-check` tabs | The current UI exposes review controls once the relevant room state is present. The review action is completed when the room panel is closed. | `tests/unit/reviewDomain.test.ts`; `tests/unit/spacedRepetition.test.ts`; `tests/unit/RoomPanel.test.tsx`; `tests/unit/GameScreen.npcDialog.test.tsx` (`awards archaeologist XP only on first review...`). |
| Archaeologist | `game` | `archaeologist` | `E`/touch room interaction; `Notes`, `Artifact`, `Self-check`; `Done reviewing`/close room panel | A review pass updates the room and SM-2 state and may award review XP. The current implementation has known unlock/interruption/idempotency gaps listed below. | `tests/unit/reviewDomain.test.ts`; `tests/unit/spacedRepetition.test.ts`; `tests/unit/GameScreen.npcDialog.test.tsx`; `tests/unit/RoomPanel.test.tsx`. No interrupted-exit browser test exists. |
| Archaeologist → Village | `game` → `village` | `archaeologist` | HUD `Home` / `Return to subject selection`; the current Village guide also lists `H` | The DOM Home / `Return to subject selection` path is current: it clears active subject state, cancels teleport state, and changes `activeScreen` to `village`. The guide-listed `H` key has no verified current `GameScreen` handler. Progression remains stored by subject. | `tests/unit/GameScreen.npcDialog.test.tsx` exercises the screen's stateful shell and callbacks, but there is no current end-to-end return-to-Village assertion. |
| Village → next subject/activity | `village` | Any | Guild Hall/create subject, subject portal, Quest Board, Library, Workshop, Fountain/Stats, Fishing Pond/Fish Stand, Settings | The current hub exposes these DOM panels and Phaser structure/NPC callbacks. The route remains state-based; there is no URL to deep-link. | Existing unit tests cover adjacent panels/components (`StudyStatsPanel`, `FishStandPanel`, `InventoryBadgesPanel`, `RoomPanel`, settings/onboarding where present), not a complete browser hub flow. |

**Important limitation:** the existing Vitest setup globally mocks Phaser
(`vitest.setup.ts`). A passing jsdom test is not evidence of actual world
rendering, input, performance, or screen-reader behavior.

## 2. Current route and control inventory

### Route/state inventory

| Surface | Current source/state | Current behavior |
| --- | --- | --- |
| Welcome | `App.activeScreen === 'welcome'`; default `sessionStore.activeScreen` is `welcome` | Shows subject creation/loading, setup, guide, and data tabs. `Continue to Village` appears when any existing subjects are present and enters `village` without a selected-subject or archetype gate; `Enter Dungeon` has the selected-subject-plus-archetype gate. |
| Village | `App.activeScreen === 'village'` | Mounts the current Phaser village plus a React HUD and contextual panels. It is a hub, not a URL route. |
| Game | `activeScreen === 'game' && snapshot && selectedClass && activeSubjectId` | Requires the activation gates, then hosts dungeon orchestration and the Creator/Scribe/Archaeologist phase UI. Fishing is launched from the current Village screen. |
| Creator | `phase === 'creator'` | Room topic/map editing, child rooms, reparenting, deletion, and cross-links. |
| Scribe | `phase === 'scribe'` | Room encounters, note editor, validation, artifact generation, and room-clear reward path. |
| Archaeologist | `phase === 'archaeologist'` | Cleared-room artifact/self-check review, review passes, and SM-2 updates. |

### Welcome entry semantics

| Control | Current gate/action | Result |
| --- | --- | --- |
| `Enter Dungeon` | Requires both `selectedExistingSubjectId` and `selectedClass`; calls the canonical load flow, then clears the village-spawn handoff. | Loads and synchronizes the selected subject, then enters `village`. |
| `Start Tutorial` | No existing-subject or archetype prerequisite; imports/creates the tutorial subject and explicitly sets phase `scribe` and class `scholar`. | Loads and synchronizes the tutorial subject, then enters `game`. |
| `Continue to Village` | Rendered when `existingSubjects.length > 0`; no selected-subject or archetype check and no subject load call. | Clears the village-spawn handoff and enters `village` directly. |

### Current controls and equivalents

| Capability | World/current input | DOM-equivalent or adjacent control | Current parity note |
| --- | --- | --- | --- |
| Village/Dungeon movement | `W A S D`, arrow keys, pointer/touch drag | Touch hint and touch controls; no complete DOM free-movement equivalent | Village and Dungeon scenes both use the four-direction movement set; full Pixi/browser parity is future work. |
| Fishing movement | `A`/`D` and `Left`/`Right` only (horizontal) | Current Fishing scene has no DOM free-movement equivalent | Fishing is intentionally distinct from Village/Dungeon movement; do not generalize the four-direction controls to it. |
| Interact | `E` and touch/tap | `Interact` buttons, `Enter Dungeon`, room primary actions, panel controls | Core actions have several DOM buttons, but browser-level coverage is absent. |
| Room information | `I` | HUD `Info` button and `RoomPanel` | DOM panel exists; actual world/DOM synchronization needs browser evidence. |
| Full map | `M` | HUD/Floating `Map` button; `FullMapView` | DOM view exists; map travel and teleport are current Phaser callbacks. |
| Teleport | Map selection and touch/pointer path | HUD/Floating `Teleport` button and map list | Two-minute cooldown is implemented; a 200%/touch browser audit is not Phase 0 evidence. |
| Return home | `H` is listed in the current Village guide, but no `GameScreen` handler for `H` was found | HUD `Home` / `Return to subject selection` | The DOM Home path is current; the guide-listed `H` key has no verified `GameScreen` handler. No complete E2E assertion is present. |
| Help | `?` or `Shift+/` | HUD `Help` button and `HelpOverlay` | Keyboard and DOM controls exist. |
| Phase switch | World/scene context changes | HUD `Creator`, `Scribe`, `Archaeologist` buttons | Current phase changes are not a future feature-flag/cutover implementation. |
| Notes | `E` on a Scribe room | Note editor dialog, section tabs, edit/preview/checks/format/images, save/submit | Editor is DOM-owned; current image upload compatibility path remains. |
| Review | `E`/room interaction in Archaeologist | Room panel `Artifact`, `Self-check`, `Done reviewing` | Review completion is coupled to panel close in current code. |
| Inventory/badges/journal | World/HUD collections | HUD collection buttons and `InventoryBadgesPanel` | DOM panel exists; no storage-v2 or backup coverage is implied. |
| Settings | HUD/settings entry | `SettingsModal` theme, language, shortcut controls | Locale, preferences, and shortcuts are localStorage-backed. |
| Village hub | Phaser structure/NPC proximity and `E` | HUD buttons and contextual info panels; touch `Interact` | Current route uses a Phaser world; no actual Pixi evidence exists yet. |
| Fishing return | `Escape` in the current fishing scene | Fishing Return button and the Village return callback | Fishing is launched from Village and returns to that screen; it is not a separate URL route. |

## 3. Complete app-owned localStorage inventory

The table covers keys and dynamic key patterns found in current production
source. A pattern in angle brackets is a caller-provided identifier/path, not a
literal single key. The inventory intentionally distinguishes keys that are
declared but currently unwritten from keys that have active readers/writers.

### Subject, progression, session, and recovery

| Key/pattern | Owner/source | Current value/behavior |
| --- | --- | --- |
| `knowledge-dungeon:v1:activeSubjectId` | `subjectPersistence.STORAGE_KEYS.activeSubjectId` | Active subject ID; removed for null. Used when hydrating v1 progression and by activation code. |
| `knowledge-dungeon:v1:subject:<subjectId>` | `subjectPersistence.STORAGE_KEYS.subject` | JSON subject snapshot. `loadSubjectSnapshot` parses raw JSON without subject migration; parseable structurally invalid data is returned unchanged and is not quarantined, while malformed JSON is quarantined. |
| `knowledge-dungeon:v1:subjects` | `subjectPersistence.STORAGE_KEYS.subjectIndex` | JSON array of subject IDs. `saveSubjectSnapshot` appends; delete and quarantine update it. |
| `knowledge-dungeon:v1:progression` | `progressionStore` / `STORAGE_KEYS.progression` | Current writes are version 3 `{ version, bySubject, crossSubjectAchievements }`; reads also normalize v1 flat and v2 by-subject shapes. |
| `knowledge-dungeon:v1:session` | `subjectPersistence.STORAGE_KEYS.session` | Declared key constant; no current production writer/reader was found. It remains part of the current declared storage surface. |
| `knowledge-dungeon:v1:sessions` | `sessionTracker` | JSON array of session records, capped at the last 500. Session functions exist but are not wired into the current gameplay flow. |
| `knowledge-dungeon:backup:<subjectId>` | `errorRecovery.BACKUP_PREFIX` | One raw subject backup per ID, written before overwrite. |
| `knowledge-dungeon:corrupt:<subjectId>` | `errorRecovery.CORRUPT_DATA_PREFIX` | Raw subject JSON quarantined after a parse failure. |

### Quest, navigation, and UI markers

| Key/pattern | Owner/source | Current value/behavior |
| --- | --- | --- |
| `kd-quest-step` | `sessionStore` | Current quest step ID; read at module initialization and written by `setQuestStep`/`advanceQuestStep`. |
| `kd-village-spawn` | `VillageScene`, `VillageScreen`, `WelcomeScreen` | Temporary JSON `{ gridX, gridY }` spawn handoff; read and removed on village entry, and cleared before some Welcome actions. |
| `knowledge-dungeon:ui:touch-hint:v1` | `MobileTouchHint` | Marker for the one-time mobile/touch hint. |
| `knowledge-dungeon:ui:fishing-hint:v1` | `VillageScreen` | Marker set to `1` after the fishing hint has been shown. |
| `knowledge-dungeon:ui:onboarding:gameplay-loop:v1` | `ui/utils/onboarding` | Value `seen` for the gameplay-loop onboarding modal. |
| `knowledge-dungeon:ui:export-reminder:lastNudge` | `useExportReminder` | Numeric `Date.now()` marker for the export reminder interval. |
| `knowledge-dungeon:ui:tooltips:v1` | `ui/utils/tooltips` | JSON array of seen tooltip IDs. |

### Preferences, shortcuts, and locale

| Key | Owner/source | Current value/behavior |
| --- | --- | --- |
| `knowledge-dungeon:session:preferences` | `preferencesStore` | JSON graphics mode/theme/active sprite-pack preferences. |
| `knowledge-dungeon:session:shortcuts` | `shortcutStore` | JSON array of Help/Map/Info shortcut bindings. |
| `knowledge-dungeon:locale` | `i18n/index.ts` and `i18next-browser-languagedetector` | Cached language selection (`en` or `es` in the current configuration). |

### Custom sprite state

| Key/pattern | Owner/source | Current value/behavior |
| --- | --- | --- |
| `knowledge-dungeon:custom-sprites:override:<spritePath>` | `customSprites` | Raw custom SVG override. |
| `knowledge-dungeon:custom-sprites:anim:<spritePath>` | `customSprites` | JSON animation configuration. |
| `knowledge-dungeon:custom-sprites:packs` | `customSprites` | JSON object containing sprite packs and active pack name. |
| `knowledge-dungeon:custom-sprites:originals:<spritePath>` | `MakeItYoursTab` | First original SVG cached before the first override. |

### Scope notes for `kd-*` and other keys

- The only production `kd-*` localStorage keys currently found are
  `kd-quest-step` and `kd-village-spawn`.
- `scripts/capture-screenshots.mjs` also injects the following legacy/tooling
  keys. They are app-repository compatibility observations, but current
  application source does not read or write them:

  | Key/pattern | Owner/source | Current value/behavior |
  | --- | --- | --- |
  | `kd-subject-index` | `scripts/capture-screenshots.mjs` | Legacy screenshot subject-index injection. |
  | `kd-subject:<subjectId>` | `scripts/capture-screenshots.mjs` | Legacy screenshot subject payload injection. |

- Strings such as `kd-player-*`, `kd-door-*`, and `kd-floor-biome-*` in the
  source are Phaser texture identifiers or generated scene keys, not
  localStorage keys, and are not included as storage entries.
- `knowledge-dungeon:subjects:index` appears in an existing test as a legacy
  test input, but no current production source declares or reads it. It is
  listed here as a compatibility observation, not an active production key:

  | Key | Owner/source | Current value/behavior |
  | --- | --- | --- |
  | `knowledge-dungeon:subjects:index` | `tests/unit/preferencesStore.test.ts` only | Legacy/test subject-index spelling used to verify that an unrelated key does not select graphics mode. No current production reader or writer was found; migration policy must explicitly decide whether to import it. |

- `perfMonitor` and `errorRecovery` count keys beginning with
  `knowledge-dungeon:`; this is an accounting prefix, not an additional key.

## 4. Build-size baseline

Measurements were taken on Linux x64 with Node `v22.22.2`, npm `10.9.7`, and
Vite `8.0.14` on 2026-09-24. Raw bytes and gzip bytes were measured from the
resulting `dist` directory; the profile run intentionally includes source maps.

### Commands and exact results

| Build | Command | Raw `dist` total | File count | Bundle check |
| --- | --- | ---: | ---: | --- |
| Production | `npm run build:web` | `4,093,638` bytes (`3.90 MiB`) | `105` | `npm run check:bundle-size` passes: `Total dist size: 3.90 MB across 105 files`. |
| Profile | `npm run build:web:profile` | `28,397,913` bytes (`27.08 MiB`) | `113` | Fails the raw ceiling: `Total bundle size 28397913 exceeds limit 12000000`. |

Representative production artifacts:

| Artifact | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| `assets/index-CER2OGRW.js` (modern app) | `438,306` | `125,578` |
| `assets/vendor-phaser-D3K-6SD4.js` (modern Phaser chunk) | `1,199,711` | `318,038` |
| `assets/index-CryJyGwS.css` | `87,825` | `15,473` |
| `assets/index-legacy-D7A37v-H.js` | `531,139` | `141,832` |
| `assets/vendor-phaser-legacy-ZmikWxJT.js` | `1,193,868` | `317,276` |

Representative profile artifacts:

| Artifact | Raw bytes | Gzip bytes | Source-map bytes |
| --- | ---: | ---: | ---: |
| `assets/index-WIUHVfNn.js` (modern app) | `438,969` | `125,892` | `1,366,525` |
| `assets/vendor-phaser-D3K-6SD4.js` (modern Phaser chunk) | `1,199,762` | `318,087` | `9,823,393` |
| `assets/index-CryJyGwS.css` | `87,825` | `15,473` | — |
| `assets/index-legacy-CtpPvcU0.js` | `531,829` | `142,139` | `1,303,769` |
| `assets/vendor-phaser-legacy-ZmikWxJT.js` | `1,193,926` | `317,330` | `9,647,567` |

**Profile limitation:** `vite.config.ts` enables `build.sourcemap` in profile
mode. The profile directory therefore contains large `.map` files, and
`check-bundle-size.mjs` counts those maps in its raw 12 MB total. The profile
failure is a measurement-mode limitation, not a production bundle-size result;
the production build is the release comparison.

### Verification record

- `npm test -- tests/contracts/phase-0-subject-characterization.test.ts tests/contracts/phase-0-progression-characterization.test.ts` — **pass**, 2 files / 20 tests.
- `npm test` — **pass**, 34 files / 254 tests.
- `npm run lint` — **pass**.
- `npm run typecheck` — **pass**.
- `git diff --check` — **pass**.
- `npm run build:web:profile` — **pass** (profile artifact generated); the following `npm run check:bundle-size` — **expected failure** because profile source maps make the raw total 28,397,913 bytes.
- Final `npm run build:web` — **pass**; final `npm run check:bundle-size` — **pass**, 3.90 MB / 105 files.

## 5. Known defects from plan §5.3

Every row below is a current known defect. None is marked fixed by Phase 0.
The phase/owner column identifies the earliest planned rebuild work and the
specialist responsible for the behavior, with QA retaining verification
ownership.

| Plan §5.3 defect | Current behavior | Intended rebuild behavior | Later phase / owner |
| --- | --- | --- | --- |
| Session tracking functions are not wired into real gameplay. | `sessionTracker` exposes start/end/track/compute functions, but current source has no gameplay calls to `startSession` or the tracking functions; Village computes a snapshot from stored sessions. | Centralized, idempotent session lifecycle events feed statistics and are wired to subject/room/note/review/XP/fishing actions. | Phase 18 — core-logic-engineer + ui-engineer; qa-engineer verifies lifecycle/date/idempotency. |
| Fishing eligibility, recall selection, and persistence may use different subject contexts. | Pond eligibility uses portal/subject summaries; keeping a fish chooses a subject from progression ordering, while recall reads the progression store's active subject. | One explicit subject context follows pond entry, catch, recall, release/keep, XP, badges, and persistence. | Phase 17 — core-logic-engineer + game-engineer + ui-engineer; qa-engineer verifies context collisions. |
| Fish catalog identity is discarded or represented inconsistently. | UI/catch data carries a catalog ID, while persisted entries and store-generated IDs can be based on display names and do not consistently retain the catalog identity. | Canonical catalog ID and stable fish identity are preserved through every event, backup, and collection view. | Phase 17 — core-logic-engineer with village-content-designer; qa-engineer verifies round trips. |
| Fish, XP, and badges are written through multiple non-transactional operations. | Keeping a fish, awarding XP, and checking/adding badges are separate store calls and localStorage writes. | One idempotent domain command commits the catch outcome and associated progression atomically (or fails without partial reward state). | Phase 17/18 — core-logic-engineer; qa-engineer verifies retries and collisions. |
| Current backups omit authoritative progression, fish, sessions, and attachment bytes. | Subject JSON/folder export centers on the subject snapshot; current backup paths do not package the full progression/session/fish/attachment set or attachment bytes. | Full-device and subject products include authoritative local state and available bytes, disclose external-only attachments, and preserve unknown fields. | Phases 5–6 — core-logic-engineer + infrastructure-engineer; qa-engineer verifies archive contents. |
| Same-ID imports can overwrite subjects while leaving stale progression. | Import writes under `imported.dungeon.dungeonId`; an existing subject ID can be replaced without a coordinated progression identity/copy decision. | Imports default to copy/remapped IDs; replace is explicit, confirmed, transactional, and cannot leave stale progression. | Phases 5–6 — core-logic-engineer; qa-engineer verifies collision and rollback cases. |
| Template metadata can contain attachment information that import later discards. | `exportSubjectAsTemplate` emits attachment metadata, while `createSubjectFromTemplate` constructs new rooms with `attachments: []`. | Blank templates contain only approved graph metadata and never imply preserved private attachment data; import behavior is explicit and lossless for the template contract. | Phase 7 — core-logic-engineer; qa-engineer verifies privacy and round trips. |
| A valid note can be resubmitted and award room-clear progression again. | `NoteEditorModal.handleSubmit` calls `awardRoomClear` after any `submitNote` result with `finalPass`; current state does not provide a durable one-time submission key for that path. | Room-clear rewards are idempotent per room/clear generation and cannot be duplicated by retries, StrictMode, or resubmission. | Phases 14–15 — core-logic-engineer + ui-engineer; qa-engineer verifies duplicate/StrictMode cases. |
| Review unlock rules are displayed but not consistently enforced. | RoomPanel displays unlock progress, while phase switching and some room interactions are available independently of a single authoritative unlock gate. | Archaeologist access and eligible review actions use one server-independent domain rule, with clear locked/unlocked states. | Phase 16 — core-logic-engineer + ui-engineer; qa-engineer verifies all entry points. |
| Interrupted review state can be lost on exit. | Review accounting is finalized in `closeInfoPanel`; leaving through other transitions does not provide a durable in-progress review record. | Review state is persisted/resumable and finalized exactly once, including reload, exit, and retry. | Phase 16 — core-logic-engineer; qa-engineer verifies interruption/reload. |
| Subject mastery and review streak metrics are inaccurate. | Review analytics is called with hard-coded zero current/longest streak values, and progression counters are not a single authoritative derivation. | Mastery, retention, and streak metrics derive from idempotent review events and survive restoration. | Phases 16/18 — core-logic-engineer; qa-engineer verifies dates and restoration. |
| Privacy documentation conflicts with web image uploads. | Welcome copy says data never leaves the device, while the web NoteEditor upload path can call the legacy `/api/upload` endpoint. | The redesigned web path stores attachment bytes locally, makes no automatic upload, and describes external-only URLs honestly. | Phase 4 — core-logic-engineer + ui-engineer + infrastructure-engineer; qa-engineer runs network-spy/privacy checks. |
| The current typecheck command does not explicitly check all project references. | `npm run typecheck` runs the root `tsc --noEmit` command; the project has additional app/Node/Electron reference configurations without a dedicated common gate here. | The release gate intentionally checks application, Node, and Electron projects and records any deliberate exclusions. | Phase 1 — infrastructure-engineer; qa-engineer verifies the corrected command. |
| The current test setup mocks Phaser and cannot validate real world behavior. | `vitest.setup.ts` replaces Phaser with a mock and canvas context stub; jsdom tests do not exercise a real renderer. | Browser tests exercise actual Pixi/legacy world behavior, with DOM alternatives, device profiles, accessibility, privacy, performance, and memory evidence. | Phases 1/9/21/22 — qa-engineer with game-engineer and infrastructure-engineer. |

## 6. Phase 0 exit-criteria review

| Exit criterion | Evidence in this change | Status |
| --- | --- | --- |
| Existing tests pass | `npm test` passes: 34 test files, 254 tests. Focused characterization command passes: 2 files, 20 tests. `npm run lint` and `npm run typecheck` also pass. | Pass |
| Fixtures reproduce current import behavior | Subject `1.0.0`/`1.1.0`, parseable-invalid raw-loader, invalid, migration-default, and progression v1/v2/v3 fixtures are exercised by deterministic Vitest tests. | Covered by focused tests |
| Golden flow is explicit and reviewable | Section 1 provides route, phase, action, expected result, and existing coverage for Welcome → Village → Creator → Scribe → Archaeologist → Village. | Covered |
| No production code/dependency changes | The overall Phase 0 deliverable is documentation/tests only. The companion README/ADR changes describe the baseline and do not alter application source, dependencies, or build configuration. | Pass |

The authoritative plan controls the Phase 0 status. After the recorded gates,
the orchestrator set Phase 0 to `verified`; this evidence artifact does not
constitute maintainer acceptance. Phase 1 remains locked until acceptance.

## 7. Known limitations and handoff

- The characterization tests run in Vitest/jsdom. They do not validate actual
  Phaser or future Pixi rendering, browser input, touch, screen readers, focus,
  zoom, reduced motion, frame time, memory, or offline behavior.
- The minimal subject fixtures intentionally exploit the current shallow import
  boundary. Acceptance by `importSubjectFromJson` is not proof of a valid
  renderable domain snapshot.
- Raw `loadSubjectSnapshot` does not migrate `1.0.0`; only
  `importSubjectFromJson` invokes the current `migrateToV11` path. A parseable
  but structurally invalid subject payload is returned unchanged by the raw
  loader without quarantine, while the file importer rejects the same payload.
  Current migration also drops top-level legacy envelope fields, and current
  progression normalization drops unknown fields.
- No storage-v2 generation, atomic migration receipt, rollback, `.kdbak`,
  `.kdsubject`, `.kdtemplate`, attachment-byte archive, privacy network test,
  or later-phase implementation is present in this test/fixture change.
- The profile build check is expected to fail its raw ceiling when source maps
  are counted; use the production build for the release baseline.
- Before acceptance, the owning specialist should review the known-defect table
  and decide whether any current behavior needs a documented exception. QA
  blocks advancement if a required gate fails.
