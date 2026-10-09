/**
 * Hermeticity of the Phase 8 gates: what a Phase 8 test is not allowed to depend on.
 *
 * ## Why this file exists
 *
 * Two Phase 8 tests passed in the author's working tree and failed in a checkout of the
 * committed state, for the same underlying reason and by the same mechanism:
 *
 * 1. `qa-verification.test.ts` took its "before" stylesheet from the checkout's own
 *    history, so once the Cozy change was committed the "before" *was* the "after" and
 *    the gate compared the stylesheet against itself.
 * 2. `welcome-budget-measure.test.ts` stripped the temporary path out of the budget
 *    report with a regex written for one of the two shapes that path can have, so the
 *    strip only matched in a checkout directly under `/tmp` and the determinism
 *    assertion failed everywhere else.
 *
 * Neither was found by the suite. Both surfaced from the same run - `vitest` inside a
 * `git worktree` of the committed state - and both would have surfaced in a reviewer's CI
 * instead of in the commit that introduced them. That is the pattern worth stopping: a gate
 * whose verdict depends on the state or the location of the checkout is a gate that
 * reports on the checkout rather than on the product. Phase 7's own evidence records the
 * same finding in its own words - "each gate depended on state a clean checkout does not
 * have" - and one of the recorded CI failures was a `git show` against a sha an
 * `actions/checkout@v4` depth-1 clone does not have.
 *
 * So the defect class gets its own gate, with two halves:
 *
 * - **No Phase 8 test reads the history of the checkout.** Every `.ts`/`.tsx` under
 *   `tests/phase8/` is scanned for a version-control invocation that resolves a commit. A
 *   "before" that is not committed cannot be compared against, and a before that *is*
 *   committed is a fixture, not a lookup. `check-ignore` is deliberately allowed: it
 *   answers from the committed `.gitignore`, which every checkout has, and resolves no
 *   commit.
 * - **The budget report does not depend on where the checkout lives.** The same synthetic
 *   bytes are measured twice, once from a `dist` outside the repository and once from a
 *   `dist` the gate sees as a plain `dist/` because the script is copied into a scratch
 *   root that owns it. The two reports differ in exactly the one location-dependent value
 *   and agree byte-for-byte once that value is replaced. Plus the direct control on the
 *   strip itself, for both path shapes and for a line that is not the labelled field.
 *
 * ## How the scan avoids becoming the next false positive
 *
 * Comments are stripped before the scan, because a test is allowed to *explain* that it
 * must not read history. That makes the stripper load-bearing, so it is itself tested
 * against controls: a real spawn must be flagged, a path-ignore query must not be, a
 * comment must not be, and - the case a naive stripper gets wrong - a protocol-relative or
 * `https:` URL in a string literal must survive, or the scan would silently lose every
 * line of code after one. The scan's own fixture snippets and its comment delimiters are
 * assembled from fragments, because this file scans itself.
 *
 * Privacy: this file contains no learner data and makes no network request. It reads
 * TypeScript sources under `tests/phase8/`, copies one committed script into a scratch
 * directory under the OS temp dir, and spawns only `node`. It never writes inside the
 * repository, and it never reads, writes, or names a subject, note, attachment,
 * progression, statistic, or preference.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { measuredFrom, stripMeasuredFrom } from './support/budgetReport';
import {
  countedBytes,
  entryHtml,
  filler,
  incompressible,
  type DistOptions,
  type GateResult,
} from './support/welcomeBudgetGate';

const REPO_ROOT = process.cwd();
const PHASE8_ROOT = path.join(REPO_ROOT, 'tests', 'phase8');
const ENFORCER = path.join(REPO_ROOT, 'scripts', 'check-welcome-budget.mjs');

/** The two files this guard was written for. The walk has to reach both. */
const GUARDED_FILES = [
  path.join(PHASE8_ROOT, 'qa-verification.test.ts'),
  path.join(PHASE8_ROOT, 'welcome-budget-measure.test.ts'),
];

/** Enough files that "the walk found almost nothing" cannot pass as a scan. */
const MINIMUM_SCANNED_FILES = 20;

/* ========================================================================== */
/* Half 1: no phase 8 gate reads the history of the checkout.                   */
/* ========================================================================== */

/**
 * Subcommands that resolve committed history, or whose answer depends on the state of the
 * working tree the runner happens to have.
 *
 * `check-ignore` is the deliberate exclusion: it reads the working tree's ignore rules
 * and resolves no commit, so a gate may use it in a clean clone, a depth-1 clone, and a
 * developer's tree alike. Everything listed here is either a lookup of a commit that may
 * not have been fetched, or a query whose answer a contributor's uncommitted work can
 * change - which is the "state a clean checkout does not have" failure in its second
 * form.
 */
const HISTORY_SUBCOMMANDS = [
  'show',
  'log',
  'diff',
  'cat-file',
  'rev-parse',
  'ls-tree',
  'rev-list',
  'merge-base',
  'describe',
  'blame',
  'hash-object',
  'status',
  'checkout',
  'stash',
  'fetch',
];

/** The quoting a command name can appear in, as a regex character class. */
const QUOTE = '[\'"`]';

/**
 * A version-control invocation that resolves history, in either shape one appears in: an
 * argument list, or a command line inside a string.
 *
 * A pattern, not a parser, so it errs by being noisy rather than quiet: a `git` call
 * and a banned subcommand word on the same source line is a finding, even if the word was
 * never an argument. That is the right direction for this gate - a false positive costs a
 * line of explanatory comment, a false negative costs a broken runner - and the
 * `check-ignore` allowance below is the one place the looseness was found to matter.
 */
const HISTORY_READ = new RegExp(
  `(${QUOTE}git${QUOTE}[^\\n]{0,200}?\\b(?:${HISTORY_SUBCOMMANDS.join('|')})\\b)` +
    `|(\\bgit\\s+(?:${HISTORY_SUBCOMMANDS.join('|')})\\b)`,
  'i',
);

/**
 * Removes comments, so a test may explain the rule without tripping it.
 *
 * The `//` form is treated as a comment only when it starts a line or follows whitespace,
 * which is what keeps `'//cdn.example.invalid/app.js'` and `https://...` inside string
 * literals intact - the case a naive stripper loses, and the case the controls below pin.
 * A `//` that follows a quote character is left alone for the same reason.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

function readsCheckoutHistory(source: string): boolean {
  return HISTORY_READ.test(stripComments(source));
}

/** Every `.ts`/`.tsx` under a directory, recursively. Only these can execute. */
function sourcesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourcesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

const scanned = sourcesUnder(PHASE8_ROOT);

/**
 * Phase 17 is scanned too.
 *
 * A scoped extension of the same rule, not a repo-wide rewrite: `tests/phase17/fishingPhaseInvariants.test.ts`
 * read `git show ade1f78:<path>` (which returned `null` on a depth-1 clone, turning every
 * byte-identity assertion into a vacuous pass) and ran `git diff --stat ade1f78...HEAD` uncaught
 * (which threw). Both are exactly this defect class, so the scan covers the phase that had it.
 * Before that file was repaired it would have been an offender here; now it reads committed
 * fixtures through `tests/phase17/support/phase17Baseline.ts`.
 */
const PHASE17_ROOT = path.join(REPO_ROOT, 'tests', 'phase17');
const scannedPhase17 = sourcesUnder(PHASE17_ROOT);
const PHASE17_GUARDED_FILES = [
  path.join(PHASE17_ROOT, 'fishingPhaseInvariants.test.ts'),
  path.join(PHASE17_ROOT, 'support', 'phase17Baseline.ts'),
];

describe('no phase 8 gate reads the history of the checkout', () => {
  it('finds the phase 8 sources, so the scan below is not an empty walk', () => {
    expect(scanned.length, 'the walk found suspiciously few sources').toBeGreaterThanOrEqual(
      MINIMUM_SCANNED_FILES,
    );
    for (const file of GUARDED_FILES) {
      expect(scanned, `${file} is not in the walk`).toContain(file);
    }
    // And the walk is reading real code: at least one phase 8 source spawns a process,
    // which is the only way a source could read history in the first place.
    const spawners = scanned.filter((file) =>
      /child_process/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(
      spawners.length,
      'no phase 8 source spawns a process, so the walk is not reading code',
    ).toBeGreaterThan(0);
    for (const file of scanned) {
      expect(readFileSync(file, 'utf8').length, `${file} is empty`).toBeGreaterThan(0);
    }
  });

  it('flags a history read and allows a working-tree query, so the rule has teeth', () => {
    // Assembled from fragments, comment delimiters included: this file scans itself, and
    // a control written as one literal would either be a real match in its own source or
    // be eaten by this file's own comment stripper.
    const controls: ReadonlyArray<{ what: string; code: readonly string[]; flagged: boolean }> = [
      {
        what: 'a spawn with a history subcommand in the argument list',
        code: ["execFileSync('g", "it', ['show', 'HEAD:src/styles.css'])"],
        flagged: true,
      },
      {
        what: 'a command line inside a string',
        code: ['await run("g', 'it show HEAD:src/styles.css");'],
        flagged: true,
      },
      {
        what: 'a working-tree ignore query, which resolves no commit',
        code: ["execFileSync('g", "it', ['check-ignore', '--quiet', '--', 'dist'])"],
        flagged: false,
      },
      {
        what: 'a line comment that mentions the rule',
        code: ['// a gate must not read g', 'it history\nconst limit = 1;'],
        flagged: false,
      },
      {
        what: 'a block comment that mentions the rule',
        code: ['/' + '* no g', 'it show here *' + '/\nconst limit = 1;'],
        flagged: false,
      },
      {
        what: 'a protocol-relative URL in a string literal',
        code: ["const reference = '//cdn.example.invalid/a.js';"],
        flagged: false,
      },
      {
        what: 'an https URL in a string literal',
        code: ['const reference = "https://example.invalid/a.js";'],
        flagged: false,
      },
    ];
    for (const control of controls) {
      expect(readsCheckoutHistory(control.code.join('')), control.what).toBe(control.flagged);
    }
  });

  it('has no offender', () => {
    const offenders = scanned
      .filter((file) => readsCheckoutHistory(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(
      offenders,
      'a phase 8 test resolves a commit, so its verdict depends on the checkout rather ' +
        'than on the product. Commit the "before" as a fixture with its own digest, as ' +
        'tests/phase7/support/fixtures and tests/phase8/support/fixtures do.',
    ).toEqual([]);
  });

  it('finds the phase 17 sources, so the scoped scan is not an empty walk', () => {
    expect(scannedPhase17.length, 'the phase 17 walk found no sources').toBeGreaterThan(0);
    for (const file of PHASE17_GUARDED_FILES) {
      expect(scannedPhase17, `${file} is not in the phase 17 walk`).toContain(file);
    }
    for (const file of scannedPhase17) {
      expect(readFileSync(file, 'utf8').length, `${file} is empty`).toBeGreaterThan(0);
    }
  });

  it('has no phase 17 offender either', () => {
    const offenders = scannedPhase17
      .filter((file) => readsCheckoutHistory(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(
      offenders,
      'a phase 17 test resolves a commit, so its verdict depends on the checkout rather ' +
        'than on the product. Commit the "before" as a fixture with its own digest, as ' +
        'tests/phase17/support/fixtures does.',
    ).toEqual([]);
  });
});

/* ========================================================================== */
/* Half 2: the budget report does not depend on where the checkout lives.      */
/* ========================================================================== */

/** Scratch roots created during the run, removed in `afterAll`. */
const scratchRoots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'kd-qa-hermetic-'));
  scratchRoots.push(root);
  return root;
}
afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** The same shape the measurement suite uses: entry, polyfills, runtime, React, CSS. */
const FIXTURE_FILES: Record<string, string> = {
  'assets/index-entry.js': incompressible(200_000),
  'assets/polyfills-modern.js': filler(30_000),
  'assets/rolldown-runtime.js': filler(200),
  'assets/vendor-react.js': incompressible(80_000),
  'assets/index.css': filler(30_000),
};
const FIXTURE_DOCUMENT: DistOptions = {
  module: ['/assets/index-entry.js', '/assets/polyfills-modern.js'],
  preloads: ['/assets/rolldown-runtime.js', '/assets/vendor-react.js'],
  styles: ['/assets/index.css'],
};

function writeFixtureDist(distDir: string): void {
  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(distDir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  writeFileSync(path.join(distDir, 'index.html'), entryHtml(FIXTURE_DOCUMENT), 'utf8');
}

function runGate(script: string, args: readonly string[], cwd: string): GateResult {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe('the budget report does not depend on where the checkout lives', () => {
  it('replaces the measured-from value whatever shape it has, and only that value', () => {
    // The direct control on the defect: two path shapes a single regex cannot both
    // match, and a line that merely looks similar, which must survive untouched.
    const absolute = '  Measured from: /tmp/kd-welcome-budget-AAAAAA/dist/index.html\n';
    const relative = '  Measured from: ../../kd-welcome-budget-BBBBBB/dist/index.html\n';
    expect(stripMeasuredFrom(absolute)).toBe(stripMeasuredFrom(relative));
    expect(measuredFrom(absolute)).toBe('/tmp/kd-welcome-budget-AAAAAA/dist/index.html');
    expect(measuredFrom(relative)).toBe('../../kd-welcome-budget-BBBBBB/dist/index.html');
    const elsewhere = '  Measured from some other field: /tmp/kd-welcome-budget-CCCCCC/x\n';
    expect(stripMeasuredFrom(elsewhere)).toBe(elsewhere);
    // The label is the anchor, so it stays: a red run still says which field was dropped.
    expect(stripMeasuredFrom(absolute)).toContain('Measured from: <dist>');
  });

  it('measures identical bytes from two different locations to the same report', () => {
    // One `dist` outside the repository, measured by the committed script with an
    // absolute argument: the value it prints is relative to *this* checkout, so it
    // carries a temporary name and however many `../..` this checkout's depth needs.
    const outside = scratch();
    const outsideDist = path.join(outside, 'dist');
    writeFixtureDist(outsideDist);
    const byAbsolutePath = runGate(ENFORCER, [`--dist=${outsideDist}`], REPO_ROOT);
    // The same argument in its relative form, from a working directory that is not the
    // repository root at all. The script resolves `--dist` against its own root and
    // prints relative to that root, so neither the argument's form nor the working
    // directory can reach the report.
    const byRelativePath = runGate(
      ENFORCER,
      [`--dist=${path.relative(REPO_ROOT, outsideDist)}`],
      outside,
    );
    // A second `dist` the gate sees as a plain `dist/`, because the script is copied into
    // a scratch root that owns it: same bytes, same report, and a path with no temporary
    // name and no `..` in it at all.
    const nestedRoot = scratch();
    const nested = path.join(nestedRoot, 'nested');
    mkdirSync(path.join(nested, 'scripts'), { recursive: true });
    copyFileSync(ENFORCER, path.join(nested, 'scripts', 'check-welcome-budget.mjs'));
    writeFixtureDist(path.join(nested, 'dist'));
    const fromNestedRoot = runGate(
      path.join(nested, 'scripts', 'check-welcome-budget.mjs'),
      [],
      nested,
    );

    for (const [what, run] of [
      ['the absolute-argument run', byAbsolutePath],
      ['the relative-argument run', byRelativePath],
      ['the nested-root run', fromNestedRoot],
    ] as const) {
      expect(run.code, `${what} did not pass:\n${run.output}`).toBe(0);
    }

    // The two locations really are two locations: the printed value differs, so the
    // comparison below is not two runs agreeing by accident.
    expect(byAbsolutePath.output, 'the two locations printed the same report').not.toBe(
      fromNestedRoot.output,
    );
    expect(measuredFrom(byAbsolutePath.output)).not.toBe(measuredFrom(fromNestedRoot.output));
    expect(measuredFrom(byAbsolutePath.output)).toContain(path.basename(outside));
    expect(measuredFrom(byAbsolutePath.output)).toMatch(/kd-qa-hermetic-/);
    expect(measuredFrom(byAbsolutePath.output)).toMatch(/dist\/index\.html$/);
    expect(measuredFrom(fromNestedRoot.output)).toBe('dist/index.html');

    // The measurement is the same number, and the reports are byte-identical once the
    // one location-dependent value is replaced.
    expect(countedBytes(byAbsolutePath)).toBe(countedBytes(fromNestedRoot));
    expect(countedBytes(byAbsolutePath)).toBe(countedBytes(byRelativePath));
    expect(stripMeasuredFrom(byAbsolutePath.output)).toBe(
      stripMeasuredFrom(fromNestedRoot.output),
    );
    // Same tree, two argument forms and two working directories: byte-identical reports
    // with no stripping at all.
    expect(byRelativePath.output).toBe(byAbsolutePath.output);
  });
});
