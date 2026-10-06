/**
 * Phase 21 accessibility audit cell plan: the machine-readable statement of **which matrix cells
 * carry automated accessibility evidence, which do not, and what each one's evidence class is**.
 *
 * Imported by `tests/e2e/playwright.a11y.config.ts` to generate its projects and by
 * `scripts/run-a11y-audit.mjs` (through a mirrored declaration that
 * `tests/phase21/infraA11ySuite.test.ts` holds equal) to decide what it may claim.
 *
 * ## Why this file exists at all, when the support matrix already exists
 *
 * `tests/e2e/support-matrix.ts` is the authority on **approved support dimensions**. This file is the
 * authority on a different and narrower question: of those approved projects, **which ones this
 * phase runs an automated accessibility scan on**, and what the phase is *not* covering.
 *
 * The gap between the two is the whole risk of Phase 21, so it is worth naming precisely.
 * `EVIDENCE_CLASSES` already distinguishes `emulated-viewport`, `engine-automation` and
 * `branded-channel-automation` from **`physical-device-manual`**, and
 * `tests/e2e/support-matrix.test.ts` already asserts that **no** matrix entry claims
 * `physical-device-manual`. So the matrix has the vocabulary and a gate on it. What it does not
 * have is a statement of *coverage*, and a report that says "the accessibility suite passed"
 * without one is exactly the prose the matrix exists to prevent.
 *
 * ## What automation can and cannot establish here, stated rather than implied
 *
 * This host is a Linux container with **no physical Chromebook, no tablet, no touch hardware, no
 * ChromeVox, and no touch screen reader**. So every cell in the plan is either
 * `emulated-viewport` or `engine-automation` evidence, and the five `PHYSICAL_DEVICE_GATES` are
 * manual and unreachable from here. The plan below therefore:
 *
 * - **names the engine family** of each cell as `chromium` or `non-chromium`, because the plan's
 *   own requirement is "at least one Chromium and one non-Chromium lane for each supported OS
 *   family", which is a statement about coverage and not about flags;
 * - **names the host operating system** each cell is approved for, read from the matrix rather than
 *   retyped, so a cell cannot be run on a host the matrix does not approve it for;
 * - **records `evidenceClass` on every cell**, taken from the matrix, so a report cannot round an
 *   emulated viewport up to a device;
 * - and states, once, that **no cell here is `physical-device-manual`** - which is asserted, not
 *   just documented.
 *
 * ## The requirement, and what happens when it cannot be met
 *
 * {@link A11Y_OS_FAMILY_REQUIREMENT} is the plan's own sentence, quoted. `scripts/run-a11y-audit.mjs`
 * evaluates it against the cells that actually ran and **exits non-zero when it is unmet**, rather
 * than printing a partial matrix as though it were complete. Three scopes are available and each
 * answers a different question, which is why the flag exists rather than one hard-coded verdict:
 *
 * - **`runnable`** - every cell this host could run. A PR gate. Green means "nothing on this host
 *   was skipped".
 * - **`host`** - every cell approved for this host's operating system. Answers "did this OS family
 *   get its Chromium and non-Chromium coverage", which is the plan's requirement scoped to one host.
 * - **`matrix`** - all eight cells plus the manual gates. This is the phase exit criterion, and it
 *   **cannot** pass from a single Linux container. It is a checklist command, not a PR gate, and
 *   `tests/phase21/infraA11ySuite.test.ts` asserts it is not wired into one.
 *
 * ## No learner data
 *
 * Nothing here contains learner data, credentials, request headers, queries, fragments, request
 * bodies, or private URLs. The fixture the suite seeds is the repository's own synthetic subject.
 */

import {
  BROWSER_ENGINES,
  EVIDENCE_CLASSES,
  HOST_OPERATING_SYSTEMS,
  PHYSICAL_DEVICE_GATES,
  SUPPORT_MATRIX,
  type BrowserEngine,
  type EvidenceClass,
  type HostOperatingSystem,
} from './support-matrix';

export const A11Y_MATRIX_SCHEMA_VERSION = 1;

/**
 * Which matrix projects carry automated accessibility evidence in Phase 21.
 *
 * **All eight**, and that is a decision with a cost rather than a default. The plan requires the
 * accessibility checks on "at least one Chromium and one non-Chromium lane for each supported OS
 * family", and a plan whose audit runs on four of its eight projects would be auditing a subset it
 * never said it was auditing. Running all eight means the runner has to discover which ones a host
 * can actually run - and it discovers them by **launching the browser**, not by reading a flag.
 */
export const A11Y_PROJECTS = Object.freeze(SUPPORT_MATRIX.map((entry) => entry.project));

/**
 * The two engine families the plan's requirement is written in.
 *
 * A named pair rather than a boolean, because the pair is what the requirement is stated over and
 * a boolean would let a future cell be classified by a rule nobody wrote down.
 */
export const A11Y_ENGINE_FAMILIES = Object.freeze(['chromium', 'non-chromium'] as const);
export type A11yEngineFamily = (typeof A11Y_ENGINE_FAMILIES)[number];

/**
 * Which family a browser engine belongs to, read from the matrix's own `engine` field.
 *
 * `firefox` and `webkit` are the non-Chromium families and `chromium` is the Chromium one - and
 * that is a fact about **engines**, not about distributions: a branded Chromium channel such as
 * `compat-edge`'s `msedge` is the Chromium family and is recorded as `branded-channel-automation`,
 * which is a different evidence class from the same engine. Both facts are carried separately,
 * because collapsing them is how "Edge is a Chromium result" becomes "we tested Edge and Chromium".
 */
export function engineFamilyFor(engine: BrowserEngine): A11yEngineFamily {
  return engine === 'chromium' ? 'chromium' : 'non-chromium';
}

/**
 * The plan's own requirement, quoted, so a reader can check the gate against its source text
 * without opening the plan.
 */
export const A11Y_OS_FAMILY_REQUIREMENT =
  'Run accessibility checks on at least one Chromium and one non-Chromium lane for each supported OS family.';

/** The three coverage scopes, and the question each one answers. */
export const A11Y_COVERAGE_SCOPES = Object.freeze(['runnable', 'host', 'matrix'] as const);
export type A11yCoverageScope = (typeof A11Y_COVERAGE_SCOPES)[number];

/** The exit status a green-but-incomplete run carries. Distinct from 1, which means "failed". */
export const A11Y_INCOMPLETE_EXIT_CODE = 3;

export interface A11yCell {
  /** The Playwright project name, and the matrix entry it comes from. */
  readonly project: string;
  readonly engine: BrowserEngine;
  readonly engineFamily: A11yEngineFamily;
  readonly channel: string;
  /** The Playwright `channel` option, when the matrix declares a branded one. */
  readonly channelOption?: string;
  /** Hosts the matrix approves this project for. */
  readonly hostOperatingSystems: readonly HostOperatingSystem[];
  readonly formFactor: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly hasTouch: boolean;
  readonly inputMode: string;
  /**
   * The matrix's own classification, copied rather than restated.
   *
   * Copied because the whole point is that a report cannot round a value up, and a value this file
   * retyped could be rounded up independently of the matrix it claims to come from. The wiring gate
   * asserts cell-by-cell equality with `SUPPORT_MATRIX`.
   */
  readonly evidenceClass: EvidenceClass;
}

export const A11Y_CELLS: readonly A11yCell[] = Object.freeze(
  SUPPORT_MATRIX.map((entry) =>
    Object.freeze({
      project: entry.project,
      engine: entry.engine,
      engineFamily: engineFamilyFor(entry.engine),
      channel: entry.channel,
      ...(entry.channelOption === undefined ? {} : { channelOption: entry.channelOption }),
      hostOperatingSystems: entry.hostOperatingSystems,
      formFactor: entry.formFactor,
      viewport: entry.viewport,
      hasTouch: entry.hasTouch,
      inputMode: entry.inputMode,
      evidenceClass: entry.evidenceClass,
    }),
  ),
);

export function a11yCellFor(project: string): A11yCell {
  const cell = A11Y_CELLS.find((candidate) => candidate.project === project);
  if (cell === undefined) throw new Error(`Unknown accessibility cell: ${project}`);
  return cell;
}

/**
 * The manual gates this phase inherits, and cannot discharge from a container.
 *
 * Carried here rather than read from the matrix so the runner's report and the plan's exit criteria
 * are talking about the same five, and so a reader of the coverage block does not have to open a
 * second file to learn what is outstanding.
 */
export const A11Y_MANUAL_GATES = Object.freeze(
  PHYSICAL_DEVICE_GATES.map((gate) =>
    Object.freeze({
      id: gate.id,
      requirement: gate.requirement,
      targetPhase: gate.targetPhase,
      automated: gate.automated,
      reason: gate.reason,
    }),
  ),
);

/**
 * The WCAG 2.2 A/AA tag set the scan runs with.
 *
 * The same five tags `currentBuild.spec.ts` and the Phase 10 lane use, declared once here so a
 * second suite cannot quietly scan a narrower set and report "no violations". `EVIDENCE_CLASSES`
 * and `BROWSER_ENGINES` are re-exported below rather than imported twice at each use site.
 */
export const A11Y_WCAG_TAGS = Object.freeze([
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
] as const);

export { BROWSER_ENGINES, EVIDENCE_CLASSES, HOST_OPERATING_SYSTEMS };

/**
 * The surfaces the automated suite scans, and what each scan is allowed to conclude.
 *
 * Stated as data so the runner's evidence names the surfaces it scanned rather than saying
 * "accessibility". Three surfaces and no more, and the omission is deliberate rather than an oversight:
 * Phase 21's scope names ten, and the per-surface assertions belong to the owners of those
 * surfaces. This file is the *runner*; its claim is "these two surfaces, on these cells, with these
 * tags", and a larger claim needs the scans that go with it.
 *
 * ## Every surface is reachable on every cell, and the two that are not obvious are
 *
 * `reach` is not decoration. On the two touch cells the village HUD is a bottom sheet that is
 * **closed and unmounted by default** - `VillageHud` drops the whole column from the tree until the
 * toggle is pressed - so the nearby action list and the Settings launcher exist only while that
 * drawer is open, and a scan that did not open it would be scanning a tablet's village with no
 * status panel and no way to reach Settings at all. The suite opens it by pressing the toggle, which
 * is the route a touch learner takes, and {@link A11Y_SURFACE_TITLE_SEPARATOR} exists so the runner
 * can tell a reader which cell covered which surface.
 *
 * The alternative - recording the village and Settings as unscanned on the two touch cells - was the
 * other honest option and was rejected for a concrete reason rather than for taste: the drawer is
 * *how* a touch learner reaches those surfaces, so the gap was an artefact of the probe, not of the
 * product. See the spec's own `openVillage` for the measurement that settled it.
 */
export const A11Y_SCANNED_SURFACES = Object.freeze([
  {
    id: 'welcome',
    label: 'Welcome',
    /**
     * How the suite reaches it, and why that is the cheapest honest route: the first route a
     * learner takes, and the one `dist/index.html`'s budget is measured against.
     */
    reach: 'the entry route, after the application has hydrated and settled',
  },
  {
    id: 'village',
    label: 'Village',
    /**
     * Reached through the application's own tutorial route rather than by seeding state, because
     * the point of scanning the village is that a learner can reach it with the controls the
     * product ships - including, on the touch cells, the drawer toggle that reveals the HUD.
     */
    reach: 'the tutorial route, through "Start Tutorial" and "Go to Village"',
  },
  {
    id: 'settings',
    label: 'Settings dialog',
    reach:
      'opened from the village HUD - which on a touch cell means opening the HUD drawer first, ' +
      'because the launcher lives inside it - and scanned while the dialog has focus',
  },
] as const);

export type A11ySurfaceId = (typeof A11Y_SCANNED_SURFACES)[number]['id'];

/**
 * The prefix a test that scans one declared surface puts on its title: `"<surface id>: "`.
 *
 * Exists so the **runner** can compute per-cell surface coverage from the JSON report it already
 * reads, rather than from prose a maintainer has to keep in step by hand. It is the whole of the
 * mechanism: the runner mirrors the surface id list (already mirrored and held equal by
 * `tests/phase21/infraA11ySuite.test.ts`) and derives coverage from these prefixes, so a cell that
 * stopped scanning a surface says so in the coverage block instead of looking like a cell that
 * scanned everything.
 *
 * A prefix rather than a separate manifest for one reason: a manifest is a second thing to keep
 * correct, and the one this replaces - "the runner prints a flat list of surfaces and every cell
 * reads as having scanned all of them" - is precisely a claim nothing checks.
 */
export const A11Y_SURFACE_TITLE_SEPARATOR = ': ';

/** The declared surface a test title claims to scan, or `null` when it claims none. */
export function a11ySurfaceFromTestTitle(title: string): A11ySurfaceId | null {
  for (const surface of A11Y_SCANNED_SURFACES) {
    if (title.startsWith(`${surface.id}${A11Y_SURFACE_TITLE_SEPARATOR}`)) return surface.id;
  }
  return null;
}

/** The surfaces this phase's scope names, and that this runner does not yet scan. */
export const A11Y_UNSCANNED_SURFACES = Object.freeze([
  'Creator',
  'Scribe',
  'Archaeologist',
  'Fishing',
  'Statistics',
  'Data Center',
  'share dialogs',
] as const);

/**
 * The serious and critical violations this repository **already records** on two of the surfaces
 * this suite scans, and which are therefore not this suite's to introduce or to fix.
 *
 * ## Why a list at all, and why exactly these two
 *
 * "Zero serious or critical automated accessibility violations" is the phase's exit criterion, and a
 * suite that starts from zero while two exceptions are on the record is a suite whose first red is a
 * finding it already knew about. Both entries below are **already tolerated by an existing gate**,
 * and both are named in a comment in that gate as belonging to Phase 21's removal work:
 *
 * - `color-contrast|serious|.welcome-checklist-status--done` - `tests/e2e/currentBuild.spec.ts`
 *   records it with the comment "Phase 1 records this pre-existing contrast defect rather than
 *   redesigning the current UI ... Phase 21 owns removal of the recorded exception."
 * - `color-contrast|serious|.hud-stat-subtle` - `tests/e2e/phase10-media-lane.ts` records it for the
 *   same reason, on the game HUD.
 *
 * ## What this list is not
 *
 * It is not a place to put a finding this audit discovered. A **new** serious or critical violation
 * is the phase's work, and this suite failing on one is the suite working. The wiring gate asserts
 * every entry appears verbatim in one of the two gates above, so this list cannot grow into a
 * blanket allowance without a red `npm test` - and it asserts the list is non-empty, because a suite
 * that tolerates nothing cannot prove it is measuring.
 */
export const A11Y_KNOWN_BLOCKING_SIGNATURES = Object.freeze([
  'color-contrast|serious|.welcome-checklist-status--done',
  'color-contrast|serious|.hud-stat-subtle',
] as const);

/** Plan section 10.1's minimum touch target, in CSS pixels. */
export const A11Y_MINIMUM_TOUCH_TARGET_PX = 44;

/**
 * The npm scripts that drive the runner, and the scope each one asks for.
 *
 * Declared here so `package.json` is checked against this table by name rather than by a regex,
 * which is the pattern every other lane in this repository uses.
 */
export const A11Y_RUNNER_SCRIPT = 'scripts/run-a11y-audit.mjs';
export const A11Y_SCRIPTS: Readonly<Record<A11yCoverageScope, string>> = Object.freeze({
  runnable: 'test:a11y:runnable',
  host: 'test:a11y',
  matrix: 'test:a11y:complete',
});

/**
 * The script CI runs, and why it is the `runnable` scope rather than the `host` one.
 *
 * `browser-smoke` runs on `ubuntu-latest`, where the `host` scope and the `runnable` scope happen
 * to coincide - so the choice is only visible in the words. `runnable` is the honest CI contract:
 * "everything this runner could have done on this host, it did, and it passed." A CI step that
 * claimed the `host` scope would be asserting a coverage requirement, and a job that runs on one
 * OS cannot establish a requirement about three.
 */
export const A11Y_CI_RUN_SCRIPT = A11Y_SCRIPTS.runnable;

/**
 * Structural problems with the cell plan. Empty means consistent.
 *
 * The properties asserted here are the ones whose absence would let a report round an emulated
 * viewport up to a physical device, or let the plan's OS-family requirement go unevaluated.
 */
export function validateA11yMatrix(cells: readonly A11yCell[] = A11Y_CELLS): readonly string[] {
  const problems: string[] = [];
  const projects = new Set<string>();
  for (const cell of cells) {
    if (!/^[a-z0-9-]+$/.test(cell.project)) problems.push(`${cell.project}: project name must be lowercase kebab-case.`);
    if (projects.has(cell.project)) problems.push(`${cell.project}: duplicate cell name.`);
    projects.add(cell.project);
    if (cell.hostOperatingSystems.length === 0) {
      problems.push(`${cell.project}: a cell with no approved host cannot be planned.`);
    }
    if (!A11Y_ENGINE_FAMILIES.includes(cell.engineFamily)) {
      problems.push(`${cell.project}: undeclared engine family "${cell.engineFamily}".`);
    }
    // The single most important line in this file.
    if (cell.evidenceClass === 'physical-device-manual') {
      problems.push(
        `${cell.project}: physical-device evidence is manual and must never be an automated cell. A Playwright project claiming it would let a viewport emulation be reported as a device check.`,
      );
    }
    if (!EVIDENCE_CLASSES.includes(cell.evidenceClass)) {
      problems.push(`${cell.project}: undeclared evidence class "${cell.evidenceClass}".`);
    }
    if (cell.viewport.width <= 0 || cell.viewport.height <= 0) {
      problems.push(`${cell.project}: viewport dimensions must be positive.`);
    }
    if ((cell.formFactor === 'tablet-portrait' || cell.formFactor === 'tablet-landscape') !== cell.hasTouch) {
      problems.push(`${cell.project}: tablet form factors must enable emulated touch input.`);
    }
  }
  if (cells.length !== A11Y_PROJECTS.length) {
    problems.push('every support-matrix entry must appear in exactly one accessibility cell.');
  }
  if (!A11Y_MANUAL_GATES.length) problems.push('the manual physical-device gates must be carried, not dropped.');
  if (!A11Y_KNOWN_BLOCKING_SIGNATURES.length) {
    problems.push('a suite that tolerates no known exception must prove it; one that tolerates everything proves nothing.');
  }
  if (!A11Y_UNSCANNED_SURFACES.length) {
    problems.push('the unscanned-surface list must be non-empty while Phase 21 is in progress.');
  }
  if (!A11Y_OS_FAMILY_REQUIREMENT.includes('Chromium')) {
    problems.push('the requirement text must name both engine families it is stated over.');
  }
  return problems;
}