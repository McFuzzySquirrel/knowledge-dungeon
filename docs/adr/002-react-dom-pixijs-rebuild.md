# ADR 002: React DOM + PixiJS 8 Rebuild with Temporary Phaser Fallback

**Status:** Accepted
**Date:** 2026-09-24
**Author:** AI-assisted development
**Tags:** architecture, renderer, react, pixijs, phaser, storage-v2, privacy, accessibility, release

---

## Context

Knowledge Dungeon currently uses React for the application shell and Phaser 3 for the
village, dungeon, and fishing worlds. The current screen model is a stateful
Welcome → Village → Game flow, with React panels, dialogs, maps, and learning
workspaces surrounding Phaser scenes. Web persistence is local-first in intent but
still includes legacy localStorage and Electron compatibility paths, and the
current image-attachment flow can use the legacy Express upload endpoint.

The rebuild plan preserves the learning model and the main subject flow while
replacing the presentation and world-renderer architecture. The migration must be
incremental: existing Phaser behavior and data remain available while renderer-
neutral contracts, storage-v2, accessibility coverage, and release gates are built.

This ADR records the locked target decisions. It is an architecture decision, not a
claim that the rebuild phases, renderer cutover, migration, or Phaser removal are
complete. Phase 0 is limited to documentation, characterization tests, and
synthetic fixtures.

## Decision

Adopt React DOM as the application and accessible-interface layer, PixiJS 8 as the
eventual world renderer, and Phaser 3 as a temporary migration fallback. The
fallback is selected by a safe legacy default until the Pixi implementation has
passed parity, cutover, and soak gates. Phaser is removed only after the release
soak described in the rebuild plan; it is not a permanent second renderer.

## Decision 1: React DOM and PixiJS 8 responsibility split

**React DOM owns:**

- Application navigation, onboarding, HUDs, forms, dialogs, and contextual panels.
- Educational and instructional text, Markdown editing and preview, settings, and
  data-management views.
- Minimaps, full maps, statistics, share-card previews, and accessible controls.
- Keyboard and screen-reader alternatives for every world action.
- Contextual nearby-action controls and the complete learning flow.

**PixiJS 8 owns:**

- Rendering of the village, dungeon, and fishing worlds.
- Camera behavior, navigation visuals, renderer-local animation, and ambient effects.
- Characters, structures, water, weather, lighting, and visual interaction feedback.

Educational text and complex inputs must not exist exclusively inside a canvas or
Pixi display object. PixiJS AccessibilitySystem may enhance the experience, but
it is not the only route to a core action. Every world interaction must have a
DOM-equivalent control, including keyboard, touch, and screen-reader paths.

PixiJS and world asset bundles are lazy-loaded. The Welcome route must not eagerly
load a world renderer. The current Phaser implementation remains the temporary
fallback while the new host is introduced.

## Decision 2: Renderer-neutral application boundary

The rebuild introduces renderer-neutral contracts for:

- **World models:** rooms, corridors, floors, structures, NPCs, player state, and
  renderer-independent interaction state.
- **World events:** room entry, interaction, floor transitions, NPC proximity,
  artifact pickup, and other application-observable changes.
- **World commands:** teleport, floor visibility, focus, room-state updates, and
  interaction requests.
- **Renderer lifecycle:** initialize, resize, focus, pause, resume, and destroy.

Phaser and PixiJS are adapters around these contracts. They translate renderer
input and visual state into application events and execute application commands;
they do not own subject activation, graph mutation, note validation, progression,
review scheduling, or backup policy.

Neither `src/core/` nor renderer-neutral application modules may import Phaser or
PixiJS. Renderer imports must be isolated to adapter and host layers. The existing
canonical subject-activation flow remains the activation path, and deterministic
domain rules remain unchanged unless a later phase explicitly accepts a behavior
change.

## Decision 3: Storage-v2, migration, and rollback direction

The target web application uses IndexedDB with an `activeGeneration` pointer.
The repository is designed around complete, validated generations rather than
mutating the active legacy state in place. The intended stores include `meta`,
`subjects`, `progression`, `sessions`, `preferences`, `shortcuts`, `assistance`,
`attachments`, `customSprites`, `recovery`, and `migrationReceipts`.

Subject schema `1.0.0` and `1.1.0`, and progression versions 1, 2, and 3, are
compatibility inputs. Product-format versions, storage generations, and subject
schema versions remain separate concepts.

A migration or restore follows this order:

1. Read and validate the source without changing it.
2. Write a complete new generation.
3. Compare record counts, relationships, and checksums.
4. Write a migration receipt.
5. Flip `activeGeneration` only after validation succeeds.
6. Retain the previous generation for rollback.
7. Mirror writes to legacy storage while the Phaser fallback remains available.

The migration must preserve unknown app-owned fields and raw recovery records.
Available attachment bytes move into IndexedDB. Historical server-hosted
attachments whose bytes cannot be recovered are reported as external-only; external
URLs are not silently downloaded. Failed imports or migrations never replace the
active generation.

The intended data products are lossless full-device backups (`.kdbak`), individual
subject backups (`.kdsubject`), and graph-only blank templates (`.kdtemplate`).
Backups include authoritative progression and available attachment bytes. Subject
copy imports remap identifiers by default; replacement is explicit and
confirmed. Templates exclude notes, drafts, artifacts, progression, review state,
assistance history, original IDs, attachments, filenames, and private metadata.

Rollback is data-preserving. A storage failure leaves the legacy generation active;
a release can select the legacy repository and retain staged generations and mirror
writes for diagnosis. Legacy data is not automatically deleted.

## Decision 4: Privacy and local-first constraints

The redesigned web flow is local-first. Learner content, notes, progression,
statistics, preferences, assistance state, and web image attachments remain on the
device, primarily in IndexedDB. The rebuilt application adds no gameplay server,
cloud accounts, cloud synchronization, public profiles, analytics, telemetry,
remote configuration, or production usage profiling.

The redesigned web flow does not upload learner data or image attachments to
`/api/upload`. A legacy upload path or Electron bridge may remain only where
compatibility requires it; neither may become a dependency of the redesigned web
flow. External URLs remain user-provided external content and are disclosed when
their bytes are unavailable.

Local downloads and Web Share require an explicit user action. Share cards offer a
local PNG download by default, use Web Share only after `navigator.canShare`
confirms file support, and exclude notes, internal identifiers, room lists, and
assistance history by default.
A service worker may cache a versioned static application shell and static assets
only; it must never cache subjects, notes, attachments, progression, statistics,
preferences, assistance, or other learner data.

Electron source and bridge compatibility may remain during migration, but Electron
packaging, signing, and installers are not prerequisites for the web release.

## Decision 5: CC0 media policy

Every newly added image, animation frame, sound effect, music track, and font must
be verified as CC0 1.0. Each approved asset record includes:

- Stable asset ID and path.
- Creator or source and source URL where applicable.
- Exact `CC0-1.0` license identifier and license URL (the CC0 1.0 deed at
  `https://creativecommons.org/publicdomain/zero/1.0/`).
- Retrieval or creation date.
- SHA-256 checksum.
- Modification record.

Legacy assets that have not been verified may remain available to the temporary
Phaser renderer, but they must not enter the default PixiJS bundle. New Pixi asset
bundles are lazy-loaded and explicitly unloaded when no longer needed. If no CC0
font is selected, the application uses a system font stack. Remote Google Fonts
are not a production dependency.

## Decision 6: Typed feature flags and cutover

The planned build-time flags are:

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

The flags must be typed, have documented owners and safe legacy defaults, and
both legacy and new configurations must compile. Before cutover, production keeps
Phaser and legacy storage as defaults; Pixi paths run in CI and internal builds;
storage-v2 is staged and mirrored; and new data products and assistance remain
opt-in.

At cutover, Pixi, storage-v2, Cozy visuals, data products, Gentle assistance, and
supported Web Share become defaults. Phaser and legacy storage remain selectable
for one release cycle, with the previous generation and mirror data recoverable.
Removal of Phaser requires a successful seven-day soak and one release cycle. The
renderer and storage flags are not removed until that gate is met.

The immediate rollback controls are `VITE_WORLD_RENDERER=phaser` and
`VITE_STORAGE_REPOSITORY=legacy`, with per-world Pixi flags disabled as needed.
Rollback must not delete migrated or legacy data.

## Decision 7: Accessibility, performance, and release targets

Accessibility is a release requirement, not a renderer enhancement:

- Target WCAG 2.2 AA.
- Complete keyboard operation of the core flow.
- A DOM equivalent for every Pixi interaction.
- Touch targets of at least 44 by 44 CSS pixels.
- No hover-only actions and no color-only state communication.
- Text contrast of at least 4.5:1 and non-text contrast of at least 3:1.
- Visible focus indicators and dialog focus trapping, initial focus, Escape
  handling, and focus restoration.
- `prefers-reduced-motion` support in both React and Pixi.
- Core operation at 200% zoom and a 320 CSS-pixel viewport.

The initial performance targets are:

- Welcome initial JavaScript and CSS: at most 300 KB gzip, excluding lazy
  renderer bundles.
- Any lazy JavaScript chunk: at most 800 KB gzip.
- Total raw `dist`: retain the current 12 MB ceiling unless measured evidence
  justifies a change.
- A 100-room dungeon: target 60 FPS with p95 frame time below 20 ms on reference
  devices.
- Interaction acknowledgement: under 100 ms.
- No material canvas or GPU memory growth over 20 world mount/unmount cycles.
- No eager Phaser or Pixi load on Welcome.
- Correct Pixi Application and asset-bundle teardown, ticker pause while hidden,
  and lower resolution/antialiasing profiles for constrained devices.

Primary release targets are the static web application on Linux, macOS, and
Windows host environments, with Chromebook/ChromeOS, desktop browsers, and
tablet portrait/landscape touch as separate form-factor targets. Automated
browser-engine evidence covers Chromium, Firefox, and WebKit; Edge and Safari
claims require branded-browser or manual evidence. Emulation is not physical
device or operating-system certification.

The approved staged matrix is machine-readable in
`tests/e2e/support-matrix.ts`, which keeps host operating system, browser
engine, branded-browser channel, form factor, input mode, evidence class, and
allowed CI lane as separate dimensions. `playwright.config.ts` generates its
projects from that matrix, so a project cannot drift from the support contract.
Pull-request lanes cover Linux/Chromium and Firefox, macOS/WebKit, and
Windows/Edge; scheduled release-candidate lanes cover Linux Chromium/Firefox,
macOS Chromium/Firefox/WebKit, and Windows Chromium/Firefox/Edge. Playwright
WebKit is WebKit engine evidence, not Safari certification, and the Edge channel
is branded-browser evidence for the recorded Windows host only.

Every automated lane tests the same production web artifact. Within each
complete CI run, one job builds the artifact, records a deterministic SHA-256 tree
identity, and uploads it; every lane job in that run downloads and verifies that
identity instead of rebuilding, because the current production build is not
guaranteed to be bit-reproducible. One artifact means one artifact per complete
CI run, never one global artifact shared across unrelated workflow runs. Each run
records actual host OS, architecture, browser engine/channel/version, viewport,
device scale factor, input mode, renderer mode, artifact identity, and whether the
lane ran on CI or a local host, using synthetic fixtures only. A lane never reports
passing evidence on a host it is not approved for, and an unavailable browser build
on an approved host is a lane failure. Physical-device checks (Chromebook with
ChromeVox, macOS Safari, a touch-platform screen reader, a Windows desktop
browser, and a Linux desktop browser) remain manual gates for the later
accessibility, performance, and cutover phases.

Electron installers are deferred and are not a web release gate. The approved
staged OS/browser matrix, the production web artifact, and physical-device
checks are required by the plan before cutover. Release evidence also includes
lint, typecheck, unit tests, web build, bundle checks, and the phase-specific
browser, privacy, license, migration, accessibility, performance, and memory
checks defined by the plan.

## Phase 3 archive dependency selection

This section records the Phase 3 library selections. It does not change Decisions
1 through 7. The archive library is the `.kdbak` and `.kdsubject` ZIP container
required by plan section 7.3; the IndexedDB shim is a test-only dependency.

### Archive library: `fflate` (runtime dependency)

- **Package and version:** `fflate` `0.8.3`, declared as `^0.8.3`.
- **License:** `MIT` (SPDX `MIT`), in `node_modules/fflate/LICENSE`.
  License URL: <https://github.com/101arrowz/fflate/blob/master/LICENSE>.
- **Dependencies:** none. `package-lock.json` records no transitive packages for
  it.
- **Size, measured locally** with the repository's own bundler (`rolldown` 1.0.2,
  `--format esm --minify`) against a stub importing only `zipSync` and `unzipSync`
  from `fflate/browser`: **12,393 bytes raw and 6,035 bytes gzip**. The upstream
  upper bound for the whole library is about 33 kB (about 12.5 kB gzip), so
  tree-shaking removes roughly two thirds of that. The published "~8 kB" claim is
  not the measured number here, so the measurement is recorded instead.
- **Maintenance signal:** latest release 0.8.3 published 2026-07-20; repository
  `101arrowz/fflate`; about 262 million npm downloads in the month before this
  record. It is the default DEFLATE implementation in several large toolchains.
- **Why it was selected:** it is the only candidate that satisfies every hard
  requirement. It is stream-optional: `zipSync` and `unzipSync` take and return
  `Uint8Array`, which is exactly the shape `.kdbak` and `.kdsubject` need for a
  handful of small JSON documents and attachment blobs, with no `ReadableStream`,
  `Response`, or `Blob` plumbing. It is pure JavaScript: a scan of the `esm`,
  `umd`, and `lib` builds found no `eval`, no `new Function`, no WebAssembly, and
  no `fetch`, so it introduces no CSP problem and no network call at import or run
  time. It declares `sideEffects: false` and ships an `exports` map with
  `browser` and `node` conditions, so the web build and the Vitest run resolve
  deliberately instead of falling back to a Node built-in.
- **Verified before selection:** a synchronous round trip of `manifest.json`,
  `subject.json`, and an `attachments/blob.bin` `Uint8Array` produced byte-identical
  JSON and binary output, and the same round trip plus a versioned IndexedDB open,
  write, and read passed under this repository's own Vitest and `jsdom`
  configuration.

### Rejected alternatives

- **`jszip` `3.10.2` (MIT OR GPL-3.0-or-later), rejected.** The dual-license
  identifier is not the single clean permissive identifier this record requires,
  and it drags in four runtime dependencies: `lie`, `pako`, `readable-stream`
  (a 2.3.x polyfill from 2016), and `setimmediate`. Its browser bundle measured
  97,303 bytes raw and 28,688 bytes gzip, roughly eight times the tree-shaken
  `fflate` cost for a library with far more capability than Phase 3 needs. Decisive
  finding: the shipped `dist/jszip.min.js` contains `new Function`, from the
  bundled `setimmediate` string-callback shim, which fails the no-`new Function`
  requirement and is a CSP liability. Rejected.
- **`client-zip` `2.5.1` (MIT), rejected on function, not size.** It is genuinely
  tiny, 6,370 bytes raw and 2,652 bytes gzip, dependency-free, and maintained
  (published 2026-09-14, about 1.4 million monthly downloads), but it exports only
  `downloadZip`, `makeZip`, and `predictLength`, and its README states it "does
  *not* compress the files or unzip existing archives." It is write-only and
  stream-only, returning a `Response` or a `ReadableStream`. Phase 3 needs to
  *read* a `.kdbak` the learner picks from a local file, so `client-zip` would
  require a second dependency for reading, or hand-rolled parsing, both of which the
  plan forbids. It also cannot compress, so archives would be store-only, and its
  ZIP64 output is documented as not readable by every ZIP reader. Rejected.

### Known limitations of the selection

- `fflate` is `0.x`. Caret pinning means a future `0.9.x` may change the API, so a
  lockfile update must be reviewed rather than taken automatically.
- Only the synchronous `zipSync` and `unzipSync` surface is selected. Streaming
  compression is deliberately not used: Phase 3 archives are bounded local products,
  and a blocking synchronous call on a very large attachment is the accepted cost.
- `fflate` does not define an archive *format*. The `.kdbak` and `.kdsubject`
  member layout, the `manifest.json` schema, the import semantics, and the
  identifier remapping rules remain this application's responsibility and are
  versioned separately from the library.
- `fflate` does not defend against a hostile archive on its own. Zip-slip member
  names, decompression-ratio limits, member-count limits, and total-bytes limits
  must be enforced in the storage-v2 archive reader before any member is written.
- Entry-point selection matters. The bare specifier resolves to `fflate`'s Node
  entry under Vitest and to the browser entry in the web build, because the Node
  ESM entry imports `node:module`. `fflate/browser` resolves to the browser build
  in both environments and was verified to work in Node. Storage-v2 code under
  `src/` should import the explicit subpath so the unit tests and the shipped
  bundle exercise the same code.

### IndexedDB test shim: `fake-indexeddb` (devDependency)

- **Package and version:** `fake-indexeddb` `6.2.5`, declared as `^6.2.5`.
- **License:** `Apache-2.0` (SPDX `Apache-2.0`). License URL:
  <https://github.com/dolanmiu/fake-indexeddb/blob/master/LICENSE>.
- **Dependencies:** none. It is a test-only shim and is never bundled.
- **Maintenance signal:** latest release 6.2.5 published 2025-11-07; repository
  `dolanmiu/fake-indexeddb`; about 22 million npm downloads in the month before this
  record. Lower release cadence than the archive library, which is expected for a
  spec-conformance shim; it is a mature and widely used reference implementation of
  the IndexedDB API for test environments.
- **Why it is needed:** the `jsdom` environment used by this repository implements
  no IndexedDB, so storage-v2 repository and migration tests cannot run without an
  in-memory implementation. The shim stays in `devDependencies` and must be
  installed by test setup only; it must not be reachable from the application
  graph.

### Recorded measurement and scope notes

- The new dependencies add no production bundle weight at this phase. Nothing
  imports them yet, and they appear in no `dist` chunk. The build remained at 105
  files and 4,107,377 bytes, matching the Phase 1 baseline exactly. When Phase 3
  archive code first imports `fflate`, the expected cost is the tree-shaken
  measurement recorded above, not the whole-library figure.
- `npm audit` reported the same 24 advisories before and after the change. All
  are in pre-existing packages such as `electron`, `electron-builder`, `vite`,
  `vitest`, `multer`, and `tar`. Neither new package is named in the audit output,
  and `npm audit fix` was deliberately not run.
- `package.json` gained exactly one script, `test:migrations`, wired to
  `vitest run tests/migrations`. No existing script or dependency was altered, and
  no production default changed: Phaser and legacy storage remain the defaults.

## Consequences

### Positive

- The learning model and deterministic domain rules can remain stable while the
  presentation is replaced.
- React DOM gives educational content, forms, dialogs, and accessibility a clear
  non-canvas home.
- Renderer-neutral contracts make Phaser-to-Pixi parity and rollback testable.
- Generation-based storage and retained mirrors make failed migrations recoverable.
- Local-first storage and explicit sharing preserve user control without adding a
  learner-data backend.
- Typed flags and lazy bundles allow measured, reversible cutover.
- A staged OS/browser matrix makes Linux, macOS, Windows, Chromebook, and tablet support explicit without coupling web acceptance to native packaging.

### Negative and risks

- The temporary dual-renderer period increases test and maintenance surface.
- A complete migration, backup, and asset registry takes time and can expose
  existing data-quality defects before they are fixed.
- DOM mirrors, keyboard navigation, touch handling, and screen-reader verification
  must be designed alongside Pixi rather than added after rendering.
- Source-map-inclusive profile artifacts can exceed raw bundle checks; the
  production and profile measurements must remain distinguishable.
- Legacy upload behavior and privacy copy can conflict until the redesigned web
  path is cut over and verified.
- Browser, operating-system, GPU, file-picker, storage, and Web Share differences
  can surface only after the first Linux/Chromium smoke baseline.

### Mitigations

- Keep Phaser and legacy storage behind safe defaults and explicit rollback flags.
- Use staged generations, checksums, migration receipts, and retained mirrors.
- Enforce renderer import boundaries, contract tests, DOM action mirrors, CC0
  registry checks, and no-learner-data cache inspection.
- Require fresh, migrated, offline, and rollback profiles to pass before cutover.
- Use representative OS/browser CI lanes on pull requests, the full approved matrix before cutover, and physical-device checks for browser, touch, and screen-reader claims.
- Treat Electron packaging as compatibility work rather than a web release gate.

## Non-goals

The rebuild does not include:

- A gameplay server.
- Cloud accounts, cloud sync, or remotely synchronized NPCs.
- Public profiles, public share URLs, multiplayer, chat, or classroom collaboration.
- LLM-generated answers, cloud learner profiling, analytics, telemetry, or remote
  configuration.
- A PixiJS note editor, data-management interface, or canvas-only core action.
- Proprietary or non-CC0 media.
- A large ECS framework or secondary game engine unless measured requirements make
  one necessary.
- Electron packaging, signing, or installer work as a prerequisite for the web
  release.
- Automatic deletion of legacy learner data.

## Implementation status

This ADR establishes the target architecture and guardrails. Phase 0 records
the current behavior, compatibility expectations, and build baseline in
documentation, characterization tests, and synthetic fixtures. Phase 1 was
verified and accepted on 2026-09-25 and added typed feature-flag contracts,
Linux/Chromium Playwright coverage, axe and privacy-network scaffolding,
intentional application/Node/Electron typechecking, CI jobs, and build metadata
recording. Phase 1A has implemented the staged cross-platform web compatibility
rails described above. Its representative PR lanes and complete eight-cell
release-candidate matrix pass on their declared hosts against one recorded
artifact per CI run. The maintainer accepted the verified checkpoint on
2026-09-25, so its status in the authoritative plan is `complete`.

The rebuild still does not implement renderer-neutral contracts, storage-v2,
migrations, CC0 tooling, the full accessibility and responsive audit, PixiJS,
performance/memory/offline hardening, production cutover, or Phaser removal. The
automated macOS, Windows, and Edge lanes are runner evidence, while the
physical-device, Safari, touch-platform, and screen-reader gates remain manual
later work. Those later gates must not be treated as complete based on this ADR.

## Related Documents

- `docs/plans/001-cozy-pixi-rebuild.md` - authoritative phased rebuild plan.
- `docs/adr/001-village-hub-and-visual-overhaul.md` - earlier village and Phaser
  visual decisions superseded by this renderer decision after acceptance.
- `README.md` - dated Phase 0 baseline, current route/control contract, build
  measurements, and the actual QA handoff/artifact inventory.
- `tests/contracts/phase-0-baseline.md` - dated Phase 0 baseline covering the
  golden-path matrix, route/control and app-owned localStorage inventories,
  build measurements, known defects, and verification evidence.
- `tests/contracts/phase-0-subject-characterization.test.ts` and
  `tests/contracts/phase-0-progression-characterization.test.ts` - current
  subject importer/raw-loader and localStorage progression hydration behavior
  for the versioned and malformed Phase 0 inputs.
- `tests/fixtures/persistence/README.md` and the synthetic `subject/` and
  `progression/` fixture sets - learner-free subject schema `1.0.0`/`1.1.0` and
  progression version 1/2/3 compatibility inputs, including invalid cases.
- `tests/e2e/support-matrix.ts` - the machine-readable web support matrix
  (host, engine, channel, form factor, input mode, evidence class, allowed CI
  lane) and the pending physical-device gates.
- `tests/e2e/currentBuild.spec.ts` and `tests/e2e/compatibility.spec.ts` - the
  separate Phase 1 current-build suite and Phase 1A cross-engine suite.
- `.github/workflows/ci.yml` - the Phase 1 current-build viewport suite plus the
  staged pull-request compatibility lanes; its `web-build` job is the single
  build, record, and upload point for both suites in a pull-request run.
- `.github/workflows/compatibility.yml` - the scheduled and manual
  release-candidate compatibility lanes only; it has no pull-request trigger, so a
  pull-request run never builds a second artifact.
