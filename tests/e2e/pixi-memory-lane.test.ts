/**
 * Pixi world-host memory lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. The properties below are the ones whose
 * absence would make the lane report something other than what it claims:
 *
 * 1. The declaration is internally consistent, claims a bounded scope, and states
 *    what it does not prove - including the four boundaries that matter most, each
 *    asserted by content rather than by count, because a `doesNotProve` list of
 *    plausible sentences can omit the one a reader needs.
 * 2. The cycle count is the plan's cycle count, pinned against the constant
 *    `scripts/check-memory.mjs` prints as the runtime measurement it cannot make.
 *    A lane that quietly used a different number would answer a question nobody
 *    asked, and the two scripts sit far enough apart to drift silently.
 * 3. The build flag is the plan's flag, its production default is still `phaser`,
 *    and this lane is the only thing that turns it on.
 * 4. The Playwright config binds exactly one project to exactly the new spec,
 *    previews an existing build on its own port, never decides to rebuild, and
 *    records no raw failure artifact.
 * 5. **The config is inside a TypeScript project.** It lives under `tests/e2e/`
 *    rather than beside the four existing configs precisely so that `tsc -b` and
 *    `eslint` both see it; a config inside no project is a config whose type
 *    errors surface only when Playwright happens to run it.
 * 6. **Six release paths stay disjoint.** The default config and the four flagged
 *    configs each bind their own spec, so `npm run test:e2e` cannot reach this spec
 *    and no existing lane is widened.
 * 7. The CI wiring is three gating steps inside the existing `browser-smoke` job,
 *    after the production viewport suite that shares its Chromium install and its
 *    production artifact, so the run stays at one `npm ci`, one browser install, one
 *    build of each flagged artifact, and one production upload. The step is asserted
 *    not to be exempt from failing, and the build job is asserted still to install
 *    no browser of any kind.
 * 8. **The spec measures what it says.** The 20-cycle test, the ResizeObserver
 *    precondition, the idle-surface reading, the DOM-mirror pass, the reduced-motion
 *    pass, and the recorded-identity verification are each asserted mechanically, so
 *    a spec that quietly stopped driving cycles cannot pass this gate.
 * 9. The change is hermetic in the sense `tests/phase8/qa-hermeticity.test.ts`
 *    established: nothing in it resolves a commit, and nothing in it produces a path
 *    that depends on where the checkout lives.
 *
 * Privacy: this file contains no learner data, reads only the repository, and
 * spawns nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import pixiMemoryConfig from './playwright.pixi-memory.config';
import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import dataProductsConfig from '../../playwright.data-products.config';
import subjectConfig from '../../playwright.subject-product.config';
import reloadConfig from '../../playwright.reload-persistence.config';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX } from './support-matrix';
import { DATA_PRODUCTS_TEST_FILE } from './data-products-lane';
import { STORAGE_V2_TEST_FILE } from './storage-v2-lane';
import { SUBJECT_LANE, SUBJECT_LANE_TEST_FILE } from './subject-product-lane';
import { RELOAD_LANE, RELOAD_LANE_TEST_FILE } from './reload-persistence-lane';
import {
  PIXI_MEMORY_BUILD_SCRIPT,
  PIXI_MEMORY_CI_BUILD_JOB,
  PIXI_MEMORY_CI_DOWNLOAD_STEP,
  PIXI_MEMORY_CI_JOB,
  PIXI_MEMORY_CI_RUN_COMMAND,
  PIXI_MEMORY_CI_RUN_SCRIPT,
  PIXI_MEMORY_CI_STEP_NAME,
  PIXI_MEMORY_CI_UPLOAD_ARTIFACT,
  PIXI_MEMORY_CI_UPLOAD_STEP,
  PIXI_MEMORY_CI_VERIFY_STEP,
  PIXI_MEMORY_CONFIG_FILE,
  PIXI_MEMORY_FLAG,
  PIXI_MEMORY_FLAG_VALUE,
  PIXI_MEMORY_LANE,
  PIXI_MEMORY_LANE_FULL_SCRIPT,
  PIXI_MEMORY_LANE_SCRIPT,
  PIXI_MEMORY_MANIFEST_PATH,
  PIXI_MEMORY_PLAYWRIGHT_COMMAND,
  PIXI_MEMORY_PREVIEW_PORT,
  PIXI_MEMORY_PREVIEW_SCRIPT,
  PIXI_MEMORY_RECORD_SCRIPT,
  PIXI_MEMORY_TEST_FILE,
  PIXI_MEMORY_TEST_PATH,
  PIXI_MEMORY_VERIFY_SCRIPT,
  validatePixiMemoryLane,
} from './pixi-memory-lane';
import { PIXI_MEMORY_CYCLES } from './pixi-memory-series';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const APP_TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.app.json');
const MEMORY_PREFLIGHT_PATH = path.join(REPO_ROOT, 'scripts/check-memory.mjs');
const MANIFEST_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/web-artifact-manifest.mjs');

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

function parseWorkflowJobs(text: string): ReadonlyMap<string, string> {
  const lines = text.split('\n');
  const jobsIndex = lines.indexOf('jobs:');
  if (jobsIndex === -1) throw new Error('Workflow has no jobs: section.');

  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const ciJobs = parseWorkflowJobs(ciWorkflow);

/** The text of one named step, up to the next step in the same job. */
function stepBlockFor(jobBody: string, stepName: string): string {
  const index = jobBody.indexOf(`name: ${stepName}`);
  if (index === -1) throw new Error(`The job has no step named ${stepName}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

describe('pixi memory lane declaration', () => {
  it('is internally consistent and claims its own bounded scope', () => {
    expect(validatePixiMemoryLane()).toEqual([]);
    expect(PIXI_MEMORY_LANE.worldRenderer).toBe('pixi');
    expect(PIXI_MEMORY_LANE.storageRepository).toBe('legacy');
    expect(PIXI_MEMORY_LANE.dataProductsV2).toBe(false);
    // The lane is a step in `browser-smoke`, not a step beside the storage-v2
    // flagged builds. It could not be the other one: that job's own gate asserts it
    // neither downloads an artifact nor runs a `build:web*` script, and it uploads
    // evidence only, so a flagged `dist` it produced could never be handed on.
    expect(PIXI_MEMORY_CI_JOB).toBe('browser-smoke');
    expect(PIXI_MEMORY_CI_BUILD_JOB).toBe('web-build');
    expect(PIXI_MEMORY_LANE.ciLane).toBe('steps-in-the-existing-browser-smoke-job');
    expect(PIXI_MEMORY_LANE.claim.length).toBeGreaterThan(200);
    expect(PIXI_MEMORY_LANE.doesNotProve.length).toBeGreaterThanOrEqual(10);
  });

  it('states the four boundaries a reader of this gate most needs', () => {
    const notProven = PIXI_MEMORY_LANE.doesNotProve.join(' ');
    // No GPU memory or live-context number, and what is asserted instead.
    expect(notProven).toMatch(/GPU memory/i);
    expect(notProven).toMatch(/isContextLost|live/i);
    // No detector for the recorded PixiJS defect, and the precondition that stands in for it.
    expect(notProven).toMatch(/CanvasObserver/i);
    expect(notProven).toMatch(/ResizeObserver/i);
    // No heap bound, and why.
    expect(notProven).toMatch(/heap/i);
    // Not a page-level unmount, and not a quiescent document.
    expect(notProven).toMatch(/page-level unmount/i);
    expect(notProven).toMatch(/quiescent/i);
    // And the matrix boundaries the plan itself states.
    expect(notProven).toMatch(/physical device/i);
    expect(notProven).toMatch(/cross-engine/i);
    expect(notProven).toMatch(/not the production artifact/i);
    expect(notProven).toMatch(/not Electron/i);
  });

  it('runs the plan cycle count, pinned against the preflight that cannot measure it', () => {
    expect(PIXI_MEMORY_CYCLES).toBe(20);
    expect(PIXI_MEMORY_LANE.cycles).toBe(PIXI_MEMORY_CYCLES);
    // `scripts/check-memory.mjs` prints this number as the runtime measurement it
    // declines to make. The two must agree, or the browser lane answers a question
    // the build gate is not asking.
    const preflight = readFileSync(MEMORY_PREFLIGHT_PATH, 'utf8');
    expect(preflight).toContain('export const MOUNT_UNMOUNT_CYCLES = 20;');
    expect(preflight).toContain('MOUNT_UNMOUNT_CYCLES');
    // And the preflight still says it measures none of this, so the lane is not a
    // duplicate of it.
    expect(preflight).toMatch(/NOT MEASURED/);
    expect(preflight).toMatch(/A Playwright lane that mounts and unmounts the world/);
  });

  it('the flag is the plan flag, its production default is still phaser, and this lane turns it on', () => {
    expect(PIXI_MEMORY_FLAG).toBe('VITE_WORLD_RENDERER');
    expect(RUNTIME_FLAG_ENV_KEYS.worldRenderer).toBe(PIXI_MEMORY_FLAG);
    expect(FEATURE_FLAG_MATRIX.worldRenderer.productionDefault).toBe('phaser');
    expect(DEFAULT_RUNTIME_CONFIG.worldRenderer).toBe('phaser');
    expect(FEATURE_FLAG_MATRIX.worldRenderer.ownerPhase).toBe(9);
    expect(PIXI_MEMORY_FLAG_VALUE).toBe('pixi');
    expect(PIXI_MEMORY_LANE.worldRenderer).toBe(PIXI_MEMORY_FLAG_VALUE);
  });

  it('builds with the existing Pixi script and records to its own manifest', () => {
    expect(npmScripts[PIXI_MEMORY_BUILD_SCRIPT]).toContain('VITE_WORLD_RENDERER=pixi');
    expect(npmScripts[PIXI_MEMORY_BUILD_SCRIPT]).toContain('npm run build:web');
    // The recorded identity is its own file, so a flagged build can never overwrite
    // another flagged build's identity or the production one.
    expect(PIXI_MEMORY_MANIFEST_PATH).toBe('artifacts/web-artifact-manifest-pixi.json');
    expect([
      'artifacts/web-artifact-manifest.json',
      'artifacts/web-artifact-manifest-storage-v2.json',
    ]).not.toContain(PIXI_MEMORY_MANIFEST_PATH);
  });
});

describe('pixi memory npm scripts', () => {
  it('exposes the lane under the repository\'s own test:e2e naming', () => {
    // The same three shapes the Phase 5, Phase 6 and reload-persistence lanes use:
    // the plain name previews an artifact that already exists, `:full` builds and
    // records one first, and `:recorded` is the preview-only script CI runs.
    for (const script of [PIXI_MEMORY_LANE_SCRIPT, PIXI_MEMORY_LANE_FULL_SCRIPT, PIXI_MEMORY_CI_RUN_SCRIPT]) {
      expect(npmScripts[script], `package.json has no ${script} script`).toBeDefined();
    }
    expect(PIXI_MEMORY_CI_RUN_SCRIPT).toBe(`${PIXI_MEMORY_LANE_SCRIPT}:recorded`);
    expect(PIXI_MEMORY_LANE_FULL_SCRIPT).toBe(`${PIXI_MEMORY_LANE_SCRIPT}:full`);
  });

  it('runs exactly the Playwright invocation the lane declares, and cannot widen it', () => {
    // The config this lane owns, bound by the one command both scripts share, so a
    // second spec cannot be reachable through a different `--config`.
    for (const script of [PIXI_MEMORY_LANE_SCRIPT, PIXI_MEMORY_CI_RUN_SCRIPT]) {
      expect(npmScripts[script]).toBe(PIXI_MEMORY_PLAYWRIGHT_COMMAND);
      expect(npmScripts[script].split('&&')).toHaveLength(1);
    }
    expect(PIXI_MEMORY_PLAYWRIGHT_COMMAND).toBe(
      `playwright test --config=${PIXI_MEMORY_CONFIG_FILE}`,
    );
    // No other spec, and no `--project` override that could select a project the
    // config does not declare.
    for (const script of [PIXI_MEMORY_LANE_SCRIPT, PIXI_MEMORY_LANE_FULL_SCRIPT, PIXI_MEMORY_CI_RUN_SCRIPT]) {
      for (const forbidden of ['--project', 'currentBuild', 'compatibility.spec', 'storageV2']) {
        expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never rebuilds from the two preview-only scripts, so CI cannot re-measure a different artifact', () => {
    // `browser-smoke` runs the production viewport suite first and this lane's
    // download replaces `dist` after it. A `:recorded` script that built would make
    // the artifact under test depend on the step that ran it.
    for (const script of [PIXI_MEMORY_LANE_SCRIPT, PIXI_MEMORY_CI_RUN_SCRIPT]) {
      for (const forbidden of ['build:web', 'vite build', 'record:web-artifact', 'npm ci']) {
        expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('puts the build, and only the build, in the :full script', () => {
    // The local one-command form, and the only place this lane may produce an
    // artifact. The build and the record are separate commands so a local run that
    // already has both does not rebuild.
    const full = npmScripts[PIXI_MEMORY_LANE_FULL_SCRIPT] ?? '';
    expect(full).toBe(
      `npm run ${PIXI_MEMORY_BUILD_SCRIPT} && npm run ${PIXI_MEMORY_RECORD_SCRIPT} && ${PIXI_MEMORY_PLAYWRIGHT_COMMAND}`,
    );
    expect(full.split('&&')).toHaveLength(3);
  });

  it('records the Pixi-flagged identity through its own record and verify scripts', () => {
    // The flags live in `package.json`, so the CI step and the local command are the
    // same command and there is no second place to keep in step with them.
    expect(npmScripts[PIXI_MEMORY_RECORD_SCRIPT]).toBe(
      `node scripts/web-artifact-manifest.mjs write --out=${PIXI_MEMORY_MANIFEST_PATH}`,
    );
    expect(npmScripts[PIXI_MEMORY_VERIFY_SCRIPT]).toBe(
      `node scripts/web-artifact-manifest.mjs verify --manifest=${PIXI_MEMORY_MANIFEST_PATH}`,
    );
    // ...and the script the scripts name really does take those flags and really has
    // both modes, so a rename upstream fails here rather than at 3 a.m. in the lane.
    const manifestScript = readFileSync(MANIFEST_SCRIPT_PATH, 'utf8');
    expect(manifestScript).toContain('--out=');
    expect(manifestScript).toContain('--manifest=');
    expect(manifestScript).toMatch(/const MODES = new Set\(\['write', 'verify'\]\)/);
    // Neither one touches `dist`, and neither is a build: they read the tree that
    // the build step already produced.
    for (const script of [PIXI_MEMORY_RECORD_SCRIPT, PIXI_MEMORY_VERIFY_SCRIPT]) {
      for (const forbidden of ['build', 'rm -rf', 'playwright']) {
        expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('pixi memory Playwright config', () => {
  it('binds exactly one project to exactly the new spec', () => {
    const projects = (pixiMemoryConfig.projects ?? []).flat();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe(PIXI_MEMORY_LANE.project);
    expect(project?.use?.browserName).toBe('chromium');
    expect(project?.use?.viewport).toEqual({ ...PIXI_MEMORY_LANE.viewport });
    expect(project?.use?.deviceScaleFactor).toBe(1);
    expect(pixiMemoryConfig.testMatch).toBe(PIXI_MEMORY_TEST_FILE);
    expect(existsSync(path.join(REPO_ROOT, PIXI_MEMORY_TEST_PATH))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, PIXI_MEMORY_CONFIG_FILE))).toBe(true);
    // The lane is Chromium only and says so, so the project must not be a device
    // descriptor that implies a touch platform it does not test.
    expect(project?.use?.hasTouch).toBe(false);
  });

  it('records no raw failure artifact', () => {
    for (const key of ['trace', 'screenshot', 'video'] as const) {
      expect(pixiMemoryConfig.use?.[key], key).toBe('off');
    }
    expect(pixiMemoryConfig.use?.acceptDownloads).toBe(false);
    expect(pixiMemoryConfig.use?.serviceWorkers).toBe('block');
    // One worker: the lane reads counters from one page and previews one port.
    expect(pixiMemoryConfig.workers).toBe(1);
    expect(pixiMemoryConfig.fullyParallel).toBe(false);
  });

  it('previews an existing build on its own port, and never decides to rebuild', () => {
    const webServer = Array.isArray(pixiMemoryConfig.webServer) ? undefined : pixiMemoryConfig.webServer;
    expect(webServer?.command).toBe(PIXI_MEMORY_PREVIEW_SCRIPT);
    expect(webServer?.command).not.toContain('build');
    expect(webServer?.url).toBe(`http://127.0.0.1:${PIXI_MEMORY_PREVIEW_PORT}`);
    expect(pixiMemoryConfig.use?.baseURL).toBe(webServer?.url);
    // Six distinct ports across six lanes, so no two can collide in one worktree.
    const ports = [43173, 43179, 43181, 43183, PIXI_MEMORY_PREVIEW_PORT];
    expect(new Set(ports).size).toBe(ports.length);
    expect(PIXI_MEMORY_PREVIEW_SCRIPT).toContain('strictPort');
    expect(webServer?.reuseExistingServer).toBe(false);
    // This config is not at the repository root, so the preview's working directory
    // has to be stated. Playwright otherwise starts it beside the config and serves
    // a `dist` that is not there.
    expect(webServer?.cwd).toBe(process.cwd());
  });

  it('sits inside a TypeScript project, so the ordinary gate can see it', () => {
    // The reason this config is under `tests/e2e/` and not beside the other four.
    const appTsconfig = JSON.parse(readFileSync(APP_TSCONFIG_PATH, 'utf8')) as {
      include?: readonly string[];
    };
    expect(appTsconfig.include).toContain('tests');
    const relative = path.relative(REPO_ROOT, path.join(REPO_ROOT, PIXI_MEMORY_CONFIG_FILE));
    expect(relative.startsWith('tests/')).toBe(true);
    // And nothing this change owns is missing from the node project, which the
    // four existing configs are listed in. This change does not edit that file, so
    // it asserts the consequence instead: the lane's own declaration module is
    // inside `tests/`, where the app project already reaches it.
    const nodeTsconfig = readFileSync(path.join(REPO_ROOT, 'tsconfig.node.json'), 'utf8');
    expect(nodeTsconfig).toContain('playwright.storage-v2.config.ts');
    expect(nodeTsconfig).not.toContain(PIXI_MEMORY_CONFIG_FILE);
  });

  it('keeps the other five release paths disjoint', () => {
    const defaultProjects = (playwrightConfig.projects ?? []).flat().map((project) => project.name);
    expect(defaultProjects).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    expect(defaultProjects).not.toContain(PIXI_MEMORY_LANE.project);
    for (const project of playwrightConfig.projects ?? []) {
      expect(project.testMatch).not.toBe(PIXI_MEMORY_TEST_FILE);
    }
    expect((storageV2Config.projects ?? []).flat()).toHaveLength(1);
    expect(storageV2Config.testMatch).toBe(STORAGE_V2_TEST_FILE);
    expect((dataProductsConfig.projects ?? []).flat()).toHaveLength(1);
    expect(dataProductsConfig.testMatch).toBe(DATA_PRODUCTS_TEST_FILE);
    expect((subjectConfig.projects ?? []).flat()).toHaveLength(1);
    expect(subjectConfig.testMatch).toBe(SUBJECT_LANE_TEST_FILE);
    expect((reloadConfig.projects ?? []).flat()).toHaveLength(1);
    expect(reloadConfig.testMatch).toBe(RELOAD_LANE_TEST_FILE);
    for (const config of [storageV2Config, dataProductsConfig, subjectConfig, reloadConfig]) {
      for (const project of config.projects ?? []) {
        expect(project.testMatch).not.toBe(PIXI_MEMORY_TEST_FILE);
        expect(project.name).not.toBe(PIXI_MEMORY_LANE.project);
      }
    }
    expect(
      new Set([
        ...defaultProjects,
        'storage-v2-chromium',
        'data-products-restore-chromium',
        SUBJECT_LANE.project,
        RELOAD_LANE.project,
        PIXI_MEMORY_LANE.project,
      ]).size,
    ).toBe(defaultProjects.length + 5);
    // The default `test:e2e` script builds the default artifact and runs only the
    // Phase 1 suite; it cannot reach this spec or this config.
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(PIXI_MEMORY_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(PIXI_MEMORY_CONFIG_FILE);
  });
});

describe('pixi memory CI wiring (ci.yml)', () => {
  const job = ciJobs.get(PIXI_MEMORY_CI_JOB);
  const buildJob = ciJobs.get(PIXI_MEMORY_CI_BUILD_JOB) ?? '';

  it('is three steps in the existing browser-smoke job, after the production suite has run', () => {
    expect(job, `${PIXI_MEMORY_CI_JOB} job is missing from ci.yml`).toBeDefined();
    const body = job ?? '';
    // The one property that makes this lane cheap: the job already installs a browser
    // once, and this change must not add an install. Counted as run steps rather than
    // as the word, because this job's own comments name the property they preserve.
    expect(body).toContain('npx playwright install --with-deps chromium');
    expect([...body.matchAll(/^\s*- run: npx playwright install[^\n]*$/gm)].length).toBe(1);
    // Two downloads, not one and not three: the production artifact this job's first
    // suite certified, and the flagged one this lane measures. Each is a step, so a
    // third download would be a second artifact arriving unannounced.
    expect([...body.matchAll(/^\s*uses: actions\/download-artifact@v4[^\n]*$/gm)].length).toBe(2);
    // Counted as run steps, not as the word: this job's own comments name the
    // property they are preserving, and a comment must not make it look violated.
    expect([...body.matchAll(/^\s*- run: npm ci[^\n]*$/gm)].length).toBe(1);

    for (const stepName of [PIXI_MEMORY_CI_DOWNLOAD_STEP, PIXI_MEMORY_CI_VERIFY_STEP, PIXI_MEMORY_CI_STEP_NAME]) {
      expect(body, stepName).toContain(`name: ${stepName}`);
    }
    // The two jobs name the same artifact, so the download can only be the upload:
    // this is the assertion that replaced a dead comparison against an empty string.
    const download = stepBlockFor(body, PIXI_MEMORY_CI_DOWNLOAD_STEP);
    expect(download).toContain(`name: ${PIXI_MEMORY_CI_UPLOAD_ARTIFACT}`);
    expect(stepBlockFor(buildJob, PIXI_MEMORY_CI_UPLOAD_STEP)).toContain(
      `name: ${PIXI_MEMORY_CI_UPLOAD_ARTIFACT}`,
    );
    expect(download).toMatch(/^\s*uses: actions\/download-artifact@v4$/m);
    expect(body).toContain(PIXI_MEMORY_CI_RUN_COMMAND);

    // Ordering, which is load-bearing. The Phase 1 suite must run against the
    // production artifact *before* the flagged download replaces `dist`, and the lane
    // must run after the download and the identity check.
    const order = [
      'npm run test:e2e:recorded',
      `name: ${PIXI_MEMORY_CI_DOWNLOAD_STEP}`,
      `name: ${PIXI_MEMORY_CI_VERIFY_STEP}`,
      `name: ${PIXI_MEMORY_CI_STEP_NAME}`,
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = body.indexOf(marker);
      expect(at, `${marker} is missing from ${PIXI_MEMORY_CI_JOB}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('the flagged artifact is built once, recorded to its own identity, and uploaded by the build job', () => {
    expect(buildJob, `${PIXI_MEMORY_CI_BUILD_JOB} is missing from ci.yml`).not.toBe('');
    // The Pixi build is already this job's last build step, and it stays there:
    // eleven existing gates assert that no other job runs any `build:web*` script.
    expect(buildJob).toContain(`npm run ${PIXI_MEMORY_BUILD_SCRIPT}`);
    expect(buildJob).toContain('Enforce the renderer memory preflight on the Pixi-flagged artifact');
    // The build job's own recorded contract, asserted the way
    // `tests/phase9/memory-gate-wiring.test.ts` asserts it: as raw text over the whole
    // job, comments included. That gate is not this change's to edit, so this
    // assertion is held to its stricter form rather than to a looser one of its own -
    // which is why the workflow's comment explains the placement without naming the
    // tool whose absence that gate looks for.
    expect(buildJob, 'the build job installs a browser').not.toContain('playwright install');
    expect([...buildJob.matchAll(/^\s*- run: [^\n]*playwright[^\n]*$/gm)]).toEqual([]);
    expect(buildJob).not.toContain(PIXI_MEMORY_CI_RUN_COMMAND);
    expect(buildJob).not.toContain(PIXI_MEMORY_CI_DOWNLOAD_STEP);
    // Recorded and verified in the same job that built it, so the identity is
    // satisfiable there, and uploaded with its own manifest.
    expect(stepBlockFor(buildJob, 'Record the Pixi-flagged artifact identity')).toContain(
      `run: npm run ${PIXI_MEMORY_RECORD_SCRIPT}`,
    );
    expect(stepBlockFor(buildJob, PIXI_MEMORY_CI_VERIFY_STEP)).toContain(
      `run: npm run ${PIXI_MEMORY_VERIFY_SCRIPT}`,
    );
    const upload = stepBlockFor(buildJob, PIXI_MEMORY_CI_UPLOAD_STEP);
    expect(upload).toContain(`name: ${PIXI_MEMORY_CI_UPLOAD_ARTIFACT}`);
    expect(upload).toContain(PIXI_MEMORY_MANIFEST_PATH);
    expect(upload).toContain('dist');
    // One artifact more than the release, not one *instead* of it, and the set of
    // uploads is pinned exactly: build metadata, the release artifact, and the
    // flagged one. A fourth upload would be a second production artifact.
    const uploadStepNames = [
      ...buildJob.matchAll(/- name: ([^\n]+)\n\s+uses: actions\/upload-artifact@v4/g),
    ].map((match) => match[1]?.trim());
    expect(uploadStepNames).toEqual([
      'Upload build metadata',
      'Upload the shared production web artifact',
      PIXI_MEMORY_CI_UPLOAD_STEP,
    ]);
    // And the release identity is still recorded and uploaded exactly once, so a
    // flagged upload can never be read as the release.
    expect(ciWorkflow.split('Upload the shared production web artifact').length - 1).toBe(1);
  });

  it('GATES: the lane step must not be exempt, and no step in the job may be', () => {
    const body = ciJobs.get(PIXI_MEMORY_CI_JOB) ?? '';
    const step = stepBlockFor(body, PIXI_MEMORY_CI_STEP_NAME);
    expect(step).toContain(PIXI_MEMORY_CI_RUN_COMMAND);
    expect(step).not.toContain('continue-on-error');
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('exit 0');
    // Matched as a YAML key at the start of a line, so prose that discusses the
    // exemption deliberately - here, and in the workflow's own comments - is not
    // counted as one.
    const exemptionKeys = [...body.matchAll(/^\s*continue-on-error\s*:/gm)].length;
    expect(exemptionKeys, 'a step in the browser-smoke job is exempt from failing').toBe(0);
    expect(body).not.toMatch(/continue-on-error/);
  });

  it('the lane step previews and measures, and neither builds nor downloads', () => {
    const body = ciJobs.get(PIXI_MEMORY_CI_JOB) ?? '';
    const step = stepBlockFor(body, PIXI_MEMORY_CI_STEP_NAME);
    expect(step).not.toContain('npm run build:');
    expect(step).not.toContain('record:web-artifact');
    expect(step).not.toContain('web-artifact-manifest');
    expect(step).not.toContain('download-artifact');
    expect(step).toContain(PIXI_MEMORY_CI_RUN_COMMAND);
    // The step runs the same npm script a person runs, so the command CI executes
    // and the command this file asserts are one string rather than two.
    expect(PIXI_MEMORY_CI_RUN_COMMAND).toBe(`npm run ${PIXI_MEMORY_CI_RUN_SCRIPT}`);
    expect(npmScripts[PIXI_MEMORY_CI_RUN_SCRIPT]).toBe(PIXI_MEMORY_PLAYWRIGHT_COMMAND);
  });

  it('uploads sanitized JSON evidence only, and never a report, trace or results tree', () => {
    const body = ciJobs.get(PIXI_MEMORY_CI_JOB) ?? '';
    const upload = stepBlockFor(body, 'Upload sanitized browser-smoke evidence');
    expect(upload).toContain('path: artifacts/compatibility-evidence');
    expect(upload).toContain('if: always()');
    // The allowlist is the whole of the path. The lane writes its own results and
    // HTML report directories deliberately outside it, so this job's pre-existing
    // failure upload is the only other thing that could carry one, and it names
    // neither of them.
    for (const forbidden of ['playwright-report', 'test-results', 'trace', 'screenshot', 'video']) {
      expect(upload, forbidden).not.toContain(forbidden);
    }
    const failureUpload = stepBlockFor(body, 'Upload browser failure evidence');
    for (const dir of ['artifacts/pixi-memory-test-results', 'artifacts/playwright-pixi-memory-report']) {
      expect(body, `${dir} is uploaded somewhere in this job`).not.toContain(dir);
    }
    expect(failureUpload).toContain('if: failure()');
  });

  it('leaves the single production build job, the flagged-build job, and the four compatibility lanes alone', () => {
    // Matched as a whole `run:` line, so a *flagged* build is not mistaken for the
    // production build this assertion is about. The `storage-v2-browser` job has
    // always run its own flagged build; what must stay unique is the production one.
    const buildJobs = [...ciJobs.entries()].filter(([, body]) =>
      /^\s+- run: npm run build:web$/m.test(body),
    );
    expect(buildJobs.map(([name]) => name)).toEqual([PIXI_MEMORY_CI_BUILD_JOB]);
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);
    // The flagged-build job is untouched by this change: one build, one record, one
    // verify, one upload, four lanes.
    const flagged = ciJobs.get('storage-v2-browser') ?? '';
    expect(flagged).not.toContain(PIXI_MEMORY_CI_RUN_COMMAND);
    expect(flagged).not.toContain(PIXI_MEMORY_CI_DOWNLOAD_STEP);
    expect(flagged.split('npm run build:storage-v2-data-products').length - 1).toBe(1);
    expect(flagged.split('actions/upload-artifact@v4').length - 1).toBe(1);
    // The four build-level Pixi steps in the build job are untouched: this lane is
    // browser-backed evidence, and the preflight there is not it.
    expect(buildJob).toContain('Enforce the renderer memory preflight on the built artifact');
    expect(buildJob).toContain('Enforce the renderer memory preflight on the Pixi-flagged artifact');
  });
});

describe('pixi memory spec', () => {
  const spec = readFileSync(path.join(REPO_ROOT, PIXI_MEMORY_TEST_PATH), 'utf8');

  it('drives the twenty cycles, through the measurement module, not inline', () => {
    // The property that distinguishes the lane. A spec that never cycles would be
    // green against the defect this lane exists for.
    expect(spec).toContain('PIXI_MEMORY_CYCLES');
    expect(spec).toContain('for (let cycle = 0; cycle <= PIXI_MEMORY_CYCLES; cycle += 1)');
    // ...and the verdict comes from the module that is unit-tested for its teeth,
    // so a failing run's reason is a decision rather than an inline comparison.
    expect(spec).toContain('evaluatePixiMemoryRun');
    expect(spec).toContain('evaluateIdleGrowth');
    expect(spec).toContain('PIXI_MEMORY_LANE.doesNotProve');
  });

  it('has seen itself fail, on a mount path that deliberately does not tear down', () => {
    // A gate nobody has seen fail is a gate nobody should trust, and a browser
    // cannot be asked to produce a leaking series on demand. So the lane produces one
    // itself, in a real engine, and reads the verdict off the same function the
    // twenty-cycle test uses. The two properties that make it a proof rather than a
    // second opinion: the "previous canvas" it hands the verdict is the real canvas
    // handle from the real page, and the non-empty expectation is on the finding
    // codes, so a future change to the series module cannot quietly make it vacuous.
    expect(spec).toContain('a cycle that never remounts the world is reported as retained');
    // The "previous canvas" handed to the second sample must be `second.previous` —
    // the reading the second `readPage` took of the first cycle's canvas. It was
    // `first.reading.previous` until Phase 9 review, and that value is null *by
    // construction*: `first` is the one read made with a null previous canvas, so the
    // verdict function skipped both retention findings and emitted
    // `previous-canvas-unread` instead. The lane could not pass, and no host could
    // have satisfied it. Pinned here in both directions, because this gate previously
    // asserted the *broken* expression as source text and so held the defect in place.
    expect(spec).toContain('toSample(1, second, second.previous)');
    expect(spec).not.toContain('toSample(1, second, first.reading.previous)');
    expect(spec).not.toContain('first.reading.previous');
    // Matched across a line break rather than against one exact wrapping, so a
    // reflow of the message cannot silently un-hold the assertion.
    expect(spec).toMatch(/codes,[\s\S]{0,240}?\)\.not\.toEqual\(\[\]\);/);
    for (const code of ['cycle-did-not-remount', 'retained-canvas', 'retained-webgl-context']) {
      expect(spec, code).toContain(code);
    }
    // And it is a pass-through, not a shadow verdict: the same import, called with
    // the same module the twenty-cycle test calls.
    expect(spec.match(/evaluatePixiMemoryRun\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('asserts the ResizeObserver precondition rather than hoping for it', () => {
    expect(spec).toContain('resizeObserverAtApplicationInit');
    expect(spec).toContain('__PIXI_APP_INIT__');
    // The diagnostic that states the boundary instead of hiding it.
    expect(spec).toContain('removing ResizeObserver changes no counter this lane can read');
    expect(spec).toContain('dropResizeObserver: true');
    // ...and the non-vacuity control that the first run of this lane was missing: a
    // global that exists is a precondition of nothing unless a renderer was actually
    // created from it, and this test read the global on a world that never mounted.
    expect(spec).toMatch(
      /expect\(\s*presented,[\s\S]{0,200}?The precondition has to be observed on a world that actually mounted\.[\s\S]{0,40}?\)\.toBe\(true\);/,
    );
  });

  it('measures the DOM mirror in a way jsdom cannot, and the reduced motion in a real engine', () => {
    expect(spec).toContain('getBoundingClientRect');
    expect(spec).toContain('MINIMUM_TOUCH_TARGET_PX');
    expect(spec).toContain("page.keyboard.press('Tab')");
    expect(spec).toContain('emulateMedia({ reducedMotion');
    expect(spec).toContain('page.screenshot');
    // A locator screenshot would make the measurement depend on the element being
    // still, which is a different question from the one being asked.
    expect(spec).not.toContain('locator(\'canvas\').first().screenshot');
  });

  it('verifies the recorded artifact before it measures anything, and does not skip a missing one', () => {
    // The stance `scripts/check-welcome-budget.mjs` takes, and this lane takes with
    // it: a gate that reports success because it measured nothing is the failure it
    // exists to prevent. A missing recorded identity is a failure, not a skip, and
    // there is no conditional skip in the spec at all.
    expect(spec).toContain('web-artifact-manifest.mjs');
    expect(spec).toContain('PIXI_MEMORY_MANIFEST_PATH');
    expect(spec).toContain(").toBe('match')");
    expect(spec).not.toContain('test.skip');
    expect(spec).not.toContain('test.fixme');
    expect(spec).not.toMatch(/\.catch\(\(\) => null\);\s*\n\s*expect\(true\)/);
  });

  it('keeps the privacy discipline: synthetic fixtures, no egress, sanitized evidence', () => {
    // The only two `catch`s in the spec must both feed an assertion, not a skip.
    expect(spec.match(/\.catch\(/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(spec).toContain('sanitizeToolchainText');
    expect(spec).toContain('sanitizeRunnerImageLabel');
    expect(spec).toContain('evidenceRelativePath');
    // No learner data, no request bodies, no external host, no full URLs recorded.
    // The lane drives the application's own synthetic tutorial subject and reads
    // no storage key of its own, so no learner-shaped field is named at all.
    for (const field of ['subjectName', 'rootTopic', 'dungeonId', 'email', 'password', 'Authorization']) {
      expect(spec, field).not.toContain(field);
    }
    expect(spec).not.toContain('request.postData');
    expect(spec).not.toContain('route.fulfill');
    expect(spec).not.toContain('http://');
    expect(spec).not.toContain('https://');
    // Every non-loopback origin is aborted before the application runs, exactly as
    // `currentBuild.spec.ts` does, so a privacy regression is still observed.
    expect(spec).toContain("url.hostname !== '127.0.0.1'");
    expect(spec).toContain("route.abort('blockedbyclient')");
  });

  it('is hermetic: no commit lookups, and no path that depends on where the checkout lives', () => {
    // The defect class `tests/phase8/qa-hermeticity.test.ts` records: a gate whose
    // verdict depends on the state or the location of the checkout. This lane's own
    // files must not repeat it.
    const mine = [PIXI_MEMORY_TEST_PATH, PIXI_MEMORY_CONFIG_FILE, 'tests/e2e/pixi-memory-lane.ts', 'tests/e2e/pixi-memory-series.ts'];
    for (const relative of mine) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, `${relative} resolves a commit`).not.toMatch(/\bgit\s+(?:show|log|diff|cat-file|rev-parse|ls-tree|rev-list)\b/);
      // `process.cwd()` is fine: every path built from it in this lane is joined
      // with a repository-relative segment, so no absolute path reaches an
      // assertion message or an evidence file.
      expect(source, `${relative} embeds an absolute path literal`).not.toMatch(/['"`]\/(?:home|tmp|Users|var)\//);
    }
    // The evidence path comes from the shared helper, which is relative by
    // construction, and the only filesystem paths the spec reads are inside the
    // repository it is running in.
    expect(spec).toContain('path.join(REPO_ROOT, relativePath)');
    expect(spec).not.toContain('process.env.HOME');
    expect(spec).not.toContain('os.homedir');
  });
});
