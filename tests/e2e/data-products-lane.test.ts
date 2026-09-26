import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import playwrightConfig from '../../playwright.config';
import storageV2Config from '../../playwright.storage-v2.config';
import dataProductsConfig from '../../playwright.data-products.config';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { CURRENT_BUILD_TEST_FILE, SUPPORT_MATRIX } from './support-matrix';
import { STORAGE_V2_LANE, STORAGE_V2_TEST_FILE } from './storage-v2-lane';
import {
  DATA_PRODUCTS_BUILD_MODE,
  DATA_PRODUCTS_BUILD_SCRIPT,
  DATA_PRODUCTS_CI_JOB,
  DATA_PRODUCTS_CI_STEP_NAME,
  DATA_PRODUCTS_CONFIG_FILE,
  DATA_PRODUCTS_ENV_FILE,
  DATA_PRODUCTS_FLAG,
  DATA_PRODUCTS_FLAG_VALUE,
  DATA_PRODUCTS_LANE,
  DATA_PRODUCTS_MANIFEST_PATH,
  DATA_PRODUCTS_OWNER_FLAG,
  DATA_PRODUCTS_OWNER_FLAG_ENABLED_IN_THIS_LANE,
  DATA_PRODUCTS_PREVIEW_COMMAND,
  DATA_PRODUCTS_PREVIEW_PORT,
  DATA_PRODUCTS_FULL_SCRIPT,
  DATA_PRODUCTS_PREVIEW_SCRIPT,
  DATA_PRODUCTS_PROJECT,
  DATA_PRODUCTS_SCRIPTS,
  DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT,
  DATA_PRODUCTS_TEST_FILE,
  DATA_PRODUCTS_TEST_PATH,
  validateDataProductsLane,
} from './data-products-lane';

/**
 * Phase 5 fresh-profile restore lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. Five things must hold, and each is checked
 * against the real file:
 *
 * 1. The lane declaration is internally consistent, and it does not reuse another
 *    lane's project name or spec file.
 * 2. The Playwright config binds exactly one project to exactly the new spec,
 *    previews an existing build on its own port, and never decides to rebuild.
 * 3. **The three release paths stay disjoint.** The default config, the Phase 4
 *    flagged config, and this one each bind their own spec, so `npm run test:e2e`
 *    cannot reach this spec and the Phase 4 lane is not widened.
 * 4. The package scripts build nothing here, record nothing here, and preview only.
 * 5. The CI wiring is a step inside the existing `storage-v2-browser` job, so the
 *    flagged artifact is built exactly once and the "exactly one job runs
 *    `npm run build:web`" and "exactly four pull-request compatibility lanes"
 *    assertions in `support-matrix.test.ts` and `storage-v2-lane.test.ts` are
 *    untouched.
 *
 * Plus the non-vacuity check that makes the whole lane meaningful: the storage
 * contract the browser probe reads must equal the constants the application uses,
 * and the Phase 5 owner flag must be the one the plan names.
 */

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

/** Splits a workflow into job blocks keyed by job id. */
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

/** The YAML block of one named step, from its `name:` to the next step. */
function stepBlockFor(jobBody: string): string {
  const index = jobBody.indexOf(`name: ${DATA_PRODUCTS_CI_STEP_NAME}`);
  if (index === -1) throw new Error(`The job has no step named ${DATA_PRODUCTS_CI_STEP_NAME}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

describe('Phase 5 fresh-profile restore lane declaration', () => {
  it('is internally consistent and claims its own bounded scope', () => {
    expect(validateDataProductsLane()).toEqual([]);
    expect(DATA_PRODUCTS_LANE.sharesArtifactWith).toBe('phase-4-storage-v2-flagged-build');
    expect(DATA_PRODUCTS_LANE.acceptDownloads).toBe(true);
    expect(DATA_PRODUCTS_LANE.claim.length).toBeGreaterThan(120);
    expect(DATA_PRODUCTS_LANE.doesNotProve.length).toBeGreaterThanOrEqual(6);
    // The lane is honest about the artifact it previews: storage-v2 flagged, and
    // with the Phase 5 product ON, because the product is landed and the lane is
    // its acceptance evidence.
    expect(DATA_PRODUCTS_LANE.flag).toBe('VITE_STORAGE_REPOSITORY');
    expect(DATA_PRODUCTS_LANE.flagValue).toBe('v2');
    expect(DATA_PRODUCTS_LANE.dataProductsV2).toBe(true);
    // The two build scripts are different scripts, which is what keeps the Phase 4
    // lane's product-free artifact independently verifiable.
    expect(DATA_PRODUCTS_LANE.buildScript).toBe('build:storage-v2-flagged');
    expect(DATA_PRODUCTS_LANE.supersetBuildScript).toBe('build:storage-v2-data-products');
    expect(DATA_PRODUCTS_LANE.supersetBuildScript).not.toBe(DATA_PRODUCTS_LANE.buildScript);
  });

  it('previews the same flagged artifact identity the Phase 4 lane verifies', () => {
    // Same build mode, same env file, same manifest path, same flag. If any of
    // these drifted, the two lanes could be pointed at different artifacts and
    // neither would notice.
    expect(DATA_PRODUCTS_LANE.buildMode).toBe(STORAGE_V2_LANE.buildMode);
    expect(DATA_PRODUCTS_LANE.envFile).toBe(STORAGE_V2_LANE.envFile);
    expect(DATA_PRODUCTS_LANE.manifestPath).toBe(STORAGE_V2_LANE.manifestPath);
    expect(DATA_PRODUCTS_LANE.buildScript).toBe(STORAGE_V2_LANE.buildScript);
    expect(DATA_PRODUCTS_BUILD_MODE).toBe('storage-v2');
    expect(DATA_PRODUCTS_BUILD_SCRIPT).toBe('build:storage-v2-flagged');
    expect(DATA_PRODUCTS_ENV_FILE).toBe('.env.storage-v2');
    expect(DATA_PRODUCTS_FLAG).toBe('VITE_STORAGE_REPOSITORY');
    expect(DATA_PRODUCTS_FLAG_VALUE).toBe('v2');
    expect(DATA_PRODUCTS_MANIFEST_PATH).toBe('artifacts/web-artifact-manifest-storage-v2.json');
    expect(existsSync(path.join(REPO_ROOT, DATA_PRODUCTS_ENV_FILE))).toBe(true);
  });

  it('the Phase 5 owner flag is the one the plan names, is default-off, and this lane turns it on', () => {
    expect(DATA_PRODUCTS_OWNER_FLAG).toBe('VITE_DATA_PRODUCTS_V2');
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe(DATA_PRODUCTS_OWNER_FLAG);
    // The *production default* is unchanged: the flag is still opt-in for the
    // default build, and the rollback is still a build-time flag.
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.ownerPhase).toBe(5);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    // What changed is only the artifact this lane previews, and it is recorded
    // rather than inferred: every evidence file says `dataProductsV2: true`.
    expect(DATA_PRODUCTS_OWNER_FLAG_ENABLED_IN_THIS_LANE).toBe(true);
    expect(DATA_PRODUCTS_LANE.dataProductsV2).toBe(true);

    // The flag is turned on by a build script, and that script must not claim the
    // storage flag itself - two declarations of one flag is a drift waiting to
    // happen, and the existing Phase 4 gate asserts which env file carries it.
    const env = readFileSync(path.join(REPO_ROOT, DATA_PRODUCTS_ENV_FILE), 'utf8');
    expect(env).toMatch(
      new RegExp(`^\\s*${DATA_PRODUCTS_FLAG}=${DATA_PRODUCTS_FLAG_VALUE}\\s*$`, 'm'),
    );
    expect(env, 'the owner flag must not be written into the Phase 4 env file').not.toContain(
      DATA_PRODUCTS_OWNER_FLAG,
    );
    const buildScript = readFileSync(
      path.join(REPO_ROOT, 'scripts/build-flagged-data-products.mjs'),
      'utf8',
    );
    expect(buildScript).toContain("'VITE_DATA_PRODUCTS_V2'");
    expect(buildScript).toContain("'true'");
    expect(buildScript).toContain("'--mode'");
    expect(buildScript).toContain("'storage-v2'");
    // The prose in the script's header names the storage flag; what matters is that
    // no code path assigns it.
    expect(buildScript, 'the superset build must not assign the storage flag').not.toContain(
      "['VITE_STORAGE_REPOSITORY']",
    );
    expect(buildScript).not.toMatch(/process\.env\.VITE_STORAGE_REPOSITORY\s*=/);
  });
});


describe('Phase 5 fresh-profile restore Playwright config', () => {
  it('binds exactly one project to exactly the new spec', () => {
    const projects = (dataProductsConfig.projects ?? []).flat();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe(DATA_PRODUCTS_PROJECT);
    expect(project?.use?.browserName).toBe('chromium');
    expect(project?.use?.viewport).toEqual({ ...DATA_PRODUCTS_LANE.viewport });
    expect(project?.use?.deviceScaleFactor).toBe(DATA_PRODUCTS_LANE.deviceScaleFactor);
    expect(project?.use?.hasTouch).toBe(DATA_PRODUCTS_LANE.hasTouch);
    // Downloads are enabled at both levels, because a backup is a local file.
    expect(project?.use?.acceptDownloads).toBe(true);
    expect(dataProductsConfig.use?.acceptDownloads).toBe(true);
    // No raw failure artifact, exactly like the other two configs.
    expect(dataProductsConfig.use?.trace).toBe('off');
    expect(dataProductsConfig.use?.screenshot).toBe('off');
    expect(dataProductsConfig.use?.video).toBe('off');
    expect(project?.use?.trace ?? 'off').toBe('off');
    expect(project?.use?.screenshot ?? 'off').toBe('off');
    expect(project?.use?.video ?? 'off').toBe('off');

    expect(dataProductsConfig.testMatch).toBe(DATA_PRODUCTS_TEST_FILE);
    expect(existsSync(path.join(REPO_ROOT, DATA_PRODUCTS_TEST_PATH))).toBe(true);
  });

  it('previews an existing build on its own port, and never decides to rebuild', () => {
    const webServer = dataProductsConfig.webServer;
    expect(Array.isArray(webServer)).toBe(false);
    const command = Array.isArray(webServer) ? undefined : webServer?.command;
    expect(command).toBe(DATA_PRODUCTS_PREVIEW_COMMAND);
    expect(command).toBe(`npm run ${DATA_PRODUCTS_PREVIEW_SCRIPT}`);
    expect(command).not.toContain('build');
    const url = Array.isArray(webServer) ? undefined : webServer?.url;
    expect(url).toBe(`http://127.0.0.1:${DATA_PRODUCTS_PREVIEW_PORT}`);
    // A port of its own, so the two flagged lanes can never collide in one
    // worktree even if they are ever run at the same time.
    expect(DATA_PRODUCTS_PREVIEW_PORT).toBe(43179);
    expect(npmScripts['preview:e2e']).toContain('43173');
    expect(npmScripts[DATA_PRODUCTS_PREVIEW_SCRIPT]).toContain(String(DATA_PRODUCTS_PREVIEW_PORT));
    // No reuse: the lane must not attach to a server somebody else started.
    expect(Array.isArray(webServer) ? false : webServer?.reuseExistingServer).toBe(false);
  });

  it('keeps the default config, the Phase 4 lane, and this lane disjoint', () => {
    const defaultProjects = (playwrightConfig.projects ?? []).flat().map((project) => project.name);
    // The approved support matrix is unchanged, so the "one project per matrix
    // entry" contract in support-matrix.test.ts still holds.
    expect(defaultProjects).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    expect(defaultProjects).not.toContain(DATA_PRODUCTS_PROJECT);
    for (const project of playwrightConfig.projects ?? []) {
      expect(project.testMatch).not.toBe(DATA_PRODUCTS_TEST_FILE);
    }
    // The Phase 4 lane is untouched: one project, one testMatch, still its spec.
    const storageProjects = (storageV2Config.projects ?? []).flat();
    expect(storageProjects).toHaveLength(1);
    expect(storageV2Config.testMatch).toBe(STORAGE_V2_TEST_FILE);
    for (const project of storageV2Config.projects ?? []) {
      expect(project.testMatch).not.toBe(DATA_PRODUCTS_TEST_FILE);
    }
    // Three configs, three project names, three spec files.
    expect(new Set([...defaultProjects, STORAGE_V2_LANE.project, DATA_PRODUCTS_PROJECT]).size).toBe(
      defaultProjects.length + 2,
    );
    // The default suite scripts still name only the current-build spec, so
    // `npm run test:e2e` cannot reach this spec.
    expect(npmScripts['test:e2e']).toContain(CURRENT_BUILD_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(DATA_PRODUCTS_TEST_FILE);
    expect(npmScripts['test:e2e']).not.toContain(DATA_PRODUCTS_CONFIG_FILE);
  });
});

describe('Phase 5 fresh-profile restore package scripts', () => {
  it('the full script previews only, and the recorded variant is free of build and record steps', () => {
    // The full script previews the artifact the Phase 4 scripts already built and
    // recorded. It must not build: a second build in a CI run is exactly the
    // duplication this lane is designed to avoid.
    const full = npmScripts[DATA_PRODUCTS_SCRIPTS.full];
    expect(full).toBe(`playwright test --config=${DATA_PRODUCTS_CONFIG_FILE}`);
    expect(full).not.toContain('build');
    expect(full).not.toContain('record');
    expect(full).not.toContain('npm run build:web');
    expect(full).not.toContain(DATA_PRODUCTS_TEST_FILE);

    const recorded = npmScripts[DATA_PRODUCTS_SCRIPTS.recorded];
    expect(recorded).toBe(full);

    // The preview script is a preview, and it is not the production preview.
    const preview = npmScripts[DATA_PRODUCTS_PREVIEW_SCRIPT];
    expect(preview).toContain('vite preview');
    expect(preview).toContain('strictPort');
    expect(preview).not.toContain('build');

    // The convenience script that builds, records, and runs, so nobody has to
    // remember the environment incantation. It delegates the build to the superset
    // script rather than to a shell assignment, and the CI job runs the same three
    // steps separately.
    const fullRun = npmScripts[DATA_PRODUCTS_FULL_SCRIPT];
    expect(fullRun).toContain(`npm run ${DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT}`);
    expect(fullRun).toContain('npm run record:web-artifact:storage-v2');
    expect(fullRun).toContain(`playwright test --config=${DATA_PRODUCTS_CONFIG_FILE}`);
    expect(fullRun).not.toContain('build:web');
    // A local shell assignment would be a POSIX-only construct; the flag travels in
    // a script instead.
    expect(fullRun).not.toMatch(/^\s*VITE_DATA_PRODUCTS_V2=/m);
    expect(npmScripts[DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT]).toBe(
      'node scripts/build-flagged-data-products.mjs',
    );

    // The Phase 4 scripts are unchanged, including the one that owns the
    // product-free flagged build.
    expect(npmScripts['test:e2e:storage']).toContain(`npm run ${STORAGE_V2_LANE.buildScript}`);
    expect(npmScripts['test:e2e:storage']).toContain('record:web-artifact:storage-v2');
    expect(npmScripts['test:e2e:storage:recorded']).toBe(
      'playwright test --config=playwright.storage-v2.config.ts',
    );
  });

  it('the lane reads the storage contract the application actually uses', () => {
    // The spec's browser probe reads these names out of the page. If the
    // application's schema module were renamed or re-keyed, every storage
    // assertion in the lane would silently report "nothing here" instead of
    // failing, so the contract is pinned against the real source.
    const laneSource = readFileSync(
      path.join(REPO_ROOT, 'tests/e2e/dataProductsRestore.spec.ts'),
      'utf8',
    );
    expect(laneSource).toContain("from './storage-v2-lane'");
    expect(laneSource).toContain('STORAGE_V2_STORAGE_CONTRACT');
    // The spec never reaches into the application's module graph at runtime, which
    // is the same discipline the Phase 4 lane follows: transpiling the app's own
    // graph inside a Playwright worker would be a second, unrelated failure mode.
    expect(laneSource).not.toContain("@/services/persistence/v2/schema");
  });
});

describe('Phase 5 fresh-profile restore CI wiring (ci.yml)', () => {
  it('runs as a gating step inside the existing flagged-build job, on the same host', () => {
    const job = ciJobs.get(DATA_PRODUCTS_CI_JOB);
    expect(job, `${DATA_PRODUCTS_CI_JOB} job is missing from ci.yml`).toBeDefined();
    const body = job ?? '';

    // Same host, same browser, same artifact - it is a step in that job, not a new
    // job, precisely so the build happens once.
    expect(body).toContain('runs-on: ubuntu-latest');
    expect(body).toContain('npx playwright install --with-deps chromium');
    expect(body).toContain('ImageOS');
    expect(body).toContain('ImageVersion');
    expect(body).toContain(DATA_PRODUCTS_CI_STEP_NAME);
    expect(body).toContain(`npm run ${DATA_PRODUCTS_SCRIPTS.recorded}`);

    // The single-build property, which is the reason this lane is a step here.
    // Both flagged lanes preview ONE tree, so the superset build runs exactly once
    // and the product-free build script is never invoked in CI.
    expect(body.split(`npm run ${DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT}`).length - 1).toBe(1);
    expect(body).not.toContain(`npm run ${DATA_PRODUCTS_BUILD_SCRIPT}`);
    expect(body.split('npm run record:web-artifact:storage-v2').length - 1).toBe(1);
    expect(body.split('npm run verify:web-artifact:storage-v2').length - 1).toBe(1);

    // It cannot consume the shared production artifact, and the job never builds
    // the *production* artifact.
    expect(body).not.toContain('actions/download-artifact');
    expect(body).not.toContain('npm run build:web');
    expect(body).not.toContain('electron-builder');

    // ...and the *step* itself neither builds nor records an identity. The script it
    // runs is named `...:recorded` because it previews an already-recorded
    // artifact, so the check is against the build and record *scripts*, not against
    // the word "recorded" in a script name.
    const step = stepBlockFor(body);
    expect(step).not.toContain(`npm run ${DATA_PRODUCTS_SUPERSET_BUILD_SCRIPT}`);
    expect(step).not.toContain('npm run record:');
    expect(step).not.toContain('npm run build:');
    expect(step).toContain(`npm run ${DATA_PRODUCTS_SCRIPTS.recorded}`);
  });

  it('GATES: the step must not carry continue-on-error', () => {
    // This assertion is deliberately the inverse of the one this file used to
    // make. It previously required `continue-on-error: true`, on the grounds that
    // the product did not exist yet and a red registered lane would be
    // indistinguishable from a Phase 4 regression. That ground is gone: the
    // product is landed, the lane is the phase's acceptance evidence for the
    // fresh-profile restore deliverable, and it passes.
    //
    // The durable property is therefore "this step's result is the job's result".
    // Asserting the *absence* of the exemption is what protects it: a bare
    // `continue-on-error` with no justification is how a gate quietly stops gating,
    // and a test that only checked the lane was green could not tell the
    // difference between a gating lane and an exempt one. This way, re-adding the
    // exemption fails here rather than being noticed in a review.
    const body = ciJobs.get(DATA_PRODUCTS_CI_JOB) ?? '';
    const step = stepBlockFor(body);
    expect(step).toContain(`npm run ${DATA_PRODUCTS_SCRIPTS.recorded}`);
    expect(step).not.toContain('continue-on-error');

    // And the job must not be excused either: no *step* in it may be exempt. Matched
    // as a YAML key at the start of a line, so the prose in this file and in the
    // workflow's own comments - which discuss the exemption deliberately - are not
    // counted as one.
    const exemptionKeys = [...body.matchAll(/^\s*continue-on-error\s*:/gm)].length;
    expect(exemptionKeys, 'a step in the flagged-build job is exempt from failing').toBe(0);

    // The stale justifications are gone too, so the workflow does not tell a future
    // maintainer that a product is missing when it is not.
    expect(body).not.toContain('continue-on-error:');
    expect(body).not.toContain('the Phase 5 product does not exist yet');
    expect(body).not.toContain('Remove it at the Phase 5 exit gate');
    // ...and the step still says why it is here, in terms that remain true.
    expect(body).toContain('acceptance evidence for the fresh-profile restore');
  });

  it('leaves the single production build job and the four compatibility lanes alone', () => {
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(buildJobs.map(([name]) => name)).toEqual(['web-build']);
    const sharedUploadStep = 'Upload the shared production web artifact';
    expect(ciWorkflow.split(sharedUploadStep).length - 1).toBe(1);

    // No new `- id:` matrix cell, so the four representative pull-request lanes
    // are still four.
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);

    // The Phase 4 lane's own assertions still hold against the modified job: one
    // upload, allowlisted evidence only, and none of this lane's raw artifacts.
    const body = ciJobs.get(DATA_PRODUCTS_CI_JOB) ?? '';
    const uploads = body.split('actions/upload-artifact@v4').length - 1;
    expect(uploads).toBe(1);
    expect(body).toContain('path: artifacts/compatibility-evidence');
    for (const forbidden of [
      'artifacts/playwright-data-products-report',
      'artifacts/data-products-test-results',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});
