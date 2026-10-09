/**
 * The CC0 media gate's wiring checks.
 *
 * The gate is infrastructure, so its wiring is verified here rather than discovered
 * the first time a pull request runs it. A gate that is never executed is worse than
 * no gate, because it is read as coverage. So this file fails if:
 *
 * 1. `npm run test:licenses` disappears from `package.json`, or stops pointing at the
 *    checker script, or starts building something.
 * 2. The CI job that should run it is missing, is renamed, or stops running the npm
 *    script and starts running a raw command that could drift from it.
 * 3. **The step can go green while the registry is broken.** The exemption is asserted
 *    two ways: no `continue-on-error` key anywhere in the job, and no `|| true` or
 *    `exit 0` on the step that runs the gate. This is the property that makes the gate
 *    a gate.
 * 4. The job is not a gate at all, because nothing waits for it: `web-build` must list
 *    it in `needs`, so a media-licensing failure stops the production artifact from
 *    being built and uploaded at all.
 * 5. **The run grows a second production build.** The license gate reads the
 *    repository and nothing else, so it must not run `build:web`, must not write to
 *    `dist`, and must not record an artifact. `web-build` stays the single build,
 *    record, and upload point.
 * 6. The claim the workflow comment makes about cost - that the job needs no
 *    dependency install - stays true: the checker imports only Node built-ins, and the
 *    job does not run `npm ci`.
 * 7. The files the gate reads are actually in the repository. The registry must be
 *    tracked, and the generated sprite manifest must stay ignored, because that
 *    asymmetry is the reason one entry cannot carry a pinned checksum.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data. The files this
 * reads are the workflow, `package.json`, `.gitignore`, and the gate's own source.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const CHECKER_PATH = path.join(REPO_ROOT, 'scripts', 'check-cc0-assets.mjs');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

const LICENSE_SCRIPT = 'test:licenses';
const LICENSE_JOB = 'asset-licenses';
const LICENSE_JOB_NAME = 'Asset Licenses (CC0 registry)';
const LICENSE_STEP_NAME = 'Verify every public asset against the CC0 registry';
const REGISTRY_PATH = 'public/assets/asset-licenses.json';
const GENERATED_MANIFEST_PATH = 'public/assets/sprite-manifest.json';

const npmScripts = (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { scripts: Record<string, string> })
  .scripts;
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const checkerSource = readFileSync(CHECKER_PATH, 'utf8');

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
const licenseJob = ciJobs.get(LICENSE_JOB) ?? '';

function stepBlockFor(jobBody: string): string {
  const index = jobBody.indexOf(`name: ${LICENSE_STEP_NAME}`);
  if (index === -1) throw new Error(`The job has no step named ${LICENSE_STEP_NAME}.`);
  const next = jobBody.indexOf('\n      - ', index + 1);
  return jobBody.slice(index, next === -1 ? jobBody.length : next);
}

/** `git check-ignore` exits 0 when the path is ignored, 1 when it is not. */
function isIgnored(repoRelativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', repoRelativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe('the license gate is bound to a script an author can run locally', () => {
  it('exists as an npm script that runs the checker', () => {
    expect(npmScripts[LICENSE_SCRIPT], 'package.json has no test:licenses script').toBeDefined();
    expect(npmScripts[LICENSE_SCRIPT]).toContain('scripts/check-cc0-assets.mjs');
    // One script, so the local command and the CI step cannot diverge in what they run.
    expect(npmScripts[LICENSE_SCRIPT].split('&&')).toHaveLength(1);
  });

  it('builds nothing, so it is runnable without a build and adds no artifact', () => {
    const script = npmScripts[LICENSE_SCRIPT];
    for (const forbidden of ['build:web', 'vite build', 'npm run build', 'record:', 'playwright', 'preview']) {
      expect(script, forbidden).not.toContain(forbidden);
    }
    // And the checker itself only reads the repository: Node built-ins and nothing else,
    // which is what lets the CI job skip the dependency install.
    const imports = [...checkerSource.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^node:/);
    expect(checkerSource).not.toMatch(/require\(/);
  });

  it('the checker exists where the script says it does, and is executable through node', () => {
    const source = readFileSync(CHECKER_PATH, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    // The header has to say what the gate is for, because the next reader of a red run
    // is looking for the reason it exists.
    expect(source).toContain('plan section 10.3');
    expect(source).toContain('default PixiJS bundle');
  });
});

describe('the license gate is a gating CI job, not an advisory one', () => {
  it('runs in its own job, on the same host as the rest of the quality rails', () => {
    expect(licenseJob, `${LICENSE_JOB} job is missing from ci.yml`).not.toBe('');
    expect(licenseJob).toContain(`name: ${LICENSE_JOB_NAME}`);
    expect(licenseJob).toContain('runs-on: ubuntu-latest');
    expect(licenseJob).toContain('actions/checkout@v4');
    // The job pins the supported Node major. Node 24 is the floor declared in
    // package.json's `engines` and in `.nvmrc`.
    expect(licenseJob).toContain('node-version: 24');
  });

  it('runs the npm script, so the CI step and the local command are the same command', () => {
    const step = stepBlockFor(licenseJob);
    expect(step).toContain(`run: npm run ${LICENSE_SCRIPT}`);
    // Not a raw `node scripts/...` invocation: a raw command is a second thing to keep
    // in step with the script, and this is the property that keeps them one thing.
    expect(step).not.toContain('node scripts/check-cc0-assets.mjs');
    expect(licenseJob.split(`npm run ${LICENSE_SCRIPT}`).length - 1).toBe(1);
  });

  it('GATES: the step is not exempt, and no step in the job may be', () => {
    const step = stepBlockFor(licenseJob);
    expect(step).toContain(`npm run ${LICENSE_SCRIPT}`);
    expect(step).not.toContain('continue-on-error');
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('exit 0');
    // Matched as a YAML key at the start of a line, so the prose that discusses the
    // exemption deliberately - in this file and in the workflow's own comment - is not
    // counted as one.
    const exemptionKeys = [...licenseJob.matchAll(/^\s*continue-on-error\s*:/gm)];
    expect(exemptionKeys, 'a step in the license job is exempt from failing').toEqual([]);
    // A `continue-on-error` at job level would swallow the whole job's failure just as
    // effectively, and the same match covers it.
    expect(licenseJob).not.toMatch(/continue-on-error/);
  });

  it('is a gate rather than a report: the build waits for it', () => {
    const buildJob = ciJobs.get('web-build') ?? '';
    expect(buildJob, 'web-build job is missing from ci.yml').not.toBe('');
    const needs = /needs:\s*\[([^\]]*)\]/.exec(buildJob)?.[1] ?? '';
    expect(needs.split(',').map((entry) => entry.trim())).toContain(LICENSE_JOB);
    // Without this, a red license gate would still produce and upload the artifact.
    expect(buildJob).toContain('actions/upload-artifact@v4');
  });

  it('does not add a second production build, and does not produce a second artifact', () => {
    for (const [name, body] of ciJobs) {
      if (name === 'web-build') continue;
      expect(body, `${name} builds a second production artifact`).not.toContain('npm run build:web');
    }
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(buildJobs.map(([name]) => name)).toEqual(['web-build']);
    // The license job is read-only with respect to the artifact: it neither writes
    // `dist` nor records an artifact identity.
    const step = stepBlockFor(licenseJob);
    for (const forbidden of ['dist', 'record:', 'upload-artifact', 'build:web', 'npm ci']) {
      expect(step, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the four pull-request compatibility lanes and the one production build intact', () => {
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);
    // The license gate must not reach into a browser lane: it is a licensing check over
    // bytes, and a lane would only add cost and a second thing to keep green.
    for (const [name, body] of ciJobs) {
      if (name === LICENSE_JOB) continue;
      expect(body, name).not.toContain(`npm run ${LICENSE_SCRIPT}`);
    }
  });
});

describe('the files the gate reads are in the repository', () => {
  it('the registry is not ignored, or a fresh checkout would have no registry to gate', () => {
    // The gitignore is read as text as well as queried, so the intent is visible: the
    // registry is a reviewed artifact and the sprite manifest is a build output.
    const gitignore = readFileSync(GITIGNORE_PATH, 'utf8');
    expect(gitignore).toContain(GENERATED_MANIFEST_PATH);
    expect(gitignore).not.toContain(REGISTRY_PATH);
    expect(isIgnored(REGISTRY_PATH), `${REGISTRY_PATH} is ignored by git`).toBe(false);
    expect(isIgnored(GENERATED_MANIFEST_PATH), `${GENERATED_MANIFEST_PATH} is not ignored`).toBe(true);
  });

  it('the generator, the checker, and the registry all exist where the registry says', () => {
    const registry = JSON.parse(readFileSync(path.join(REPO_ROOT, REGISTRY_PATH), 'utf8')) as {
      assets: { generation?: { script?: string } }[];
    };
    const declared = new Set(
      registry.assets.flatMap((entry) => (entry.generation?.script ? [entry.generation.script] : [])),
    );
    expect(declared.size).toBeGreaterThan(0);
    for (const script of declared) {
      expect(readFileSync(path.join(REPO_ROOT, script), 'utf8').length, script).toBeGreaterThan(0);
    }
    expect(declared.has('scripts/check-cc0-assets.mjs')).toBe(true);
    expect(declared.has('scripts/generate-cozy-placeholders.mjs')).toBe(true);
  });
});
