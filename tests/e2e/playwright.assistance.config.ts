import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  ASSISTANCE_LANE,
  ASSISTANCE_PREVIEW_PORT,
  ASSISTANCE_PREVIEW_SCRIPT,
  ASSISTANCE_TEST_FILE,
} from './assistance-lane';

/**
 * The Phase 21 flagged assistance lane, against a `VITE_ADAPTIVE_ASSISTANCE=true` artifact.
 *
 * ## Why a separate config
 *
 * The same reason `playwright.pixi-memory.config.ts` records. The default config generates
 * its projects from the support matrix and binds the current-build projects to
 * `currentBuild.spec.ts`, and `tests/e2e/support-matrix.test.ts` enforces one project per
 * matrix entry - so adding a project there would either multiply the current-build suite or
 * break a gate that works. This config can only ever run `assistance.spec.ts` against a build
 * made with the Phase 19 flag on.
 *
 * ## Why this file is under `tests/e2e/` and not beside the older configs
 *
 * `tsconfig.node.json` lists the four older `playwright.*.config.ts` files by name. A root-level
 * config would sit inside no TypeScript project: `npm run typecheck` would never see it and
 * `npm run lint`, whose parser is configured with exactly three projects, would fail to parse
 * it. Here it is inside `tsconfig.app.json`'s `include: ["src", "tests"]`, so both see it and no
 * file outside this change's ownership has to change.
 *
 * ## No raw failure artifacts
 *
 * Trace, screenshot, and video are off, as they are for the other flagged lanes, so a failing
 * run cannot leave a DOM snapshot, a network log, or a video behind - and so a Playwright trace
 * cannot embed a font file under `artifacts/` where a repository-wide font walk would find it.
 * The only thing this lane writes is sanitized JSON under the allowlisted
 * `artifacts/compatibility-evidence/` root, which the CI job already uploads.
 */

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();

/**
 * Absolute on purpose. Playwright resolves `outputDir` and a reporter's `outputFolder` against
 * the *config file's* directory, and this config is not at the repository root. Left relative
 * they would put a results tree inside `tests/e2e/`, where the CI job's evidence allowlist would
 * never see it and where it would be an untracked directory in the source tree.
 */
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/assistance-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-assistance-report');

const laneProject: Project = {
  name: ASSISTANCE_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...ASSISTANCE_LANE.viewport },
    deviceScaleFactor: ASSISTANCE_LANE.deviceScaleFactor,
    hasTouch: ASSISTANCE_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  // Playwright resolves `testDir` against the config file's own directory, so `.` is this
  // directory. Written this way rather than as `__dirname` because the config is an ES module
  // and `__dirname` does not exist in one.
  testDir: '.',
  // Bound at the config level so no project selection can widen it.
  testMatch: ASSISTANCE_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: the journey drives one page through a seeded device and a village walk, and a
  // second worker would contend for the same preview server.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  // Long enough for a village walk, a cast-to-hook cycle with a bounded retry loop, and the
  // suggestion card's own lazy chunk to evaluate in a software-rasterised container on a loaded
  // CI runner. Generous on purpose: the Phaser fishing scene exposes no DOM state for the bite
  // window, so the lane polls for the catch panel rather than driving a deterministic event.
  // A leaking host saturates the compositor and a failure is slower than a pass, so a test
  // timeout would replace the finding with a wall-clock number, which is the one thing this
  // lane must never do.
  timeout: 300_000,
  use: {
    baseURL: `http://127.0.0.1:${ASSISTANCE_PREVIEW_PORT}`,
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
    // Preview only: the build and the recorded identity belong to the CI steps and to the
    // documented local command sequence, so this lane can never decide for itself whether to
    // rebuild, and cannot test a different artifact than the one that was recorded. The
    // preflight that establishes the artifact is the lane's npm script, not this file.
    command: ASSISTANCE_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory and this config
    // is not at the repository root. Without it the preview would serve a `dist` that does not
    // exist and every run would be a 404 - which the readiness check reports as a 180-second
    // timeout rather than as the mistake it is.
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${ASSISTANCE_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});