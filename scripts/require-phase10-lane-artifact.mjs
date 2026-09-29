#!/usr/bin/env node
/**
 * Preflight for the Phase 10 audio and asset browser lane.
 *
 * ## Why this is a separate script and not a guard at the top of the config
 *
 * Because of what it cost the Pixi lanes when it was the other way round, and
 * because `scripts/require-pixi-lane-artifact.mjs` records the whole story: a
 * module-scope `throw` in a lane config made the *wiring gate* that imports the
 * config to assert its shape fatal in any checkout without a built artifact,
 * including the `unit-tests` CI job, which has none and never should. Both configs
 * are therefore importable and side-effect free, and this check runs only when a
 * person or CI actually invokes the lane.
 *
 * ## What it does
 *
 * Exits non-zero with one sentence naming what is missing and what to run. Fast
 * enough to cost nothing: a handful of `stat` calls. It deliberately does not check
 * the manifest's *contents* — the lane does that through
 * `scripts/web-artifact-manifest.mjs`, which can tell a stale artifact from an
 * absent one. This only establishes that there is something to check.
 *
 * ## Why it is a separate file rather than a flag on the Pixi preflight
 *
 * The Pixi preflight hard-codes the Pixi-flagged manifest and names the Pixi
 * scripts in its remedy text. Adding a `--production` flag would make one script
 * carry two lanes' vocabulary and two lanes' remedy sentences, and the wiring
 * gates that assert the Pixi script's text would then be asserting about a script
 * that had grown a second job. Two small scripts with one job each is easier to
 * read and easier to keep honest.
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

const LABEL = 'The Phase 10 audio and asset lane';
const CONFIG = 'tests/e2e/playwright.phase10-media.config.ts';
const buildScript = 'build:web';
const recordScript = 'record:web-artifact';
const verifyScript = 'verify:web-artifact';

function fail(problem, remedy) {
  console.error(
    `${LABEL} cannot run: ${problem}\n\n` +
      `  ${remedy}\n\n` +
      `  It is run by \`npm run test:e2e:phase10-media:recorded\`,\n` +
      '  which is the same command CI runs, so the local and CI invocations cannot drift.\n' +
      `  This lane previews the *production* artifact, so it needs the production build and the\n` +
      `  production identity rather than the Pixi-flagged ones. The Pixi lanes have their own\n` +
      `  preflight for those. See ${CONFIG}.`,
  );
  process.exit(1);
}

const distDir = path.join(REPO_ROOT, 'dist');
const manifest = path.join(REPO_ROOT, 'artifacts/web-artifact-manifest.json');

if (!existsSync(distDir)) {
  fail(
    'there is no `dist/` directory to preview.',
    `Build it with \`npm run ${buildScript}\`, or download a recorded artifact.`,
  );
}
if (!existsSync(path.join(distDir, 'index.html'))) {
  fail(
    '`dist/` exists but has no `index.html`, so it is a partial build rather than a web artifact.',
    `Rebuild it with \`npm run ${buildScript}\`. A partial \`dist/\` is a common source of confusing\n` +
      '  failures elsewhere in this repository, which is why this case is distinct from the one above.',
  );
}
if (!existsSync(manifest)) {
  fail(
    'there is no recorded production artifact identity to confirm the build against.',
    `Record one with \`npm run ${recordScript}\` after \`npm run ${buildScript}\`, then verify it with\n` +
      `  \`npm run ${verifyScript}\`.`,
  );
}
