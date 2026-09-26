/**
 * Adversarial probes for the cross-suite planting exemption.
 *
 * The privacy gate plants detector probe modules inside `src/__privacy_probe__/`
 * so that its import-graph walk and network scanner are proven against the real
 * application tree. Because the `qaHardening` gate scans `src/` for forbidden
 * imports at the same time, that planting needs a transient, self-declaring
 * exemption (`isTestOwnedTransientPath`) or the two suites flake against each
 * other.
 *
 * An exemption is a hole in a gate, so it gets attacked the way the gate does:
 *
 *   1. Does a real offender in a differently named directory still fail? (no hole)
 *   2. Does a lookalike directory name widen the exemption? (no hole)
 *   3. Does a real offender left in the declared directory fail once the planting
 *      is over? (no standing hole)
 *   4. Is the marker load-bearing, or is the directory name enough? (load-bearing)
 *   5. Can a real forbidden call be smuggled past the gate by planting it in the
 *      declared directory while the planting window is open?
 *
 * ── History: items 1-4 passed; the last three tests asserted the hole existed ──
 *
 * The three tests in `the hole` block were written while the exemption was
 * *directory-wide*, and they asserted what was true then: a module in the exempt
 * directory was invisible to the gate for as long as the marker existed, whether
 * or not the planting had declared it. They are now the tests that hold the hole
 * shut, inverted so that a regression fails. The attack is unchanged - same
 * smuggling attempt, same assertions, opposite expectation - so the file still
 * proves the property rather than merely restating it.
 *
 * The fix was to make the marker's *contents* the declaration: it lists the exact
 * repo-relative paths the planting created, and only those are exempt. A planting
 * that cannot state its files, or states them malformed, is exempt for nothing.
 *
 * ── Why this file never plants a forbidden file under `src/` ────────────────
 *
 * `isTestOwnedTransientPath` is a *path predicate*: it stats the marker, reads the
 * marker's own declaration, and string-matches the directory name. It never reads
 * the content of the file being judged, so it is the only thing in the
 * `qaHardening` gate that can hide a module, and it can be attacked on
 * hypothetical paths without writing anything.
 *
 * That matters here, because this file runs in the same parallel pass as the
 * gate it attacks. A test that planted a genuine forbidden call into a
 * non-exempt directory would make the real `qaHardening` gate fail for real, and
 * a test that must be run separately is a weaker test. So:
 *
 *   - Every file written under `src/` is written **inside the declared,
 *     marker-exempt directory**, with the marker present, so other gates skip it.
 *     Those files contain no forbidden call.
 *   - Forbidden content exists only as a *string*, handed to the gate's own
 *     `scanModuleForNetworkRules` to prove it is detectable.
 *   - The `afterEach` removes the whole declared directory, marker included.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PLANTING_MARKER_NAME,
  SRC_ROOT,
  TEST_OWNED_SOURCE_DIRECTORIES,
  allFirstPartyModules,
  isTestOwnedTransientPath,
  plantingMarkerPath,
  repoPath,
  scanModuleForNetworkRules,
  testOwnedDirectory,
  writePlantingMarker,
} from '../privacy/support/appGraph';

const DECLARED = TEST_OWNED_SOURCE_DIRECTORIES[0] as string;
const DECLARED_DIRECTORY = testOwnedDirectory(DECLARED);
const MARKER = plantingMarkerPath(DECLARED);

/** Siblings whose names are *not* declared, used as hypothetical paths only. */
const UNDECLARED_DIRECTORY = join(SRC_ROOT, `${DECLARED}__offender`);
const LOOKALIKE_DIRECTORY = join(SRC_ROOT, `${DECLARED}__lookalike`);

/** Harmless module source. Written under `src/`, so it must stay clean. */
const INERT_SOURCE = 'export const syntheticProbePlaceholder = 1;\n';

/**
 * A real, unambiguous forbidden call: a first-party POST to a remote endpoint.
 * Never written to disk; only ever scanned as a string.
 */
const REAL_OFFENDER_SOURCE = [
  'export async function uploadLearnerWork(payload: string): Promise<Response> {',
  "  return fetch('https://collector.example.invalid/api/upload', {",
  "    method: 'POST',",
  '    body: payload,',
  '  });',
  '}',
  '',
].join('\n');

/**
 * Start a planting the way the privacy gate does: the test-owned directory exists,
 * then the marker is written into it. `writePlantingMarker` deliberately does not
 * create the directory, so the order is part of the contract.
 *
 * `declared` is the exact file list the planting claims, which is what the
 * exemption is keyed on. The default is the inert probe this file plants, so a test
 * that does not care about the distinction still exercises a declared planting.
 */
function startPlanting(declared: readonly string[] = [`src/${DECLARED}/planted-probe.ts`]): void {
  mkdirSync(DECLARED_DIRECTORY, { recursive: true });
  writePlantingMarker(DECLARED, declared);
}

function plantInertModule(fileName: string): string {
  mkdirSync(DECLARED_DIRECTORY, { recursive: true });
  const file = join(DECLARED_DIRECTORY, fileName);
  writeFileSync(file, INERT_SOURCE, 'utf8');
  return file;
}

/**
 * A module in the exempt directory that the planting never declared.
 *
 * Written for real, and inert: the gate's file *list* only ever contains files that
 * exist, so asserting "the gate still sees it" against a hypothetical path would
 * pass for the wrong reason. What the file must not contain is a forbidden import -
 * the smuggled forbidden call is only ever a string - so writing it cannot make any
 * other gate fail.
 */
function plantUndeclaredModule(fileName: string): string {
  return plantInertModule(fileName);
}

/**
 * The exact filter the `qaHardening` gate applies to the source tree
 * (`tests/migrations/qaHardening.test.ts:96`), reconstructed from exported
 * helpers so this test observes the gate's real view of `src/`.
 */
function modulesTheGateSees(): readonly string[] {
  return allFirstPartyModules()
    .map((repoRelative) => join(process.cwd(), repoRelative))
    .filter((absolute) => !isTestOwnedTransientPath(absolute))
    .map(repoPath);
}

/** Does the gate's own scanner find the forbidden call in this source? */
function scannerFindsForbiddenCall(): boolean {
  return scanModuleForNetworkRules('src/__privacy_probe__/hypothetical.ts', REAL_OFFENDER_SOURCE)
    .findings.length > 0;
}

afterEach(() => {
  rmSync(DECLARED_DIRECTORY, { recursive: true, force: true });
});

describe('planting exemption: the forbidden call is detectable to begin with', () => {
  it('the gate scanner reports a smuggled real offender', () => {
    // Every "the exemption hides it" claim below rests on this: the content is
    // genuinely forbidden, so only the filter can be the reason it goes unreported.
    expect(scannerFindsForbiddenCall()).toBe(true);
  });
});

describe('planting exemption: boundaries hold', () => {
  it('a differently named directory is never exempt, even mid-planting', () => {
    startPlanting();
    const smuggled = join(UNDECLARED_DIRECTORY, 'smuggled.ts');

    expect(isTestOwnedTransientPath(smuggled)).toBe(false);
    expect(modulesTheGateSees()).not.toContain(repoPath(smuggled));
    expect(existsSync(UNDECLARED_DIRECTORY)).toBe(false);
  });

  it('a lookalike directory name is not covered by the declared name', () => {
    startPlanting();
    const smuggled = join(LOOKALIKE_DIRECTORY, 'smuggled.ts');

    expect(smuggled.startsWith(`${DECLARED_DIRECTORY}/`)).toBe(false);
    expect(isTestOwnedTransientPath(smuggled)).toBe(false);
  });

  it('the marker is load-bearing, not the directory name', () => {
    const planted = plantInertModule('planted-probe.ts');

    // Before the marker: the directory is ordinary source and is scanned.
    expect(existsSync(MARKER)).toBe(false);
    expect(isTestOwnedTransientPath(planted)).toBe(false);
    expect(modulesTheGateSees()).toContain(repoPath(planted));

    // With the marker: exempt.
    startPlanting();
    expect(existsSync(MARKER)).toBe(true);
    expect(isTestOwnedTransientPath(planted)).toBe(true);
    expect(modulesTheGateSees()).not.toContain(repoPath(planted));

    // Planting over: the exemption is gone, so a leftover is scanned again.
    rmSync(MARKER, { force: true });
    expect(isTestOwnedTransientPath(planted)).toBe(false);
    expect(modulesTheGateSees()).toContain(repoPath(planted));
  });

  it('the declared name is the only exempt name, and only one is declared', () => {
    expect(TEST_OWNED_SOURCE_DIRECTORIES).toEqual([DECLARED]);
    expect(PLANTING_MARKER_NAME).toBe('.test-planted');
  });
});

describe('planting exemption: the hole is closed', () => {
  it('a real forbidden call is no longer skipped while a planting is in flight', () => {
    // The attack, unchanged. Inside the planting window a module is planted in the
    // exempt directory that the planting never declared. Previously the gate could
    // not see it at all: the exemption was directory-wide, so *any* module there
    // was invisible. Now the marker's contents are the declaration, and this file
    // is not in it.
    startPlanting();
    const smuggled = plantUndeclaredModule('smuggled.ts');

    // The content is genuinely forbidden, so only the filter can be the reason it
    // goes unreported.
    expect(scannerFindsForbiddenCall()).toBe(true);
    // It is scanned, and the gate sees it, while a planting is live.
    expect(isTestOwnedTransientPath(smuggled)).toBe(false);
    expect(modulesTheGateSees()).toContain(repoPath(smuggled));
    // And the planting's *own* declared file is still exempt, or the exemption
    // would be useless and the two suites would flake.
    const owned = plantInertModule('planted-probe.ts');
    expect(isTestOwnedTransientPath(owned)).toBe(true);
    expect(modulesTheGateSees()).not.toContain(repoPath(owned));
  });

  it('the exemption is limited to the planting\'s own declared modules', () => {
    startPlanting();
    const owned = plantInertModule('planted-probe.ts');
    const unrelated = plantUndeclaredModule('unrelated-offender.ts');

    // The distinction the directory-wide exemption could not draw: the module the
    // planting declared, and a module that merely happens to sit beside it.
    expect(isTestOwnedTransientPath(owned)).toBe(true);
    expect(isTestOwnedTransientPath(unrelated)).toBe(false);

    const seen = modulesTheGateSees();
    expect(seen).not.toContain(repoPath(owned));
    expect(seen).toContain(repoPath(unrelated));
  });

  it('a marker that declares nothing exempts nothing, so writing one gains no cover', () => {
    // The third attack, and the one that decides the design: the predicate used to
    // authorise on the *presence* of the marker, so any suite could open the
    // exemption just by creating the file. Now the marker has to be a readable
    // list of paths, and an unreadable or non-JSON marker authorises nothing - the
    // gate fails closed, which is the only safe direction for an exemption.
    mkdirSync(DECLARED_DIRECTORY, { recursive: true });
    const smuggled = plantUndeclaredModule('smuggled.ts');
    writeFileSync(MARKER, 'not written by the privacy gate, but indistinguishable\n', 'utf8');
    expect(isTestOwnedTransientPath(smuggled)).toBe(false);
    expect(modulesTheGateSees()).toContain(repoPath(smuggled));

    // The same is true of a marker that names a path as a list-shaped string rather
    // than as JSON: the declaration is data, and unparseable data is not a
    // declaration.
    writeFileSync(MARKER, JSON.stringify({ files: [`src/${DECLARED}/smuggled.ts`] }), 'utf8');
    expect(isTestOwnedTransientPath(smuggled)).toBe(false);
    expect(modulesTheGateSees()).toContain(repoPath(smuggled));
  });

  it('a planting that forgets to declare a file it created gets that file scanned', () => {
    // Failing closed in the other direction, and the reason the design is tolerable:
    // the failure mode of a forgotten declaration is a false positive in the
    // migration gate, not a hidden offender. A loud false positive is the right
    // trade; a quiet false negative is not.
    startPlanting([`src/${DECLARED}/planted-probe.ts`]);
    const forgotten = plantInertModule('forgotten-probe.ts');
    expect(isTestOwnedTransientPath(forgotten)).toBe(false);
    expect(modulesTheGateSees()).toContain(repoPath(forgotten));
  });
});
