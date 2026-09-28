/**
 * The Welcome budget gate's wiring checks.
 *
 * The gate is infrastructure, so its wiring is verified here rather than discovered the
 * first time a pull request runs it. A gate that is never executed is worse than no
 * gate, because it is read as coverage - and this one had no committed form at all
 * until now, so the wiring is exactly the thing that could have been left unwritten.
 *
 * This file fails if:
 *
 * 1. `npm run check:budget:welcome` disappears from `package.json`, stops pointing at
 *    the enforcer script, or starts building something.
 * 2. The enforcer script is missing, is not runnable through node, or does not state
 *    the plan budget its name claims to enforce.
 * 3. The CI step that should run it is missing, is not in the job that already builds,
 *    or stops running the npm script and starts running a raw command that could drift
 *    from it.
 * 4. **The step can go green while the budget is blown.** The exemption is asserted
 *    two ways, the same pair the sibling license gate uses: no exemption key anywhere in
 *    the `web-build` job, and neither `|| true` nor `exit 0` on the step itself. A
 *    warning that reads as coverage is how a 300 KiB budget becomes 400 KiB quietly.
 * 5. The step adds a second production build, or a second artifact. `web-build` stays
 *    the single build, record, and upload point; the whole reason the measurement is
 *    trustworthy is that it reads the one `dist` that is about to be uploaded.
 * 6. The measurement is not pinned to the plan. The budget is 300 KiB, the lazy
 *    renderer exclusions are the two chunk families plan section 10.2 names, and the
 *    script is deterministic: gzip level 9, paths sorted, no dev server and no clock.
 * 7. The release verification path runs the gate, so the number is checked on the way
 *    out and not only in CI.
 *
 * The measurement logic itself is covered by `welcome-budget-measure.test.ts`, which
 * uses synthetic trees and in-memory buffers and so never needs a `dist` to exist.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data. The files this
 * reads are the workflow, `package.json`, and the enforcer's own source. No asset,
 * registry, or IndexedDB store is touched, and no test in this file depends on a build.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { WELCOME_BUDGET_BYTES, WELCOME_BUDGET_KIB } from './support/welcomeBudgetGate';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const ENFORCER_PATH = path.join(REPO_ROOT, 'scripts', 'check-welcome-budget.mjs');

const BUDGET_SCRIPT = 'check:budget:welcome';
const BUDGET_STEP_NAME = 'Enforce the Welcome initial payload budget';
const BUILD_JOB = 'web-build';

const npmScripts = (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { scripts: Record<string, string> })
  .scripts;
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const enforcerSource = readFileSync(ENFORCER_PATH, 'utf8');

/** Splits the workflow into job blocks keyed by job id, as the other lane gates do. */
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

const ciJobs = parseWorkflowJobs(ciWorkflow);
const buildJob = ciJobs.get(BUILD_JOB) ?? '';

function stepBlockFor(jobBody: string): string {
  const index = jobBody.indexOf(`name: ${BUDGET_STEP_NAME}`);
  if (index === -1) throw new Error(`The job has no step named ${BUDGET_STEP_NAME}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

describe('the Welcome budget is bound to a script an author can run locally', () => {
  it('exists as an npm script that runs the enforcer', () => {
    expect(npmScripts[BUDGET_SCRIPT], `package.json has no ${BUDGET_SCRIPT} script`).toBeDefined();
    expect(npmScripts[BUDGET_SCRIPT]).toContain('scripts/check-welcome-budget.mjs');
    // One script, so the local command and the CI step cannot diverge in what they run.
    expect(npmScripts[BUDGET_SCRIPT].split('&&')).toHaveLength(1);
  });

  it('is run by the release verification path, so the number is checked on the way out', () => {
    const release = npmScripts['release:verify'] ?? '';
    expect(release, 'release:verify does not run the Welcome budget gate').toContain(
      `npm run ${BUDGET_SCRIPT}`,
    );
    // After the build, or it has nothing to measure - and this gate fails rather than
    // passing an unmeasured build, so ordering it before the build would be a red run.
    expect(release.indexOf('npm run build:web')).toBeLessThan(release.indexOf(`npm run ${BUDGET_SCRIPT}`));
  });

  it('builds nothing itself, so it cannot add a build to the run', () => {
    const script = npmScripts[BUDGET_SCRIPT];
    for (const forbidden of ['build:web', 'vite build', 'npm run build', 'record:', 'playwright', 'preview']) {
      expect(script, forbidden).not.toContain(forbidden);
    }
  });

  it('the enforcer exists where the script says it does, and is executable through node', () => {
    expect(enforcerSource.startsWith('#!/usr/bin/env node')).toBe(true);
    // The header has to name the plan budget, because the next reader of a red run is
    // looking for the reason it exists and where the number came from.
    expect(enforcerSource).toContain('plan section 10.2');
    expect(enforcerSource).toContain('300 KB');
    // And it must be runnable with no install step beyond Node itself.
    const imports = [...enforcerSource.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^node:/);
    expect(enforcerSource).not.toMatch(/require\(/);
  });
});

describe('the budget enforcer measures the plan budget, deterministically', () => {
  it('pins 300 KiB, and reports it in the unit it enforces', () => {
    // Enforced as integer bytes, so the printed figure and the compared figure cannot
    // disagree through a rounding step. The arithmetic is 300 * 1024.
    expect(enforcerSource).toMatch(/WELCOME_BUDGET_BYTES\s*=\s*300 \* 1024/);
    expect(WELCOME_BUDGET_BYTES).toBe(307_200);
    expect(WELCOME_BUDGET_KIB).toBe(300);
  });

  it('excludes exactly the lazy renderer chunk families plan section 10.2 names', () => {
    // Both families are asserted by name, because a chunk family that stops matching
    // silently re-enters the total and fails a build that has not grown.
    expect(enforcerSource).toContain('vendor-phaser');
    expect(enforcerSource).toMatch(/\^vendor-phaser-/);
    expect(enforcerSource).toContain('polyfills-legacy');
    expect(enforcerSource).toMatch(/\^polyfills-legacy-/);
    // The modern polyfill chunk is initial, not a lazy renderer bundle: only the
    // `-legacy-` family is excluded, and the pattern is anchored on the family name.
    expect(enforcerSource).not.toMatch(/\^polyfills-(?!legacy-)/);
    // And the exclusions are prefix patterns, never a content hash, which changes on
    // every build.
    expect(enforcerSource).not.toMatch(/vendor-phaser-[A-Za-z0-9_-]{6,}\./);
  });

  it('counts module scripts, modulepreloads, and linked stylesheets, and nothing else', () => {
    for (const kind of ['js-module', 'js-modulepreload', 'css-stylesheet']) {
      expect(enforcerSource, kind).toContain(kind);
    }
  });

  it('is deterministic: a stated gzip level, no clock, and no dev server', () => {
    expect(enforcerSource).toMatch(/GZIP_LEVEL\s*=\s*9/);
    // A clock in the measured path would make the number a coin flip, which is the same
    // argument the procedural generator makes for carrying no timestamp.
    expect(enforcerSource).not.toMatch(/\bDate\b/);
    expect(enforcerSource).not.toMatch(/Math\.random/);
    expect(enforcerSource).not.toMatch(/localhost|createServer|127\.0\.0\.1/);
  });

  it('fails rather than passing a build it could not measure', () => {
    // The specific divergence from check:bundle-size.mjs, which exits 0 when dist is
    // absent. That is fine for a check a developer may run before building and not
    // fine for a gate, so it is asserted as a property of this script.
    expect(enforcerSource).toMatch(/no built entry document/);
    expect(enforcerSource).toMatch(/not reported, because a silently dropped reference/);
  });
});

describe('the Welcome budget gate is gating CI, not an advisory step', () => {
  it('runs in the job that already builds, so it reads the artifact that ships', () => {
    expect(buildJob, `${BUILD_JOB} job is missing from ci.yml`).not.toBe('');
    expect(buildJob).toContain('npm run build:web');
    // Before the build would mean measuring a stale or absent dist, and after the
    // artifact upload would mean reporting a failure nobody can act on.
    expect(buildJob.indexOf('npm run build:web')).toBeLessThan(buildJob.indexOf(`name: ${BUDGET_STEP_NAME}`));
    expect(buildJob.indexOf(`name: ${BUDGET_STEP_NAME}`)).toBeLessThan(
      buildJob.indexOf('Upload the shared production web artifact'),
    );
  });

  it('runs the npm script, so the CI step and the local command are the same command', () => {
    const step = stepBlockFor(buildJob);
    expect(step).toContain(`run: npm run ${BUDGET_SCRIPT}`);
    // Not a raw `node scripts/...` invocation: a raw command is a second thing to keep
    // in step with the script, and this is the property that keeps them one thing.
    expect(step).not.toContain('node scripts/check-welcome-budget.mjs');
    expect(buildJob.split(`npm run ${BUDGET_SCRIPT}`).length - 1).toBe(1);
  });

  it('GATES: the step is not exempt, and no step in the build job may be', () => {
    const step = stepBlockFor(buildJob);
    expect(step).toContain(`npm run ${BUDGET_SCRIPT}`);
    expect(step).not.toContain('continue-on-error');
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('exit 0');
    // Matched as a YAML key at the start of a line, so the prose that discusses the
    // exemption deliberately - in this file and in the workflow's own comment - is not
    // counted as one.
    const exemptionKeys = [...buildJob.matchAll(/^\s*continue-on-error\s*:/gm)];
    expect(exemptionKeys, 'a step in the build job is exempt from failing').toEqual([]);
    // At job level it would swallow the whole job's failure just as effectively, and
    // the same match covers it.
    expect(buildJob).not.toMatch(/continue-on-error/);
  });

  it('does not add a second production build, and does not produce a second artifact', () => {
    for (const [name, body] of ciJobs) {
      if (name === BUILD_JOB) continue;
      expect(body, `${name} builds a second production artifact`).not.toContain('npm run build:web');
      // The budget is a property of the one production `dist`, so no compatibility
      // lane or flagged lane re-measures a different build as if it were the release.
      expect(body, `${name} runs the Welcome budget against its own build`).not.toContain(
        `npm run ${BUDGET_SCRIPT}`,
      );
    }
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(buildJobs.map(([name]) => name)).toEqual([BUILD_JOB]);
    // Read-only with respect to the artifact: the gate measures, it never rewrites.
    const step = stepBlockFor(buildJob);
    for (const forbidden of ['upload-artifact', 'rm -rf', 'record:web-artifact']) {
      expect(step, forbidden).not.toContain(forbidden);
    }
    // One shared artifact, uploaded once.
    expect(ciWorkflow.split('Upload the shared production web artifact').length - 1).toBe(1);
  });

  it('keeps the four pull-request compatibility lanes and the one production build intact', () => {
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);
  });
});
