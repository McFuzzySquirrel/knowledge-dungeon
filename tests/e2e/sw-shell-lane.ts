/**
 * Phase 22 service-worker-enabled compatibility lane declaration.
 *
 * The machine-readable source for the browser proof that the offline shell still
 * behaves as a strict same-origin static client when the service worker is enabled
 * rather than blocked. Imported by `tests/e2e/playwright.sw-shell.config.ts` and
 * `tests/e2e/swShellCompatibility.spec.ts`, and checked against the real build
 * scripts, the real npm scripts, the real Playwright project, and the real CI steps
 * by `tests/e2e/sw-shell-lane.test.ts`.
 *
 * ## What this lane is, and why it is separate from the offline lane
 *
 * The plan's Phase 22 scope has two distinct requirements that are easy to
 * conflate:
 *
 *   - "Add a versioned service worker ... for offline reload" - the offline lane
 *     proves the reload guarantee, the data survival, and the cache contents.
 *   - "Add service-worker-enabled compatibility projects without globally relaxing
 *     the privacy network policy" - this lane. It is not another reload proof.
 *
 * This lane answers exactly one question the offline lane does not: with the worker
 * *enabled* (not blocked), does the application still make only the same-origin
 * static requests the privacy policy permits? The offline lane observes off-origin
 * traffic only; this lane runs the full `compat-evidence` classification over every
 * request the page makes - external origin, application endpoint (`/api/`,
 * `/uploads/`, analytics/telemetry/remote-config), non-idempotent method, external
 * blob, and non-static local path - and asserts that enabling the worker introduces
 * none of them.
 *
 * ## Why it is a *compatibility* lane, and how it stays honest about the host
 *
 * It is a `compat-*`-shaped lane: an engine-automation project over one recorded
 * artifact, with an explicit host approval list and the shared
 * `decideLaneOutcome` host-not-approved mechanism. It is deliberately **not** added
 * to `tests/e2e/support-matrix.ts`: that matrix owns the Phase 1A cross-engine
 * production-artifact cells, and this lane previews a flagged build. Adding it there
 * would also break the "one project per matrix entry" contract the matrix test
 * enforces. A host this lane is not approved for is skipped as not-selected
 * evidence locally and fails on a runner - never a silent pass.
 *
 * ## The one deliberate policy difference, and where it stops
 *
 * This lane and the offline lane are the only two lanes whose Playwright `use`
 * sets `serviceWorkers: 'allow'`, and each does so only for its own project. The
 * global `playwright.config.ts`, every other lane's config, and the Phase 1 network
 * spy keep `serviceWorkers: 'block'`. Neither lane reads, changes, or relaxes
 * another lane's policy. See `tests/e2e/sw-shell-lane.test.ts`, which asserts the
 * `'allow'` census over the whole config directory rather than trusting this prose.
 *
 * ## Which artifact, and why no second build
 *
 * It previews the **same flagged artifact the offline lane previews** - the build
 * produced by `build:web:offline` and recorded to
 * `artifacts/web-artifact-manifest-offline.json`. `VITE_OFFLINE_SHELL` is a
 * build-time flag, so the worker only exists in that artifact; a second build would
 * be the duplication the one-artifact rule forbids. `buildScript` here is therefore
 * the offline lane's build script, not a script of its own.
 *
 * Privacy: this file contains no learner data, no request data, no credentials, and
 * no URL. Every value it names is a project, a step, a port, a build-script name, a
 * manifest path, or a bounded claim.
 */

import {
  OFFLINE_LANE_BUILD_SCRIPT,
  OFFLINE_LANE_CI_BUILD_JOB,
  OFFLINE_LANE_CI_DOWNLOAD_STEP,
  OFFLINE_LANE_CI_JOB,
  OFFLINE_LANE_CI_UPLOAD_ARTIFACT,
  OFFLINE_LANE_CI_UPLOAD_STEP,
  OFFLINE_LANE_CI_VERIFY_STEP,
  OFFLINE_LANE_MANIFEST_PATH,
  OFFLINE_LANE_PREFLIGHT_COMMAND,
} from './offline-lane';

export const SW_SHELL_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const SW_SHELL_PROJECT = 'offline-shell-sw-compat-chromium';

/** The only spec this lane may run. */
export const SW_SHELL_TEST_FILE = 'swShellCompatibility.spec.ts';
export const SW_SHELL_TEST_PATH = `tests/e2e/${SW_SHELL_TEST_FILE}`;

/** The Playwright config that owns the lane. Under `tests/e2e/` for the same
 *  TypeScript-project reason the offline, Pixi and Phase 10 configs record. */
export const SW_SHELL_CONFIG_FILE = 'tests/e2e/playwright.sw-shell.config.ts';
export const SW_SHELL_CONFIG_BASENAME = 'playwright.sw-shell.config.ts';

/** The same flagged build and recorded identity the offline lane uses. */
export const SW_SHELL_BUILD_SCRIPT = OFFLINE_LANE_BUILD_SCRIPT;
export const SW_SHELL_MANIFEST_PATH = OFFLINE_LANE_MANIFEST_PATH;
/** The build-time flag whose artifact this lane is the compatibility evidence for. */
export const SW_SHELL_FLAG = 'VITE_OFFLINE_SHELL';
export const SW_SHELL_FLAG_VALUE = 'true';

/** Its own port, so it cannot contend with the offline lane or any other preview. */
export const SW_SHELL_PREVIEW_PORT = 43209;
export const SW_SHELL_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${SW_SHELL_PREVIEW_PORT} --strictPort`;

/**
 * The preflight this lane shares with the offline lane.
 *
 * It is a command rather than a guard at the top of the config, for the reason the
 * offline lane records: a module-scope `throw` would make importing the config fatal
 * in a checkout with no build, including the `unit-tests` CI job. It checks the same
 * artifact this lane previews, so there is one preflight for one artifact.
 */
export const SW_SHELL_PREFLIGHT_COMMAND = OFFLINE_LANE_PREFLIGHT_COMMAND;

/** The Playwright invocation, spelled once. */
export const SW_SHELL_PLAYWRIGHT_COMMAND = `playwright test --config=${SW_SHELL_CONFIG_FILE}`;

/** The npm scripts a person runs this lane through, and the one CI runs. */
export const SW_SHELL_LANE_SCRIPT = 'test:e2e:sw-shell';
export const SW_SHELL_LANE_FULL_SCRIPT = 'test:e2e:sw-shell:full';
export const SW_SHELL_CI_RUN_SCRIPT = 'test:e2e:sw-shell:recorded';
export const SW_SHELL_CI_RUN_COMMAND = `npm run ${SW_SHELL_CI_RUN_SCRIPT}`;

/**
 * The job that previews and measures the artifact. It already has Chromium.
 *
 * The artifact name, both step names, and the identity-check step name are the
 * offline lane's, imported rather than retyped: there is one upload and one download
 * for one artifact, and two spellings of either name would be two things to keep in
 * step.
 */
export const SW_SHELL_CI_JOB = OFFLINE_LANE_CI_JOB;
/** The job that builds, records and uploads the flagged artifact. */
export const SW_SHELL_CI_BUILD_JOB = OFFLINE_LANE_CI_BUILD_JOB;
/** The artifact name both lanes download. */
export const SW_SHELL_CI_UPLOAD_ARTIFACT = OFFLINE_LANE_CI_UPLOAD_ARTIFACT;
export const SW_SHELL_CI_UPLOAD_STEP = OFFLINE_LANE_CI_UPLOAD_STEP;
export const SW_SHELL_CI_DOWNLOAD_STEP = OFFLINE_LANE_CI_DOWNLOAD_STEP;
export const SW_SHELL_CI_VERIFY_STEP = OFFLINE_LANE_CI_VERIFY_STEP;
/** This lane's own CI step, distinct from the offline lane's. */
export const SW_SHELL_CI_STEP_NAME = 'Run the Phase 22 service-worker compatibility lane';

/** Hosts this lane is approved to run on. Chromium on the Linux CI runner. */
export const SW_SHELL_HOST_OPERATING_SYSTEMS = ['linux'] as const;

export interface SwShellLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-22-service-worker-compatibility';
  readonly project: string;
  readonly testFile: string;
  readonly testPath: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly manifestPath: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly worldRenderer: 'phaser';
  readonly storageRepository: 'v2';
  readonly engine: 'chromium';
  readonly channel: 'playwright-bundled';
  readonly evidenceClass: 'engine-automation';
  readonly hostOperatingSystems: readonly string[];
  readonly installTargets: readonly 'chromium'[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly inputMode: 'pointer-keyboard';
  readonly ciJob: string;
  readonly ciBuildJob: string;
  readonly ciLane: 'steps-in-the-existing-browser-smoke-job';
  readonly runnerLabels: readonly string[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

const LIMITATIONS = [
  'Not a cross-engine result: Chromium only. No Firefox, WebKit, or Edge project runs this spec.',
  'Not a physical-device or ChromeOS certification; the viewport is emulated.',
  'Not a comparison against the pre-cutover stack: this artifact and the Phase 23 production default both enable the offline shell and use storage-v2.',
  'Not a reload, data-survival, or cache-content proof; the offline lane owns those and this lane makes no claim about them.',
  'Not an offline write queue, background sync, runtime caching, push, install-prompt, or offline-editing result; the locked Phase 22 scope is the reload guarantee only.',
  'Not a WebGPU, GPU-memory, or frame-time result of any kind.',
  'Not a substitute for the Phase 1 network spy or the compatibility suite; it checks the worker-enabled build, and the production lanes keep their own privacy evidence.',
  'Not a certification that every host in the support matrix is covered; the lane declares the one host it is approved for and skips any other as not-selected evidence.',
] as const;

export const SW_SHELL_LANE: SwShellLaneDeclaration = Object.freeze({
  schemaVersion: SW_SHELL_LANE_SCHEMA_VERSION,
  suite: 'phase-22-service-worker-compatibility',
  project: SW_SHELL_PROJECT,
  testFile: SW_SHELL_TEST_FILE,
  testPath: SW_SHELL_TEST_PATH,
  configFile: SW_SHELL_CONFIG_FILE,
  buildScript: SW_SHELL_BUILD_SCRIPT,
  manifestPath: SW_SHELL_MANIFEST_PATH,
  flag: SW_SHELL_FLAG,
  flagValue: SW_SHELL_FLAG_VALUE,
  worldRenderer: 'phaser',
  storageRepository: 'v2',
  engine: 'chromium',
  channel: 'playwright-bundled',
  evidenceClass: 'engine-automation',
  hostOperatingSystems: SW_SHELL_HOST_OPERATING_SYSTEMS,
  installTargets: ['chromium'] as const,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  inputMode: 'pointer-keyboard',
  ciJob: SW_SHELL_CI_JOB,
  ciBuildJob: SW_SHELL_CI_BUILD_JOB,
  ciLane: 'steps-in-the-existing-browser-smoke-job',
  runnerLabels: ['ubuntu-latest'] as const,
  claim:
    'Against the recorded offline-shell-flagged build, in real Chromium with service workers ' +
    'enabled rather than blocked: the shell loads and remains interactive, the worker registers ' +
    'and controls the page, and every request the journey makes is one the Phase 1A network ' +
    'policy permits - same-origin GET to the document or a build-time shell asset, with no ' +
    'off-origin request, no analytics, telemetry, remote-config, or upload destination, no ' +
    'non-idempotent method, and no WebSocket. Enabling the worker introduces no new network ' +
    'destination of any kind.',
  doesNotProve: LIMITATIONS,
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validateSwShellLane(
  lane: SwShellLaneDeclaration = SW_SHELL_LANE,
): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (
    [
      'offline-shell-chromium',
      'pixi-world-memory-chromium',
      'pixi-pointer-chromium',
      'phase10-media-chromium',
      'storage-v2-chromium',
      'data-products-restore-chromium',
      'subject-product-chromium',
      'reload-persistence-chromium',
    ].includes(lane.project)
  ) {
    problems.push('the sw-shell lane must not reuse another lane project name.');
  }
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (lane.testFile !== SW_SHELL_TEST_FILE) problems.push('the lane must bind its own spec.');
  if (lane.testFile === 'offline.spec.ts') problems.push('the lane must not widen the offline spec.');
  // The one-artifact rule: the lane reuses the offline lane's build and identity.
  if (lane.buildScript !== OFFLINE_LANE_BUILD_SCRIPT) {
    problems.push('the lane must build with the offline lane build script, not a script of its own.');
  }
  if (lane.manifestPath !== OFFLINE_LANE_MANIFEST_PATH) {
    problems.push('the lane must verify the offline lane recorded identity, not one of its own.');
  }
  if (lane.hostOperatingSystems.length === 0) {
    problems.push('the lane must declare at least one approved host.');
  }
  if (lane.installTargets.length === 0) {
    problems.push('the lane must declare a browser install target.');
  }
  if (lane.evidenceClass !== 'engine-automation') {
    problems.push('the lane is engine automation, not a physical-device or viewport claim.');
  }
  if (lane.ciJob !== SW_SHELL_CI_JOB) {
    problems.push('the lane must run as a step in the existing browser-smoke job.');
  }
  if (lane.ciLane !== 'steps-in-the-existing-browser-smoke-job') {
    problems.push('the lane must declare that it runs as a step in the existing browser-smoke job.');
  }
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 8) problems.push('the lane must declare a does-not-prove list.');
  for (const limitation of lane.doesNotProve) {
    if (limitation.trim().length < 20) problems.push('a does-not-prove entry is too short to be a boundary.');
  }
  return problems;
}
