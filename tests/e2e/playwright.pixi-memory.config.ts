import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import {
  PIXI_MEMORY_LANE,
  PIXI_MEMORY_PREVIEW_PORT,
  PIXI_MEMORY_PREVIEW_SCRIPT,
  PIXI_MEMORY_TEST_FILE,
} from './pixi-memory-lane';

/**
 * The Phase 9 Pixi world-host memory lane.
 *
 * ## Why a separate config
 *
 * The default config generates its projects from the approved support matrix and
 * binds its current-build projects to `currentBuild.spec.ts`; adding a project
 * there would either multiply the current-build suite or break the "one project per
 * matrix entry" contract `tests/e2e/support-matrix.test.ts` enforces. The four
 * flagged lanes each solved the same problem with their own config, and this is the
 * fifth. `npm run test:e2e` therefore still builds the default artifact and runs
 * only the Phase 1 suite, and this config can only ever run `pixiMemory.spec.ts`
 * against a build that was made with `VITE_WORLD_RENDERER=pixi`.
 *
 * ## Why this file is under `tests/e2e/` and not beside the other four
 *
 * `tsconfig.node.json` lists the four existing `playwright.*.config.ts` files by
 * name. Adding a fifth at the repository root would put it inside no TypeScript
 * project: `npm run typecheck` would never see it and `npm run lint`, whose parser
 * is configured with exactly three projects, would fail to parse it. Here it is
 * inside `tsconfig.app.json`'s `include: ["src", "tests"]`, so both see it and no
 * file outside this change's ownership has to change. The cost is that the lane's
 * config is one directory away from the others; the benefit is that a type error in
 * it fails the ordinary gate instead of surfacing the first time Playwright runs.
 *
 * ## No raw failure artifacts
 *
 * Trace, screenshot, and video are off, as they are for the other flagged lanes, so
 * a failing run cannot leave a DOM snapshot, a network log, or a video behind. The
 * only thing this lane writes is sanitized JSON under the allowlisted
 * `artifacts/compatibility-evidence/` root, which the CI job already uploads.
 */

/** One sanitized run identifier per Playwright invocation, shared by workers. */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();

/**
 * Output paths are absolute on purpose.
 *
 * Playwright resolves `outputDir` and a reporter's `outputFolder` against the
 * *config file's* directory, and this config is not at the repository root. Left
 * relative they would put a results tree inside `tests/e2e/`, where the CI job's
 * evidence allowlist would never see it and where it would be an untracked
 * directory in the source tree.
 */
const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/pixi-memory-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-pixi-memory-report');


const laneProject: Project = {
  name: PIXI_MEMORY_LANE.project,
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    viewport: { ...PIXI_MEMORY_LANE.viewport },
    deviceScaleFactor: PIXI_MEMORY_LANE.deviceScaleFactor,
    hasTouch: PIXI_MEMORY_LANE.hasTouch,
  },
  outputDir: RESULTS_DIR,
};

export default defineConfig({
  // Playwright resolves `testDir` against the config file's own directory, so `.`
  // is this directory. Written this way rather than as `__dirname` because the
  // config is an ES module and `__dirname` does not exist in one.
  testDir: '.',
  // Bound at the config level so no project selection can widen it.
  testMatch: PIXI_MEMORY_TEST_FILE,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: the lane's counters are read from one page, and a second worker
  // would only contend for the same preview server.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: REPORT_DIR, open: 'never' }],
  ],
  outputDir: RESULTS_DIR,
  expect: {
    timeout: 15_000,
  },
  // Long enough for twenty-one PixiJS applications to be created, presented and
  // settled in a software-rasterised WebGL context on a loaded CI runner, and long
  // enough for the *failing* run to reach its verdict rather than a timeout. A
  // leaking host saturates the compositor, so a failure is slower than a pass here;
  // a test timeout would replace the finding list with a wall-clock number, which is
  // the one thing this lane must never do.
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${PIXI_MEMORY_PREVIEW_PORT}`,
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
    // Preview only: the build and the recorded identity belong to the CI steps and
    // to the documented local command sequence, so this lane can never decide for
    // itself whether to rebuild, and cannot test a different artifact than the one
    // that was recorded.
    command: PIXI_MEMORY_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory
    // and this config is not at the repository root. Without it the preview would
    // serve a `dist` that does not exist and every run would be a 404 - which the
    // webServer readiness check reports as a 180-second timeout rather than as the
    // mistake it is.
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${PIXI_MEMORY_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [laneProject],
});
