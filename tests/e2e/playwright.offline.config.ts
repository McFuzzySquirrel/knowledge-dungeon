import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  OFFLINE_LANE,
  OFFLINE_LANE_PREVIEW_PORT,
  OFFLINE_LANE_PREVIEW_SCRIPT,
  OFFLINE_LANE_TEST_FILE,
} from './offline-lane';

/**
 * The Phase 22 offline static-shell lane.
 *
 * ## Why a separate config, and why it lives here
 *
 * The default `playwright.config.ts` generates its projects from the approved
 * support matrix and binds its current-build projects to `currentBuild.spec.ts`;
 * adding an offline project there would multiply the current-build suite or break
 * the "one project per matrix entry" contract. Every flagged lane solved the same
 * problem with its own config, and this is another. Like the Pixi memory and
 * pointer configs, it lives under `tests/e2e/` rather than at the repository root
 * so `tsconfig.app.json`'s `include: ["src", "tests"]` covers it: a root-level
 * config would be inside no TypeScript project, so `npm run typecheck` would never
 * see it and `npm run lint` would not parse it.
 *
 * ## The one deliberate policy difference: `serviceWorkers: 'allow'`
 *
 * Every other lane blocks service workers, and the global `playwright.config.ts`
 * keeps `serviceWorkers: 'block'`. This lane is one of exactly two exceptions, and
 * only for its own project: its subject is the worker, so a blocked worker would
 * make the proof impossible. Its companion, `playwright.sw-shell.config.ts`, allows
 * the worker for its own project for the same reason. No other lane's policy is
 * read, changed, or relaxed - `tests/e2e/sw-shell-lane.test.ts` asserts the census
 * over the whole config directory. This is the "service-worker-enabled
 * compatibility projects without globally relaxing the privacy network policy" the
 * plan asks for, scoped to the projects that need it.
 *
 * ## No raw failure artifacts
 *
 * Trace, screenshot, and video are off, as for every other lane, so a failing run
 * cannot leave a DOM snapshot, a network log, or a video behind. The lane writes
 * only sanitized JSON attachments.
 *
 * ## Preview only, never builds
 *
 * The build and the recorded identity belong to the package scripts and to CI, so
 * this config can never test a different artifact than the one that was recorded.
 */

/** One sanitized run identifier per Playwright invocation, shared by workers. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();
const PREVIEW_URL = `http://127.0.0.1:${OFFLINE_LANE_PREVIEW_PORT}`;
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/offline-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-offline-report');

const laneProject: Project = {
  name: OFFLINE_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...OFFLINE_LANE.viewport },
    deviceScaleFactor: OFFLINE_LANE.deviceScaleFactor,
    hasTouch: OFFLINE_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  // Playwright resolves `testDir` against the config file's own directory, so `.`
  // is this directory. Written this way rather than as `__dirname` because the
  // config is an ES module and `__dirname` does not exist in one.
  testDir: '.',
  // Bound at the config level so no project selection can widen it.
  testMatch: OFFLINE_LANE_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: the lane reads one page's Cache Storage and one device's IndexedDB,
  // and a second worker would only contend for the same preview server.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  // Long enough for a service worker install plus a full build reload on a loaded
  // CI runner, and long enough for a failing run to reach its verdict rather than a
  // timeout.
  timeout: 180_000,
  use: {
    baseURL: PREVIEW_URL,
    headless: true,
    // THE ONE LANE THAT ALLOWS SERVICE WORKERS. See the file header.
    serviceWorkers: 'allow',
    acceptDownloads: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: OFFLINE_LANE_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory
    // and this config is not at the repository root. Without it the preview would
    // serve a `dist` that does not exist and every run would be a 180-second
    // webServer timeout rather than the missing-build diagnosis it is.
    cwd: REPO_ROOT,
    url: PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
