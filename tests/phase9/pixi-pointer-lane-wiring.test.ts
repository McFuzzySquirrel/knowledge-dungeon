/**
 * The binding gate for the canvas-pointer lane.
 *
 * ## Why a separate file rather than another case in `tests/e2e/pixi-memory-lane.test.ts`
 *
 * That file is the memory lane's own contract, and its assertions are deliberately
 * narrow: one spec, one `testMatch`, one eight-test count, one CI step. A gate that
 * describes one lane should not be the thing that has to change when a second lane
 * is added, because a gate that changes when unrelated work lands stops being
 * evidence about the thing it names. This file describes only the pointer lane.
 *
 * ## What it holds down
 *
 * The pointer lane is the only gate in the repository that clicks the canvas, so
 * the three things that can quietly neuter it are worth pinning: that the npm
 * script exists and points at the real config, that CI actually runs that script,
 * and that the step is not exempt from failing. A gate nobody has seen go red is a
 * gate nobody should trust, and the evidence that this one bites is in the Phase 9
 * record: reverting one line in `createTestWorld.ts` — the scene calling its own
 * `activate` instead of the host's dispatcher — turned two of its three tests red
 * with `the first canvas click did not reach the mirror`, against the same artifact.
 *
 * ## Invariants this asserts alongside the wiring
 *
 * - The lane is **preview only**: it cannot rebuild, so it cannot end up testing a
 *   different artifact than the one CI recorded.
 * - The lane is **hard fail, never skip**, and the guard runs at config load rather
 *   than warning, so a missing artifact costs a second and names the cause instead
 *   of becoming a 180-second webServer timeout.
 * - The lane produces **no trace, screenshot, or video**, so nothing it writes can
 *   reach an upload.
 * - It shares the memory lane's artifact, port discipline and browser install, so
 *   it adds a step rather than a build, a download, or an install.
 *
 * ## Privacy
 *
 * This file reads `package.json` and `.github/workflows/ci.yml` as text and never
 * executes them. It contains no learner data, no subject, note, attachment,
 * statistic or preference field, and it prints nothing from the workflow it reads
 * beyond the assertion failures above.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PIXI_LANE_PREFLIGHT_COMMAND,
  PIXI_POINTER_LANE,
  PIXI_POINTER_PREVIEW_PORT,
  PIXI_POINTER_PREVIEW_SCRIPT,
} from '../e2e/pixi-memory-lane';
import {
  DOWNLOAD_DECLARATION,
  auditJobTransfers,
  transferMutationResults,
} from '../e2e/artifact-transfer-wiring';

const REPO_ROOT = process.cwd();
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CONFIG = path.join(REPO_ROOT, 'tests/e2e/playwright.pixi-pointer.config.ts');
const SPEC = path.join(REPO_ROOT, 'tests/phase9/browser/pixi-canvas-pointer.spec.ts');
const PREFLIGHT_PATH = path.join(REPO_ROOT, 'scripts/require-pixi-lane-artifact.mjs');

const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
  scripts: Record<string, string>;
};
const workflow = readFileSync(WORKFLOW, 'utf8');
const config = readFileSync(CONFIG, 'utf8');
const spec = readFileSync(SPEC, 'utf8');
const preflight = readFileSync(path.join(REPO_ROOT, 'scripts/require-pixi-lane-artifact.mjs'), 'utf8');

/** The body of one named step, so an assertion about it is about that step. */
function stepBlock(name: string): string {
  const start = workflow.indexOf(`name: ${name}`);
  expect(start, `ci.yml has no step named "${name}"`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {6}- (?:name|run|uses):/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** One job's body, so a per-job assertion cannot be satisfied by another job. */
function jobBlock(job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`);
  expect(start, `ci.yml has no job named "${job}"`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe('the canvas-pointer lane is bound and can fail', () => {
  it('has a preflight that is valid JavaScript, and says so rather than failing obscurely', () => {
    // The preflight shipped once with TypeScript syntax - `} as const;` and a
    // parameter annotation - in a file Node loads as an ES module. It passed `tsc`
    // because `scripts/` is in no tsconfig project, and it passed `eslint` because
    // `scripts/**` is in its ignore list, so the only thing that could have caught it
    // was running it, and the first thing that ran it was CI. `node --check` is the
    // cheap gate that belongs in the suite, because a syntax error in a preflight is
    // a red run that names a Node stack trace instead of a missing artifact.
    const checked = spawnSync(process.execPath, ['--check', PREFLIGHT_PATH], {
      encoding: 'utf8',
    });
    expect(checked.stderr, checked.stderr).toBe('');
    expect(checked.status, `${PREFLIGHT_PATH} does not parse as JavaScript`).toBe(0);
  });

  it('has an npm script, and the scripts are the same command CI runs', () => {
    // The preflight runs first, in the command, not as a guard at the top of the
    // config: a module-scope throw made importing the config fatal in a checkout
    // without a built artifact, which broke the `unit-tests` job. So a missing
    // artifact costs a one-line diagnosis here and the config stays importable.
    const command = `${PIXI_LANE_PREFLIGHT_COMMAND} && playwright test --config=${PIXI_POINTER_LANE.configFile}`;
    expect(packageJson.scripts['test:e2e:pixi-pointer'], 'plain script').toBe(command);
    expect(packageJson.scripts['test:e2e:pixi-pointer:recorded'], 'recorded script').toBe(command);
    // `:full` is the local build-and-record path. The config must never be able to
    // build for itself, so the build lives here, in a command a person runs.
    expect(packageJson.scripts['test:e2e:pixi-pointer:full']).toBe(
      `npm run ${PIXI_POINTER_LANE.buildScript} && npm run ${PIXI_POINTER_LANE.recordScript} && ${command}`,
    );
    // The config path is declared once and both the script and the config read it.
    expect(PIXI_POINTER_LANE.configFile).toBe('tests/e2e/playwright.pixi-pointer.config.ts');
    // And the config module itself must carry no artifact check, or the import that
    // the wiring gate above performs would fail in a clean checkout.
    expect(config).not.toMatch(/existsSync/);
    expect(config).not.toMatch(/throw new Error/);
  });

  it('runs in CI, as a step rather than a job of its own', () => {
    expect(PIXI_POINTER_LANE.ciJob).toBe('browser-smoke');
    const step = stepBlock('Run the Pixi canvas-pointer DOM mirror lane');
    expect(step).toContain('run: npm run test:e2e:pixi-pointer:recorded');
    // Not the raw Playwright command: one string, so the local command and the CI
    // command cannot drift into two things that have to be kept in step.
    expect(step).not.toContain('npx playwright test');
  });

  it('is not exempt from failing', () => {
    const step = stepBlock('Run the Pixi canvas-pointer DOM mirror lane');
    expect(step).not.toContain('continue-on-error');
    expect(step).not.toContain('|| true');
    expect(step).not.toContain('exit 0');
    // The whole job, matched as a YAML key at line start so this file's own prose
    // and the workflow's comments are not counted as one.
    expect(jobBlock(PIXI_POINTER_LANE.ciJob).match(/^\s*continue-on-error\s*:/gm) ?? []).toEqual([]);
  });

  it('adds a step, not a build, a download, or a browser install', () => {
    const job = jobBlock(PIXI_POINTER_LANE.ciJob);
    // One install, and the artifact downloads held as a property rather than as a count. This
    // was `toBe(3)`, and it had been `toBe(2)`; Phase 17, Phase 19 and Phase 21 each grew the
    // real number and each had to amend it here, which is the whole of what
    // `tests/e2e/artifact-transfer-wiring.ts` was written to end. What this lane needs to know
    // is unchanged: it adds **none** of the downloads, and reuses the second one. The property
    // says that structurally - every arriving artifact is a named step that declares itself, in
    // the declared order, each after its own `rm -rf dist` - so a sixth download and an unnamed
    // fifth one both fail, and this lane cannot be what introduced either.
    expect([...job.matchAll(/^\s*- run: npx playwright install[^\n]*$/gm)].length).toBe(1);
    expect(
      auditJobTransfers(workflow, PIXI_POINTER_LANE.ciJob, DOWNLOAD_DECLARATION),
      'the pointer lane shares a job whose artifact transfers are not the declared ones',
    ).toEqual([]);
    // The lane reuses the flagged artifact the memory lane already downloaded.
    expect([...job.matchAll(/^\s*- run: npm run build:web[^\n]*$/gm)].length).toBe(0);
    expect([...job.matchAll(/^\s*- run: npm run build:web:pixi[^\n]*$/gm)].length).toBe(0);
    // It runs after the artifact is verified, so it cannot measure a stale dist.
    // The indices are taken *inside* the job block, not against the whole workflow:
    // `web-build` carries its own `Verify the Pixi-flagged artifact identity` step,
    // and a workflow-wide indexOf matches that one first, which inverts the answer.
    const jobScoped = jobBlock(PIXI_POINTER_LANE.ciJob);
    const order = [
      'Run the current-build viewport suite against the shared artifact',
      'Discard the production dist before the flagged download',
      'Download the Pixi-flagged artifact',
      'Verify the Pixi-flagged artifact identity',
      'Run the Pixi world mount/unmount memory lane',
      'Run the Pixi canvas-pointer DOM mirror lane',
    ].map((name) => jobScoped.indexOf(`name: ${name}`));
    expect(order.every((index) => index > -1), 'all six steps are in this job').toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the transfer property it now asserts can fail, and fails for the right reason', () => {
    /*
     * This file's own header states the standard it holds its gates to: "A gate nobody has
     * seen go red is a gate nobody should trust." Rewriting a working assertion is exactly when
     * that matters, so the rewrite is checked rather than assumed - and checked in *both*
     * directions, because the upload mutations land in `web-build` and the assertion above only
     * reads `browser-smoke`.
     *
     * Each mutation must be rejected by the check it names, and must have changed the workflow
     * at all. The second half is not pedantry: a mutation whose anchor stopped matching returns
     * the text unchanged, and a loop that only asserted "the audit found nothing" would report
     * such a mutation as a clean pass - a green proof of nothing, which is the failure this
     * repository has already found in its own gates.
     */
    const results = transferMutationResults(workflow);
    expect(results.length, 'the mutation table is empty, so nothing was proved').toBeGreaterThanOrEqual(7);
    for (const result of results) {
      expect(result.changed, `${result.what}: the mutation changed nothing`).toBe(true);
      expect(
        result.caught,
        `${result.what}: expected \`${result.check}\` to reject it, and the findings were ${
          result.fired.join(', ') || '(none)'
        }`,
      ).toBe(true);
    }
  });

  it('replaces the production dist rather than merging the flagged build into it', () => {
    // Found the hard way, on the first CI run of this phase.
    // `actions/download-artifact` extracts *into* the working directory, so the
    // flagged download merged into the production tree the earlier download left
    // behind. Both builds emit the same logical chunk names with different content
    // hashes, so the result was neither artifact: 179 files, the union of a 151-file
    // production dist and the flagged one. The identity check caught it and refused
    // to measure it, which is the right place for it to be caught — but a red run is
    // a worse outcome than a correct one.
    //
    // This is the mirror of the invariant the build job already asserts, that
    // nothing between the production upload and the Pixi build *reads* `dist`. This
    // one is that nothing between the production suite and the flagged download
    // *keeps* it.
    const jobScoped = jobBlock(PIXI_POINTER_LANE.ciJob);
    const clear = stepBlock('Discard the production dist before the flagged download');
    expect(clear).toMatch(/rm -rf dist/);
    // Between the clear and the download, nothing may put a dist back.
    const after = jobScoped.slice(jobScoped.indexOf('name: Discard the production dist'));
    const beforeDownload = after.slice(0, after.indexOf('name: Download the Pixi-flagged artifact'));
    expect(
      [...beforeDownload.matchAll(/^\s*-\s+(?:run|uses):[^\n]*$/gm)].map((m) => m[0]),
      'nothing runs between the clear and the download',
    ).toHaveLength(0);
    // And the clear is inside this job, not somewhere that never runs.
    expect(after).toContain('name: Download the Pixi-flagged artifact');
  });

  it('cannot rebuild, and cannot skip', () => {
    // Preview only: the config starts the declared preview server and nothing else.
    // The script itself is imported from the declaration, so the assertion is on
    // the usage rather than on a restated literal that would be a second copy.
    expect(config).toContain('command: PIXI_POINTER_PREVIEW_SCRIPT');
    expect(config).not.toContain('npm run build:web');
    expect(config).not.toMatch(/npm run build:web:pixi/);
    expect(config).not.toMatch(/test\.skip\(/);
    // The preflight, not the config, is what names a missing artifact. A guard in
    // the config has two failure modes and both were hit: a `console.warn` let the
    // run reach a `vite preview` of a directory that was not there, which Playwright
    // reports as a 180-second timeout; and changing that warn to a `throw` made the
    // config unimportable, so the gate that asserts its shape failed in every
    // checkout without a build — including the `unit-tests` CI job, which has none
    // and never should. The check therefore runs in the command.
    expect(PIXI_LANE_PREFLIGHT_COMMAND).toBe('node scripts/require-pixi-lane-artifact.mjs');
    expect(preflight).toMatch(/process\.exit\(1\)/);
    expect(preflight).toMatch(/existsSync\(distDir\)/);
    expect(preflight).toMatch(/existsSync\(manifest\)/);
    // A partial `dist` is a distinct message, because a partial build is a recurring
    // source of confusing failures elsewhere in this repository.
    expect(preflight).toMatch(/index\.html/);
    expect(spec).not.toMatch(/test\.skip\(/);
    expect(spec).not.toMatch(/test\.fixme\(/);
  });

  it('leaves nothing behind that an upload could sweep up', () => {
    for (const setting of ["trace: 'off'", "screenshot: 'off'", "video: 'off'"]) {
      expect(config, setting).toContain(setting);
    }
    // Output goes under `artifacts/`, which is gitignored, and not Playwright's
    // default `test-results/` at the repository root — which is *not* gitignored, so
    // the default drops an untracked directory into the source tree on every run.
    expect(config).toMatch(/outputDir: path\.resolve\(REPO_ROOT, 'artifacts\/pixi-pointer-test-results'\)/);
    expect(config).not.toMatch(/outputDir: 'test-results'/);
    // And that path is outside the CI upload allowlist's reach, asserted here so the
    // two cannot drift apart.
    expect(config).not.toMatch(/artifacts\/compatibility-evidence/);
  });

  it('has a port of its own, so it cannot contend with the memory lane', () => {
    expect(PIXI_POINTER_PREVIEW_PORT).toBe(43187);
    expect(PIXI_POINTER_PREVIEW_SCRIPT).toContain(`--port ${PIXI_POINTER_PREVIEW_PORT}`);
    expect(PIXI_POINTER_PREVIEW_SCRIPT).toContain('--strictPort');
    // The config imports the port and the script from the declaration rather than
    // restating them, so there is one place to change and no chance of the two
    // drifting. Asserting the literal text here would be asserting nothing.
    expect(config).toMatch(/import \{[^}]*PIXI_POINTER_PREVIEW_PORT[^}]*\}\s*from '\.\/pixi-memory-lane'/);
    expect(config).toMatch(/import \{[^}]*PIXI_POINTER_PREVIEW_SCRIPT[^}]*\}\s*from '\.\/pixi-memory-lane'/);
    expect(config).toContain('command: PIXI_POINTER_PREVIEW_SCRIPT');
    expect(config).toContain('baseURL: `http://127.0.0.1:${PIXI_POINTER_PREVIEW_PORT}`');
    expect(config).toContain('url: `http://127.0.0.1:${PIXI_POINTER_PREVIEW_PORT}`');
  });

  it('declares what it does not prove, rather than letting the name imply it', () => {
    for (const entry of PIXI_POINTER_LANE.doesNotProve) {
      expect(typeof entry, entry).toBe('string');
      expect(entry.length, entry).toBeGreaterThan(20);
    }
    // The memory lane's non-vacuity and identity guarantees are the ones a reader
    // would assume carry over; they are the memory lane's, and this lane reuses the
    // artifact rather than the evidence.
    expect(PIXI_POINTER_LANE.doesNotProve.join(' ')).toMatch(/memory/i);
  });
});
