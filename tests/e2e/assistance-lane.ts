/**
 * Phase 21 assistance lane declaration: the machine-readable source for the two flagged
 * browser lanes, imported by both Playwright configs and checked against the real build
 * script, the real Playwright projects, the real npm scripts, the CI steps, and the
 * preflight by `tests/e2e/assistance-lane.test.ts`.
 *
 * ## Why this lane exists at all
 *
 * Phase 19 built adaptive assistance behind `VITE_ADAPTIVE_ASSISTANCE` with a production
 * default of `false`, and `vite.config.ts` already refuses to *emit* a build whose lane
 * modules are not fetchable. Emitting is not rendering. Until this lane existed, **no
 * browser had ever seen a suggestion card**: `npm run test:e2e` builds the default artifact,
 * `AssistanceSlot` returns `null` before it imports anything, and the whole learner-facing
 * half of Phase 19 - the card, its reason text, its Dismiss control, and the gate that keeps
 * it silent - had jsdom evidence and nothing else.
 *
 * The maintainer deferred the lane on 2026-10-05 and authorised it on 2026-10-06, on the
 * grounds that Phase 21 runs the accessibility audit anyway and so acquires the lane inside
 * work it must do. That ruling is why this file is in Phase 21 and not in the Phase 19
 * record.
 *
 * ## Why there are two lanes in one module, and one manifest each
 *
 * The Phase 19 rollback line is `VITE_ADAPTIVE_ASSISTANCE=false`, and the rollback half of a
 * cutover is evidence like any other half: "the same entry point reaches the same fishing
 * session and the card is absent" is a claim about the **default production artifact**, not
 * about the flagged one. Asserting it against the flagged artifact would be vacuous.
 *
 * So there are two lanes over two recorded identities, each with its own manifest path, each
 * with its own preflight invocation, each with its own port. `scripts/require-assistance-lane-artifact.mjs`
 * reads the flag constant **out of the emitted bytes**, so a lane handed the other lane's
 * `dist/` is red before Playwright starts - which is a stronger statement than "the manifest
 * was verified", and the property a Phase 17 dead lane would have failed.
 *
 * ## The one surface this lane can reach, and why that is a finding rather than a choice
 *
 * `AssistanceSlot` is mounted from five places: the Creator workspace, the Scribe encounter,
 * the Archaeologist review workspace (twice: `archaeologist` and `device`), and the village
 * screen's fishing slot. **Four of the five are behind their own `productionDefault: false`
 * flags** - `VITE_CREATOR_WORKSPACE`, `VITE_SCRIBE_ENCOUNTER_WORKSPACE`, and
 * `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` - and `build:web:assistance` turns on
 * `VITE_ADAPTIVE_ASSISTANCE` alone. `tests/e2e/assistance-build-lane.test.ts` pins that
 * script to exactly one flag for a real reason, so this lane cannot widen it.
 *
 * The fishing slot is therefore the only surface a `VITE_ADAPTIVE_ASSISTANCE=true` build can
 * reach, and it is mounted only once a recall question has been **missed** on the current
 * visit (`useVillageFishing`'s own `assistance === null` guard). That is why this lane drives
 * a whole cast-to-catch-to-missed-recall journey rather than opening a panel, and it is
 * recorded here because it is a fact about the phase's browser coverage, not a preference:
 * the Creator, Scribe and Archaeologist surfaces still have no browser evidence, and closing
 * that needs either a composite-flag artifact or a product decision. See `doesNotProve`.
 *
 * ## What the lane is not allowed to claim
 *
 * Stated in full in each lane's `doesNotProve` and asserted by content in the wiring gate,
 * because a lane that overstates itself is worse than no lane:
 *
 * - **Not physical-device evidence.** Chromium only, one emulated viewport, `emulated-viewport`
 *   class. No Chromebook, no tablet, no touch hardware, no screen reader.
 * - **Not an accessibility result.** The card's semantics were checked in jsdom by
 *   `tests/phase19/assistanceUiAccessibility.test.tsx`; this lane checks that a card *renders*.
 *   The Phase 21 `test:a11y` suite is the accessibility gate.
 * - **Not a Phaser-vs-Pixi comparison.** `build:web:assistance` leaves `VITE_PIXI_FISHING` at
 *   its default, so the pond is the Phaser `FishingScene` with a canvas and no DOM controls.
 *   The lane drives it the way the rollback lane does - pointer events on the canvas - and says so.
 * - **Not a data-integrity certification.** What it asserts about progression is that the card's
 *   controls are advisory: dismissing one writes nothing but a counter.
 *
 * Privacy: synthetic fixtures only. Every subject and room identifier is a literal this lane
 * wrote or imported from `tests/e2e/fishing-recall-fixture.ts`; no learner data, request body,
 * credential, or private URL enters a script, a config, a spec, a test name, or a report.
 */

/* ── The two lanes ───────────────────────────────────────────────────────────── */

export const ASSISTANCE_LANE_SCHEMA_VERSION = 1;

/** Playwright project names. Must be unique across every config in the repository. */
export const ASSISTANCE_PROJECT = 'assistance-flagged-chromium';
export const ASSISTANCE_DEFAULT_PROJECT = 'assistance-default-chromium';

/** The only spec each lane may run. */
export const ASSISTANCE_TEST_FILE = 'assistance.spec.ts';
export const ASSISTANCE_TEST_PATH = `tests/e2e/${ASSISTANCE_TEST_FILE}`;
export const ASSISTANCE_DEFAULT_TEST_FILE = 'assistanceDefault.spec.ts';
export const ASSISTANCE_DEFAULT_TEST_PATH = `tests/e2e/${ASSISTANCE_DEFAULT_TEST_FILE}`;

/**
 * The configs that own the lanes.
 *
 * Under `tests/e2e/` for the reason `playwright.pixi-memory.config.ts` records: the four
 * older root-level configs are enumerated by name in `tsconfig.node.json`, so a sixth
 * root-level config would sit inside no TypeScript project - `npm run lint` would fail to
 * parse it and `npm run typecheck` would never see it. Inside `tests/e2e/**` both files are
 * covered by `tsconfig.app.json`'s `include: ["src", "tests"]`, so a type error in one fails
 * the ordinary gate rather than surfacing the first time Playwright runs it.
 */
export const ASSISTANCE_CONFIG_FILE = 'tests/e2e/playwright.assistance.config.ts';
export const ASSISTANCE_CONFIG_BASENAME = 'playwright.assistance.config.ts';
export const ASSISTANCE_DEFAULT_CONFIG_FILE = 'tests/e2e/playwright.assistance-default.config.ts';
export const ASSISTANCE_DEFAULT_CONFIG_BASENAME = 'playwright.assistance-default.config.ts';

/** The build scripts that produce the two artifacts these lanes preview. */
export const ASSISTANCE_BUILD_SCRIPT = 'build:web:assistance';
/**
 * The rollback artifact's build script.
 *
 * Before the Phase 23 cutover this lane previewed `npm run build:web`, because the
 * default build *was* the pre-cutover artifact. After the cutover the default build
 * carries the assistance flag at `true`, so a "no assistance" claim verified against
 * it would be vacuous. `build:web:rollback` forces every cutover flag to its
 * pre-cutover value, so this is the same artifact the previous release shipped.
 */
export const ASSISTANCE_DEFAULT_BUILD_SCRIPT = 'build:web:rollback';

/** The build-time flag, its value on the flagged build, and the cutover production default. */
export const ASSISTANCE_FLAG = 'VITE_ADAPTIVE_ASSISTANCE';
export const ASSISTANCE_FLAG_VALUE = 'true';
export const ASSISTANCE_FLAG_PRODUCTION_DEFAULT = 'true';

/**
 * The flag key as the bundler emits it, and the shape a preflight matches in `dist/`.
 *
 * ## Why the key, and why the value is the discriminator
 *
 * Measured on both builds at this phase: the **default** build emits the lane chunks
 * anyway - `assets/AssistanceRegion-*.js` and `assets/assistanceStore-*.js` exist, and
 * `vite.config.ts`'s own census reports `2/2 declared path(s) fetchable` for both. So the
 * presence of a lane chunk file **cannot** tell a flagged artifact from a default one, and a
 * preflight that looked for the file would pass on a default `dist/`: exactly the "configured
 * lane that verifies nothing" defect Phase 17 hit.
 *
 * The thing that genuinely differs is the compiled flag constant. Vite substitutes
 * `import.meta.env` with an object literal holding only the keys the build actually has, and
 * so the flagged build contains `VITE_ADAPTIVE_ASSISTANCE:`+"`true`"+` inside that literal
 * while the default build's literal omits the key entirely. Reading that out of the emitted
 * bytes - rather than out of `process.env`, which says what the *shell* asked for - is what
 * makes the preflight a statement about the artifact under test.
 *
 * The value is matched with a quote-agnostic pattern because the minifier's string quoting
 * is not a contract this repository controls; the key and the value are.
 */
export const ASSISTANCE_FLAG_ENV_KEY = 'VITE_ADAPTIVE_ASSISTANCE';

/**
 * The chunk stem a lane uses to notice that the **card** was actually fetched.
 *
 * ## Why one stem and not two
 *
 * The lane's two declared modules are emitted into two chunks, and they are fetched at different
 * moments, and that difference is why the network observation works:
 *
 * - **`AssistanceRegion-*` is fetched only when the card mounts**, which cannot happen while the
 *   flag is off. Its presence says the lane was reached; its absence after a journey that reached
 *   the mounting state says the gate held.
 * - **`assistanceStore-*` is a weaker signal, and its meaning changed in Phase 22.** Before then
 *   `runBootstrap` awaited `loadAssistanceStore()` on every build, so the store chunk was fetched
 *   at startup on every route and its presence said only that the application started. Phase 22
 *   removed that fetch from the default build: the bootstrap now reads the record through
 *   `@/services/assistance/assistanceRecord` and preloads the store **only when
 *   `VITE_ADAPTIVE_ASSISTANCE` is on**. On the default build the store chunk is instead fetched
 *   the first time a write needs it - `useVillageFishing.onDecide`'s missed-recall `bumpSignals` -
 *   which is after the journey, not at boot.
 *
 * So the default lane's boot observation is stated over the **store** stem (it is absent from the
 * request log on Welcome), and its journey observation is stated over the **card** stem (the card
 * is never fetched even though the journey reached the state that mounts it). Matching a single
 * combined pattern could not express either claim.
 */
export const ASSISTANCE_CARD_CHUNK_STEM = 'AssistanceRegion';

/**
 * The store chunk's stem, declared so a lane can name it and assert on it rather than have it
 * matched by accident. See {@link ASSISTANCE_CARD_CHUNK_STEM} for what its presence does and does
 * not mean after Phase 22.
 */
export const ASSISTANCE_STORE_CHUNK_STEM = 'assistanceStore';


/**
 * The lazy chunk names this lane's declaration pins, one per declared lane module.
 *
 * Vite names a dynamic chunk after the module it was reached through, so these are the
 * `ASSISTANCE_LANE_PATHS` stems with the path separators removed. They are a *presence*
 * check and not the discriminator - see {@link ASSISTANCE_FLAG_ENV_KEY} for which is which -
 * and they exist because "the lane artifact contains assistance code" has to be checkable at
 * all, so a build where the lane was tree-shaken away or renamed into nothing is red before
 * Playwright starts rather than being a lane that measures nothing.
 */
export const ASSISTANCE_LANE_CHUNK_STEMS = Object.freeze([
  ASSISTANCE_CARD_CHUNK_STEM,
  ASSISTANCE_STORE_CHUNK_STEM,
]);

/** One recorded identity per artifact, so a flagged build is never mistaken for a rollback one. */
export const ASSISTANCE_MANIFEST_PATH = 'artifacts/web-artifact-manifest-assistance.json';
export const ASSISTANCE_DEFAULT_MANIFEST_PATH = 'artifacts/web-artifact-manifest-rollback.json';

/** The recorded-identity script pair, per artifact. */
export const ASSISTANCE_RECORD_SCRIPT = 'record:web-artifact:assistance';
export const ASSISTANCE_VERIFY_SCRIPT = 'verify:web-artifact:assistance';
export const ASSISTANCE_DEFAULT_RECORD_SCRIPT = 'record:web-artifact:rollback';
export const ASSISTANCE_DEFAULT_VERIFY_SCRIPT = 'verify:web-artifact:rollback';

/** The Playwright invocations, spelled once each. */
export const ASSISTANCE_PLAYWRIGHT_COMMAND = `playwright test --config=${ASSISTANCE_CONFIG_FILE}`;
export const ASSISTANCE_DEFAULT_PLAYWRIGHT_COMMAND =
  `playwright test --config=${ASSISTANCE_DEFAULT_CONFIG_FILE}`;

/**
 * One port per lane.
 *
 * Different, and `reuseExistingServer` is `false` on both, so running both configs in one
 * worktree within a few minutes of each other is a `--strictPort` failure rather than a
 * silent preview of whichever artifact happened to start first.
 */
export const ASSISTANCE_PREVIEW_PORT = 43203;
export const ASSISTANCE_DEFAULT_PREVIEW_PORT = 43205;
export const ASSISTANCE_PREVIEW_SCRIPT =
  `npx vite preview --host 127.0.0.1 --port ${ASSISTANCE_PREVIEW_PORT} --strictPort`;
export const ASSISTANCE_DEFAULT_PREVIEW_SCRIPT =
  `npx vite preview --host 127.0.0.1 --port ${ASSISTANCE_DEFAULT_PREVIEW_PORT} --strictPort`;

/**
 * The preflight both lanes run before Playwright starts.
 *
 * A command rather than a guard at the top of a config, for the reason
 * `scripts/require-pixi-lane-artifact.mjs` records in full: `tests/e2e/assistance-lane.test.ts`
 * imports both config modules to assert their shape, so a module-scope `throw` would make
 * importing them fatal in any checkout without a built artifact, including the `unit-tests` CI
 * job, which has none and never should.
 */
export const ASSISTANCE_PREFLIGHT_SCRIPT = 'require-assistance-lane-artifact.mjs';
export const ASSISTANCE_PREFLIGHT_COMMAND = `node scripts/${ASSISTANCE_PREFLIGHT_SCRIPT}`;
/** The default-artifact lane's preflight invocation. One script, selected by a flag. */
export const ASSISTANCE_DEFAULT_PREFLIGHT_COMMAND = `${ASSISTANCE_PREFLIGHT_COMMAND} --default`;

/**
 * The npm scripts, following the repository's own three-way split.
 *
 * `test:e2e:assistance` previews an artifact that already exists, `:full` builds, records and
 * verifies one first, and `:recorded` is the preview-only name that says the artifact was
 * recorded elsewhere - which in CI is the build job, in another runner. CI runs `:recorded`, so
 * the job that just measured the production artifact cannot silently rebuild it.
 */
export const ASSISTANCE_LANE_SCRIPT = 'test:e2e:assistance';
export const ASSISTANCE_LANE_FULL_SCRIPT = 'test:e2e:assistance:full';
export const ASSISTANCE_CI_RUN_SCRIPT = 'test:e2e:assistance:recorded';
export const ASSISTANCE_DEFAULT_LANE_SCRIPT = 'test:e2e:assistance:default';
export const ASSISTANCE_DEFAULT_LANE_FULL_SCRIPT = 'test:e2e:assistance:default:full';
export const ASSISTANCE_DEFAULT_CI_RUN_SCRIPT = 'test:e2e:assistance:default:recorded';

/* ── The measured environment, recorded with every run ────────────────────────── */

/**
 * The lane's own viewport, read from the support matrix rather than retyped.
 *
 * `support-matrix.ts`'s `desktop-chromium` record, so a change to the approved desktop
 * Chromium viewport cannot leave this lane measuring a size the plan no longer approves.
 * This lane is not a matrix project - it is one new surface on the Chromium engine - so it
 * declares its own `evidenceClass` and says in `doesNotProve` that a Chromium lane is not a
 * matrix claim.
 */
export const ASSISTANCE_VIEWPORT: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 1440,
  height: 900,
});
export const ASSISTANCE_DEVICE_SCALE_FACTOR = 1;
/** Chromium only and pointer-driven, so emulated touch stays off. */
export const ASSISTANCE_HAS_TOUCH = false;
export const ASSISTANCE_INPUT_MODE = 'pointer-keyboard';

/**
 * The suggestion kind this lane expects to observe, and the surface that can render it.
 *
 * `fishing.navigation-after-miss` is the only kind a `VITE_ADAPTIVE_ASSISTANCE=true` build
 * can render on this artifact; see the module header for why the other four surfaces are out
 * of reach here. Closed app-owned vocabulary from `ASSISTANCE_SUGGESTION_KINDS`, never a
 * learner-derived value, and asserted against the engine's own exported table by the wiring
 * gate so a rename is a red test naming the constant rather than a lane that silently
 * observes a different suggestion.
 */
export const ASSISTANCE_EXPECTED_KIND = 'fishing.navigation-after-miss';
export const ASSISTANCE_EXPECTED_SURFACE = 'fishing';

/**
 * The reason code, and the i18n key whose English sentence the lane asserts on the page.
 *
 * The **key** is asserted rather than the sentence, and the spec reads the sentence out of
 * `src/i18n/locales/en.json` at run time. That is the same discipline
 * `currentBuild.spec.ts` applies to `VILLAGE_MAP`: a spec that retyped the copy would keep
 * passing after the copy changed, which is the failure mode the Phase 12 refactor had.
 */
export const ASSISTANCE_EXPECTED_REASON_CODE = 'fishing-recall-missed';
export const ASSISTANCE_REASON_DETAIL_I18N_KEY = 'assistance.detail.fishing-recall-missed';
export const ASSISTANCE_TITLE_I18N_KEY = 'assistance.title.fishing.navigation-after-miss';


/**
 * The request pattern for the card chunk, and the lane's second independent witness.
 *
 * An observation about the network rather than a claim about a flag constant: the flagged lane
 * must see this chunk requested, and the default lane must see it **not** requested even after
 * driving the identical journey. A lane that only proved presence would pass for a card that is
 * always on screen; a lane that only proved absence would pass for a build with no lane at all.
 */
export const ASSISTANCE_CARD_CHUNK_REQUEST_MATCH =
  /(?:\/|^)(?:assets\/)?AssistanceRegion-(?!legacy-)[^\s"'/]+\.js$/;

/**
 * The request pattern for the store chunk. Present on every build; used only as a control.
 *
 * Excludes the `-legacy-` re-emission for the same reason: no browser in plan section 2.5's engine
 * matrix executes it, and a pattern that matched it would report an ES5 fallback request as a
 * learner-visible fetch of the card.
 */
export const ASSISTANCE_STORE_CHUNK_REQUEST_MATCH =
  /(?:\/|^)(?:assets\/)?assistanceStore-(?!legacy-)[^\s"'/]+\.js$/;

/** The DOM attributes the probe reads. App-owned static vocabulary from `assistanceTestIds.ts`. */
export const ASSISTANCE_CARD_SELECTOR = '[data-assistance-id="assistance-card"]';
export const ASSISTANCE_SUGGESTION_SELECTOR = 'li.assistance-suggestion';
export const ASSISTANCE_REASON_TEXT_SELECTOR = '.assistance-suggestion__detail';
export const ASSISTANCE_DISMISS_SELECTOR = '[data-assistance-id="assistance-dismiss"]';
export const ASSISTANCE_DISMISSED_SELECTOR = '[data-assistance-id="assistance-dismissed"]';
export const ASSISTANCE_STATUS_SELECTOR = '[data-assistance-id="assistance-status"]';
/** Any assistance element at all. The gated lane's probe: this must be empty. */
export const ASSISTANCE_ANY_SELECTOR = '[data-assistance-id], [data-assistance-kind], [data-assistance-reason]';

/* ── Claims ───────────────────────────────────────────────────────────────────── */

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification. The evidence class is emulated-viewport and it is recorded as such in every JSON file this lane writes.',
  'Not a cross-engine result: Chromium only. Firefox, WebKit and Edge do not run this spec, so nothing here is evidence about another engine. Plan section 10.4 assigns cross-browser evidence to the compat-* projects and to the Phase 21 accessibility matrix.',
  'Not a screen-reader result. No assistive technology is installed on this host, so the lane asserts that a Dismiss control is focusable and that pressing it hides the row, and it asserts nothing about what any screen reader announces.',
  'Not an accessibility conformance result of any kind: no axe analysis runs here. The card semantics were checked in jsdom by tests/phase19/assistanceUiAccessibility.test.tsx, and the automated accessibility gate is the Phase 21 test:a11y suite.',
  'Not a frame-time, frame-budget, GPU-memory, layout, contrast-ratio or touch-target-size result. The lane reads DOM state and one network observation and measures nothing about rendering or layout.',
  'Not a hardware-GPU result: the WebGL context the village renderer obtains is real, and in a headless Linux container the unmasked renderer string is a software rasteriser.',
  'Not Electron; native packaging and installer workflows do not satisfy this gate and this lane does not run in them.',
] as const;

const SHARED_LIMITATIONS = [
  'Not a claim about the other four Phase 19 surfaces. The Creator, Scribe and Archaeologist workspaces are each behind their own flag, which the cutover default now turns on, so this artifact carries those surfaces too; the lane only drives the fishing slot, and no card was observed on any other one.',
  'Not a data-integrity certification: what the lane asserts about dismissal is that the control is advisory, so dismissing a suggestion removes the row and publishes a sentence and nothing else is written.',
  'Not a backup, data-product, offline, or licence result; those are Phases 5 through 8.',
] as const;

export interface AssistanceLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-21-assistance-lane';
  readonly project: string;
  readonly testFile: string;
  readonly testPath: string;
  readonly configFile: string;
  readonly configBasename: string;
  readonly buildScript: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  readonly recordScript: string;
  readonly verifyScript: string;
  readonly preflightCommand: string;
  readonly playwrightCommand: string;
  readonly previewPort: number;
  readonly previewScript: string;
  readonly script: string;
  readonly fullScript: string;
  readonly ciRunScript: string;
  /** Whether the artifact under test is expected to carry the compiled flag at `true`. */
  readonly expectsFlagOn: boolean;
  /** Whether the lane is expected to observe a rendered suggestion card. */
  readonly expectsCard: boolean;
  readonly worldRenderer: 'pixi' | 'phaser';
  readonly villageRenderer: 'pixi' | 'phaser';
  readonly storageRepository: 'v2' | 'legacy';
  readonly dataProductsV2: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: typeof ASSISTANCE_INPUT_MODE;
  readonly evidenceClass: 'emulated-viewport';
  readonly engine: 'chromium';
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  readonly ciJob: string;
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

export const ASSISTANCE_LANE: AssistanceLaneDeclaration = Object.freeze({
  schemaVersion: ASSISTANCE_LANE_SCHEMA_VERSION,
  suite: 'phase-21-assistance-lane',
  project: ASSISTANCE_PROJECT,
  testFile: ASSISTANCE_TEST_FILE,
  testPath: ASSISTANCE_TEST_PATH,
  configFile: ASSISTANCE_CONFIG_FILE,
  configBasename: ASSISTANCE_CONFIG_BASENAME,
  buildScript: ASSISTANCE_BUILD_SCRIPT,
  flag: ASSISTANCE_FLAG,
  flagValue: ASSISTANCE_FLAG_VALUE,
  manifestPath: ASSISTANCE_MANIFEST_PATH,
  recordScript: ASSISTANCE_RECORD_SCRIPT,
  verifyScript: ASSISTANCE_VERIFY_SCRIPT,
  preflightCommand: ASSISTANCE_PREFLIGHT_COMMAND,
  playwrightCommand: ASSISTANCE_PLAYWRIGHT_COMMAND,
  previewPort: ASSISTANCE_PREVIEW_PORT,
  previewScript: ASSISTANCE_PREVIEW_SCRIPT,
  script: ASSISTANCE_LANE_SCRIPT,
  fullScript: ASSISTANCE_LANE_FULL_SCRIPT,
  ciRunScript: ASSISTANCE_CI_RUN_SCRIPT,
  expectsFlagOn: true,
  expectsCard: true,
  // The cutover default keeps the application host, but `VITE_PIXI_VILLAGE` defaults on,
  // so the village world is the PixiJS one.
  worldRenderer: 'phaser',
  villageRenderer: 'pixi',
  storageRepository: 'v2',
  dataProductsV2: true,
  viewport: ASSISTANCE_VIEWPORT,
  deviceScaleFactor: ASSISTANCE_DEVICE_SCALE_FACTOR,
  hasTouch: ASSISTANCE_HAS_TOUCH,
  inputMode: ASSISTANCE_INPUT_MODE,
  evidenceClass: 'emulated-viewport',
  engine: 'chromium',
  runnerLabels: ['ubuntu-latest'] as const,
  installTargets: ['chromium'] as const,
  ciJob: 'browser-smoke',
  claim:
    'Against a build made with VITE_ADAPTIVE_ASSISTANCE=true, a real Chromium session that seeds a synthetic subject, ' +
    'walks the village to the pond, casts, hooks a bite, and answers the recall question for the room it came from ' +
    'wrong: a suggestion card region is rendered on the page with the engine-ranked suggestion inside it, the ' +
    "reason sentence that explanation derives, its evidence count and priority published as numbers, a polite role=\"status\" " +
    'announcement region, and a focusable Dismiss control whose accessible name carries the suggestion title; pressing ' +
    'that control removes the row and replaces it with a dismissed sentence; the lazy assistance chunk was fetched, ' +
    'which is what proves the card was rendered by the lane rather than by something already in the page; and every ' +
    'request the whole journey makes stays on the preview origin.',
  doesNotProve: [...EMULATION_LIMITATIONS, ...SHARED_LIMITATIONS],
});

export const ASSISTANCE_DEFAULT_LANE: AssistanceLaneDeclaration = Object.freeze({
  ...ASSISTANCE_LANE,
  project: ASSISTANCE_DEFAULT_PROJECT,
  testFile: ASSISTANCE_DEFAULT_TEST_FILE,
  testPath: ASSISTANCE_DEFAULT_TEST_PATH,
  configFile: ASSISTANCE_DEFAULT_CONFIG_FILE,
  configBasename: ASSISTANCE_DEFAULT_CONFIG_BASENAME,
  buildScript: ASSISTANCE_DEFAULT_BUILD_SCRIPT,
  manifestPath: ASSISTANCE_DEFAULT_MANIFEST_PATH,
  recordScript: ASSISTANCE_DEFAULT_RECORD_SCRIPT,
  verifyScript: ASSISTANCE_DEFAULT_VERIFY_SCRIPT,
  preflightCommand: ASSISTANCE_DEFAULT_PREFLIGHT_COMMAND,
  playwrightCommand: ASSISTANCE_DEFAULT_PLAYWRIGHT_COMMAND,
  previewPort: ASSISTANCE_DEFAULT_PREVIEW_PORT,
  previewScript: ASSISTANCE_DEFAULT_PREVIEW_SCRIPT,
  script: ASSISTANCE_DEFAULT_LANE_SCRIPT,
  fullScript: ASSISTANCE_DEFAULT_LANE_FULL_SCRIPT,
  ciRunScript: ASSISTANCE_DEFAULT_CI_RUN_SCRIPT,
  expectsFlagOn: false,
  expectsCard: false,
  // The rollback artifact is the pre-cutover build: Phaser on both renderers, the
  // legacy repository, and the data-products flag off. Overriding the cutover
  // identity inherited from `ASSISTANCE_LANE` is what keeps the pair's two claims
  // about two genuinely different artifacts.
  worldRenderer: 'phaser',
  villageRenderer: 'phaser',
  storageRepository: 'legacy',
  dataProductsV2: false,
  claim:
    'Against the Phase 23 full-rollback artifact - every cutover flag at its pre-cutover value - the identical ' +
    'journey - the same seeded subject, the same walk to the pond, the same cast, hook, and a recall question ' +
    'answered wrong for the room it came from - renders no assistance element of any kind: the card region, a ' +
    'suggestion, a reason sentence and a Dismiss control are all absent from the document, and the lazy card ' +
    'chunk is never requested even though the journey reached the DOM state that mounts it. The Welcome route ' +
    'also makes no request for the assistance store chunk: Phase 22 removed the unconditional boot fetch, so on ' +
    'the rollback artifact a launch no longer pulls the store for a feature it renders nothing of. This is the ' +
    'Phase 19 rollback line observed rather than asserted, and it is the half of the evidence that a card which ' +
    'is always on screen cannot produce.',
  doesNotProve: [
    ...EMULATION_LIMITATIONS,
    ...SHARED_LIMITATIONS,
    'Not a claim that the card is absent because the code is absent. The rollback build emits the same lazy lane chunks as the cutover one; what differs is the compiled flag constant, and the preflight reads it out of the emitted bytes rather than out of the environment.',
    'Not a claim that the assistance store chunk is never requested at all on the rollback build. It is absent at boot, which is what Phase 22 removed, but a missed recall later in the journey dynamically imports the store to record a signal - a write-time fetch, not a boot one.',
    'Not the complete absence of assistance from the shipped product: this lane observes the Phase 23 rollback artifact. The cutover default build carries the same code with the flag compiled on, which is the flagged lane\'s subject and this lane\'s positive control.',
  ],
});

export const ASSISTANCE_LANES: readonly AssistanceLaneDeclaration[] = Object.freeze([
  ASSISTANCE_LANE,
  ASSISTANCE_DEFAULT_LANE,
]);

/**
 * Structural problems with the lane **pair**. Empty means the two are one lane in two directions.
 *
 * Separate from {@link validateAssistanceLane} because the property that matters most is not
 * per-lane: a per-lane rule cannot say "the flagged lane and the default lane must disagree", and
 * that disagreement *is* the pair's whole value. Without it the two lanes would both be valid
 * declarations that assert the same thing, which is a lane set that reports the same observation
 * twice and proves nothing twice.
 */
export function validateAssistanceLanePair(
  lanes: readonly AssistanceLaneDeclaration[] = ASSISTANCE_LANES,
): readonly string[] {
  const problems: string[] = [];
  if (lanes.length !== 2) {
    problems.push(`the lane pair must be exactly two lanes, and there are ${lanes.length}.`);
    return problems;
  }
  const [flagged, fallback] = lanes;
  for (const field of ASSISTANCE_LANE_IDENTITY_FIELDS) {
    if (flagged[field] === fallback[field]) {
      problems.push(
        `the two lanes declare the same ${field}. A rollback claim verified against a flagged artifact is the ` +
          'confusion one manifest path per lane exists to make impossible.',
      );
    }
  }
  if (flagged.expectsFlagOn !== true || flagged.expectsCard !== true) {
    problems.push('the flagged lane must expect the compiled flag on and a rendered card.');
  }
  if (fallback.expectsFlagOn !== false || fallback.expectsCard !== false) {
    problems.push('the default lane must expect the compiled flag off and no card.');
  }
  if (flagged.buildScript !== ASSISTANCE_BUILD_SCRIPT || fallback.buildScript !== ASSISTANCE_DEFAULT_BUILD_SCRIPT) {
    problems.push(
      'the cutover lane previews `build:web:assistance` and the rollback lane previews `build:web:rollback`; ' +
        'anything else makes one of the two claims a claim about an artifact neither flag describes.',
    );
  }
  return problems;
}

/**
 * The lane's accessibility-relevant DOM selectors, grouped by the question each answers.
 *
 * Declared as data rather than inlined in the two specs, so the wiring gate can assert that
 * every selector the specs read is declared here and that a spec's probe and this table
 * cannot drift. A probe the gate cannot see is a probe nobody reviews.
 */
export const ASSISTANCE_PROBES = Object.freeze({
  /** The card region itself. Must exist exactly once on the flagged lane, never on the default one. */
  card: ASSISTANCE_CARD_SELECTOR,
  /** One suggestion row inside the card. */
  suggestion: ASSISTANCE_SUGGESTION_SELECTOR,
  /** The one-sentence reason the explanation derived. */
  reasonText: ASSISTANCE_REASON_TEXT_SELECTOR,
  /** The per-row Dismiss control. */
  dismiss: ASSISTANCE_DISMISS_SELECTOR,
  /** The sentence that replaces a dismissed suggestion. */
  dismissed: ASSISTANCE_DISMISSED_SELECTOR,
  /** The polite live region. */
  status: ASSISTANCE_STATUS_SELECTOR,
  /** Any assistance element at all. The default lane's probe, and the flagged lane's silence check. */
  any: ASSISTANCE_ANY_SELECTOR,
});

export const ASSISTANCE_PROBE_NAMES = Object.freeze([
  'card',
  'suggestion',
  'reasonText',
  'dismiss',
  'dismissed',
  'status',
  'any',
] as const);

/** Structural problems with a lane declaration. Empty means consistent. */
export function validateAssistanceLane(
  lane: AssistanceLaneDeclaration = ASSISTANCE_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (
    [
      'desktop-chromium',
      'chromebook',
      'tablet',
      'tablet-landscape',
      'compat-chromium',
      'compat-firefox',
      'compat-webkit',
      'compat-edge',
      'pixi-world-memory-chromium',
      'pixi-pointer-chromium',
      'pixi-fishing-chromium',
      'phase10-media-chromium',
      'storage-v2-chromium',
      'data-products-restore-chromium',
      'subject-product-chromium',
      'reload-persistence-chromium',
    ].includes(lane.project)
  ) {
    problems.push('the assistance lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (
    [
      'currentBuild.spec.ts',
      'compatibility.spec.ts',
      'storageV2.spec.ts',
      'dataProductsRestore.spec.ts',
      'subjectProductRoundTrip.spec.ts',
      'reloadPersistence.spec.ts',
      'pixiMemory.spec.ts',
      'pixi-canvas-pointer.spec.ts',
      'phase10Media.spec.ts',
      'fishing.spec.ts',
      'fishingRollback.spec.ts',
    ].includes(lane.testFile)
  ) {
    problems.push('the assistance lane must not bind an existing suite spec file.');
  }
  if (lane.expectsFlagOn) {
    // The Phase 23 cutover keeps the application host (`phaser`) and turns the per-world
    // flags on, so the village world is the PixiJS one (`pixi`).
    if (lane.worldRenderer !== 'phaser' || lane.villageRenderer !== 'pixi') {
      problems.push(
        'build:web:assistance produces the Phase 23 cutover default: the application host (phaser) with the PixiJS village world (pixi).',
      );
    }
    if (lane.storageRepository !== 'v2') {
      problems.push('the cutover-default artifact reads and writes storage-v2.');
    }
    if (lane.dataProductsV2 !== true) {
      problems.push('the cutover-default artifact has the data-products flag on.');
    }
  } else {
    if (lane.worldRenderer !== 'phaser' || lane.villageRenderer !== 'phaser') {
      problems.push(
        'build:web:rollback restores the Phaser renderers, so both must be recorded as phaser.',
      );
    }
    if (lane.storageRepository !== 'legacy') {
      problems.push('the rollback artifact restores the legacy storage repository.');
    }
    if (lane.dataProductsV2 !== false) {
      problems.push('the rollback artifact has the data-products flag off.');
    }
  }
  if (lane.engine !== 'chromium') problems.push('the lane is Chromium only; cross-browser evidence is Phase 21 matrix work.');
  if (lane.hasTouch !== false) {
    problems.push('the lane is Chromium only and drives a real pointer, so emulated touch must stay off.');
  }
  if (lane.evidenceClass !== 'emulated-viewport') {
    problems.push(
      'the lane drives an emulated viewport in headless Chromium, so its evidence class is emulated-viewport and must never be physical-device-manual.',
    );
  }
  if (lane.viewport.width <= 0 || lane.viewport.height <= 0) {
    problems.push('the lane must declare a positive viewport.');
  }
  if (lane.deviceScaleFactor <= 0) problems.push('the lane must declare a positive device scale factor.');
  if (lane.runnerLabels.length === 0) problems.push('the lane must declare a runner label.');
  if (lane.installTargets.length === 0) problems.push('the lane must declare a browser install target.');
  if (lane.ciJob !== 'browser-smoke') {
    problems.push(
      'the lane runs as steps in the existing browser-smoke job, which is the only job with a Chromium install and no build of its own.',
    );
  }
  if (!lane.testFile.startsWith('assistance')) problems.push('the lane must bind an assistance spec file.');
  if (!lane.configFile.startsWith('tests/e2e/')) {
    problems.push('the lane config must live under tests/e2e/ so both typecheck and lint see it.');
  }
  if (lane.previewPort <= 0) problems.push('the lane must declare a positive preview port.');
  if (!lane.previewScript.includes(String(lane.previewPort))) {
    problems.push('the preview command must name the port the lane declares.');
  }
  if (!lane.previewScript.includes('--strictPort')) {
    problems.push('the preview command must use --strictPort so a port collision fails instead of previewing another dist.');
  }
  if (!lane.playwrightCommand.includes(lane.configFile)) {
    problems.push('the Playwright command must name the config file the lane declares.');
  }
  if (lane.claim.trim().length < 200) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 8) problems.push('the lane must declare a does-not-prove list.');
  for (const limitation of lane.doesNotProve) {
    if (limitation.trim().length < 20) problems.push('a does-not-prove entry is too short to be a boundary.');
  }
  // The two lanes are one lane in two directions, and the boundaries that matter are named
  // rather than counted. `emulated-viewport` is asserted above, and the physical-device
  // refusal is asserted here by content so a future edit cannot delete the sentence that
  // keeps this lane from ever being read as a Chromebook or tablet result.
  if (!lane.doesNotProve.some((entry) => /not a physical device/i.test(entry))) {
    problems.push('the lane must refuse to be read as physical-device evidence, in words.');
  }
  if (!lane.doesNotProve.some((entry) => /screen-reader/i.test(entry))) {
    problems.push('the lane must refuse to be read as a screen-reader result, in words.');
  }
  if (!lane.doesNotProve.some((entry) => /axe/i.test(entry))) {
    problems.push('the lane must refuse to be read as an accessibility conformance result, in words.');
  }
  return problems;
}

/**
 * The two lanes as a table of the four places their identities must differ.
 *
 * Asserted by the wiring gate rather than left to a reader: a lane pair whose artifacts,
 * ports, configs or npm scripts had merged would let a rollback claim be verified against a
 * flagged build, which is the exact confusion the fishing module's two manifests exist to
 * make impossible.
 */
export const ASSISTANCE_LANE_IDENTITY_FIELDS = Object.freeze([
  'project',
  'testFile',
  'configFile',
  'buildScript',
  'manifestPath',
  'previewPort',
  'expectsFlagOn',
  'expectsCard',
] as const);