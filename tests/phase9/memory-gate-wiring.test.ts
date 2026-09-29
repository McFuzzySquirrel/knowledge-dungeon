/**
 * The Phase 9 memory gate's wiring checks, and the wiring of the Pixi-flagged build.
 *
 * ## Why this file exists
 *
 * Phase 9's verification block names `npm run check:memory` and no such script
 * existed, so the phase was unbuildable as written. A gate that is added but never
 * executed is worse than no gate, because it is read as coverage - and this one had
 * no committed form at all, which means the wiring is exactly the thing that could
 * have been left unwritten. So this file fails if:
 *
 * 1. `npm run check:memory` disappears from `package.json`, stops pointing at the
 *    enforcer, or starts building something.
 * 2. The enforcer is missing, is not runnable through node, imports anything but Node
 *    built-ins, or stops saying what it cannot prove.
 * 3. The CI step that should run it is missing, is not in the job that already builds,
 *    or stops running the npm script for a raw command that could drift from it.
 * 4. **The step can go green while the plan ceiling is blown.** The exemption is
 *    asserted the way the sibling gates assert it: no exemption key anywhere in the
 *    `web-build` job, and neither `|| true` nor `exit 0` on the step itself. The key
 *    is matched as a YAML key at the start of a line, so the prose that discusses the
 *    exemption deliberately is not counted as one.
 * 5. The step adds a second production build, or a second uploaded artifact.
 * 6. The Pixi-flagged build is not exercised in CI, or is exercised by a second job
 *    that pays for a second install or a browser a pull request does not otherwise
 *    need, or is recorded or uploaded as if it were the production artifact.
 * 7. The production default changed. `VITE_WORLD_RENDERER` must still be `phaser`
 *    when nothing sets it, and `npm run build:web` must not set it.
 * 8. The release verification path runs the memory gate, so the number is checked on
 *    the way out and not only in CI.
 *
 * ## Hermeticity
 *
 * This file reads `package.json`, the workflow, and the enforcer's own source. It
 * resolves no commit and asserts nothing about a `dist/`, so it passes on a clean
 * checkout before anything has been built. The measurement logic itself is covered by
 * `memory-preflight.test.ts`, which uses synthetic trees and so never needs a build
 * either.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data. No asset,
 * registry, or IndexedDB store is touched.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseWorkflowJobs,
  REPO_ROOT,
  sourceOf,
  stepBlockFor,
} from './support/phase9Build';

const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const ENFORCER_PATH = path.join(REPO_ROOT, 'scripts', 'check-memory.mjs');

const MEMORY_SCRIPT = 'check:memory';
const MEMORY_STEP_NAME = 'Enforce the renderer memory preflight on the built artifact';
const PIXI_STEP_NAME = 'Build the Phase 9 Pixi-flagged artifact';
const PIXI_MEMORY_STEP_NAME = 'Enforce the renderer memory preflight on the Pixi-flagged artifact';
const BUILD_JOB = 'web-build';
const PIXI_BUILD_SCRIPT = 'build:web:pixi';

/** The step names that fix the production artifact's identity and ship it. */
const RECORD_STEP_NAME = 'Record the shared production artifact identity';
const VERIFY_STEP_NAME = 'Verify the shared production artifact identity';
const PRODUCTION_UPLOAD_STEP_NAME = 'Upload the shared production web artifact';

/** The two jobs that consume the uploaded production artifact. */
const PRODUCTION_ARTIFACT_CONSUMERS = ['browser-smoke', 'compatibility-pr'];

/** The artifact name every consumer downloads. */
const PRODUCTION_ARTIFACT_NAME = 'web-artifact';

interface Step {
  readonly name: string;
  /** The step's own text, comments included. */
  readonly body: string;
  /** The step's `uses:` action, or `''` for a `run:` step. */
  readonly uses: string;
  /**
   * The command the step runs, with a YAML block scalar (`run: |`) folded in and
   * comment lines removed. `''` for a `uses:` step, which runs no command here.
   */
  readonly command: string;
}

/**
 * Splits a job body into its steps.
 *
 * A step starts at a `      - ` list item, which is how the workflow indents them
 * under `steps:`. Comments sit at the same indentation as a step's body, so a comment
 * block attaches to the step that follows it. That is the right place for it - the
 * prose explains the step it introduces - and it is why `command` strips comment lines
 * rather than the prose being allowed to satisfy or trip a scan.
 */
function stepsOf(jobBody: string): Step[] {
  const starts: number[] = [];
  const pattern = /^ {6}- /gm;
  for (let match = pattern.exec(jobBody); match !== null; match = pattern.exec(jobBody)) {
    starts.push(match.index);
  }
  return starts.map((start, index) => {
    const body = jobBody.slice(start, starts[index + 1] ?? jobBody.length);
    const named = /^ {6}- name: (.+)$/m.exec(body);
    const uses = /^ {6}(?:  )?uses: (.+)$/m.exec(body);
    return {
      name: named?.[1] ?? '(unnamed step)',
      body,
      uses: uses?.[1] ?? '',
      command: runCommandOf(body),
    };
  });
}

/**
 * The command a `run:` step executes, with a block scalar folded in.
 *
 * Folding matters because a multi-line `run: |` is how the workflow records a shell
 * snippet, and a scan that only read the first line would miss every command after it -
 * which is exactly the shape of a gate that reports clean because it measured the wrong
 * thing. A step with `uses:` has no command here and yields `''`.
 */
function runCommandOf(stepBody: string): string {
  const match = /^ {6}(?:  )?run: (.+)$/m.exec(stepBody);
  if (match === null) return '';
  const first = match[1].trim();
  if (first !== '|' && first !== '>' && first !== '|-' && first !== '>-') return first;
  const after = stepBody.slice(match.index + match[0].length);
  const lines: string[] = [];
  for (const line of after.split('\n')) {
    // The block ends at the first line that is not more indented than the `run:` key.
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!/^ {8}/.test(line)) break;
    lines.push(line);
  }
  return [first, ...lines]
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .trim();
}

/**
 * True when a step's command names the build output directory.
 *
 * `dist/` and a bare `dist` token both count, and a path *ending* in `dist` counts
 * too, so `./dist`, `dist/assets`, and `rm -rf dist` are all caught. What does not
 * count is a word that merely contains those characters, which is why the boundary is
 * written as a token rather than a substring.
 */
function namesDist(step: Step): boolean {
  return /(?:^|[\s'"=/])dist(?:\/|['"\s]|$)/m.test(step.command);
}

/**
 * npm scripts that read the repository's `dist` without naming it on the command line,
 * because the script's own default argument points there.
 *
 * Listed rather than inferred, because the alternative is a text scan that reports
 * "no step reads dist" while a step runs a gate whose entire job is to read the
 * artifact. Both of these take `dist` by default and accept `--dist=DIR` for a test
 * fixture; a CI step that passes an explicit path is measuring something other than
 * this runner's build output, so the no-argument form is the one that matters here.
 */
const DIST_BY_DEFAULT_SCRIPTS = ['check:memory', 'check:bundle-size', 'check:budget:welcome'];

/** True when a step reads this runner's build output, by name or by script default. */
function readsDist(step: Step): boolean {
  if (namesDist(step)) return true;
  return DIST_BY_DEFAULT_SCRIPTS.some(
    (script) => new RegExp(`npm run ${script}(?![\\w:-])`).test(step.command),
  );
}

/** The index of the named step in a job, or `-1`. */
function stepIndex(jobBody: string, stepName: string): number {
  return stepsOf(jobBody).findIndex((step) => step.name === stepName);
}

const npmScripts = (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { scripts: Record<string, string> })
  .scripts;
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const enforcerSource = readFileSync(ENFORCER_PATH, 'utf8');

const ciJobs = parseWorkflowJobs(ciWorkflow);
const buildJob = ciJobs.get(BUILD_JOB) ?? '';

describe('the memory gate is bound to a script an author can run locally', () => {
  it('exists as an npm script that runs the enforcer', () => {
    expect(npmScripts[MEMORY_SCRIPT], `package.json has no ${MEMORY_SCRIPT} script`).toBeDefined();
    expect(npmScripts[MEMORY_SCRIPT]).toContain('scripts/check-memory.mjs');
    // One script, so the local command and the CI step cannot diverge in what they run.
    expect(npmScripts[MEMORY_SCRIPT].split('&&')).toHaveLength(1);
  });

  it('builds nothing itself, so it cannot add a build to the run', () => {
    const script = npmScripts[MEMORY_SCRIPT];
    for (const forbidden of ['build:web', 'vite build', 'npm run build', 'record:', 'playwright', 'preview']) {
      expect(script, forbidden).not.toContain(forbidden);
    }
  });

  it('is run by the release verification path, after the build', () => {
    const release = npmScripts['release:verify'] ?? '';
    expect(release, 'release:verify does not run the renderer memory preflight').toContain(
      `npm run ${MEMORY_SCRIPT}`,
    );
    expect(release.indexOf('npm run build:web')).toBeLessThan(release.indexOf(`npm run ${MEMORY_SCRIPT}`));
  });

  it('the enforcer exists where the script says it does, and runs on Node alone', () => {
    expect(enforcerSource.startsWith('#!/usr/bin/env node')).toBe(true);
    const imports = [...enforcerSource.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier, specifier).toMatch(/^node:/);
    expect(enforcerSource).not.toMatch(/require\(/);
  });
});

describe('the enforcer states the boundary of what it measures', () => {
  it('names the plan section it enforces and the number it enforces', () => {
    expect(enforcerSource).toContain('plan section 10.2');
    expect(enforcerSource).toContain('800 KB gzip');
    expect(enforcerSource).toMatch(/LAZY_CHUNK_GZIP_BYTES\s*=\s*800 \* 1024/);
    // The two properties the header quotes are the plan's, word for word, so a reader
    // of a red run can find the criterion rather than guess at it.
    expect(enforcerSource).toContain('No material canvas or GPU memory growth over 20 world mount and unmount cycles.');
    expect(enforcerSource).toContain('Correct Pixi Application and asset-bundle teardown.');
  });

  it('says out loud that it cannot measure a mount/unmount leak', () => {
    // The whole reason this file reads the enforcer's source rather than only its exit
    // code: a green run that a reader mistakes for a leak measurement is the failure
    // this gate could still cause while being correct.
    expect(enforcerSource).toContain('What this script CANNOT prove, and will not claim');
    expect(enforcerSource).toMatch(/Canvas count, GPU texture memory, WebGL context loss/);
    // Matched across a line break rather than against one exact wrapping, so a
    // reflow of the comment cannot silently un-hold the assertion.
    expect(enforcerSource).toMatch(/Nothing in this file, and no line of its\s*\n\s*\*\s*output/);
    expect(enforcerSource).toMatch(/it is listed\s*\n\s*\*\s*here as the remaining gap/);
    expect(enforcerSource).toMatch(/neither of which this phase's dependency-and-build work owns/);
    expect(enforcerSource).toContain('NOT MEASURED');
    expect(enforcerSource).toContain('is not a mount/unmount leak measurement.');
  });

  it('names the failure modes a reader would otherwise have to infer', () => {
    for (const finding of [
      'eager-pixi',
      'oversized-renderer',
      'no-renderer-chunk',
      'no-assets-tree',
      // The exported-API half: an undeclared family is a finding in sentence form,
      // not a TypeError. Asserted behaviourally in `memory-preflight.test.ts`; named
      // here so a rename cannot drop the code from the report without this failing.
      'unknown-renderer-family',
    ]) {
      expect(enforcerSource, finding).toContain(`'${finding}'`);
    }
  });

  it('distinguishes an absent renderer family from a measured clean one, in the source and the output', () => {
    // MINOR 4. The default production build has no `vendor-pixi-*` chunk at all, so
    // "no eager Pixi chunk" there is satisfied by absence rather than by measurement.
    // The header has to say that is what happened, or a reader of the default-build
    // run is shown a green claim about a family the run never looked at.
    expect(enforcerSource).toContain('Absence is not a measurement, and the report says so per family');
    expect(enforcerSource).toContain('NOT PRESENT in this build');
    expect(enforcerSource).toContain('Renderer families NOT measured on this artifact');
    // And it must not be the *reason* the run passes: absence is a reported fact, so
    // it may not appear in the findings path.
    expect(enforcerSource).toMatch(/absent from it, not clean/);
    expect(enforcerSource).toContain('RENDERER_FAMILY_NAMES');
  });

  it('fails rather than passing an unmeasured build, unlike check:bundle-size.mjs', () => {
    expect(enforcerSource).toContain('no built entry document');
    expect(sourceOf('scripts/check-bundle-size.mjs')).toContain('process.exit(0)');
  });

  it('reads no learner data and makes no network request', () => {
    // Privacy as a property of the gate rather than as a promise: the only paths it
    // reads are the built artifact, and the only host it could reach is none.
    for (const forbidden of ['localhost', 'createServer', '127.0.0.1', 'fetch(', 'http:']) {
      expect(enforcerSource, forbidden).not.toContain(forbidden);
    }
    expect(enforcerSource).not.toMatch(/\bsubject\b/i);
    expect(enforcerSource).not.toMatch(/\battachment\b/i);
  });
});

describe('the memory gate is gating CI, not an advisory step', () => {
  it('runs in the job that already builds, so it reads the artifact that ships', () => {
    expect(buildJob, `${BUILD_JOB} job is missing from ci.yml`).not.toBe('');
    expect(buildJob).toContain('npm run build:web');
    // Before the build would mean measuring a stale or absent dist; after the artifact
    // upload would mean reporting a failure nobody can act on.
    expect(buildJob.indexOf('npm run build:web')).toBeLessThan(
      buildJob.indexOf(`name: ${MEMORY_STEP_NAME}`),
    );
    expect(buildJob.indexOf(`name: ${MEMORY_STEP_NAME}`)).toBeLessThan(
      buildJob.indexOf('Upload the shared production web artifact'),
    );
  });

  it('runs the npm script, so the CI step and the local command are the same command', () => {
    const step = stepBlockFor(buildJob, MEMORY_STEP_NAME);
    expect(step).toContain(`run: npm run ${MEMORY_SCRIPT}`);
    // Not a raw `node scripts/...` invocation: a raw command is a second thing to keep
    // in step with the script.
    expect(step).not.toContain('node scripts/check-memory.mjs');
    expect(buildJob.split(`npm run ${MEMORY_SCRIPT}`).length - 1).toBe(2);
  });

  it('GATES: the step is not exempt, and no step in the build job may be', () => {
    const step = stepBlockFor(buildJob, MEMORY_STEP_NAME);
    expect(step).toContain(`npm run ${MEMORY_SCRIPT}`);
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
      // The preflight is a property of the build it measures, so no other lane
      // re-measures a different dist as if it were the release.
      expect(body, `${name} runs the renderer memory preflight against its own build`).not.toContain(
        `npm run ${MEMORY_SCRIPT}`,
      );
    }
    const buildJobs = [...ciJobs.entries()].filter(([, body]) => body.includes('npm run build:web'));
    expect(buildJobs.map(([name]) => name)).toEqual([BUILD_JOB]);
    // Read-only with respect to the artifact: it measures, it never rewrites.
    for (const stepName of [MEMORY_STEP_NAME, PIXI_MEMORY_STEP_NAME]) {
      const step = stepBlockFor(buildJob, stepName);
      for (const forbidden of ['upload-artifact', 'rm -rf', 'record:web-artifact', 'record:build-metadata']) {
        expect(step, `${stepName}: ${forbidden}`).not.toContain(forbidden);
      }
    }
    // One shared artifact, uploaded once, even with the Pixi build in this job.
    expect(ciWorkflow.split('Upload the shared production web artifact').length - 1).toBe(1);
  });

  it('keeps the four pull-request compatibility lanes intact', () => {
    const laneIds = [...ciWorkflow.matchAll(/^\s+- id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    expect(laneIds).toEqual([
      'pr-linux-chromium',
      'pr-linux-firefox',
      'pr-macos-webkit',
      'pr-windows-edge',
    ]);
  });
});

describe('the Pixi-flagged build is exercised in CI without a second artifact or a browser', () => {
  it('is declared as steps in the job that already installs, rather than as a new job', () => {
    // The storage-v2 lane is the precedent: one job, one install, one flagged build,
    // several steps against it. A job of its own would pay for a second `npm ci` and
    // would need a second artifact upload, which is the duplication the lane exists
    // to avoid.
    expect(buildJob, 'the Pixi build is not in the web-build job').toContain(`name: ${PIXI_STEP_NAME}`);
    expect(buildJob).toContain(`npm run ${PIXI_BUILD_SCRIPT}`);
    expect(ciJobs.has('pixi'), 'the Pixi build grew a job of its own').toBe(false);
    // Counted as run steps rather than as text, because the job's own comments discuss
    // `npm ci` while explaining why it is not run twice.
    const installs = [...buildJob.matchAll(/^\s*- run: npm ci/gm)].length;
    expect(installs, 'the build job installs more than once').toBe(1);
  });

  it('runs strictly after the production artifact is recorded, verified, and uploaded', () => {
    // Nothing downstream reads this job's `dist`: `browser-smoke` and the four
    // compatibility lanes download the uploaded `web-artifact`. Rebuilding before the
    // upload would let a flagged artifact overwrite the one the lanes certify.
    const upload = buildJob.indexOf('Upload the shared production web artifact');
    const pixiBuild = buildJob.indexOf(`name: ${PIXI_STEP_NAME}`);
    expect(pixiBuild).toBeGreaterThan(upload);
    expect(pixiBuild).toBeGreaterThan(buildJob.indexOf('npm run record:web-artifact'));
    expect(pixiBuild).toBeGreaterThan(buildJob.indexOf('npm run verify:web-artifact'));
  });
});

/**
 * The `dist` overwrite is a load-bearing CI invariant with no test attached.
 *
 * `npm run build:web:pixi` rewrites this runner's `dist`. It is ordered after the
 * production artifact has been recorded, verified, and uploaded, and every downstream
 * consumer downloads the uploaded `web-artifact` rather than reading a working
 * directory, so the rebuild cannot be mistaken for the artifact that shipped. All of
 * that is asserted in `ci.yml`'s own comments and in the ordering test above - and a
 * comment is not a gate. A single step added between the upload and the Pixi build
 * that reads `dist/` would silently measure the *flagged* build while the release
 * artifact on record is the production one: a green run whose measurements describe
 * something else. That is the failure this block exists to make impossible to land
 * quietly, and it is cheap to check because the workflow is text.
 */
describe('the production artifact is never re-read after the Pixi build overwrites dist', () => {
  it('the step order is record, verify, upload, then the flagged build', () => {
    // Asserted on the parsed step list rather than by `indexOf` on the raw text, so
    // the assertion is about the order steps actually run in and not about where a
    // phrase happens to first appear in a comment.
    const order = [RECORD_STEP_NAME, VERIFY_STEP_NAME, PRODUCTION_UPLOAD_STEP_NAME, PIXI_STEP_NAME].map(
      (name) => stepIndex(buildJob, name),
    );
    for (const [index, name] of [RECORD_STEP_NAME, VERIFY_STEP_NAME, PRODUCTION_UPLOAD_STEP_NAME, PIXI_STEP_NAME].entries()) {
      expect(order[index], `the build job has no step named "${name}"`).toBeGreaterThanOrEqual(0);
    }
    // Strictly increasing, so each of the three preconditions is asserted rather than
    // merely present.
    expect(order, 'upload, record, verify, and the flagged build are not in that order').toEqual(
      [...order].sort((a, b) => a - b),
    );
  });

  it('no step between the production upload and the Pixi build reads dist', () => {
    // The window is exactly the hazard: inside it, `dist` is still the production
    // artifact, so a reader there would be right - and a *rebuild* later would make
    // that reader wrong without changing the step. This is the one ordering in the
    // job that is only safe because of what comes after it, which is why it cannot be
    // left to a comment.
    const steps = stepsOf(buildJob);
    const from = stepIndex(buildJob, PRODUCTION_UPLOAD_STEP_NAME);
    const to = stepIndex(buildJob, PIXI_STEP_NAME);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);

    const between = steps.slice(from + 1, to);
    // Non-vacuous: the parse found the job's real steps rather than an empty list, so
    // "nothing between them reads dist" is a statement about the window and not about
    // a parser that matched nothing.
    expect(steps.length, 'the step parser found almost nothing in the build job').toBeGreaterThan(10);
    expect(between.map((step) => step.name)).toEqual([]);

    const readers = between.filter(readsDist);
    expect(
      readers.map((step) => `${step.name}: ${step.command}`),
      'a step between the production upload and the flagged build reads dist, so it would measure the flagged build',
    ).toEqual([]);
  });

  it('the dist-reading detector discriminates, so the window check is not vacuous', () => {
    // The control for the check above. A reader that matched everything, or nothing,
    // would satisfy an empty window identically.
    const reads = (command: string) => readsDist({ name: 'probe', body: '', uses: '', command });
    // By name: every shape of path that reaches the directory.
    for (const offending of [
      'ls dist/assets',
      'cat dist/index.html',
      'rm -rf dist && npm run build:web',
      'du -sh ./dist',
      'test -d dist',
      'sha256sum dist/index.html',
      "node -e \"require('fs').readdirSync('dist')\"",
    ]) {
      expect(reads(offending), offending).toBe(true);
    }
    // By script default: the three gates whose whole job is to read the artifact and
    // whose command line does not say so. A text scan alone would call these clean.
    for (const script of DIST_BY_DEFAULT_SCRIPTS) {
      expect(reads(`npm run ${script}`), script).toBe(true);
    }
    for (const innocent of [
      'npm run record:web-artifact:pixi',
      'npm run verify:web-artifact:pixi',
      'npm run check:memory-without-a-dist',
      'npx playwright install --with-deps chromium',
      'node scripts/check-welcome-budget.mjs',
      'npm run test:e2e:recorded',
    ]) {
      expect(reads(innocent), innocent).toBe(false);
    }
    // A deliberate false positive, and the direction it errs in. This detector is a
    // conservative over-approximation of "reads dist", not a shell parser, so a string
    // in an `echo` counts. That is the safe direction: the assertion it feeds is that a
    // set of steps is *empty*, so a false positive makes the gate stricter and a false
    // negative - which is what would actually matter - is what this test above rules out.
    expect(reads('echo "the dist is rebuilt after this"')).toBe(true);
  });

  it('a run block scalar is read in full, not only its first line', () => {
    // A multi-line `run: |` is how this workflow records a shell snippet, and a scan
    // that read only the first line would miss every command under it. The two steps
    // in the workflow that use one are asserted against their real text.
    const smokeSteps = stepsOf(ciJobs.get('browser-smoke') ?? '');
    const toolchain = smokeSteps.find((step) => step.name === 'Record the runner image and toolchain');
    expect(toolchain, 'the toolchain step is missing from browser-smoke').toBeDefined();
    expect(toolchain?.command).toContain('npx playwright --version');
    expect(toolchain?.command.split('\n').length ?? 0).toBeGreaterThan(1);
  });

  it('every production-artifact consumer downloads the artifact instead of building or reading a dist', () => {
    for (const job of PRODUCTION_ARTIFACT_CONSUMERS) {
      const body = ciJobs.get(job);
      expect(body, `ci.yml has no ${job} job`).toBeDefined();
      const steps = stepsOf(body ?? '');

      // It downloads the named production artifact, rather than reading a working
      // directory. A job with no download step has nothing to certify.
      const download = steps.find(
        (step) => step.uses.startsWith('actions/download-artifact') && step.body.includes(PRODUCTION_ARTIFACT_NAME),
      );
      expect(download, `${job} does not download ${PRODUCTION_ARTIFACT_NAME}`).toBeDefined();

      // It never builds. A consumer that built would be measuring its own build
      // rather than the recorded artifact, which is the whole property at stake.
      const builders = steps.filter((step) => /npm run build:/.test(step.command));
      expect(builders.map((step) => step.name), `${job} builds instead of downloading`).toEqual([]);

      // And it has no `dist` of its own to read: the working directory it starts from
      // is a fresh checkout, so the only artifact it can measure is the downloaded
      // one. This is the property that makes the `web-build` overwrite safe, so it is
      // asserted rather than assumed.
      const distReaders = steps.filter(readsDist);
      expect(
        distReaders.map((step) => `${step.name}: ${step.command}`),
        `${job} reads a dist it did not download`,
      ).toEqual([]);
    }
  });

  it('the web-build job is the only one with a dist, and it is gone from the consumers', () => {
    // The positive statement of the same invariant, in the form a reader of the
    // workflow is checking: exactly one job ever has a `dist`, and it is the job that
    // uploads it before overwriting it.
    const withDist = [...ciJobs.entries()].filter(([, body]) => stepsOf(body).some(readsDist));
    expect(withDist.map(([name]) => name)).toEqual([BUILD_JOB]);
  });

  it('installs no browser and downloads no artifact', () => {
    const steps = [
      stepBlockFor(buildJob, PIXI_STEP_NAME),
      stepBlockFor(buildJob, PIXI_MEMORY_STEP_NAME),
    ].join('\n');
    for (const forbidden of ['playwright', 'download-artifact', 'upload-artifact']) {
      expect(steps, forbidden).not.toContain(forbidden);
    }
    // And the whole job installs at most one browser, which is zero: the Pixi lane is
    // a build-level lane and does not quietly become a browser lane.
    expect(buildJob).not.toContain('playwright install');
  });

  it('GATES: the Pixi build and its preflight are not exempt', () => {
    for (const stepName of [PIXI_STEP_NAME, PIXI_MEMORY_STEP_NAME]) {
      const step = stepBlockFor(buildJob, stepName);
      expect(step, stepName).not.toContain('continue-on-error');
      expect(step, stepName).not.toContain('|| true');
      expect(step, stepName).not.toContain('exit 0');
    }
    expect(buildJob).not.toMatch(/continue-on-error/);
  });

  it('is a flagged build of the same script, so the two builds cannot drift', () => {
    const script = npmScripts[PIXI_BUILD_SCRIPT];
    expect(script, `package.json has no ${PIXI_BUILD_SCRIPT} script`).toBeDefined();
    expect(script).toContain('VITE_WORLD_RENDERER=pixi');
    expect(script).toContain('npm run build:web');
    // It delegates rather than re-implementing, so the Pixi artifact is produced by
    // the same command as the production one with one environment variable changed.
    expect(script).not.toContain('vite build');
  });
});

describe('the production default is unchanged', () => {
  it('npm run build:web sets no renderer flag', () => {
    expect(npmScripts['build:web']).toBe('npm run build');
    expect(npmScripts['build']).not.toContain('VITE_WORLD_RENDERER');
  });

  it('the flag matrix still names phaser as the production default for phase 9', () => {
    const matrix = sourceOf('src/config/featureFlags.ts');
    expect(matrix).toContain('productionDefault: \'phaser\'');
    expect(matrix).toContain('ownerPhase: 9');
  });
});
