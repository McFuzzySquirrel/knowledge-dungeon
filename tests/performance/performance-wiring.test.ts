/**
 * The Phase 22 route-aware performance budget gate's wiring checks.
 *
 * A gate that is added but never executed is worse than no gate, because it is read
 * as coverage. This file fails if:
 *
 * 1. `npm run check:perf` disappears from `package.json`, stops pointing at the
 *    enforcer, or starts building something.
 * 2. The enforcer imports anything but Node built-ins and sibling repository scripts,
 *    so it cannot be run by a bare `node` on the CI's supported Node.
 * 3. The enforcer re-declares a number another script owns. `LAZY_CHUNK_GZIP_BYTES`
 *    (800 KiB) is declared once in `check-memory.mjs` and `TOTAL_DIST_RAW_BYTES`
 *    (12 MB) once in `check-bundle-size.mjs`; the gate must read them, not copy them.
 * 4. The census file name is declared in two places: the build that writes it and the
 *    gate that reads it must share `scripts/performance-budgets.mjs`.
 * 5. The CI step that runs it is missing, is not in the job that already builds, or
 *    stops running the npm script for a raw command that could drift from it.
 * 6. **The step can go green while a budget is blown.** No exemption key anywhere in
 *    the `web-build` job, and neither `|| true` nor `exit 0` on the step itself.
 * 7. The step adds a second production build, or runs the gate in a job that does not
 *    build: the gate must read the one `dist` that ships.
 * 8. The release verification path runs the gate, so the number is checked on the way
 *    out and not only in CI.
 *
 * This file reads `package.json`, the workflow, and the enforcer's own source. It
 * never needs a `dist`, so it passes on a clean checkout.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const ENFORCER_PATH = path.join(REPO_ROOT, 'scripts', 'check-performance.mjs');
const MEMORY_PATH = path.join(REPO_ROOT, 'scripts', 'check-memory.mjs');
const BUNDLE_SIZE_PATH = path.join(REPO_ROOT, 'scripts', 'check-bundle-size.mjs');
const VITE_CONFIG_PATH = path.join(REPO_ROOT, 'vite.config.ts');
const BUDGETS_PATH = path.join(REPO_ROOT, 'scripts', 'performance-budgets.mjs');

const PERF_SCRIPT = 'check:perf';
const BUILD_JOB = 'web-build';
const BUILD_COMMAND = 'npm run build:web';
const PRODUCTION_UPLOAD_STEP = 'Upload the shared production web artifact';
const DEFAULT_PERF_STEP = 'Enforce the route-aware performance budgets on the built artifact';

const npmScripts = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).scripts as Record<string, string>;
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const enforcerSource = readFileSync(ENFORCER_PATH, 'utf8');
const memorySource = readFileSync(MEMORY_PATH, 'utf8');
const bundleSizeSource = readFileSync(BUNDLE_SIZE_PATH, 'utf8');
const viteConfigSource = readFileSync(VITE_CONFIG_PATH, 'utf8');
const budgetsSource = readFileSync(BUDGETS_PATH, 'utf8');

/** Splits the workflow into job blocks keyed by job id. */
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

/** The text of one named step in a job, up to the next step. */
function stepBlockFor(jobBody: string, stepName: string): string {
  const index = jobBody.indexOf(`name: ${stepName}`);
  if (index === -1) throw new Error(`The job has no step named ${stepName}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

const ciJobs = parseWorkflowJobs(ciWorkflow);
const buildJob = ciJobs.get(BUILD_JOB) ?? '';

describe('the gate is bound to a script an author can run locally', () => {
  it('exists as an npm script that runs the enforcer', () => {
    expect(npmScripts[PERF_SCRIPT], `package.json has no ${PERF_SCRIPT} script`).toBeDefined();
    expect(npmScripts[PERF_SCRIPT]).toContain('scripts/check-performance.mjs');
    // One command, so the local invocation and the CI step cannot diverge.
    expect(npmScripts[PERF_SCRIPT].split('&&')).toHaveLength(1);
  });

  it('builds nothing itself, so it cannot add a build to the run', () => {
    for (const forbidden of ['build:web', 'vite build', 'npm run build', 'record:', 'playwright', 'preview']) {
      expect(npmScripts[PERF_SCRIPT], forbidden).not.toContain(forbidden);
    }
  });

  it('is run by the release verification path, after the build', () => {
    const release = npmScripts['release:verify'] ?? '';
    expect(release, 'release:verify does not run the performance budget gate').toContain(
      `npm run ${PERF_SCRIPT}`,
    );
    expect(release.indexOf(BUILD_COMMAND)).toBeLessThan(release.indexOf(`npm run ${PERF_SCRIPT}`));
  });
});

describe('the enforcer runs on Node alone and does not re-declare a budget', () => {
  it('imports only Node built-ins and sibling repository scripts', () => {
    expect(enforcerSource.startsWith('#!/usr/bin/env node')).toBe(true);
    const imports = [...enforcerSource.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, specifier).toMatch(/^(node:|\.\/)/);
    }
    expect(enforcerSource).not.toMatch(/require\(/);
  });

  it('reads the 800 KiB ceiling from check-memory and the 12 MB ceiling from check-bundle-size', () => {
    expect(enforcerSource).toContain("from './check-memory.mjs'");
    expect(enforcerSource).toContain('LAZY_CHUNK_GZIP_BYTES');
    expect(enforcerSource).toContain("from './check-bundle-size.mjs'");
    expect(enforcerSource).toContain('TOTAL_DIST_RAW_BYTES');
    // The numbers themselves are not re-declared here.
    expect(enforcerSource).not.toMatch(/\b800\s*\*\s*1024\b/);
    expect(enforcerSource).not.toMatch(/\b12_000_000\b/);
    expect(enforcerSource).not.toMatch(/\b12000000\b/);
  });

  it('leaves each number with its single owning declaration', () => {
    expect(memorySource).toMatch(/LAZY_CHUNK_GZIP_BYTES\s*=\s*800 \* 1024/);
    expect(bundleSizeSource).toMatch(/TOTAL_DIST_RAW_BYTES\s*=\s*12_000_000/);
  });

  it('shares the census file name with the build that writes it', () => {
    expect(budgetsSource).toContain('BUNDLE_CENSUS_FILENAME');
    expect(viteConfigSource).toContain('./scripts/performance-budgets.mjs');
    expect(viteConfigSource).toContain('BUNDLE_CENSUS_FILENAME');
    expect(enforcerSource).toContain("from './performance-budgets.mjs'");
    // The gate reads the census rather than re-walking the emitted import graph.
    expect(enforcerSource).toContain('BUNDLE_CENSUS_FILENAME');
    expect(enforcerSource).not.toContain("from './vite.config");
  });
});

describe('the enforcer states the boundary of what it measures', () => {
  it('names the plan and the route-aware numbers it enforces', () => {
    expect(enforcerSource).toContain('plan section 10.2');
    expect(enforcerSource).toContain('800 KB gzip');
    expect(enforcerSource).toContain('12 MB ceiling');
  });

  it('names the failure modes a reader would otherwise have to infer', () => {
    for (const finding of [
      'missing-boundary-chunk',
      'oversized-boundary',
      'no-lazy-boundary',
      'stale-census',
      'dist-over-budget',
    ]) {
      expect(enforcerSource, finding).toContain(`'${finding}'`);
    }
  });

  it('says out loud that the runtime targets are not measured here', () => {
    expect(enforcerSource).toContain('NOT MEASURED HERE');
    expect(enforcerSource).toContain('interaction acknowledgement under 100 ms');
    expect(enforcerSource).toContain('p95 frame time under 20 ms');
  });

  it('reads no learner data and makes no network request', () => {
    for (const forbidden of ['localhost', 'createServer', '127.0.0.1', 'fetch(', 'http:']) {
      expect(enforcerSource, forbidden).not.toContain(forbidden);
    }
    expect(enforcerSource).not.toMatch(/\bsubject\b/i);
    expect(enforcerSource).not.toMatch(/\battachment\b/i);
  });
});

describe('the gate is gating CI, not an advisory step', () => {
  it('runs in the job that already builds, before the production artifact is uploaded', () => {
    expect(buildJob, `${BUILD_JOB} job is missing from ci.yml`).not.toBe('');
    expect(buildJob).toContain(BUILD_COMMAND);
    expect(buildJob.indexOf(BUILD_COMMAND)).toBeLessThan(buildJob.indexOf(`name: ${DEFAULT_PERF_STEP}`));
    expect(buildJob.indexOf(`name: ${DEFAULT_PERF_STEP}`)).toBeLessThan(
      buildJob.indexOf(PRODUCTION_UPLOAD_STEP),
    );
  });

  it('runs the npm script, so the CI step and the local command are the same command', () => {
    const step = stepBlockFor(buildJob, DEFAULT_PERF_STEP);
    expect(step).toContain(`run: npm run ${PERF_SCRIPT}`);
    expect(step).not.toContain('node scripts/check-performance.mjs');
  });

  it('GATES: the step is not exempt, and no step in the build job may be', () => {
    const step = stepBlockFor(buildJob, DEFAULT_PERF_STEP);
    expect(step).not.toContain('continue-on-error');
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('exit 0');
    const exemptionKeys = [...buildJob.matchAll(/^\s*continue-on-error\s*:/gm)];
    expect(exemptionKeys, 'a step in the build job is exempt from failing').toEqual([]);
  });

  it('runs on the default, Pixi-flagged, and offline-shell-flagged artifacts once each', () => {
    const occurrences = buildJob.split(`npm run ${PERF_SCRIPT}`).length - 1;
    expect(occurrences, 'the build job does not run check:perf exactly three times').toBe(3);
    // The Pixi and offline boundaries only exist on their flagged builds, so the gate
    // is run where each is emitted rather than only on the default artifact.
    expect(buildJob).toContain('Enforce the route-aware performance budgets on the Pixi-flagged artifact');
    expect(buildJob).toContain('Enforce the route-aware performance budgets on the offline-shell artifact');
  });

  it('does not add a second production build, and runs the gate only where a build exists', () => {
    for (const [name, body] of ciJobs) {
      if (name === BUILD_JOB) continue;
      expect(body, `${name} runs the performance budget gate against a build it does not make`).not.toContain(
        `npm run ${PERF_SCRIPT}`,
      );
      expect(body, `${name} builds a second production artifact`).not.toContain(BUILD_COMMAND);
    }
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes(BUILD_COMMAND));
    expect(buildJobs.map(([name]) => name)).toEqual([BUILD_JOB]);
  });
});
