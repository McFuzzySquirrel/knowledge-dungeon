import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  PIXI_ROUTE_LANE,
  PIXI_ROUTE_PREVIEW_PORT,
  PIXI_ROUTE_PREVIEW_SCRIPT,
  PIXI_ROUTE_TEST_FILE,
} from './pixi-route-lane';

/**
 * The Phase 22 route-change teardown lane.
 *
 * Preview-only, on its own port, against an artifact that must already have been
 * built with `VITE_PIXI_DUNGEON=true VITE_PIXI_FISHING=true` and recorded. The build
 * and the recorded identity belong to the `:full` script and to CI; this config can
 * never rebuild, so it cannot test a different artifact than the one recorded.
 *
 * Under `tests/e2e/` rather than at the repository root for the reason the five
 * existing flagged configs are: `tsconfig.node.json` enumerates the root-level
 * configs by name, and a config inside no TypeScript project is a config whose type
 * errors surface only when Playwright happens to run it.
 */

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/pixi-route-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-pixi-route-report');

const laneProject: Project = {
  name: PIXI_ROUTE_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...PIXI_ROUTE_LANE.viewport },
    deviceScaleFactor: PIXI_ROUTE_LANE.deviceScaleFactor,
    hasTouch: false,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  testDir: '.',
  testMatch: PIXI_ROUTE_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: { timeout: 15_000 },
  // The walk from the spawn to the pond is on foot and the two renderers are real;
  // the budget bounds a *failing* run, not a passing one.
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${PIXI_ROUTE_PREVIEW_PORT}`,
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
    command: PIXI_ROUTE_PREVIEW_SCRIPT,
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${PIXI_ROUTE_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
