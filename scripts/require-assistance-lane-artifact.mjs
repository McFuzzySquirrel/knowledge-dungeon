#!/usr/bin/env node
/**
 * Preflight for the two Phase 21 assistance browser lanes, run before Playwright starts.
 *
 * ## Why this is a script and not a guard at the top of a config
 *
 * Because of what it cost when it was the other way round, and
 * `scripts/require-pixi-lane-artifact.mjs` records the whole story: both lane configs
 * originally warned at module scope when `dist/` or the recorded manifest was missing, and the
 * run then reached a `vite preview` of a directory that was not there - which Playwright
 * reports as a 180-second webServer timeout rather than as the missing build. Making that
 * guard `throw` fixed the diagnosis and broke `npm test`, because
 * `tests/e2e/assistance-lane.test.ts` imports the config modules to assert their shape, so a
 * top-level throw made importing them fatal in any checkout without a built artifact,
 * including the `unit-tests` CI job, which has none and never should.
 *
 * So the check lives here, in the command, where it runs only when a person or CI actually
 * invokes a lane, and the config modules stay importable and side-effect free.
 *
 * ## What this checks that the other two preflights do not
 *
 * `require-fishing-lane-artifact.mjs` and `require-pixi-lane-artifact.mjs` establish that
 * there is *something* to measure: a `dist/` with an `index.html` and a recorded manifest. That
 * is necessary and it is not sufficient here, and the reason is measured rather than assumed.
 *
 * On the **default** build the lane chunks are emitted anyway. Measured at this phase:
 * `assets/AssistanceRegion-*.js` and `assets/assistanceStore-*.js` exist in both builds, and
 * `vite.config.ts`'s own census prints `2/2 declared path(s) fetchable` for both. So "the
 * artifact contains assistance code" is **not** distinguishable from "the artifact is a
 * default one" by looking for a chunk file, and a preflight that looked for the file would
 * pass on a default `dist/`: a configured lane that verifies nothing, which is the Phase 17
 * defect this exists to prevent.
 *
 * What genuinely differs is the **compiled flag constant**. Vite substitutes `import.meta.env`
 * with an object literal carrying only the keys the build actually has, so:
 *
 * - a `VITE_ADAPTIVE_ASSISTANCE=true` build contains `VITE_ADAPTIVE_ASSISTANCE:` + a `true`
 *   string literal inside that object;
 * - a default build's object omits the key entirely.
 *
 * This script reads that out of the **emitted bytes of `dist/`** - not out of
 * `process.env`, which says what the shell asked for rather than what the artifact contains -
 * and requires, per lane, that it is present for the flagged lane and absent for the default
 * one. Combined with the recorded-identity manifest each lane names, a lane handed the other
 * lane's `dist/` is red here before Playwright starts.
 *
 * Three more facts are established, each cheap and each load-bearing:
 *
 * 1. **The lane's lazy chunks exist.** Presence, not the discriminator - but "the artifact
 *    contains assistance code" has to be checkable at all, so a build where the lane was
 *    tree-shaken away is red rather than a lane that measures nothing.
 * 2. **The entry document names no lane chunk.** That is the laziness the flagged build is
 *    supposed to keep, and it is the artifact-shaped version of `vite.config.ts`'s eager-edge
 *    check: a static edge would put a `modulepreload` in `dist/index.html` and every Welcome
 *    visitor would download a disabled feature. Checked here as well because this is the last
 *    gate before a browser is pointed at the tree.
 * 3. **The recorded manifest exists**, which is the identity half; the two are read together so
 *    neither can be satisfied without the other.
 *
 * ## Non-vacuity
 *
 * The flag predicate is a claim about a real difference between two real builds, so it is
 * falsifiable in both directions and `tests/e2e/assistance-lane.test.ts` exercises it against a
 * synthetic `dist/` of both shapes rather than asserting that the regex matches a string.
 *
 * ## Privacy
 *
 * Reads `dist/` and one JSON manifest path, prints only repository-relative paths and bounded
 * problem codes. No learner data, no request body, no credentials, no network.
 *
 * ## `--root`
 *
 * Overridable only so `tests/e2e/assistance-lane.test.ts` can exercise this script against a
 * synthetic `dist/` of both shapes. Every lane and every package script uses the default, so the
 * checked artifact is always this repository's own. Without it the non-vacuity proofs in that gate
 * would have to run against whichever `dist/` happened to be on disk, which is exactly the state
 * dependence this repository's Phase 8 hermeticity guard exists to forbid - a gate that cannot tell
 * a correct build from an incorrect one has to be able to be handed both.
 *
 * Usage:
 *   node scripts/require-assistance-lane-artifact.mjs            # the flagged lane
 *   node scripts/require-assistance-lane-artifact.mjs --default  # the default-artifact lane
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
/** The `--root=` override. See the header. Only this file's own tests pass it. */
const ROOT_OVERRIDE = process.argv
  .find((argument) => argument.startsWith('--root='))
  ?.slice('--root='.length);
const ROOT = ROOT_OVERRIDE === undefined ? REPO_ROOT : path.resolve(process.cwd(), ROOT_OVERRIDE);

/** The flag key as Vite emits it into the `import.meta.env` literal. */
const FLAG_ENV_KEY = 'VITE_ADAPTIVE_ASSISTANCE';

/**
 * The flag key with its compiled value.
 *
 * Quote-agnostic on purpose: the minifier chooses between `"`, `'` and a backtick and that is
 * not a contract this repository controls, while the key and the value are. A false negative
 * here would be a red preflight on a correct build, so the pattern is written to accept all
 * three rather than the one shape this build happened to emit.
 */
const FLAG_VALUE_PATTERN = new RegExp(`${FLAG_ENV_KEY}\\s*:\\s*(["'\`])(true|false)\\1`);

/**
 * The emitted lazy chunk names, as prefixes. Vite names a dynamic chunk after the module it was
 * reached through, so these are the `ASSISTANCE_LANE_PATHS` stems with their path separators
 * removed. Declared here as literals rather than imported from `vite.config.ts` because this
 * script is plain ESM run by `node`, which does not load a TypeScript module.
 */
const LANE_CHUNK_STEMS = ['AssistanceRegion', 'assistanceStore'];

/** Every name of a declared lane stem, across both the module bundle and the ES5 re-emission. */
function laneChunkNames(assetsDir) {
  const found = [];
  for (const name of readdirSync(assetsDir)) {
    for (const stem of LANE_CHUNK_STEMS) {
      if (name.startsWith(`${stem}-`) && name.endsWith('.js')) {
        found.push({ fileName: name, stem, legacy: name.includes('-legacy-') });
      }
    }
  }
  return found.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

/**
 * The ES5 re-emission is not the release path, so it is excluded.
 *
 * `vite.config.ts` states why at length: plan section 2.5's engine matrix is Chromium, Firefox
 * and WebKit, all of which support ES modules, and plan section 10.2's Welcome budget declines
 * to count the `nomodule` bundle. Reading the flag constant out of the fallback would make the
 * preflight describe a bundle no supported browser executes.
 */
function isModuleBundle(name) {
  return !name.includes('-legacy-');
}

/**
 * Where the compiled flag constant is, and with what value.
 *
 * Scans every module-bundle JavaScript chunk in `dist/assets`. The value is not expected in
 * `dist/index.html` and the scan does not read it: `import.meta.env` is substituted into the
 * chunk that calls `parseFeatureFlags(import.meta.env)`, which the bundler placed inside the
 * vendor chunk at this phase. Scanning every chunk rather than one named chunk is what keeps
 * this a statement about the artifact instead of a statement about today's chunking.
 */
function readCompiledFlag(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  const modules = [];
  for (const name of readdirSync(assetsDir).sort()) {
    if (!name.endsWith('.js') || !isModuleBundle(name)) continue;
    const source = readFileSync(path.join(assetsDir, name), 'utf8');
    const match = FLAG_VALUE_PATTERN.exec(source);
    if (match !== null) {
      modules.push({ fileName: name, value: match[2] });
    }
  }
  return modules;
}

/** The files the entry document names, for the laziness check. */
function entryDocumentReferences(distDir) {
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  return [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

const lanes = {
  flagged: {
    label: 'The flagged assistance lane',
    /** `npm run <script>`, for a message a reader can paste. */
    buildScript: 'build:web:assistance',
    recordScript: 'record:web-artifact:assistance',
    verifyScript: 'verify:web-artifact:assistance',
    manifest: 'artifacts/web-artifact-manifest-assistance.json',
    config: 'tests/e2e/playwright.assistance.config.ts',
    /** The npm script a person runs this lane through, and the one CI runs. */
    runScript: 'test:e2e:assistance:recorded',
    /** Whether the compiled flag must be `true` in this artifact. */
    expectsFlag: 'true',
  },
  default: {
    label: 'The assistance rollback lane',
    buildScript: 'build:web',
    recordScript: 'record:web-artifact',
    verifyScript: 'verify:web-artifact',
    manifest: 'artifacts/web-artifact-manifest.json',
    config: 'tests/e2e/playwright.assistance-default.config.ts',
    runScript: 'test:e2e:assistance:default:recorded',
    /** The production default, stated out loud rather than left as "absent". */
    expectsFlag: 'false',
  },
};

function fail(lane, code, problem, remedy) {
  console.error(
    `${lane.label} cannot run: ${problem}\n` +
      `  [${code}]\n\n` +
      `  ${remedy}\n\n` +
      `  It is run by \`npm run ${lane.runScript}\`, which is the same command CI runs, so the local\n` +
      '  and CI invocations cannot drift.\n' +
      `  See ${lane.config} and tests/e2e/assistance-lane.ts for what this lane does and does not claim.`,
  );
  process.exit(1);
}

// `--default` selects the lane; anything else is the flagged lane, so an unrecognised argument
// cannot silently preflight the wrong manifest.
const lane = process.argv.includes('--default') ? lanes.default : lanes.flagged;
const distDir = path.join(ROOT, 'dist');
const manifest = path.join(ROOT, lane.manifest);

if (!existsSync(distDir)) {
  fail(
    lane,
    'dist-missing',
    'there is no `dist/` directory to measure.',
    `Build it with \`npm run ${lane.buildScript}\`, or download a recorded artifact.`,
  );
}
if (!existsSync(path.join(distDir, 'index.html'))) {
  fail(
    lane,
    'dist-partial',
    '`dist/` exists but has no `index.html`, so it is a partial build rather than a web artifact.',
    `Rebuild it with \`npm run ${lane.buildScript}\`. A partial \`dist/\` is a common source of confusing\n` +
      '  failures elsewhere in this repository, which is why this case is distinct from the one above.',
  );
}
if (!existsSync(manifest)) {
  fail(
    lane,
    'manifest-missing',
    `there is no recorded artifact identity to confirm the build against (${lane.manifest}).`,
    `Record one with \`npm run ${lane.recordScript}\` after \`npm run ${lane.buildScript}\`, then verify it with\n` +
      `  \`npm run ${lane.verifyScript}\`.`,
  );
}
const assetsDir = path.join(distDir, 'assets');
if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
  fail(
    lane,
    'assets-missing',
    '`dist/` has no `assets/` directory, so there are no chunks to census.',
    `Rebuild it with \`npm run ${lane.buildScript}\`.`,
  );
}

/* ── 1. The lane's lazy chunks are present ────────────────────────────────────── */

const laneChunks = laneChunkNames(assetsDir);
for (const stem of LANE_CHUNK_STEMS) {
  const present = laneChunks.some((entry) => entry.stem === stem && !entry.legacy);
  if (!present) {
    fail(
      lane,
      'lane-chunk-missing',
      `the built artifact contains no \`${stem}-*.js\` chunk in the module bundle, so it carries no ${stem} code.`,
      'A lane whose artifact does not contain the lane it is named for verifies nothing, which is the Phase 17\n' +
        `  dead lane. Build with \`npm run ${lane.buildScript}\` and check that the chunk was emitted at all.`,
    );
  }
}

/* ── 2. The compiled flag constant says which artifact this is ────────────────── */

const compiledFlag = readCompiledFlag(distDir);
const flaggedChunks = compiledFlag.filter((entry) => entry.value === 'true');
if (lane.expectsFlag === 'true' && flaggedChunks.length === 0) {
  fail(
    lane,
    'flag-not-compiled-in',
    'no module-bundle chunk carries the compiled `VITE_ADAPTIVE_ASSISTANCE: "true"` constant, so this `dist/` was\n' +
      '    built with the feature at its production default.',
    `The preflight reads the flag out of the emitted bytes rather than out of the environment, because \`npm run ${lane.runScript}\`\n` +
      '  previews whatever `dist/` happens to hold. Rebuild with `npm run ' +
      lane.buildScript +
      '`, then re-record and\n' +
      `  re-verify the artifact identity with \`npm run ${lane.recordScript}\` and \`npm run ${lane.verifyScript}\`.`,
  );
}
if (lane.expectsFlag === 'false' && flaggedChunks.length > 0) {
  fail(
    lane,
    'flag-compiled-in',
    `the module bundle carries the compiled \`VITE_ADAPTIVE_ASSISTANCE: "true"\` constant in ` +
      `${flaggedChunks.map((entry) => entry.fileName).join(', ')}, so this \`dist/\` is a flagged artifact and not the production default.`,
    'This lane is the observation of the production default, and a green run describing a flagged build would\n' +
      '  describe something other than what it claims. Build with `npm run ' +
      lane.buildScript +
      '`, then re-record and\n' +
      `  re-verify with \`npm run ${lane.recordScript}\` and \`npm run ${lane.verifyScript}\`.`,
  );
}

/* ── 3. The entry document names no lane chunk, on either artifact ────────────── */

const entryReferences = entryDocumentReferences(distDir);
const eagerLaneChunks = entryReferences.filter((reference) =>
  LANE_CHUNK_STEMS.some((stem) => reference.includes(`${stem}-`)),
);
if (eagerLaneChunks.length > 0) {
  fail(
    lane,
    'lane-eagerly-preloaded',
    `the entry document names ${eagerLaneChunks.join(', ')}, so a Welcome visitor downloads the lane before any\n` +
      '    application code runs - on an artifact where the feature may well be switched off.',
    'Vite emits a <link rel="modulepreload"> for every statically reachable chunk. Reach the assistance lane\n' +
      '  through a dynamic import (React.lazy, or await import()) so the router, not the entry, decides when it loads.',
  );
}

/*
 * What the constant actually reads in the artifact, in words rather than by inference.
 *
 * `compiledFlag` is `[]` on a default build rather than `[{ value: 'false' }]`, because Vite's
 * substitution object omits a key the build does not have at all. Printing `lane.expectsFlag`
 * there would claim the artifact carries `VITE_ADAPTIVE_ASSISTANCE: "false"`, which is a different
 * statement from the one measured - and a message that overstates what it checked is worse than no
 * message, because it is what a reader trusts.
 */
const measuredFlag =
  flaggedChunks.length > 0 ? '"true"' : compiledFlag.length > 0 ? '"false"' : 'no such constant';

console.log(
  `${lane.label} preflight passed: ${laneChunks.filter((entry) => !entry.legacy).length} lane chunk(s) in the module ` +
    `bundle, the compiled ${FLAG_ENV_KEY} constant reads ${measuredFlag} and this lane requires ` +
    `${lane.expectsFlag === 'true' ? '"true"' : 'its absence'}, the entry document names none of the lane chunks, ` +
    'and a recorded identity is present.',
);