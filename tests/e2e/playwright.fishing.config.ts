/**
 * The Phase 17 fishing lane's Playwright config.
 *
 * ## Why a separate config
 *
 * The default config generates its projects from the approved support matrix and binds its
 * current-build projects to `currentBuild.spec.ts`; adding a project there would either
 * multiply the current-build suite or break the "one project per matrix entry" contract
 * `tests/e2e/support-matrix.test.ts` enforces. The two Pixi lanes and the media lane each
 * solved the same problem with their own config, and this is the sixth. `npm run test:e2e`
 * therefore still builds the default artifact and runs only the Phase 1 suite, and this
 * config can only ever run `fishing.spec.ts`.
 *
 * ## Why this file is under `tests/e2e/` and not beside the four older ones
 *
 * `tsconfig.node.json` lists the four existing `playwright.*.config.ts` files by name. A fifth
 * root-level config would sit inside no TypeScript project: `npm run typecheck` would never see
 * it and `npm run lint`, whose parser is configured with exactly three projects, would fail to
 * parse it. Inside `tests/e2e/**` it is covered by `tsconfig.app.json`'s `include: ["src",
 * "tests"]`, so both see it and no file outside this change's ownership has to change.
 *
 * ## Chromium only
 *
 * The lane's own declaration says so in `engine` and `doesNotProve`: this is one new surface
 * on the engine the two Pixi lanes already run. Plan section 10.4's cross-browser evidence is
 * the `compat-*` projects, and Phase 21 owns the accessibility and responsive audit the full
 * matrix serves. Inventing four engines for one new surface on the day it lands would multiply
 * CI cost for evidence that phase produces properly anyway.
 *
 * ## Both artifacts, one config
 *
 * The flagged lane previews `build:web:pixi-fishing`'s artifact and the rollback lane previews
 * the default one. They share this config, this port, and this spec; what differs is which
 * recorded identity the preflight verified, and the spec classifies the artifact from `dist/`
 * rather than from a flag. `webServer.reuseExistingServer` is `false`, so two runs can never
 * share a server, and `--strictPort` means a port already in use is an error rather than a
 * silent fallback to a different artifact.
 *
 * ## No raw failure artifacts
 *
 * Trace, screenshot, and video are off, as they are for every other flagged lane, so a failing
 * run cannot leave a DOM snapshot, a network log, or a video behind. The only thing this lane
 * writes is the return code and the sanitized JSON the spec attaches to the report.
 */

import path from 'node:path';

import { defineConfig, devices, type PlaywrightTestConfig, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  FISHING_LANE,
  FISHING_PREVIEW_PORT,
  FISHING_PREVIEW_SCRIPT,
  FISHING_TEST_FILE,
} from './fishing-lane';

/** One sanitized run identifier per Playwright invocation, shared by every worker. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

// `process.cwd()`, not `__dirname`: this config is an ES module, where `__dirname` does not
// exist. It matches the two Pixi lanes' own configs, and it is why every npm script that loads
// a config runs from the repository root.
const REPO_ROOT = process.cwd();

/**
 * The repository root, exported to the workers through the environment.
 *
 * Playwright runs a spec in a worker whose working directory is **not** guaranteed to be the
 * directory the config was loaded from - the config's own `webServer.cwd` exists for the same
 * reason - so a spec that resolves `dist/` from `process.cwd()` can read a directory that is not
 * the build. The value is captured here, where the config file's own directory *is* the
 * repository root by construction, and read back by the harness.
 */
process.env.KD_FISHING_REPO_ROOT = REPO_ROOT;

/**
 * Absolute, on purpose.
 *
 * Playwright resolves `outputDir` and a reporter's `outputFolder` against the *config file's*
 * directory, and this config is not at the repository root. Left relative they would put a
 * results tree inside `tests/e2e/`, which is untracked in the source tree and outside the CI
 * job's evidence allowlist.
 */
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/fishing-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-fishing-report');

const laneProject: Project = {
  name: FISHING_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: FISHING_LANE.engine,
    viewport: { ...FISHING_LANE.viewport },
    deviceScaleFactor: FISHING_LANE.deviceScaleFactor,
    hasTouch: FISHING_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  // Playwright resolves `testDir` against the config file's own directory, so `.` is this
  // directory. Written this way rather than as `__dirname` for the reason above.
  testDir: '.',
  // Bound at the config level so no project selection can widen it.
  testMatch: FISHING_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker. The entry-point walk holds arrow keys on one page for a few seconds and every
  // test after it drives one pond on one canvas; a second worker would contend for the same
  // preview server without adding evidence.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  // Generous, and the reason is the walk. Reaching a fishing pond means holding arrow keys for
  // several seconds on a Phaser village whose movement is integrated from a clamped frame delta, so
  // a 1200 ms deadline is the largest spend that still fits inside one test that also casts a fish;
  // the catch flow adds a bite window the test has to be ready for; and the rollback lane's own
  // Escape round trip adds a settle on both sides. A tight timeout would replace the finding with a
  // wall-clock number, which is the one thing this lane must never do.
  //
  // It is raised from 180 s for exactly one reason: `WALK_SW_POND_TO_FISH_STAND.budgetMs` is 120 s,
  // and three of the tests below walk to the pond, act, and then walk to the fish stand. At 180 s a
  // machine half as fast as the one the budgets were measured on would have had its finding replaced
  // by a Playwright timeout — which is the failure mode the comment above exists to prevent, not a
  // budget too small. `tests/e2e/fishing-lane.test.ts` asserts every walk budget plus setup still fits
  // inside this number, so raising it is a deliberate edit rather than a way to stop a failure.
  timeout: 300_000,
  use: {
    baseURL: `http://127.0.0.1:${FISHING_PREVIEW_PORT}`,
    headless: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    // Preview only. The build and the recorded identity belong to the CI steps and to the
    // documented local command sequence, so this lane can never decide for itself whether to
    // rebuild, and cannot test a different artifact than the one that was recorded.
    command: FISHING_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory and this
    // config is not at the repository root. Without it the preview would serve a `dist` that
    // does not exist and every run would be a 404, which the readiness check reports as a
    // 180-second timeout rather than as the mistake it is.
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${FISHING_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
} satisfies PlaywrightTestConfig);