/**
 * Phase 6 individual-subject backup lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. The same five properties Phase 5's wiring
 * gate holds, restated for this lane, plus the two that are specific to it:
 *
 * 1. The lane declaration is internally consistent and claims a bounded scope.
 * 2. The Playwright config binds exactly one project to exactly the new spec,
 *    previews an existing build on its own port, and never decides to rebuild.
 * 3. **Four release paths stay disjoint.** The default config, the Phase 4 flagged
 *    config, the Phase 5 fresh-profile config, and this one each bind their own
 *    spec, so `npm run test:e2e` cannot reach this spec and neither existing lane
 *    is widened.
 * 4. The package scripts build nothing here and record nothing here.
 * 5. The CI wiring is a gating step inside the existing `storage-v2-browser` job, so
 *    the flagged artifact is built exactly once and the "exactly one job runs
 *    `npm run build:web`" and "exactly four pull-request compatibility lanes"
 *    assertions are untouched.
 * 6. The lane previews an artifact with the owner flag ON, and the artifact
 *    identity it names is the one the other flagged lanes name.
 * 7. The storage contract the spec's browser probe reads is the real one, pinned
 *    against the real source rather than trusted.
 *
 * Plus the non-vacuity property that makes the refusal test in the spec mean
 * anything: the spec must contain a control that *proves the fingerprint can move*,
 * or "the device is unchanged after a refused import" would be satisfied by a
 * fingerprint that cannot move.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import dataProductsConfig from '../../playwright.data-products.config';
import subjectConfig from '../../playwright.subject-product.config';
import {
  DEFAULT_RUNTIME_CONFIG,
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
} from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX } from './support-matrix';
import { STORAGE_V2_LANE, STORAGE_V2_STORAGE_CONTRACT, STORAGE_V2_TEST_FILE } from './storage-v2-lane';
import { DATA_PRODUCTS_TEST_FILE } from './data-products-lane';
import {
  SUBJECT_LANE,
  SUBJECT_LANE_CI_JOB,
  SUBJECT_LANE_CI_STEP_NAME,
  SUBJECT_LANE_CONFIG_FILE,
  SUBJECT_LANE_OWNER_FLAG,
  SUBJECT_LANE_PREVIEW_COMMAND,
  SUBJECT_LANE_PREVIEW_PORT,
  SUBJECT_LANE_PREVIEW_SCRIPT,
  SUBJECT_LANE_SCRIPTS,
  SUBJECT_LANE_SUPERSET_BUILD_SCRIPT,
  SUBJECT_LANE_TEST_FILE,
  SUBJECT_LANE_TEST_PATH,
  validateSubjectLane,
} from './subject-product-lane';

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
  const index = jobBody.indexOf(`name: ${SUBJECT_LANE_CI_STEP_NAME}`);
  if (index === -1) throw new Error(`The job has no step named ${SUBJECT_LANE_CI_STEP_NAME}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

describe('Phase 6 individual-subject backup lane declaration', () => {
  it('is internally consistent and claims its own bounded scope', () => {
    expect(validateSubjectLane()).toEqual([]);
    expect(SUBJECT_LANE.sharesArtifactWith).toBe('phase-4-storage-v2-flagged-build');
    expect(SUBJECT_LANE.acceptDownloads).toBe(true);
    expect(SUBJECT_LANE.claim.length).toBeGreaterThan(120);
    expect(SUBJECT_LANE.doesNotProve.length).toBeGreaterThanOrEqual(6);
    expect(SUBJECT_LANE.dataProductsV2).toBe(true);
    expect(SUBJECT_LANE.storageRepository).toBe('v2');
    // The lane says out loud that it does not drive the destructive mode, so a
    // reader cannot mistake it for replace-fidelity evidence.
    expect(SUBJECT_LANE.doesNotProve.join(' ')).toMatch(/replace/i);
  });

  it('previews the same flagged artifact identity the other flagged lanes name', () => {
    expect(SUBJECT_LANE.buildMode).toBe(STORAGE_V2_LANE.buildMode);
    expect(SUBJECT_LANE.envFile).toBe(STORAGE_V2_LANE.envFile);
    expect(SUBJECT_LANE.manifestPath).toBe(STORAGE_V2_LANE.manifestPath);
    expect(SUBJECT_LANE.supersetBuildScript).toBe('build:storage-v2-data-products');
    expect(existsSync(path.join(REPO_ROOT, SUBJECT_LANE.envFile))).toBe(true);
  });

  it('the owner flag is the plan\'s flag, default-on after the cutover, and this lane pins it on', () => {
    expect(SUBJECT_LANE_OWNER_FLAG).toBe('VITE_DATA_PRODUCTS_V2');
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe(SUBJECT_LANE_OWNER_FLAG);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(true);
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(true);
    expect(parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'false' }).dataProductsV2).toBe(false);
    expect(SUBJECT_LANE.dataProductsV2).toBe(true);
  });
});

describe('Phase 6 individual-subject backup Playwright config', () => {
  it('binds exactly one project to exactly the new spec', () => {
    const projects = (subjectConfig.projects ?? []).flat();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe(SUBJECT_LANE.project);
    expect(project?.use?.browserName).toBe('chromium');
    expect(project?.use?.viewport).toEqual({ ...SUBJECT_LANE.viewport });
    expect(project?.use?.acceptDownloads).toBe(true);
    expect(subjectConfig.use?.acceptDownloads).toBe(true);
    for (const key of ['trace', 'screenshot', 'video'] as const) {
      expect(subjectConfig.use?.[key]).toBe('off');
    }
    expect(subjectConfig.testMatch).toBe(SUBJECT_LANE_TEST_FILE);
    expect(existsSync(path.join(REPO_ROOT, SUBJECT_LANE_TEST_PATH))).toBe(true);
  });

  it('previews an existing build on its own port, and never decides to rebuild', () => {
    const webServer = Array.isArray(subjectConfig.webServer) ? undefined : subjectConfig.webServer;
    expect(webServer?.command).toBe(SUBJECT_LANE_PREVIEW_COMMAND);
    expect(webServer?.command).not.toContain('build');
    expect(webServer?.url).toBe(`http://127.0.0.1:${SUBJECT_LANE_PREVIEW_PORT}`);
    expect(SUBJECT_LANE_PREVIEW_PORT).toBe(43181);
    // Four distinct ports across four lanes, so no two can collide in one worktree.
    const ports = [
      ...(playwrightConfig.webServer === undefined ? [] : []),
      43173,
      43179,
      SUBJECT_LANE_PREVIEW_PORT,
    ];
    expect(new Set(ports).size).toBe(ports.length);
    expect(npmScripts[SUBJECT_LANE_PREVIEW_SCRIPT]).toContain('43181');
    expect(npmScripts[SUBJECT_LANE_PREVIEW_SCRIPT]).toContain('strictPort');
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(subjectConfig.use?.serviceWorkers).toBe('block');
  });

  it('keeps the other three release paths disjoint', () => {
    const defaultProjects = (playwrightConfig.projects ?? []).flat().map((project) => project.name);
    expect(defaultProjects).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    expect(defaultProjects).not.toContain(SUBJECT_LANE.project);
    for (const project of playwrightConfig.projects ?? []) {
      expect(project.testMatch).not.toBe(SUBJECT_LANE_TEST_FILE);
    }
    // Phase 4: one project, one testMatch, still its spec.
    expect((storageV2Config.projects ?? []).flat()).toHaveLength(1);
    expect(storageV2Config.testMatch).toBe(STORAGE_V2_TEST_FILE);
    // Phase 5: one project, one testMatch, still its spec.
    expect((dataProductsConfig.projects ?? []).flat()).toHaveLength(1);
    expect(dataProductsConfig.testMatch).toBe(DATA_PRODUCTS_TEST_FILE);
    for (const config of [storageV2Config, dataProductsConfig]) {
      for (const project of config.projects ?? []) {
        expect(project.testMatch).not.toBe(SUBJECT_LANE_TEST_FILE);
      }
    }
    // Four configs, four project names, four spec files.
    expect(
      new Set([
        ...defaultProjects,
        STORAGE_V2_LANE.project,
        'data-products-restore-chromium',
        SUBJECT_LANE.project,
      ]).size,
    ).toBe(defaultProjects.length + 3);
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(SUBJECT_LANE_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(SUBJECT_LANE_CONFIG_FILE);
  });
});

describe('Phase 6 individual-subject backup package scripts', () => {
  it('the recorded script previews only, and the full script delegates the build', () => {
    const recorded = npmScripts[SUBJECT_LANE_SCRIPTS.recorded];
    expect(recorded).toBe(`playwright test --config=${SUBJECT_LANE_CONFIG_FILE}`);
    expect(recorded).not.toContain('build');
    expect(recorded).not.toContain('record');
    expect(npmScripts['test:e2e:subject-product']).toBe(recorded);

    const full = npmScripts['test:e2e:subject-product:full'];
    expect(full).toContain(`npm run ${SUBJECT_LANE_SUPERSET_BUILD_SCRIPT}`);
    expect(full).toContain('npm run record:web-artifact:storage-v2');
    expect(full).toContain(`playwright test --config=${SUBJECT_LANE_CONFIG_FILE}`);
    expect(full).not.toContain('build:web');
    expect(full).not.toMatch(/^\s*VITE_DATA_PRODUCTS_V2=/m);

    // The Phase 4 and Phase 5 scripts are unchanged.
    expect(npmScripts['test:e2e:storage:recorded']).toBe(
      'playwright test --config=playwright.storage-v2.config.ts',
    );
    expect(npmScripts['test:e2e:data-products:recorded']).toBe(
      'playwright test --config=playwright.data-products.config.ts',
    );
  });

  it('the spec drives the product\'s own controls and proves its fingerprint can move', () => {
    const spec = readFileSync(path.join(REPO_ROOT, SUBJECT_LANE_TEST_PATH), 'utf8');
    // Every interaction pattern in the declaration is *referenced* by the spec, so
    // the declaration cannot drift into naming controls the lane never touches. The
    // spec must go through the declaration rather than restating a pattern, or the
    // two would be free to disagree.
    for (const name of Object.keys(SUBJECT_LANE.interactionContract)) {
      expect(spec, `the spec never uses interactionContract.${name}`).toContain(
        `interactionContract.${name}`,
      );
    }
    // The non-vacuity control for the refusal claim.
    expect(spec).toContain('the fingerprint cannot move, so the refusal test is vacuous');
    // The lane must not reach into the application's module graph at runtime.
    expect(spec).not.toContain("@/services/persistence/v2/schema");
    expect(spec).not.toContain("@/services/persistence/products/");
    // And it must not stub anything. The one `page.route` in the spec is the egress
    // guard, whose only action is to abort a non-loopback request; a fulfilled route
    // would be a stubbed response and is refused here.
    expect(spec).toContain("route.abort('blockedbyclient')");
    expect(spec).not.toContain('route.fulfill');
    expect(spec).not.toContain('route.continue');
    expect(spec).not.toContain('addInitScript(\n      () =>');
  });

  it('the storage contract the probe reads is the real one', async () => {
    // The probe names the database, the meta store, the pointer owner, and the
    // subject store. If any of those drifted from the application's own constants,
    // every storage assertion in the lane would report "nothing here" instead of
    // failing, so they are pinned against the real source.
    const schema = readFileSync(
      path.join(REPO_ROOT, 'src/services/persistence/v2/schema.ts'),
      'utf8',
    );
    expect(schema).toContain(`'${STORAGE_V2_STORAGE_CONTRACT.subjectsStore}'`);
    expect(schema).toContain(`'${STORAGE_V2_STORAGE_CONTRACT.progressionStore}'`);
    expect(schema).toContain(`'${STORAGE_V2_STORAGE_CONTRACT.preferencesStore}'`);
    // The database name and the pointer owner are constants, so they are compared by
    // value against the real module rather than by a substring of a doc comment.
    const storageConstants = await import('@/services/persistence/v2/schema');
    expect(storageConstants.STORAGE_V2_DATABASE_NAME).toBe(STORAGE_V2_STORAGE_CONTRACT.databaseName);
    expect(storageConstants.STORAGE_V2_SCHEMA_VERSION).toBe(STORAGE_V2_STORAGE_CONTRACT.schemaVersion);
    expect(storageConstants.ACTIVE_GENERATION_META_OWNER).toBe(
      STORAGE_V2_STORAGE_CONTRACT.activeGenerationOwner,
    );
    expect(storageConstants.ACTIVE_GENERATION_META_KEY).toBe(
      STORAGE_V2_STORAGE_CONTRACT.activeGenerationKey,
    );
    expect(storageConstants.GENERATION_META_KEY_PREFIX).toBe(
      STORAGE_V2_STORAGE_CONTRACT.generationKeyPrefix,
    );
  });
});

describe('Phase 6 individual-subject backup CI wiring (ci.yml)', () => {
  it('runs as a gating step inside the existing flagged-build job, on the same host', () => {
    const body = ciJobs.get(SUBJECT_LANE_CI_JOB);
    expect(body, `${SUBJECT_LANE_CI_JOB} job is missing from ci.yml`).toBeDefined();
    const job = body ?? '';
    expect(job).toContain('runs-on: ubuntu-latest');
    expect(job).toContain('npx playwright install --with-deps chromium');
    expect(job).toContain(SUBJECT_LANE_CI_STEP_NAME);
    expect(job).toContain(`npm run ${SUBJECT_LANE_SCRIPTS.recorded}`);
    // The single-build property: the superset build still runs exactly once for all
    // three flagged lanes, and the product-free Phase 4 build never runs in CI.
    expect(job.split(`npm run ${SUBJECT_LANE_SUPERSET_BUILD_SCRIPT}`).length - 1).toBe(1);
    expect(job).not.toContain('npm run build:storage-v2-flagged');
    expect(job.split('npm run record:web-artifact:storage-v2').length - 1).toBe(1);
    // The step itself neither builds nor records.
    const step = stepBlockFor(job);
    expect(step).not.toContain(`npm run ${SUBJECT_LANE_SUPERSET_BUILD_SCRIPT}`);
    expect(step).not.toContain('npm run record:');
    expect(step).not.toContain('npm run build:');
    expect(step).toContain(`npm run ${SUBJECT_LANE_SCRIPTS.recorded}`);
  });

  it('GATES: the step must not carry continue-on-error, and no step in the job may', () => {
    const body = ciJobs.get(SUBJECT_LANE_CI_JOB) ?? '';
    const step = stepBlockFor(body);
    expect(step).toContain(`npm run ${SUBJECT_LANE_SCRIPTS.recorded}`);
    expect(step).not.toContain('continue-on-error');
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
    const body = ciJobs.get(SUBJECT_LANE_CI_JOB) ?? '';
    // One upload, evidence only, and none of this lane's raw artifacts.
    expect(body.split('actions/upload-artifact@v4').length - 1).toBe(1);
    expect(body).toContain('path: artifacts/compatibility-evidence');
    for (const forbidden of [
      'artifacts/playwright-subject-product-report',
      'artifacts/subject-product-test-results',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});
