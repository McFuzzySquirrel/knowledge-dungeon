import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  SW_SHELL_LANE,
  SW_SHELL_PREVIEW_PORT,
  SW_SHELL_PREVIEW_SCRIPT,
  SW_SHELL_TEST_FILE,
} from './sw-shell-lane';

/**
 * The Phase 22 service-worker-enabled compatibility lane.
 *
 * ## Why a separate config
 *
 * The default `playwright.config.ts` generates its projects from the approved
 * support matrix and binds its current-build projects to `currentBuild.spec.ts`.
 * The offline lane already owns one config, and adding a second project there would
 * either multiply the offline suite or break the "one project per config" shape the
 * other lanes keep. This config binds exactly one project to exactly one spec.
 *
 * ## The one deliberate policy difference
 *
 * `serviceWorkers: 'allow'`, for this project only, because the worker is the
 * subject. The global config and every other lane keep `serviceWorkers: 'block'`;
 * this file changes none of them. `tests/e2e/sw-shell-lane.test.ts` asserts the
 * census, so a future lane cannot quietly join this exception.
 *
 * ## Preview only, never builds
 *
 * The build and the recorded identity belong to the package scripts and to CI, so
 * this config can never test a different artifact than the one that was recorded.
 * It previews the **offline-flagged** artifact - the same one the offline lane
 * previews - because `VITE_OFFLINE_SHELL` is a build-time flag and a second build
 * would be the duplication the one-artifact rule forbids.
 *
 * ## No raw failure artifacts
 *
 * Trace, screenshot, and video are off, so a failing run cannot leave a DOM
 * snapshot, a network log, or a video behind. The only thing this lane writes is
 * sanitized JSON under the allowlisted `artifacts/compatibility-evidence/` root.
 */

/** One sanitized run identifier per Playwright invocation, shared by workers. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();
const PREVIEW_URL = `http://127.0.0.1:${SW_SHELL_PREVIEW_PORT}`;
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/sw-shell-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-sw-shell-report');

const laneProject: Project = {
  name: SW_SHELL_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...SW_SHELL_LANE.viewport },
    deviceScaleFactor: SW_SHELL_LANE.deviceScaleFactor,
    hasTouch: SW_SHELL_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  // Playwright resolves `testDir` against the config file's own directory, so `.`
  // is this directory. Written this way rather than as `__dirname` because the
  // config is an ES module and `__dirname` does not exist in one.
  testDir: '.',
  // Bound at the config level so no project selection can widen it.
  testMatch: SW_SHELL_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: the lane reads one page's request stream and one preview server.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  // Long enough for a worker install plus a full shell load on a loaded CI runner,
  // and long enough for a failing run to reach its verdict rather than a timeout.
  timeout: 180_000,
  use: {
    baseURL: PREVIEW_URL,
    headless: true,
    // THE SECOND AND LAST LANE THAT ALLOWS SERVICE WORKERS. See the file header.
    serviceWorkers: 'allow',
    acceptDownloads: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: SW_SHELL_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory
    // and this config is not at the repository root.
    cwd: REPO_ROOT,
    url: PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
