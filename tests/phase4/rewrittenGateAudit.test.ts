/**
 * Phase 4 independent audit of the *rewritten gates* in
 * `tests/migrations/qaHardening.test.ts`.
 *
 * Phase 3 review found five gates that passed vacuously, so a rewritten gate is
 * treated here as suspect until its detector is shown to bite. This file does two
 * things:
 *
 * 1. **Proves the new static-import detector is sensitive.** The new rule "no
 *    module outside the v2 tree statically imports a storage-v2 implementation
 *    module" is a regular expression over source text. A regular expression that
 *    matches nothing is indistinguishable from a clean tree, so the expression is
 *    exercised here against planted probes - every shape it must catch, plus the
 *    shapes it must *not* flag - without touching a production file.
 * 2. **Shows the allowlist gate is a permission list, not an equality check.**
 *    `qaHardening.test.ts` allows seven named files to import storage-v2. Nothing
 *    there asserts that those files still import it, so an entry can go stale and
 *    the gate keeps passing while the real importer set shrinks. That is recorded
 *    here as a finding rather than silently accepted.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');
const V2_DIR = join(SRC, 'services', 'persistence', 'v2');
const HARDENING = join(REPO_ROOT, 'tests', 'migrations', 'qaHardening.test.ts');

/**
 * The exact expression the new gate uses, copied from
 * `tests/migrations/qaHardening.test.ts`. It is duplicated rather than imported
 * so this file measures the *rule* and not one test's use of it.
 */
const STATIC_IMPORT = /(?:^|\n)\s*import\s(?!type\s)([^;]*?from\s*)?['"]([^'"]+)['"]/g;

/** The v2 modules the rule protects, as base names. */
const IMPLEMENTATION_MODULES = [
  'database',
  'repository',
  'migrations',
  'validation',
  'legacyReader',
  'appRepository',
  'attachmentBytes',
  'migrationState',
  'archive',
];

/** The specifiers a planted probe uses. */
const SPECIFIERS = [
  '@/services/persistence/v2/repository',
  '@/services/persistence/v2/appRepository',
  './v2/attachmentBytes',
  '../v2/migrations',
];

/** The specifiers the rule must resolve to a v2 module. */
function resolvesToV2(specifier: string): boolean {
  const name = specifier.split('/').pop() as string;
  return IMPLEMENTATION_MODULES.includes(name.replace(/\.js$/, ''));
}

describe('The rewritten static-import gate bites', () => {
  it('catches every shape of a value import of a storage-v2 implementation module', () => {
    const shapes = [
      `import { openStorageV2Repository } from '${SPECIFIERS[0]}';\n`,
      `import { openStorageV2Repository } from "${SPECIFIERS[0]}";\n`,
      `import * as repo from '${SPECIFIERS[0]}';\n`,
      `import { openStorageV2Repository as open } from '${SPECIFIERS[0]}';\n`,
      `import defaultExport from '${SPECIFIERS[0]}';\n`,
      `import '${SPECIFIERS[0]}';\n`,
      // Indented, as a nested import would be.
      `  import { x } from '${SPECIFIERS[0]}';\n`,
      // A multi-line named import.
      `import {\n  a,\n  b,\n} from '${SPECIFIERS[1]}';\n`,
      // A relative specifier.
      `import { x } from '${SPECIFIERS[2]}';\n`,
      // Two imports on one statement list.
      `import { a } from '${SPECIFIERS[0]}';\nimport { b } from '${SPECIFIERS[3]}';\n`,
    ];
    const caught = shapes.map((source) => [...source.matchAll(STATIC_IMPORT)].length > 0);
    // Every shape must be caught. If one is not, the gate can be satisfied by a
    // tree that imports the module in that shape.
    expect(caught.filter((value) => !value)).toEqual([]);
  });

  it('does not flag a type-only import, a dynamic import, or a mention in a string', () => {
    const shapes = [
      `import type { StorageV2Repository } from '${SPECIFIERS[0]}';\n`,
      `const mod = await import('${SPECIFIERS[0]}');\n`,
      `const mod = await import(\n  '${SPECIFIERS[0]}',\n);\n`,
      `// import { x } from '${SPECIFIERS[0]}';\n`,
      ` * import { x } from '${SPECIFIERS[0]}';\n`,
      `const text = "import { x } from '${SPECIFIERS[0]}'";\n`,
      `export type { Thing } from '${SPECIFIERS[0]}';\n`,
    ];
    const caught = shapes.map((source) => [...source.matchAll(STATIC_IMPORT)].length > 0);
    // A gate that flags these would be noise; a gate that misses the first three
    // is a hole.
    expect(caught).toEqual([false, false, false, false, false, false, false]);
  });

  it('resolves every protected module to a real file, so the name list is not fiction', () => {
    for (const name of IMPLEMENTATION_MODULES) {
      expect(existsSync(join(V2_DIR, `${name}.ts`)), name).toBe(true);
    }
    // And the rule's own exclusion list names real modules too, so a rename
    // cannot silently widen the rule.
    for (const name of ['appState', 'dualWrite', 'repositorySelection', 'checksum', 'schema']) {
      expect(existsSync(join(V2_DIR, `${name}.ts`)), name).toBe(true);
    }
  });

  it('reports a real violation when one is planted in a copy of a real module', () => {
    // The walk is reproduced against a temporary copy of a real application
    // module with a planted value import, so the check is shown to bite on the
    // real graph rather than on a string in isolation.
    const realModule = join(SRC, 'services', 'sessionTracker.ts');
    const source = readFileSync(realModule, 'utf8');
    const planted = `${source}\nimport { publishShortcutsToActiveGeneration } from '@/services/persistence/v2/appRepository';\n`;
    const before = [...source.matchAll(STATIC_IMPORT)].filter((match) =>
      resolvesToV2(String(match[2])),
    ).length;
    const after = [...planted.matchAll(STATIC_IMPORT)].filter((match) =>
      resolvesToV2(String(match[2])),
    ).length;
    // The real module is clean, and the planted import is caught: +1.
    expect(before).toBe(0);
    expect(after).toBe(before + 1);
  });
});

describe('The rewritten allowlist gate is a permission list, not an equality check', () => {
  it('every allowlisted file exists, and the entry for preferencesStore is a type-only import', () => {
    // Read the allowlist out of the gate itself rather than restating it, so this
    // test fails if the gate is edited without this audit being updated.
    const source = readFileSync(HARDENING, 'utf8');
    // The gate hoists its allowlist and its detector to module scope so a test can
    // prove what the detector does with one specific path, so the audit reads the
    // declaration from its new home. The properties asserted below are unchanged.
    const allowlistStart = source.indexOf('const STORAGE_V2_SEAMS: ReadonlyMap<string, string> = new Map([');
    const allowlistEnd = source.indexOf('const offenders: string[] = []', allowlistStart);
    expect(allowlistStart, 'the allowlist declaration was not found in the gate').toBeGreaterThan(-1);
    expect(allowlistEnd, 'the end of the allowlist block was not found').toBeGreaterThan(allowlistStart);
    const allowlist = source.slice(allowlistStart, allowlistEnd);
    const entries = [...allowlist.matchAll(/extensionless\(join\(SRC([^)]*)\)\)/g)].map(
      (match) =>
        [...(match[1] as string).matchAll(/'([^']+)'/g)]
          .map((segment) => segment[1] as string)
          .join('/'),
    );
    expect(entries.length).toBeGreaterThanOrEqual(7);
    for (const entry of entries) {
      expect(existsSync(resolve(SRC, entry)), entry).toBe(true);
    }
    // The `preferencesStore` entry exists only for a *type* import, which the
    // build erases. It is legitimate, and it is also the one entry that would
    // still pass if the import were deleted - the recorded weakness.
    const preferences = readFileSync(join(SRC, 'store', 'preferencesStore.ts'), 'utf8');
    const staticImports = [...preferences.matchAll(STATIC_IMPORT)].filter((match) =>
      resolvesToV2(String(match[2])),
    );
    expect(staticImports).toEqual([]);
    expect(preferences).toContain("import type { PersistedPreferencesValue } from '@/services/persistence/v2/appState'");
  });

  it('the gate does not assert that each allowlisted entry is still live', () => {
    // Stated as a fact about the gate, so a future edit that adds the assertion
    // makes this test fail and prompts a re-audit.
    const source = readFileSync(HARDENING, 'utf8');
    // The allowlist, the detector, and the test that runs them, in source order.
    const block = source.slice(
      source.indexOf('const STORAGE_V2_SEAMS: ReadonlyMap<string, string> = new Map(['),
    );
    const end = block.indexOf("it('no module outside the v2 tree statically imports");
    const body = block.slice(0, end > 0 ? end : undefined);
    // The gate checks that every real importer is allowed...
    expect(body).toContain('if (importsStorageV2 && !STORAGE_V2_SEAMS.has(');
    // ...and that every allowlisted entry exists...
    expect(body).toContain('existsSync(`${key}.ts`)');
    // ...but there is no assertion that every allowlisted entry still imports
    // storage-v2, so an entry can go stale while the gate stays green.
    expect(body).not.toContain('importsStorageV2 ===');
    expect(body).not.toContain('toBe(STORAGE_V2_SEAMS.size');
  });
});
