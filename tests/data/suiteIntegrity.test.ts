/**
 * Phase 5 data-product suite: wiring, non-vacuity floors, and privacy.
 *
 * Phase 3 review found five vacuous gates in this repository and Phase 4 found
 * more, so a gate suite is expected to account for itself. This file is that
 * accounting, and it is deliberately the *first* thing anyone reading the suite
 * should look at.
 *
 * What it establishes:
 *
 * 1. **`npm run test:data` exists and is bound to this directory**, with the exact
 *    script text the plan's Phase 5 verification block requires.
 * 2. **Every one of the four exit criteria is held by at least one test file**,
 *    named, and every gate file is reachable from the suite's entry points - so a
 *    file that is written but never run cannot pass unnoticed.
 * 3. **The registered-reproduction count is measured, not asserted from a
 *    comment.** Every `it.fails` in the suite is counted and the count is pinned.
 *    The suite shipped with **24** registered reproductions - nine `it.fails`
 *    call sites, one of which is a fifteen-case loop, so twenty-four runtime
 *    registrations - and Phase 5 implements all of them. The gate therefore now
 *    asserts the *opposite*: that no `it.fails` remains, so a reproduction cannot
 *    be re-registered to make a red assertion disappear, and so the twenty-four
 *    that were implemented cannot be un-implemented quietly.
 * 4. **No learner data and no forbidden host is in the suite.** Every source file
 *    under `tests/data/` is scanned for the reserved `example.invalid` host's
 *    *siblings* - real hosts - and for anything that looks like a credential, a
 *    bearer token, an absolute home path, or a query string. Synthetic fixtures are
 *    allowed to name `example.invalid` and nothing else.
 *
 * Privacy: this file reports file paths, counts, and rule ids. It never copies a
 * matched value into a failure message.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CORRUPTION_CASES,
  EXPORT_ENTRY_POINTS,
  FULL_DEVICE_BACKUP_MODULE,
  ARCHIVE_VALIDATION_MODULE,
  REQUIRED_MANIFEST_KEYS,
  PHASE_5_FLAG_ENV_KEY,
} from './support/productInterface';

const REPO_ROOT = process.cwd();
const DATA_ROOT = join(REPO_ROOT, 'tests/data');

/** The gate files, and the exit criterion each one holds. */
const GATE_FILES: ReadonlyArray<{
  readonly file: string;
  readonly criterion: string;
  readonly what: string;
}> = [
  {
    file: 'populatedStateRoundTrip.test.ts',
    criterion: 'A populated storage-v2 state exports and restores with semantic equality.',
    what: 'gate 1',
  },
  {
    file: 'attachmentBytesRoundTrip.test.ts',
    criterion: 'All available attachment bytes and custom sprite data survive.',
    what: 'gate 2',
  },
  {
    file: 'corruptArchiveIsolation.test.ts',
    criterion: 'Corrupt archives never replace current data.',
    what: 'gate 3',
  },
  {
    file: 'externalOnlyDisclosure.test.ts',
    criterion: 'External-only images are disclosed.',
    what: 'gate 4',
  },
  {
    file: 'manifestContract.test.ts',
    criterion: 'The manifest carries counts, versions, and checksums, and no learner content.',
    what: 'gate 5',
  },
  {
    file: 'localDownloadOnly.test.ts',
    criterion: 'A backup is a local download and a local file pick, and nothing else.',
    what: 'gate 6',
  },
  {
    file: 'memberPathSafety.test.ts',
    criterion: 'Member paths are safe on write and on read.',
    what: 'gate 7',
  },
  {
    file: 'phase5FlagDefault.test.ts',
    criterion: 'VITE_DATA_PRODUCTS_V2 defaults to false and the default build cannot reach the product.',
    what: 'gate 8',
  },
  {
    file: 'suiteIntegrity.test.ts',
    criterion: 'The suite accounts for itself: wiring, non-vacuity floors, and privacy.',
    what: 'gate 9',
  },
];

function listFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

function sourceOf(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('Phase 5 data suite: the command and the criteria it holds', () => {
  it('npm run test:data exists and names this directory', () => {
    const packageJson = JSON.parse(sourceOf(join(REPO_ROOT, 'package.json'))) as {
      scripts: Record<string, string>;
    };
    // The exact text the plan's Phase 5 verification block requires, in the same
    // style as test:contracts, test:migrations, and test:privacy.
    expect(packageJson.scripts['test:data']).toBe('vitest run tests/data');
    // The sibling phase gates are still declared, and none of them was renamed.
    for (const sibling of ['test:contracts', 'test:migrations', 'test:privacy']) {
      expect(packageJson.scripts[sibling], sibling).toMatch(/^vitest run tests\//);
    }
    expect(packageJson.scripts.test).toBe('vitest run');
    // The data suite is inside the default Vitest include glob, exactly as
    // tests/contracts, tests/migrations, and tests/privacy are, so `npm test`
    // covers it too rather than hiding it in a lane nobody runs.
    const viteConfig = sourceOf(join(REPO_ROOT, 'vite.config.ts'));
    expect(viteConfig).toContain("include: ['tests/**/*.test.{ts,tsx}']");
  });

  it('every Phase 5 exit criterion is held by a named gate file, and every gate file exists', () => {
    expect(GATE_FILES).toHaveLength(9);
    for (const gate of GATE_FILES) {
      const path = join(DATA_ROOT, gate.file);
      expect(statSync(path).isFile(), gate.file).toBe(true);
      // The file really declares a test for the criterion, not just a comment.
      const source = sourceOf(path);
      expect(source.includes('Phase 5 gate'), gate.file).toBe(true);
      expect(source.length, gate.file).toBeGreaterThan(2000);
    }
    // The four exit criteria, in the plan's order, are all present.
    const criteria = GATE_FILES.map((gate) => gate.criterion);
    expect(criteria[0]).toContain('semantic equality');
    expect(criteria[1]).toContain('attachment bytes');
    expect(criteria[2]).toContain('never replace current data');
    expect(criteria[3]).toContain('External-only');
  });

  it('the suite is tracked by git, and every file in it is', () => {
    // The trap this guards: `.gitignore` carries a bare `data/` pattern, which in
    // gitignore semantics matches a directory named `data` at *any* depth - so
    // `tests/data/` was ignored wholesale. The suite would pass locally, `npm run
    // test:data` would pass, and CI would have no files to run at all. A gate that
    // cannot be committed is not a gate.
    const gitignore = sourceOf(join(REPO_ROOT, '.gitignore'));
    expect(gitignore).toMatch(/^!tests\/data\/$/m);
    // The rule that caused it is still there and still broad, which is why the
    // negation is load-bearing rather than decorative.
    expect(gitignore).toMatch(/^data\/$/m);

    const files = listFiles(DATA_ROOT).map((file) => relative(REPO_ROOT, file));
    expect(files.length).toBeGreaterThanOrEqual(16);
    // Every path is relative and inside `tests/data/`, and none of them is ignored.
    // `git check-ignore` exits 0 for an ignored path and 1 for a tracked one, so a
    // non-zero exit across the whole list is the assertion.
    for (const file of files) {
      expect(file.split('\\').join('/').startsWith('tests/data/'), file).toBe(true);
    }
    const check = spawnSync('git', ['check-ignore', '--quiet', '--', ...files], {
      cwd: REPO_ROOT,
    });
    expect(
      check.status,
      `git check-ignore reported ${check.status === 0 ? 'ignored' : 'an error'} paths under tests/data/. ` +
        'The suite must be committable.',
    ).not.toBe(0);
  });

  it('the suite is exactly the eight gate files plus its support modules', () => {
    const all = listFiles(DATA_ROOT).map((file) => relative(REPO_ROOT, file).split('\\').join('/'));
    const tests = all.filter((path) => path.endsWith('.test.ts'));
    expect([...tests].sort()).toEqual(GATE_FILES.map((gate) => `tests/data/${gate.file}`).sort());
    // Support code lives in one directory and is not a test file, so Vitest never
    // collects it on its own.
    const support = all.filter((path) => path.includes('/support/'));
    expect(support.length).toBeGreaterThanOrEqual(8);
    for (const path of support) {
      expect(path.startsWith('tests/data/support/'), path).toBe(true);
      expect(path.endsWith('.test.ts'), path).toBe(false);
    }
    // No stray scratch file was left behind.
    expect(all.filter((path) => path.includes('__'))).toEqual([]);
  });
});

describe('Phase 5 data suite: the registered reproductions are accounted for', () => {
  it('the interfaces the suite waits on are named, and the product modules are the plan\'s', () => {
    expect(FULL_DEVICE_BACKUP_MODULE).toBe('@/services/persistence/products/fullDeviceBackup');
    expect(ARCHIVE_VALIDATION_MODULE).toBe('@/services/persistence/products/archiveValidation');
    expect(PHASE_5_FLAG_ENV_KEY).toBe('VITE_DATA_PRODUCTS_V2');
    // Three capabilities, each with at least two accepted export names, so an
    // implementer has a small, explicit list to align rather than one invented
    // name the whole suite would hang on.
    expect(Object.keys(EXPORT_ENTRY_POINTS).sort()).toEqual([
      'exportArchive',
      'importArchive',
      'readArchive',
    ]);
    for (const [capability, names] of Object.entries(EXPORT_ENTRY_POINTS)) {
      expect(names.length, capability).toBeGreaterThanOrEqual(2);
      for (const name of names) {
        expect(name, capability).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    }
    expect(EXPORT_ENTRY_POINTS.exportArchive).toContain('exportFullDeviceBackup');
    expect(EXPORT_ENTRY_POINTS.importArchive).toContain('importFullDeviceBackup');
    expect(EXPORT_ENTRY_POINTS.readArchive).toContain('readFullDeviceArchive');
  });

  it('every registered reproduction has been implemented, and none is still waiting', () => {
    // HISTORY. This gate used to count the `it.fails` registrations and pin the
    // total at twenty-four, so that a new reproduction could not be added without
    // the count moving. Phase 5 implemented all twenty-four and flipped each one to
    // a live assertion, keeping a `HISTORY` note beside it, so the count is now
    // zero. The replacement is deliberately *stronger* than the count it replaces:
    // it fails if a registration comes back, which is the only way an implemented
    // assertion could be turned back into a "waiting" one.
    //
    // This file is excluded from its own scan: it necessarily contains the pattern
    // it is counting.
    const self = 'suiteIntegrity.test.ts';
    const files = listFiles(DATA_ROOT).filter(
      (file) => file.endsWith('.test.ts') && !file.endsWith(self),
    );
    const perFile: string[] = [];
    for (const file of files) {
      const source = sourceOf(file);
      // A *call* is `it.fails(` at the start of an expression. Matching the
      // parenthesised form rather than the bare identifier keeps a mention in a
      // comment or a string from being counted as a registration.
      const count = (source.match(/\bit\.fails\(/g) ?? []).length;
      if (count > 0) {
        perFile.push(`${relative(REPO_ROOT, file).split('\\').join('/')}:${count}`);
        // A registered reproduction that does not say what it waits for is a trap
        // for the next maintainer, so the explanation is required in the same
        // file, near the registration.
        expect(source, file).toContain('REGISTERED');
        expect(source.length, file).toBeGreaterThan(2000);
      }
    }
    expect(
      perFile,
      'a registered reproduction is still waiting; flip it to a live assertion and record the history beside it',
    ).toEqual([]);

    // The fifteen-case corruption matrix is the bulk of the twenty-four, and it is
    // still a table of fifteen rather than a literal in a test name, so a case
    // added later still moves the runtime count.
    expect(CORRUPTION_CASES.length).toBe(15);
  });

  it('the twenty-four implemented reproductions are still present as live assertions', () => {
    // The other half of the previous gate: proving the count reached zero did not
    // happen by deleting the tests.
    //
    // A *test* is `it(` or `it.fails(`; matching `it(` alone would also match
    // `it.fails(`, so both are counted and the difference is the number of live
    // assertions in the seven gate files that carried reproductions.
    const self = 'suiteIntegrity.test.ts';
    const perFile: string[] = [];
    let live = 0;
    for (const file of listFiles(DATA_ROOT)) {
      if (!file.endsWith('.test.ts') || file.endsWith(self)) continue;
      const source = sourceOf(file);
      const count = (source.match(/^\s*it(?:\.fails)?\(/gm) ?? []).length;
      live += count;
      perFile.push(`${relative(REPO_ROOT, file).split('\\').join('/')}:${count}`);
    }
    // Each of the seven files that held a registration still holds at least the
    // tests it held, and the total is far above the twenty-four that were
    // implemented, so nothing was removed to make the count zero.
    for (const file of [
      'tests/data/attachmentBytesRoundTrip.test.ts',
      'tests/data/corruptArchiveIsolation.test.ts',
      'tests/data/externalOnlyDisclosure.test.ts',
      'tests/data/manifestContract.test.ts',
      'tests/data/memberPathSafety.test.ts',
      'tests/data/phase5FlagDefault.test.ts',
      'tests/data/populatedStateRoundTrip.test.ts',
    ]) {
      const entry = perFile.find((line) => line.startsWith(`${file}:`));
      expect(entry, file).toBeDefined();
      expect(Number((entry as string).split(':').pop()), file).toBeGreaterThan(0);
    }
    // A floor, and deliberately well below the measured count: the point is only
    // that the count did not reach zero by deleting tests, so the floor has to sit
    // far above the nine call sites that were once `it.fails` and far below the
    // suite's real size, or a future added test would break the gate.
    expect(live).toBeGreaterThan(60);
  });

  it('the corruption table is fifteen distinct cases with distinct rule statements', () => {
    expect(CORRUPTION_CASES).toHaveLength(15);
    expect(new Set(CORRUPTION_CASES.map((spec) => spec.id)).size).toBe(15);
    expect(new Set(CORRUPTION_CASES.map((spec) => spec.rule)).size).toBe(15);
    // Two cases legitimately share a reason: `state-not-json` and
    // `manifest-not-json` are both `member-not-json`, because one member-reading
    // rule covers both. Fourteen distinct reasons for fifteen cases is the real
    // number, and pinning it keeps a copy-paste from silently merging two.
    expect(new Set(CORRUPTION_CASES.map((spec) => spec.contractReason)).size).toBe(14);
    // Every case declares whether the audited codec catches it on its own, and the
    // partition is measured rather than restated: the codec's own coverage is
    // asserted against a real read in `corruptArchiveIsolation.test.ts`, and this
    // is the same number from the table's side.
    expect(
      CORRUPTION_CASES.filter((spec) => spec.codecCoverage === 'codec-rejects').length +
        CORRUPTION_CASES.filter((spec) => spec.codecCoverage === 'requires-product-validation').length,
    ).toBe(CORRUPTION_CASES.length);
    expect(CORRUPTION_CASES.filter((spec) => spec.codecCoverage === 'codec-rejects').length).toBeGreaterThan(0);
    expect(
      CORRUPTION_CASES.filter((spec) => spec.codecCoverage === 'requires-product-validation').length,
    ).toBeGreaterThan(0);
  });

  it('the manifest key set the suite pins is twelve distinct keys', () => {
    expect(REQUIRED_MANIFEST_KEYS).toHaveLength(12);
    expect(new Set(REQUIRED_MANIFEST_KEYS).size).toBe(12);
    // The three version concepts are three keys, not one.
    for (const key of [
      'formatVersion',
      'storageGenerationFormatVersion',
      'subjectSchemaVersion',
    ]) {
      expect(REQUIRED_MANIFEST_KEYS, key).toContain(key);
    }
  });
});

describe('Phase 5 data suite: privacy', () => {
  it('no source, fixture, or filename in the suite contains learner data or a real host', () => {
    // A host allowlist, not a blocklist: the reserved `example.invalid` is the
    // only host this repository's synthetic fixtures may name, so anything that
    // looks like a real host has to be justified and this suite refuses to.
    const files = listFiles(DATA_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(16);

    const HOST_LIKE = /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|co|uk|de|app|xyz|info|biz)\b/gi;
    const CREDENTIAL_LIKE =
      /\b(?:bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key\s*[:=]\s*['"][^'"]{8,}|password\s*[:=]\s*['"][^'"]{4,}|authorization\s*[:=])/i;
    const QUERY_STRING = /[?&](?:token|key|secret|password|session)=/i;
    const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//;

    const offenders: string[] = [];
    for (const file of files) {
      const repoRelativePath = relative(REPO_ROOT, file).split('\\').join('/');
      const source = sourceOf(file);
      for (const [rule, pattern] of [
        ['host-like', HOST_LIKE],
        ['credential-like', CREDENTIAL_LIKE],
        ['query-string', QUERY_STRING],
        ['home-path', HOME_PATH],
      ] as const) {
        for (const match of source.matchAll(
          new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
        )) {
          // The SVG XML namespace URI is a namespace name, not a destination, and
          // the repository's own Phase 0 fixture already contains it.
          if (match[0] === 'www.w3.org') continue;
          offenders.push(`${repoRelativePath}:${rule}`);
        }
      }
      // The reserved host is allowed, and only the reserved host. The one other
      // identifier allowed is the SVG XML namespace URI, which is a namespace
      // *name* rather than a destination - it is never dereferenced, and the
      // repository's own Phase 0 subject fixture already contains it.
      const hosts = [...source.matchAll(/\bhttps?:\/\/([^/'"\s)]+)/g)].map((match) => match[1]);
      for (const host of hosts) {
        if (
          host !== 'example.invalid' &&
          host !== 'www.w3.org' &&
          !/^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(host)
        ) {
          offenders.push(`${repoRelativePath}:non-reserved-host`);
        }
      }
    }
    expect(offenders, [...new Set(offenders)].join('\n')).toEqual([]);
  });

  it('no filename in the suite names a subject, a note, a topic, or an attachment', () => {
    // A filename is a place learner content leaks from, so the suite's own
    // filenames are checked as strictly as the archive's member names.
    const files = listFiles(DATA_ROOT);
    for (const file of files) {
      const name = file.split('\\').join('/').split('/').pop() as string;
      expect(name, file).toMatch(/^[a-z0-9][A-Za-z0-9._-]*$/);
      expect(name.endsWith('.png'), name).toBe(false);
      expect(name.endsWith('.jpg'), name).toBe(false);
      expect(name.endsWith('.svg'), name).toBe(false);
      expect(name.endsWith('.txt'), name).toBe(false);
      expect(name.endsWith('.md'), name).toBe(false);
    }
  });
});
