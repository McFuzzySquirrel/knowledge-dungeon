import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './tests/e2e/compat-evidence';
import { STORAGE_V2_LANE, STORAGE_V2_TEST_FILE } from './tests/e2e/storage-v2-lane';

const REPO_ROOT = process.cwd();
const PRODUCTION_PREVIEW_URL = 'http://127.0.0.1:43173';
const DIST_DIR = path.resolve(REPO_ROOT, 'dist');
const MANIFEST_PATH = path.resolve(REPO_ROOT, STORAGE_V2_LANE.manifestPath);

/**
 * Phase 4 flagged-build lane configuration.
 *
 * This is a SEPARATE config from `playwright.config.ts` on purpose. The default
 * config generates its projects from the approved support matrix, and its
 * current-build projects are bound to `currentBuild.spec.ts`; adding a
 * storage-v2 project there would either multiply the current-build suite or
 * break the "one project per matrix entry" contract that
 * `tests/e2e/support-matrix.test.ts` enforces. A separate config keeps the two
 * release paths disjoint: `npm run test:e2e` still builds the default artifact
 * and runs only the Phase 1 suite, and this config can only ever run
 * `storageV2.spec.ts` against a build that
 * `npm run build:storage-v2-flagged` produced.
 *
 * Like the compatibility projects, this project records no raw failure
 * artifact: trace, screenshot, and video are all off, so a failing lane cannot
 * leave a DOM snapshot, a network log, or a video behind.
 */

/** One sanitized run identifier per Playwright invocation, shared by workers. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

if (!existsSync(DIST_DIR)) {
  console.warn(
    'No dist/ directory found. Run "npm run build:storage-v2-flagged" (or "npm run test:e2e:storage") ' +
      'before running the storage-v2 lane.',
  );
}
if (!existsSync(MANIFEST_PATH)) {
  console.warn(
    'No recorded flagged-artifact identity found. The storage-v2 lane requires ' +
      '"npm run build:storage-v2-flagged && npm run record:web-artifact:storage-v2".',
  );
}

const laneProject: Project = {
  name: STORAGE_V2_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...STORAGE_V2_LANE.viewport },
    deviceScaleFactor: STORAGE_V2_LANE.deviceScaleFactor,
    hasTouch: STORAGE_V2_LANE.hasTouch,
  },
  outputDir: 'artifacts/storage-v2-test-results',
};

export default defineConfig({
  testDir: './tests/e2e',
  // Bound at the config level so no project selection can widen it.
  testMatch: STORAGE_V2_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-storage-v2-report', open: 'never' }],
  ],
  outputDir: 'artifacts/storage-v2-test-results',
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: PRODUCTION_PREVIEW_URL,
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
    // Preview only: the build and the record step belong to the package
    // scripts, so this lane can never decide for itself whether to rebuild.
    command: 'npm run preview:e2e',
    url: PRODUCTION_PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
