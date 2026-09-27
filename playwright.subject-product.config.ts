import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './tests/e2e/compat-evidence';
import {
  SUBJECT_LANE,
  SUBJECT_LANE_CONFIG_FILE,
  SUBJECT_LANE_PREVIEW_COMMAND,
  SUBJECT_LANE_PREVIEW_PORT,
  SUBJECT_LANE_TEST_FILE,
} from './tests/e2e/subject-product-lane';

/**
 * Phase 6 individual-subject backup lane configuration.
 *
 * A **fourth** config, separate from `playwright.config.ts`,
 * `playwright.storage-v2.config.ts`, and `playwright.data-products.config.ts`, for
 * the reasons Phase 5 recorded: the default config generates its projects from the
 * approved support matrix and binds them to `currentBuild.spec.ts`, and the Phase 4
 * config binds exactly one project to exactly one `testMatch`, both of which an
 * existing gate asserts. Widening either would weaken an existing gate.
 *
 * It previews **the same `dist`** the other two flagged lanes preview, and it never
 * builds: the build and the identity record belong to the package scripts and to
 * the `storage-v2-browser` CI job, so this lane can never decide for itself whether
 * to rebuild and a second artifact can never appear in a CI run.
 *
 * Its own port (43181), so it cannot collide with `preview:e2e` (43173) or
 * `preview:e2e:data-products` (43179) if the lanes are ever run concurrently in one
 * worktree.
 *
 * `acceptDownloads` is on - a subject backup is a local file the learner keeps - and
 * `serviceWorkers` is blocked like every other lane. Trace, screenshot, and video are
 * off, so a failing lane cannot leave a DOM snapshot, a network log, or a video
 * behind.
 */

const REPO_ROOT = process.cwd();
const PREVIEW_URL = `http://127.0.0.1:${SUBJECT_LANE_PREVIEW_PORT}`;
const DIST_DIR = path.resolve(REPO_ROOT, 'dist');
const MANIFEST_PATH = path.resolve(REPO_ROOT, SUBJECT_LANE.manifestPath);

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

if (!existsSync(DIST_DIR)) {
  console.warn(
    'No dist/ directory found. Run "npm run build:storage-v2-data-products" (and ' +
      '"npm run record:web-artifact:storage-v2") before running the subject-backup lane.',
  );
}
if (!existsSync(MANIFEST_PATH)) {
  console.warn(
    `No recorded flagged-artifact identity at ${SUBJECT_LANE.manifestPath}. Run ` +
      '"npm run build:storage-v2-data-products && npm run record:web-artifact:storage-v2".',
  );
}

const laneProject: Project = {
  name: SUBJECT_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...SUBJECT_LANE.viewport },
    deviceScaleFactor: SUBJECT_LANE.deviceScaleFactor,
    hasTouch: SUBJECT_LANE.hasTouch,
    acceptDownloads: true,
  },
  outputDir: 'artifacts/subject-product-test-results',
};

export default defineConfig({
  testDir: './tests/e2e',
  // Bound at the config level so no project selection can widen it.
  testMatch: SUBJECT_LANE_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-subject-product-report', open: 'never' }],
  ],
  outputDir: 'artifacts/subject-product-test-results',
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
    command: SUBJECT_LANE_PREVIEW_COMMAND,
    url: PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});

/** The config's own file name, re-exported so the wiring gate can assert it. */
export const SUBJECT_LANE_CONFIG_BASENAME = SUBJECT_LANE_CONFIG_FILE;
