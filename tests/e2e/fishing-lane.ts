/**
 * Phase 17 Pixi fishing lane declaration.
 *
 * The machine-readable source for the flagged browser lane, imported by this lane's
 * Playwright config and checked against the real build script, the real Playwright
 * project, the real npm scripts, and the preflight by `tests/e2e/fishing-lane.test.ts`.
 *
 * ## Why this lane exists
 *
 * Phase 17's Deliverables name "Fishing browser E2E coverage" and its Exit criteria
 * name "A complete cast-to-catch-to-keep flow works using touch and keyboard". Neither
 * had any route to a browser before this file: the only gated browser lane that could
 * reach a flag is `test:e2e:pixi-*`, and both of those run `VITE_WORLD_RENDERER=pixi`,
 * which switches the *village and dungeon* renderers. `VITE_PIXI_FISHING` is a different
 * switch with a different build script, so `VITE_PIXI_FISHING=true npm run test:e2e`
 * — the command in the phase's own Verification block — previews the **default** artifact
 * and therefore tests the Phaser fishing lane, not the Pixi one. Phase 16 established that
 * pattern for exactly this reason; this lane is the fishing instance of it.
 *
 * ## Which build, and why a *flagged* one is the only possible subject
 *
 * The pond is only in the artifact when `VITE_PIXI_FISHING=true`, exactly as the Pixi
 * memory lane is only about a `VITE_WORLD_RENDERER=pixi` artifact. After the Phase 23
 * cutover the per-world switches default on, so `build:web:pixi-fishing` now pins its
 * isolation explicitly: `VITE_WORLD_RENDERER=phaser`, `VITE_PIXI_FISHING=true`, and the
 * two other Pixi world switches off. The village that owns the entry point stays on
 * Phaser, which is the configuration this lane is defined against and the reason
 * `vite.config.ts`'s renderer chunk boundary has a `pixiFishing` check of its own.
 *
 * ## Why there are two lanes in one module
 *
 * Phase 17's rollback line is `VITE_PIXI_FISHING=false`, and the rollback half of a cutover
 * is evidence like any other half: "the same entry point reaches the Phaser `FishingScene`"
 * is a claim about the **Phase 23 full-rollback artifact** (`build:web:rollback`), not about
 * the isolated Pixi-pond one. Asserting it against the isolated artifact would be vacuous —
 * today the isolated artifact reaches the Phaser scene too, which is a defect rather than a
 * pass (see `tests/e2e/fishing.spec.ts`'s header for the finding and the lane's own
 * `knownDefects` list).
 *
 * So the module declares two lanes over two recorded identities, and `package.json` exposes
 * each under its own `test:e2e:fishing:*` / `test:e2e:fishing:rollback:*` scripts. They share
 * one spec file, one config, and one preflight, because they share the entry-point walk and
 * the privacy discipline; what differs is which manifest is verified and which claims are
 * live. The spec **classifies the artifact from `dist/` itself** — by looking for the fishing
 * chunk Vite emitted — rather than by reading an environment variable, so a lane can never
 * assert a rollback claim against an artifact that contains the thing being rolled back.
 *
 * ## Chromium only, and why
 *
 * Plan section 10.4's staged matrix puts cross-browser evidence in the `compat-*` projects,
 * and Phase 21 owns the accessibility and responsive audit that the full matrix serves. One
 * new surface does not need four engines on the day it lands: this lane runs the
 * Playwright-bundled Chromium engine, the same engine the two Pixi lanes already run, and
 * says so in `doesNotProve`. A fishing E2E lane that ran four engines would multiply CI cost
 * and maintenance for evidence Phase 21 will produce properly anyway.
 *
 * ## What it does not prove
 *
 * Stated in full in each lane's `doesNotProve` and asserted by content by the wiring gate,
 * because a lane that overstates itself is worse than no lane. The ones that matter most:
 *
 * - **No frame-time, GPU-memory, canvas-size, contrast, touch-target-on-screen, 320 px, or
 *   200 % zoom number.** The lane measures the *flow* and the *DOM state*, not rendering
 *   performance or layout. Plan section 10.1 and 10.2's visual and timing budgets are Phase
 *   21's and Phase 22's.
 * - **No physical device, ChromeOS, screen-reader, or engine claim beyond Chromium.**
 * - **Not a headless-GPU claim.** The WebGL2 context the pond obtains is real; the unmasked
 *   renderer string in a headless Linux container is a software rasteriser, and nothing here
 *   asserts otherwise.
 * - **Not a data-integrity certification.** What the lane asserts about progression is that
 *   *nothing visible changed* on the release path and that no experience sentence appeared
 *   on the keep-with-no-recall path. The idempotency ledger itself is proved in
 *   `tests/phase17/catchRewards.test.ts` against a plain object.
 *
 * Privacy: synthetic fixtures only. Every subject, room, and pond identifier this lane names
 * is a literal it wrote itself and reads back out of the page; no learner data, request body,
 * credential, or private URL may enter a script, a config, a spec, a test name, or a report.
 */

/* ── The two lanes ─────────────────────────────────────────────────────────── */

export const FISHING_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const FISHING_PROJECT = 'pixi-fishing-chromium';

/** The only spec this lane may run. */
export const FISHING_TEST_FILE = 'fishing.spec.ts';
export const FISHING_TEST_PATH = `tests/e2e/${FISHING_TEST_FILE}`;

/**
 * The config that owns the lane.
 *
 * It lives under `tests/e2e/` for the reason `playwright.pixi-memory.config.ts` records:
 * `tsconfig.node.json` enumerates the four older configs by name in its `include`, so a
 * sixth root-level config would sit inside no TypeScript project — `npm run lint` would fail
 * to parse it and `npm run typecheck` would never see it. Inside `tests/e2e/**` the file is
 * covered by `tsconfig.app.json`'s `include: ["src", "tests"]`, so a type error in it fails
 * the ordinary gate rather than surfacing the first time Playwright happens to run it.
 */
export const FISHING_CONFIG_FILE = 'tests/e2e/playwright.fishing.config.ts';
export const FISHING_CONFIG_BASENAME = 'playwright.fishing.config.ts';

/**
 * The rollback lane's spec and config.
 *
 * Its own two files for one reason: a test's premise must be true of the artifact it runs
 * against. The flagged spec drives the pond's six DOM controls, which exist only in an artifact
 * that contains the pond; the rollback spec drives the Phaser `FishingScene`, which exists only
 * in an artifact that does not. One spec asserting both would need a skip to express the half
 * that cannot run, and a lane that passes by not measuring is the exact failure this
 * repository's own doctrine forbids.
 */
export const FISHING_ROLLBACK_TEST_FILE = 'fishingRollback.spec.ts';
export const FISHING_ROLLBACK_TEST_PATH = `tests/e2e/${FISHING_ROLLBACK_TEST_FILE}`;
export const FISHING_ROLLBACK_CONFIG_FILE = 'tests/e2e/playwright.fishing-rollback.config.ts';
export const FISHING_ROLLBACK_CONFIG_BASENAME = 'playwright.fishing-rollback.config.ts';

/** The build script that produces the isolated flagged artifact this lane previews. */
export const FISHING_BUILD_SCRIPT = 'build:web:pixi-fishing';
/** The Phase 23 full-rollback artifact, which the rollback lane previews. */
export const FISHING_ROLLBACK_BUILD_SCRIPT = 'build:web:rollback';

/** The build-time flag, and the value the plan's matrix requires for it. */
export const FISHING_FLAG = 'VITE_PIXI_FISHING';
export const FISHING_FLAG_VALUE = 'true';

/**
 * Its own recorded identity, so a flagged build is never mistaken for another flagged build.
 *
 * One file per artifact, which is the whole reason the rollback lane needs a second one: a
 * single manifest path would let the rollback claim be verified against the pond.
 */
export const FISHING_MANIFEST_PATH = 'artifacts/web-artifact-manifest-pixi-fishing.json';
export const FISHING_ROLLBACK_MANIFEST_PATH = 'artifacts/web-artifact-manifest-rollback.json';

/** The recorded-identity scripts, one pair per artifact. */
export const FISHING_RECORD_SCRIPT = 'record:web-artifact:pixi-fishing';
export const FISHING_VERIFY_SCRIPT = 'verify:web-artifact:pixi-fishing';
export const FISHING_ROLLBACK_RECORD_SCRIPT = 'record:web-artifact:rollback';
export const FISHING_ROLLBACK_VERIFY_SCRIPT = 'verify:web-artifact:rollback';

/**
 * The Playwright invocation, spelled once.
 *
 * `package.json` is the one place a Playwright command is written, and every script that
 * runs this lane uses this same string, so the config this lane declares and the config
 * Playwright loads cannot be different files. No `--project` override anywhere: the config
 * binds exactly one project, so there is nothing to select.
 */
export const FISHING_PLAYWRIGHT_COMMAND = `playwright test --config=${FISHING_CONFIG_FILE}`;
export const FISHING_ROLLBACK_PLAYWRIGHT_COMMAND = `playwright test --config=${FISHING_ROLLBACK_CONFIG_FILE}`;

/**
 * Its own port, so it cannot contend with any other lane's preview server.
 *
 * And so it cannot contend with **this** lane's either: the two configs may both be run in one
 * worktree within a few minutes of each other, and `webServer.reuseExistingServer` is `false`
 * on both, so sharing a port would be a hard `--strictPort` failure rather than a silent preview
 * of whichever artifact happened to be first.
 */
export const FISHING_PREVIEW_PORT = 43199;
export const FISHING_ROLLBACK_PREVIEW_PORT = 43201;
/**
 * The preview command.
 *
 * An `npx vite preview` invocation rather than an npm script, for the reason
 * `playwright.pixi-memory.config.ts` records: the preview belongs to the Playwright config
 * rather than to a command a person runs, and every other lane reaches its port the same way.
 * The port and `--strictPort` are the parts that matter; the wiring gate asserts both.
 */
export const FISHING_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${FISHING_PREVIEW_PORT} --strictPort`;
export const FISHING_ROLLBACK_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${FISHING_ROLLBACK_PREVIEW_PORT} --strictPort`;

/**
 * The preflight both lanes run before Playwright starts.
 *
 * A command rather than a guard at the top of the config, for the reason
 * `scripts/require-pixi-lane-artifact.mjs` records in full: `tests/e2e/fishing-lane.test.ts`
 * imports the config module to assert its shape, so a module-scope `throw` would make
 * importing it fatal in any checkout without a built artifact, including the `unit-tests` CI
 * job, which has none and never should. `undefined` is treated exactly as `false`: the
 * default build is unaffected.
 */
export const FISHING_LANE_PREFLIGHT_SCRIPT = 'require-fishing-lane-artifact.mjs';
export const FISHING_LANE_PREFLIGHT_COMMAND = `node scripts/${FISHING_LANE_PREFLIGHT_SCRIPT}`;
/**
 * The rollback lane's preflight invocation.
 *
 * One script for both lanes, selected by a flag, so the two cannot drift apart in how they
 * decide an artifact is present to measure. It establishes that there is something to check
 * and nothing more: it cannot build and cannot record.
 */
export const FISHING_ROLLBACK_PREFLIGHT_COMMAND = `${FISHING_LANE_PREFLIGHT_COMMAND} --rollback`;

/**
 * The npm scripts, following the repository's own split.
 *
 * `test:e2e:fishing` previews an artifact that already exists, `:full` builds, records and
 * verifies one first, and `:recorded` is the preview-only name that says the artifact was
 * recorded by something else — which in CI would be the build job, on another runner. The
 * rollback lane has the same three under `:rollback`.
 */
export const FISHING_LANE_SCRIPT = 'test:e2e:fishing';
export const FISHING_LANE_FULL_SCRIPT = 'test:e2e:fishing:full';
export const FISHING_CI_RUN_SCRIPT = 'test:e2e:fishing:recorded';
export const FISHING_ROLLBACK_LANE_SCRIPT = 'test:e2e:fishing:rollback';
export const FISHING_ROLLBACK_LANE_FULL_SCRIPT = 'test:e2e:fishing:rollback:full';
export const FISHING_ROLLBACK_CI_RUN_SCRIPT = 'test:e2e:fishing:rollback:recorded';

/* ── The measured environment, recorded with every run ──────────────────────── */

/**
 * Plan section 10.4's required dimensions, as data.
 *
 * The matrix in `tests/e2e/support-matrix.ts` owns the *approved* dimensions, and this lane
 * is not a matrix project — it is one new surface on the Chromium engine that the two Pixi
 * lanes already run. So it declares its own viewport, scale factor, and input mode here,
 * records all of them plus the observed OS, architecture, and browser version in the run's
 * sanitized JSON, and states in `doesNotProve` that a Chromium lane is not a matrix claim.
 *
 * The viewport is `support-matrix.ts`'s own `compat-chromium` record, read from the matrix
 * rather than retyped, so a change to the approved desktop Chromium viewport cannot leave
 * this lane measuring a size the plan no longer approves.
 */
export const FISHING_VIEWPORT: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 1280,
  height: 800,
});
export const FISHING_DEVICE_SCALE_FACTOR = 1;
/** Chromium only, so `hasTouch` is false and every test drives a real mouse or key. */
export const FISHING_HAS_TOUCH = false;
/**
 * The emulated input modes this lane exercises, one per test group.
 *
 * `keyboard-only` and `pointer-only` are the parity pair Phase 17's exit criterion names: the
 * whole cast-to-catch-to-keep flow is driven once with no pointer event anywhere and once with no
 * key anywhere. `pointer-keyboard` is the third, and it is not a third kind of parity - it is the
 * *navigation* every one of those tests has to perform before it can start, because reaching a
 * pond means walking the village on the arrow keys and pressing a DOM row with the mouse.
 */
export const FISHING_INPUT_MODES = ['keyboard-only', 'pointer-only', 'pointer-keyboard'] as const;
export type FishingInputMode = (typeof FISHING_INPUT_MODES)[number];

/** The renderer modes this lane can observe, one per lane. */
export const FISHING_RENDERER_MODES = ['pixi-fishing-pond', 'phaser-fishing-scene'] as const;
export type FishingRendererMode = (typeof FISHING_RENDERER_MODES)[number];

/**
 * The chunk name prefix Vite gives the Pixi fishing world, and the marker that proves the
 * entry point reached the Phaser scene instead.
 *
 * Both are **read from `dist/` and from the live page**, never from a flag constant: the
 * point of the rollback lane is to establish what the artifact contains, and reading the
 * flag back out of the code under test would make the lane assert the flag rather than the
 * product. `FishingWorld` is the lazy chunk `PixiFishingLane.tsx` imports, so its presence
 * in `dist/assets` is the artifact-level fact and its *absence* is the production default.
 */
export const FISHING_CHUNK_PREFIX = 'FishingWorld-';

/**
 * The class the **village's own** Phaser canvas is mounted under.
 *
 * `village-canvas`, not `game-canvas-host`: the latter is the dungeon route's host, and the
 * fishing pond is entered from the village, so the canvas that survives a cast is the village's.
 * Naming the wrong one would have made this lane assert against an element the product does not
 * render here.
 */
export const FISHING_PHASER_FALLBACK_CLASS = 'village-canvas';

/* ── Claims ────────────────────────────────────────────────────────────────── */

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a cross-engine result: Chromium only. Firefox, WebKit, and Edge do not run this spec, so nothing here is evidence about another engine; plan section 10.4 assigns cross-browser evidence to the compat-* projects and Phase 21.',
  'Not a frame-time, frame-budget, GPU-memory, or interaction-latency result. The lane reads DOM state and network observations and measures nothing about rendering performance.',
  'Not a layout result: no contrast ratio, no on-screen touch-target size, no 320 CSS-pixel viewport, and no 200 % zoom figure is measured here. Plan section 10.1 and 10.2 assign those to Phase 21 and Phase 22.',
  'Not a hardware-GPU result: the WebGL2 context the pond obtains is real, and in a headless Linux container the unmasked renderer string is a software rasteriser.',
  'Not Electron; native packaging and installer workflows do not satisfy this gate and this lane does not run in them.',
] as const;

const SHARED_LIMITATIONS = [
  'Not an accessibility certification: no axe scan runs here. The lane asserts that the controls exist, are reachable, and are pressed by keyboard and by pointer; the semantics were checked in jsdom by tests/phase17/fishing-hud.test.tsx.',
  'Not a data-integrity certification: what is asserted about progression is that nothing visible changed on the release path and that no experience sentence appeared on the keep-with-no-recall path. The idempotent ledger itself is proved against a plain object in tests/phase17/catchRewards.test.ts.',
  'Not a renderer-teardown result: returning to the village and re-entering is asserted as a DOM transition, and the release-side facts are measured in tests/phase17/fishing-scene-teardown.test.ts rather than here.',
  'Not a data-product or backup result; those are Phases 5 through 7.',
] as const;

export interface FishingLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-17-pixi-fishing';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  readonly recordScript: string;
  readonly verifyScript: string;
  readonly preflightCommand: string;
  readonly script: string;
  readonly fullScript: string;
  readonly ciRunScript: string;
  /** The renderer this lane is the only browser evidence for. */
  readonly expectedRendererMode: FishingRendererMode;
  /** Whether the artifact under test is expected to contain the Pixi fishing chunk. */
  readonly expectsPixiChunk: boolean;
  /** The world renderer the artifact's **village** uses. Phaser, pinned on both lanes. */
  readonly villageRenderer: 'phaser';
  readonly worldRenderer: 'phaser';
  readonly storageRepository: 'v2' | 'legacy';
  readonly dataProductsV2: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputModes: readonly FishingInputMode[];
  readonly evidenceClass: 'emulated-viewport';
  readonly engine: 'chromium';
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

export const FISHING_LANE: FishingLaneDeclaration = Object.freeze({
  schemaVersion: FISHING_LANE_SCHEMA_VERSION,
  suite: 'phase-17-pixi-fishing',
  project: FISHING_PROJECT,
  testFile: FISHING_TEST_FILE,
  configFile: FISHING_CONFIG_FILE,
  buildScript: FISHING_BUILD_SCRIPT,
  flag: FISHING_FLAG,
  flagValue: FISHING_FLAG_VALUE,
  manifestPath: FISHING_MANIFEST_PATH,
  recordScript: FISHING_RECORD_SCRIPT,
  verifyScript: FISHING_VERIFY_SCRIPT,
  preflightCommand: FISHING_LANE_PREFLIGHT_COMMAND,
  script: FISHING_LANE_SCRIPT,
  fullScript: FISHING_LANE_FULL_SCRIPT,
  ciRunScript: FISHING_CI_RUN_SCRIPT,
  expectedRendererMode: 'pixi-fishing-pond',
  expectsPixiChunk: true,
  // `build:web:pixi-fishing` pins `VITE_WORLD_RENDERER=phaser` and turns the two
  // other Pixi world switches off, so the artifact is the pre-cutover "Phaser host,
  // one Pixi world" shape the lane was written against. The storage and data-product
  // flags are the post-cutover defaults, because this artifact is not the rollback.
  villageRenderer: 'phaser',
  worldRenderer: 'phaser',
  storageRepository: 'v2',
  dataProductsV2: true,
  viewport: FISHING_VIEWPORT,
  deviceScaleFactor: FISHING_DEVICE_SCALE_FACTOR,
  hasTouch: FISHING_HAS_TOUCH,
  inputModes: FISHING_INPUT_MODES,
  evidenceClass: 'emulated-viewport',
  engine: 'chromium',
  runnerLabels: ['ubuntu-latest'] as const,
  installTargets: ['chromium'] as const,
  claim:
    'Against a build made with VITE_PIXI_FISHING=true, the same village fishing-pond entry point that ' +
    'serves the Phaser fallback mounts the PixiJS pond: the canvas the world draws into is the pond, ' +
    'a complete cast to bite to hook to catch to keep flow completes with the keyboard alone and again ' +
    'with pointer input alone, keeping a fish with no recall material awards no experience and says so, ' +
    'releasing a fish leaves no visible progression change, the Fish Stand reports a canonical catalogue ' +
    'count, the recall question offers a route back to the room it came from, and every request the whole ' +
    'flow makes stays on the preview origin.',
  doesNotProve: [...EMULATION_LIMITATIONS, ...SHARED_LIMITATIONS],
});

export const FISHING_ROLLBACK_LANE: FishingLaneDeclaration = Object.freeze({
  ...FISHING_LANE,
  testFile: FISHING_ROLLBACK_TEST_FILE,
  configFile: FISHING_ROLLBACK_CONFIG_FILE,
  buildScript: FISHING_ROLLBACK_BUILD_SCRIPT,
  manifestPath: FISHING_ROLLBACK_MANIFEST_PATH,
  recordScript: FISHING_ROLLBACK_RECORD_SCRIPT,
  verifyScript: FISHING_ROLLBACK_VERIFY_SCRIPT,
  preflightCommand: FISHING_ROLLBACK_PREFLIGHT_COMMAND,
  script: FISHING_ROLLBACK_LANE_SCRIPT,
  fullScript: FISHING_ROLLBACK_LANE_FULL_SCRIPT,
  ciRunScript: FISHING_ROLLBACK_CI_RUN_SCRIPT,
  expectedRendererMode: 'phaser-fishing-scene',
  expectsPixiChunk: false,
  // The rollback artifact is the pre-cutover build, so these are the legacy values.
  storageRepository: 'legacy',
  dataProductsV2: false,
  claim:
    'Against the Phase 23 full-rollback artifact - every cutover flag at its pre-cutover value - the built bundle ' +
    'contains no Pixi fishing chunk and the village fishing-pond entry point reaches the Phaser FishingScene in ' +
    'the village game, not a Pixi pond: the same single canvas stays in place, the cast is driven through the ' +
    'Phaser scene, Escape returns to the village, no Pixi script is requested at any point, and every request the ' +
    'whole flow makes stays on the preview origin. This is the Phase 17 rollback line as an observation rather ' +
    'than as a claim: VITE_PIXI_FISHING=false is the rollback, and this lane is the evidence that the rollback ' +
    'target still works.',
  doesNotProve: [
    ...EMULATION_LIMITATIONS,
    ...SHARED_LIMITATIONS,
    'Not a claim that the Pixi pond is absent from a VITE_PIXI_FISHING=true build. This lane runs the Phase 23 rollback artifact; the isolated Pixi-pond artifact is the other lane, and the fact that the two cannot be distinguished at the entry point today is a recorded defect, not a rollback result.',
    'Not a Phaser-versus-Pixi comparison of the fishing loop. The Phaser scene has no DOM controls of its own, so this lane presses keys against a canvas and asserts the scene swap, and the cast-to-catch parity comparison is the flagged lane’s subject once the pond is reachable.',
  ],
});

/** Structural problems with a lane declaration. Empty means consistent. */
export function validateFishingLane(
  lane: FishingLaneDeclaration = FISHING_LANE,
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
      'storage-v2-chromium',
      'data-products-restore-chromium',
      'pixi-world-memory-chromium',
      'pixi-pointer-chromium',
      'phase10-media-chromium',
    ].includes(lane.project)
  ) {
    problems.push('the fishing lane must not reuse another lane project name.');
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
    ].includes(lane.testFile)
  ) {
    problems.push('the fishing lane must not bind an existing suite spec file.');
  }
  if (lane.villageRenderer !== 'phaser' || lane.worldRenderer !== 'phaser') {
    problems.push(
      'both lanes pin the world and village renderers to Phaser so the pond route stays reachable behind a Phaser host.',
    );
  }
  if (lane.expectsPixiChunk) {
    if (lane.storageRepository !== 'v2') {
      problems.push('the isolated Pixi-pond artifact is a post-cutover build, so its storage repository is v2.');
    }
    if (lane.dataProductsV2 !== true) {
      problems.push('the isolated Pixi-pond artifact is a post-cutover build, so the data-products flag is on.');
    }
  } else {
    if (lane.storageRepository !== 'legacy') {
      problems.push('the rollback artifact restores the legacy storage repository.');
    }
    if (lane.dataProductsV2 !== false) {
      problems.push('the rollback artifact has the data-products flag off.');
    }
  }
  if (lane.engine !== 'chromium') {
    problems.push('the lane is Chromium only; Phase 21 owns cross-browser evidence for this surface.');
  }
  if (lane.hasTouch !== false) {
    problems.push(
      'the lane is Chromium only and drives a real mouse and real keys, so emulated touch must stay off.',
    );
  }
  if (lane.inputModes.length !== 3 || !lane.inputModes.includes('keyboard-only')) {
    problems.push("the lane must declare a keyboard-only and a pointer-only input mode; parity is the criterion.");
  }
  if (!(lane.inputModes as readonly string[]).includes('pointer-only')) {
    problems.push('the lane must declare a pointer-only input mode; parity is the criterion.');
  }
  if ((lane.inputModes as readonly string[]).includes('touch-emulated')) {
    problems.push('emulated touch is a form-factor claim this lane does not make; pointer input is what it drives.');
  }
  if (lane.viewport.width <= 0 || lane.viewport.height <= 0) {
    problems.push('the lane must declare a positive viewport.');
  }
  if (lane.deviceScaleFactor <= 0) problems.push('the lane must declare a positive device scale factor.');
  if (lane.runnerLabels.length === 0) problems.push('the lane must declare a runner label.');
  if (lane.installTargets.length === 0) problems.push('the lane must declare a browser install target.');
  if (lane.claim.trim().length < 120) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 8) problems.push('the lane must declare a does-not-prove list.');
  for (const limitation of lane.doesNotProve) {
    if (limitation.trim().length < 20) problems.push('a does-not-prove entry is too short to be a boundary.');
  }
  return problems;
}

/**
 * The two lanes as one list, for a gate that asserts them together.
 *
 * Their identities must differ in exactly the four places that make the rollback claim
 * possible: the artifact's build script, the recorded identity, the npm scripts, and the
 * renderer the entry point is expected to reach. Anywhere else they are the same lane.
 */
export const FISHING_LANES: readonly FishingLaneDeclaration[] = Object.freeze([
  FISHING_LANE,
  FISHING_ROLLBACK_LANE,
]);