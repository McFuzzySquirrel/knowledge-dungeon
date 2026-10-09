#!/usr/bin/env node
/**
 * Preflight for the two Phase 17 fishing browser lanes, run before Playwright starts.
 *
 * ## Why this is a script and not a guard at the top of the config
 *
 * Because of what it cost when it was the other way round, and `scripts/require-pixi-lane-artifact.mjs`
 * records the whole story: both lane configs originally warned at module scope when `dist/` or
 * the recorded manifest was missing, and the run then reached a `vite preview` of a directory
 * that was not there — which Playwright reports as a 180-second webServer timeout rather than
 * as the missing build. Making that guard `throw` fixed the diagnosis and broke `npm test`,
 * because `tests/e2e/fishing-lane.test.ts` imports the config module to assert its shape, so a
 * top-level throw made importing it fatal in any checkout without a built artifact, including
 * the `unit-tests` CI job, which has none and never should.
 *
 * So the check lives here, in the command, where it runs only when a person or CI actually
 * invokes a lane, and the config module stays importable and side-effect free.
 *
 * ## Why there are two lanes behind one script
 *
 * The rollback line for Phase 17 is `VITE_PIXI_FISHING=false`, and the rollback half of a
 * cutover is evidence like any other half: "the same entry point reaches the Phaser
 * `FishingScene`" is a claim about the **default production artifact**. One manifest path for
 * both lanes would let a rollback claim be verified against an artifact that still contains
 * the pond, which is the exact confusion this script makes impossible: each lane's manifest is
 * named here, so a rollback run that was handed a flagged `dist` fails on the recorded identity
 * in `scripts/web-artifact-manifest.mjs` rather than passing silently.
 *
 * ## What it does
 *
 * Exits non-zero with one sentence naming what is missing and what to run. Fast enough to cost
 * nothing: a handful of `stat` calls. It deliberately does not check the manifest's
 * *contents* — the lane does that through `scripts/web-artifact-manifest.mjs`, which can tell
 * a stale artifact from an absent one. This only establishes that there is something to check.
 *
 * ## Privacy
 *
 * Reads two paths and prints only repository-relative paths. No learner data, no request body,
 * no credentials, no network.
 *
 * Usage:
 *   node scripts/require-fishing-lane-artifact.mjs              # the flagged pond lane
 *   node scripts/require-fishing-lane-artifact.mjs --rollback   # the default-artifact rollback lane
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const lanes = {
  pond: {
    label: 'The Pixi fishing lane',
    /** `npm run <script>`, for a message a reader can paste. */
    buildScript: 'build:web:pixi-fishing',
    recordScript: 'record:web-artifact:pixi-fishing',
    verifyScript: 'verify:web-artifact:pixi-fishing',
    manifest: 'artifacts/web-artifact-manifest-pixi-fishing.json',
    config: 'tests/e2e/playwright.fishing.config.ts',
    /** The npm script a person runs this lane through, and the one CI would run. */
    runScript: 'test:e2e:fishing:recorded',
  },
  rollback: {
    label: 'The fishing rollback lane',
    buildScript: 'build:web:rollback',
    recordScript: 'record:web-artifact:rollback',
    verifyScript: 'verify:web-artifact:rollback',
    manifest: 'artifacts/web-artifact-manifest-rollback.json',
    config: 'tests/e2e/playwright.fishing.config.ts',
    runScript: 'test:e2e:fishing:rollback:recorded',
  },
};

function fail(lane, problem, remedy) {
  console.error(
    `${lane.label} cannot run: ${problem}\n\n` +
      `  ${remedy}\n\n` +
      `  It is run by \`npm run ${lane.runScript}\`, which is the same command CI runs, so the local\n` +
      '  and CI invocations cannot drift.\n' +
      `  See ${lane.config} and tests/e2e/fishing-lane.ts for what this lane does and does not claim.`,
  );
  process.exit(1);
}

// `--rollback` selects the lane; anything else is the flagged pond lane, so an unrecognised
// argument cannot silently preflight the wrong manifest.
const lane = process.argv.includes('--rollback') ? lanes.rollback : lanes.pond;
const distDir = path.join(REPO_ROOT, 'dist');
const manifest = path.join(REPO_ROOT, lane.manifest);

if (!existsSync(distDir)) {
  fail(
    lane,
    'there is no `dist/` directory to measure.',
    `Build it with \`npm run ${lane.buildScript}\`, or download a recorded artifact.`,
  );
}
if (!existsSync(path.join(distDir, 'index.html'))) {
  fail(
    lane,
    '`dist/` exists but has no `index.html`, so it is a partial build rather than a web artifact.',
    `Rebuild it with \`npm run ${lane.buildScript}\`. A partial \`dist/\` is a common source of confusing\n` +
      '  failures elsewhere in this repository, which is why this case is distinct from the one above.',
  );
}
if (!existsSync(manifest)) {
  fail(
    lane,
    `there is no recorded artifact identity to confirm the build against (${lane.manifest}).`,
    `Record one with \`npm run ${lane.recordScript}\` after \`npm run ${lane.buildScript}\`, then verify it with\n` +
      `  \`npm run ${lane.verifyScript}\`.`,
  );
}