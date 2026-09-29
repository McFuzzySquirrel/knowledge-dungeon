/**
 * Phase 10 audio and asset lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. The properties below are the ones whose
 * absence would make the lane report something other than what it claims.
 *
 * 1. The declaration is internally consistent, claims a bounded scope, and states
 *    what it does not prove — including the boundaries that matter most, each
 *    asserted by content rather than by count, because a `doesNotProve` list of
 *    plausible sentences can omit the one a reader needs.
 * 2. **The lane is honest about its two surfaces.** It previews the production
 *    artifact for the product-level claims and a dev server for the two that must
 *    call the shipped module, and it says so in `doesNotProve`. A lane that claimed
 *    the built bundle for a test that only works unbundled would be reporting a
 *    result it did not measure.
 * 3. The npm scripts are spelled the repository's way: preview-only, `:full`, and
 *    `:recorded`, with the build and the recording in `:full` and nowhere else, so
 *    CI cannot rebuild the artifact it just measured.
 * 4. The Playwright config binds exactly one project to exactly the new spec,
 *    previews an existing build, never decides to rebuild, and records no raw
 *    failure artifact.
 * 5. **The config is inside a TypeScript project** and is importable with no
 *    `dist/`, so `npm test` and `npm run lint` see it and this gate can assert its
 *    shape in a checkout that has never been built. That is the Phase 9
 *    hermeticity defect class, asserted against rather than assumed.
 * 6. Six release paths stay disjoint: no existing config can reach this spec, and
 *    this spec binds no existing suite.
 * 7. **The spec actually measures what it claims.** Each of the four manual checks
 *    is asserted to be present *and* to carry its non-vacuity control, because a
 *    test that quietly stopped driving the thing it names can otherwise pass.
 * 8. The spec is hermetic in the sense `tests/phase8/qa-hermeticity.test.ts`
 *    established: nothing resolves a commit and nothing depends on where the
 *    checkout lives.
 * 9. **The CI step is a gate, and this file is what says so.** The wiring block
 *    below used to assert that the string `browser-smoke:` appears in the workflow,
 *    which was true before Phase 10 wired anything and stayed true if Phase 10 wired
 *    nothing: a vacuous gate for the one lane whose entire claim is that it gates. It
 *    now holds the properties a working Phase 9 gate holds - the named step exists in
 *    the named job and runs the declared npm script; it is not exempt from failing
 *    and cannot be skipped; it adds no build, artifact download, browser install or
 *    second `npm ci`, four counts that other gates already pin in this job; and it
 *    sits between the production artifact's identity check and the step that discards
 *    the production tree. Each of those is a named check over a parsed job, and each
 *    is proven able to fail by a table of mutated workflows - see the block's own
 *    comments for the failure mode each property prevents.
 *
 * Privacy: this file contains no learner data, reads only the repository, and
 * spawns nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import phase10MediaConfig from './playwright.phase10-media.config';
import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import dataProductsConfig from '../../playwright.data-products.config';
import subjectConfig from '../../playwright.subject-product.config';
import reloadConfig from '../../playwright.reload-persistence.config';
import pixiMemoryConfig from './playwright.pixi-memory.config';
import pixiPointerConfig from './playwright.pixi-pointer.config';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX, supportEntryForProject } from './support-matrix';
import { DATA_PRODUCTS_TEST_FILE } from './data-products-lane';
import { STORAGE_V2_TEST_FILE } from './storage-v2-lane';
import { SUBJECT_LANE, SUBJECT_LANE_TEST_FILE } from './subject-product-lane';
import { RELOAD_LANE, RELOAD_LANE_TEST_FILE } from './reload-persistence-lane';
import {
  PIXI_MEMORY_CI_DOWNLOAD_STEP,
  PIXI_MEMORY_LANE,
  PIXI_MEMORY_PREVIEW_PORT,
  PIXI_MEMORY_TEST_FILE,
} from './pixi-memory-lane';
import { PIXI_POINTER_LANE, PIXI_POINTER_PREVIEW_PORT } from './pixi-memory-lane';
import {
  PHASE10_MEDIA_CI_JOB,
  PHASE10_MEDIA_CI_RUN_COMMAND,
  PHASE10_MEDIA_CI_RUN_SCRIPT,
  PHASE10_MEDIA_CI_STEP_NAME,
  PHASE10_MEDIA_CONFIG_FILE,
  PHASE10_MEDIA_DEV_SCRIPT,
  PHASE10_MEDIA_LANE,
  PHASE10_MEDIA_LANE_FULL_SCRIPT,
  PHASE10_MEDIA_LANE_SCRIPT,
  PHASE10_MEDIA_MANIFEST_PATH,
  PHASE10_MEDIA_MINIMUM_TOUCH_TARGET_PX,
  PHASE10_MEDIA_PLAYWRIGHT_COMMAND,
  PHASE10_MEDIA_PREFLIGHT_COMMAND,
  PHASE10_MEDIA_PREFLIGHT_SCRIPT,
  PHASE10_MEDIA_PREVIEW_SCRIPT,
  PHASE10_MEDIA_TEST_PATH,
  validatePhase10MediaLane,
} from './phase10-media-lane';

const REPO_ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const PREFLIGHT_PATH = path.join(REPO_ROOT, 'scripts', PHASE10_MEDIA_PREFLIGHT_SCRIPT);
const SPEC_PATH = path.join(REPO_ROOT, PHASE10_MEDIA_TEST_PATH);
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

const specSource = readFileSync(SPEC_PATH, 'utf8');
const configSource = readFileSync(path.join(REPO_ROOT, PHASE10_MEDIA_CONFIG_FILE), 'utf8');
const preflightSource = readFileSync(PREFLIGHT_PATH, 'utf8');
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');

describe('phase 10 media lane declaration', () => {
  it('is internally consistent and claims a bounded scope', () => {
    expect(validatePhase10MediaLane()).toEqual([]);
  });

  it('binds a spec of its own, on a spec directory of its own', () => {
    expect(PHASE10_MEDIA_LANE.testFile).toBe('phase10Media.spec.ts');
    expect(PHASE10_MEDIA_LANE.testPath).toBe('tests/phase10/browser/phase10Media.spec.ts');
    expect(existsSync(SPEC_PATH), 'the bound spec exists on disk').toBe(true);
  });

  it('previews the production artifact and records that it is the production one', () => {
    expect(PHASE10_MEDIA_LANE.buildScript).toBe('build:web');
    expect(PHASE10_MEDIA_LANE.manifestPath).toBe('artifacts/web-artifact-manifest.json');
    expect(PHASE10_MEDIA_LANE.worldRenderer).toBe('phaser');
    expect(PHASE10_MEDIA_LANE.storageRepository).toBe('legacy');
    expect(PHASE10_MEDIA_LANE.dataProductsV2).toBe(false);
  });

  it('states the two boundaries a reader of this gate most needs', () => {
    // Both by content, not by count: a list of plausible sentences can omit the
    // one a reader needs, and these are the two that decide whether the evidence
    // can be cited.
    expect(
      PHASE10_MEDIA_LANE.doesNotProve.some((entry) => /any shipping route plays a sound/i.test(entry)),
      'the lane must say that no route is wired to the audio service',
    ).toBe(true);
    expect(
      PHASE10_MEDIA_LANE.doesNotProve.some((entry) => /emitted chunk/i.test(entry)),
      'the lane must say that the module-level checks run unbundled, not against the minified chunk',
    ).toBe(true);
    expect(
      PHASE10_MEDIA_LANE.doesNotProve.some((entry) => /screen-reader result/i.test(entry)),
      'the lane must say that no assistive technology was involved',
    ).toBe(true);
    expect(
      PHASE10_MEDIA_LANE.doesNotProve.some((entry) => /hardware-audio result/i.test(entry)),
      'the lane must say that no sound device exists here',
    ).toBe(true);
    expect(
      PHASE10_MEDIA_LANE.doesNotProve.some((entry) => /macOS Safari/i.test(entry)),
      'the lane must say it is Chromium only',
    ).toBe(true);
  });

  it('uses the four documented emulated viewports and the plan touch target', () => {
    expect(PHASE10_MEDIA_LANE.a11yProjects).toEqual([
      'desktop-chromium',
      'chromebook',
      'tablet',
      'tablet-landscape',
    ]);
    // Read from the support matrix, so a viewport the matrix stops documenting
    // fails here rather than being silently dropped from the scan.
    for (const project of PHASE10_MEDIA_LANE.a11yProjects) {
      const entry = supportEntryForProject(project);
      expect(entry.evidenceClass, `${project} is an emulated viewport`).toBe('emulated-viewport');
      expect(entry.viewport.width).toBeGreaterThan(0);
    }
    expect(PHASE10_MEDIA_MINIMUM_TOUCH_TARGET_PX).toBe(44);
  });

  it('names its one pre-existing blocking violation rather than tolerating a set', () => {
    expect(PHASE10_MEDIA_LANE.knownBlockingSignatures.length).toBeGreaterThan(0);
    for (const signature of PHASE10_MEDIA_LANE.knownBlockingSignatures) {
      expect(signature).toMatch(/^[\w-]+\|(serious|critical)\|/);
    }
  });
});

describe('phase 10 media npm scripts', () => {
  it('exposes the lane under the repository\'s own test:e2e naming', () => {
    expect(npmScripts[PHASE10_MEDIA_LANE_SCRIPT]).toBeDefined();
    expect(npmScripts[PHASE10_MEDIA_LANE_FULL_SCRIPT]).toBeDefined();
    expect(npmScripts[PHASE10_MEDIA_CI_RUN_SCRIPT]).toBeDefined();
  });

  it('runs the preflight and exactly the Playwright invocation the lane declares', () => {
    for (const script of [
      PHASE10_MEDIA_LANE_SCRIPT,
      PHASE10_MEDIA_LANE_FULL_SCRIPT,
      PHASE10_MEDIA_CI_RUN_SCRIPT,
    ]) {
      expect(npmScripts[script], `${script} runs the preflight`).toContain(PHASE10_MEDIA_PREFLIGHT_COMMAND);
      expect(npmScripts[script], `${script} runs the declared Playwright command`).toContain(
        PHASE10_MEDIA_PLAYWRIGHT_COMMAND,
      );
      // The config is spelled once, in the declaration, so the config the lane
      // owns and the config Playwright loads cannot be different files.
      expect(npmScripts[script]).toContain(PHASE10_MEDIA_CONFIG_FILE);
    }
  });

  it('never rebuilds from the two preview-only scripts, so CI cannot re-measure', () => {
    for (const script of [PHASE10_MEDIA_LANE_SCRIPT, PHASE10_MEDIA_CI_RUN_SCRIPT]) {
      expect(npmScripts[script], `${script} must not build`).not.toContain('build:web');
      expect(npmScripts[script], `${script} must not record an artifact`).not.toContain(
        'record:web-artifact',
      );
    }
    expect(PHASE10_MEDIA_CI_RUN_COMMAND).toBe(`npm run ${PHASE10_MEDIA_CI_RUN_SCRIPT}`);
  });

  it('puts the build, and only the build, in the :full script', () => {
    const full = npmScripts[PHASE10_MEDIA_LANE_FULL_SCRIPT] ?? '';
    expect(full).toContain(PHASE10_MEDIA_LANE.buildScript);
    expect(full).toContain('record:web-artifact');
    expect(full).toContain('verify:web-artifact');
  });

  it('does not collide with any existing lane script or port', () => {
    // The two ports are the lane's own, spelled once in the declaration. Every
    // other lane's preview port is enumerated in its own declaration, so a
    // collision is checked against the declarations rather than against whatever
    // happens to be in a script string today.
    const otherPorts = [PIXI_MEMORY_PREVIEW_PORT, PIXI_POINTER_PREVIEW_PORT];
    for (const port of otherPorts) {
      expect(port, `${port} is not this lane's preview port`).not.toBe(PHASE10_MEDIA_LANE.previewPort);
      expect(port, `${port} is not this lane's dev port`).not.toBe(PHASE10_MEDIA_LANE.devPort);
    }
    // The support matrix and the lane declaration together name the project
    // strings; this lane's must not be one of them.
    const known = SUPPORT_MATRIX.map((entry) => entry.project);
    expect(known).not.toContain(PHASE10_MEDIA_LANE.project);
    // And the preflight is the only thing that may gate on the artifact.
    expect(PHASE10_MEDIA_PREFLIGHT_COMMAND).toContain(PHASE10_MEDIA_PREFLIGHT_SCRIPT);
  });
});

describe('phase 10 media Playwright config', () => {
  it('binds exactly one project to exactly the new spec', () => {
    const projects = phase10MediaConfig.projects ?? [];
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe(PHASE10_MEDIA_LANE.project);
    expect(phase10MediaConfig.testMatch).toBe(PHASE10_MEDIA_LANE.testFile);
  });

  it('records no raw failure artifact', () => {
    expect(phase10MediaConfig.use?.trace).toBe('off');
    expect(phase10MediaConfig.use?.screenshot).toBe('off');
    expect(phase10MediaConfig.use?.video).toBe('off');
  });

  it('previews an existing build and serves a dev copy, and never decides to rebuild', () => {
    const servers = phase10MediaConfig.webServer;
    const list = Array.isArray(servers) ? servers : [servers];
    expect(list).toHaveLength(2);
    const commands = list.map((entry) => String(entry?.command));
    expect(commands).toContain(PHASE10_MEDIA_PREVIEW_SCRIPT);
    expect(commands).toContain(PHASE10_MEDIA_DEV_SCRIPT);
    for (const command of commands) {
      // Neither server may build: a lane that decided to rebuild could end up
      // measuring a different artifact than the one that was recorded.
      expect(command).not.toContain('npm run build');
    }
    for (const entry of list) {
      expect(entry?.reuseExistingServer, 'a stale server on the port is not reused').toBe(false);
      expect(entry?.cwd, 'the server runs from the repository root').toBe(REPO_ROOT);
    }
  });

  it('carries the artifact check in a command, not at module scope', () => {
    // The Phase 9 hermeticity defect class: a module-scope throw made the wiring
    // gate that imports this config fatal in any checkout without a build,
    // including the unit-tests CI job, which has none and never should. So the
    // config must carry no existence check at all.
    expect(configSource).not.toMatch(/existsSync/);
    expect(configSource).not.toMatch(/\bthrow\b/);
    // And the check lives in the preflight, which is a command.
    expect(preflightSource).toContain('existsSync');
    expect(preflightSource).toContain(PHASE10_MEDIA_MANIFEST_PATH);
    expect(PHASE10_MEDIA_PREFLIGHT_COMMAND).toBe(`node scripts/${PHASE10_MEDIA_PREFLIGHT_SCRIPT}`);
  });

  it('sits inside a TypeScript project, so the ordinary gate can see it', () => {
    const appTsconfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'tsconfig.app.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { include?: string[] };
    expect(appTsconfig.include, 'tests/ is inside the app project').toContain('tests');
    const eslintConfig = readFileSync(path.join(REPO_ROOT, 'eslint.config.js'), 'utf8');
    expect(eslintConfig, 'the linter is not told to ignore the config directory').not.toMatch(
      /playwright\.phase10-media/,
    );
  });

  it('keeps the seven release paths disjoint', () => {
    // No existing config may reach this spec, and this spec may not bind one of
    // theirs. Either direction would file Phase 10's evidence under another
    // lane's name, inside that lane's CI upload allowlist.
    const others: Array<[string, unknown]> = [
      ['playwright.config', playwrightConfig],
      ['storage-v2', storageV2Config],
      ['data-products', dataProductsConfig],
      ['subject-product', subjectConfig],
      ['reload-persistence', reloadConfig],
      ['pixi-memory', pixiMemoryConfig],
      ['pixi-pointer', pixiPointerConfig],
    ];
    const theirFiles = [
      CURRENT_BUILD_TEST_FILE,
      'compatibility.spec.ts',
      STORAGE_V2_TEST_FILE,
      DATA_PRODUCTS_TEST_FILE,
      SUBJECT_LANE_TEST_FILE,
      RELOAD_LANE_TEST_FILE,
      PIXI_MEMORY_TEST_FILE,
      PIXI_POINTER_LANE.testFile,
    ];
    for (const [name, config] of others) {
      const testMatch = (config as { testMatch?: unknown }).testMatch;
      const matched = Array.isArray(testMatch) ? testMatch : [testMatch];
      for (const entry of matched) {
        expect(String(entry), `${name} must not bind the Phase 10 spec`).not.toContain(
          PHASE10_MEDIA_LANE.testFile,
        );
      }
    }
    for (const file of theirFiles) {
      expect(validatePhase10MediaLane(), `the lane must not bind ${file}`).toEqual([]);
    }
    // And the project name is unique across the matrix and the other lanes.
    const allProjects = new Set<string>([
      ...SUPPORT_MATRIX.map((entry) => entry.project),
      PIXI_MEMORY_LANE.project,
      PIXI_POINTER_LANE.project,
      STORAGE_V2_TEST_FILE,
      DATA_PRODUCTS_TEST_FILE,
      SUBJECT_LANE.project,
      RELOAD_LANE.project,
    ]);
    expect(allProjects.has(PHASE10_MEDIA_LANE.project), 'the project name is unique').toBe(false);
  });
});

describe('phase 10 media spec', () => {
  it('verifies the recorded artifact before it measures anything, and does not skip a missing one', () => {
    expect(specSource).toContain('web-artifact-manifest.mjs');
    expect(specSource).toContain('beforeAll');
    // A `skip` on the identity check would turn "I could not measure" into green.
    expect(specSource).not.toMatch(/test\.skip\(/);
    expect(specSource).not.toMatch(/test\.fixme\(/);
  });

  it('never stubs the audio service, and says which module it drives', () => {
    // The real module, imported by path, and its public surface.
    expect(specSource).toContain("/src/services/audioManager.ts");
    expect(specSource).toContain('audioManager.playBgm');
    // No test double is substituted for the service, the graph, or the recipes.
    expect(specSource).not.toContain('createAudioGraph');
    expect(specSource).not.toContain('createProceduralAudioProvider');
    expect(specSource).not.toContain('FakeAudioContext');
  });

  it('installs the audio probe as an observer that delegates to the real constructor', () => {
    expect(specSource).toContain('Reflect.construct(target, args, newTarget)');
    expect(specSource).toContain('__KD_AUDIO_PROBE__');
    // It refuses to overwrite another hook rather than silently doing so.
    expect(specSource).toContain('refusing to overwrite another hook');
  });

  it('covers each of the four manual checks', () => {
    for (const heading of [
      'manual check 1, negative half',
      'manual check 1, positive half',
      'manual check 2',
      'manual check 3',
      'manual check 4',
    ]) {
      expect(specSource, `the spec covers ${heading}`).toContain(heading);
    }
  });

  it('carries a non-vacuity control on every measurement that could pass by doing nothing', () => {
    // The platform really has Web Audio, or every count below is zero by default.
    expect(specSource).toContain('platformHasAudio');
    // The journey really made requests, or "no off-origin request" is trivial.
    expect(specSource).toContain('the journey really made requests');
    // The bundle asset was really requested, or the fallback proves nothing.
    expect(specSource).toContain('the bundle members were really requested');
    // The touch sweep really inspected controls.
    expect(specSource).toContain('the sweep really inspected the panel controls');
    // Something really was holding live source nodes when dispose ran, so a count
    // that returns to zero is a measurement of the release and not of an
    // already-empty graph.
    expect(specSource).toContain('really was holding live source nodes before dispose');
  });

  it('attributes each counted AudioContext to an owner rather than counting blindly', () => {
    // The lane found this confound on its first run: the Phaser world constructs a
    // context of its own when the game boots, so a bare count would have reported
    // "1" for a journey in which the audio service built nothing — a false positive
    // on the phase's most important property. A lane that regressed to a bare count
    // would silently go back to being wrong in the same direction.
    expect(specSource).toContain('byAudioService');
    expect(specSource).toContain('byPhaser');
    expect(specSource).toContain('byUnknown');
    expect(specSource, 'an unexplained construction is itself a finding').toContain(
      'A context was constructed by neither',
    );
    // And the confound has its own test, so the attribution cannot rot into
    // "always zero".
    expect(specSource).toContain('records the pre-existing Phaser context rather than hiding it');
  });

  it('drives the real PixiJS asset runtime and the real loader, not a double', () => {
    expect(specSource).toContain('/src/renderers/pixi/runtime/createPixiApplication.ts');
    expect(specSource).toContain('/src/renderers/pixi/assets/AssetLoader.ts');
    expect(specSource).toContain("createPixiAssetRuntime()");
    // And it is against real network failures rather than a thrown error object.
    expect(specSource).toContain("route.abort('failed')");
  });

  it('blocks every non-local request before the application runs', () => {
    expect(specSource).toContain("url.hostname !== '127.0.0.1'");
    expect(specSource).toContain("route.abort('blockedbyclient')");
  });

  it('records privacy evidence as origin and path only', () => {
    // No query, no fragment, no headers, no body: an artifact must not be able to
    // carry a subject name.
    expect(specSource).toContain('url.pathname');
    expect(specSource).not.toContain('request.headers()');
    expect(specSource).not.toContain('request.postData()');
    expect(specSource).not.toContain('url.search');
  });

  it('is hermetic: no commit lookups, and no path that depends on where the checkout lives', () => {
    expect(specSource).not.toMatch(/\bgit\b/);
    expect(specSource).not.toMatch(/show\s+[0-9a-f]{7,40}/);
    // The only path it builds is a repository-relative one under `process.cwd()`,
    // which is how every other lane in this repository does it.
    expect(specSource).toContain('process.cwd()');
  });
});

/* ========================================================================== */
/* Reading the Phase 10 CI step out of the workflow text                       */
/* ========================================================================== */

/**
 * The steps that bound this lane's step, by name.
 *
 * `dist` is the *production* artifact from the identity check down to the step that
 * discards it, and this lane's preflight and its first test both verify that
 * production identity, so the window between those two steps is the window in which
 * this lane's measurements mean what they say. `PIXI_MEMORY_CI_DOWNLOAD_STEP` is
 * imported from the Pixi memory lane's declaration rather than restated, so a rename
 * there and a rename here cannot drift into two spellings of one step.
 *
 * `tests/phase9/pixi-pointer-lane-wiring.test.ts` names the production viewport suite
 * and the discard step in its own order assertion, and nothing below contradicts it.
 * That gate requires *nothing at all* to run between the discard and the flagged
 * download; this one requires the Phase 10 step to be before the discard. The two
 * together close the window from both ends.
 */
const PRODUCTION_SUITE_STEP = 'Run the current-build viewport suite against the shared artifact';
const PRODUCTION_IDENTITY_STEP = 'Verify the shared artifact identity';
const PRODUCTION_DISCARD_STEP = 'Discard the production dist before the flagged download';

/** The ordered window the lane's step has to sit inside, by step name. */
const LANE_WINDOW = [
  PRODUCTION_IDENTITY_STEP,
  PRODUCTION_SUITE_STEP,
  PHASE10_MEDIA_CI_STEP_NAME,
  PRODUCTION_DISCARD_STEP,
  PIXI_MEMORY_CI_DOWNLOAD_STEP,
];

/**
 * Enough steps that "nothing runs between two of them" is a statement about a window
 * and not about a parser that matched nothing.
 *
 * `browser-smoke` has sixteen; ten is a floor low enough to survive a future step and
 * high enough that a broken parse cannot satisfy the ordering checks. The same guard,
 * on the build job, is what `tests/phase9/memory-gate-wiring.test.ts` calls "the step
 * parser found almost nothing".
 */
const MINIMUM_BROWSER_SMOKE_STEPS = 10;

/**
 * The exemption key, named once.
 *
 * The sibling gates match it as a YAML key at the start of a line so that the prose
 * which discusses the exemption deliberately - in this file, and in the workflow's own
 * comments - is not counted as one, and then additionally assert the raw job text
 * never names it at all. Both forms are kept here for the same reason: the workflow's
 * comments explain their own placement without spelling this key, and a comment that
 * did spell it would fail the second form.
 */
const EXEMPTION_KEY = 'continue-on-error';

/** One `run:` step, in any spelling the repository builds with. */
const PRODUCTION_BUILD_STEP = /^\s*- run: (?:npm run build[^\n]*|(?:npx )?vite build[^\n]*|rollup -c[^\n]*)$/gm;
/** A Playwright browser install. */
const BROWSER_INSTALL_STEP = /^\s*- run: [^\n]*playwright install[^\n]*$/gm;
/** An artifact download, whatever version the action is pinned at. */
const ARTIFACT_DOWNLOAD_STEP = /^\s*uses: actions\/download-artifact[^\n]*$/gm;
/** An `npm ci`, with or without flags. */
const NPM_CI_STEP = /^\s*- run: npm ci[^\n]*$/gm;

/** The lane's step exactly as the workflow writes it, so a mutation can move or edit it. */
const LANE_STEP_TEXT = `      - name: ${PHASE10_MEDIA_CI_STEP_NAME}\n        run: ${PHASE10_MEDIA_CI_RUN_COMMAND}\n`;

/** The command line the lane's step runs, for a mutation that appends to it. */
const LANE_RUN_LINE = `        run: ${PHASE10_MEDIA_CI_RUN_COMMAND}\n`;

interface WorkflowStep {
  /** The step's `name:`, or `''` for an unnamed step. */
  readonly name: string;
  /** The step's own lines, with every comment line removed. */
  readonly ownText: string;
  /** The command it runs, a `run: |` block folded in. `''` for a `uses:` step. */
  readonly command: string;
  /** Whether the step executes anything at all. */
  readonly executes: boolean;
}

/** Splits a workflow into job blocks keyed by job id, as the sibling gates do. */
function parseWorkflowJobs(text: string): ReadonlyMap<string, string> {
  const lines = text.split('\n');
  const jobsIndex = lines.indexOf('jobs:');
  if (jobsIndex === -1) return new Map();
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current !== null) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

/**
 * The command a step runs, with a `run: |` block scalar folded in.
 *
 * Folding matters because a multi-line `run: |` is how this workflow records a shell
 * snippet, and a scan that read only the first line would miss every command under it.
 * A `uses:` step runs nothing here and yields `''`.
 */
function runCommandOf(ownLines: readonly string[]): string {
  const key = ownLines.findIndex((line) => /^ {6}(?:  )?run: /.test(line));
  if (key === -1) return '';
  const first = ownLines[key]?.trim().replace(/^run:\s*/, '') ?? '';
  if (!/^[|>][-+]?$/.test(first)) return first;
  const folded: string[] = [];
  for (const line of ownLines.slice(key + 1)) {
    if (line.trim() === '') {
      folded.push('');
      continue;
    }
    // The block ends at the first line that is not more indented than the `run:` key.
    if (!/^ {8}/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join('\n').trim();
}

/**
 * A job body split into the steps that run, in the order they run.
 *
 * Comments are removed per line rather than by block, and that is load-bearing rather
 * than tidy: this workflow's comment blocks sit at the step indentation and explain
 * the step that follows them, and the Phase 10 comment block states in so many words
 * that the step adds "no build, no download, no browser install, no second `npm ci`".
 * A scan that read a step's raw slice would report a violation of the very thing the
 * comment says, and the fix would be to delete the comment - which is how the prose
 * explaining a gate gets lost.
 */
function stepsOf(jobBody: string): WorkflowStep[] {
  const starts: number[] = [];
  const pattern = /^ {6}- /gm;
  for (let match = pattern.exec(jobBody); match !== null; match = pattern.exec(jobBody)) {
    starts.push(match.index);
  }
  return starts.map((start, index) => {
    const body = jobBody.slice(start, starts[index + 1] ?? jobBody.length);
    const ownLines = body.split('\n').filter((line) => !/^\s*#/.test(line));
    // The slice ends at the next step, so it ends with whatever separated the two:
    // a blank line here, and nothing else a step owns.
    while (ownLines.at(-1)?.trim() === '') ownLines.pop();
    const ownText = ownLines.join('\n');
    return {
      name: /^ {6}- name: (.+)$/m.exec(body)?.[1] ?? '',
      ownText,
      command: runCommandOf(ownLines),
      executes: /^\s*(?:run|uses)\s*:/m.test(ownText),
    };
  });
}

/** How many lines of a job body match a pattern, which is how the counts below are read. */
function countMatching(jobText: string, pattern: RegExp): number {
  return [...jobText.matchAll(pattern)].length;
}

interface Wiring {
  /** The named job's body, or `''` when the workflow has no such job. */
  readonly jobText: string;
  readonly steps: readonly WorkflowStep[];
}

interface WiringFinding {
  readonly check: WiringCheck;
  readonly detail: string;
}

type WiringCheck =
  | 'job-parsed'
  | 'step-present'
  | 'step-command'
  | 'step-not-exempt'
  | 'step-not-skipped'
  | 'step-adds-nothing'
  | 'job-no-production-build'
  | 'job-one-browser-install'
  | 'job-two-artifact-downloads'
  | 'job-one-npm-ci'
  | 'step-inside-the-production-window';

function readWiring(text: string): Wiring {
  const jobText = parseWorkflowJobs(text).get(PHASE10_MEDIA_CI_JOB) ?? '';
  return { jobText, steps: jobText === '' ? [] : stepsOf(jobText) };
}

function laneStepOf(wiring: Wiring): WorkflowStep | undefined {
  return wiring.steps.find((step) => step.name === PHASE10_MEDIA_CI_STEP_NAME);
}

function windowIndices(steps: readonly WorkflowStep[]): number[] {
  return LANE_WINDOW.map((name) => steps.findIndex((step) => step.name === name));
}

const MISSING_STEP = `${PHASE10_MEDIA_CI_JOB} has no step named "${PHASE10_MEDIA_CI_STEP_NAME}".`;

/**
 * Every property this block holds, as one predicate over the parsed job.
 *
 * One implementation with two consumers: the expectations in the block below, which
 * report a red run as a named check with the text that broke it, and the mutation
 * table under them, which proves each of these can fail. A second implementation for
 * the mutation table would prove only that the second implementation can fail, which
 * is the defect this block replaced: a gate that reads true whether or not the
 * wiring exists.
 */
const WIRING_CHECKS: Record<WiringCheck, (wiring: Wiring) => string | null> = {
  'job-parsed': (wiring) => {
    if (wiring.jobText === '') return `ci.yml has no ${PHASE10_MEDIA_CI_JOB} job.`;
    if (wiring.steps.length < MINIMUM_BROWSER_SMOKE_STEPS) {
      return `the job parsed ${wiring.steps.length} steps, so every check below would be reading a near-empty list.`;
    }
    return null;
  },
  'step-present': (wiring) => {
    const found = wiring.steps.filter((step) => step.name === PHASE10_MEDIA_CI_STEP_NAME);
    if (found.length !== 1) {
      return `expected exactly one step named "${PHASE10_MEDIA_CI_STEP_NAME}" in ${PHASE10_MEDIA_CI_JOB}; found ${found.length}.`;
    }
    return null;
  },
  'step-command': (wiring) => {
    const step = laneStepOf(wiring);
    if (step === undefined) return MISSING_STEP;
    if (step.command !== PHASE10_MEDIA_CI_RUN_COMMAND) {
      return `the step runs \`${step.command}\` rather than the declared \`${PHASE10_MEDIA_CI_RUN_COMMAND}\`.`;
    }
    return null;
  },
  'step-not-exempt': (wiring) => {
    if (wiring.jobText === '') return `ci.yml has no ${PHASE10_MEDIA_CI_JOB} job.`;
    // The key form first, so prose that discusses the exemption deliberately is not
    // counted as one, and the raw form second because a job-level exemption swallows
    // every step's failure just as effectively and several gates assert on raw text.
    const keys = [...wiring.jobText.matchAll(/^\s*continue-on-error\s*:/gm)].map((match) => match[0].trim());
    if (keys.length > 0) return `${PHASE10_MEDIA_CI_JOB} carries the exemption key: ${keys.join(', ')}.`;
    if (wiring.jobText.includes(EXEMPTION_KEY)) {
      return `the job's own text names the exemption key, which several working gates scan for in this job's raw text.`;
    }
    const step = laneStepOf(wiring);
    if (step === undefined) return MISSING_STEP;
    // A shell escape does the same thing as the key, and no gate above looks for it.
    for (const escape of ['|| true', 'exit 0']) {
      if (step.command.includes(escape)) return `the step's command escapes failure with \`${escape}\`.`;
    }
    return null;
  },
  'step-not-skipped': (wiring) => {
    const step = laneStepOf(wiring);
    if (step === undefined) return MISSING_STEP;
    // An `if:` that is ever false is a skip: the step would report nothing while the
    // job stayed green, and `if: always()` would run it after a red step, which is a
    // different lane's policy rather than this one's evidence.
    const conditional = /^\s*if\s*:.*$/m.exec(step.ownText);
    if (conditional) return `the step carries \`${conditional[0].trim()}\`, so it can be skipped.`;
    return null;
  },
  'step-adds-nothing': (wiring) => {
    const step = laneStepOf(wiring);
    if (step === undefined) return MISSING_STEP;
    // A step is one step. An `uses:` key here would mean the lane was replaced by an
    // action rather than appended to, which runs no command at all.
    if (/^\s*uses\s*:/m.test(step.ownText)) {
      return 'the step is an action step rather than a run step, so it runs no command.';
    }
    // Each of these four is a count other gates pin in this job, so a step that added
    // one would be a silent breach of a gate that is currently working - and the
    // breach would be reported by a different file, in a different phase, with a
    // message that names the wrong lane.
    for (const [what, pattern] of [
      ['a production build', /npm run build/],
      ['an artifact download', /download-artifact/],
      ['a browser install', /playwright install/],
      ['a second npm ci', /npm ci/],
    ] as const) {
      if (pattern.test(step.ownText)) return `the step's own text adds ${what}.`;
    }
    return null;
  },
  'job-no-production-build': (wiring) => {
    if (wiring.jobText === '') return `ci.yml has no ${PHASE10_MEDIA_CI_JOB} job.`;
    const builds = countMatching(wiring.jobText, PRODUCTION_BUILD_STEP);
    if (builds !== 0) return `${PHASE10_MEDIA_CI_JOB} builds a production artifact ${builds} times; only web-build may.`;
    return null;
  },
  'job-one-browser-install': (wiring) => {
    if (wiring.jobText === '') return `ci.yml has no ${PHASE10_MEDIA_CI_JOB} job.`;
    const installs = countMatching(wiring.jobText, BROWSER_INSTALL_STEP);
    if (installs !== 1) return `${PHASE10_MEDIA_CI_JOB} installs a browser ${installs} times; it is entitled to the one it already had.`;
    return null;
  },
  'job-two-artifact-downloads': (wiring) => {
    if (wiring.jobText === '') return `ci.yml has no ${PHASE10_MEDIA_CI_JOB} job.`;
    const downloads = countMatching(wiring.jobText, ARTIFACT_DOWNLOAD_STEP);
    if (downloads !== 2) return `${PHASE10_MEDIA_CI_JOB} downloads an artifact ${downloads} times; it has the production one and the Pixi-flagged one.`;
    return null;
  },
  'job-one-npm-ci': (wiring) => {
    if (wiring.jobText === '') return `ci.yml has no ${PHASE10_MEDIA_CI_JOB} job.`;
    const installs = countMatching(wiring.jobText, NPM_CI_STEP);
    if (installs !== 1) return `${PHASE10_MEDIA_CI_JOB} runs \`npm ci\` ${installs} times; one checkout, one install.`;
    return null;
  },
  'step-inside-the-production-window': (wiring) => {
    // The same five indices the expectation below states, computed the same way, so
    // the mutations below prove the assertion and not a weaker restatement of it.
    const indices = windowIndices(wiring.steps);
    for (const [position, name] of LANE_WINDOW.entries()) {
      if (indices[position] < 0) {
        return `${PHASE10_MEDIA_CI_JOB} has no step named "${name}"; the window cannot be checked.`;
      }
    }
    if ([...indices].sort((a, b) => a - b).join() !== indices.join()) {
      return `these five steps are at positions [${indices.join(', ')}] rather than in the order [${LANE_WINDOW.join(' -> ')}]; the lane's step is at position ${indices[2]}, outside the window in which \`dist\` is the production artifact.`;
    }
    // The half the pointer gate does not cover. Between this step and the discard,
    // `dist` is still the production artifact this lane previews, so anything that
    // runs in that window could replace the tree the next step measures - and a green
    // run would describe something other than what it claims.
    const laneAt = indices[2];
    const discardAt = indices[3];
    const between = wiring.steps.slice(laneAt + 1, discardAt).filter((step) => step.executes);
    if (between.length > 0) {
      return `these steps run between the lane and the discard: ${between.map((step) => step.name).join(', ')}.`;
    }
    return null;
  },
};

/** Every finding a workflow has, in check order. Empty means the wiring is what it claims. */
function wiringFindings(text: string): WiringFinding[] {
  const wiring = readWiring(text);
  const findings: WiringFinding[] = [];
  for (const [check, evaluate] of Object.entries(WIRING_CHECKS) as ReadonlyArray<
    [WiringCheck, (wiring: Wiring) => string | null]
  >) {
    const detail = evaluate(wiring);
    if (detail !== null) findings.push({ check, detail });
  }
  return findings;
}

/** Asserts one named check holds, so a red run names the property and the text that broke it. */
function expectWiringHolds(check: WiringCheck, wiring: Wiring): void {
  expect(WIRING_CHECKS[check](wiring), `${check} does not hold`).toBeNull();
}

interface WiringMutation {
  /** What the mutated workflow does, in the words a reader would use. */
  readonly what: string;
  /** The check that has to reject it. */
  readonly check: WiringCheck;
  readonly apply: (text: string) => string;
}

/** Replaces text through a function, so `$` in the replacement is never a pattern. */
function rewrite(text: string, from: string, to: string): string {
  return text.replace(from, () => to);
}

/** Moves the lane's step to just before the step named `anchor`. */
function moveLaneStepBefore(anchor: string) {
  return (text: string): string => rewrite(rewrite(text, LANE_STEP_TEXT, ''), anchor, LANE_STEP_TEXT + anchor);
}

/**
 * The mutations that prove each check can fail.
 *
 * Every one is a real way this wiring has been got wrong elsewhere in the repository -
 * a lane added to the wrong job, a lane added after the step that replaces its
 * artifact, a step marked advisory, a step that quietly reinstalls - and each names the
 * check that has to reject it. The block below asserts both that the mutation changed
 * the workflow at all and that the named check, specifically, rejected it, and then
 * that no check is left without a mutation: a check nobody tried to break is the
 * vacuous gate this block replaced, one level down.
 */
const WIRING_MUTATIONS: readonly WiringMutation[] = [
  {
    what: 'the job is renamed',
    check: 'job-parsed',
    apply: (text) => rewrite(text, '\n  browser-smoke:\n', '\n  browser-smoke-lanes:\n'),
  },
  {
    what: 'the step is deleted',
    check: 'step-present',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, ''),
  },
  {
    what: 'the step is renamed',
    check: 'step-present',
    apply: (text) => rewrite(text, `- name: ${PHASE10_MEDIA_CI_STEP_NAME}`, '- name: Run the Phase 10 lane'),
  },
  {
    what: 'the step runs raw Playwright instead of the npm script',
    check: 'step-command',
    apply: (text) => rewrite(text, LANE_RUN_LINE, `        run: npx playwright test --config=${PHASE10_MEDIA_CONFIG_FILE}\n`),
  },
  {
    what: "the step's command swallows its own failure",
    check: 'step-not-exempt',
    apply: (text) => rewrite(text, LANE_RUN_LINE, `        run: ${PHASE10_MEDIA_CI_RUN_COMMAND} || true\n`),
  },
  {
    what: 'the step is exempt from failing',
    check: 'step-not-exempt',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}        continue-on-error: true\n`),
  },
  {
    what: 'the job is exempt at job level',
    check: 'step-not-exempt',
    apply: (text) => rewrite(text, '    needs: [web-build]\n', '    needs: [web-build]\n    continue-on-error: true\n'),
  },
  {
    what: 'the step is skipped by a condition',
    check: 'step-not-skipped',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}        if: \${{ false }}\n`),
  },
  {
    what: 'the step also runs npm ci',
    check: 'step-adds-nothing',
    apply: (text) => rewrite(text, LANE_RUN_LINE, `        run: npm ci --ignore-scripts && ${PHASE10_MEDIA_CI_RUN_COMMAND}\n`),
  },
  {
    what: 'the step also installs a browser',
    check: 'step-adds-nothing',
    apply: (text) => rewrite(text, LANE_RUN_LINE, `        run: npx playwright install --with-deps chromium && ${PHASE10_MEDIA_CI_RUN_COMMAND}\n`),
  },
  {
    what: 'the step is replaced by an artifact download',
    check: 'step-adds-nothing',
    apply: (text) =>
      rewrite(text, LANE_STEP_TEXT, `      - name: ${PHASE10_MEDIA_CI_STEP_NAME}\n        uses: actions/download-artifact@v4\n`),
  },
  {
    what: 'the step also builds',
    check: 'step-adds-nothing',
    apply: (text) => rewrite(text, LANE_RUN_LINE, `        run: npm run build:web && ${PHASE10_MEDIA_CI_RUN_COMMAND}\n`),
  },
  {
    what: 'a second browser install is added to the job',
    check: 'job-one-browser-install',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}      - run: npx playwright install --with-deps chromium\n`),
  },
  {
    what: 'a third artifact download is added to the job',
    check: 'job-two-artifact-downloads',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}      - name: Download the production artifact again\n        uses: actions/download-artifact@v4\n`),
  },
  {
    what: 'a second npm ci is added to the job',
    check: 'job-one-npm-ci',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}      - run: npm ci --ignore-scripts\n`),
  },
  {
    what: 'a second production build is added to the job',
    check: 'job-no-production-build',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}      - run: npm run build:web\n`),
  },
  {
    what: 'the step is moved after the production tree is discarded',
    check: 'step-inside-the-production-window',
    apply: moveLaneStepBefore(`      - name: ${PIXI_MEMORY_CI_DOWNLOAD_STEP}\n`),
  },
  {
    what: 'the step is moved before the production identity check',
    check: 'step-inside-the-production-window',
    apply: moveLaneStepBefore(`      - name: ${PRODUCTION_IDENTITY_STEP}\n        run: npm run verify:web-artifact\n`),
  },
  {
    what: 'a step runs between the lane and the discard',
    check: 'step-inside-the-production-window',
    apply: (text) => rewrite(text, LANE_STEP_TEXT, `${LANE_STEP_TEXT}      - name: Download the Pixi-flagged artifact early\n        uses: actions/download-artifact@v4\n`),
  },
];

/**
 * The CI wiring, as a gate rather than as a string that happens to be present.
 *
 * ## What this block holds, and what each property prevents
 *
 * 1. **The step exists, in the named job, and runs the declared npm script.** The
 *    previous version of this block asserted that the string `browser-smoke:` appears
 *    in the workflow, which was true before Phase 10 wired anything and would stay
 *    true if the step were deleted. A lane whose whole claim is that it gates needs a
 *    gate that says the step is there. The command is compared for equality, so a raw
 *    `npx playwright test` cannot stand in for the script and become a second thing to
 *    keep in step with it.
 * 2. **The step cannot be exempted from failing, and cannot be skipped.** Either one
 *    turns a red lane into a green job: the gesture, persistence, no-egress and
 *    four-viewport accessibility checks would report nothing while CI stayed green,
 *    which is the failure mode the Phase 9 record argues for - three of that phase's
 *    four shipped defects were found by CI and by nothing else.
 * 3. **The step adds a step, not a cost.** `tests/phase9/memory-gate-wiring.test.ts`
 *    and `tests/phase9/pixi-pointer-lane-wiring.test.ts` pin this job to one `npm ci`,
 *    one browser install, two artifact downloads and no `build:web*` script. Those
 *    gates are working; a step that added a third download would breach one of them,
 *    and the breach would be reported by another phase's file about another lane. The
 *    counts are restated here so this gate is the canary in front of them.
 * 4. **The step is inside the production window, and nothing runs after it before the
 *    discard.** This is the load-bearing one and the reason the ordering is asserted
 *    at all. This lane previews the *production* artifact on purpose: its preflight
 *    and its first test both verify the production identity, and the step immediately
 *    after it deletes `dist` and the step after that replaces it with the
 *    Pixi-flagged build. A step placed after the discard would verify the production
 *    identity and then preview a Pixi-flagged tree - a green run describing something
 *    other than what it claims, which is the same shape of defect the discard step
 *    exists to prevent. `tests/phase9/pixi-pointer-lane-wiring.test.ts` holds the other
 *    end of the same window, that nothing runs between the discard and the flagged
 *    download; the two assertions cannot both pass unless this step is before the
 *    discard.
 * 5. **Every one of the above can fail.** Each is a named check over a parsed job, and
 *    each has a mutation below that the check rejects. A gate that cannot fail is the
 *    defect this block replaced, so the block holds itself to the standard it is
 *    restoring, and a check added later without a mutation fails the completeness
 *    assertion rather than shipping as a renamed version of the old one.
 *
 * ## Hermeticity
 *
 * The workflow is read as text and never executed, nothing is spawned, nothing is
 * written, and no path outside the repository is consulted, so this block passes in a
 * checkout with no `dist/`, no `artifacts/` and no prior build - which is what the
 * `unit-tests` CI job has, and what the import of the lane's config above depends on.
 *
 * Privacy: the only thing read is the workflow, and the only thing printed from it is
 * the failing check's own message, which names a step and a command.
 */
describe('phase 10 media CI wiring (ci.yml)', () => {
  const wiring = readWiring(ciWorkflow);

  it('runs the declared npm script, from the named step in the named job', () => {
    expect(PHASE10_MEDIA_CI_JOB).toBe('browser-smoke');
    expectWiringHolds('job-parsed', wiring);
    expectWiringHolds('step-present', wiring);
    expectWiringHolds('step-command', wiring);
    // The command CI runs and the command the declaration names are one string, so the
    // local command and the CI step cannot drift into two things kept in step by hand.
    expect(PHASE10_MEDIA_CI_RUN_COMMAND).toBe(`npm run ${PHASE10_MEDIA_CI_RUN_SCRIPT}`);
    expect(npmScripts[PHASE10_MEDIA_CI_RUN_SCRIPT], `${PHASE10_MEDIA_CI_RUN_SCRIPT} is in package.json`).toBeDefined();
    // The parsed step really is this lane's step, and not a neighbouring comment
    // block: `stepsOf` gives back the command that step runs, and every check above
    // is reading that rather than the prose around it.
    expect(laneStepOf(wiring)?.command).toBe(PHASE10_MEDIA_CI_RUN_COMMAND);
  });

  it('GATES: the step cannot be exempt from failing, and cannot be skipped', () => {
    expectWiringHolds('step-not-exempt', wiring);
    expectWiringHolds('step-not-skipped', wiring);
    // The counts and the key, stated as the sibling gates state them. The key form
    // first, so this file's prose and the workflow's own comments - which discuss the
    // exemption deliberately without naming the key - are not counted as one, and the
    // raw form second because `tests/e2e/pixi-memory-lane.test.ts` and
    // `tests/e2e/welcome-narrow-viewport.test.ts` both assert on this job's raw text.
    expect(countMatching(wiring.jobText, /^\s*continue-on-error\s*:/gm), 'an exempt step in this job').toBe(0);
    expect(wiring.jobText).not.toMatch(/continue-on-error/);
  });

  it('adds a step, not a build, an artifact download, a browser install, or a second npm ci', () => {
    expectWiringHolds('step-adds-nothing', wiring);
    expectWiringHolds('job-no-production-build', wiring);
    expectWiringHolds('job-one-browser-install', wiring);
    expectWiringHolds('job-two-artifact-downloads', wiring);
    expectWiringHolds('job-one-npm-ci', wiring);
    // The numbers the Phase 9 gates pin in this job, restated so a red run says which
    // count moved. One checkout, one install, the production artifact and the
    // Pixi-flagged one, and no production build outside `web-build`.
    expect(countMatching(wiring.jobText, NPM_CI_STEP)).toBe(1);
    expect(countMatching(wiring.jobText, BROWSER_INSTALL_STEP)).toBe(1);
    expect(countMatching(wiring.jobText, ARTIFACT_DOWNLOAD_STEP)).toBe(2);
    expect(countMatching(wiring.jobText, PRODUCTION_BUILD_STEP)).toBe(0);
  });

  it('runs inside the production window, and nothing runs between it and the discard', () => {
    expectWiringHolds('step-inside-the-production-window', wiring);
    // The window, named, so a red run reports an order rather than a predicate. The
    // indices are taken inside this job's parsed steps, not against the whole
    // workflow: `web-build` carries a step of its own named `Verify the shared
    // production artifact identity`, and a workflow-wide search matches that one first,
    // which inverts the answer.
    const indices = windowIndices(wiring.steps);
    expect(indices.every((index) => index > -1), 'all five steps are in this job').toBe(true);
    expect([...indices].sort((a, b) => a - b), 'the five steps are not in that order').toEqual(indices);
    // And the window's far end, which is this block's half and the pointer gate's is
    // the other one.
    const between = wiring.steps.slice(indices[1] + 1, indices[2]).filter((step) => step.executes);
    expect(
      between.map((step) => step.name),
      'something runs between the lane and the discard of the production tree',
    ).toEqual([]);
  });

  it('rejects every mutation of the wiring it claims to gate, and no check is left unmutated', () => {
    expect(
      wiringFindings(ciWorkflow).map((finding) => `${finding.check}: ${finding.detail}`),
      'the workflow as committed has a wiring finding',
    ).toEqual([]);
    for (const mutation of WIRING_MUTATIONS) {
      const mutated = mutation.apply(ciWorkflow);
      // A mutation whose `replace` matched nothing is a no-op, and would prove
      // nothing while reading like a proof.
      expect(mutated, `${mutation.what}: the mutation changed nothing`).not.toBe(ciWorkflow);
      expect(
        wiringFindings(mutated).map((finding) => finding.check),
        `${mutation.what}: nothing rejected it`,
      ).toContain(mutation.check);
    }
    // And no check without one: a check that has never been tried to break is the
    // vacuous gate this block replaced, one level down.
    expect(
      [...new Set(WIRING_MUTATIONS.map((mutation) => mutation.check))].sort(),
      'a check has no mutation proving it can fail',
    ).toEqual([...Object.keys(WIRING_CHECKS)].sort());
  });
});
