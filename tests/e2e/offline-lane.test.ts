import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_CONFIG,
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
} from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX, NON_CUTOVER_FLAG_KEYS } from '@/config/featureFlags';
import offlineConfig from './playwright.offline.config';
import playwrightConfig from '../../playwright.config';
import {
  OFFLINE_LANE,
  OFFLINE_LANE_CI_BUILD_JOB,
  OFFLINE_LANE_CI_DOWNLOAD_STEP,
  OFFLINE_LANE_CI_JOB,
  OFFLINE_LANE_CI_RUN_COMMAND,
  OFFLINE_LANE_CI_RUN_STEP,
  OFFLINE_LANE_CI_UPLOAD_ARTIFACT,
  OFFLINE_LANE_CI_UPLOAD_STEP,
  OFFLINE_LANE_CI_VERIFY_STEP,
  OFFLINE_LANE_MANIFEST_PATH,
  OFFLINE_LANE_PREFLIGHT_COMMAND,
  OFFLINE_LANE_RECORD_SCRIPT,
  OFFLINE_LANE_TEST_PATH,
  OFFLINE_LANE_VERIFY_SCRIPT,
  validateOfflineLane,
} from './offline-lane';
import {
  DOWNLOAD_DECLARATION,
  UPLOAD_DECLARATION,
  auditJobTransfers,
} from './artifact-transfer-wiring';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');

/**
 * Phase 22 offline-shell lane wiring.
 *
 * The claims here are the boundaries the spike must not cross: the lane's own
 * project allows service workers, every other lane and the global config still
 * block them, the flag defaults off, the package scripts that build and run the
 * lane exist, and the CI wiring moves exactly one flagged artifact through the
 * shared transfer declaration. Nothing here builds or launches a browser.
 */

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

describe('the Phase 22 offline-shell lane is wired and bounded', () => {
  it('declares a structurally consistent lane', () => {
    expect(validateOfflineLane()).toEqual([]);
    expect(existsSync(path.join(REPO_ROOT, OFFLINE_LANE_TEST_PATH))).toBe(true);
  });

  it('allows service workers for this lane only', () => {
    expect(offlineConfig.use?.serviceWorkers).toBe('allow');
    expect(offlineConfig.testMatch).toBe(OFFLINE_LANE.testFile);
    // The global privacy policy and every other lane keep blocking.
    expect(playwrightConfig.use?.serviceWorkers).toBe('block');
  });

  it('records no raw failure artifact', () => {
    for (const key of ['trace', 'screenshot', 'video'] as const) {
      expect(offlineConfig.use?.[key], key).toBe('off');
    }
  });

  it('defaults the flag on after the cutover and keeps it a cutover gate', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.offlineShell).toBe('VITE_OFFLINE_SHELL');
    // Phase 23 makes the offline shell the production default; `false` is the one-release
    // rollback and still removes the worker, manifest, and registration script.
    expect(DEFAULT_RUNTIME_CONFIG.offlineShell).toBe(true);
    expect(FEATURE_FLAG_MATRIX.offlineShell.productionDefault).toBe(true);
    expect(parseRuntimeConfig({ VITE_OFFLINE_SHELL: 'false' }).offlineShell).toBe(false);
    expect(FEATURE_FLAG_MATRIX.offlineShell.ownerPhase).toBe(22);
    expect(NON_CUTOVER_FLAG_KEYS).not.toContain('offlineShell');
  });

  it('exposes the build, record, verify, and run scripts', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const name of [
      'build:web:offline',
      'record:web-artifact:offline',
      'verify:web-artifact:offline',
      'test:e2e:offline',
      'test:e2e:offline:full',
      'test:e2e:offline:recorded',
    ]) {
      expect(pkg.scripts?.[name], name).toBeTruthy();
    }
    // The recorded-identity commands and the preflight are shared with the
    // service-worker compatibility lane, so they live in the declaration.
    expect(OFFLINE_LANE_RECORD_SCRIPT).toBe('record:web-artifact:offline');
    expect(OFFLINE_LANE_VERIFY_SCRIPT).toBe('verify:web-artifact:offline');
    expect(OFFLINE_LANE_PREFLIGHT_COMMAND).toBe('node scripts/require-offline-lane-artifact.mjs');
  });
});

describe('the Phase 22 offline-shell CI wiring (ci.yml)', () => {
  const job = ciJobs.get(OFFLINE_LANE_CI_JOB) ?? '';
  const buildJob = ciJobs.get(OFFLINE_LANE_CI_BUILD_JOB) ?? '';

  it('builds, records, verifies and uploads the flagged artifact once, in the build job', () => {
    expect(OFFLINE_LANE_CI_BUILD_JOB).toBe('web-build');
    expect(buildJob).toContain('npm run build:web:offline');
    expect(buildJob).toContain(`npm run ${OFFLINE_LANE_RECORD_SCRIPT}`);
    expect(buildJob).toContain(`npm run ${OFFLINE_LANE_VERIFY_SCRIPT}`);
    const upload = stepBlockFor(buildJob, OFFLINE_LANE_CI_UPLOAD_STEP);
    expect(upload).toContain(`name: ${OFFLINE_LANE_CI_UPLOAD_ARTIFACT}`);
    expect(upload).toContain(OFFLINE_LANE_MANIFEST_PATH);
    expect(upload).toContain('dist');
    // Build-level only: no browser is installed for a flagged build.
    expect(buildJob).not.toContain(OFFLINE_LANE_CI_RUN_COMMAND);
  });

  it('downloads, verifies, and runs that one artifact in the browser job', () => {
    expect(OFFLINE_LANE_CI_JOB).toBe('browser-smoke');
    const download = stepBlockFor(job, OFFLINE_LANE_CI_DOWNLOAD_STEP);
    expect(download).toContain(`name: ${OFFLINE_LANE_CI_UPLOAD_ARTIFACT}`);
    expect(download).toMatch(/^\s*uses: actions\/download-artifact@v4$/m);
    expect(stepBlockFor(job, OFFLINE_LANE_CI_VERIFY_STEP)).toContain(
      `npm run ${OFFLINE_LANE_VERIFY_SCRIPT}`,
    );
    const run = stepBlockFor(job, OFFLINE_LANE_CI_RUN_STEP);
    expect(run).toContain(OFFLINE_LANE_CI_RUN_COMMAND);
    // The lane previews and measures; it never builds, records, or downloads.
    for (const forbidden of ['download-artifact', 'npm run build:', 'record:web-artifact', 'continue-on-error']) {
      expect(run, `${OFFLINE_LANE_CI_RUN_STEP}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('orders the discard, download, verify and lane run correctly', () => {
    const order = [
      'Discard the production dist before the offline-shell download',
      `name: ${OFFLINE_LANE_CI_DOWNLOAD_STEP}`,
      `name: ${OFFLINE_LANE_CI_VERIFY_STEP}`,
      `name: ${OFFLINE_LANE_CI_RUN_STEP}`,
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = job.indexOf(marker);
      expect(at, `${marker} is missing from ${OFFLINE_LANE_CI_JOB}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('holds both artifact movements as the shared declaration, not a count', () => {
    expect(
      auditJobTransfers(ciWorkflow, OFFLINE_LANE_CI_JOB, DOWNLOAD_DECLARATION),
      'browser-smoke moves something other than the declared downloads',
    ).toEqual([]);
    expect(
      auditJobTransfers(ciWorkflow, OFFLINE_LANE_CI_BUILD_JOB, UPLOAD_DECLARATION),
      'web-build uploads something other than the declared artifacts',
    ).toEqual([]);
  });

  it('leaves no step in the browser job exempt from failing', () => {
    expect([...job.matchAll(/^\s*continue-on-error\s*:/gm)].length, 'a step is exempt').toBe(0);
  });
});
