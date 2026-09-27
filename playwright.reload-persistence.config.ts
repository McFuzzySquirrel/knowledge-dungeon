import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './tests/e2e/compat-evidence';
import {
  RELOAD_LANE,
  RELOAD_LANE_CONFIG_FILE,
  RELOAD_LANE_PREVIEW_COMMAND,
  RELOAD_LANE_PREVIEW_PORT,
  RELOAD_LANE_TEST_FILE,
} from './tests/e2e/reload-persistence-lane';

/**
 * Reload-persistence lane configuration.
 *
 * A **fifth** config, separate from `playwright.config.ts`,
 * `playwright.storage-v2.config.ts`, `playwright.data-products.config.ts`, and
 * `playwright.subject-product.config.ts`, for the reasons the lane declaration
 * gives: the default config generates its projects from the approved support
 * matrix, and each flagged config binds exactly one project to exactly one
 * `testMatch`, all of which existing gates assert. Widening any of them would
 * weaken an existing gate.
 *
 * It previews **the same `dist`** the other three flagged lanes preview, and it
 * never builds. The build and the identity record belong to the package scripts
 * and to the `storage-v2-browser` CI job, so this lane can never decide for itself
 * whether to rebuild - and a second artifact can never appear in a CI run, which
 * is what plan section 10.4 requires.
 *
 * Its own port (43183), so it cannot collide with `preview:e2e` (43173),
 * `preview:e2e:data-products` (43179), or `preview:e2e:subject-product` (43181) if
 * the lanes are ever run concurrently in one worktree.
 *
 * `acceptDownloads` is on - all three products are local files the learner keeps -
 * and `serviceWorkers` is blocked like every other lane. Trace, screenshot, and
 * video are off, so a failing lane cannot leave a DOM snapshot, a network log, or
 * a video behind.
 */

const REPO_ROOT = process.cwd();
const PREVIEW_URL = `http://127.0.0.1:${RELOAD_LANE_PREVIEW_PORT}`;
const DIST_DIR = path.resolve(REPO_ROOT, 'dist');
const MANIFEST_PATH = path.resolve(REPO_ROOT, RELOAD_LANE.manifestPath);

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

if (!existsSync(DIST_DIR)) {
  console.warn(
    'No dist/ directory found. Run "npm run build:storage-v2-data-products" (and ' +
      '"npm run record:web-artifact:storage-v2") before running the reload-persistence lane.',
  );
}
if (!existsSync(MANIFEST_PATH)) {
  console.warn(
    `No recorded flagged-artifact identity at ${RELOAD_LANE.manifestPath}. Run ` +
      '"npm run build:storage-v2-data-products && npm run record:web-artifact:storage-v2".',
  );
}

const laneProject: Project = {
  name: RELOAD_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...RELOAD_LANE.viewport },
    deviceScaleFactor: RELOAD_LANE.deviceScaleFactor,
    hasTouch: RELOAD_LANE.hasTouch,
    acceptDownloads: true,
  },
  outputDir: 'artifacts/reload-persistence-test-results',
};

export default defineConfig({
  testDir: './tests/e2e',
  // Bound at the config level so no project selection can widen it.
  testMatch: RELOAD_LANE_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-reload-persistence-report', open: 'never' }],
  ],
  outputDir: 'artifacts/reload-persistence-test-results',
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: PREVIEW_URL,
    headless: true,
    serviceWorkers: 'block',
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: RELOAD_LANE_PREVIEW_COMMAND,
    url: PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});

/** The config's own file name, re-exported so the wiring gate can assert it. */
export const RELOAD_LANE_CONFIG_BASENAME = RELOAD_LANE_CONFIG_FILE;
