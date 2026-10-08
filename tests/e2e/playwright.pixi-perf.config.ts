import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  PIXI_PERF_LANE,
  PIXI_PERF_PREVIEW_PORT,
  PIXI_PERF_PREVIEW_SCRIPT,
  PIXI_PERF_TEST_FILE,
} from './pixi-perf-lane';

/**
 * The Phase 22 PixiJS dungeon frame-time lane.
 *
 * ## Why a separate config, and why it lives here
 *
 * The default `playwright.config.ts` generates its projects from the approved support
 * matrix and binds its current-build projects to `currentBuild.spec.ts`; adding this
 * project there would multiply the current-build suite or break the "one project per
 * matrix entry" contract. Every flagged lane solved the same problem with its own
 * config, and this is another. Like the Pixi memory and offline configs, it lives
 * under `tests/e2e/` rather than at the repository root so `tsconfig.app.json`'s
 * `include: ["src", "tests"]` covers it: a root-level config would be inside no
 * TypeScript project, so `npm run typecheck` would never see it and `npm run lint`
 * would not parse it.
 *
 * ## No raw failure artifacts, and service workers blocked
 *
 * Trace, screenshot, and video are off, as for every other lane, so a failing run
 * cannot leave a DOM snapshot, a network log, or a video behind. Service workers are
 * blocked, exactly as the global config and every lane except the two offline lanes
 * block them: this lane measures the world, and a worker interposing on its requests
 * would make the measurement a claim about something else.
 *
 * ## Preview only, never builds
 *
 * The build and the recorded identity belong to the package scripts and to CI, so this
 * config can never test a different artifact than the one that was recorded.
 */

/** One sanitized run identifier per Playwright invocation, shared by workers. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();
const PREVIEW_URL = `http://127.0.0.1:${PIXI_PERF_PREVIEW_PORT}`;
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/pixi-perf-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-pixi-perf-report');

const laneProject: Project = {
  name: PIXI_PERF_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...PIXI_PERF_LANE.viewport },
    deviceScaleFactor: PIXI_PERF_LANE.deviceScaleFactor,
    hasTouch: PIXI_PERF_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  // Playwright resolves `testDir` against the config file's own directory, so `.` is
  // this directory. Written this way rather than as `__dirname` because the config is
  // an ES module and `__dirname` does not exist in one.
  testDir: '.',
  // Bound at the config level so no project selection can widen it.
  testMatch: PIXI_PERF_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: each measurement reads one page's frame timing and one device's world,
  // and a second worker would contend for the same preview server and the same CPU.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 20_000,
  },
  // Long enough for three software-rendered worlds to mount, sample, and interact on a
  // loaded CI runner, and long enough for a failing run to reach its verdict rather
  // than a timeout.
  timeout: 240_000,
  use: {
    baseURL: PREVIEW_URL,
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
    command: PIXI_PERF_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory and
    // this config is not at the repository root. Without it the preview would serve a
    // `dist` that does not exist and every run would be a 180-second webServer timeout
    // rather than the missing-build diagnosis it is.
    cwd: REPO_ROOT,
    url: PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
