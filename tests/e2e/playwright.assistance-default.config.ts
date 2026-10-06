import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  ASSISTANCE_DEFAULT_LANE,
  ASSISTANCE_DEFAULT_PREVIEW_PORT,
  ASSISTANCE_DEFAULT_PREVIEW_SCRIPT,
  ASSISTANCE_DEFAULT_TEST_FILE,
} from './assistance-lane';

/**
 * The Phase 21 assistance **rollback** lane, against the default production artifact.
 *
 * ## Why this is a separate config and a separate spec rather than a branch
 *
 * The Phase 19 rollback line is `VITE_ADAPTIVE_ASSISTANCE=false`, and "the card is absent" is a
 * claim about the artifact that actually ships, not about the flagged one. Asserting it against
 * the flagged artifact would be vacuous: the card is there.
 *
 * But the more important reason is the one `tests/e2e/fishing-lane.ts` states at length: a
 * lane that passes by not measuring is the failure this repository forbids, and expressing
 * "this half cannot run" inside a shared spec needs a `skip`. So each lane has its own config,
 * its own port, its own preflight invocation, its own recorded identity, and its own spec - and
 * each spec asserts the half that is true of the artifact it is pointed at.
 *
 * ## Why the probe is the same shape as the flagged lane's
 *
 * The card's absence is only evidence about the gate if the journey that would mount it
 * actually reached its precondition. Both specs drive the identical journey - the same seeded
 * subject, the same walk to the pond, the same cast and hook, and the same recall question
 * answered wrong for the room it came from - and both assert that the recall dialog was
 * answered. The default lane then asserts that no assistance element exists and that the lazy
 * lane chunk was never requested.
 *
 * ## No raw failure artifacts
 *
 * As in the flagged lane's config: trace, screenshot and video are off, so a failing run leaves
 * no DOM snapshot, no network log, and no video, and no Playwright trace can embed a font file
 * under `artifacts/`.
 */

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();

const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/assistance-default-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-assistance-default-report');

const laneProject: Project = {
  name: ASSISTANCE_DEFAULT_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...ASSISTANCE_DEFAULT_LANE.viewport },
    deviceScaleFactor: ASSISTANCE_DEFAULT_LANE.deviceScaleFactor,
    hasTouch: ASSISTANCE_DEFAULT_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  testDir: '.',
  testMatch: ASSISTANCE_DEFAULT_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  timeout: 300_000,
  use: {
    baseURL: `http://127.0.0.1:${ASSISTANCE_DEFAULT_PREVIEW_PORT}`,
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
    command: ASSISTANCE_DEFAULT_PREVIEW_SCRIPT,
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${ASSISTANCE_DEFAULT_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});