/**
 * Phase 18: the renderer and network boundaries of the statistics domain.
 *
 * Four gates, each pinned by an import-graph walk rather than by a comment:
 *
 * 1. `src/core/statistics/**` reaches no renderer, no store, no service, and no DOM.
 * 2. `src/application/sessionLifecycle.ts` reaches no renderer, no store, and no service - the
 *    reason the lifecycle is unit-testable without a browser.
 * 3. No module in the statistics closure performs a network call. Statistics are local, and a
 *    network request carrying a day key or an event count would be the plan's non-goal.
 * 4. The privacy gate's own detector still fires: a planted probe is caught. Without this the
 *    three walks above could pass *because* the walker found nothing at all.
 *
 * The walks are written here rather than reused from the privacy gate, because a gate that
 * shares an implementation with the thing it verifies can only agree with itself.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');
const ALIAS = '@/';

/** A module specifier that must never appear in a renderer-neutral module's closure. */
const FORBIDDEN_PREFIXES = [
  'src/renderers/',
  'src/game/',
  'node_modules/phaser',
  'node_modules/pixi.js',
  'phaser',
  'pixi.js',
] as const;

/** A module specifier a `src/core/` module must not reach. */
const CORE_FORBIDDEN = [
  'src/store/',
  'src/services/',
  'src/ui/',
  'src/application/',
  'src/game/',
  'src/renderers/',
] as const;

/**
 * A **DOM API call** a `src/core/` module must not make.
 *
 * Specific API shapes rather than the bare identifiers, because `window` and `document` are
 * ordinary variable names in this repository - `roomClearRewards.ts` has a `Set` named
 * `window` - and a bare-identifier scan would report a false positive that could only be
 * silenced by renaming a working module. What is forbidden is *reaching the host*, and these
 * are the shapes that do.
 */
const DOM_APIS = [
  /\bglobalThis\.window\b/,
  /\btypeof\s+window\b/,
  /\bwindow\.(addEventListener|removeEventListener|localStorage|sessionStorage|document|setTimeout|setInterval|requestAnimationFrame|navigator|location|matchMedia)\b/,
  /\bdocument\.(getElementById|querySelector|querySelectorAll|createElement|addEventListener|body|head)\b/,
  /\blocalStorage\.(getItem|setItem|removeItem|clear)\b/,
  /\bindexedDB\.open\b/,
  /\bnavigator\.(sendBeacon|clipboard|geolocation)\b/,
  /\bnew\s+XMLHttpRequest\b/,
] as const;

/** A network call, in any spelling this repository uses. */
const NETWORK_CALLS = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bnew\s+Worker\s*\(/,
] as const;

function readSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Static `import ... from '...'`, bare `import '...'`, and `export ... from '...'`.
  for (const match of source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/import\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  // Dynamic `import('...')`.
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]);
  }
  // `require('...')`.
  for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** Resolve a specifier from an importing file, or `null` when it leaves the repository. */
function resolveSpecifier(specifier: string, importer: string): string | null {
  const base = specifier.startsWith(ALIAS)
    ? resolve(SRC, specifier.slice(ALIAS.length))
    : specifier.startsWith('.')
      ? resolve(dirname(importer), specifier)
      : null;
  if (base === null) return null;
  // TypeScript source is imported without its extension, so resolve `.ts` and `.tsx`
  // explicitly. Without this the walk records every relative specifier as unresolvable and
  // the gate's `unresolved` assertion becomes noise rather than a signal.
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const candidate of ['index.ts', 'index.tsx']) {
      if (existsSync(join(base, candidate))) return join(base, candidate);
    }
  }
  return base;
}

/**
 * The executable code of a source file, with comments removed.
 *
 * The gate scans for forbidden *constructs*, and a module header in this repository quotes the
 * very defects it fixes - `86_400_000`, `window.`, `console.log` all appear in prose. Reading
 * the prose as a violation would make the gate unfixable, and deleting the prose would lose
 * the argument for the fix, so the scan reads only code.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    // A string literal can hold any of these characters; blank them so the scan cannot be
    // satisfied or defeated by prose inside a string. Template literals are blanked wholesale.
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Every module reachable from an entry, as repo-relative POSIX paths.
 *
 * A module that resolves to nothing is recorded as `unresolved:<specifier>` rather than
 * dropped, so a broken resolver is visible instead of producing a small closure that makes
 * every walk above vacuously pass.
 */
function closureOf(entry: string): { files: string[]; unresolved: string[] } {
  const files: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file) || !statSync(file).isFile()) {
      unresolved.push(file);
      continue;
    }
    files.push(file);
    for (const specifier of readSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(specifier, file);
      if (target === null) continue;
      if (!existsSync(target)) {
        unresolved.push(target);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, unresolved };
}

function rel(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

/** Type-only imports carry no runtime edge, so they cannot reach a renderer. */
function runtimeSpecifiers(source: string): string[] {
  const withoutTypeOnly = source
    // `import type { X } from '...'` and `import { type X } from '...'` cannot reach a value.
    .replace(/import\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/export\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/import\s*\{[^}]*\btype\s+[^}]*\}\s*from\s*['"][^'"]+['"]/g, '');
  return readSpecifiers(withoutTypeOnly);
}

function runtimeClosureOf(entry: string): { files: string[]; unresolved: string[] } {
  const files: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file) || !statSync(file).isFile()) {
      unresolved.push(file);
      continue;
    }
    files.push(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(specifier, file);
      if (target === null) continue;
      if (!existsSync(target)) {
        unresolved.push(target);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, unresolved };
}

describe('src/core/statistics is renderer-, store-, and DOM-free', () => {
  const entries = readdirSync(join(SRC, 'core', 'statistics'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join('src', 'core', 'statistics', name));

  it('has the modules the phase expects, so the walk cannot pass on an empty directory', () => {
    expect(entries.map((entry) => entry.split('/').pop()).sort()).toEqual([
      'activitySink.ts',
      'index.ts',
      'localCalendar.ts',
      'statisticsEvents.ts',
      'statisticsMetrics.ts',
    ]);
  });

  for (const entry of entries) {
    it(`${entry} reaches no renderer, store, service, application, or UI module at run time`, () => {
      // The **runtime** closure, not the type closure. `lootSystem.ts` - reached through
      // `canonicalProgression` - has a pre-existing `import type { LootItem } from
      // '@/store/progressionStore'`, which a type-only import erases at build time. A type-only
      // edge cannot render anything, cannot write anything, and cannot be reached by a
      // learner, so the boundary being asserted is a runtime one and the walk says so rather
      // than reporting a pre-existing type import as a violation of this phase.
      const { files, unresolved } = runtimeClosureOf(entry);
      expect(unresolved, `${entry} has an unresolvable import`).toEqual([]);
      const offenders = files
        .map(rel)
        .filter((path) => CORE_FORBIDDEN.some((prefix) => path.startsWith(prefix)));
      expect(offenders, `${entry} reaches outside src/core/ at run time`).toEqual([]);
    });

    it(`${entry} has no renderer in its TYPE closure either`, () => {
      // The narrower rule stated for every renderer in this repository: no *renderer* edge of
      // any kind, type-only included. Stores and services are excluded from this one, because
      // the pre-existing type-only store import above is out of this phase's boundary.
      const { files } = closureOf(entry);
      const offenders = files
        .map(rel)
        .filter((path) => path.startsWith('src/renderers/') || path.startsWith('src/game/'));
      expect(offenders, `${entry} has a renderer in its type closure`).toEqual([]);
    });

    it(`${entry} uses no DOM global`, () => {
      // The runtime closure: a type-only reach cannot execute a DOM call, and the pre-existing
      // type-only store import that `canonicalProgression` carries must not make this scan
      // report `localStorage.setItem` from a store it cannot call at run time.
      for (const file of runtimeClosureOf(entry).files) {
        const source = codeOnly(readFileSync(file, 'utf8'));
        for (const api of DOM_APIS) {
          expect(api.test(source), `${rel(file)} matches ${String(api)}`).toBe(false);
        }
      }
    });

    it(`${entry} performs no network call`, () => {
      for (const file of runtimeClosureOf(entry).files) {
        const source = codeOnly(readFileSync(file, 'utf8'));
        for (const pattern of NETWORK_CALLS) {
          expect(pattern.test(source), `${rel(file)} matches ${String(pattern)}`).toBe(false);
        }
      }
    });
  }

  it('the calendar module uses no millisecond-day constant anywhere', () => {
    // The structural gate behind the DST behaviour: `addLocalDays` steps by calendar
    // construction, so the file cannot contain a one-day-in-milliseconds literal for a reader
    // or a future edit to reintroduce one.
    // `codeOnly` matters here: the module header explains the defect by naming the constant,
    // and reading that prose as a violation would make the gate unfixable.
    const source = codeOnly(readFileSync(join(SRC, 'core', 'statistics', 'localCalendar.ts'), 'utf8'));
    expect(source.includes('86_400_000')).toBe(false);
    expect(source.includes('86400000')).toBe(false);
    expect(source.includes('864e5')).toBe(false);
  });

  it('the metrics module computes a day difference without a millisecond day', () => {
    const source = codeOnly(readFileSync(join(SRC, 'core', 'statistics', 'statisticsMetrics.ts'), 'utf8'));
    expect(source.includes('86_400_000')).toBe(false);
    expect(source.includes('86400000')).toBe(false);
  });

  it('the session tracker keeps no millisecond-day arithmetic for a day key or a streak', () => {
    // The two defects the reader inherited: a UTC day key and an 86_400_000 ms streak walk.
    const source = codeOnly(readFileSync(join(SRC, 'services', 'sessionTracker.ts'), 'utf8'));
    expect(source.includes('toISOString().slice(0, 10)')).toBe(false);
    expect(source.includes('86400000')).toBe(false);
    expect(source.includes('86_400_000')).toBe(false);
  });
});

describe('the session lifecycle is renderer- and store-free', () => {
  const entry = 'src/application/sessionLifecycle.ts';

  it('reaches no renderer, store, service, or UI module', () => {
    const { files, unresolved } = runtimeClosureOf(entry);
    expect(unresolved).toEqual([]);
    const offenders = files
      .map(rel)
      .filter((path) =>
        ['src/renderers/', 'src/game/', 'src/store/', 'src/services/', 'src/ui/'].some(
          (prefix) => path.startsWith(prefix),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('reaches nothing at run time but itself: the statistics contract is a type-only import', () => {
    // The strongest form of the claim: the lifecycle has **no** runtime edge at all, so it
    // cannot be dragged into a dependency it did not choose, and importing it costs the
    // consumer nothing.
    const { files, unresolved } = runtimeClosureOf(entry);
    expect(unresolved).toEqual([]);
    expect(files.map(rel)).toEqual(['src/application/sessionLifecycle.ts']);
  });

  it('imports the statistics contract with `import type`, so it costs no runtime edge', () => {
    const source = readFileSync(resolve(REPO_ROOT, entry), 'utf8');
    const statisticsImports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s*'([^']+)'/g)]
      .filter((match) => match[3].startsWith('@/'));
    expect(statisticsImports.length).toBeGreaterThan(0);
    for (const match of statisticsImports) {
      expect(match[3], 'a value import of a core contract would create a runtime edge').toBe(
        '@/core/statistics/activitySink',
      );
      // `type` prefix, so the import is erased at build time.
      expect(match[1], 'the statistics contract must be imported type-only').toBe('type ');
    }
    expect(source).toContain('StatisticsActivity');
    expect(source).toContain('SubjectActivationEvent');
  });

  it('performs no network call and uses no DOM global', () => {
    const source = codeOnly(readFileSync(resolve(REPO_ROOT, entry), 'utf8'));
    for (const pattern of NETWORK_CALLS) expect(pattern.test(source)).toBe(false);
    for (const api of DOM_APIS) expect(api.test(source), String(api)).toBe(false);
    expect(source).not.toContain('addEventListener');
  });
});

describe('the statistics store and the lifecycle binding stay in the store layer', () => {
  it('neither reaches a renderer', () => {
    for (const entry of ['src/store/statisticsStore.ts', 'src/store/sessionLifecycleBinding.ts']) {
      const { files, unresolved } = runtimeClosureOf(entry);
      expect(unresolved, entry).toEqual([]);
      const offenders = files
        .map(rel)
        .filter((path) => path.startsWith('src/renderers/') || path.startsWith('src/game/'));
      expect(offenders, entry).toEqual([]);
    }
  });

  it('the binding wires the DOM listeners, and only the binding does', () => {
    const source = readFileSync(join(SRC, 'store', 'sessionLifecycleBinding.ts'), 'utf8');
    expect(source).toContain("addEventListener('pagehide'");
    expect(source).toContain("addEventListener('visibilitychange'");
    // The lifecycle module itself must stay DOM-free, which is what makes it testable.
    expect(codeOnly(readFileSync(join(SRC, 'application', 'sessionLifecycle.ts'), 'utf8'))).not.toContain(
      'addEventListener',
    );
  });
});

describe('the domain boundary walk can actually fail', () => {
  it('catches a planted renderer import in src/core/statistics', () => {
    // The positive control. Without it, a walk that resolved nothing would pass every
    // assertion above and this file would be a vacuous gate.
    // The detector is exercised on the specifier form itself, so nothing is written to `src/`
    // and no cross-suite planting can collide with the privacy gate's own probe directories.
    const rendererSpecifier = '@/game/scenes/DungeonScene';
    const resolvedRenderer = resolveSpecifier(rendererSpecifier, join(SRC, 'core', 'statistics', 'probe.ts'));
    expect(resolvedRenderer).not.toBeNull();
    expect(rel(resolvedRenderer as string).startsWith('src/game/')).toBe(true);
    // And the same detector on a renderer-free specifier resolves to something under core/.
    const coreSpecifier = './localCalendar';
    const resolvedCore = resolveSpecifier(coreSpecifier, join(SRC, 'core', 'statistics', 'probe.ts'));
    expect(rel(resolvedCore as string)).toBe('src/core/statistics/localCalendar.ts');
    expect(rel(resolvedCore as string).startsWith('src/game/')).toBe(false);
    // And the runtime-specifier reader does see a value import of the renderer.
    expect(runtimeSpecifiers("import { x } from '@/game/scenes/DungeonScene';")).toEqual([rendererSpecifier]);
    // ...and not a type-only one, which is the distinction the boundary rests on.
    expect(runtimeSpecifiers("import type { x } from '@/game/scenes/DungeonScene';")).toEqual([]);
  });

  it('the renderer modules the walks forbid do exist, so the forbidden list is not vacuous', () => {
    for (const forbidden of FORBIDDEN_PREFIXES) {
      const matches =
        forbidden.endsWith('/') &&
        !existsSync(join(REPO_ROOT, forbidden)) === false &&
        existsSync(join(REPO_ROOT, forbidden));
      if (forbidden.endsWith('/')) {
        expect(matches, forbidden).toBe(true);
      }
    }
    expect(existsSync(join(SRC, 'renderers'))).toBe(true);
    expect(existsSync(join(SRC, 'game'))).toBe(true);
    expect(existsSync(join(SRC, 'renderers', 'pixi'))).toBe(true);
  });

  it('resolves every specifier the statistics modules name', () => {
    for (const name of readdirSync(join(SRC, 'core', 'statistics'))) {
      if (!name.endsWith('.ts')) continue;
      const file = join(SRC, 'core', 'statistics', name);
      for (const specifier of readSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolveSpecifier(specifier, file);
        if (target === null) continue;
        expect(existsSync(target), `${name} names ${specifier}`).toBe(true);
      }
    }
  });
});

describe('no statistics record is written to a URL, a filename, or a log line', () => {
  it('no statistics module mentions a query parameter or a filename for a subject', () => {
    for (const name of readdirSync(join(SRC, 'core', 'statistics'))) {
      if (!name.endsWith('.ts')) continue;
      const source = codeOnly(readFileSync(join(SRC, 'core', 'statistics', name), 'utf8'));
      // Plan working rule 6. A subject name, a room topic, or a note must never reach a URL.
      for (const forbidden of ['searchParams', 'URLSearchParams', 'encodeURIComponent', 'console.log', 'console.warn', 'console.error', 'localStorage.setItem']) {
        expect(source.includes(forbidden), `${name} uses ${forbidden}`).toBe(false);
      }
    }
  });

  it('the lifecycle writes no learner content beyond a subject display name it was given', () => {
    const source = codeOnly(readFileSync(join(SRC, 'application', 'sessionLifecycle.ts'), 'utf8'));
    expect(source).not.toContain('console.');
    expect(source).not.toContain('JSON.stringify');
    expect(source).not.toContain('localStorage');
  });
});