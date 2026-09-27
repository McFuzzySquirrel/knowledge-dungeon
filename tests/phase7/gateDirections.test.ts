/**
 * Phase 7 verifier gate V7 - the two gate directions Phase 7 changed, judged and probed.
 *
 * ## What changed, and what each old assertion was a proxy for
 *
 * **`tests/data/templateProductBoundary.test.ts`**: "no module outside the product tree
 * names the product" became "a pinned list of named `dynamic` callers, and no eager edge of
 * any kind". The property the old assertion proxied for is *"the product cannot be reached
 * eagerly from the application"*. The replacement is that property plus a name: it still
 * ranges over **every** module outside the tree, still collects **every** edge kind, and
 * now adds two things the old one could not say - which module is entitled to reach the
 * product, and that the count of lazy call sites is pinned. So it is a **superset**, not a
 * sound-alike. The one thing to check for is vacuity: a classifier that recognised nothing
 * would report "no eager edge" for the wrong reason, and the replacement is partly a
 * negative assertion, so it needs a positive control.
 *
 * **`tests/data/templateLegacyPath.test.ts`**: "exactly one screen names either function"
 * became an **empty** caller set with a tightened detector (a real edge to the module *and*
 * the name in live code, ignoring comments and type-only edges). The old assertion proxied
 * for *"the leaking exporter is reachable from exactly one place, and that place is known"*.
 * After the cutover the true property is *"the leaking exporter is reachable from nowhere"*,
 * so the old assertion could not be kept - pinning one caller after removing it would be
 * pinning a falsehood. The replacement states the true property, and the tightening makes
 * it *less* likely to be satisfied by accident: a comment mentioning the pair no longer
 * counts, and a type-only import no longer counts.
 *
 * ## What this gate does
 *
 * It probes both replacements for vacuity using the implementers' own edge classifier, with
 * a **deliberate violation** in each direction: a synthetic module that statically imports
 * the product, and a synthetic module that dynamically imports the legacy module and binds
 * the leaking exporter. A detector that cannot see those has stopped detecting, and the
 * gates would pass for the wrong reason.
 *
 * It also re-derives both measurements with this suite's own independent walker, so the
 * verdicts do not rest entirely on the implementers' resolver.
 *
 * Phase: 7.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { blankComments, classifySpecifierEdges } from '../data/support/importGraph';
import { blankComments as myBlankComments, closureOf, specifiersIn } from './support/closure';

const REPO_ROOT = process.cwd();
const PRODUCT_MODULE = 'src/services/persistence/products/subjectTemplate.ts';
const LEGACY_MODULE = 'src/services/persistence/subjectPersistence.ts';
const CUTOVER_MODULE = 'src/ui/data/SubjectTemplateTab.tsx';
const PRODUCTS_TREE = 'src/services/persistence/products/';

/** A synthetic module that violates the boundary the way a real regression would. */
const EAGER_CALLER = [
  `import { exportSubjectTemplate } from '@/services/persistence/products/subjectTemplate';`,
  `export const leak = exportSubjectTemplate;`,
  '',
].join('\n');

/** A synthetic module that violates the cutover the way a real regression would. */
const LEGACY_CALLER = [
  `export async function bad() {`,
  `  const legacy = await import('@/services/persistence/subjectPersistence');`,
  `  return legacy.exportSubjectAsTemplate;`,
  `}`,
  '',
].join('\n');

/** A synthetic module that only *mentions* the legacy pair, with no binding. */
const PROSE_ONLY = [
  `// The pre-Phase-7 exportSubjectAsTemplate was leaking, and so was createSubjectFromTemplate.`,
  `export const note = 'exportSubjectAsTemplate';`,
  '',
].join('\n');

describe('phase 7 verifier V7: the product-boundary replacement detects an eager caller', () => {
  it('classifies a static importer of the product as a static edge', () => {
    expect(
      classifySpecifierEdges(EAGER_CALLER, 'src/ui/synthetic/eagerCaller.tsx', PRODUCT_MODULE).map(
        (edge) => edge.kind,
      ),
    ).toEqual(['static']);
  });

  it('classifies the real cutover tab as three dynamic edges and one type-only edge', () => {
    // The positive control the gate relies on. If this produced nothing, the gate's
    // "no eager edge" assertion would be satisfied by a classifier that sees nothing.
    expect(
      classifySpecifierEdges(
        blankComments(readFileSync(join(REPO_ROOT, CUTOVER_MODULE), 'utf8')),
        CUTOVER_MODULE,
        PRODUCT_MODULE,
      )
        .map((edge) => edge.kind)
        .sort(),
    ).toEqual(['dynamic', 'dynamic', 'dynamic', 'type-only']);
  });

  it('re-derives, with this suite\'s own walker, that the only outside-tree reacher is lazy', () => {
    const eager: string[] = [];
    const lazy: string[] = [];
    for (const path of closureOf('src/main.tsx').paths) {
      if (!path.startsWith('src/') || path.startsWith(PRODUCTS_TREE)) continue;
      const code = myBlankComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
      const names = specifiersIn(code).filter((specifier) =>
        specifier.replace(/^@\//, 'src/').startsWith(PRODUCTS_TREE.replace(/\/$/, '')),
      );
      if (names.length === 0) continue;
      // A liberal walker cannot tell `import x from` from `await import(`, so the two are
      // separated per specifier: an eager edge is a top-level `import ... from '<spec>'`
      // that is not `import type`, and a `require` call.
      for (const specifier of names) {
        const escape = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const eagerForm = new RegExp(
          `(^|\\n)\\s*import\\s+(?!type\\b)[^;'\"]*?\\sfrom\\s*['\"]${escape}['\"]`,
        ).test(code);
        const requireForm = new RegExp(`require\\s*\\(\\s*['\"]${escape}['\"]`).test(code);
        const entry = `${path} ${eagerForm || requireForm ? 'eager' : 'lazy'}`;
        if (eagerForm || requireForm) eager.push(entry);
        else lazy.push(entry);
      }
    }
    expect(eager).toEqual([]);
    expect(lazy.length).toBeGreaterThanOrEqual(1);
    expect(lazy.every((entry) => entry.endsWith('lazy'))).toBe(true);
  });
});

describe('phase 7 verifier V7: the legacy-cutover replacement detects a real caller', () => {
  it('classifies a dynamic importer that binds the leaking exporter as a caller', () => {
    const edges = classifySpecifierEdges(LEGACY_CALLER, 'src/ui/synthetic/legacyCaller.tsx', LEGACY_MODULE);
    expect(edges.map((edge) => edge.kind)).toEqual(['dynamic']);
    expect(edges.some((edge) => edge.kind !== 'type-only')).toBe(true);
  });

  it('classifies prose that mentions the pair as no edge at all, which is the tightening', () => {
    // The tightening is what makes the empty set trustworthy rather than accidental: a
    // comment explaining the cutover, and a string constant naming the function, are both
    // documentation and neither is a binding.
    expect(
      classifySpecifierEdges(PROSE_ONLY, 'src/ui/synthetic/proseOnly.tsx', LEGACY_MODULE),
    ).toEqual([]);
  });

  it('re-derives, with this suite\'s own walker, that no module outside the legacy module reaches it by either name', () => {
    const offenders: string[] = [];
    // The walk, then a word-boundary mention check over every module it reached.
    const reached = closureOf('src/main.tsx').paths;
    for (const path of reached) {
      if (path === 'src/services/persistence/subjectPersistence.ts') continue;
      const code = myBlankComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
      if (!code.includes('@/services/persistence/subjectPersistence')) continue;
      for (const name of ['exportSubjectAsTemplate', 'createSubjectFromTemplate']) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${path}:${name}`);
      }
    }
    expect(offenders).toEqual([]);
    // ...and the walk really did reach the legacy module, so the result is about the names.
    expect(reached).toContain('src/services/persistence/subjectPersistence.ts');
    expect(reached).toContain(CUTOVER_MODULE);
    expect(reached.length).toBeGreaterThanOrEqual(100);
  });

  it('finds the caller in the pre-cutover screen, which is the positive control for the detector', () => {
    // `git show` of the commit before this phase: the screen *did* bind the pair there, and
    // the same detector must say so. Without this, "no callers" could be a detector that
    // stopped working.
    const before = execFileSync('git', ['show', '8eb2587:src/ui/screens/WelcomeScreen.tsx'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const edges = classifySpecifierEdges(
      blankComments(before),
      'src/ui/screens/WelcomeScreen.tsx',
      LEGACY_MODULE,
    );
    expect(edges.map((edge) => edge.kind)).toEqual(['static']);
    expect(edges.some((edge) => edge.kind !== 'type-only')).toBe(true);
    expect(blankComments(before)).toMatch(/\bexportSubjectAsTemplate\b/);
  });
});
