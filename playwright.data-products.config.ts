import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './tests/e2e/compat-evidence';
import {
  DATA_PRODUCTS_LANE,
  DATA_PRODUCTS_PREVIEW_COMMAND,
  DATA_PRODUCTS_PREVIEW_PORT,
  DATA_PRODUCTS_TEST_FILE,
} from './tests/e2e/data-products-lane';

const REPO_ROOT = process.cwd();
const PREVIEW_URL = `http://127.0.0.1:${DATA_PRODUCTS_PREVIEW_PORT}`;
const DIST_DIR = path.resolve(REPO_ROOT, 'dist');
const MANIFEST_PATH = path.resolve(REPO_ROOT, DATA_PRODUCTS_LANE.manifestPath);

/**
 * Phase 5 fresh-profile restore lane configuration.
 *
 * A SEPARATE config from `playwright.config.ts` and from
 * `playwright.storage-v2.config.ts`, on purpose:
 *
 * - The default config generates its projects from the approved support matrix and
 *   binds them to `currentBuild.spec.ts`, so `npm run test:e2e` and
 *   `npm run test:e2e:compat` cannot pick this spec up and the current-build suite
 *   is not multiplied.
 * - The Phase 4 config binds exactly one project to exactly one `testMatch`, and
 *   `tests/e2e/storage-v2-lane.test.ts` asserts both. Adding a second project or
 *   widening that `testMatch` would weaken an existing gate.
 *
 * It previews **the same `dist`** the Phase 4 flagged lane previews, and it never
 * builds: the build and the identity record belong to the package scripts and to
 * the `storage-v2-browser` CI job, so this lane can never decide for itself whether
 * to rebuild, and a second artifact can never appear in a CI run.
 *
 * Its own port, so it can never collide with `preview:e2e`'s fixed port if the two
 * lanes are ever run concurrently in one worktree.
 *
 * `acceptDownloads` is on - a backup is a local file the learner keeps - and
 * `serviceWorkers` is blocked, like every other lane. Trace, screenshot, and video
 * are off, so a failing lane cannot leave a DOM snapshot, a network log, or a video
 * behind.
 */

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

if (!existsSync(DIST_DIR)) {
  console.warn(
    'No dist/ directory found. Run "npm run build:storage-v2-flagged" (or ' +
      '"npm run test:e2e:data-products") before running the fresh-profile restore lane.',
  );
}
if (!existsSync(MANIFEST_PATH)) {
  console.warn(
    `No recorded flagged-artifact identity at ${DATA_PRODUCTS_LANE.manifestPath}. Run ` +
      '"npm run build:storage-v2-flagged && npm run record:web-artifact:storage-v2".',
  );
}

const laneProject: Project = {
  name: DATA_PRODUCTS_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...DATA_PRODUCTS_LANE.viewport },
    deviceScaleFactor: DATA_PRODUCTS_LANE.deviceScaleFactor,
    hasTouch: DATA_PRODUCTS_LANE.hasTouch,
    acceptDownloads: true,
  },
  outputDir: 'artifacts/data-products-test-results',
};

export default defineConfig({
  testDir: './tests/e2e',
  // Bound at the config level so no project selection can widen it.
  testMatch: DATA_PRODUCTS_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-data-products-report', open: 'never' }],
  ],
  outputDir: 'artifacts/data-products-test-results',
  expect: {
    timeout: 10_000,
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
    // Preview only, on this lane's own port. The build and the record step belong
    // to the package scripts and to the CI job that already ran them.
    command: DATA_PRODUCTS_PREVIEW_COMMAND,
    url: PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
