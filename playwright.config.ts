import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';
import { buildLocalRunId } from './tests/e2e/compat-evidence';
import {
  COMPATIBILITY_TEST_FILE,
  CURRENT_BUILD_TEST_FILE,
  isPhase1CurrentBuildProject,
  SUPPORT_MATRIX,
  type SupportMatrixEntry,
} from './tests/e2e/support-matrix';

const PRODUCTION_PREVIEW_URL = 'http://127.0.0.1:43173';
const DIST_DIR = path.resolve('dist');
const WEB_ARTIFACT_MANIFEST_PATH = path.resolve('artifacts/web-artifact-manifest.json');

/**
 * One sanitized run identifier per Playwright invocation. It is exported through
 * the environment so every worker of a run shares it, and it carries seconds,
 * milliseconds, and a per-process discriminator so two invocations cannot
 * overwrite each other's compatibility evidence.
 */
const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

/**
 * Phase 1A build-once rule. Playwright only ever previews an existing `dist`
 * tree: package scripts build and record the artifact before the relevant suite,
 * and CI jobs download the shared artifact uploaded by the single build job. The
 * suite never decides whether to rebuild based on its arguments, so a lane can
 * never silently test a different artifact than the one that was recorded.
 */
if (!existsSync(DIST_DIR)) {
  console.warn(
    'No dist/ directory found. Run "npm run build:web" (or download the shared CI artifact) ' +
      'before running a Playwright suite.',
  );
}
if (!existsSync(WEB_ARTIFACT_MANIFEST_PATH)) {
  console.warn(
    'No recorded web-artifact identity found. Compatibility lanes require ' +
      '"npm run build:web && npm run record:web-artifact" or the artifact uploaded by the CI build job.',
  );
}

/**
 * Project generation is driven by the support matrix so a Playwright project can
 * never drift from the documented host, engine, channel, form factor, and
 * evidence classification. The four Phase 1 viewport projects keep their
 * verified `devices['Desktop Chrome']` descriptors and their existing failure
 * evidence behavior. The compatibility projects deliberately use no user-agent
 * override, and they disable traces, screenshots, and video so a failing
 * compatibility lane cannot leave a raw DOM, network, or video artifact.
 */
function projectForEntry(entry: SupportMatrixEntry): Project {
  const isCurrentBuild = isPhase1CurrentBuildProject(entry.project);
  const engine: Project['use'] = {
    browserName: entry.engine,
    viewport: { ...entry.viewport },
    deviceScaleFactor: entry.deviceScaleFactor,
    hasTouch: entry.hasTouch,
  };

  if (isCurrentBuild) {
    return {
      name: entry.project,
      testMatch: CURRENT_BUILD_TEST_FILE,
      use: {
        ...devices['Desktop Chrome'],
        ...engine,
        ...(entry.isMobileEmulation ? { isMobile: true } : {}),
      },
    };
  }

  return {
    name: entry.project,
    testMatch: COMPATIBILITY_TEST_FILE,
    outputDir: 'artifacts/compat-test-output',
    use: {
      ...engine,
      ...(entry.isMobileEmulation ? { isMobile: true } : {}),
      ...(entry.channelOption ? { channel: entry.channelOption } : {}),
      trace: 'off',
      screenshot: 'off',
      video: 'off',
    },
  };
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }],
  ],
  outputDir: 'artifacts/test-results',
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run preview:e2e',
    url: PRODUCTION_PREVIEW_URL,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: SUPPORT_MATRIX.map(projectForEntry),
});
