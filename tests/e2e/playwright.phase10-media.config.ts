/**
 * The Phase 10 audio and asset lane's Playwright config.
 *
 * ## Why this previews the production artifact
 *
 * The two Pixi lanes need `VITE_WORLD_RENDERER=pixi` because the world host is
 * only in that build. This lane's subject is renderer-neutral: the audio service
 * has no engine import at all, and the asset runtime is reached by importing the
 * module under test rather than by mounting a route. So it previews the production
 * `dist` and its own recorded identity, which is also what makes its privacy and
 * settings claims evidence about the artifact that actually ships.
 *
 * ## Invariants this config is responsible for
 *
 * - **Preview only.** The build and the recorded identity belong to the CI steps
 *   and to the documented local command sequence. A lane that could decide for
 *   itself whether to rebuild could end up measuring a different artifact than the
 *   one that was recorded.
 * - **Hard fail on a missing artifact, never skip.** Same stance, same reason: a
 *   green run that measured nothing is the failure this gate exists to prevent. The
 *   guard lives in `scripts/require-phase10-lane-artifact.mjs` as a command, so
 *   that importing this config in a checkout with no `dist/` — which
 *   `tests/e2e/phase10-media-lane.test.ts` does — is not fatal.
 * - **No trace, screenshot, or video.** Nothing this lane produces is uploaded;
 *   the only output is the return code and sanitized JSON evidence.
 * - **A port of its own**, so it cannot contend with any other lane's preview
 *   server if two ever run in the same job.
 * - **One worker.** The subject is a single-screen settings surface, so a second
 *   worker adds contention without adding evidence.
 *
 * The accessibility scan is not a Playwright project here. The four viewports it
 * measures are emulated *inside* one spec, with one browser and four contexts,
 * because a project per viewport would multiply the audio journey by four for no
 * additional evidence; the spec header records why.
 */
import path from 'node:path';

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

import {
  PHASE10_MEDIA_DEV_SCRIPT,
  PHASE10_MEDIA_LANE,
  PHASE10_MEDIA_PREVIEW_SCRIPT,
} from './phase10-media-lane';

// `process.cwd()`, not `__dirname`: these configs are ES modules, where `__dirname`
// does not exist. It matches the other two lane configs, and it is why every npm
// script that loads a config runs from the repository root.
const REPO_ROOT = process.cwd();

export default defineConfig({
  // Relative to this file, which is not at the repository root.
  testDir: '../phase10/browser',
  // Under `artifacts/`, like the Pixi lanes, and not Playwright's default
  // `test-results/` at the repository root. `artifacts` is gitignored; a
  // root-level `test-results/` is not, so the default would drop an untracked
  // directory into the source tree on every run — and, because the CI upload
  // allowlist is rooted at `artifacts/`, putting a lane's output inside the
  // ignored tree is also what keeps it away from every upload.
  outputDir: path.resolve(REPO_ROOT, 'artifacts/phase10-media-test-results'),
  testMatch: PHASE10_MEDIA_LANE.testFile,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list']],
  // 180 seconds, not the usual 60. The accessibility test is the slow one: it
  // boots the Phaser world *and* runs two full axe analyses (panel-scoped and
  // whole-page) at four viewports, and the narrowest of those is measurably the
  // slowest. The bound exists to make a hanging run diagnosable rather than to
  // tune a passing one — a healthy run is a few seconds.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: PHASE10_MEDIA_LANE.previewOrigin,
    viewport: { ...PHASE10_MEDIA_LANE.viewport },
    deviceScaleFactor: PHASE10_MEDIA_LANE.deviceScaleFactor,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: [
    {
      // The recorded production artifact. Every product-level claim is made here.
      command: PHASE10_MEDIA_PREVIEW_SCRIPT,
      // Explicit, because Playwright defaults this to the *config file's* directory
      // and this config is not at the repository root.
      cwd: REPO_ROOT,
      url: PHASE10_MEDIA_LANE.previewOrigin,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The same checkout served unbundled, for the two checks that must *call* the
      // shipped module. The built artifact does not export its modules, so without
      // this there is no request to gate and no bundle to fail, and both of those
      // absences would make an assertion pass for the wrong reason. The spec header
      // and the lane's `doesNotProve` both say which surface each test is on.
      command: PHASE10_MEDIA_DEV_SCRIPT,
      cwd: REPO_ROOT,
      url: PHASE10_MEDIA_LANE.devOrigin,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: PHASE10_MEDIA_LANE.project,
      use: { browserName: 'chromium' },
    },
  ],
}) satisfies PlaywrightTestConfig;
