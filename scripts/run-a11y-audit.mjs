#!/usr/bin/env node
/**
 * The Phase 21 accessibility audit runner: `npm run test:a11y`.
 *
 * ## Why a runner and not a bare `playwright test`
 *
 * Because the phase's central integrity risk is not a failing assertion - it is a **passing** one
 * that means less than it appears to. Plan section 10.4's own requirement is about coverage: "Run
 * accessibility checks on at least one Chromium and one non-Chromium lane for each supported OS
 * family." A script that ran whatever browsers it happened to find and exited 0 would satisfy an
 * axe scan and fail that requirement silently, and the failure would be invisible precisely because
 * the run was green.
 *
 * So this runner:
 *
 * 1. **Plans the cells** from the support matrix - all eight, mirrored here and held equal to
 *    `tests/e2e/a11y-matrix.ts` by `tests/phase21/infraA11ySuite.test.ts`.
 * 2. **Probes runnability by launching the browser**, not by reading a flag. A cell the matrix
 *    approves for another host is absent with that reason; a cell whose browser cannot launch on
 *    this host is absent with *that* reason, and the two are different findings.
 * 3. **Runs the runnable cells**, with Playwright's JSON reporter, so the per-cell counts are read
 *    from a machine-readable result rather than scraped out of a terminal line. The child's own
 *    stdout and stderr are piped rather than inherited or discarded, and are relayed into this
 *    report **only when the run failed** - see "Reading a red run" below.
 * 4. **Prints a coverage block naming every cell that ran and every cell that did not**, with a
 *    reason for each absence, **which of the declared surfaces each cell actually scanned**, and the
 *    five manual physical-device gates it cannot discharge.
 * 5. **Writes the coverage into sanitized JSON evidence** under the allowlisted
 *    `artifacts/compatibility-evidence/` root, so the claim outlives the terminal.
 * 6. **Exits non-zero on incompleteness**, which is the whole point.
 *
 * ## Reading a red run
 *
 * The child process is spawned with `stdio: ['ignore', 'pipe', 'pipe']`. That is also the default, so
 * it is named in the code to record why the choice is deliberate:
 *
 * - **`inherit` would make the report unreadable.** Playwright's progress lines would interleave
 *   with the aligned coverage table, so the one section a reader is scanning becomes the one section
 *   that cannot be scanned.
 * - **`ignore` was the defect.** A reader who found `passed 7 failed 1` had to open
 *   `artifacts/a11y-run-report.json` to learn what failed. The counts were correct and useless, which
 *   is worse than a wrong number because nothing looks wrong.
 *
 * So the output is drained and relayed under `ASSERTION FAILURES`, taking the message from the JSON
 * report's own `errors[]` - the assertion text this repository writes on purpose, naming the surface
 * and the violation - and bounded so a red run with many failures stays readable. Nothing is added to
 * a green run's output.
 *
 * ## Exit statuses, and why there are three
 *
 * | status | meaning |
 * | --- | --- |
 * | `0` | every cell in the requested scope ran, every assertion passed, and nothing in that scope is outstanding |
 * | `1` | an accessibility assertion failed, or a cell the scope required did not run |
 * | `3` | green, but the requested scope is not complete - and the block above names every absence |
 *
 * `3` is deliberately distinct from `1`. Conflating them is what makes a partial matrix
 * indistinguishable from a failure in a CI summary, and it is why a runner that cannot meet its own
 * requirement must not be wired into a PR gate that runs on one host.
 *
 * ## Scopes
 *
 * - `runnable` (`npm run test:a11y:runnable`) - every cell this host could run. **This is what CI
 *   runs.** "Nothing on this host was skipped."
 * - `host` (`npm run test:a11y`) - every cell approved for this host's OS family. Answers the plan's
 *   requirement scoped to one host, which is as far as one host can go.
 * - `matrix` (`npm run test:a11y:complete`) - all eight cells plus the five manual gates. This is
 *   the phase exit criterion, and it **cannot** pass from a Linux container. It is a checklist
 *   command, deliberately not wired into CI, and the wiring gate asserts it stays that way.
 *
 * ## `--config` and `--project-prefix`
 *
 * Overridable only so `tests/phase21/infraA11ySuite.test.ts` can prove the **exit-3 path** - the
 * green-but-incomplete verdict - exists and fires. It cannot be proved against the real suite while
 * that suite has findings to report, and an exit code nobody has ever seen is a claim rather than a
 * guarantee. The gate runs this runner against a scratch config whose spec passes, and asserts that
 * `--require=runnable` exits 0 while `--require=matrix` exits 3 on the *same* run. Every production
 * invocation uses the defaults, so the audited config is always this repository's own.
 *
 * ## Privacy
 *
 * Reads repository files, launches local browsers, and writes sanitized JSON under the allowlisted
 * evidence root. No learner data, no credentials, no request headers or bodies, no outbound request:
 * the preview is a loopback origin and nothing else is contacted. Recorded values are counts,
 * browser version strings, boolean cells, and bounded category names.
 *
 * Usage:
 *   node scripts/run-a11y-audit.mjs [--require=runnable|host|matrix] [--json]
 *                                     [--config=<path>] [--project-prefix=<prefix>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as playwright from 'playwright-core';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/* ── The cell plan, mirrored from tests/e2e/a11y-matrix.ts ───────────────────── */

/**
 * Every support-matrix entry, with the four fields the runner reasons about.
 *
 * **Mirrored, not imported.** This script is plain ESM run by `node`, which does not load a
 * TypeScript module, and the plan's own data lives in a `.ts` file so the Playwright config can
 * generate its projects from it. A mirror is a second implementation, so it is held equal to the
 * original by `tests/phase21/infraA11ySuite.test.ts` - which reads **both** and compares them
 * field by field. That is the same arrangement `require-*-lane-artifact.mjs` and its wiring gates
 * use, and it is what makes a divergence a red `npm test` rather than a quiet lie.
 */
const CELLS = Object.freeze([
  { project: 'desktop-chromium', engine: 'chromium', channelOption: undefined, evidenceClass: 'emulated-viewport', formFactor: 'desktop', hasTouch: false, hostOperatingSystems: ['linux'] },
  { project: 'chromebook', engine: 'chromium', channelOption: undefined, evidenceClass: 'emulated-viewport', formFactor: 'chromebook', hasTouch: false, hostOperatingSystems: ['linux'] },
  { project: 'tablet', engine: 'chromium', channelOption: undefined, evidenceClass: 'emulated-viewport', formFactor: 'tablet-portrait', hasTouch: true, hostOperatingSystems: ['linux'] },
  { project: 'tablet-landscape', engine: 'chromium', channelOption: undefined, evidenceClass: 'emulated-viewport', formFactor: 'tablet-landscape', hasTouch: true, hostOperatingSystems: ['linux'] },
  { project: 'compat-chromium', engine: 'chromium', channelOption: undefined, evidenceClass: 'engine-automation', formFactor: 'desktop', hasTouch: false, hostOperatingSystems: ['linux', 'macos', 'windows'] },
  { project: 'compat-firefox', engine: 'firefox', channelOption: undefined, evidenceClass: 'engine-automation', formFactor: 'desktop', hasTouch: false, hostOperatingSystems: ['linux', 'macos', 'windows'] },
  { project: 'compat-webkit', engine: 'webkit', channelOption: undefined, evidenceClass: 'engine-automation', formFactor: 'desktop', hasTouch: false, hostOperatingSystems: ['macos'] },
  { project: 'compat-edge', engine: 'chromium', channelOption: 'msedge', evidenceClass: 'branded-channel-automation', formFactor: 'desktop', hasTouch: false, hostOperatingSystems: ['windows'] },
]);

/** The two engine families the plan's requirement is stated over. */
function engineFamily(engine) {
  return engine === 'chromium' ? 'chromium' : 'non-chromium';
}

/** The five manual gates, mirrored from `support-matrix.ts`'s `PHYSICAL_DEVICE_GATES`. */
const MANUAL_GATES = Object.freeze([
  { id: 'physical-chromebook-screen-reader', automated: false, targetPhase: 'Phase 21', reason: 'Chromium viewport emulation cannot prove ChromeVox output or ChromeOS hardware behavior.' },
  { id: 'physical-macos-safari', automated: false, targetPhase: 'Phase 21', reason: 'Playwright WebKit is engine evidence, not a Safari release or macOS version claim.' },
  { id: 'physical-touch-platform-screen-reader', automated: false, targetPhase: 'Phase 21', reason: 'Emulated touch does not prove mobile browser accessibility or touch-target behavior on real hardware.' },
  { id: 'physical-windows-desktop-browser', automated: false, targetPhase: 'Phase 21', reason: 'A Windows runner verifies the recorded artifact but not a user-installed desktop browser profile.' },
  { id: 'physical-linux-desktop-browser', automated: false, targetPhase: 'Phase 21', reason: 'A Linux runner is not a per-distribution desktop certification.' },
]);

/** The surfaces the suite scans, mirrored from `a11y-matrix.ts`. */
const SCANNED_SURFACES = Object.freeze(['welcome', 'village', 'settings']);
/** The surfaces Phase 21's scope names and this runner does not yet scan. */
const UNSCANNED_SURFACES = Object.freeze([
  'Creator',
  'Scribe',
  'Archaeologist',
  'Fishing',
  'Statistics',
  'Data Center',
  'share dialogs',
]);
/**
 * The prefix a test that scans one declared surface puts on its title.
 *
 * Mirrored from `tests/e2e/a11y-matrix.ts`'s `A11Y_SURFACE_TITLE_SEPARATOR`, and joined to the
 * surface ids already mirrored above, which the wiring gate holds equal. Together they let the
 * coverage block below say, per cell, which of the three surfaces that cell actually scanned.
 *
 * Why a title prefix and not a per-test manifest or an attachment: this runner already reads the
 * JSON report and titles are the one field it already had. A second channel would be a second thing
 * to keep correct, and the failure this fixes - a flat `surfaces scanned:` line above six cells, where
 * every cell reads as though it had scanned all three - is a claim nothing was checking.
 */
const SURFACE_TITLE_SEPARATOR = ': ';
const KNOWN_BLOCKING_SIGNATURES = Object.freeze([
  'color-contrast|serious|.welcome-checklist-status--done',
  'color-contrast|serious|.hud-stat-subtle',
]);

const DEFAULT_A11Y_CONFIG = 'tests/e2e/playwright.a11y.config.ts';
const DEFAULT_PROJECT_PREFIX = 'a11y-';
const EVIDENCE_ROOT = path.join(REPO_ROOT, 'artifacts/compatibility-evidence');
const EXIT_FAILED = 1;
const EXIT_INCOMPLETE = 3;

/* ── Host ─────────────────────────────────────────────────────────────────────── */

/**
 * This host's operating system, in the support matrix's own vocabulary.
 *
 * `process.platform` mapped rather than passed through, because a coverage report that says `linux64`
 * and a matrix that says `linux` cannot be compared by eye.
 */
function hostOperatingSystem(platform) {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return null;
}

/* ── Runnability, measured by launching ───────────────────────────────────────── */

/**
 * Whether this host can actually launch a cell's browser.
 *
 * **Launch, not a flag and not a path check.** Three reasons, and the third is the one that decided
 * it: a browser directory can exist while its system libraries do not, a branded channel can be
 * declared while it is not installed, and a permission problem looks exactly like a missing file to
 * a path check. A launch either produces a version string or an error, and both are facts.
 *
 * The error is reduced to a bounded category rather than a message: an error string from a browser
 * launch can contain a filesystem path, and this report is uploaded.
 */
async function probeCell(cell) {
  const browserType = playwright[cell.engine];
  if (browserType === undefined) {
    return { runnable: false, reason: 'engine-unknown', version: null };
  }
  try {
    const browser = await browserType.launch({
      headless: true,
      ...(cell.channelOption === undefined ? {} : { channel: cell.channelOption }),
    });
    const version = browser.version();
    await browser.close();
    return { runnable: true, reason: null, version };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const category = /is not found|Executable doesn't exist/i.test(message)
      ? 'browser-not-installed'
      : /Host system is missing dependencies|missing dependencies to run browsers/i.test(message)
        ? 'browser-dependencies-missing'
        : /no such file|Permission denied/i.test(message)
          ? 'browser-not-executable'
          : 'browser-launch-failed';
    return { runnable: false, reason: category, version: null };
  }
}

/* ── Running ──────────────────────────────────────────────────────────────────── */

/**
 * Run the suite for the named projects and return the per-cell counts.
 *
 * The JSON reporter is used, and its output is read as **data**: this repository has been bitten by
 * harnesses that scrape a terminal line, and a report whose counts come from parsing prose is a
 * report whose counts can be wrong in a way nothing notices. `stats` and each spec's `tests[].status`
 * are both read, so "3 tests ran" cannot be printed when 4 ran and 1 was skipped.
 */
async function runSuite(projects, jsonPath, config, projectPrefix) {
  const args = ['playwright', 'test', `--config=${config}`];
  for (const project of projects) args.push(`--project=${projectPrefix}${project}`);
  args.push('--reporter=json');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('npx', args, {
    cwd: REPO_ROOT,
    /*
     * `stdio` is named, and it is `pipe` - which is also the default, so this line changes no
     * behaviour. It is here because **the default is why the output used to disappear**, and a
     * defect whose cause is an unstated default reads as a mystery.
     *
     * The two halves of the choice, and they pull in opposite directions:
     *
     * - Not `inherit`. Playwright's progress output would interleave with the coverage block
     *   below, so the per-cell reasons would be unreadable for the same reason the whole report
     *   exists - to be *read*. The coverage block is the deliverable; the child's chatter is not.
     * - Not `ignore`. Discarding it is the defect being fixed. It is drained below and relayed
     *   **only when the run failed**, bounded, so a red run says why in the terminal instead of
     *   sending the reader to `artifacts/a11y-run-report.json` to discover it.
     */
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!existsSync(jsonPath)) {
    return {
      ok: false,
      reason: 'the Playwright JSON reporter wrote no output file, so the counts cannot be read',
      exitCode: result.status,
      projects: {},
      totals: null,
      childOutput: childOutput(result),
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return {
      ok: false,
      reason: 'the Playwright JSON reporter wrote unparseable output',
      exitCode: result.status,
      projects: {},
      totals: null,
      childOutput: childOutput(result),
    };
  }
  return {
    ok: true,
    reason: null,
    exitCode: result.status,
    totals: report.stats ?? null,
    projects: perProjectCounts(report, projectPrefix),
    // The assertion text, read from the same report the counts come from. This is the channel
    // that makes `passed 7 failed 1` actionable in the terminal rather than only in a file.
    failures: assertionFailures(report, projectPrefix),
    childOutput: childOutput(result),
  };
}

/**
 * The child's own stdout and stderr, joined and bounded.
 *
 * Two reasons this is captured rather than inherited, both of which are about what the runner is
 * *for*. The coverage block is a report, and a report has one job; and the captured text is the only
 * channel that exists when the JSON reporter itself fails, which is exactly the case where the
 * structured counts are missing too.
 *
 * Bounded and redacted on the way in rather than at the point of printing, so there is one place
 * where a reader has to look to know what a printed line may contain.
 */
function childOutput(result) {
  const joined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return redactAndBound(joined, { maxLines: 40, maxChars: 4_000 });
}

/**
 * Make a captured line safe to print and short enough to read.
 *
 * Three transforms, in this order, and each earns its place:
 *
 * - **ANSI escapes are stripped.** Playwright's own reporter colours its diffs, so the assertion text
 *   arrives wrapped in SGR sequences. Printed raw, those escapes are invisible in a terminal and turn
 *   a readable message into noise - and they are worse than noise in a pasted CI log, where they
 *   render as literal `<ESC>[2m` text. The colours carried no information here: the section header above
 *   already says which run this is and which project failed.
 * - **Stack frames are dropped.** A frame is a filesystem path in disguise, and the redaction below
 *   would turn it into `<path>` anyway - so dropping it says the same thing without spending lines.
 * - **Absolute paths are replaced.** Not a learner datum, but environment detail this runner has no
 *   standing to publish, and one of the blocks it writes is uploaded.
 *
 * Bounded on the way in rather than at the point of printing, so there is one place where a reader
 * has to look to know what a printed line may contain.
 */
// eslint-disable-next-line no-control-regex -- matching a terminal SGR sequence is the whole job
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function redactAndBound(text, limits) {
  const lines = String(text)
    .split('\n')
    .filter((line) => !/^\s*at\s/.test(line))
    .map((line) => line.replace(ANSI_PATTERN, '').replace(/(?:\/[\w.@+-]+){2,}\/?/g, '<path>').trimEnd());
  const bounded = [];
  let used = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (bounded.length >= limits.maxLines || used >= limits.maxChars) {
      bounded.push(`... (${lines.length - bounded.length} further line(s) not shown)`);
      break;
    }
    bounded.push(line);
    used += line.length + 1;
  }
  return bounded.join('\n');
}

/**
 * One line per failed assertion, carrying the assertion's own message.
 *
 * ## Why the message and not just a count
 *
 * The per-cell line printed below reports `failed 1`. That is a fact about the run and no help at
 * all to whoever has to act on it, which is the whole defect: the run is red, the reason is in a
 * file, and the terminal - the place a person is standing - says nothing. The message is taken from
 * the report's own `errors[]`, which is the assertion text the suite wrote for exactly this
 * purpose, so nothing is scraped out of prose.
 *
 * Bounded three ways because a red run can carry fifty failures and printing fifty stacks is the
 * unreadability this fix was supposed to remove: at most {@link RELAY_FAILURE_LIMIT} failures, the
 * first line of each message (Playwright stacks the expectation diff below it), and a per-message
 * character cap.
 */
const RELAY_FAILURE_LIMIT = 6;
const RELAY_FAILURE_LINE_LIMIT = 6;
const RELAY_FAILURE_CHAR_LIMIT = 400;

function assertionFailures(report, projectPrefix) {
  const projectPrefixRegex = new RegExp(`^${projectPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const failures = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const testCase of spec.tests ?? []) {
        const results = testCase.results ?? [];
        const last = results[results.length - 1];
        if (last?.status !== 'failed' && last?.status !== 'timedOut') continue;
        const message = (last?.errors ?? [])
          .map((entry) => (typeof entry?.message === 'string' ? entry.message : ''))
          .find((candidate) => candidate.trim().length > 0);
        failures.push({
          project: (testCase.projectName ?? 'unknown').replace(projectPrefixRegex, ''),
          title: spec.title ?? testCase.title ?? '',
          status: last?.status ?? 'failed',
          message: message === undefined
            ? 'the report recorded the failure without an error message'
            : redactAndBound(message, { maxLines: RELAY_FAILURE_LINE_LIMIT, maxChars: RELAY_FAILURE_CHAR_LIMIT }),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return failures;
}

/**
 * Per-project counts, read from the report's own suite tree.
 *
 * Grouped by the project name Playwright records (`a11y-<matrix project>`), because a report that
 * says "12 passed" without saying which cells produced them is the thing this whole file exists to
 * prevent. Each project's tests are carried through as `{title, status}` as well, because the
 * per-cell **surface** coverage below is read from titles and there is no other channel for it.
 */
function perProjectCounts(report, projectPrefix) {
  const counts = {};
  const projectPrefixRegex = new RegExp(`^${projectPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const testCase of spec.tests ?? []) {
        const projectName = (testCase.projectName ?? 'unknown').replace(projectPrefixRegex, '');
        const bucket = (counts[projectName] ??= {
          passed: 0,
          failed: 0,
          skipped: 0,
          flaky: 0,
          expected: 0,
          unexpected: 0,
          tests: [],
        });
        bucket[testCase.status] = (bucket[testCase.status] ?? 0) + 1;
        // The last result is the one that decided the run. `timedOut` and `interrupted` are
        // counted as failures because that is what a cell that ran out of time or was cancelled
        // means to a reader, and neither surfaces in `passed`.
        let status = testCase.status;
        if (testCase.results?.length) {
          const last = testCase.results[testCase.results.length - 1];
          if (last.status === 'passed') {
            bucket.passed += 1;
            status = 'passed';
          } else if (last.status === 'failed') {
            bucket.failed += 1;
            status = 'failed';
          } else if (last.status === 'skipped') {
            // The category line above already incremented `skipped` when Playwright reported the
            // test as skipped, and this branch added it a second time. The per-cell line then read
            // `skipped 2` for a cell with one skipped test while the report's own `stats.skipped`
            // said one - a count that is wrong in the way this whole file exists to prevent, in the
            // one place a reader is meant to be able to trust. The category line is the record that
            // also covers a statically-skipped test with no results at all, so the last-result tally
            // defers to it rather than counting the same test twice.
            if (testCase.status !== 'skipped') bucket.skipped += 1;
            status = 'skipped';
          } else if (last.status === 'timedOut' || last.status === 'interrupted') {
            bucket.failed += 1;
            status = last.status;
          }
        }
        bucket.tests.push({ title: spec.title ?? testCase.title ?? '', status });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return counts;
}

/**
 * Which declared surfaces each cell actually scanned, and which it did not.
 *
 * A surface counts as scanned by a cell only when some test in that cell **passed** and its title
 * begins `"<surface id>: "`. Three deliberate choices, each of which is the conservative direction:
 *
 * - **Passed, not merely present.** A test that failed did not produce an accessibility result, and
 *   counting it would turn this audit's own failures into coverage.
 * - **Per cell, not per run.** The whole point: six cells and three surfaces is eighteen claims, and
 *   the runner previously made one.
 * - **A run in which *no* test claimed any surface is reported as not making per-surface claims at
 *   all**, rather than as having scanned none. That is what keeps this runner usable against the
 *   scratch fixture `tests/phase21/infraA11ySuite.test.ts` generates to prove the exit-3 path, and it
 *   is not a loophole in the real suite: `a11yAudit.spec.ts` asserts that every declared surface has a
 *   scanning test and that every scanning test's title carries its surface's prefix, so the convention
 *   cannot disappear from the real suite without a red run. The distinction is printed either way.
 */
function surfaceCoverage(counts, cells, declaredSurfaces) {
  const rows = cells.map((cell) => {
    const bucket = counts[cell.project];
    const scanned = new Set();
    let claimed = 0;
    for (const entry of bucket?.tests ?? []) {
      const surface = declaredSurfaces.find((candidate) =>
        entry.title.startsWith(`${candidate}${SURFACE_TITLE_SEPARATOR}`),
      );
      if (surface === undefined) continue;
      claimed += 1;
      if (entry.status === 'passed') scanned.add(surface);
    }
    return {
      project: cell.project,
      claimed,
      scanned: [...scanned].sort(),
      missing: declaredSurfaces.filter((surface) => !scanned.has(surface)),
    };
  });
  return { rows, claimsSurfaces: rows.some((row) => row.claimed > 0) };
}

/* ── Coverage ─────────────────────────────────────────────────────────────────── */

/**
 * Decide the runnable cells, the absent cells, and the reasons.
 *
 * A cell is absent for one of exactly three bounded reasons, and they are different findings:
 * `host-not-approved` is a matrix decision, `browser-*` is an installation fact, and
 * `scope-excluded` is this runner declining to over-claim.
 */
function planCells(cells, host, probes, scope) {
  const runnable = [];
  const absent = [];
  for (const cell of cells) {
    if (!cell.hostOperatingSystems.includes(host)) {
      absent.push({ ...cell, reason: 'host-not-approved', reasonDetail: `the matrix approves this project only for ${cell.hostOperatingSystems.join(', ')}` });
      continue;
    }
    const probe = probes.get(cell.project);
    if (probe.runnable !== true) {
      absent.push({ ...cell, reason: probe.reason, reasonDetail: 'the browser did not launch on this host' });
      continue;
    }
    runnable.push({ ...cell, browserVersion: probe.version });
  }
  if (scope === 'runnable') return { runnable, absent };
  if (scope === 'host') return { runnable, absent };
  // `matrix`: every cell is required, so a cell this host could not run is an outstanding item
  // rather than an exclusion. The reason is preserved so the block says *why*.
  return { runnable, absent };
}

/**
 * The plan's OS-family requirement, evaluated against the cells that actually ran.
 *
 * ## Why a cell that ran here does not satisfy another OS's pair
 *
 * A cell that ran **on this host** produced evidence for **this host's** operating system. The
 * matrix declares `compat-chromium` and `compat-firefox` as approved for macOS and Windows too, so a
 * loose reading - "some ran cell approves that OS and has that engine family" - would mark all six
 * pairs satisfied from a Linux container and report the requirement met. That is the exact
 * overstatement this whole file exists to prevent, in the one place where the overstatement is
 * easiest to make because the data genuinely looks like coverage.
 *
 * So: the host's own pairs are evaluated against what ran, and every other host's pairs are reported
 * unmet with the reason. Returns the missing pairs rather than a boolean, because a report that says
 * "the requirement is not met" without naming the family and the missing engine is a finding nobody
 * can act on.
 */
function unmetOsFamilyRequirement(host, ranCells) {
  const unmet = [];
  for (const os of ['linux', 'macos', 'windows']) {
    for (const family of ['chromium', 'non-chromium']) {
      const satisfied =
        os === host &&
        ranCells.some(
          (cell) => cell.hostOperatingSystems.includes(os) && engineFamily(cell.engine) === family,
        );
      if (satisfied) continue;
      unmet.push({
        hostOperatingSystem: os,
        engineFamily: family,
        reason:
          os === host
            ? `no ${family} cell ran on ${host}`
            : `not established from a ${host} host; a ${os} runner is required`,
      });
    }
  }
  return unmet;
}

/* ── Reporting ────────────────────────────────────────────────────────────────── */

function writeEvidence(payload) {
  const runId = process.env.KD_COMPAT_RUN_ID ?? `a11y-local-${process.pid}`;
  const relative = path.join('artifacts/compatibility-evidence', `a11y-${runId}.json`);
  mkdirSync(path.dirname(path.join(REPO_ROOT, relative)), { recursive: true });
  writeFileSync(path.join(REPO_ROOT, relative), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return relative;
}

async function main() {
  const scope = (process.argv.find((argument) => argument.startsWith('--require=')) ?? '--require=runnable').slice(
    '--require='.length,
  );
  const asJson = process.argv.includes('--json');
  const host = hostOperatingSystem(process.platform);
  if (host === null) {
    console.error(
      `run-a11y-audit: this host's platform "${process.platform}" is not one of the support matrix's ` +
        'three operating systems, so no coverage claim can be made. Refusing to report a partial matrix as complete.',
    );
    process.exitCode = EXIT_INCOMPLETE;
    return;
  }
  if (!['runnable', 'host', 'matrix'].includes(scope)) {
    console.error(`run-a11y-audit: unknown --require scope "${scope}". Use runnable, host or matrix.`);
    process.exitCode = EXIT_FAILED;
    return;
  }

  if (!existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
    console.error(
      'run-a11y-audit: there is no web artifact to audit. Build one with `npm run build:web` and record\n' +
        '  its identity with `npm run record:web-artifact` first. This suite scans the production artifact,\n' +
        '  because an accessibility result is a claim about the application a learner downloads.',
    );
    process.exitCode = EXIT_FAILED;
    return;
  }

  const probes = new Map();
  for (const cell of CELLS) {
    if (!cell.hostOperatingSystems.includes(host)) continue;
    probes.set(cell.project, await probeCell(cell));
  }

  const config =
    process.argv.find((argument) => argument.startsWith('--config='))?.slice('--config='.length) ??
    DEFAULT_A11Y_CONFIG;
  const projectPrefix =
    process.argv.find((argument) => argument.startsWith('--project-prefix='))?.slice('--project-prefix='.length) ??
    DEFAULT_PROJECT_PREFIX;

  const { runnable, absent } = planCells(CELLS, host, probes, scope);
  const jsonPath = path.join(REPO_ROOT, 'artifacts/a11y-run-report.json');
  const run = runnable.length > 0
    ? await runSuite(runnable.map((cell) => cell.project), jsonPath, config, projectPrefix)
    : {
    ok: true,
    reason: null,
    exitCode: 0,
    totals: null,
    projects: {},
    failures: [],
    childOutput: '',
    };

  const unmet = scope === 'runnable' ? [] : unmetOsFamilyRequirement(host, runnable);
  const outstanding = scope === 'matrix' ? absent : scope === 'host' ? absent : [];

  /*
   * Per-cell surface coverage, and the gaps folded into the verdict.
   *
   * This is the third thing the coverage block says alongside cells and engine families, and it is
   * the one that was missing when this runner reported ten findings: a flat
   * `surfaces scanned: welcome, village, settings` above six cells reads as six complete scans when
   * two of them had timed out before reaching either the village or Settings. A gap here is an
   * **incompleteness**, not a failure - the assertions that ran are green, and the honest statement
   * is that this cell did not cover this surface - so it feeds `coverageComplete` and the exit-3
   * verdict rather than `failed`. That keeps the three exit statuses meaning what the table at the
   * top of this file says they mean, and adds nothing to them that a reader cannot act on.
   */
  const coverage = surfaceCoverage(run.projects, runnable, SCANNED_SURFACES);
  const surfaceGaps = coverage.claimsSurfaces
    ? coverage.rows.flatMap((row) => row.missing.map((surface) => ({ project: row.project, surface })))
    : [];
  const coverageComplete = outstanding.length === 0 && unmet.length === 0 && surfaceGaps.length === 0;
  const failed =
    run.ok !== true || run.exitCode !== 0 || runnable.length === 0 || Object.values(run.projects).some((counts) => counts.failed > 0);

  const lines = [];
  lines.push('');
  lines.push('== Phase 21 automated accessibility audit ==');
  lines.push(`host: ${host}    scope: ${scope}    cells planned: ${CELLS.length}`);
  lines.push(`declared surfaces: ${SCANNED_SURFACES.join(', ')} (per-cell coverage below)`);
  lines.push(`surfaces NOT scanned by this runner: ${UNSCANNED_SURFACES.join(', ')}`);
  lines.push(`known tolerated blocking signature(s): ${KNOWN_BLOCKING_SIGNATURES.join(', ')}`);
  lines.push('');
  lines.push(`RAN (${runnable.length} cell(s)):`);
  for (const cell of runnable) {
    const counts = run.projects[cell.project];
    lines.push(
      `  ${cell.project.padEnd(22)} ${cell.engine.padEnd(9)} ${cell.evidenceClass.padEnd(28)} ` +
        (counts === undefined
          ? 'no counts recorded'
          : `passed ${counts.passed}  failed ${counts.failed}  skipped ${counts.skipped}`),
    );
  }
  lines.push('');
  lines.push(`ABSENT (${absent.length} cell(s)):`);
  if (absent.length === 0) {
    lines.push('  (none)');
  }
  for (const cell of absent) {
    lines.push(
      `  ${cell.project.padEnd(22)} ${cell.engine.padEnd(9)} ${cell.evidenceClass.padEnd(28)} ${cell.reason}: ${cell.reasonDetail}`,
    );
  }
  lines.push('');
  lines.push(`SURFACE COVERAGE (per cell, of ${SCANNED_SURFACES.length} declared surface(s)):`);
  if (!coverage.claimsSurfaces) {
    lines.push(
      '  not applicable - no test in this run declared a surface by title prefix, so this suite makes',
    );
    lines.push(
      '  no per-surface claim and none is inferred. A real accessibility run declares every surface.',
    );
  } else {
    for (const row of coverage.rows) {
      lines.push(
        `  ${row.project.padEnd(22)} scanned ${String(row.scanned.length).padStart(2)}/${SCANNED_SURFACES.length}  ` +
          `[${row.scanned.join(', ') || '(none)'}]` +
          (row.missing.length > 0 ? `  MISSING: ${row.missing.join(', ')}` : ''),
      );
    }
  }
  lines.push('');
  lines.push(`MANUAL GATES NOT DISCHARGED (${MANUAL_GATES.length}):`);
  for (const gate of MANUAL_GATES) {
    lines.push(`  ${gate.id.padEnd(38)} automated=${gate.automated}  ${gate.reason}`);
  }
  if (unmet.length > 0) {
    lines.push('');
    lines.push('UNMET PLAN SECTION 10.4 REQUIREMENT - at least one Chromium and one non-Chromium lane per OS family:');
    for (const entry of unmet) {
      lines.push(`  ${entry.hostOperatingSystem} / ${entry.engineFamily}: ${entry.reason}`);
    }
  }
  lines.push('');
  if (surfaceGaps.length > 0) {
    lines.push('SURFACES NOT COVERED BY A CELL THAT RAN:');
    for (const gap of surfaceGaps) {
      lines.push(`  ${gap.project.padEnd(22)} ${gap.surface}`);
    }
    lines.push('');
  }
  lines.push('');
  /*
   * The assertion text, printed only when there is any.
   *
   * ## Why this is here and why it is conditional
   *
   * The child process was spawned with its output piped, so Playwright's own account of a failure -
   * and the assertion messages this repository writes deliberately, naming the surface and the
   * violation - reached nobody. A red run showed `passed 7 failed 1` per cell and stopped there.
   * Every one of those numbers is correct and none of them is actionable, so the fix is to put the
   * assertion's own words in the terminal.
   *
   * Conditional on there being something to say, which is what keeps the block readable: a green run
   * prints exactly what it printed before, and a red one adds a section. Bounded inside
   * `assertionFailures`, and placed **above** the coverage block's summary line rather than inside
   * the per-cell table so it cannot reflow the aligned columns a reader is scanning.
   *
   * `run.childOutput` is the fallback for the one case the report cannot describe: the JSON reporter
   * itself failed, so there are no counts and no per-test errors to read, and the child's stderr is
   * the only account of what went wrong.
   */
  if (run.reason !== null && run.reason !== undefined) {
    lines.push(`RUN COULD NOT BE READ: ${run.reason}`);
    if (run.childOutput.length > 0) {
      lines.push('  Playwright output:');
      for (const line of run.childOutput.split('\n')) lines.push(`    ${line}`);
    }
    lines.push('');
  }
  if ((run.failures ?? []).length > 0) {
    lines.push(`ASSERTION FAILURES (${run.failures.length}); each block is the assertion's own message:`);
    for (const failure of run.failures.slice(0, RELAY_FAILURE_LIMIT)) {
      lines.push(`  ${failure.project.padEnd(22)} [${failure.status}] ${failure.title}`);
      for (const line of failure.message.split('\n')) lines.push(`      ${line}`);
    }
    const hidden = run.failures.length - Math.min(run.failures.length, RELAY_FAILURE_LIMIT);
    if (hidden > 0) {
      lines.push(`  ... and ${hidden} further failure(s), in ${path.relative(REPO_ROOT, jsonPath)}`);
    }
    lines.push('');
  } else if (failed && run.reason === null && run.childOutput.length > 0) {
    // A non-zero exit with no failed test and no unreadable report: the run died somewhere the
    // report does not describe. Say so with what there is, rather than printing nothing.
    lines.push('THE RUN FAILED WITHOUT A RECORDED ASSERTION FAILURE; Playwright said:');
    for (const line of run.childOutput.split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }
  lines.push(
    coverageComplete
      ? `COVERAGE: complete for scope "${scope}".`
      : `COVERAGE: INCOMPLETE for scope "${scope}" - ${outstanding.length} cell(s) absent, ` +
        `${unmet.length} engine-family requirement(s) unmet, and ${surfaceGaps.length} cell/surface ` +
        'coverage gap(s).',
  );
  lines.push(
    'This suite is an automated accessibility scan. It is NOT screen-reader, ChromeVox, physical\n' +
      '  device, or operating-system certification, and no cell above claims to be: every cell carries the\n' +
      '  matrix\'s own evidenceClass, and physical-device-manual is not among them.',
  );
  lines.push('');
  if (!asJson) console.log(lines.join('\n'));
  else console.log(JSON.stringify({ lines }, null, 2));

  const evidencePath = writeEvidence({
    schemaVersion: 1,
    hostOperatingSystem: host,
    scope,
    coverageComplete,
    cellsPlanned: CELLS.length,
    cellsRan: runnable.map((cell) => ({
      project: cell.project,
      engine: cell.engine,
      engineFamily: engineFamily(cell.engine),
      evidenceClass: cell.evidenceClass,
      browserVersion: cell.browserVersion ?? null,
      counts: run.projects[cell.project] ?? null,
    })),
    cellsAbsent: absent.map((cell) => ({
      project: cell.project,
      engine: cell.engine,
      evidenceClass: cell.evidenceClass,
      reason: cell.reason,
    })),
    manualGatesNotDischarged: MANUAL_GATES.map((gate) => ({ id: gate.id, automated: gate.automated, reason: gate.reason })),
    unmetEngineFamilyRequirements: unmet,
    scannedSurfaces: SCANNED_SURFACES,
    // Per cell, not one flat list: eighteen claims across six cells, each of them earned by a test
    // that passed. The flat list is kept because it names what the runner scans; this says which
    // cell actually did.
    surfaceCoverage: coverage.claimsSurfaces
      ? coverage.rows.map((row) => ({ project: row.project, scanned: row.scanned, missing: row.missing }))
      : 'not-applicable-no-surface-declared-by-title',
    uncoveredCellSurfaces: surfaceGaps,
    unscannedSurfaces: UNSCANNED_SURFACES,
    knownBlockingSignatures: KNOWN_BLOCKING_SIGNATURES,
    // Counts, not text. The assertion messages are terminal output for a human standing at the run;
    // this file is uploaded, and its privacy rule is that it carries counts, version strings and
    // bounded category names. `assertionFailures` already redacts, but "already redacted" is not a
    // reason to publish prose from a failure message into an artifact.
    failedCells: runnable
      .filter((cell) => (run.projects[cell.project]?.failed ?? 0) > 0)
      .map((cell) => cell.project),
    totals: run.totals ?? null,
  });

  if (!asJson) console.log(`Evidence: ${path.relative(REPO_ROOT, evidencePath)}`);

  if (failed) {
    if (!asJson) console.error('RESULT: FAILED - an assertion failed, or a runnable cell did not run.');
    process.exitCode = EXIT_FAILED;
    return;
  }
  if (!coverageComplete) {
    if (!asJson) {
      console.error(
        `RESULT: INCOMPLETE (exit ${EXIT_INCOMPLETE}) - the assertions that ran passed, and the matrix above is ` +
          'not complete for the requested scope. This run does not establish an accessibility claim for the\n' +
          '  absent cells' +
          (surfaceGaps.length > 0
            ? ', nor for the cell/surface combinations listed under SURFACE COVERAGE'
            : '') +
          ', and nothing in its output should be read as doing so.',
      );
    }
    process.exitCode = EXIT_INCOMPLETE;
    return;
  }
  if (!asJson) console.log('RESULT: PASSED - every cell in the requested scope ran and no assertion failed.');
}

await main();