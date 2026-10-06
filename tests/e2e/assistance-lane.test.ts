/**
 * Phase 21 assistance lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered the first time
 * somebody runs it. The properties below are the ones whose absence would make the lane report
 * something other than what it claims.
 *
 * 1. **The declaration is internally consistent and bounded.** Both lanes state a claim and a
 *    `doesNotProve` list, and the three boundaries a reader of this gate most needs - not physical
 *    device, not a screen reader, not an accessibility conformance result - are asserted **by
 *    content** rather than by count, because a list of plausible sentences can omit the one that
 *    matters.
 * 2. **The two lanes cannot be confused.** Their identities must differ in exactly the eight places
 *    that make the pair evidence: artifact, manifest, build script, config, port, project, spec and
 *    expectation. One manifest path would let a rollback claim be verified against a flagged build.
 * 3. **The preflight is a command, not a module-scope throw**, and it exists as its own file.
 * 4. **The preflight is non-vacuous.** Its discriminator - the compiled flag constant read out of
 *    the emitted bytes - is exercised against synthetic `dist/` trees of **both** shapes, so the
 *    claim that it can tell them apart is checked rather than described. This is the property the
 *    Phase 17 fishing lane lacked, and the reason it once reported green while its host published
 *    nothing.
 * 5. **The preflight's chunk check is stated as presence and not as the discriminator.** Measured:
 *    the **default** build emits both lane chunks too, so a preflight that looked for a chunk file
 *    would pass on a default `dist/`.
 * 6. **The npm scripts are the three shapes the repository uses**, the two preview-only scripts
 *    never build, and `:full` is the only place either artifact is produced.
 * 7. **The Playwright configs bind exactly one project to exactly one spec**, preview an existing
 *    build on their own port, and record no raw failure artifact.
 * 8. **The specs drive the same journey and observe opposite expectations**, and neither skips.
 * 9. **The specs read their selectors from the declared probe table**, so a probe the gate cannot
 *    see is a probe nobody reviewed.
 * 10. **The copy assertions read the shipped locale file** rather than retyping it, and the
 *     suggestion kind is asserted against the engine's own exported vocabulary.
 * 11. **CI builds, records, uploads, downloads, verifies and runs both lanes**, and the steps are
 *     ordered the way the identity checks require.
 * 12. **Privacy.** Synthetic identifiers only, no learner-shaped field in a spec, no external URL.
 *
 * Hermeticity: reads repository files and the flag tables only, and builds synthetic `dist/` trees
 * in a temporary directory for the preflight's own tests. No real `dist/`, no browser, no network.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PlaywrightTestConfig } from '@playwright/test';
import { afterAll, describe, expect, it } from 'vitest';

import assistanceConfig from './playwright.assistance.config';
import assistanceDefaultConfig from './playwright.assistance-default.config';
import a11yConfig from './playwright.a11y.config';
import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import pixiMemoryConfig from './playwright.pixi-memory.config';
import { ASSISTANCE_SUGGESTION_KINDS } from '../../src/core/assistance/types';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '../../src/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX, NON_CUTOVER_FLAG_KEYS } from '../../src/config/featureFlags';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX } from './support-matrix';
import { FISHING_TEST_FILE } from './fishing-lane';
import {
  ASSISTANCE_CARD_CHUNK_REQUEST_MATCH,
  ASSISTANCE_CARD_CHUNK_STEM,
  ASSISTANCE_CARD_SELECTOR,
  ASSISTANCE_DEFAULT_CI_RUN_SCRIPT,
  ASSISTANCE_DEFAULT_CONFIG_FILE,
  ASSISTANCE_DEFAULT_LANE,
  ASSISTANCE_DEFAULT_LANE_FULL_SCRIPT,
  ASSISTANCE_DEFAULT_LANE_SCRIPT,
  ASSISTANCE_DEFAULT_MANIFEST_PATH,
  ASSISTANCE_DEFAULT_PREFLIGHT_COMMAND,
  ASSISTANCE_DEFAULT_PREVIEW_PORT,
  ASSISTANCE_DEFAULT_TEST_FILE,
  ASSISTANCE_DEFAULT_VERIFY_SCRIPT,
  ASSISTANCE_EXPECTED_KIND,
  ASSISTANCE_EXPECTED_REASON_CODE,
  ASSISTANCE_EXPECTED_SURFACE,
  ASSISTANCE_FLAG,
  ASSISTANCE_FLAG_VALUE,
  ASSISTANCE_CI_RUN_SCRIPT,
  ASSISTANCE_LANE,
  ASSISTANCE_LANE_IDENTITY_FIELDS,
  ASSISTANCE_LANE_SCRIPT,
  ASSISTANCE_LANES,
  ASSISTANCE_LANE_CHUNK_STEMS,
  ASSISTANCE_MANIFEST_PATH,
  ASSISTANCE_PREFLIGHT_COMMAND,
  ASSISTANCE_PREFLIGHT_SCRIPT,
  ASSISTANCE_PROBE_NAMES,
  ASSISTANCE_PROBES,
  ASSISTANCE_RECORD_SCRIPT,
  ASSISTANCE_STORE_CHUNK_REQUEST_MATCH,
  ASSISTANCE_STORE_CHUNK_STEM,
  ASSISTANCE_VERIFY_SCRIPT,
  validateAssistanceLane,
  validateAssistanceLanePair,
} from './assistance-lane';
import { ASSISTANCE_LANE_PATHS, ASSISTANCE_LANE_ROLE } from '../../vite.config';

import { stripComments } from '../phase9/support/phase9Build';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PREFLIGHT_PATH = path.join(REPO_ROOT, 'scripts', ASSISTANCE_PREFLIGHT_SCRIPT);
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

const flaggedSpec = readFileSync(path.join(REPO_ROOT, ASSISTANCE_LANE.testPath), 'utf8');
const defaultSpec = readFileSync(path.join(REPO_ROOT, ASSISTANCE_DEFAULT_LANE.testPath), 'utf8');
const journeySource = readFileSync(path.join(REPO_ROOT, 'tests/e2e/assistance-journey.ts'), 'utf8');
const ciSource = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

/**
 * The `browser-smoke` job's text, on its own.
 *
 * Several step names appear in **both** the build job and the browser job - `verify:web-artifact`
 * is the sharpest, because the flagged lane's `verify:web-artifact:assistance` starts with it as a
 * string. An index into the whole file therefore finds the wrong job, and an ordering assertion built
 * on one fails for a reason that has nothing to do with ordering. Slicing the job first is what
 * makes these assertions say what they claim.
 */
const BROWSER_JOB_START = ciSource.indexOf('  browser-smoke:');
const COMPAT_JOB_START = ciSource.indexOf('  compatibility-pr:');
const BROWSER_JOB = ciSource.slice(BROWSER_JOB_START, COMPAT_JOB_START);
const BUILD_JOB_START = ciSource.indexOf('  web-build:');
const BUILD_JOB = ciSource.slice(BUILD_JOB_START, BROWSER_JOB_START);

const TEMP_ROOTS: string[] = [];
afterAll(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

/* ── Non-vacuity of the preflight ─────────────────────────────────────────────── */

/**
 * A synthetic `dist/` with the two shapes this phase measured.
 *
 * The point of this whole section: the preflight's discriminator is a claim that the *emitted bytes*
 * differ between the two builds, and the only way to know that claim is load-bearing is to hand the
 * preflight both shapes. The two constants are copied verbatim from the builds at this phase, and
 * the flag-**off** shape omits the key exactly as Vite's substitution object does - which is the
 * detail the naive `"false"` reading would have missed.
 */
const FLAGGED_ENV_LITERAL =
  'J({BASE_URL:`/`,DEV:!1,LEGACY:!1,MODE:`production`,PROD:!0,SSR:!1,VITE_ADAPTIVE_ASSISTANCE:`true`})';
const DEFAULT_ENV_LITERAL =
  'J({BASE_URL:`/`,DEV:!1,LEGACY:!1,MODE:`production`,PROD:!0,SSR:!1})';
/** The single- and double-quoted spellings the minifier might choose instead of a backtick. */
const FLAGGED_ENV_LITERAL_QUOTED =
  '({VITE_ADAPTIVE_ASSISTANCE:"true"});const x=1;({VITE_ADAPTIVE_ASSISTANCE:\'true\'});';

/**
 * Write a synthetic repository with a `dist/` in one of the two shapes, plus a recorded manifest.
 *
 * A whole temporary repository rather than a temporary `dist/`, because the preflight resolves both
 * paths against its own repository root and a test that could not run the real script would be
 * testing a copy of it.
 */
function syntheticRepo(options: {
  readonly envLiteral: string;
  readonly laneChunks?: readonly string[];
  readonly entryReferences?: readonly string[];
  readonly manifest?: boolean;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'kd-assistance-preflight-'));
  TEMP_ROOTS.push(root);
  const distAssets = path.join(root, 'dist', 'assets');
  mkdirSync(distAssets, { recursive: true });
  writeFileSync(
    path.join(root, 'dist', 'index.html'),
    `<!doctype html><html><body><script type="module" src="/assets/index-a1.js"></script>${(
      options.entryReferences ?? []
    )
      .map((reference) => `<link rel="modulepreload" href="/${reference}">`)
      .join('')}</body></html>`,
    'utf8',
  );
  writeFileSync(path.join(distAssets, 'index-a1.js'), options.envLiteral, 'utf8');
  writeFileSync(path.join(distAssets, 'vendor-react-c1.js'), 'export const x=1;', 'utf8');
  // The default shape emits both lane chunks too. That is measured, and it is why the preflight's
  // chunk check is a presence check and not the discriminator.
  for (const chunk of options.laneChunks ?? ASSISTANCE_LANE_CHUNK_STEMS) {
    writeFileSync(path.join(distAssets, `${chunk}-abc12345.js`), 'export const y=1;', 'utf8');
    writeFileSync(path.join(distAssets, `${chunk}-legacy-def67890.js`), 'System.register([],function(){})', 'utf8');
  }
  if (options.manifest !== false) {
    mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    for (const manifest of [ASSISTANCE_MANIFEST_PATH, ASSISTANCE_DEFAULT_MANIFEST_PATH]) {
      writeFileSync(path.join(root, manifest), '{}\n', 'utf8');
    }
  }
  return root;
}

/** Run the real preflight against a synthetic repository, and return its output and status. */
function runPreflight(
  root: string,
  args: readonly string[] = [],
): { readonly status: number; readonly output: string } {
  try {
    const output = execFileSync('node', [PREFLIGHT_PATH, ...args, `--root=${root}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('the flagged build has a script that turns on exactly one flag', () => {
  it('build:web:assistance sets only VITE_ADAPTIVE_ASSISTANCE', () => {
    // Phase 19's own gate asserts this and this file must not restate it as an assumption: if the
    // script ever widened, the lane would be previewing an artifact its preflight no longer
    // discriminates, and the red would arrive from a build error rather than from a lane finding.
    expect(npmScripts['build:web:assistance']).toBe(
      'VITE_ADAPTIVE_ASSISTANCE=true npm run build:web',
    );
    expect(ASSISTANCE_FLAG).toBe(RUNTIME_FLAG_ENV_KEYS.adaptiveAssistance);
    expect(ASSISTANCE_FLAG_VALUE).toBe('true');
  });

  it('the flag parses, defaults to false, and stays a cutover gate rather than a kill switch', () => {
    // The production default is what makes the flag-off build the rollback, and the flag-off build
    // is what this lane's second half observes.
    expect(DEFAULT_RUNTIME_CONFIG.adaptiveAssistance).toBe(false);
    expect(FEATURE_FLAG_MATRIX.adaptiveAssistance.productionDefault).toBe(false);
    // And `NON_CUTOVER_FLAG_KEYS` must remain exactly `['audioEnabled']`, asserted as the negative
    // that keeps a second flag from joining it.
    expect([...NON_CUTOVER_FLAG_KEYS]).toEqual(['audioEnabled']);
    expect([...NON_CUTOVER_FLAG_KEYS]).not.toContain('adaptiveAssistance');
  });

  it('the flag value can carry no learner data', () => {
    // Every runtime config value is a boolean or a two-value enum, so no build-time flag can carry a
    // subject name into a built artifact, a log, or a filename.
    for (const [key, value] of Object.entries(DEFAULT_RUNTIME_CONFIG)) {
      expect(['string', 'boolean'], key).toContain(typeof value);
    }
  });
});

describe('the declaration is bounded and the two lanes cannot be confused', () => {
  it('both lanes are internally consistent', () => {
    expect(validateAssistanceLane(ASSISTANCE_LANE)).toEqual([]);
    expect(validateAssistanceLane(ASSISTANCE_DEFAULT_LANE)).toEqual([]);
    // The pair's own validator, because "the two lanes must disagree" is not a per-lane property.
    expect(validateAssistanceLanePair()).toEqual([]);
    expect(ASSISTANCE_LANES).toHaveLength(2);
    expect(ASSISTANCE_LANE.claim.length).toBeGreaterThan(200);
    expect(ASSISTANCE_DEFAULT_LANE.claim.length).toBeGreaterThan(200);
  });

  it('their identities differ in exactly the eight fields that make the pair evidence', () => {
    expect([...ASSISTANCE_LANE_IDENTITY_FIELDS]).toEqual([
      'project',
      'testFile',
      'configFile',
      'buildScript',
      'manifestPath',
      'previewPort',
      'expectsFlagOn',
      'expectsCard',
    ]);
    for (const field of ASSISTANCE_LANE_IDENTITY_FIELDS) {
      expect(ASSISTANCE_LANE[field], field).not.toBe(ASSISTANCE_DEFAULT_LANE[field]);
    }
  });

  it('the flagged lane expects a card and the default lane expects none', () => {
    expect(ASSISTANCE_LANE.expectsFlagOn).toBe(true);
    expect(ASSISTANCE_LANE.expectsCard).toBe(true);
    expect(ASSISTANCE_DEFAULT_LANE.expectsFlagOn).toBe(false);
    expect(ASSISTANCE_DEFAULT_LANE.expectsCard).toBe(false);
  });

  it('neither lane can be read as physical-device, screen-reader or axe evidence, in words', () => {
    for (const lane of ASSISTANCE_LANES) {
      expect(lane.evidenceClass, lane.project).toBe('emulated-viewport');
      expect(lane.evidenceClass, lane.project).not.toBe('physical-device-manual');
      const joined = lane.doesNotProve.join(' ');
      expect(joined, lane.project).toMatch(/not a physical device/i);
      expect(joined, lane.project).toMatch(/screen-reader/i);
      expect(joined, lane.project).toMatch(/axe/i);
      expect(joined, lane.project).toMatch(/not a cross-engine result/i);
      // And the four Phase 19 surfaces this artifact cannot reach are named, so a reader is not left
      // to infer that the fishing surface is the only one.
      expect(joined, lane.project).toMatch(/other four Phase 19 surfaces/i);
    }
  });

  it('the suggestion kind and surface it drives exist in the engine, and the kind is named by the lane', () => {
    expect([...ASSISTANCE_SUGGESTION_KINDS]).toContain(ASSISTANCE_EXPECTED_KIND);
    expect(ASSISTANCE_EXPECTED_SURFACE).toBe('fishing');
    expect(ASSISTANCE_EXPECTED_REASON_CODE).toBe('fishing-recall-missed');
  });

  it('the two declared lane modules still exist at the paths the preflight and the census name', () => {
    expect([...ASSISTANCE_LANE_PATHS]).toEqual([
      'src/core/assistance/assistanceEngine',
      'src/store/assistanceStore',
    ]);
    for (const lanePath of ASSISTANCE_LANE_PATHS) {
      expect(ASSISTANCE_LANE_ROLE[lanePath], lanePath).toBeTruthy();
    }
    // And the chunk stems the preflight names are the two lane paths' last segments, so a rename of
    // either module fails here instead of making the preflight silently look for nothing.
    expect([...ASSISTANCE_LANE_CHUNK_STEMS].sort()).toEqual(['AssistanceRegion', 'assistanceStore']);
  });

  it('the card chunk and the store chunk are distinguished, because they are fetched differently', () => {
    // Measured at this phase: `runBootstrap` awaits `loadAssistanceStore()` on every build, so the
    // store chunk is fetched at startup on every route, while the card chunk is fetched only when
    // the card mounts. A single combined pattern would make the default lane's absence claim
    // unsayable, because the store's presence is always true.
    expect(ASSISTANCE_CARD_CHUNK_STEM).not.toBe(ASSISTANCE_STORE_CHUNK_STEM);
    expect(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH.test('/assets/AssistanceRegion-abc12345.js')).toBe(true);
    expect(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH.test('/assets/assistanceStore-abc12345.js')).toBe(false);
    expect(ASSISTANCE_STORE_CHUNK_REQUEST_MATCH.test('/assets/assistanceStore-abc12345.js')).toBe(true);
    // And the legacy re-emission is matched by neither: no supported browser executes it.
    expect(ASSISTANCE_CARD_CHUNK_REQUEST_MATCH.test('/assets/AssistanceRegion-legacy-abc.js')).toBe(false);
  });

  it('every selector the specs read is declared in the probe table', () => {
    expect([...ASSISTANCE_PROBE_NAMES]).toEqual([
      'card',
      'suggestion',
      'reasonText',
      'dismiss',
      'dismissed',
      'status',
      'any',
    ]);
    expect(ASSISTANCE_PROBES.card).toBe(ASSISTANCE_CARD_SELECTOR);
    for (const [name, selector] of Object.entries(ASSISTANCE_PROBES)) {
      expect(selector, name).toMatch(/^\[|^\.|^[a-z]/);
    }
    // The default lane iterates the whole table, so an undeclared selector would be a probe this
    // gate cannot see.
    expect(defaultSpec).toContain('Object.entries(ASSISTANCE_PROBES)');
    expect(defaultSpec).toContain('ASSISTANCE_ANY_SELECTOR');
  });
});

describe('the preflight is a command, not a module-scope throw', () => {
  it('it exists as its own script and both configs import nothing that runs it', () => {
    expect(preflightSourceHasMain()).toBe(true);
    // Importing a config must be harmless in a checkout with no `dist/`, or `npm test` fails in the
    // `unit-tests` CI job - the defect `scripts/require-pixi-lane-artifact.mjs` records at length.
    for (const configSource of [
      readFileSync(path.join(REPO_ROOT, ASSISTANCE_LANE.configFile), 'utf8'),
      readFileSync(path.join(REPO_ROOT, ASSISTANCE_DEFAULT_CONFIG_FILE), 'utf8'),
    ]) {
      expect(configSource).not.toContain(ASSISTANCE_PREFLIGHT_SCRIPT);
      expect(configSource).not.toMatch(/^\s*throw\s/m);
      expect(configSource).not.toContain('existsSync(DIST_DIR)');
    }
    // The guard is in the command, so the npm scripts carry it.
    for (const script of [ASSISTANCE_LANE_SCRIPT, ASSISTANCE_LANE.fullScript, ASSISTANCE_CI_RUN_SCRIPT]) {
      expect(npmScripts[script], script).toContain(ASSISTANCE_PREFLIGHT_COMMAND);
    }
    for (const script of [
      ASSISTANCE_DEFAULT_LANE_SCRIPT,
      ASSISTANCE_DEFAULT_LANE_FULL_SCRIPT,
      ASSISTANCE_DEFAULT_CI_RUN_SCRIPT,
    ]) {
      expect(npmScripts[script], script).toContain(ASSISTANCE_DEFAULT_PREFLIGHT_COMMAND);
    }
  });

  it('the preflight exists and states the four things it checks', () => {
    const source = readFileSync(PREFLIGHT_PATH, 'utf8');
    for (const code of [
      'dist-missing',
      'dist-partial',
      'manifest-missing',
      'lane-chunk-missing',
      'flag-not-compiled-in',
      'flag-compiled-in',
      'lane-eagerly-preloaded',
    ]) {
      expect(source, code).toContain(`'${code}'`);
    }
    // Both lanes select on one flag, so an unrecognised argument cannot preflight the wrong manifest.
    expect(source).toContain("process.argv.includes('--default')");
  });
});

function preflightSourceHasMain(): boolean {
  const source = readFileSync(PREFLIGHT_PATH, 'utf8');
  return source.includes('const lane =');
}

describe('the preflight is non-vacuous: it fails on the artifact it must refuse', () => {
  it('PASSES a synthetic flagged artifact and says the constant reads true', () => {
    const root = syntheticRepo({ envLiteral: FLAGGED_ENV_LITERAL });
    const result = runPreflight(root);
    expect(result.output, result.output).toContain('preflight passed');
    expect(result.output).toContain('reads "true"');
  });

  it('FAILS the flagged lane on a default artifact, by name', () => {
    // Proof (a): the preflight is red on a default-artifact `dist/`. Without this the preflight
    // could be a presence check that always passes, which is the Phase 17 dead lane in new
    // clothing.
    const root = syntheticRepo({ envLiteral: DEFAULT_ENV_LITERAL });
    const result = runPreflight(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('flag-not-compiled-in');
    expect(result.output).toContain('built with the feature at its production default');
    expect(result.output).toContain('npm run build:web:assistance');
  });

  it('FAILS the default lane on a flagged artifact, by name', () => {
    // The mirror, and the one that keeps a rollback claim from being verified against a flagged
    // build. A single manifest path would let exactly this happen.
    const root = syntheticRepo({ envLiteral: FLAGGED_ENV_LITERAL });
    const result = runPreflight(root, ['--default']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('flag-compiled-in');
    expect(result.output).toContain('not the production default');
    expect(result.output).toContain('npm run build:web');
  });

  it('PASSES the default lane on a default artifact and reports the constant as absent', () => {
    // The message must not claim the constant reads `"false"`. Vite's substitution object **omits**
    // the key on a default build, so `"no such constant"` is what was measured and anything else
    // would be a message overstating its own check.
    const root = syntheticRepo({ envLiteral: DEFAULT_ENV_LITERAL });
    const result = runPreflight(root, ['--default']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('reads no such constant');
    expect(result.output).not.toContain('reads "false"');
  });

  it('FAILS both lanes when a lane chunk is absent, which is the "carries no assistance code" case', () => {
    const root = syntheticRepo({ envLiteral: FLAGGED_ENV_LITERAL, laneChunks: ['assistanceStore'] });
    const result = runPreflight(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('lane-chunk-missing');
    expect(result.output).toContain(ASSISTANCE_CARD_CHUNK_STEM);
  });

  it('FAILS both lanes when the entry document preloads a lane chunk', () => {
    const root = syntheticRepo({
      envLiteral: FLAGGED_ENV_LITERAL,
      entryReferences: [`assets/${ASSISTANCE_CARD_CHUNK_STEM}-abc12345.js`],
    });
    const result = runPreflight(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('lane-eagerly-preloaded');
    expect(result.output).toContain('modulepreload');
  });

  it('FAILS when the recorded manifest is absent', () => {
    const root = syntheticRepo({ envLiteral: FLAGGED_ENV_LITERAL, manifest: false });
    const result = runPreflight(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('manifest-missing');
    expect(result.output).toContain(ASSISTANCE_RECORD_SCRIPT);
  });

  it('the chunk-presence check alone does NOT tell the two artifacts apart, and the gate says so', () => {
    // The measured fact that makes the flag constant the discriminator rather than a decoration:
    // the **default** shape in the synthetic repository also carries both lane chunks. If the
    // preflight relied on them, the first test above would be the only red one and the default lane
    // would accept a flagged `dist/`.
    const root = syntheticRepo({ envLiteral: DEFAULT_ENV_LITERAL });
    expect(readFileSync(path.join(root, 'dist/assets', `${ASSISTANCE_CARD_CHUNK_STEM}-abc12345.js`), 'utf8')).toBeTruthy();
    // And both sides state it, so a future reader does not have to re-derive either half: the
    // preflight's own header says the two artifacts cannot be told apart by chunk presence, and the
    // journey's header quotes the product sentence that shows why the route matters.
    const preflight = readFileSync(PREFLIGHT_PATH, 'utf8');
    expect(preflight).toContain('is **not** distinguishable from');
    // The line break after `would` is exactly why this is asserted on a shorter fragment.
    expect(preflight).toContain('pass on a default `dist/`');
    expect(journeySource).toContain('This catch has no open pond session');
  });

  it('matches the compiled constant regardless of which quote the minifier chose', () => {
    // The minifier's string quoting is not a contract this repository controls; the key and the
    // value are. A false negative here would be a red preflight on a correct build.
    for (const literal of [FLAGGED_ENV_LITERAL, FLAGGED_ENV_LITERAL_QUOTED]) {
      const root = syntheticRepo({ envLiteral: literal });
      expect(runPreflight(root).status, literal).toBe(0);
      expect(runPreflight(root, ['--default']).status, literal).not.toBe(0);
    }
  });
});

describe('the Playwright configs bind one project to one spec and never rebuild', () => {
  it('the flagged config binds exactly one project to the flagged spec', () => {
    const config = assistanceConfig as PlaywrightTestConfig;
    const server = singleWebServer(config);
    expect(config.projects?.map((project) => project.name)).toEqual([ASSISTANCE_LANE.project]);
    expect(config.testMatch).toBe(ASSISTANCE_LANE.testFile);
    expect(server.command).toContain(String(ASSISTANCE_LANE.previewPort));
    expect(server.command).toContain('--strictPort');
    expect(server.reuseExistingServer).toBe(false);
    // Preview only: a lane that could decide to rebuild could test a different artifact than the
    // one that was recorded, and the identity check would then be checking the rebuild.
    expect(server.command).not.toContain('build:web');
    expect(config.use?.trace).toBe('off');
    expect(config.use?.screenshot).toBe('off');
    expect(config.use?.video).toBe('off');
  });

  it('the default config binds exactly one project to the default spec, on its own port', () => {
    const config = assistanceDefaultConfig as PlaywrightTestConfig;
    expect(config.projects?.map((project) => project.name)).toEqual([ASSISTANCE_DEFAULT_LANE.project]);
    expect(config.testMatch).toBe(ASSISTANCE_DEFAULT_TEST_FILE);
    expect(singleWebServer(config).command).toContain(String(ASSISTANCE_DEFAULT_PREVIEW_PORT));
    expect(ASSISTANCE_DEFAULT_PREVIEW_PORT).not.toBe(ASSISTANCE_LANE.previewPort);
    expect(config.use?.trace).toBe('off');
  });

  it('neither project name collides with another lane or a matrix project', () => {
    const names = new Set([
      ...(playwrightConfig.projects ?? []).map((project) => project.name),
      ...(storageV2Config.projects ?? []).map((project) => project.name),
      ...(pixiMemoryConfig.projects ?? []).map((project) => project.name),
      ...(a11yConfig.projects ?? []).map((project) => project.name),
    ]);
    for (const lane of ASSISTANCE_LANES) {
      expect(names.has(lane.project), lane.project).toBe(false);
    }
    for (const entry of SUPPORT_MATRIX) {
      expect(laneUsesMatrixProject(entry.project), entry.project).toBe(false);
    }
  });

  it('no existing suite can reach either assistance spec, so no release path is widened', () => {
    const specs = [
      CURRENT_BUILD_TEST_FILE,
      'compatibility.spec.ts',
      'storageV2.spec.ts',
      'dataProductsRestore.spec.ts',
      'subjectProductRoundTrip.spec.ts',
      'reloadPersistence.spec.ts',
      'pixiMemory.spec.ts',
      'pixi-canvas-pointer.spec.ts',
      'phase10Media.spec.ts',
      FISHING_TEST_FILE,
      'fishingRollback.spec.ts',
      'a11yAudit.spec.ts',
    ];
    for (const config of [playwrightConfig, storageV2Config, pixiMemoryConfig] as PlaywrightTestConfig[]) {
      const match = config.testMatch;
      for (const spec of specs) {
        expect(String(match), `${config.testDir} vs ${spec}`).not.toContain(ASSISTANCE_LANE.testFile);
        expect(String(match), `${config.testDir} vs ${spec}`).not.toContain(
          ASSISTANCE_DEFAULT_TEST_FILE,
        );
      }
    }
  });

  it('the a11y config generates one project per matrix cell and binds one spec', () => {
    const config = a11yConfig as PlaywrightTestConfig;
    expect(config.projects?.map((project) => project.name)).toEqual(
      SUPPORT_MATRIX.map((entry) => `a11y-${entry.project}`),
    );
    expect(config.testMatch).toBe('a11yAudit.spec.ts');
    expect(config.use?.trace).toBe('off');
    expect(config.use?.screenshot).toBe('off');
    expect(config.use?.video).toBe('off');
  });
});

/**
 * The config's single web server, or a throw.
 *
 * Playwright types `webServer` as an object *or an array* of them, and the lane configs each declare
 * exactly one. Narrowing here rather than with `as` at each use site keeps a second server from
 * being added to one of these configs without a red test noticing - which is the change that would
 * silently introduce a second preview and a second `dist`.
 */
function singleWebServer(config: PlaywrightTestConfig): {
  command: string;
  reuseExistingServer?: boolean;
} {
  const server = config.webServer;
  const single = Array.isArray(server) ? (server.length === 1 ? server[0] : undefined) : server;
  if (single === undefined) {
    throw new Error(
      `The config at ${config.testDir} declares ${Array.isArray(server) ? `${server.length} web servers` : 'no web server'}. ` +
        'A lane must preview exactly one artifact on exactly one port.',
    );
  }
  return { command: single.command, reuseExistingServer: single.reuseExistingServer };
}

function laneUsesMatrixProject(name: string): boolean {
  return ASSISTANCE_LANES.some((lane) => lane.project === name);
}

describe('the npm scripts are the repository three shapes and the two preview-only scripts never build', () => {
  it('the flagged lane has :recorded, :full and the plain name', () => {
    expect(npmScripts[ASSISTANCE_LANE_SCRIPT]).toBeDefined();
    expect(npmScripts[ASSISTANCE_LANE.fullScript]).toContain('npm run build:web:assistance');
    expect(npmScripts[ASSISTANCE_LANE.fullScript]).toContain(`npm run ${ASSISTANCE_RECORD_SCRIPT}`);
    expect(npmScripts[ASSISTANCE_LANE.fullScript]).toContain(`npm run ${ASSISTANCE_VERIFY_SCRIPT}`);
    // The preview-only names never build, so CI cannot silently rebuild what it just measured.
    expect(npmScripts[ASSISTANCE_LANE_SCRIPT]).not.toContain('build:web');
    expect(npmScripts[ASSISTANCE_CI_RUN_SCRIPT]).not.toContain('build:web');
  });

  it('the default lane has the same three shapes, against the production build', () => {
    expect(npmScripts[ASSISTANCE_DEFAULT_LANE_SCRIPT]).toBeDefined();
    expect(npmScripts[ASSISTANCE_DEFAULT_LANE_FULL_SCRIPT]).toContain('npm run build:web &&');
    expect(npmScripts[ASSISTANCE_DEFAULT_LANE_SCRIPT]).not.toContain('build:web');
    expect(npmScripts[ASSISTANCE_DEFAULT_CI_RUN_SCRIPT]).not.toContain('build:web');
  });

  it('the record and verify scripts name this lane own manifest, not another lane s', () => {
    expect(npmScripts[ASSISTANCE_RECORD_SCRIPT]).toContain(ASSISTANCE_MANIFEST_PATH);
    expect(npmScripts[ASSISTANCE_VERIFY_SCRIPT]).toContain(ASSISTANCE_MANIFEST_PATH);
    // The default lane's verify relies on `web-artifact-manifest.mjs`'s own default path, which is
    // the production manifest, and does not pass `--manifest` at all. Asserted so the two are
    // distinguishable: the flagged lane names its manifest, the default lane inherits it.
    expect(ASSISTANCE_DEFAULT_VERIFY_SCRIPT).toBe('verify:web-artifact');
    expect(npmScripts[ASSISTANCE_DEFAULT_VERIFY_SCRIPT]).toBe('node scripts/web-artifact-manifest.mjs verify');
    expect(npmScripts[ASSISTANCE_DEFAULT_VERIFY_SCRIPT]).not.toContain('--manifest');
    expect(npmScripts[ASSISTANCE_VERIFY_SCRIPT]).toContain(`--manifest=${ASSISTANCE_MANIFEST_PATH}`);
    expect(npmScripts[ASSISTANCE_VERIFY_SCRIPT]).not.toBe(npmScripts[ASSISTANCE_DEFAULT_VERIFY_SCRIPT]);
  });

  it('both Playwright commands name the config the lane declares', () => {
    expect(npmScripts[ASSISTANCE_CI_RUN_SCRIPT]).toContain(ASSISTANCE_LANE.configFile);
    expect(npmScripts[ASSISTANCE_DEFAULT_CI_RUN_SCRIPT]).toContain(ASSISTANCE_DEFAULT_CONFIG_FILE);
    expect(npmScripts[ASSISTANCE_LANE_SCRIPT]).toContain(ASSISTANCE_LANE.configFile);
  });

  it('no script names a flag or an environment variable that could carry learner data', () => {
    for (const [name, command] of Object.entries(npmScripts)) {
      if (!name.startsWith('test:e2e:assistance')) continue;
      expect(command, name).not.toMatch(/--subject|--name|--token|--secret/i);
      expect(command, name).not.toContain('SUBJECT=');
    }
  });
});

describe('the specs measure what they claim and skip nothing', () => {
  it('neither spec skips or fixes anything', () => {
    // On **code**, not on the file: both specs' headers say in words that they contain no skip, and
    // a gate that read the file would fail on its own header. `stripComments` is the helper
    // `tests/phase19/assistance-build-lane.test.ts` uses for exactly this.
    for (const [name, source] of [
      [ASSISTANCE_LANE.testFile, flaggedSpec],
      [ASSISTANCE_DEFAULT_TEST_FILE, defaultSpec],
    ] as const) {
      const code = stripComments(source);
      expect(code, name).not.toContain('test.skip');
      expect(code, name).not.toContain('test.fixme');
      expect(code, name).not.toMatch(/\.only\(/);
    }
  });

  it('both specs drive the same journey module, which is what makes the pair evidence', () => {
    expect(flaggedSpec).toContain('driveMissedRecallJourney');
    expect(defaultSpec).toContain('driveMissedRecallJourney');
    expect(journeySource).toContain('export async function driveMissedRecallJourney');
    // And the journey asserts the premise on both sides rather than only where it failed last time.
    expect(flaggedSpec).toContain('recallQuestionOffered');
    expect(defaultSpec).toContain('recallQuestionOffered');
    expect(defaultSpec).toContain('caughtFishLabel');
  });

  it('the flagged lane observes the card, its reason text and its dismiss control', () => {
    expect(flaggedSpec).toContain('ASSISTANCE_PROBES.card');
    expect(flaggedSpec).toContain('ASSISTANCE_PROBES.suggestion');
    // The reason text and the dismiss control are read by `readFirstSuggestion` in the shared
    // journey module, so the assertion is on the code that reads them rather than on the spec that
    // calls it.
    expect(flaggedSpec).toContain('readFirstSuggestion');
    expect(journeySource).toContain('ASSISTANCE_PROBES.reasonText');
    expect(journeySource).toContain('ASSISTANCE_PROBES.dismiss');
    // The reason sentence is asserted against the shipped locale file, not retyped.
    expect(flaggedSpec).toContain("src/i18n/locales/en.json");
    expect(flaggedSpec).toContain('ASSISTANCE_REASON_DETAIL_I18N_KEY');
    expect(flaggedSpec).toContain('ASSISTANCE_TITLE_I18N_KEY');
    // The card's own numbers, read as numbers.
    expect(flaggedSpec).toContain('Number.isInteger');
    expect(flaggedSpec).toContain('ASSISTANCE_EXPECTED_KIND');
    expect(flaggedSpec).toContain('ASSISTANCE_EXPECTED_REASON_CODE');
    expect(flaggedSpec).toContain('ASSISTANCE_EXPECTED_SURFACE');
    // And the second witness: the card chunk was actually fetched.
    expect(flaggedSpec).toContain('ASSISTANCE_CARD_CHUNK_REQUEST_MATCH');
  });

  it('the default lane requires every probe to be absent, and the card chunk never requested', () => {
    expect(defaultSpec).toContain('Object.entries(ASSISTANCE_PROBES)');
    expect(defaultSpec).toContain('ASSISTANCE_CARD_CHUNK_REQUEST_MATCH');
    // The positive control: a lane that only asserted an absence would pass on a page that loaded
    // nothing, so the store chunk's presence is asserted too.
    expect(defaultSpec).toContain('scriptPathsMatching');
    expect(flaggedSpec).toContain('ASSISTANCE_STORE_CHUNK_REQUEST_MATCH');
  });

  it('both specs assert no request left the preview origin and no page error occurred', () => {
    for (const [name, source] of [
      [ASSISTANCE_LANE.testFile, flaggedSpec],
      [ASSISTANCE_DEFAULT_TEST_FILE, defaultSpec],
    ] as const) {
      expect(source, name).toContain('offOriginPaths');
      expect(source, name).toContain('pageErrors');
    }
  });

  it('the journey refuses a canvas too small for its own press geometry, and says so', () => {
    expect(journeySource).toContain('MINIMUM_ASSUMED_CANVAS_PX');
    expect(journeySource).toContain('premiseFailures.push');
    // And the premise list is asserted first in both specs, so a red test cannot be diagnosed as
    // "the card did not appear" when the walk never arrived.
    expect(flaggedSpec.indexOf('premiseFailures')).toBeLessThan(flaggedSpec.indexOf('ASSISTANCE_PROBES.card'));
    expect(defaultSpec.indexOf('premiseFailures')).toBeLessThan(
      defaultSpec.indexOf('Object.entries(ASSISTANCE_PROBES)'),
    );
  });

  it('the journey reaches the pond through the control that mints a session, and says why', () => {
    // The hardest-won fact in this lane: pressing the nearby row enters fishing without recording
    // the pond, so no session is opened and the product says "This catch has no open pond session".
    // A lane that walked the other way would observe nothing and report a green run about it.
    expect(journeySource).toContain("name: 'Cast Line'");
    expect(journeySource).toContain('CAST_LINE_SELECTOR');
    expect(journeySource).toContain('no open pond session');
    // And the walk carries no press at all, which is the difference from the shared harness walk.
    // Asserted on the journey's **code**: its header names the helper in order to say why it is
    // deliberately not used.
    expect(stripComments(journeySource)).not.toContain('walkToStructureAndPress');
  });

  it('the fishing route is the one it claims: the pond panel, not the nearby row', () => {
    // The two ways into `enterFishing` are not equivalent, and the lane asserts it drives the one
    // that mints a session rather than leaving that as a comment.
    expect(journeySource).toContain('walkToPondPanel');
    expect(flaggedSpec).not.toContain('walkToStructureAndPress');
    expect(defaultSpec).not.toContain('walkToStructureAndPress');
  });

  it('neither spec contains a learner-shaped field, an external URL or a request body', () => {
    for (const [name, source] of [
      [ASSISTANCE_LANE.testFile, flaggedSpec],
      [ASSISTANCE_DEFAULT_TEST_FILE, defaultSpec],
      ['assistance-journey.ts', journeySource],
    ] as const) {
      expect(source, name).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
      expect(source, name).not.toContain('noteText');
      expect(source, name).not.toContain('subjectName');
      expect(source, name).not.toContain('headers()');
      expect(source, name).not.toContain('postData');
    }
  });
});

describe('CI builds, uploads, downloads, verifies and runs both lanes in that order', () => {
  it('the build job produces, records, verifies and uploads the flagged artifact', () => {
    expect(BUILD_JOB).toContain('npm run build:web:assistance');
    expect(BUILD_JOB).toContain(`npm run ${ASSISTANCE_RECORD_SCRIPT}`);
    expect(BUILD_JOB).toContain(`npm run ${ASSISTANCE_VERIFY_SCRIPT}`);
    expect(BUILD_JOB).toContain('name: assistance-web-artifact');
    expect(BUILD_JOB).toContain(ASSISTANCE_MANIFEST_PATH);
  });

  it('the flagged build runs after the production artifact is uploaded, so it cannot be mistaken for it', () => {
    const uploadProduction = BUILD_JOB.indexOf('name: web-artifact');
    const buildFlagged = BUILD_JOB.indexOf('npm run build:web:assistance');
    expect(uploadProduction, 'the production upload step was found').toBeGreaterThan(-1);
    expect(buildFlagged).toBeGreaterThan(uploadProduction);
  });

  it('the browser job downloads, verifies and runs the flagged lane before the absence lane', () => {
    const download = BROWSER_JOB.indexOf('name: assistance-web-artifact');
    const verify = BROWSER_JOB.indexOf(`npm run ${ASSISTANCE_VERIFY_SCRIPT}`);
    const runFlagged = BROWSER_JOB.indexOf(`npm run ${ASSISTANCE_CI_RUN_SCRIPT}`);
    const runDefault = BROWSER_JOB.indexOf(`npm run ${ASSISTANCE_DEFAULT_CI_RUN_SCRIPT}`);
    expect(download).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(download);
    expect(runFlagged).toBeGreaterThan(verify);
    expect(runDefault).toBeGreaterThan(runFlagged);
  });

  it('the absence lane downloads the production artifact back and re-verifies it first', () => {
    // A lane claiming "the card is absent" while pointed at a flagged build would describe
    // something other than what it claims - the same shape of defect the discards exist to prevent.
    const runDefault = BROWSER_JOB.indexOf(`npm run ${ASSISTANCE_DEFAULT_CI_RUN_SCRIPT}`);
    const reverify = BROWSER_JOB.lastIndexOf('npm run verify:web-artifact\n', runDefault);
    expect(reverify, 'the production identity is verified again before the absence lane').toBeGreaterThan(-1);
    expect(reverify).toBeLessThan(runDefault);
    // And the production download it pairs with is the second one in the job, not the first.
    expect(BROWSER_JOB.indexOf('name: web-artifact')).not.toBe(
      BROWSER_JOB.lastIndexOf('name: web-artifact'),
    );
  });

  it('both lane steps are not exempt from failing', () => {
    for (const script of [ASSISTANCE_CI_RUN_SCRIPT, ASSISTANCE_DEFAULT_CI_RUN_SCRIPT]) {
      const index = ciSource.indexOf(`npm run ${script}`);
      expect(index, script).toBeGreaterThan(-1);
      const stepStart = ciSource.lastIndexOf('- name:', index);
      const block = ciSource.slice(stepStart, index);
      expect(block, `${script} carries an exemption key`).not.toContain('continue-on-error');
    }
  });

  it('the build job installs no browser for this lane', () => {
    // A build-level lane must not turn into a browser lane: eleven existing wiring gates hold that
    // property for the other three flagged builds, and this lane joins them rather than breaking them.
    const start = BUILD_JOB.indexOf('npm run build:web:assistance');
    expect(start, 'the flagged build step was found in the build job').toBeGreaterThan(-1);
    expect(BUILD_JOB.slice(start), 'the build job installed a browser for a build-level lane').not.toContain(
      'playwright install',
    );
  });
});

describe('the accessibility audit is wired into the same job and asserts its own scope', () => {
  it('browser-smoke runs the accessibility audit, and the a11y runner is CI-wired to the runnable scope', () => {
    expect(BROWSER_JOB).toContain('npm run test:a11y:runnable');
    expect(ciSource).not.toContain('npm run test:a11y:complete');
    const start = BROWSER_JOB.indexOf('npm run test:a11y:runnable');
    const stepStart = BROWSER_JOB.lastIndexOf('- name:', start);
    expect(BROWSER_JOB.slice(stepStart, start)).not.toContain('continue-on-error');
  });

  it('the accessibility audit runs against the production artifact, so it describes what ships', () => {
    // It runs after the production re-download that the absence lane performed, so the tree it scans
    // is the production one rather than whichever flagged build happened to be last. Asserted by
    // position inside the browser job, because a whole-file index finds the build job's copies.
    const runA11y = BROWSER_JOB.indexOf('npm run test:a11y:runnable');
    const runDefault = BROWSER_JOB.indexOf(`npm run ${ASSISTANCE_DEFAULT_CI_RUN_SCRIPT}`);
    const reverify = BROWSER_JOB.lastIndexOf('npm run verify:web-artifact\n', runDefault);
    expect(runDefault).toBeGreaterThan(-1);
    expect(reverify).toBeGreaterThan(-1);
    expect(runA11y).toBeGreaterThan(runDefault);
    expect(runA11y).toBeGreaterThan(reverify);
  });
});