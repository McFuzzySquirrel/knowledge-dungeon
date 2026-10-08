/**
 * Phase 22 service-worker compatibility lane wiring checks.
 *
 * The lane is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. The properties below are the ones whose
 * absence would make the lane report something other than what it claims:
 *
 * 1. The declaration is internally consistent, claims a bounded scope, and states
 *    what it does not prove.
 * 2. The lane reuses the offline lane's artifact - one build, one recorded
 *    identity, no second flagged artifact - and turns no new flag on.
 * 3. The Playwright config binds exactly one project to exactly the new spec,
 *    previews an existing build on its own port, allows service workers for that
 *    project only, and records no raw failure artifact.
 * 4. **The `serviceWorkers: 'allow'` census holds.** The global config and every
 *    other lane config block service workers; only the offline lane and this lane
 *    allow them, each for its own project. Asserted as a text property over the
 *    whole config directory, so a future lane cannot quietly join the exception.
 * 5. **The CI wiring is one artifact built once.** The offline flagged artifact is
 *    built, recorded, verified and uploaded by `web-build`, downloaded once by
 *    `browser-smoke`, and both the offline lane and this lane run against that one
 *    download. The transfer audit
 *    (`tests/e2e/artifact-transfer-wiring.ts`) holds the two movements as a
 *    declaration, not a count.
 * 6. **Host selection is honest.** The lane declares the one host it is approved
 *    for, uses the shared `decideLaneOutcome` mechanism, and is not smuggled into
 *    the support matrix to force it to run.
 * 7. **The privacy policy is proved, not relaxed.** The spec classifies every
 *    request through the unchanged `compat-evidence` policy and asserts no
 *    violation; the Phase 1 spy is still the production artifact's network gate,
 *    and neither it nor `compat-evidence.ts` was weakened.
 *
 * Privacy: this file contains no learner data, reads only the repository, and
 * spawns nothing.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import swShellConfig from './playwright.sw-shell.config';
import offlineConfig from './playwright.offline.config';
import playwrightConfig from '../../playwright.config';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import {
  COMPATIBILITY_PROJECTS,
  SUPPORT_MATRIX,
  validateSupportMatrix,
} from './support-matrix';
import {
  OFFLINE_LANE_BUILD_SCRIPT,
  OFFLINE_LANE_MANIFEST_PATH,
  OFFLINE_LANE_PREFLIGHT_COMMAND,
  OFFLINE_LANE_TEST_FILE,
} from './offline-lane';
import {
  SW_SHELL_CI_BUILD_JOB,
  SW_SHELL_CI_DOWNLOAD_STEP,
  SW_SHELL_CI_JOB,
  SW_SHELL_CI_RUN_COMMAND,
  SW_SHELL_CI_STEP_NAME,
  SW_SHELL_CI_UPLOAD_ARTIFACT,
  SW_SHELL_CI_UPLOAD_STEP,
  SW_SHELL_CI_VERIFY_STEP,
  SW_SHELL_CONFIG_FILE,
  SW_SHELL_LANE,
  SW_SHELL_LANE_FULL_SCRIPT,
  SW_SHELL_LANE_SCRIPT,
  SW_SHELL_MANIFEST_PATH,
  SW_SHELL_PLAYWRIGHT_COMMAND,
  SW_SHELL_PREVIEW_PORT,
  SW_SHELL_PREVIEW_SCRIPT,
  SW_SHELL_TEST_FILE,
  SW_SHELL_TEST_PATH,
  validateSwShellLane,
} from './sw-shell-lane';
import { decideLaneOutcome } from './compat-evidence';
import {
  DOWNLOAD_DECLARATION,
  UPLOAD_DECLARATION,
  auditJobTransfers,
} from './artifact-transfer-wiring';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const npmScripts = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');

/** The config files that may set `serviceWorkers`, in both directories they live in. */
function playwrightConfigFiles(): readonly string[] {
  const root = readdirSync(REPO_ROOT)
    .filter((name) => /^playwright\.[a-z0-9-]+\.config\.ts$/.test(name))
    .map((name) => path.join(REPO_ROOT, name));
  const nested = readdirSync(path.join(REPO_ROOT, 'tests/e2e'))
    .filter((name) => /^playwright\.[a-z0-9-]+\.config\.ts$/.test(name))
    .map((name) => path.join(REPO_ROOT, 'tests', 'e2e', name));
  return [...root, ...nested, path.join(REPO_ROOT, 'playwright.config.ts')];
}

const SERVICE_WORKER_ALLOW_FILES = new Set([
  'playwright.offline.config.ts',
  'playwright.sw-shell.config.ts',
]);

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

/** The text of one named step, up to the next step in the same job. */
function stepBlockFor(jobBody: string, stepName: string): string {
  const index = jobBody.indexOf(`name: ${stepName}`);
  if (index === -1) throw new Error(`The job has no step named ${stepName}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

const ciJobs = parseWorkflowJobs(ciWorkflow);

describe('sw-shell compatibility lane declaration', () => {
  it('is internally consistent and claims its own bounded scope', () => {
    expect(validateSwShellLane()).toEqual([]);
    expect(SW_SHELL_LANE.suite).toBe('phase-22-service-worker-compatibility');
    expect(SW_SHELL_LANE.engine).toBe('chromium');
    expect(SW_SHELL_LANE.evidenceClass).toBe('engine-automation');
    expect(SW_SHELL_LANE.storageRepository).toBe('v2');
    expect(SW_SHELL_LANE.claim.length).toBeGreaterThan(200);
    expect(SW_SHELL_LANE.doesNotProve.length).toBeGreaterThanOrEqual(8);
  });

  it('reuses the offline lane artifact and turns on no flag of its own', () => {
    // The one-artifact rule: no second flagged build.
    expect(SW_SHELL_LANE.buildScript).toBe(OFFLINE_LANE_BUILD_SCRIPT);
    expect(SW_SHELL_LANE.manifestPath).toBe(OFFLINE_LANE_MANIFEST_PATH);
    expect(SW_SHELL_MANIFEST_PATH).toBe(OFFLINE_LANE_MANIFEST_PATH);
    // ...and it is the same build-time flag the offline lane is the browser evidence
    // for, still off by production default.
    expect(SW_SHELL_LANE.flag).toBe('VITE_OFFLINE_SHELL');
    expect(SW_SHELL_LANE.flagValue).toBe('true');
    expect(RUNTIME_FLAG_ENV_KEYS.offlineShell).toBe(SW_SHELL_LANE.flag);
    expect(DEFAULT_RUNTIME_CONFIG.offlineShell).toBe(false);
    expect(FEATURE_FLAG_MATRIX.offlineShell.productionDefault).toBe(false);
    expect(FEATURE_FLAG_MATRIX.offlineShell.ownerPhase).toBe(22);
  });

  it('does not widen the offline suite', () => {
    expect(SW_SHELL_TEST_FILE).not.toBe(OFFLINE_LANE_TEST_FILE);
    expect(SW_SHELL_LANE.configFile).not.toBe('tests/e2e/playwright.offline.config.ts');
  });
});

describe('sw-shell compatibility npm scripts', () => {
  it('exposes the lane under the repository\'s own test:e2e naming', () => {
    for (const script of [SW_SHELL_LANE_SCRIPT, SW_SHELL_LANE_FULL_SCRIPT, 'test:e2e:sw-shell:recorded']) {
      expect(npmScripts[script], `package.json has no ${script} script`).toBeDefined();
    }
  });

  it('runs the shared preflight and exactly the config it declares', () => {
    const expected = `${OFFLINE_LANE_PREFLIGHT_COMMAND} && ${SW_SHELL_PLAYWRIGHT_COMMAND}`;
    expect(npmScripts[SW_SHELL_LANE_SCRIPT]).toBe(expected);
    expect(npmScripts['test:e2e:sw-shell:recorded']).toBe(expected);
    expect(SW_SHELL_PLAYWRIGHT_COMMAND).toBe(`playwright test --config=${SW_SHELL_CONFIG_FILE}`);
    // Preview only: a missing artifact is a failure, not a rebuild.
    for (const script of [SW_SHELL_LANE_SCRIPT, 'test:e2e:sw-shell:recorded']) {
      for (const forbidden of ['build:web', 'vite build', 'record:web-artifact', 'npm ci']) {
        expect(npmScripts[script], `${script}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('builds and records the shared flagged artifact only in the :full script', () => {
    expect(npmScripts[SW_SHELL_LANE_FULL_SCRIPT]).toBe(
      `npm run ${OFFLINE_LANE_BUILD_SCRIPT} && npm run record:web-artifact:offline && ` +
        `${OFFLINE_LANE_PREFLIGHT_COMMAND} && ${SW_SHELL_PLAYWRIGHT_COMMAND}`,
    );
  });

  it('binds its spec and config to real files on disk', () => {
    expect(existsSync(path.join(REPO_ROOT, SW_SHELL_TEST_PATH))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, SW_SHELL_CONFIG_FILE))).toBe(true);
  });
});

describe('sw-shell compatibility Playwright config', () => {
  it('binds exactly one project to exactly the new spec', () => {
    const projects = (swShellConfig.projects ?? []).flat();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe(SW_SHELL_LANE.project);
    expect(project?.use?.browserName).toBe('chromium');
    expect(project?.use?.viewport).toEqual({ ...SW_SHELL_LANE.viewport });
    expect(project?.use?.deviceScaleFactor).toBe(1);
    expect(project?.use?.hasTouch).toBe(false);
    expect(swShellConfig.testMatch).toBe(SW_SHELL_TEST_FILE);
  });

  it('allows service workers for this project only, and records no raw artifact', () => {
    expect(offlineConfig.use?.serviceWorkers).toBe('allow');
    expect(swShellConfig.use?.serviceWorkers).toBe('allow');
    for (const key of ['trace', 'screenshot', 'video'] as const) {
      expect(swShellConfig.use?.[key], key).toBe('off');
    }
    expect(swShellConfig.use?.acceptDownloads).toBe(false);
    expect(swShellConfig.workers).toBe(1);
    expect(swShellConfig.fullyParallel).toBe(false);
  });

  it('previews an existing build on its own port, and never decides to rebuild', () => {
    const webServer = Array.isArray(swShellConfig.webServer) ? undefined : swShellConfig.webServer;
    expect(webServer?.command).toBe(SW_SHELL_PREVIEW_SCRIPT);
    expect(webServer?.command).not.toContain('build');
    expect(webServer?.url).toBe(`http://127.0.0.1:${SW_SHELL_PREVIEW_PORT}`);
    expect(swShellConfig.use?.baseURL).toBe(webServer?.url);
    expect(SW_SHELL_PREVIEW_SCRIPT).toContain('strictPort');
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(webServer?.cwd).toBe(process.cwd());
    // A distinct port from every other lane, including the offline lane it shares
    // an artifact with.
    expect(SW_SHELL_PREVIEW_PORT).not.toBe(43207);
  });

  it('keeps the global config and every other lane blocking service workers', () => {
    expect(playwrightConfig.use?.serviceWorkers).toBe('block');
    const seen: string[] = [];
    for (const file of playwrightConfigFiles()) {
      const basename = path.basename(file);
      const source = readFileSync(file, 'utf8');
      const allows = /serviceWorkers:\s*'allow'/.test(source);
      const blocks = /serviceWorkers:\s*'block'/.test(source);
      if (SERVICE_WORKER_ALLOW_FILES.has(basename)) {
        expect(allows, `${basename} must allow service workers`).toBe(true);
        seen.push(basename);
      } else {
        expect(allows, `${basename} allows service workers and must not`).toBe(false);
        expect(blocks, `${basename} must block service workers`).toBe(true);
      }
    }
    // The allow list is exactly the two lanes, and the census actually saw them.
    expect(new Set(seen)).toEqual(new Set(SERVICE_WORKER_ALLOW_FILES));
  });
});

describe('sw-shell compatibility CI wiring (ci.yml)', () => {
  const job = ciJobs.get(SW_SHELL_CI_JOB) ?? '';
  const buildJob = ciJobs.get(SW_SHELL_CI_BUILD_JOB) ?? '';

  it('builds, records, verifies and uploads the flagged artifact once, in web-build', () => {
    expect(buildJob, `${SW_SHELL_CI_BUILD_JOB} is missing from ci.yml`).not.toBe('');
    expect(SW_SHELL_CI_BUILD_JOB).toBe('web-build');
    expect(buildJob).toContain(`npm run ${SW_SHELL_LANE.buildScript}`);
    expect(buildJob).toContain('npm run record:web-artifact:offline');
    expect(buildJob).toContain('npm run verify:web-artifact:offline');
    const upload = stepBlockFor(buildJob, SW_SHELL_CI_UPLOAD_STEP);
    expect(upload).toContain(`name: ${SW_SHELL_CI_UPLOAD_ARTIFACT}`);
    expect(upload).toContain(SW_SHELL_LANE.manifestPath);
    expect(upload).toContain('dist');
    // The build job installs no browser: this is a build-level lane up here.
    expect(buildJob).not.toContain('playwright install');
    expect(buildJob).not.toContain(SW_SHELL_CI_RUN_COMMAND);
  });

  it('downloads and verifies that one artifact in browser-smoke, and runs both lanes', () => {
    expect(SW_SHELL_CI_JOB).toBe('browser-smoke');
    const download = stepBlockFor(job, SW_SHELL_CI_DOWNLOAD_STEP);
    expect(download).toContain(`name: ${SW_SHELL_CI_UPLOAD_ARTIFACT}`);
    expect(download).toMatch(/^\s*uses: actions\/download-artifact@v4$/m);
    expect(stepBlockFor(job, SW_SHELL_CI_VERIFY_STEP)).toContain('npm run verify:web-artifact:offline');
    expect(job).toContain(SW_SHELL_CI_RUN_COMMAND);
    expect(job).toContain('npm run test:e2e:offline:recorded');
    // The SW lane shares the download rather than making its own.
    const swStep = stepBlockFor(job, SW_SHELL_CI_STEP_NAME);
    expect(swStep).toContain(SW_SHELL_CI_RUN_COMMAND);
    expect(swStep).not.toContain('download-artifact');
    expect(swStep).not.toContain('npm run build:');
    expect(swStep).not.toContain('record:web-artifact');
    expect(swStep).not.toContain('continue-on-error');
    expect(swStep).not.toContain('|| true');
    expect(swStep).not.toContain('exit 0');
  });

  it('orders the discard, download, verify and both lanes correctly', () => {
    const order = [
      'Discard the production dist before the offline-shell download',
      `name: ${SW_SHELL_CI_DOWNLOAD_STEP}`,
      `name: ${SW_SHELL_CI_VERIFY_STEP}`,
      `name: ${SW_SHELL_CI_STEP_NAME}`,
      'name: Run the Phase 22 offline-shell lane',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = job.indexOf(marker);
      expect(at, `${marker} is missing from ${SW_SHELL_CI_JOB}`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // The offline lane owns the version-bump mutation and restores the manifest in
    // its afterAll; the compatibility lane is pure and runs first, so it never
    // measures a tree the offline lane has touched.
    expect(job.indexOf(`name: ${SW_SHELL_CI_STEP_NAME}`)).toBeLessThan(
      job.indexOf('name: Run the Phase 22 offline-shell lane'),
    );
  });

  it('holds both artifact movements as the shared declaration, not a count', () => {
    expect(
      auditJobTransfers(ciWorkflow, SW_SHELL_CI_JOB, DOWNLOAD_DECLARATION),
      'browser-smoke moves something other than the declared downloads',
    ).toEqual([]);
    expect(
      auditJobTransfers(ciWorkflow, SW_SHELL_CI_BUILD_JOB, UPLOAD_DECLARATION),
      'web-build uploads something other than the declared artifacts',
    ).toEqual([]);
    expect(
      DOWNLOAD_DECLARATION.some(
        (entry) => entry.stepName === SW_SHELL_CI_DOWNLOAD_STEP && entry.artifact === SW_SHELL_CI_UPLOAD_ARTIFACT,
      ),
      'the offline-shell download is not declared',
    ).toBe(true);
    expect(
      UPLOAD_DECLARATION.some(
        (entry) => entry.stepName === SW_SHELL_CI_UPLOAD_STEP && entry.artifact === SW_SHELL_CI_UPLOAD_ARTIFACT,
      ),
      'the offline-shell upload is not declared',
    ).toBe(true);
  });

  it('leaves no step in the job exempt from failing', () => {
    expect([...job.matchAll(/^\s*continue-on-error\s*:/gm)].length, 'a step in browser-smoke is exempt').toBe(0);
  });
});

describe('sw-shell compatibility host selection', () => {
  it('declares the one host it is approved for and skips any other honestly', () => {
    expect(SW_SHELL_LANE.hostOperatingSystems).toEqual(['linux']);
    // The shared mechanism: local unapproved host is not-selected evidence; a runner
    // unapproved host is a lane failure, never a green run.
    const local = decideLaneOutcome({
      hostApproved: false,
      isCi: false,
      browserAvailable: false,
      project: SW_SHELL_LANE.project,
      approvedHosts: SW_SHELL_LANE.hostOperatingSystems,
      actualHost: 'windows',
      engine: SW_SHELL_LANE.engine,
      installTargets: SW_SHELL_LANE.installTargets,
    });
    expect(local.outcome).toBe('skip-host');
    expect(local.reason).toMatch(/not approved/i);
    const remote = decideLaneOutcome({
      hostApproved: false,
      isCi: true,
      browserAvailable: false,
      project: SW_SHELL_LANE.project,
      approvedHosts: SW_SHELL_LANE.hostOperatingSystems,
      actualHost: 'windows',
      engine: SW_SHELL_LANE.engine,
      installTargets: SW_SHELL_LANE.installTargets,
    });
    expect(remote.outcome).toBe('fail-host');
  });

  it('is not smuggled into the support matrix to force it to run', () => {
    // `support-matrix.ts` owns the Phase 1A cross-engine production-artifact cells;
    // this flagged-build lane is deliberately not one of them, and the matrix is
    // still internally consistent.
    expect(validateSupportMatrix()).toEqual([]);
    expect(SUPPORT_MATRIX.map((entry) => entry.project)).not.toContain(SW_SHELL_LANE.project);
    expect(COMPATIBILITY_PROJECTS as readonly string[]).not.toContain(SW_SHELL_LANE.project);
  });
});

describe('sw-shell compatibility spec', () => {
  const spec = readFileSync(path.join(REPO_ROOT, SW_SHELL_TEST_PATH), 'utf8');

  it('proves the privacy policy through the unchanged classification', () => {
    expect(spec).toContain('classifyRequestLike');
    expect(spec).toContain('buildNetworkPolicyReport');
    expect(spec).toContain('describeNetworkFailures');
    expect(spec).toContain('expect(report.violations');
    expect(spec).toMatch(/violations[\s\S]{0,120}?\.toEqual\(\[\]\);/);
    expect(spec).toContain('blockedExternalCount');
    expect(spec).toContain("requestsByDestination['external-other']");
    expect(spec).toContain("requestsByDestination['local-app-endpoint']");
    expect(spec).toContain("requestsByDestination['local-non-static']");
    expect(spec).toContain('report.webSockets.total');
  });

  it('verifies the recorded artifact before measuring, and skips only an unapproved host', () => {
    expect(spec).toContain('web-artifact-manifest.mjs');
    expect(spec).toContain(").toBe('match')");
    expect(spec.match(/test\.skip\(/g)?.length ?? 0).toBe(1);
    expect(spec).toContain('decideLaneOutcome');
    expect(spec).toContain('not selected');
    // No catch is allowed to turn a failure into a pass.
    expect(spec).not.toMatch(/\.catch\(\(\) => null\);\s*\n\s*expect\(true\)/);
  });

  it('keeps the privacy discipline: no learner data, no egress, sanitized evidence', () => {
    for (const field of ['subjectName', 'rootTopic', 'dungeonId', 'email', 'password', 'Authorization']) {
      expect(spec, field).not.toContain(field);
    }
    expect(spec).not.toContain('request.postData');
    expect(spec).not.toContain('route.fulfill');
    expect(spec).not.toContain('http://');
    expect(spec).not.toContain('https://');
    // The off-origin backstop is present, exactly as the compatibility suite and the
    // Phase 1 spy have it.
    expect(spec).toContain("url.hostname !== '127.0.0.1'");
    expect(spec).toContain("route.abort('blockedbyclient')");
    expect(spec).toContain('sanitizeToolchainText');
    expect(spec).toContain('evidenceRelativePath');
  });

  it('leaves the Phase 1 spy and the compat classification intact', () => {
    const phase1 = readFileSync(path.join(REPO_ROOT, 'tests/e2e/currentBuild.spec.ts'), 'utf8');
    expect(phase1).toContain('inspectPrivacyNetwork');
    expect(phase1).toContain('/(?:analytics|telemetry|remote[-_]?config)/i');
    expect(phase1).toContain("url.hostname !== '127.0.0.1'");
    expect(phase1).toContain("route.abort('blockedbyclient')");

    const compat = readFileSync(path.join(REPO_ROOT, 'tests/e2e/compat-evidence.ts'), 'utf8');
    expect(compat).toContain('FORBIDDEN_APP_PATH_PATTERNS');
    expect(compat).toMatch(/analytics\|telemetry\|remote/);
    expect(compat).toContain('non-idempotent-method');
    expect(compat).toContain('external-origin');
    expect(compat).toContain('non-static-local-path');
    expect(compat).toContain('export function decideLaneOutcome');
  });

  it('is hermetic: no commit lookups, and no path that depends on where the checkout lives', () => {
    for (const relative of [
      SW_SHELL_TEST_PATH,
      SW_SHELL_CONFIG_FILE,
      'tests/e2e/sw-shell-lane.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, `${relative} resolves a commit`).not.toMatch(
        /\bgit\s+(?:show|log|diff|cat-file|rev-parse|ls-tree|rev-list)\b/,
      );
      expect(source, `${relative} embeds an absolute path literal`).not.toMatch(
        /['"`]\/(?:home|tmp|Users|var)\//,
      );
    }
    expect(spec).not.toContain('process.env.HOME');
    expect(spec).not.toContain('os.homedir');
  });
});
