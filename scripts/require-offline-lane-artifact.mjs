#!/usr/bin/env node
/**
 * Preflight for the Phase 22 offline-shell browser lane.
 *
 * Run before Playwright starts, and only then, for the reason
 * `scripts/require-pixi-lane-artifact.mjs` records: a module-scope throw in a
 * Playwright config makes importing that config fatal in a checkout with no build,
 * including the unit-test job. So the config module stays importable and
 * side-effect free, and this command is what turns "the artifact is missing" into a
 * one-line diagnosis instead of a 180-second webServer timeout.
 *
 * It checks four things: a `dist/` exists, it has an `index.html`, it has the
 * generated `offline-shell-manifest.js` (proof the offline plugin actually ran on
 * this build), and a recorded identity exists for the build to be confirmed
 * against. It does not parse the manifest - `scripts/web-artifact-manifest.mjs`
 * owns that - and it never prints anything but repository-relative paths.
 *
 * Usage: node scripts/require-offline-lane-artifact.mjs
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DIST_DIR = path.join(REPO_ROOT, 'dist');
const MANIFEST_PATH = path.join(REPO_ROOT, 'artifacts/web-artifact-manifest-offline.json');

function fail(problem, remedy) {
  console.error(
    `The offline-shell lane cannot run: ${problem}\n\n` +
      `  ${remedy}\n\n` +
      '  It is run by `npm run test:e2e:offline:recorded`, the same command CI will run,\n' +
      '  so the local and CI invocations cannot drift. The flagged artifact is built by\n' +
      '  `npm run test:e2e:offline:full` (or the shared CI build job) and recorded before\n' +
      '  this preflight. See tests/e2e/playwright.offline.config.ts.',
  );
  process.exit(1);
}

if (!existsSync(DIST_DIR)) {
  fail('there is no `dist/` directory to preview.', 'Build it with `npm run build:web:offline`.');
}
if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  fail(
    '`dist/` exists but has no `index.html`, so it is a partial build rather than a web artifact.',
    'Rebuild it with `npm run build:web:offline`.',
  );
}
if (!existsSync(path.join(DIST_DIR, 'offline-shell-manifest.js'))) {
  fail(
    '`dist/` has no `offline-shell-manifest.js`, so this build was not made with `VITE_OFFLINE_SHELL=true`.',
    'Build it with `npm run build:web:offline` (the default build deliberately emits no shell).',
  );
}
if (!existsSync(path.join(DIST_DIR, 'sw.js'))) {
  fail(
    '`dist/` has no `sw.js`, so this build did not carry the hand-written service worker.',
    'Build it with `npm run build:web:offline`.',
  );
}
if (!existsSync(MANIFEST_PATH)) {
  fail(
    'there is no recorded offline artifact identity to confirm the build against.',
    'Record one with `npm run record:web-artifact:offline` after `npm run build:web:offline`.',
  );
}
