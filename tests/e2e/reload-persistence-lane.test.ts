/**
 * Reload-persistence lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. The same properties the Phase 5 and
 * Phase 6 wiring gates hold, restated for this lane, plus the two that are
 * specific to it:
 *
 * 1. The lane declaration is internally consistent, claims a bounded scope, and
 *    says out loud what it does not prove.
 * 2. The Playwright config binds exactly one project to exactly the new spec,
 *    previews an existing build on its own port, and never decides to rebuild.
 * 3. **Five release paths stay disjoint.** The default config, the Phase 4, Phase 5
 *    and Phase 6 configs, and this one each bind their own spec, so `npm run
 *    test:e2e` cannot reach this spec and no existing lane is widened.
 * 4. The package scripts build nothing here and record nothing here.
 * 5. The CI wiring is a gating step inside the existing `storage-v2-browser` job,
 *    so the flagged artifact is built exactly once and the "exactly one job runs
 *    the production web build" and "exactly four pull-request compatibility lanes"
 *    assertions are untouched.
 * 6. **The spec reloads.** This is the property that distinguishes the lane, so it
 *    is asserted mechanically rather than trusted: a spec that never reloads would
 *    be green against the defect this lane exists for, because every assertion in
 *    it would be made about the generation the write is in - which is precisely how
 *    two accepted phases missed it.
 * 7. **The spec asserts the pointer, not only the records.** A subject count read
 *    from the active generation cannot see a generation that was superseded; a
 *    pointer that did not move can.
 *
 * Plus the non-vacuity property that makes the reload assertions mean anything:
 * the spec asserts a subject is listed with the row the application itself
 * derived from the subject's snapshot, so "still listed" is a read rather than a
 * name that survived in some cache.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import dataProductsConfig from '../../playwright.data-products.config';
import subjectConfig from '../../playwright.subject-product.config';
import reloadConfig from '../../playwright.reload-persistence.config';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX } from './support-matrix';
import { STORAGE_V2_LANE, STORAGE_V2_STORAGE_CONTRACT, STORAGE_V2_TEST_FILE } from './storage-v2-lane';
import { DATA_PRODUCTS_TEST_FILE } from './data-products-lane';
import { SUBJECT_LANE, SUBJECT_LANE_TEST_FILE } from './subject-product-lane';
import {
  RELOAD_LANE,
  RELOAD_LANE_CI_JOB,
  RELOAD_LANE_CI_STEP_NAME,
  RELOAD_LANE_CONFIG_FILE,
  RELOAD_LANE_OWNER_FLAG,
  RELOAD_LANE_PREVIEW_COMMAND,
  RELOAD_LANE_PREVIEW_PORT,
  RELOAD_LANE_PREVIEW_SCRIPT,
  RELOAD_LANE_SCRIPTS,
  RELOAD_LANE_SUPERSET_BUILD_SCRIPT,
  RELOAD_LANE_TEST_FILE,
  RELOAD_LANE_TEST_PATH,
  validateReloadLane,
} from './reload-persistence-lane';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

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

function stepBlockFor(jobBody: string): string {
  const index = jobBody.indexOf(`name: ${RELOAD_LANE_CI_STEP_NAME}`);
  if (index === -1) throw new Error(`The job has no step named ${RELOAD_LANE_CI_STEP_NAME}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

describe('reload-persistence lane declaration', () => {
  it('is internally consistent and claims its own bounded scope', () => {
    expect(validateReloadLane()).toEqual([]);
    expect(RELOAD_LANE.sharesArtifactWith).toBe('phase-4-storage-v2-flagged-build');
    expect(RELOAD_LANE.acceptDownloads).toBe(true);
    expect(RELOAD_LANE.claim.length).toBeGreaterThan(120);
    expect(RELOAD_LANE.doesNotProve.length).toBeGreaterThanOrEqual(6);
    expect(RELOAD_LANE.dataProductsV2).toBe(true);
    expect(RELOAD_LANE.storageRepository).toBe('v2');
    // The lane says out loud that it is not an egress result and not a
    // replace-fidelity result, so a reader cannot mistake it for either.
    expect(RELOAD_LANE.doesNotProve.join(' ')).toMatch(/egress/i);
    expect(RELOAD_LANE.doesNotProve.join(' ')).toMatch(/replace-fidelity/i);
  });

  it('previews the same flagged artifact identity the other flagged lanes name', () => {
    expect(RELOAD_LANE.buildMode).toBe(STORAGE_V2_LANE.buildMode);
    expect(RELOAD_LANE.envFile).toBe(STORAGE_V2_LANE.envFile);
    expect(RELOAD_LANE.manifestPath).toBe(STORAGE_V2_LANE.manifestPath);
    expect(RELOAD_LANE.supersetBuildScript).toBe('build:storage-v2-data-products');
    expect(existsSync(path.join(REPO_ROOT, RELOAD_LANE.envFile))).toBe(true);
  });

  it('the owner flag is the plan\'s flag, default-off, and this lane turns it on', () => {
    expect(RELOAD_LANE_OWNER_FLAG).toBe('VITE_DATA_PRODUCTS_V2');
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe(RELOAD_LANE_OWNER_FLAG);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    expect(RELOAD_LANE.dataProductsV2).toBe(true);
  });
});

describe('reload-persistence Playwright config', () => {
  it('binds exactly one project to exactly the new spec', () => {
    const projects = (reloadConfig.projects ?? []).flat();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe(RELOAD_LANE.project);
    expect(project?.use?.browserName).toBe('chromium');
    expect(project?.use?.viewport).toEqual({ ...RELOAD_LANE.viewport });
    expect(project?.use?.acceptDownloads).toBe(true);
    expect(reloadConfig.use?.acceptDownloads).toBe(true);
    for (const key of ['trace', 'screenshot', 'video'] as const) {
      expect(reloadConfig.use?.[key]).toBe('off');
    }
    expect(reloadConfig.testMatch).toBe(RELOAD_LANE_TEST_FILE);
    expect(existsSync(path.join(REPO_ROOT, RELOAD_LANE_TEST_PATH))).toBe(true);
  });

  it('previews an existing build on its own port, and never decides to rebuild', () => {
    const webServer = Array.isArray(reloadConfig.webServer) ? undefined : reloadConfig.webServer;
    expect(webServer?.command).toBe(RELOAD_LANE_PREVIEW_COMMAND);
    expect(webServer?.command).not.toContain('build');
    expect(webServer?.url).toBe(`http://127.0.0.1:${RELOAD_LANE_PREVIEW_PORT}`);
    expect(RELOAD_LANE_PREVIEW_PORT).toBe(43183);
    // Five distinct ports across five lanes, so no two can collide in one worktree.
    const ports = [43173, 43179, 43181, RELOAD_LANE_PREVIEW_PORT];
    expect(new Set(ports).size).toBe(ports.length);
    expect(npmScripts[RELOAD_LANE_PREVIEW_SCRIPT]).toContain('43183');
    expect(npmScripts[RELOAD_LANE_PREVIEW_SCRIPT]).toContain('strictPort');
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(reloadConfig.use?.serviceWorkers).toBe('block');
  });

  it('keeps the other four release paths disjoint', () => {
    const defaultProjects = (playwrightConfig.projects ?? []).flat().map((project) => project.name);
    expect(defaultProjects).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    // The support matrix is the *only* list of Playwright projects, and this lane
    // is not in it: the matrix is the approved cross-engine and viewport matrix,
    // and a project added to it would claim support dimensions this lane does not
    // have. Five configs, five project names, five spec files.
    expect(defaultProjects).not.toContain(RELOAD_LANE.project);
    for (const project of playwrightConfig.projects ?? []) {
      expect(project.testMatch).not.toBe(RELOAD_LANE_TEST_FILE);
    }
    // Phase 4: one project, one testMatch, still its spec.
    expect((storageV2Config.projects ?? []).flat()).toHaveLength(1);
    expect(storageV2Config.testMatch).toBe(STORAGE_V2_TEST_FILE);
    // Phase 5 and Phase 6: same.
    expect((dataProductsConfig.projects ?? []).flat()).toHaveLength(1);
    expect(dataProductsConfig.testMatch).toBe(DATA_PRODUCTS_TEST_FILE);
    expect((subjectConfig.projects ?? []).flat()).toHaveLength(1);
    expect(subjectConfig.testMatch).toBe(SUBJECT_LANE_TEST_FILE);
    for (const config of [storageV2Config, dataProductsConfig, subjectConfig]) {
      for (const project of config.projects ?? []) {
        expect(project.testMatch).not.toBe(RELOAD_LANE_TEST_FILE);
        expect(project.name).not.toBe(RELOAD_LANE.project);
      }
    }
    expect(
      new Set([
        ...defaultProjects,
        STORAGE_V2_LANE.project,
        'data-products-restore-chromium',
        SUBJECT_LANE.project,
        RELOAD_LANE.project,
      ]).size,
    ).toBe(defaultProjects.length + 4);
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(RELOAD_LANE_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(RELOAD_LANE_CONFIG_FILE);
  });
});

describe('reload-persistence package scripts', () => {
  it('the recorded script previews only, and the full script delegates the shared build', () => {
    const recorded = npmScripts[RELOAD_LANE_SCRIPTS.recorded];
    expect(recorded).toBe(`playwright test --config=${RELOAD_LANE_CONFIG_FILE}`);
    expect(recorded).not.toContain('build');
    expect(recorded).not.toContain('record');
    expect(npmScripts['test:e2e:reload-persistence']).toBe(recorded);

    const full = npmScripts[RELOAD_LANE_SCRIPTS.full];
    expect(full).toContain(`npm run ${RELOAD_LANE_SUPERSET_BUILD_SCRIPT}`);
    expect(full).toContain('npm run record:web-artifact:storage-v2');
    expect(full).toContain(`playwright test --config=${RELOAD_LANE_CONFIG_FILE}`);
    expect(full).not.toContain('build:web');
    expect(full).not.toMatch(/^\s*VITE_DATA_PRODUCTS_V2=/m);

    // The four pre-existing lane scripts are unchanged.
    expect(npmScripts['test:e2e:storage:recorded']).toBe(
      'playwright test --config=playwright.storage-v2.config.ts',
    );
    expect(npmScripts['test:e2e:data-products:recorded']).toBe(
      'playwright test --config=playwright.data-products.config.ts',
    );
    expect(npmScripts['test:e2e:subject-product:recorded']).toBe(
      'playwright test --config=playwright.subject-product.config.ts',
    );
  });

  it('the spec reloads, and asserts the pointer rather than only the records', () => {
    const spec = readFileSync(path.join(REPO_ROOT, RELOAD_LANE_TEST_PATH), 'utf8');
    // The property that distinguishes this lane. A spec without a reload would be
    // green against the defect: every assertion in it would be made about the
    // generation the write is in, which is how two accepted phases missed it.
    expect(spec).toContain('page.reload()');
    // ...and the pointer, which a superseded generation cannot satisfy. A subject
    // count read from the active generation cannot see the defect at all.
    expect(spec).toContain('activeGenerationId');
    expect(spec).toContain('the pointer moved on a reload');
    // The generation's *status* is read, not just its record count: the defect is
    // the generation the write was in ceasing to be the one in use.
    expect(spec).toContain('superseded');
    expect(spec).toContain('generationStatus');
    // One reload is one boot; the failure mode was a boot-time re-migration, so at
    // least one test asks twice.
    expect(spec.match(/await reloadApplication\(page\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Every interaction pattern in the declaration is *referenced* by the spec, so
    // the declaration cannot drift into naming controls the lane never touches. The
    // spec must go through the declaration rather than restating a pattern, or the
    // two would be free to disagree.
    for (const name of Object.keys(RELOAD_LANE.interactionContract)) {
      expect(spec, `the spec never uses interactionContract.${name}`).toContain(
        `interactionContract.${name}`,
      );
    }
    // The three products are each driven for real, from the product's own controls.
    for (const product of ['.kdtemplate', '.kdsubject', '.kdbak']) {
      expect(spec, product).toContain(product);
    }
    // The lane must not reach into the application's module graph at runtime, and
    // must not stub anything: there is no `page.route` in it at all, because it
    // makes no network claim of its own.
    expect(spec).not.toContain("@/services/persistence/v2/schema");
    expect(spec).not.toContain("@/services/persistence/products/");
    expect(spec).not.toContain('route.fulfill');
    expect(spec).not.toContain('route.continue');
    expect(spec).not.toContain('addInitScript');
  });

  it('the storage contract the probe reads is the real one', async () => {
    // The probe names the database, the meta store, the pointer owner, the subject
    // store, the receipts store, and the generation-key prefix. If any of those
    // drifted from the application's own constants, every storage assertion in the
    // lane would report "nothing here" instead of failing, so they are pinned
    // against the real module.
    const schema = readFileSync(
      path.join(REPO_ROOT, 'src/services/persistence/v2/schema.ts'),
      'utf8',
    );
    expect(schema).toContain(`'${STORAGE_V2_STORAGE_CONTRACT.subjectsStore}'`);
    expect(schema).toContain(`'${STORAGE_V2_STORAGE_CONTRACT.migrationReceiptsStore}'`);
    const storageConstants = await import('@/services/persistence/v2/schema');
    expect(storageConstants.STORAGE_V2_DATABASE_NAME).toBe(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(storageConstants.ACTIVE_GENERATION_META_OWNER).toBe(
      STORAGE_V2_STORAGE_CONTRACT.activeGenerationOwner,
    );
    expect(storageConstants.ACTIVE_GENERATION_META_KEY).toBe(
      STORAGE_V2_STORAGE_CONTRACT.activeGenerationKey,
    );
    expect(storageConstants.GENERATION_META_KEY_PREFIX).toBe(
      STORAGE_V2_STORAGE_CONTRACT.generationKeyPrefix,
    );
    expect(storageConstants.STORAGE_V2_STORE_NAMES).toContain(
      STORAGE_V2_STORAGE_CONTRACT.migrationReceiptsStore,
    );
  });
});

describe('reload-persistence CI wiring (ci.yml)', () => {
  it('runs as a gating step inside the existing flagged-build job, on the same host', () => {
    const body = ciJobs.get(RELOAD_LANE_CI_JOB);
    expect(body, `${RELOAD_LANE_CI_JOB} job is missing from ci.yml`).toBeDefined();
    const job = body ?? '';
    expect(job).toContain('runs-on: ubuntu-latest');
    expect(job).toContain('npx playwright install --with-deps chromium');
    expect(job).toContain(RELOAD_LANE_CI_STEP_NAME);
    expect(job).toContain(`npm run ${RELOAD_LANE_SCRIPTS.recorded}`);
    // The single-build property: the superset build still runs exactly once for all
    // four flagged lanes, and the product-free Phase 4 build never runs in CI.
    expect(job.split(`npm run ${RELOAD_LANE_SUPERSET_BUILD_SCRIPT}`).length - 1).toBe(1);
    expect(job).not.toContain('npm run build:storage-v2-flagged');
    expect(job.split('npm run record:web-artifact:storage-v2').length - 1).toBe(1);
    expect(job.split('npm run verify:web-artifact:storage-v2').length - 1).toBe(1);
    // The step itself neither builds nor records.
    const step = stepBlockFor(job);
    expect(step).not.toContain(`npm run ${RELOAD_LANE_SUPERSET_BUILD_SCRIPT}`);
    expect(step).not.toContain('npm run record:');
    expect(step).not.toContain('npm run build:');
    expect(step).toContain(`npm run ${RELOAD_LANE_SCRIPTS.recorded}`);
  });

  it('GATES: the step must not be exempt, and no step in the job may be', () => {
    const body = ciJobs.get(RELOAD_LANE_CI_JOB) ?? '';
    const step = stepBlockFor(body);
    expect(step).toContain(`npm run ${RELOAD_LANE_SCRIPTS.recorded}`);
    expect(step).not.toContain('continue-on-error');
    // Matched as a YAML key at the start of a line, so the prose that discusses the
    // exemption deliberately - in this file and in the workflow's own comments - is
    // not counted as one.
    const exemptionKeys = [...body.matchAll(/^\s*continue-on-error\s*:/gm)].length;
    expect(exemptionKeys, 'a step in the flagged-build job is exempt from failing').toBe(0);
  });

  it('leaves the single production build job and the four compatibility lanes alone', () => {
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(buildJobs.map(([name]) => name)).toEqual(['web-build']);
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);
    const body = ciJobs.get(RELOAD_LANE_CI_JOB) ?? '';
    // One upload, evidence only, and none of this lane's raw artifacts.
    expect(body.split('actions/upload-artifact@v4').length - 1).toBe(1);
    expect(body).toContain('path: artifacts/compatibility-evidence');
    for (const forbidden of [
      'artifacts/playwright-reload-persistence-report',
      'artifacts/reload-persistence-test-results',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});
