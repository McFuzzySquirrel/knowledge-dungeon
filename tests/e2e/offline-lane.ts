/**
 * Phase 22 offline static-shell browser lane declaration.
 *
 * The machine-readable source for the Chromium-only proof that a previously loaded
 * app reloads with no network, renders the shell, keeps its storage-v2 IndexedDB
 * data, caches only build-time shell assets, and purges a stale cache after a
 * version bump. Imported by `tests/e2e/playwright.offline.config.ts` and
 * `tests/e2e/offline.spec.ts`, and checked against the real build and record
 * scripts by `tests/e2e/offline-lane.test.ts`.
 *
 * ## Why this lane allows service workers, and which other lane does
 *
 * Every other lane sets `serviceWorkers: 'block'`, and that is correct for them: a
 * lane that is measuring the application's network behavior must not have a worker
 * interposing on it. This lane's subject *is* the worker, so it sets
 * `serviceWorkers: 'allow'` for its own project only. One companion lane does the
 * same for the same reason - `tests/e2e/playwright.sw-shell.config.ts`, which proves
 * the worker-enabled build still obeys the privacy network policy. Neither changes
 * the global Playwright config, any other lane's config, or the Phase 1 network spy,
 * all of which keep `serviceWorkers: 'block'`.
 *
 * ## What it does and does not prove
 *
 * It proves the minimum offline scope locked for Phase 22 and nothing broader: no
 * offline write queue, no background sync, no runtime caching, no push, no install
 * prompt, no offline editing, and no cross-engine or physical-device claim.
 */

export const OFFLINE_LANE_SCHEMA_VERSION = 1;

/** Playwright project name. Must be unique across every config in the repository. */
export const OFFLINE_LANE_PROJECT = 'offline-shell-chromium';

/** The only spec this lane may run. */
export const OFFLINE_LANE_TEST_FILE = 'offline.spec.ts';
export const OFFLINE_LANE_TEST_PATH = `tests/e2e/${OFFLINE_LANE_TEST_FILE}`;

/** The Playwright config that owns the lane. */
export const OFFLINE_LANE_CONFIG_FILE = 'tests/e2e/playwright.offline.config.ts';
export const OFFLINE_LANE_CONFIG_BASENAME = 'playwright.offline.config.ts';

/** The build script that produces the artifact this lane previews. */
export const OFFLINE_LANE_BUILD_SCRIPT = 'build:web:offline';
/** The build mode the script uses; `.env.storage-v2` supplies the storage flag. */
export const OFFLINE_LANE_BUILD_MODE = 'storage-v2';
/** The build-time flag this lane is the browser evidence for. */
export const OFFLINE_LANE_FLAG = 'VITE_OFFLINE_SHELL';
export const OFFLINE_LANE_FLAG_VALUE = 'true';
/** Its own recorded identity, so it is never mistaken for another lane's build. */
export const OFFLINE_LANE_MANIFEST_PATH = 'artifacts/web-artifact-manifest-offline.json';

/** The generated shell manifest the worker imports, relative to the deploy base. */
export const OFFLINE_SHELL_MANIFEST_FILENAME = 'offline-shell-manifest.js';
/** Every cache this worker owns uses this prefix. */
export const OFFLINE_SHELL_CACHE_PREFIX = 'kd-offline-shell-';

/** Its own port, so no two lanes can collide in one worktree. */
export const OFFLINE_LANE_PREVIEW_PORT = 43207;
/** The preview this lane serves, and never builds. */
export const OFFLINE_LANE_PREVIEW_SCRIPT = `npx vite preview --host 127.0.0.1 --port ${OFFLINE_LANE_PREVIEW_PORT} --strictPort`;

/**
 * The recorded-identity scripts, spelled once.
 *
 * The command form is derived from the script name rather than spelled out, so the
 * CI step and the local command are the same command.
 */
export const OFFLINE_LANE_RECORD_SCRIPT = 'record:web-artifact:offline';
export const OFFLINE_LANE_VERIFY_SCRIPT = 'verify:web-artifact:offline';
export const OFFLINE_LANE_RECORD_COMMAND = `npm run ${OFFLINE_LANE_RECORD_SCRIPT}`;
export const OFFLINE_LANE_VERIFY_COMMAND = `npm run ${OFFLINE_LANE_VERIFY_SCRIPT}`;

/**
 * The preflight both offline-artifact lanes run before Playwright starts.
 *
 * It is a command rather than a guard at the top of a config, for the reason the
 * Pixi lanes record: a module-scope `throw` would make importing a config fatal in a
 * checkout with no build, including the `unit-tests` CI job. It checks the one
 * artifact both lanes preview.
 */
export const OFFLINE_LANE_PREFLIGHT_COMMAND = 'node scripts/require-offline-lane-artifact.mjs';

/**
 * The CI wiring this artifact owns, shared with the service-worker compatibility
 * lane that previews the same build.
 *
 * The upload lives in `web-build` and both downloads live in `browser-smoke`. The
 * two lanes are separate steps; the artifact and its identity check are one.
 */
export const OFFLINE_LANE_CI_JOB = 'browser-smoke';
export const OFFLINE_LANE_CI_BUILD_JOB = 'web-build';
export const OFFLINE_LANE_CI_UPLOAD_ARTIFACT = 'offline-shell-web-artifact';
export const OFFLINE_LANE_CI_UPLOAD_STEP = 'Upload the offline-shell-flagged web artifact';
export const OFFLINE_LANE_CI_DOWNLOAD_STEP = 'Download the offline-shell-flagged artifact';
export const OFFLINE_LANE_CI_VERIFY_STEP = 'Verify the offline-shell-flagged artifact identity';
/** This lane's own CI step, distinct from the compatibility lane's. */
export const OFFLINE_LANE_CI_RUN_STEP = 'Run the Phase 22 offline-shell lane';
export const OFFLINE_LANE_CI_RUN_SCRIPT = 'test:e2e:offline:recorded';
export const OFFLINE_LANE_CI_RUN_COMMAND = `npm run ${OFFLINE_LANE_CI_RUN_SCRIPT}`;

/**
 * Path fragments that would mean learner data had been cached. The lane asserts no
 * cache key matches any of them; the list is the plan's list of things the cache
 * must never contain, plus the two server-data routes.
 */
export const LEARNER_DATA_PATH_MARKERS = Object.freeze([
  'subject',
  'note',
  'attachment',
  'progression',
  'statistic',
  'preference',
  'assistance',
  '/api/',
  '/uploads/',
] as const);

export interface OfflineLaneDeclaration {
  readonly schemaVersion: number;
  readonly suite: 'phase-22-offline-static-shell';
  readonly project: string;
  readonly testFile: string;
  readonly configFile: string;
  readonly buildScript: string;
  readonly buildMode: string;
  readonly flag: string;
  readonly flagValue: string;
  readonly manifestPath: string;
  readonly storageRepository: 'v2';
  readonly evidenceClass: 'emulated-viewport';
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly hasTouch: boolean;
  readonly installTargets: readonly 'chromium'[];
  readonly claim: string;
  readonly doesNotProve: readonly string[];
}

export const OFFLINE_LANE: OfflineLaneDeclaration = Object.freeze({
  schemaVersion: OFFLINE_LANE_SCHEMA_VERSION,
  suite: 'phase-22-offline-static-shell',
  project: OFFLINE_LANE_PROJECT,
  testFile: OFFLINE_LANE_TEST_FILE,
  configFile: OFFLINE_LANE_CONFIG_FILE,
  buildScript: OFFLINE_LANE_BUILD_SCRIPT,
  buildMode: OFFLINE_LANE_BUILD_MODE,
  flag: OFFLINE_LANE_FLAG,
  flagValue: OFFLINE_LANE_FLAG_VALUE,
  manifestPath: OFFLINE_LANE_MANIFEST_PATH,
  storageRepository: 'v2',
  evidenceClass: 'emulated-viewport',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: false,
  installTargets: ['chromium'] as const,
  claim:
    'Against a Chromium build with VITE_OFFLINE_SHELL=true and ' +
    'VITE_STORAGE_REPOSITORY=v2, a previously loaded app survives a reload with the ' +
    'browser offline: the shell renders, a subject created through the Welcome form is ' +
    'still listed from its storage-v2 IndexedDB record, every Cache Storage key is a ' +
    'build-time shell asset rather than a learner-data path, and a version-bump rebuild ' +
    'deletes the previous versioned cache.',
  doesNotProve: [
    'Not a cross-engine result: Chromium only, and no Firefox, WebKit, or Edge lane runs this spec.',
    'Not a physical-device or ChromeOS certification; the viewport is emulated.',
    'Not a comparison against the pre-cutover stack: this artifact and the Phase 23 production default both enable the offline shell and use storage-v2.',
    'Not an offline write queue, background sync, runtime caching, push, install, or offline-editing result; the locked Phase 22 scope is the reload guarantee only.',
    'Not a claim that the world assets or a lazy route beyond the welcome shell are available offline.',
    'Not a cold-start-from-nothing result: the app must have been loaded online once for the shell to be cached.',
    'Not a hard network-privacy audit of the whole app; the separate privacy and compatibility lanes hold that, and this lane only checks that enabling the worker introduces no off-origin request.',
  ],
});

/** Structural problems with the lane declaration. Empty means consistent. */
export function validateOfflineLane(lane: OfflineLaneDeclaration = OFFLINE_LANE): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9-]+$/.test(lane.project)) problems.push('project name must be lowercase kebab-case.');
  if (!lane.testFile.endsWith('.spec.ts')) problems.push('the lane must bind a .spec.ts file.');
  if (lane.testFile !== OFFLINE_LANE_TEST_FILE) problems.push('the lane must bind its own spec.');
  if (lane.storageRepository !== 'v2') problems.push('the proof requires storage-v2 IndexedDB data.');
  if (lane.claim.trim().length === 0) problems.push('the lane must declare a bounded claim.');
  if (lane.doesNotProve.length < 5) problems.push('the lane must declare a does-not-prove list.');
  return problems;
}
