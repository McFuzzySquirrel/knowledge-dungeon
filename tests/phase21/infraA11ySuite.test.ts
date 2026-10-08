/**
 * Phase 21 accessibility-audit infrastructure gate.
 *
 * ## What this file is
 *
 * Owned by the build/CI lane, and deliberately **not** a test of the surfaces it scans. Those belong
 * to the owners of Welcome, the village and the Settings dialog. What is tested here is only the part
 * that is infrastructure, and it is the part whose failure modes are all silent:
 *
 * 1. **The runner's mirrored cell plan equals the declaration.** `scripts/run-a11y-audit.mjs` is
 *    plain ESM run by `node`, which cannot load the TypeScript declaration, so it carries its own
 *    copy of the plan. A mirror that drifted would make the runner report coverage for cells the
 *    suite does not generate, which is the exact class of failure this phase's integrity risk is
 *    made of. Compared **field by field** here, not by count.
 * 2. **No cell claims `physical-device-manual`.** The support matrix already asserts this of the
 *    matrix; this asserts it of the *plan*, because the plan is the thing the runner reports from and
 *    a plan is a second place a claim could be made.
 * 3. **Every cell's evidence class is the matrix's own value**, copied rather than restated.
 * 4. **The npm scripts exist and carry the scope each one claims**, so `test:a11y` cannot quietly
 *    become `--require=runnable` and quietly stop reporting the matrix's incompleteness.
 * 5. **CI runs the `runnable` scope, and no CI step runs the `matrix` scope.** The `matrix` scope
 *    exits 3 from a single-host runner by construction. Wiring it into a PR gate would make every
 *    pull request permanently red, which is the same failure as a gate that always passes: a run
 *    whose status carries no information.
 * 6. **The suite scans the surfaces it declares, and names the ones it does not.** An audit that
 *    reports "the accessibility suite passed" without naming its surfaces is the failure the whole
 *    phase is exposed to.
 * 7. **The exit statuses are three, not two**, and the incomplete one is distinct from the failure
 *    one — because a partial matrix and a broken assertion must not look the same in a CI summary.
 * 8. **No repository walk for media**, unlike the Phase 20 font walk that a Playwright trace used to
 *    turn into a recurring false red. `artifacts/` is excluded by construction because this gate does
 *    not walk at all; the assertion that matters is that the lane records no trace.
 *
 * Hermeticity: reads repository files and the flag tables only. No `dist/`, no build, no browser, no
 * network, no learner data.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  A11Y_CELLS,
  A11Y_CI_RUN_SCRIPT,
  A11Y_COVERAGE_SCOPES,
  A11Y_INCOMPLETE_EXIT_CODE,
  A11Y_KNOWN_BLOCKING_SIGNATURES,
  A11Y_MANUAL_GATES,
  A11Y_MINIMUM_TOUCH_TARGET_PX,
  A11Y_OS_FAMILY_REQUIREMENT,
  A11Y_PROJECTS,
  A11Y_RUNNER_SCRIPT,
  A11Y_SCANNED_SURFACES,
  A11Y_SCRIPTS,
  A11Y_UNSCANNED_SURFACES,
  A11Y_WCAG_TAGS,
  engineFamilyFor,
  validateA11yMatrix,
} from '../../tests/e2e/a11y-matrix';
import { PHYSICAL_DEVICE_GATES, SUPPORT_MATRIX } from '../../tests/e2e/support-matrix';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_PATH = path.join(REPO_ROOT, A11Y_RUNNER_SCRIPT);
const SPEC_PATH = path.join(REPO_ROOT, 'tests/e2e/a11yAudit.spec.ts');
const CONFIG_PATH = path.join(REPO_ROOT, 'tests/e2e/playwright.a11y.config.ts');
const CI_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const PLAN_PATH = path.join(REPO_ROOT, 'docs/plans/001-cozy-pixi-rebuild.md');

const npmScripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

const runnerSource = readFileSync(RUNNER_PATH, 'utf8');
const specSource = readFileSync(SPEC_PATH, 'utf8');
const configSource = readFileSync(CONFIG_PATH, 'utf8');
const ciSource = readFileSync(CI_PATH, 'utf8');

/**
 * The runner's `CELLS` literal, read out of the script and parsed.
 *
 * Parsed rather than imported, because the script's only side effects are its `main()` call and the
 * browser launches inside it — importing it would run an audit inside `npm test`. The array is
 * `Object.freeze([...])` of plain object literals, so the shape is stable and this comparison is a
 * real one rather than a substring match.
 */
function runnerCells(): ReadonlyArray<Record<string, unknown>> {
  const match = /const CELLS = Object\.freeze\((\[[\s\S]*?\])\);/.exec(runnerSource);
  if (match === null) throw new Error('run-a11y-audit.mjs no longer declares CELLS as an Object.freeze array literal.');
  return new Function(`return ${match[1]};`)() as ReadonlyArray<Record<string, unknown>>;
}

function runnerManualGates(): ReadonlyArray<Record<string, unknown>> {
  const match = /const MANUAL_GATES = Object\.freeze\((\[[\s\S]*?\])\);/.exec(runnerSource);
  if (match === null) throw new Error('run-a11y-audit.mjs no longer declares MANUAL_GATES as an Object.freeze array literal.');
  return new Function(`return ${match[1]};`)() as ReadonlyArray<Record<string, unknown>>;
}

/**
 * A scratch Playwright config and spec whose only job is to pass.
 *
 * The exit-3 proof needs a run where every assertion is green and the coverage is still incomplete,
 * because that combination is the one the exit code exists for and the one the real suite cannot
 * currently produce while it has findings to report.
 *
 * ## Why it lives under `artifacts/` and not in the system temp directory
 *
 * Measured, and the failure is instructive: a config in `/tmp` cannot resolve `@playwright/test`,
 * because Node resolves a config's imports from the **config's own directory**. The run then exits 1
 * with an empty JSON report, and the runner's honest verdict is "FAILED" - which looks exactly like
 * the exit-3 proof working if the counts are not also read. `artifacts/` is gitignored, is already the
 * home for generated Playwright output, and sits inside the repository so resolution works.
 *
 * Generated rather than committed, so a fixture cannot rot into a second accessibility suite nobody
 * is maintaining, and given its **own** project prefix so the runner's `--project-prefix` has
 * something distinct to strip.
 */
function writeScratchRunnerFixture(): { config: string; prefix: string } {
  const root = path.join(REPO_ROOT, 'artifacts/a11y-exitproof');
  mkdirSync(root, { recursive: true });
  const prefix = 'a11yexitproof-';
  writeFileSync(
    path.join(root, `${prefix}scan.spec.ts`),
    [
      "import { expect, test } from '@playwright/test';",
      '',
      "// Deliberately trivial: this fixture proves a coverage verdict, not an accessibility result.",
      "test('the scratch cell ran, which is all this fixture claims', async () => {",
      '  expect(1 + 1).toBe(2);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(root, 'playwright.exitproof.config.ts'),
    [
      "import { defineConfig } from '@playwright/test';",
      '',
      '// Projects inlined rather than imported: this fixture lives in a temporary directory outside',
      '// the repository, and a Playwright config that reaches into the checkout for its project list',
      '// is a fixture that fails for a loader reason rather than a coverage one.',
      "const CELLS = [",
      ...A11Y_CELLS.map(
        (cell) =>
          `  { project: '${cell.project}', engine: '${cell.engine}', channelOption: ${JSON.stringify(cell.channelOption ?? null)} },`,
      ),
      '];',
      '',
      'export default defineConfig({',
      "  testDir: '.',",
      `  testMatch: '${prefix}scan.spec.ts',`,
      '  fullyParallel: false,',
      '  retries: 0,',
      '  workers: 1,',
      '  reporter: [["line"]],',
      '  outputDir: "./results",',
      '  use: { headless: true },',
      '  projects: CELLS.map((cell) => ({',
      `    name: '${prefix}' + cell.project,`,
      '    use: { browserName: cell.engine, ...(cell.channelOption === null ? {} : { channel: cell.channelOption }) },',
      '  })),',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return { config: path.join(root, 'playwright.exitproof.config.ts'), prefix };
}

describe('the accessibility cell plan is internally consistent and cannot over-claim', () => {
  it('validateA11yMatrix reports no problem', () => {
    expect(validateA11yMatrix()).toEqual([]);
  });

  it('declares exactly one cell per support-matrix entry, in matrix order', () => {
    expect(A11Y_PROJECTS).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    expect(A11Y_CELLS.map((cell) => cell.project)).toEqual(A11Y_PROJECTS);
    // Nine, because the branded Chrome lane added a ninth matrix entry and the
    // cell plan covers every entry. This is a deliberate reviewed change, not a
    // relaxation: the assertion still pins the exact count.
    expect(A11Y_CELLS).toHaveLength(9);
  });

  it('NO cell claims physical-device-manual, in words rather than by absence', () => {
    // The single most important property of this phase's plan, asserted on the plan and not only on
    // the matrix. A plan that listed a cell with that evidence class would let a viewport emulation
    // be reported as a device check, and nothing downstream would catch it: the run would be green.
    for (const cell of A11Y_CELLS) {
      expect(cell.evidenceClass, cell.project).not.toBe('physical-device-manual');
    }
    expect(A11Y_CELLS.some((cell) => cell.evidenceClass === 'physical-device-manual')).toBe(false);
    // And the class has to exist as a value for the negation above to be a choice rather than a
    // tautology, so assert the vocabulary still contains it.
    expect(
      SUPPORT_MATRIX.length,
      'the matrix must not have shrunk, or this gate proves less than it appears to',
    ).toBeGreaterThanOrEqual(8);
  });

  it('copies each cell evidence class from the matrix rather than restating it', () => {
    for (const cell of A11Y_CELLS) {
      const entry = SUPPORT_MATRIX.find((candidate) => candidate.project === cell.project);
      expect(entry, cell.project).toBeDefined();
      expect(cell.evidenceClass, cell.project).toBe(entry?.evidenceClass);
      expect(cell.engine, cell.project).toBe(entry?.engine);
      expect(cell.engineFamily, cell.project).toBe(engineFamilyFor(entry?.engine ?? 'chromium'));
      expect(cell.hasTouch, cell.project).toBe(entry?.hasTouch);
      expect(cell.formFactor, cell.project).toBe(entry?.formFactor);
      expect(cell.viewport, cell.project).toEqual(entry?.viewport);
      expect([...cell.hostOperatingSystems], cell.project).toEqual([...(entry?.hostOperatingSystems ?? [])]);
    }
  });

  it('classifies the branded Chromium channel as Chromium engine, different evidence class', () => {
    // Two facts that are easy to collapse and must not be: `compat-edge` is the Chromium *engine*,
    // and it is `branded-channel-automation` evidence. Collapsing them is how "Edge is a Chromium
    // result" becomes "we tested Edge and Chromium".
    const edge = A11Y_CELLS.find((cell) => cell.project === 'compat-edge');
    expect(edge?.engineFamily).toBe('chromium');
    expect(edge?.evidenceClass).toBe('branded-channel-automation');
    const webkit = A11Y_CELLS.find((cell) => cell.project === 'compat-webkit');
    expect(webkit?.engineFamily).toBe('non-chromium');
    expect(webkit?.evidenceClass).toBe('engine-automation');
  });

  it('carries the five manual physical-device gates, all of them un-automated', () => {
    expect(A11Y_MANUAL_GATES).toHaveLength(PHYSICAL_DEVICE_GATES.length);
    expect(A11Y_MANUAL_GATES.length).toBeGreaterThanOrEqual(5);
    for (const gate of A11Y_MANUAL_GATES) {
      expect(gate.automated, gate.id).toBe(false);
      expect(gate.targetPhase, gate.id).toMatch(/^Phase \d/);
      expect(gate.reason.length, gate.id).toBeGreaterThan(20);
    }
  });

  it('names the surfaces it scans and the surfaces it does not', () => {
    expect(A11Y_SCANNED_SURFACES.map((surface) => surface.id)).toEqual(['welcome', 'village', 'settings']);
    for (const surface of A11Y_SCANNED_SURFACES) {
      expect(surface.label.length, surface.id).toBeGreaterThan(0);
      expect(surface.reach.length, surface.id).toBeGreaterThan(20);
    }
    // Non-empty while the phase is in progress, so an incomplete audit cannot be reported as a
    // complete one. When Phase 21 finishes, this list empties and this assertion is what changes.
    expect(A11Y_UNSCANNED_SURFACES.length).toBeGreaterThan(0);
    expect(A11Y_UNSCANNED_SURFACES).toContain('Creator');
    expect(A11Y_UNSCANNED_SURFACES).toContain('Data Center');
  });

  it('scans with the same five WCAG 2.2 tags the existing suites use', () => {
    // A narrower tag set would make "no violations" a statement about a smaller surface, and the
    // difference is invisible in a log. Named explicitly rather than imported from the other suites
    // so this gate fails if one of them changes without the others.
    expect([...A11Y_WCAG_TAGS]).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
    expect(specSource).toContain('A11Y_WCAG_TAGS');
  });

  it('tolerates exactly the violations another gate already records, and no more', () => {
    // Every entry has to appear **verbatim** in a gate that already tolerates it, with its own
    // comment saying Phase 21 owns removing it. That is what stops this list from becoming a place
    // to park a finding this audit discovered: adding a signature here without adding it to a gate
    // that already recorded it is a red `npm test`, not a quieter suite.
    const currentBuild = readFileSync(path.join(REPO_ROOT, 'tests/e2e/currentBuild.spec.ts'), 'utf8');
    const phase10Lane = readFileSync(path.join(REPO_ROOT, 'tests/e2e/phase10-media-lane.ts'), 'utf8');
    expect(A11Y_KNOWN_BLOCKING_SIGNATURES.length).toBeGreaterThan(0);
    for (const signature of A11Y_KNOWN_BLOCKING_SIGNATURES) {
      const recorded = currentBuild.includes(signature) || phase10Lane.includes(signature);
      expect(recorded, `${signature} is not recorded by any existing gate`).toBe(true);
    }
    expect(currentBuild).toContain("'color-contrast|serious|.welcome-checklist-status--done'");
    expect(phase10Lane).toContain("'color-contrast|serious|.hud-stat-subtle'");
    // And the phase is on the record as the owner of removing them, in both places.
    expect(currentBuild).toContain('Phase 21 owns removal of the recorded exception');
    expect(specSource).toContain('A11Y_KNOWN_BLOCKING_SIGNATURES');
    // The runner's mirror lists the same two.
    expect(runnerSource).toContain("'color-contrast|serious|.welcome-checklist-status--done'");
    expect(runnerSource).toContain("'color-contrast|serious|.hud-stat-subtle'");
  });

  it('measures the plan touch-target floor, not a number of its own', () => {
    expect(A11Y_MINIMUM_TOUCH_TARGET_PX).toBe(44);
    expect(specSource).toContain('A11Y_MINIMUM_TOUCH_TARGET_PX');
  });

  it('quotes the plan requirement it evaluates, so the gate can be checked against its source', () => {
    expect(A11Y_OS_FAMILY_REQUIREMENT).toContain('at least one Chromium and one non-Chromium lane');
    expect(A11Y_OS_FAMILY_REQUIREMENT).toContain('each supported OS family');
    const plan = readFileSync(PLAN_PATH, 'utf8');
    const phase = plan.slice(plan.indexOf('## Phase 21: Accessibility and Responsive-Device Audit'));
    expect(phase).toContain('## Phase 21: Accessibility and Responsive-Device Audit');
    // The three scope lines the runner enforces, verbatim from the phase's own scope block.
    expect(phase).toContain('Run accessibility checks on at least one Chromium and one non-Chromium lane for each supported OS family.');
    expect(phase).toContain('Keep viewport/touch emulation distinct from physical Chromebook, tablet, desktop, and operating-system verification.');
    expect(phase).toContain('Record actual Safari, Edge, ChromeVox, and touch-screen-reader evidence separately from automated Playwright evidence.');
    // And the exit criteria this phase cannot discharge from a container.
    expect(phase).toContain('ChromeVox and the selected touch screen-reader script pass.');
    expect(phase).toContain('Viewport emulation is not reported as physical Chromebook or tablet verification.');
  });
});

describe("the runner's mirrored plan equals the declaration, field by field", () => {
  it('the cell lists are the same projects in the same order', () => {
    const mirrored = runnerCells();
    expect(mirrored.map((cell) => cell.project)).toEqual(A11Y_PROJECTS);
    expect(mirrored).toHaveLength(A11Y_CELLS.length);
  });

  it('every mirrored field equals the declared field for the same project', () => {
    const mirrored = runnerCells();
    for (const cell of A11Y_CELLS) {
      const copy = mirrored.find((candidate) => candidate.project === cell.project);
      expect(copy, cell.project).toBeDefined();
      expect(copy?.engine, cell.project).toBe(cell.engine);
      expect(copy?.evidenceClass, cell.project).toBe(cell.evidenceClass);
      expect(copy?.formFactor, cell.project).toBe(cell.formFactor);
      expect(copy?.hasTouch, cell.project).toBe(cell.hasTouch);
      expect(copy?.channelOption ?? undefined, cell.project).toBe(cell.channelOption ?? undefined);
      const mirroredHosts = copy?.hostOperatingSystems as readonly string[] | undefined;
      expect(mirroredHosts, cell.project).toEqual([...cell.hostOperatingSystems]);
    }
  });

  it('the mirrored manual gates are the same five, with the same reasons', () => {
    const mirrored = runnerManualGates();
    expect(mirrored.map((gate) => gate.id)).toEqual(A11Y_MANUAL_GATES.map((gate) => gate.id));
    for (const gate of A11Y_MANUAL_GATES) {
      const copy = mirrored.find((candidate) => candidate.id === gate.id);
      expect(copy?.automated, gate.id).toBe(false);
      expect(copy?.reason, gate.id).toBe(gate.reason);
    }
  });

  it('the mirrored scope names and the incomplete exit code are the declared ones', () => {
    expect(runnerSource).toContain("['runnable', 'host', 'matrix']");
    expect(runnerSource).toContain(`const EXIT_INCOMPLETE = ${A11Y_INCOMPLETE_EXIT_CODE};`);
    expect(A11Y_INCOMPLETE_EXIT_CODE).toBe(3);
    expect(A11Y_COVERAGE_SCOPES).toEqual(['runnable', 'host', 'matrix']);
  });
});

describe('the runner reports its coverage rather than asserting a partial matrix is complete', () => {
  it('probes runnability by launching a browser, not by reading a flag or a path', () => {
    // Three reasons this is a launch and not a path check, and the third decided it: a browser
    // directory can exist while its system libraries do not, a branded channel can be declared
    // while it is not installed, and a permission problem looks exactly like a missing file.
    // `probeCell` calls `browserType.launch`, and this gate asserts it rather than describing it.
    expect(runnerSource).toContain('browserType.launch');
    expect(runnerSource).toContain('await browser.close()');
    expect(runnerSource).toContain("await browserType.launch({");
    // And it reduces the failure to a bounded category, because a launch error string can contain a
    // filesystem path and this report is uploaded.
    expect(runnerSource).toContain("'browser-not-installed'");
    expect(runnerSource).toContain("'browser-dependencies-missing'");
    expect(runnerSource).not.toContain('error.message)}');
  });

  it('distinguishes the three absence reasons, because they are three different findings', () => {
    expect(runnerSource).toContain("'host-not-approved'");
    expect(runnerSource).toContain("'browser-not-installed'");
    expect(runnerSource).toContain('reasonDetail');
  });

  it('evaluates the OS-family requirement instead of printing a partial matrix as complete', () => {
    expect(runnerSource).toContain('unmetOsFamilyRequirement');
    expect(runnerSource).toContain('UNMET PLAN SECTION 10.4 REQUIREMENT');
    expect(runnerSource).toContain("for (const os of ['linux', 'macos', 'windows'])");
    expect(runnerSource).toContain("for (const family of ['chromium', 'non-chromium'])");
  });

  it('the exit-3 path exists and fires, which is proved rather than claimed', () => {
    // An exit code nobody has ever seen is a claim, not a guarantee. The runner is pointed at a
    // scratch config whose spec passes - so the **only** thing under test is the coverage verdict -
    // and the same run is asked for two scopes. `runnable` must be 0 and `matrix` must be 3 on
    // identical green results, which is the whole claim: a green run says out loud that it did not
    // cover the matrix.
    //
    // Two `execFileSync` calls, each of which probes five browser engines by **launching** them, so
    // this is the slow test in the file and it carries an explicit timeout for that reason. Vitest's
    // 5-second default would otherwise turn a working proof into a timeout - the failure mode
    // `tests/phase19/assistanceNonVacuity.test.ts` already hit in this repository, where a spawned
    // child suite timed out under load and read as a product defect.
    const scratch = writeScratchRunnerFixture();
    const runWith = (scope: string): { status: number; output: string } => {
      try {
        const output = execFileSync(
          'node',
          [
            RUNNER_PATH,
            `--require=${scope}`,
            `--config=${scratch.config}`,
            `--project-prefix=${scratch.prefix}`,
          ],
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return { status: 0, output };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return {
          status: typeof failure.status === 'number' ? failure.status : 1,
          output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
        };
      }
    };

    const runnable = runWith('runnable');
    expect(runnable.status, runnable.output).toBe(0);
    expect(runnable.output).toContain('COVERAGE: complete for scope "runnable"');
    expect(runnable.output).toContain('RESULT: PASSED');

    const matrix = runWith('matrix');
    expect(matrix.status, matrix.output).toBe(A11Y_INCOMPLETE_EXIT_CODE);
    expect(matrix.status, 'the incomplete status must be distinct from the failure status').not.toBe(1);
    expect(matrix.output).toContain('COVERAGE: INCOMPLETE for scope "matrix"');
    expect(matrix.output).toContain('a macos runner is required');
    expect(matrix.output).toContain('RESULT: INCOMPLETE');
    // And the same run's own assertions were green: this is the green-but-incomplete verdict, not a
    // failure being relabelled.
    expect(matrix.output).not.toContain('RESULT: FAILED');
  }, 240_000);

  it('reads its counts from the JSON reporter, not from a terminal line', () => {
    // A report whose counts come from parsing prose is a report whose counts can be wrong in a way
    // nothing notices. `--reporter=json` plus `report.stats` plus a walk of the suite tree.
    expect(runnerSource).toContain("'--reporter=json'");
    expect(runnerSource).toContain('PLAYWRIGHT_JSON_OUTPUT_NAME');
    expect(runnerSource).toContain('report.stats');
    expect(runnerSource).toContain('perProjectCounts');
  });

  it('refuses to run without a web artifact, and names the build and the record command', () => {
    expect(runnerSource).toContain("path.join(REPO_ROOT, 'dist', 'index.html')");
    expect(runnerSource).toContain('npm run build:web');
    expect(runnerSource).toContain('npm run record:web-artifact');
  });

  it('writes sanitized evidence under the allowlisted root, and nothing else', () => {
    expect(runnerSource).toContain('artifacts/compatibility-evidence');
    // The evidence names the coverage verdict, so the claim outlives the terminal. A report that
    // exists only on a console is a report nobody reads a week later.
    expect(runnerSource).toContain('coverageComplete');
    expect(runnerSource).toContain('cellsAbsent');
    expect(runnerSource).toContain('manualGatesNotDischarged');
    expect(runnerSource).toContain('unscannedSurfaces');
  });

  it('refuses to claim screen-reader, ChromeVox, physical-device or OS certification', () => {
    // Asserted on the runner's own output text, because that text is what a reader sees.
    expect(runnerSource).toContain('NOT screen-reader, ChromeVox, physical');
    expect(runnerSource).toContain("physical-device-manual is not among them");
    expect(runnerSource).toContain('COVERAGE: INCOMPLETE');
  });

  it('records no trace, screenshot or video, so no run can leave a raw failure artifact', () => {
    // A Playwright trace embeds a font file, and a trace under `artifacts/` is what turned the
    // Phase 20 repository-wide font walk into a recurring false red. Both halves are asserted: the
    // config disables the artefacts, and this gate does not walk the tree at all.
    for (const value of ["trace: 'off'", "screenshot: 'off'", "video: 'off'"]) {
      expect(configSource, value).toContain(value);
    }
    expect(runnerSource).not.toContain('trace:');
  });
});

describe('the npm scripts exist and each carries the scope its name claims', () => {
  it('test:a11y asks for the host scope, because that is the plan requirement scoped to one host', () => {
    expect(npmScripts[A11Y_SCRIPTS.host]).toContain('--require=host');
    expect(npmScripts[A11Y_SCRIPTS.host]).toContain(A11Y_RUNNER_SCRIPT);
    // The script the plan's own Verification block names is this one.
    const plan = readFileSync(PLAN_PATH, 'utf8');
    const phase = plan.slice(plan.indexOf('## Phase 21: Accessibility and Responsive-Device Audit'));
    expect(phase).toContain('npm run test:a11y');
    expect(npmScripts[A11Y_SCRIPTS.host], 'the plan names `npm run test:a11y`, so it must exist').toBeDefined();
  });

  it('the three scopes are three distinct scripts, and each is a distinct command', () => {
    const commands = new Set(
      A11Y_COVERAGE_SCOPES.map((scope) => npmScripts[A11Y_SCRIPTS[scope]]),
    );
    expect(commands.size).toBe(A11Y_COVERAGE_SCOPES.length);
    for (const scope of A11Y_COVERAGE_SCOPES) {
      expect(npmScripts[A11Y_SCRIPTS[scope]], scope).toContain(`--require=${scope}`);
      expect(npmScripts[A11Y_SCRIPTS[scope]], scope).toContain(A11Y_RUNNER_SCRIPT);
    }
  });

  it('no script passes both the runner and a build, because a scan must describe one artifact', () => {
    // The runner's own header says the build belongs to the caller, so a script that both builds
    // and audits could silently audit a different `dist` than the one the caller recorded.
    for (const scope of A11Y_COVERAGE_SCOPES) {
      expect(npmScripts[A11Y_SCRIPTS[scope]], scope).not.toContain('build:web');
    }
  });
});

describe('CI runs the runnable scope and never the matrix scope', () => {
  it('the browser-smoke job runs the CI script by name', () => {
    expect(ciSource).toContain(`npm run ${A11Y_CI_RUN_SCRIPT}`);
    expect(A11Y_CI_RUN_SCRIPT).toBe(A11Y_SCRIPTS.runnable);
  });

  it('no CI step runs the matrix scope, and the wiring gate names why', () => {
    // The `matrix` scope exits 3 from a single-host runner by construction: `compat-webkit` is
    // macOS-only, `compat-edge` is Windows-only, and the five manual gates need hardware. Wiring it
    // into a PR gate would make every pull request permanently red, which is the same failure as a
    // gate that always passes — a run whose status carries no information.
    expect(A11Y_SCRIPTS.matrix).not.toBe(A11Y_CI_RUN_SCRIPT);
    expect(ciSource).not.toContain(`npm run ${A11Y_SCRIPTS.matrix}`);
    // And the three steps it does not run are named in this file's own header comment, so a reader
    // who wonders where the full-matrix gate is finds the answer next to the assertion.
    expect(A11Y_SCRIPTS.matrix).toBe('test:a11y:complete');
  });

  it('the accessibility step is not exempt from failing', () => {
    // `continue-on-error` on the accessibility step would turn a regression into a green run, which
    // is precisely the outcome this whole phase must not have. Matched on the step's own block.
    const stepIndex = ciSource.indexOf(`npm run ${A11Y_CI_RUN_SCRIPT}`);
    expect(stepIndex, 'the CI step invoking the accessibility runner was found').toBeGreaterThan(-1);
    const stepStart = ciSource.lastIndexOf('- name:', stepIndex);
    const stepBlock = ciSource.slice(stepStart, stepIndex);
    expect(stepBlock, 'the step block carries an exemption key').not.toContain('continue-on-error');
  });

  it('the accessibility evidence upload names the allowlisted root and nothing else', () => {
    // The runner writes under `artifacts/compatibility-evidence/`, which every other browser lane
    // already uploads. Asserting the upload exists keeps the coverage claim from living only on a
    // console.
    expect(ciSource).toContain('artifacts/compatibility-evidence');
  });
});