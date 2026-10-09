/**
 * Phase 22 frame-time and interaction-latency browser lane declaration.
 *
 * The machine-readable source for the second half of the Phase 22 performance work:
 * the runtime half that `scripts/check-performance.mjs` explicitly declares it does
 * not measure. That gate reads a directory of files; this lane mounts the real PixiJS
 * dungeon world in real Chromium against deterministic 1-, 10-, and 100-room fixtures
 * and **reports** frame time and interaction acknowledgement.
 *
 * ## Measurement, not certification
 *
 * The Phase 22 scope lock rules that "software-WebGL Chromium in CI is a floor; the
 * 60 FPS / p95 below 20 ms target is not certified until a real-GPU reference
 * environment runs it, and that check is carried to Phase 23." Everything here keeps
 * that distinction: the reference targets are declared and recorded, and the run is
 * gated only against deliberately generous **CI regression floors** that catch a
 * catastrophic regression. The floors live in `pixi-perf-series.ts`.
 *
 * ## Why a *flagged* build, and why it is the Pixi-dungeon one
 *
 * The PixiJS dungeon world is only reachable in the artifact when `VITE_PIXI_DUNGEON=true`
 * (`GameScreen`'s build-time switch) **and** the world host is on Phaser, because
 * `VITE_WORLD_RENDERER=pixi` routes the world screen to the Phase 9 test host rather than to
 * `GameScreen`. `build:web:pixi-dungeon` pins both: the dungeon switch on, the host phaser,
 * and the other two Pixi world switches off. The Phase 9 `pixi-web-artifact` therefore cannot
 * serve - it contains no dungeon to measure. So this lane needs an isolated flagged artifact of
 * its own, with its own recorded identity.
 *
 * ## What it does and does not prove
 *
 * It proves that, against a `VITE_PIXI_DUNGEON=true` build, the application's own
 * Start-Tutorial → dungeon route mounts a synthetic 1-, 10-, and 100-room world in real
 * Chromium, that the world draws a non-trivial number of frames, that a world
 * interaction is acknowledged by the DOM mirror within a bounded time, and that those
 * numbers clear a generous regression floor. Everything it cannot prove is in
 * `doesNotProve`.
 */

export const PIXI_PERF_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const PIXI_PERF_PROJECT = 'pixi-perf-chromium';

/** The only spec this lane may run. */
export const PIXI_PERF_TEST_FILE = 'pixiPerf.spec.ts';
export const PIXI_PERF_TEST_PATH = `tests/e2e/${PIXI_PERF_TEST_FILE}`;

/** The Playwright config that owns the lane. */
export const PIXI_PERF_CONFIG_FILE = 'tests/e2e/playwright.pixi-perf.config.ts';
export const PIXI_PERF_CONFIG_BASENAME = 'playwright.pixi-perf.config.ts';

/** The build script that produces the artifact this lane previews. */
export const PIXI_PERF_BUILD_SCRIPT = 'build:web:pixi-dungeon';

/** The build-time flag this lane is the browser evidence for. */
export const PIXI_PERF_FLAG = 'VITE_PIXI_DUNGEON';
export const PIXI_PERF_FLAG_VALUE = 'true';

/** Its own recorded identity, so it is never mistaken for another lane's build. */
export const PIXI_PERF_MANIFEST_PATH = 'artifacts/web-artifact-manifest-pixi-dungeon.json';

/**
 * The recorded-identity scripts, spelled once.
 *
 * The command form is derived from the script name rather than spelled out, so the CI
 * step and the local command are the same command.
 */
export const PIXI_PERF_RECORD_SCRIPT = 'record:web-artifact:pixi-dungeon';
export const PIXI_PERF_VERIFY_SCRIPT = 'verify:web-artifact:pixi-dungeon';
export const PIXI_PERF_RECORD_COMMAND = `npm run ${PIXI_PERF_RECORD_SCRIPT}`;
export const PIXI_PERF_VERIFY_COMMAND = `npm run ${PIXI_PERF_VERIFY_SCRIPT}`;

/** Its own port, so no two lanes can collide in one worktree. */
export const PIXI_PERF_PREVIEW_PORT = 43217;
/** The preview this lane serves, and never builds. */
export const PIXI_PERF_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${PIXI_PERF_PREVIEW_PORT} --strictPort`;

/**
 * The preflight this lane runs before Playwright starts.
 *
 * A command rather than a guard at the top of the config, for the reason the Pixi
 * lanes record: a module-scope throw would make importing a config fatal in a
 * checkout with no build, including the unit-test job.
 */
export const PIXI_PERF_PREFLIGHT_COMMAND =
  'node scripts/require-pixi-perf-lane-artifact.mjs';

/**
 * The CI wiring this artifact owns.
 *
 * The upload lives in `web-build` and the download lives in `browser-smoke`, where the
 * single Chromium install already exists. The artifact is moved through the shared
 * transfer declaration in `tests/e2e/artifact-transfer-wiring.ts`, not a count.
 */
export const PIXI_PERF_CI_JOB = 'browser-smoke';
export const PIXI_PERF_CI_BUILD_JOB = 'web-build';
export const PIXI_PERF_CI_UPLOAD_ARTIFACT = 'pixi-dungeon-web-artifact';
export const PIXI_PERF_CI_BUILD_STEP = 'Build the Phase 22 Pixi-dungeon performance fixture artifact';
export const PIXI_PERF_CI_UPLOAD_STEP = 'Upload the Pixi-dungeon-flagged web artifact';
export const PIXI_PERF_CI_DISCARD_STEP = 'Discard the offline-shell dist before the Pixi-dungeon download';
export const PIXI_PERF_CI_DOWNLOAD_STEP = 'Download the Pixi-dungeon-flagged artifact';
export const PIXI_PERF_CI_VERIFY_STEP = 'Verify the Pixi-dungeon-flagged artifact identity';
export const PIXI_PERF_CI_RUN_STEP = 'Run the Phase 22 Pixi dungeon frame-time lane';
export const PIXI_PERF_CI_RUN_SCRIPT = 'test:e2e:pixi-perf:recorded';
export const PIXI_PERF_CI_RUN_COMMAND = `npm run ${PIXI_PERF_CI_RUN_SCRIPT}`;

export interface PixiPerfLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-22-pixi-dungeon-frame-time';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  readonly worldRenderer: 'phaser';
  readonly pixiDungeon: true;
  readonly storageRepository: 'v2';
  readonly roomCounts: readonly number[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: 'pointer-keyboard';
  readonly evidenceClass: 'emulated-viewport';
  readonly ciJob: string;
  readonly ciLane: 'steps-in-the-existing-browser-smoke-job';
  readonly installTargets: readonly 'chromium'[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const EMULATION_LIMITATIONS = [
  'Not a physical-device or ChromeOS certification; the viewport is emulated.',
  'Not a cross-engine result: Chromium only, and no Firefox, WebKit, or Edge lane runs this spec.',
  'Not a comparison against the pre-cutover stack: `build:web:pixi-dungeon` pins the Phaser host so the dungeon stays reachable, and its storage and data-product flags are the Phase 23 defaults.',
  'Not a hardware-GPU result, and not a certification of the plan\'s 60 FPS / p95 < 20 ms target; CI software WebGL is a floor, and the real-GPU check is carried to Phase 23.',
  'Not Electron; native packaging does not satisfy this gate and this lane does not run in it.',
] as const;

const MEASUREMENT_LIMITATIONS = [
  'Not a browser-profiler trace: frame time is measured from requestAnimationFrame deltas in the page, which is the cadence a learner sees, not the GPU\'s own per-frame cost.',
  'Not a GPU or canvas memory measurement; the Phase 9 memory lane owns that.',
  'Not an interaction-correctness result: the lane times how quickly the DOM mirror acknowledges one world action, not whether every world action is correct.',
  'Not a claim that a synthetic 100-room fixture is representative of every authored subject; it is a deterministic, reproducible stress case.',
  'Not a measure of the Welcome route, the village, the fishing pond, or any world other than the PixiJS dungeon.',
] as const;

export const PIXI_PERF_LANE: PixiPerfLaneDeclaration = Object.freeze({
  schemaVersion: PIXI_PERF_LANE_SCHEMA_VERSION,
  suite: 'phase-22-pixi-dungeon-frame-time',
  project: PIXI_PERF_PROJECT,
  testFile: PIXI_PERF_TEST_FILE,
  configFile: PIXI_PERF_CONFIG_FILE,
  buildScript: PIXI_PERF_BUILD_SCRIPT,
  flag: PIXI_PERF_FLAG,
  flagValue: PIXI_PERF_FLAG_VALUE,
  manifestPath: PIXI_PERF_MANIFEST_PATH,
  worldRenderer: 'phaser',
  pixiDungeon: true,
  storageRepository: 'v2',
  roomCounts: Object.freeze([1, 10, 100] as const),
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  evidenceClass: 'emulated-viewport',
  ciJob: PIXI_PERF_CI_JOB,
  ciLane: 'steps-in-the-existing-browser-smoke-job',
  installTargets: ['chromium'] as const,
  claim:
    'Against a Chromium build with VITE_PIXI_DUNGEON=true, the application\'s own Start-Tutorial → dungeon route ' +
    'mounts the real PixiJS dungeon world over deterministic synthetic 1-, 10-, and 100-room subjects; each world ' +
    'draws a non-trivial number of frames, its PixiJS ticker advances, the DOM mirror lists exactly the fixture\'s ' +
    'room count, and a world action is acknowledged by the DOM mirror — with the measured p95 frame time, mean FPS, ' +
    'and slowest interaction latency reported against a declared reference environment and a generous CI regression ' +
    'floor rather than certified against the plan\'s real-GPU target.',
  doesNotProve: [...EMULATION_LIMITATIONS, ...MEASUREMENT_LIMITATIONS],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validatePixiPerfLane(lane: PixiPerfLaneDeclaration = PIXI_PERF_LANE): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (lane.testFile !== PIXI_PERF_TEST_FILE) problems.push('the lane must bind its own spec.');
  if (lane.worldRenderer !== 'phaser') {
    problems.push('the Pixi dungeon build leaves VITE_WORLD_RENDERER at its phaser default.');
  }
  if (lane.pixiDungeon !== true) problems.push('the lane must record the Pixi dungeon flag as on.');
  if (lane.roomCounts.length !== 3 || !lane.roomCounts.includes(100)) {
    problems.push('the lane must measure the 1-, 10-, and 100-room fixtures.');
  }
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 8) problems.push('the lane must declare a does-not-prove list.');
  return problems;
}
