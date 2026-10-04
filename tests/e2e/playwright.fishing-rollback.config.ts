/**
 * The Phase 17 fishing **rollback** lane's Playwright config.
 *
 * ## What this is for
 *
 * Phase 17's rollback line is `VITE_PIXI_FISHING=false`. A rollback line that has never been
 * observed is a hope, and the plan's own Phase 17 scope requires the release path to be kept
 * and exercised: the entry point a learner uses to reach the pond must still reach the Phaser
 * `FishingScene` on the artifact that actually ships.
 *
 * So this lane previews the **default production artifact** — `npm run build:web`, recorded and
 * verified by `npm run record:web-artifact` / `npm run verify:web-artifact` — and asserts the
 * three facts that make the rollback a measurement rather than a claim:
 *
 * 1. the built bundle contains **no** Pixi fishing chunk, read from `dist/assets`;
 * 2. the entry point reaches the Phaser scene in the village's own game and canvas, and the
 *    Pixi pond's DOM controls do not exist on the page at all;
 * 3. `Escape` returns to the village, because `FishingScene` binds `ESC` and the Pixi pond does
 *    not — so which of the two worlds a learner is in is observable from the keyboard alone.
 *
 * ## Why it is a separate config rather than a project in the flagged lane's
 *
 * `testMatch` is one spec per config throughout this repository, and the reason is the evidence
 * allowlist: widening a lane's `testMatch` files a different claim's evidence under this lane's
 * name. More fundamentally, a test's premise must be true of the artifact it runs against. The
 * flagged spec drives six DOM fishing controls that exist only in an artifact containing the
 * pond; this one drives a Phaser canvas that exists only in an artifact without it. A single
 * spec asserting both would need a skip to express the half that cannot run.
 *
 * ## Everything else matches `playwright.fishing.config.ts`
 *
 * Same engine, same viewport, same scale factor, same port discipline, same
 * preview-only/no-rebuild stance, same no-raw-failure-artifact stance. If these two drift apart
 * the difference stops being a fact about the products and starts being a fact about the lanes,
 * which `tests/e2e/fishing-lane.test.ts` asserts cannot happen.
 */

import path from 'node:path';

import { defineConfig, devices, type PlaywrightTestConfig, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  FISHING_LANE,
  FISHING_ROLLBACK_PREVIEW_PORT,
  FISHING_ROLLBACK_PREVIEW_SCRIPT,
  FISHING_ROLLBACK_TEST_FILE,
} from './fishing-lane';

/** One sanitized run identifier per Playwright invocation, shared by every worker. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

// `process.cwd()`, not `__dirname`: this config is an ES module, where `__dirname` does not
// exist, and it is why every npm script that loads a config runs from the repository root.
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

const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/fishing-rollback-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-fishing-rollback-report');

const rollbackProject: Project = {
  // The flagged lane's project name plus its role, because a Playwright project name has to be
  // unique across every config in the repository and the two lanes are not the same lane.
  name: `${FISHING_LANE.project}-rollback`,
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
  testDir: '.',
  testMatch: FISHING_ROLLBACK_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker, for the reason the flagged lane's config records: the entry-point walk holds
  // arrow keys on one page and a second worker would contend for the same preview server.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  // Raised to match the flagged lane's, and for the same single reason: both lanes share
  // `WALK_SPAWN_TO_SW_POND`, whose budget is a wall-clock deadline sized for a machine slower than
  // the one it was measured on. At 180 s a slower runner would have its finding replaced by a
  // Playwright timeout, which is the failure the flagged lane's config comment exists to prevent.
  // `tests/e2e/fishing-lane.test.ts` asserts the shared budget plus setup fits inside this number, so
  // raising it is a deliberate edit and not a way to stop a test from failing.
  timeout: 300_000,
  use: {
    baseURL: `http://127.0.0.1:${FISHING_ROLLBACK_PREVIEW_PORT}`,
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
    // Preview only, and of the **default** artifact. The build and the recorded identity belong
    // to the CI steps and to `npm run test:e2e:fishing:rollback:full`; a lane that could decide
    // for itself whether to rebuild could end up measuring an artifact nobody recorded.
    command: FISHING_ROLLBACK_PREVIEW_SCRIPT,
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${FISHING_ROLLBACK_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [rollbackProject],
} satisfies PlaywrightTestConfig);