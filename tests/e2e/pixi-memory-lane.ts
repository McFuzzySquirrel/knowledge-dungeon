/**
 * Phase 9 Pixi world-host memory lane declaration.
 *
 * The machine-readable source for the browser-backed half of plan section 10.2's
 * renderer memory gate, imported by the lane's Playwright config and checked
 * against the real build script, the real Playwright project, the real CI steps,
 * and the preflight's own cycle count by `tests/e2e/pixi-memory-lane.test.ts`.
 *
 * ## Why this lane exists
 *
 * Phase 9's exit criteria name "Repeated mount and unmount does not leak canvases
 * or GPU resources", and plan section 10.2 states the number: "No material canvas
 * or GPU memory growth over 20 world mount and unmount cycles." Until now the only
 * gate on that pair was `scripts/check-memory.mjs`, and that script says in its own
 * header, in its own output, and in its own `NOT_MEASURED` list that it is a
 * build-level preflight: it reads a directory of files, starts no browser, mounts
 * no world, and measures none of it. It is a real and necessary gate - it is what
 * makes "no eager Pixi on Welcome" and the 800 KiB lazy-chunk ceiling structural -
 * and it is not a leak measurement. The phase's central memory criterion therefore
 * had no gate at all, and this is that gate.
 *
 * ## Which build, and why a *flagged* one is the only possible subject
 *
 * The criterion is about the PixiJS host, and the host is only in the artifact when
 * `VITE_WORLD_RENDERER=pixi`. `build:web:pixi` is already run in CI, in the
 * `web-build` job, and `web-build` is the wrong place for a browser lane for a
 * reason its own comment records: it installs no browser, deliberately, so that a
 * pull request does not pay for a browser install to prove that a flag compiles. The
 * job that already has a Chromium install, an `npm ci`, a production `dist` in hand,
 * and a declared policy of uploading nothing but sanitized JSON is `browser-smoke`.
 * So this lane is *steps in that job*, after the Phase 1 viewport suite has run
 * against the production artifact: a Pixi-flagged build of the same checkout is
 * downloaded from the `web-build` job, its own recorded identity is verified, the
 * lane previews it and measures it, and sanitized JSON evidence is uploaded. No
 * second production artifact, no second `npm ci`, no second browser install, no
 * second production upload.
 *
 * ## What a cycle is here, stated plainly
 *
 * A cycle is the world host being torn down and rebuilt: a live
 * `prefers-reduced-motion` change changes the host's effect dependencies, so React
 * runs the old host's cleanup (`host.unmount()` -> scene destroy ->
 * `Application.destroy({ removeView: true, releaseGlobalResources: true })` -> canvas
 * removal) and then mounts a brand new host, with a new `Application`, a new WebGL
 * context, a new ticker, and a new canvas. Everything the leak criterion is about -
 * canvas, renderer, GPU context, ticker, scene, subscriptions - is created and
 * released once per cycle.
 *
 * It is *not* a navigation away from the world and back, and the `doesNotProve`
 * list says so. The flagged build has no product control that leaves the world: the
 * renderer switch is at the screen level, the test world is a Phase 9 runtime-host
 * surface rather than a place a learner travels from, and nothing on that screen
 * changes the session store's screen. Choosing a host rebuild over a route change
 * is therefore a change of *trigger*, not a change of *teardown path*: both run the
 * same cleanup, and the lane asserts that the cleanup is total.
 *
 * ## What it does not prove
 *
 * Stated in full in `doesNotProve` and asserted by the wiring gate, because a lane
 * that overstates itself is worse than no lane. The three that matter most:
 *
 * - **No live-context or GPU-memory number.** No API in a headless browser reports
 *   the number of live WebGL contexts or the bytes of texture memory, and the built
 *   `vendor-pixi` chunk exports only the four PixiJS symbols this application
 *   imports, so `Ticker.shared` is not reachable from the page. What the lane does
 *   assert is the release-side fact a context count would have detected indirectly:
 *   every one of the 20 renderers had its WebGL context explicitly lost at teardown.
 * - **No detector for the PixiJS 8.21.0 `CanvasObserver` defect.** That defect is a
 *   listener left on `Ticker.shared` per application, and `Ticker.shared` cannot be
 *   read from outside the bundle. The lane therefore asserts the *precondition*
 *   instead - `ResizeObserver` is present in the page when the renderer is created,
 *   which is the condition under which the defect does not occur - and records, from
 *   a run with the global removed, that no counter this lane can read changes.
 * - **No page-level unmount, and no quiescent document.** Teardown and the next
 *   mount are one synchronous React commit, so there is no instant at which the
 *   document can be sampled with nothing mounted. The lane asserts the equivalent
 *   and stronger fact - zero canvases retained from any earlier cycle - rather than
 *   a literal return to the pre-mount count.
 *
 * Privacy: nothing here contains learner data, request data, credentials, or a
 * private URL. The lane drives the application's own synthetic tutorial subject, the
 * only host it names is the reserved `example.invalid`, and every value it records
 * is a count, a byte total, a browser/driver string, or a boolean.
 */

export const PIXI_MEMORY_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const PIXI_MEMORY_PROJECT = 'pixi-world-memory-chromium';

/** The only spec this lane may run. */
export const PIXI_MEMORY_TEST_FILE = 'pixiMemory.spec.ts';
export const PIXI_MEMORY_TEST_PATH = `tests/e2e/${PIXI_MEMORY_TEST_FILE}`;

/**
 * The config that owns the lane.
 *
 * It lives under `tests/e2e/` rather than at the repository root beside the four
 * existing `playwright.*.config.ts` files, and that is a constraint rather than a
 * preference. `tsconfig.node.json` enumerates the four existing configs by name in
 * its `include`, and this change does not own that file; a fifth root-level config
 * would therefore be inside no TypeScript project, which means `npm run lint`
 * (whose parser is configured with exactly those three projects) would fail to parse
 * it and `npm run typecheck` would never see it - a config whose type errors surface
 * only if Playwright happens to run it. Inside `tests/e2e/**` the file is covered by
 * `tsconfig.app.json`'s `include: ["src", "tests"]`, so it is linted and typechecked
 * with no change to any file this change does not own.
 */
export const PIXI_MEMORY_CONFIG_FILE = 'tests/e2e/playwright.pixi-memory.config.ts';
export const PIXI_MEMORY_CONFIG_BASENAME = 'playwright.pixi-memory.config.ts';

/** The build script that produces the artifact this lane previews. */
export const PIXI_MEMORY_BUILD_SCRIPT = 'build:web:pixi';

/** The build-time flag, and the value the plan's matrix requires for it. */
export const PIXI_MEMORY_FLAG = 'VITE_WORLD_RENDERER';
export const PIXI_MEMORY_FLAG_VALUE = 'pixi';

/** Its own recorded identity, so a flagged build is never mistaken for another. */
export const PIXI_MEMORY_MANIFEST_PATH = 'artifacts/web-artifact-manifest-pixi.json';

/**
 * The recorded-identity scripts.
 *
 * The command form is derived from the script name rather than spelled out, so the
 * CI step and the local command are the same command and there is nothing to drift.
 * The scripts themselves carry the `--out` and `--manifest` flags, and
 * `tests/e2e/pixi-memory-lane.test.ts` asserts that in `package.json`, which is
 * where a change to either half is visible.
 */
export const PIXI_MEMORY_RECORD_SCRIPT = 'record:web-artifact:pixi';
export const PIXI_MEMORY_VERIFY_SCRIPT = 'verify:web-artifact:pixi';
export const PIXI_MEMORY_RECORD_COMMAND = `npm run ${PIXI_MEMORY_RECORD_SCRIPT}`;
export const PIXI_MEMORY_VERIFY_COMMAND = `npm run ${PIXI_MEMORY_VERIFY_SCRIPT}`;

/**
 * The Playwright invocation, spelled once.
 *
 * `package.json` is the one place a Playwright command is written, and both the
 * plain and the `:full` scripts use this same string, so the config this lane owns
 * and the config Playwright actually loads cannot be different files.
 */
export const PIXI_MEMORY_PLAYWRIGHT_COMMAND = `playwright test --config=${PIXI_MEMORY_CONFIG_FILE}`;

/** Its own port, so no two lanes can collide in one worktree. */
export const PIXI_MEMORY_PREVIEW_PORT = 43185;
/**
 * The preview command. A `npx vite preview` invocation rather than an npm script,
 * because the preview belongs to the Playwright config rather than to a command a
 * person runs, and every other lane reaches its port through the same kind of
 * command. The port and `--strictPort` are the parts that matter; the wiring gate
 * asserts both.
 */
export const PIXI_MEMORY_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${PIXI_MEMORY_PREVIEW_PORT} --strictPort`;


/** The job that downloads, previews and measures the artifact. It already has Chromium. */
export const PIXI_MEMORY_CI_JOB = 'browser-smoke';

/**
 * The job that builds, records and uploads the flagged artifact.
 *
 * It cannot be the job that runs the lane: `tests/phase9/memory-gate-wiring.test.ts`
 * asserts this job contains no browser install, and names the property in the
 * test's own title. Splitting the two is what keeps that contract intact.
 */
export const PIXI_MEMORY_CI_BUILD_JOB = 'web-build';

/** The artifact name the flagged build is uploaded and downloaded under. */
export const PIXI_MEMORY_CI_UPLOAD_ARTIFACT = 'pixi-web-artifact';
export const PIXI_MEMORY_CI_UPLOAD_STEP = 'Upload the Pixi-flagged web artifact';
export const PIXI_MEMORY_CI_DOWNLOAD_STEP = 'Download the Pixi-flagged artifact';
export const PIXI_MEMORY_CI_VERIFY_STEP = 'Verify the Pixi-flagged artifact identity';
export const PIXI_MEMORY_CI_STEP_NAME = 'Run the Pixi world mount/unmount memory lane';

/**
 * The npm scripts a person runs this lane through, and the one CI runs.
 *
 * The split is the repository's own: `test:e2e:<lane>` previews an artifact that
 * already exists, `test:e2e:<lane>:full` builds and records it first, and
 * `test:e2e:<lane>:recorded` is the same preview-only script under the name that
 * says the artifact was recorded by something else - which in CI is the `web-build`
 * job, in a different job, in a different runner. CI runs the `:recorded` name for
 * exactly the reason the other flagged lanes do: the job that ran the production
 * Phase 1 suite must not silently rebuild what it just measured.
 */
export const PIXI_MEMORY_LANE_SCRIPT = 'test:e2e:pixi-memory';
export const PIXI_MEMORY_LANE_FULL_SCRIPT = 'test:e2e:pixi-memory:full';
export const PIXI_MEMORY_CI_RUN_SCRIPT = 'test:e2e:pixi-memory:recorded';
export const PIXI_MEMORY_CI_RUN_COMMAND = `npm run ${PIXI_MEMORY_CI_RUN_SCRIPT}`;

export interface PixiMemoryLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-9-pixi-world-memory';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  /** The world renderer this lane is the only browser evidence for. */
  readonly worldRenderer: 'pixi';
  /** Recorded in the evidence for every test in the lane, and true of the artifact. */
  readonly storageRepository: 'v2';
  readonly dataProductsV2: boolean;
  readonly cycles: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: 'pointer-keyboard';
  readonly evidenceClass: 'emulated-viewport';
  readonly ciJob: string;
  readonly ciLane: 'steps-in-the-existing-browser-smoke-job';
  readonly runnerLabels: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const EMULATION_LIMITATIONS = [
  'Not a physical device, ChromeOS, or operating-system version certification.',
  'Not a cross-engine result; Firefox, WebKit, and Edge lanes do not run this spec, so nothing here is evidence about another renderer engine.',
  'Not the production artifact certification: build:web:pixi now produces the Phase 23 cutover default, and this lane records that artifact\'s identity but measures only the world-host mount and unmount memory property, not the application\'s whole release surface.',
  'Not a hardware-GPU result: the WebGL2 context the lane obtains is real, and the evidence records the unmasked renderer string, which in a headless Linux container is a software rasteriser.',
  'Not Electron; native packaging and installer workflows do not satisfy this gate and this lane does not run in them.',
] as const;

const MEASUREMENT_LIMITATIONS = [
  'Not a live-WebGL-context count and not a GPU memory figure: no API in a headless browser reports either, and the built vendor-pixi chunk exports only the four PixiJS symbols this application imports, so Ticker.shared cannot be read from the page. What is asserted is the release-side equivalent - every one of the 20 renderers had its WebGL context explicitly lost at teardown, and every one of its PixiJS Application objects had its renderer and stage nulled by its own destroy.',
  'Not a detector for the PixiJS 8.21.0 CanvasObserver defect, which leaves one unremovable Ticker.shared listener per application when the runtime has no ResizeObserver: the counter that defect moves is unreachable from the built bundle. The lane asserts the precondition the defect needs instead, and records from a run with the global removed that no counter the lane can read changes.',
  'Not a JavaScript heap or DOM residency bound: the heap and Chromium own Nodes and JSEventListeners readings are recorded, and not gated, because a linear leak and a bounded cache are indistinguishable in an estimate that moves by tens between samples and no gate should be built on a coin flip.',
  'Not a page-level unmount: the flagged build has no product control that leaves the world, so a cycle is the host effect being torn down and rebuilt by a live prefers-reduced-motion change, and the React component, the lazy boundary, and the DOM mirror are not unmounted between cycles. The teardown path a cycle exercises is the product own host.unmount().',
  'Not a quiescent-document reading: teardown and the next mount are one synchronous React commit, so there is no instant at which the document can be sampled with no world mounted. The lane asserts the equivalent and stronger fact, zero canvases retained from any earlier cycle at every sample, rather than a literal return to the pre-mount count.',
  'Not a frame-time, 100-room dungeon, or interaction-latency result: the world it mounts is the Phase 9 test world, and plan section 10.2 puts the frame-time target on the dungeon phase.',
  'Not an axe or WCAG result for the world screen; the mirror half of this lane measures the DOM controls a browser can measure, and the semantics were checked in jsdom by tests/phase9/pixi-dom-mirror.test.tsx.',
  'Not an asset-bundle, audio, or share-card result; those are Phases 10 and 20.',
] as const;

export const PIXI_MEMORY_LANE: PixiMemoryLaneDeclaration = Object.freeze({
  schemaVersion: PIXI_MEMORY_LANE_SCHEMA_VERSION,
  suite: 'phase-9-pixi-world-memory',
  project: PIXI_MEMORY_PROJECT,
  testFile: PIXI_MEMORY_TEST_FILE,
  configFile: PIXI_MEMORY_CONFIG_FILE,
  buildScript: PIXI_MEMORY_BUILD_SCRIPT,
  flag: PIXI_MEMORY_FLAG,
  flagValue: PIXI_MEMORY_FLAG_VALUE,
  manifestPath: PIXI_MEMORY_MANIFEST_PATH,
  worldRenderer: 'pixi',
  storageRepository: 'v2',
  dataProductsV2: true,
  cycles: 20,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  ciJob: PIXI_MEMORY_CI_JOB,
  ciLane: 'steps-in-the-existing-browser-smoke-job',
  runnerLabels: ['ubuntu-latest'] as const,
  installTargets: ['chromium'] as const,
  claim:
    'Against a build with VITE_WORLD_RENDERER=pixi, twenty world mount and unmount cycles in real Chromium ' +
    'against a real WebGL2 context create twenty-one PixiJS applications and release twenty of them; at every ' +
    'sample the document holds exactly one world canvas, no canvas from any earlier cycle is still attached, and ' +
    'no earlier cycle WebGL context is still live; a world that has been presented does not grow its drawing ' +
    'surface while it is left idle; the runtime provides ResizeObserver when the renderer is created; and every ' +
    'interaction the world offers is reachable from a labelled, focusable, 44 CSS-pixel control that performs it.',
  doesNotProve: [...EMULATION_LIMITATIONS, ...MEASUREMENT_LIMITATIONS],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validatePixiMemoryLane(
  lane: PixiMemoryLaneDeclaration = PIXI_MEMORY_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (['desktop-chromium', 'storage-v2-chromium', 'data-products-restore-chromium', 'subject-product-chromium', 'reload-persistence-chromium'].includes(lane.project)) {
    problems.push('the pixi memory lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (['currentBuild.spec.ts', 'compatibility.spec.ts', 'storageV2.spec.ts', 'dataProductsRestore.spec.ts', 'subjectProductRoundTrip.spec.ts', 'reloadPersistence.spec.ts'].includes(lane.testFile)) {
    problems.push('the pixi memory lane must not bind an existing suite spec file.');
  }
  if (lane.worldRenderer !== 'pixi') problems.push('the lane must record the pixi world renderer.');
  if (lane.storageRepository !== 'v2') {
    problems.push('build:web:pixi now produces the cutover default, whose storage repository is v2.');
  }
  if (lane.dataProductsV2 !== true) {
    problems.push('build:web:pixi now produces the cutover default, so the data-products flag is on.');
  }
  if (lane.cycles < 20) problems.push('the lane must run at least plan section 10.2 cycle count of 20.');
  if (lane.viewport.width !== 1440 || lane.viewport.height !== 900) {
    problems.push('the lane must use the desktop-chromium-equivalent viewport.');
  }
  if (lane.ciLane !== 'steps-in-the-existing-browser-smoke-job') {
    problems.push('the lane must declare that it runs as a step in the existing browser-smoke job.');
  }
  if (lane.runnerLabels.length === 0) problems.push('the lane must declare a runner label.');
  if (lane.installTargets.length === 0) problems.push('the lane must declare a browser install target.');
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 8) problems.push('the lane must declare a does-not-prove list.');
  for (const limitation of lane.doesNotProve) {
    if (limitation.trim().length < 20) problems.push('a does-not-prove entry is too short to be a boundary.');
  }
  return problems;
}

/**
 * The preflight both Pixi lanes run before Playwright starts.
 *
 * It exists as a command rather than as a guard at the top of a config, and the
 * reason is recorded in the script's own header: a module-scope `throw` made
 * `tests/e2e/pixi-memory-lane.test.ts` — which imports the config to assert its
 * shape — fail in any checkout without a built artifact, including the
 * `unit-tests` CI job, which has none and never should. The config modules are
 * therefore importable and side-effect free, and the check runs only when a person
 * or CI actually invokes a lane. That is what makes a missing artifact a one-line
 * diagnosis instead of a 180-second webServer timeout, without making the config
 * depend on a `dist/`.
 */
export const PIXI_LANE_PREFLIGHT_SCRIPT = 'require-pixi-lane-artifact.mjs';
export const PIXI_LANE_PREFLIGHT_COMMAND = `node scripts/${PIXI_LANE_PREFLIGHT_SCRIPT}`;

/*
 * ── The canvas-pointer gate ───────────────────────────────────────────────────
 *
 * A second lane over the same Pixi-flagged artifact, and a separate one on purpose.
 * Its concern is not memory but the pointer route: a canvas press changes the
 * world, and the DOM mirror is the only place a screen-reader user can learn that
 * it did. The shipped Phase 9 build got that wrong — the bell's `pointertap`
 * handler called the scene's own `activate`, so the world changed and the host,
 * which is the only thing that calls `publishState()`, never heard about it.
 *
 * Three gates missed it, and each for a reason worth remembering: a synthetic
 * `bell.emit('pointertap', …)` that calls the listener directly and never enters
 * PixiJS's event system; a `listenerCount('pointertap') === 1` assertion, which a
 * listener that never fires satisfies; and a browser lane that exercised keyboard
 * and the DOM control and never clicked the canvas. So this lane is the one that
 * clicks the canvas, in a real engine, and reads the mirror's real text.
 *
 * It is a lane of its own rather than a ninth test in the memory spec for two
 * reasons, both of which are load-bearing. `PIXI_MEMORY_LANE.testFile` is the
 * memory lane's `testMatch` and its eight-test count is asserted, so adding to it
 * breaks a gate that works. And widening that `testMatch` would file a
 * non-memory test's evidence under the memory lane's name, inside the CI upload
 * allowlist.
 */
export const PIXI_POINTER_LANE = {
  schemaVersion: 1,
  suite: 'phase-9-pixi-canvas-pointer',
  project: 'pixi-pointer-chromium',
  testDir: 'tests/phase9/browser',
  testFile: 'pixi-canvas-pointer.spec.ts',
  configFile: 'tests/e2e/playwright.pixi-pointer.config.ts',
  /** The build and the recorded identity belong to CI and to the local command
   *  sequence. A lane that could decide for itself whether to rebuild could end up
   *  measuring a different artifact than the one that was recorded. */
  buildScript: PIXI_MEMORY_BUILD_SCRIPT,
  recordScript: 'record:web-artifact:pixi',
  verifyScript: 'verify:web-artifact:pixi',
  manifestPath: PIXI_MEMORY_LANE.manifestPath,
  flag: 'VITE_WORLD_RENDERER',
  flagValue: 'pixi',
  /** Same viewport and input mode as the memory lane, so a failure in one is not
   *  an artefact of a different setup. */
  viewport: PIXI_MEMORY_LANE.viewport,
  deviceScaleFactor: PIXI_MEMORY_LANE.deviceScaleFactor,
  inputMode: PIXI_MEMORY_LANE.inputMode,
  evidenceClass: PIXI_MEMORY_LANE.evidenceClass,
  timeout: 60_000,
  ciJob: PIXI_MEMORY_CI_JOB,
  installTargets: PIXI_MEMORY_LANE.installTargets,
  claim: 'A real click on the real canvas changes the DOM mirror status a screen reader would announce.',
  doesNotProve: [
    'Not a touch-platform result: the press is a Playwright mouse click, not a real touch tap.',
    'Not a cross-engine result: Chromium only, matching the memory lane.',
    'Not a hardware-GPU result, and not a frame-time or memory result of any kind.',
    'Not a claim about any world other than the Phase 9 test world.',
  ],
} as const;

/** Its own port, so the two lanes cannot contend for one preview server in a job. */
export const PIXI_POINTER_PREVIEW_PORT = 43187;
export const PIXI_POINTER_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${PIXI_POINTER_PREVIEW_PORT} --strictPort`;
