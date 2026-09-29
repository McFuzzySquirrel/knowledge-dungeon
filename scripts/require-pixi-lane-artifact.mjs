#!/usr/bin/env node
/**
 * Preflight for the two Pixi browser lanes, run before Playwright starts.
 *
 * ## Why this is a separate script and not a guard at the top of the config
 *
 * Because of what it cost when it was the other way round. Both lane configs
 * originally warned at module scope when `dist/` or the recorded manifest was
 * missing, and the run then reached a `vite preview` of a directory that was not
 * there — which Playwright reports as a 180-second webServer timeout rather than
 * as the missing build. Making that guard `throw` fixed the diagnosis and broke
 * `npm test`: `tests/e2e/pixi-memory-lane.test.ts` imports the config module to
 * assert its shape, so a top-level throw made importing it fatal in any checkout
 * without a built artifact, including the `unit-tests` CI job, which has none and
 * never should.
 *
 * That is the same defect class the Phase 8 hermeticity guard exists for — a gate
 * that depends on state a clean checkout does not have — reintroduced while fixing
 * a different one. So the check lives here, in the command, where it runs only
 * when a person or CI actually invokes the lane, and the config module is left
 * importable and side-effect free.
 *
 * ## What it does
 *
 * Exits non-zero with one sentence naming what is missing and what to run. Fast
 * enough to cost nothing: a handful of `stat` calls. It deliberately does not
 * check the manifest's *contents* — the lane does that through
 * `scripts/web-artifact-manifest.mjs`, which can tell a stale artifact from an
 * absent one. This only establishes that there is something to check.
 *
 * ## Privacy
 *
 * Reads two paths and prints only repository-relative paths. No learner data, no
 * request body, no credentials, no network.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** `npm run <script>`, for a message a reader can paste. */
const buildScript = 'build:web:pixi';
const recordScript = 'record:web-artifact:pixi';
const verifyScript = 'verify:web-artifact:pixi';

const lanes = {
  memory: {
    label: 'The Pixi world memory lane',
    config: 'tests/e2e/playwright.pixi-memory.config.ts',
  },
  pointer: {
    label: 'The Pixi canvas-pointer gate',
    config: 'tests/e2e/playwright.pixi-pointer.config.ts',
  },
};

function fail(lane, problem, remedy) {
  console.error(
    `${lane.label} cannot run: ${problem}\n\n` +
      `  ${remedy}\n\n` +
      `  It is run by \`npm run test:e2e:pixi-${lane === lanes.memory ? 'memory' : 'pointer'}:recorded\`,\n` +
      '  which is the same command CI runs, so the local and CI invocations cannot drift.\n' +
      '  In CI the flagged artifact is built by the `web-build` job, uploaded, downloaded and\n' +
      '  identity-verified immediately before this lane, so reaching this message there means the\n' +
      `  upload or download chain broke rather than that a build is missing. See ${lane.config}.`,
  );
  process.exit(1);
}

// Both lanes share one preflight, so it reports the memory lane's name and points
// at the pointer gate's config only when that is the one invoked. The command is
// one script for both so the two cannot drift.
const lane = process.argv.includes('--pointer') ? lanes.pointer : lanes.memory;
const distDir = path.join(REPO_ROOT, 'dist');
const manifest = path.join(REPO_ROOT, 'artifacts/web-artifact-manifest-pixi.json');

if (!existsSync(distDir)) {
  fail(
    lane,
    'there is no `dist/` directory to measure.',
    `Build it with \`npm run ${buildScript}\`, or download a recorded artifact.`,
  );
}
if (!existsSync(path.join(distDir, 'index.html'))) {
  fail(
    lane,
    '`dist/` exists but has no `index.html`, so it is a partial build rather than a web artifact.',
    `Rebuild it with \`npm run ${buildScript}\`. A partial \`dist/\` is a common source of confusing\n` +
      '  failures elsewhere in this repository, which is why this case is distinct from the one above.',
  );
}
if (!existsSync(manifest)) {
  fail(
    lane,
    'there is no recorded Pixi-flagged artifact identity to confirm the build against.',
    `Record one with \`npm run ${recordScript}\` after \`npm run ${buildScript}\`, then verify it with\n` +
      `  \`npm run ${verifyScript}\`.`,
  );
}
