/**
 * Unit tests for the Welcome budget measurement logic.
 *
 * What is under test
 * ------------------
 * The pass/fail decision and the boundary that produces it, because a budget whose
 * boundary is undefined or approximate is not a budget. Plan section 10.2 sets 300 KB
 * gzip for Welcome initial JavaScript and CSS excluding lazy renderer bundles, and this
 * file pins what "initial" means, what is excluded, and what a reader is told about both.
 *
 * The gate is a CLI, so every case here is a real run of
 * `node scripts/check-welcome-budget.mjs` against a synthetic `dist` in a temporary
 * directory. No case reads the repository's real `dist`, so this suite passes on a clean
 * checkout before anyone has run `npm run build:web`; the real artifact is measured by
 * `npm run check:budget:welcome` in CI, where a build already exists.
 *
 * On the fixture sizes
 * --------------------
 * A case can only prove a limit if it can actually reach it, so the over-budget fixtures
 * use high-entropy filler that gzips at about 0.75:1. A run of identical characters
 * would have been the wrong tool: it gzips to almost nothing, so a nominal 400 KB
 * "oversized" fixture measured a few hundred bytes and the gate correctly passed it -
 * a test that would have looked like coverage while asserting nothing.
 *
 * On location independence
 * -----------------------
 * One value in the report differs by construction: where the run measured from. The
 * script prints it relative to the repository root, so its shape depends on where this
 * checkout is, and the "same report every run" case below used to strip it with a regex
 * written for one of its two shapes. That made this file pass only in a checkout under
 * `/tmp` and fail in every other one, which is not a property of the measurement. The
 * strip now keys on the report's own label instead; `support/budgetReport.ts` explains
 * why, and `qa-hermeticity.test.ts` re-measures the same bytes from a second location so
 * the next version of this mistake fails here rather than in a runner.
 *
 * Privacy: the fixtures are filler bytes in a temporary directory. Nothing here reads,
 * writes, or asserts on learner data, and no subject, note, attachment, progression,
 * statistic, or preference is read or named.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { measuredFrom, stripMeasuredFrom } from './support/budgetReport';
import {
  WELCOME_BUDGET_BYTES,
  WELCOME_BUDGET_KIB,
  countedBytes,
  filler,
  incompressible,
  limitBytes,
  makeDist,
  makeEmptyDist,
  type DistOptions,
  type GateResult,
  type SyntheticDist,
} from './support/welcomeBudgetGate';

/** Raw filler bytes whose gzip size exceeds the whole 300 KiB budget. */
const OVER_BUDGET_RAW = 500_000;

let open: SyntheticDist[] = [];

function dist(options: DistOptions, files: Record<string, string>) {
  const made = makeDist(options, files);
  open.push(made);
  return made;
}

afterEach(() => {
  for (const made of open) made.cleanup();
  open = [];
});

/** A tree shaped like the real Welcome entry: entry, polyfills, runtime, React, CSS. */
const GOOD_FILES = {
  'assets/index-entry.js': incompressible(200_000),
  'assets/polyfills-modern.js': filler(30_000),
  'assets/rolldown-runtime.js': filler(200),
  'assets/vendor-react.js': incompressible(80_000),
  'assets/index.css': filler(30_000),
};

const GOOD_DOCUMENT: DistOptions = {
  module: ['/assets/index-entry.js', '/assets/polyfills-modern.js'],
  preloads: ['/assets/rolldown-runtime.js', '/assets/vendor-react.js'],
  styles: ['/assets/index.css'],
};

describe('a known-good set passes, and says by how much', () => {
  it('exits zero, names every counted file, and reports the headroom it left', () => {
    const result = dist(GOOD_DOCUMENT, GOOD_FILES).run();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Welcome budget within budget/);
    for (const path of [
      'assets/index-entry.js',
      'assets/polyfills-modern.js',
      'assets/rolldown-runtime.js',
      'assets/vendor-react.js',
      'assets/index.css',
    ]) {
      expect(result.output, path).toContain(path);
    }
    expect(result.output).toMatch(/headroom\s+[\d.]+ KiB under the limit/);
  });

  it('enforces exactly 300 KiB, and reports it in the unit it enforces', () => {
    const result = dist(GOOD_DOCUMENT, GOOD_FILES).run();
    expect(limitBytes(result)).toBe(WELCOME_BUDGET_BYTES);
    expect(limitBytes(result)).toBe(307_200);
    expect(WELCOME_BUDGET_KIB).toBe(300);
  });
});

describe('a set over the limit fails, and says by how much', () => {
  it('exits non-zero when the counted gzip total exceeds the budget', () => {
    const result = dist(
      { module: ['/assets/index-entry.js'], styles: ['/assets/index.css'] },
      { 'assets/index-entry.js': incompressible(OVER_BUDGET_RAW), 'assets/index.css': filler(1_000) },
    ).run();

    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/Welcome budget EXCEEDED/);
    expect(countedBytes(result)).toBeGreaterThan(WELCOME_BUDGET_BYTES);
    expect(result.output).toMatch(/headroom\s+[\d.]+ KiB over the limit/);
  });

  it('fails on a single oversized chunk, which is the realistic shape of the regression', () => {
    const result = dist(
      { module: ['/assets/index-entry.js'] },
      { 'assets/index-entry.js': incompressible(OVER_BUDGET_RAW) },
    ).run();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/Welcome budget EXCEEDED/);
  });
});

describe('what counts as initial is the three document-level ways to pull JS or CSS', () => {
  it('does not count a file the entry document references twice', () => {
    // Vite emits the entry as a module script and can also list a shared chunk as a
    // modulepreload. Counting a file twice would inflate the total by the size of the
    // entry itself, so the total with a duplicate reference must equal the total without.
    const once = dist({ module: ['/assets/only.js'] }, { 'assets/only.js': incompressible(200_000) }).run();
    const twice = dist(
      { module: ['/assets/only.js'], preloads: ['/assets/only.js'] },
      { 'assets/only.js': incompressible(200_000) },
    ).run();

    expect(once.code, once.output).toBe(0);
    expect(twice.code, twice.output).toBe(0);
    expect(countedBytes(once)).toBeGreaterThan(100_000);
    expect(countedBytes(twice)).toBe(countedBytes(once));
    expect(twice.output).toMatch(/over 1 file\(s\)/);
  });

  it('does not count a classic script, an icon, or a preconnect', () => {
    // Each of these is large enough that counting it would blow the budget, so the
    // passing exit code is the assertion.
    const result = dist(
      {
        module: ['/assets/index-entry.js'],
        extraHead: [
          '    <script src="/assets/classic.js"></script>',
          '    <link rel="preconnect" href="https://example.invalid">',
        ],
      },
      {
        'assets/index-entry.js': filler(1_000),
        'assets/classic.js': incompressible(OVER_BUDGET_RAW),
      },
    ).run();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/js-nonmodule/);
    expect(result.output).toMatch(/link-icon/);
    expect(result.output).toMatch(/link-preconnect/);
    // The oversized classic script is not in the counted list.
    expect(result.output).toMatch(/total counted\s+[\d.]+ KiB \(\d+ bytes\) over 1 file\(s\)/);
  });

  it('counts a route chunk that is preloaded, and ignores one that is not referenced', () => {
    // The first half: a modulepreload is an initial reference by definition, so an
    // eagerly preloaded route chunk is correctly inside the budget.
    const preloaded = dist(
      { module: ['/assets/index-entry.js'], preloads: ['/assets/DataCenter-chunk.js'] },
      { 'assets/index-entry.js': filler(1_000), 'assets/DataCenter-chunk.js': incompressible(OVER_BUDGET_RAW) },
    ).run();
    expect(preloaded.code, preloaded.output).toBe(1);

    // The second half: a lazy chunk the document never names is out of scope
    // structurally, not by a name pattern. That is what lets routes be added without
    // this number moving.
    const unreferenced = dist(
      { module: ['/assets/index-entry.js'] },
      { 'assets/index-entry.js': filler(1_000), 'assets/DataCenter-chunk.js': incompressible(OVER_BUDGET_RAW) },
    ).run();
    expect(unreferenced.code, unreferenced.output).toBe(0);
    expect(countedBytes(unreferenced)).toBeLessThan(2_000);
  });

  it('reports an inline script rather than silently dropping it', () => {
    const result = dist({ module: ['/assets/index-entry.js'] }, { 'assets/index-entry.js': filler(1_000) }).run();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Not an initial asset \(reported, not counted\)/);
    expect(result.output).toMatch(/js-inline/);
  });
});

describe('the exclusion boundary is the plan boundary, and is reported', () => {
  it('excludes the Phaser renderer chunk and still reports its size', () => {
    // On its own this chunk is more than twice the whole budget, which is the reason
    // plan section 10.2 excludes lazy renderer bundles at all.
    const result = dist(
      { module: ['/assets/index-entry.js'], preloads: ['/assets/vendor-phaser-hash.js'] },
      {
        'assets/index-entry.js': filler(1_000),
        'assets/vendor-phaser-hash.js': incompressible(1_000_000),
      },
    ).run();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('assets/vendor-phaser-hash.js');
    expect(result.output).toMatch(/\(vendor-phaser\)/);
    expect(result.output).toMatch(/excluded \(not in the total\)/);
  });

  it('excludes the legacy polyfill chunk but not the modern one', () => {
    const result = dist(
      {
        module: ['/assets/index-entry.js', '/assets/polyfills-modern.js'],
        preloads: ['/assets/polyfills-legacy-hash.js'],
      },
      {
        'assets/index-entry.js': filler(1_000),
        'assets/polyfills-modern.js': incompressible(OVER_BUDGET_RAW),
        'assets/polyfills-legacy-hash.js': incompressible(OVER_BUDGET_RAW),
      },
    ).run();

    // The modern polyfill is initial, so its size fails the gate. The legacy one is
    // excluded. Had the two been treated alike the run would have passed.
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/\(polyfills-legacy\)/);
    expect(result.output).toMatch(/polyfills-modern\.js\s+[\d.]+ KiB\s+\[js-module\]/);
  });

  it('does not count the ES5 fallback, so the same application is not paid for twice', () => {
    // `index-legacy-*.js` is the module entry re-emitted at ES5. Counting both would
    // fail a build that has not grown by a byte, and the module path is the release
    // path: web on Chromebook, desktop browsers, and tablets.
    const result = dist(
      { module: ['/assets/index-entry.js'], legacy: ['/assets/index-legacy-hash.js'] },
      {
        'assets/index-entry.js': incompressible(200_000),
        'assets/index-legacy-hash.js': incompressible(OVER_BUDGET_RAW),
      },
    ).run();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/js-legacy-nomodule/);
    expect(result.output).toMatch(/count the app twice/);
  });

  it('does not exclude a lazy chunk by hashed name, so the boundary survives a rebuild', () => {
    // A content hash changes on every build. A boundary keyed to a hash is a boundary
    // that silently stops excluding anything.
    const result = dist(
      { module: ['/assets/index-entry.js'], preloads: ['/assets/vendor-phaser-DIFFERENT-hash.js'] },
      {
        'assets/index-entry.js': filler(1_000),
        'assets/vendor-phaser-DIFFERENT-hash.js': incompressible(1_000_000),
      },
    ).run();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/\(vendor-phaser\)/);
  });
});

describe('a reference that leaves the shipped artifact is a failure, not a skipped line', () => {
  it('fails when the entry document names a file the build does not contain', () => {
    const result = dist({ module: ['/assets/index-entry.js.js'] }, {}).run();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/referenced by dist\/index\.html but not present in the build/);
    expect(result.output).toMatch(/a silently dropped reference is not a measurement/);
    // No total is reported, because a total over a subset of the real set is a number
    // that means something else.
    expect(result.output).not.toMatch(/total counted/);
  });

  it('fails on an absolute URL, which cannot be measured and is not a shipped asset', () => {
    for (const reference of [
      'https://cdn.example.invalid/app.js',
      '//cdn.example.invalid/app.js',
      'data:text/javascript,void 0',
    ]) {
      const result = dist({ module: [reference] }, {}).run();
      expect(result.code, reference).toBe(1);
      expect(result.output, reference).toMatch(/does not name a file inside the built artifact/);
    }
  });

  it('fails on a traversal out of the build directory', () => {
    const result = dist({ module: ['/../../etc/passwd'] }, {}).run();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/does not name a file inside the built artifact/);
  });
});

describe('a build it cannot measure fails rather than reporting a pass', () => {
  it('exits non-zero when there is no entry document, and names the command to run', () => {
    // This is the deliberate divergence from scripts/check-bundle-size.mjs, which warns
    // and exits 0. That is reasonable for a check a developer may run before building
    // and not acceptable for a gate: a budget that reports success because it measured
    // nothing is the exact failure this gate exists to prevent.
    const made = makeEmptyDist();
    open.push(made);
    const result = made.run();

    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/no built entry document/);
    expect(result.output).toMatch(/npm run build:web/);
    expect(result.output).not.toMatch(/within budget/);
  });
});

describe('the measurement is deterministic and reproducible by hand', () => {
  it('prints the gzip level it used, and produces the same report every run', () => {
    const first = dist(GOOD_DOCUMENT, GOOD_FILES).run();
    const second = dist(GOOD_DOCUMENT, GOOD_FILES).run();

    expect(first.code, first.output).toBe(0);
    expect(first.output).toMatch(/gzip level: 9/);
    // Two independent synthetic builds of identical bytes, each measured: the report has
    // to be byte-identical, or the number is not a measurement.
    expect(countedBytes(first)).toBe(countedBytes(second));
    // The reports are *not* identical before stripping: the two trees have different
    // names by construction, so this assertion is the control that proves the strip is
    // doing the work rather than two runs happening to agree.
    expect(first.output, 'the two runs were already identical, so nothing was volatile').not.toBe(
      second.output,
    );
    expect(measuredFrom(first.output)).toBeDefined();
    expect(measuredFrom(first.output)).not.toBe(measuredFrom(second.output));
    expect(stripMeasuredFrom(first.output)).toBe(stripMeasuredFrom(second.output));
    // And the strip is narrow: it replaces the one volatile value and nothing else, so
    // the report still says where it measured from and still carries the counted total.
    const stripped = stripMeasuredFrom(first.output);
    expect(stripped).toMatch(/^\s*Measured from:\s+\S+$/m);
    expect(countedBytes(asReport(stripped))).toBe(countedBytes(first));
  });

  it('lists the counted files in a stable, sorted order', () => {
    const result = dist(GOOD_DOCUMENT, GOOD_FILES).run();
    const listed = [...result.output.matchAll(/^\s+(assets\/\S+)\s+[\d.]+ KiB\s+\[/gm)].map((match) => match[1]);
    expect(listed).toEqual([...listed].sort());
    expect(listed).toEqual([
      'assets/index-entry.js',
      'assets/index.css',
      'assets/polyfills-modern.js',
      'assets/rolldown-runtime.js',
      'assets/vendor-react.js',
    ]);
  });
});

/**
 * Re-labels a stripped report as a {@link GateResult}, so the shared readers in
 * `support/welcomeBudgetGate` can be pointed at it.
 *
 * Only `output` is ever read, and re-deriving the number from the *stripped* text is the
 * point: it proves the strip did not take the counted total with it.
 */
function asReport(output: string): GateResult {
  return { code: 0, stdout: output, stderr: '', output };
}
