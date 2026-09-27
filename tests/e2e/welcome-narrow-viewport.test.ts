/**
 * The jsdom half of the 320 CSS-pixel viewport gate.
 *
 * ## What each half can honestly assert
 *
 * The measurement itself is Chromium, in `currentBuild.spec.ts`, because jsdom
 * has no layout engine and cannot tell a passing page from a broken one. What
 * *this* file asserts is the half jsdom can be authoritative about: that the
 * measurement contract still says what it said, and - the part that actually
 * protects the gate - that the gate is still **bound and run** by the CI step
 * that reuses the already-built production artifact.
 *
 * A regression test that is never executed is worse than no regression test,
 * because it is read as coverage. So this file fails if:
 *
 * 1. the plan's 320-pixel width or 44-pixel minimum is changed in the
 *    measurement module without the constants being restated here;
 * 2. the name-length table loses a case, or loses the unbreakable 78- and
 *    122-character cases, or loses the no-subject case, because those are the
 *    cases that actually fail;
 * 3. either test is deleted from `currentBuild.spec.ts`, or the spec stops
 *    importing the measurement module and inlines its own numbers;
 * 4. the CI step that runs the gate stops running the suite, gains an exemption
 *    that lets it fail green, or starts building its own artifact - which would
 *    be a second build in a run that plan §2.5 and §10.4 say has exactly one.
 *
 * ## Why this needs no new Playwright project
 *
 * `tests/e2e/support-matrix.ts` sanctions the projects, and the four
 * Phase 1 current-build ones are all Chromium. `playwright.config.ts` binds each
 * of them to exactly one `testMatch`, and `support-matrix.test.ts` asserts those
 * bindings, so a fifth project or a widened `testMatch` would weaken an existing
 * gate. The measurement narrows the viewport inside a test instead, which is
 * what the viewport is *for*: the project's job is to supply the engine, and the
 * width under test is the width the plan names. This gate asserts the sanctioned
 * project set is still exactly the four, so "no new project" is a checked fact
 * rather than an intention.
 *
 * Privacy: nothing here contains learner data, and the spec it reads is checked
 * as text, never executed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHASE_1_CURRENT_BUILD_PROJECTS, CURRENT_BUILD_TEST_FILE } from './support-matrix';
import {
  OVERFLOW_TOLERANCE_PX,
  PLAN_MINIMUM_TOUCH_TARGET_PX,
  PLAN_ZOOM_PERCENT,
  SUBJECT_NAME_LENGTH_CASES,
  WELCOME_NARROW_VIEWPORT,
  WELCOME_SECTION_TAB_NAMES,
} from './welcome-narrow-viewport';

const REPO_ROOT = process.cwd();
const SPEC_PATH = path.join(REPO_ROOT, `tests/e2e/${CURRENT_BUILD_TEST_FILE}`);
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

const specSource = readFileSync(SPEC_PATH, 'utf8');
const ciWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const npmScripts = (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { scripts: Record<string, string> })
  .scripts;

const OVERFLOW_TEST_TITLE =
  'the Welcome shell has no horizontal overflow at 320 CSS pixels, at any subject-name length';
const TOUCH_TARGET_TEST_TITLE =
  'every Welcome shell control meets the 44 CSS-pixel minimum touch target at 320 pixels';

/** Splits the workflow into job blocks keyed by job id, as the matrix gate does. */
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
const browserSmokeJob = ciJobs.get('browser-smoke') ?? '';
const browserSmokeSteps = browserSmokeJob
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('- name: ') || line.startsWith('run: ') || line.startsWith('continue-on-error:'));

describe('the 320 CSS-pixel viewport measurement contract', () => {
  it('measures the width and the target size the plan actually names', () => {
    // Plan section 10.1, verbatim: "Core operation at 200 % zoom and a 320
    // CSS-pixel viewport" and "Minimum 44 by 44 CSS-pixel touch targets".
    expect(WELCOME_NARROW_VIEWPORT).toEqual({ width: 320, height: 640 });
    expect(PLAN_MINIMUM_TOUCH_TARGET_PX).toBe(44);
    expect(PLAN_ZOOM_PERCENT).toBe(200);
    // Half a pixel: below anything a finger can hit, above a rounding artefact.
    expect(OVERFLOW_TOLERANCE_PX).toBeGreaterThan(0);
    expect(OVERFLOW_TOLERANCE_PX).toBeLessThan(1);
  });

  it('covers every subject-name length the defect was reported at, and the empty device', () => {
    const lengths = SUBJECT_NAME_LENGTH_CASES.map((nameCase) => nameCase.characters).sort((a, b) => a - b);
    expect(lengths).toEqual([0, 1, 29, 78, 122]);
  });

  it('keeps the cases that actually fail, which are the unbreakable names', () => {
    for (const characters of [78, 122]) {
      const nameCase = SUBJECT_NAME_LENGTH_CASES.find((entry) => entry.characters === characters);
      expect(nameCase, `no ${characters}-character case`).toBeDefined();
      expect(nameCase?.subjectName).toHaveLength(characters);
      // A name with a space has a min-content equal to its longest word, so it
      // stops growing the floor. Only a name with no break opportunity in it can
      // reproduce this defect at all.
      expect(nameCase?.subjectName).not.toMatch(/\s/);
    }
    // The empty device is a case in its own right: it has the lowest floor, and it
    // is the state a first-time learner is actually in.
    expect(
      SUBJECT_NAME_LENGTH_CASES.find((entry) => entry.characters === 0)?.subjectName,
    ).toBeNull();
  });

  it('names every Welcome section tab, so a control on a hidden tab is still covered', () => {
    expect([...WELCOME_SECTION_TAB_NAMES]).toEqual(['Create / Load', 'Player Setup', 'Guide', 'Data']);
  });
});

describe('the 320 CSS-pixel gate is bound to the suite CI actually runs', () => {
  it('lives in the current-build spec, which is the suite the shared artifact lane runs', () => {
    expect(specSource).toContain(`from './welcome-narrow-viewport'`);
    expect(specSource).toContain(OVERFLOW_TEST_TITLE);
    expect(specSource).toContain(TOUCH_TARGET_TEST_TITLE);
    // The measurements are imported, not re-invented: the spec must not carry its
    // own copy of the width, the minimum, or the case table.
    expect(specSource).toContain('WELCOME_NARROW_VIEWPORT');
    expect(specSource).toContain('SUBJECT_NAME_LENGTH_CASES');
    expect(specSource).toContain('measureHorizontalOverflow');
    expect(specSource).toContain('measureTouchTargets');
    // ...and it does not inline a different viewport width or target size.
    expect(specSource).not.toMatch(/setViewportSize\(\{\s*width:\s*(?!320\b)\d+/);
  });

  it('runs in the recorded production suite, preview-only', () => {
    expect(npmScripts['test:e2e:recorded']).toBe(`playwright test tests/e2e/${CURRENT_BUILD_TEST_FILE}`);
    // Preview-only: it may not build or record. The artifact is the one
    // `build:web` produced and the build job uploaded.
    expect(npmScripts['test:e2e:recorded']).not.toContain('build:web');
    expect(npmScripts['test:e2e:recorded']).not.toContain('record:web-artifact');
  });

  it('adds no Playwright project, so the sanctioned matrix is still the four', () => {
    expect([...PHASE_1_CURRENT_BUILD_PROJECTS]).toEqual([
      'desktop-chromium',
      'chromebook',
      'tablet',
      'tablet-landscape',
    ]);
  });
});

describe('the 320 CSS-pixel gate is a gating step on the already-built artifact', () => {
  it('runs inside the browser-smoke job that downloads the shared artifact', () => {
    expect(browserSmokeJob, 'browser-smoke job is missing from ci.yml').not.toBe('');
    expect(browserSmokeJob).toContain('npm run test:e2e:recorded');
    expect(browserSmokeJob).toContain('name: web-artifact');
    // The same job, so the gate is one Chromium install and one download away
    // from the artifact, not a second build of its own.
    expect(browserSmokeJob).toContain('npm run verify:web-artifact');
  });

  it('cannot go green while the page overflows', () => {
    const stepIndex = browserSmokeSteps.findIndex((line) => line.includes('test:e2e:recorded'));
    expect(stepIndex, 'no CI step runs test:e2e:recorded').toBeGreaterThan(-1);
    // The step that runs the suite is not exempt, and no step in this job is:
    // a `continue-on-error` anywhere here would turn a broken 320-pixel layout
    // into a green run, which is the exact failure this gate exists to prevent.
    const exempting = browserSmokeSteps.filter((line) => line.startsWith('continue-on-error:'));
    expect(exempting, `browser-smoke is exempt: ${exempting.join(' | ')}`).toEqual([]);
    expect(browserSmokeJob).not.toContain('continue-on-error');
  });

  it('does not add a second production build to the run', () => {
    // Only the build job may run `build:web`; every lane job previews what it
    // downloaded. The support matrix already asserts this, and it is restated
    // here because this gate is the reason someone might be tempted to break it.
    for (const [name, body] of ciJobs) {
      if (name === 'web-build') continue;
      expect(body, `${name} builds a second production artifact`).not.toContain('npm run build:web');
    }
    expect(ciJobs.has('web-build')).toBe(true);
  });
});
