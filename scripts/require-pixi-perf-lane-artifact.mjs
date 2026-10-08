#!/usr/bin/env node
/**
 * Preflight for the Phase 22 Pixi-dungeon frame-time lane.
 *
 * Run before Playwright starts, and only then, for the reason
 * `scripts/require-pixi-lane-artifact.mjs` records: a module-scope throw in a
 * Playwright config makes importing that config fatal in a checkout with no build,
 * including the unit-test job. So the config module stays importable and side-effect
 * free, and this command is what turns "the artifact is missing" into a one-line
 * diagnosis instead of a 180-second webServer timeout.
 *
 * It checks three things: a `dist/` exists, it has an `index.html`, and its emitted
 * `bundle-census.json` carries a present `renderer:pixi` boundary. That last check is
 * what makes this preflight specific to the **dungeon-flagged** build rather than to
 * any web artifact: `VITE_PIXI_DUNGEON=true` is the only build script that leaves the
 * renderer at `phaser` while emitting a Pixi chunk, and a lane pointed at the wrong
 * `dist` — the default build, or the Phase 9 `VITE_WORLD_RENDERER=pixi` build — would
 * otherwise preview a tree with no dungeon to measure. It does not parse the manifest;
 * `scripts/web-artifact-manifest.mjs` owns that.
 *
 * Privacy: reads repository files and prints only repository-relative paths. No learner
 * data, no request body, no credentials, no network.
 *
 * Usage: node scripts/require-pixi-perf-lane-artifact.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DIST_DIR = path.join(REPO_ROOT, 'dist');
const CENSUS_PATH = path.join(DIST_DIR, 'bundle-census.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'artifacts/web-artifact-manifest-pixi-dungeon.json');

const buildScript = 'build:web:pixi-dungeon';
const recordScript = 'record:web-artifact:pixi-dungeon';
const verifyScript = 'verify:web-artifact:pixi-dungeon';

function fail(problem, remedy) {
  console.error(
    `The Pixi dungeon frame-time lane cannot run: ${problem}\n\n` +
      `  ${remedy}\n\n` +
      '  It is run by `npm run test:e2e:pixi-perf:recorded`, the same command CI runs,\n' +
      '  so the local and CI invocations cannot drift. The flagged artifact is built by\n' +
      '  `npm run test:e2e:pixi-perf:full` (or the shared CI build job) and recorded before\n' +
      '  this preflight. See tests/e2e/playwright.pixi-perf.config.ts.',
  );
  process.exit(1);
}

if (!existsSync(DIST_DIR)) {
  fail('there is no `dist/` directory to preview.', `Build it with \`npm run ${buildScript}\`.`);
}
if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  fail(
    '`dist/` exists but has no `index.html`, so it is a partial build rather than a web artifact.',
    `Rebuild it with \`npm run ${buildScript}\`.`,
  );
}

let census;
try {
  census = JSON.parse(readFileSync(CENSUS_PATH, 'utf8'));
} catch {
  fail(
    'there is no readable `bundle-census.json` in `dist/`, so this build cannot state what it emitted.',
    `Rebuild it with \`npm run ${buildScript}\`.`,
  );
}

const pixiBoundary = Array.isArray(census?.boundaries)
  ? census.boundaries.find((boundary) => boundary?.id === 'renderer:pixi')
  : undefined;
if (!pixiBoundary || pixiBoundary.present !== true) {
  fail(
    '`dist/` has no present `renderer:pixi` boundary, so this build was not made with `VITE_PIXI_DUNGEON=true`.',
    `Build it with \`npm run ${buildScript}\` (the default build deliberately emits no Pixi dungeon chunk).`,
  );
}

if (!existsSync(MANIFEST_PATH)) {
  fail(
    'there is no recorded Pixi-dungeon artifact identity to confirm the build against.',
    `Record one with \`npm run ${recordScript}\` after \`npm run ${buildScript}\`, then verify it with\n` +
      `  \`npm run ${verifyScript}\`.`,
  );
}
