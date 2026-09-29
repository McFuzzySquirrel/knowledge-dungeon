/**
 * The canvas-pointer gate's Playwright config.
 *
 * ## Why this lives beside the memory lane's config and not at the repository root
 *
 * The five older configs sit at the root and are listed explicitly in
 * `tsconfig.node.json`. The memory lane's config is at `tests/e2e/`, and this one
 * follows it, for a reason that is not tidiness: a root config that imports its
 * declaration from `tests/e2e/` makes that declaration a member of two composite
 * projects, which `tsc -b` rejects (`TS6307`) and ESLint's type-aware rules reject
 * as a file found in multiple projects. A config under `tests/` is covered by
 * `tsconfig.app.json` along with the declaration it reads, exactly as
 * `playwright.pixi-memory.config.ts` already is.
 *
 * ## Why the canvas is a separate lane rather than a ninth test in the memory lane
 *
 * `tests/e2e/pixiMemory.spec.ts` is the 20-cycle mount/unmount memory gate. Its
 * `testMatch` is pinned to that one spec and its eight-test count is asserted by
 * `tests/e2e/pixi-memory-lane.test.ts`, so adding a ninth test to it would break a
 * gate that is currently doing its job. Widening its `testMatch` would file a
 * non-memory test's evidence under the memory lane's name, inside the CI upload
 * allowlist.
 *
 * ## What it is for
 *
 * A canvas pointer press changes the world, and the DOM mirror is the only place a
 * screen-reader user can learn that it did. The shipped Phase 9 build got that
 * wrong: the bell's `pointertap` handler called the scene's own `activate`, so the
 * world changed and the host — the only thing that calls `publishState()` — never
 * heard about it. Two real taps left the mirror reading `Bell quiet` and the next
 * DOM click jumped to `Bell rung 3 times`. See the spec's own header for how three
 * separate gates missed it.
 *
 * ## Invariants this config is responsible for
 *
 * - **Preview only.** The build and the recorded identity belong to the CI steps and
 *   the documented local command sequence. A lane that could decide for itself
 *   whether to rebuild could end up measuring a different artifact than the one that
 *   was recorded — the failure the memory lane's identity check exists to prevent.
 * - **Hard fail on a missing artifact, never skip.** Same stance, same reason: a
 *   green run that measured nothing is the failure this gate exists to prevent. The
 *   guard throws at config load, because a warning let the run reach a `vite
 *   preview` of a directory that is not there and Playwright reported that as a
 *   180-second timeout rather than as the missing build.
 * - **No trace, screenshot, or video.** Nothing this lane produces is uploaded; the
 *   only output is the return code.
 * - **A port of its own**, so it cannot contend with the memory lane's preview
 *   server if both ever run in the same job.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

import {
  PIXI_MEMORY_LANE,
  PIXI_POINTER_LANE,
  PIXI_POINTER_PREVIEW_PORT,
  PIXI_POINTER_PREVIEW_SCRIPT,
} from './pixi-memory-lane';

// `process.cwd()`, not `__dirname`: these configs are ES modules, where `__dirname`
// does not exist. It matches the memory lane's own config, and it is why every npm
// script that loads a config runs from the repository root.
const REPO_ROOT = process.cwd();
const DIST_DIR = path.resolve(REPO_ROOT, 'dist');
const MANIFEST_PATH = path.resolve(REPO_ROOT, PIXI_MEMORY_LANE.manifestPath);

if (!existsSync(DIST_DIR)) {
  throw new Error(
    'The Pixi canvas-pointer gate has no built artifact to test. ' +
      `Run "npm run ${PIXI_POINTER_LANE.buildScript}" first, then record and verify its identity with ` +
      `"npm run ${PIXI_POINTER_LANE.recordScript}" and "npm run ${PIXI_POINTER_LANE.verifyScript}". ` +
      'In CI the artifact is downloaded and identity-verified immediately before this lane runs, so ' +
      'reaching this message there means the upload or download chain broke rather than that a build ' +
      'is missing.',
  );
}
if (!existsSync(MANIFEST_PATH)) {
  throw new Error(
    'The Pixi canvas-pointer gate has no recorded Pixi-flagged artifact identity at ' +
      `${PIXI_MEMORY_LANE.manifestPath}. Run "npm run ${PIXI_POINTER_LANE.buildScript}" followed by ` +
      `"npm run ${PIXI_POINTER_LANE.recordScript}". This lane refuses to test an artifact whose ` +
      'identity it cannot confirm.',
  );
}

export default defineConfig({
  // Relative to this file, which is not at the repository root.
  testDir: '../phase9/browser',
  // Under `artifacts/`, like the memory lane, and not Playwright's default
  // `test-results/` at the repository root. `artifacts` is gitignored; a
  // root-level `test-results/` is not, so the default would drop an untracked
  // directory into the source tree on every run — and, because the CI upload
  // allowlist is rooted at `artifacts/`, putting a lane's output inside the
  // ignored tree is also what keeps it away from every upload.
  outputDir: path.resolve(REPO_ROOT, 'artifacts/pixi-pointer-test-results'),
  testMatch: PIXI_POINTER_LANE.testFile,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // One worker: the two lanes share a `dist` and the world is a single-screen
  // surface, so a second worker adds contention without adding evidence.
  workers: 1,
  reporter: [['list']],
  timeout: PIXI_POINTER_LANE.timeout,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PIXI_POINTER_PREVIEW_PORT}`,
    viewport: { ...PIXI_POINTER_LANE.viewport },
    deviceScaleFactor: PIXI_POINTER_LANE.deviceScaleFactor,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: PIXI_POINTER_PREVIEW_SCRIPT,
    // Explicit, because Playwright defaults this to the *config file's* directory
    // and this config is not at the repository root.
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${PIXI_POINTER_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: PIXI_POINTER_LANE.project,
      use: { browserName: 'chromium' },
    },
  ],
} satisfies PlaywrightTestConfig);
