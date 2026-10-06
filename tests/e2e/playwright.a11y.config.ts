import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

import { buildLocalRunId } from './compat-evidence';
import { A11Y_CELLS, A11Y_SCANNED_SURFACES, A11Y_WCAG_TAGS } from './a11y-matrix';

/**
 * The Phase 21 automated accessibility suite.
 *
 * ## Why this config exists rather than a project on the default one
 *
 * `playwright.config.ts` generates one project per support-matrix entry and binds each to
 * `currentBuild.spec.ts` or `compatibility.spec.ts`, and `tests/e2e/support-matrix.test.ts` enforces
 * both the project list and each project's `testMatch`. Widening either would break a gate that
 * works and would file this suite's evidence under the Phase 1 suite's name. So this config has its
 * own projects, generated from the **same** `SUPPORT_MATRIX` rows - so a cell cannot drift from the
 * matrix - and bound to one spec.
 *
 * ## Which projects are generated here, and which are selected
 *
 * All eight cells are **generated**, so a reader of this file sees the full matrix, and
 * `scripts/run-a11y-audit.mjs` **selects** the subset this host can run by passing `--project` for
 * each. A cell whose browser cannot launch is absent from the run, and the runner names it and why;
 * it is not generated-and-skipped, because a generated project that never runs is indistinguishable
 * from one that ran and passed once you are reading a log.
 *
 * ## No raw failure artifacts
 *
 * Trace, screenshot and video are off. A Playwright trace embeds a font file, and a trace under
 * `artifacts/` is what makes a repository-wide font walk report a shipped `.ttf` the artifact does
 * not ship - a false red this repository has already hit once.
 *
 * ## The preview is the production artifact
 *
 * `build:web` and its recorded identity, never a flagged build: an accessibility result is a claim
 * about the application a learner downloads, and the flags that gate four of Phase 19's surfaces
 * would make the same page scan differently from one build to the next.
 */

const RUN_ID = process.env.KD_COMPAT_RUN_ID ?? buildLocalRunId(new Date(), process.pid);
process.env.KD_COMPAT_RUN_ID = RUN_ID;

const REPO_ROOT = process.cwd();

const RESULTS_DIR = path.join(REPO_ROOT, 'artifacts/a11y-test-results');
const REPORT_DIR = path.join(REPO_ROOT, 'artifacts/playwright-a11y-report');

/** The preview origin, shared with `playwright.config.ts`'s production preview port. */
export const A11Y_PREVIEW_PORT = 43173;
export const A11Y_PREVIEW_SCRIPT = 'npm run preview:e2e';

/**
 * One project per matrix cell, from the matrix row.
 *
 * `isMobileEmulation` is honoured only where the matrix sets it, because the matrix validates that
 * a non-Chromium engine never carries it (`validateSupportMatrix`), and this config reads the same
 * field rather than deciding for itself.
 */
function projectForCell(cell: (typeof A11Y_CELLS)[number]): Project {
  const isCurrentBuildFormFactor =
    cell.formFactor === 'desktop' || cell.formFactor === 'chromebook' || cell.formFactor.startsWith('tablet');
  return {
    name: `a11y-${cell.project}`,
    use: {
      ...(isCurrentBuildFormFactor ? devices['Desktop Chrome'] : {}),
      browserName: cell.engine,
      viewport: { ...cell.viewport },
      deviceScaleFactor: 1,
      hasTouch: cell.hasTouch,
      ...(cell.channelOption === undefined ? {} : { channel: cell.channelOption }),
      trace: 'off',
      screenshot: 'off',
      video: 'off',
    },
    outputDir: RESULTS_DIR,
  };
}

export default defineConfig({
  testDir: '.',
  testMatch: 'a11yAudit.spec.ts',
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
  // Long enough for the tutorial route to mint a subject and mount the village world in a
  // software-rasterised context on a loaded runner, and for two axe analyses on top of that. Two
  // engines are the slowest and a machine several times slower than the one this was measured on
  // is the case the margin is for.
  timeout: 240_000,
  use: {
    baseURL: `http://127.0.0.1:${A11Y_PREVIEW_PORT}`,
    headless: true,
    // Blocked, because the plan's offline requirement is Phase 22's and a service worker in a
    // scan would make two runs of the same cell measure different things.
    serviceWorkers: 'block',
    acceptDownloads: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: A11Y_PREVIEW_SCRIPT,
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${A11Y_PREVIEW_PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: A11Y_CELLS.map(projectForCell),
});

/**
 * What the suite scans, printed at config load so a run's log says what it covered.
 *
 * `console.log` rather than a comment, because the log is the artifact a reader has. A report that
 * says "the accessibility suite passed" without saying which surfaces were scanned is the failure
 * this whole file exists to make impossible.
 */
console.log(
  `[a11y] ${A11Y_CELLS.length} cell(s) generated from the support matrix; ` +
    `${A11Y_SCANNED_SURFACES.length} surface(s) scanned (${A11Y_SCANNED_SURFACES.map((surface) => surface.id).join(', ')}) ` +
    `with tags ${A11Y_WCAG_TAGS.join(', ')}.`,
);