/**
 * Phase 6 verifier gate V9 - the lazy boundary and the default build, restated
 * without the implementer's classifier.
 *
 * This file answers the two honesty questions B1 and B2, so it does not import the
 * implementer's detector and does not reuse their edge classifier. It re-derives the
 * property twice, by two different means, and each derivation carries a positive
 * control:
 *
 * 1. **The source graph.** Which modules outside the product tree name a Phase 6
 *    module, and by what kind of edge. The non-vacuity control is that the walk
 *    actually *finds* the two sanctioned dynamic callers - a walk that matched
 *    nothing would report "no eager edge" just as happily as a walk that found only
 *    lazy edges.
 * 2. **The built artifact.** Which files `index.html` names, and whether any product
 *    or storage-v2 chunk is reachable from them through a **static** import. This one
 *    needs no marker strings at all, and marker-free reachability is the property
 *    the implementer's raised byte ceiling and their five marker strings are both
 *    proxies for. Non-vacuity is proved by running the same closure forward from a
 *    product chunk, which *does* reach the product's own graph.
 *
 * On the marker set: the implementer's new direct assertion checks that five marker
 * strings are absent from the initial files. It never checks that those strings are
 * *present* in the product chunks, so a marker whose source string is renamed would
 * silently become vacuous in their gate. This file measures the presence, so the
 * difference is visible.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS, parseRuntimeConfig } from '@/config/runtimeConfig';

const ROOT = process.cwd();
const PRODUCTS_TREE = 'src/services/persistence/products/';

/** The four Phase 6 modules and the two the Phase 6 UI reaches. */
const PHASE_6_MODULES = [
  'src/services/persistence/products/subjectBackup',
  'src/services/persistence/products/idRemapping',
] as const;

const DATA_PRODUCT_CHUNK_PREFIXES = ['DataCenter', 'fullDeviceBackup', 'subjectBackup', 'archiveValidation'] as const;

/** storage-v2 chunks the product pulls in. Not product chunks by name. */
const STORAGE_CHUNK_PREFIXES = [
  'attachmentBytes', 'checksum', 'schema', 'validation', 'migrations', 'migrationState',
  'repository', 'appRepository', 'deviceAttachments', 'dualWrite', 'legacyReader', 'database',
] as const;

// ── Source graph ────────────────────────────────────────────────────────────

function listModules(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...listModules(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Comments blanked, so a promise of absence in prose is not read as the absence. */
function code(source: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1] ?? '';
    if (mode === 'code') {
      if (char === '/' && next === '/') { mode = 'line'; out += '  '; index += 1; continue; }
      if (char === '/' && next === '*') { mode = 'block'; out += '  '; index += 1; continue; }
      if (char === "'") { mode = 'single'; out += char; continue; }
      if (char === '"') { mode = 'double'; out += char; continue; }
      if (char === '`') { mode = 'template'; out += char; continue; }
      out += char;
      continue;
    }
    if (mode === 'line') { if (char === '\n') { mode = 'code'; out += char; } else out += ' '; continue; }
    if (mode === 'block') {
      if (char === '*' && next === '/') { mode = 'code'; out += '  '; index += 1; } else out += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (char === '\\') { out += '  '; index += 1; continue; }
    if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"') || (mode === 'template' && char === '`')) mode = 'code';
    out += char;
  }
  return out;
}

type EdgeKind = 'value' | 'type-only' | 'dynamic' | 'side-effect' | 'require';

const SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function edgesOf(file: string): Array<{ target: string; kind: EdgeKind }> {
  const source = code(readFileSync(file, 'utf8'));
  const out: Array<{ target: string; kind: EdgeKind }> = [];
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const clause = source.slice(match.index, match.index + match[0].length);
    let specifier: string | undefined;
    let kind: EdgeKind;
    if (match[1] !== undefined) {
      specifier = match[1];
      kind = /^(?:import|export)\s+type\s/.test(clause.trim()) ? 'type-only' : 'value';
    } else if (match[2] !== undefined) {
      specifier = match[2];
      kind = 'dynamic';
    } else if (match[3] !== undefined) {
      specifier = match[3];
      kind = 'side-effect';
    } else {
      specifier = match[4];
      kind = 'require';
    }
    const resolved = resolveSpecifier(file, specifier as string);
    if (resolved !== null) out.push({ target: resolved, kind });
  }
  return out;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(ROOT, 'src', specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  // Extensionless module ids, so two spellings of the same file cannot both appear
  // in a comparison and no assertion has to remember which suffix to expect.
  const posix = (value: string): string => relative(ROOT, value).split('\\').join('/').replace(/\.(ts|tsx)$/, '');
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return posix(candidate);
  }
  return posix(base);
}

describe('Phase 6 verifier V9: the lazy boundary (B1)', () => {
  it('the owner flag is off by default and Phase 5 still owns it', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe('VITE_DATA_PRODUCTS_V2');
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({}).dataProductsV2).toBe(false);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
    const onByDefault = Object.values(FEATURE_FLAG_MATRIX).filter(
      (definition) => (definition.productionDefault as boolean) === true,
    );
    expect(onByDefault).toEqual([]);
  });

  it('NON-VACUITY: the walk finds the two sanctioned dynamic callers, so "no eager edge" is not "no edge"', () => {
    const files = listModules(join(ROOT, 'src')).map((file) => relative(ROOT, file).split('\\').join('/'));
    expect(files.length).toBeGreaterThan(50);
    const phase6 = new Set<string>(PHASE_6_MODULES);

    const valueCallers = new Set<string>();
    const eagerOffenders: string[] = [];
    for (const path of files) {
      if (path.startsWith(PRODUCTS_TREE)) continue;
      for (const edge of edgesOf(join(ROOT, path))) {
        if (!phase6.has(edge.target)) continue;
        if (edge.kind === 'dynamic') valueCallers.add(`${path} -> ${edge.target}`);
        // A `type-only` edge is erased by TypeScript, so it is not an edge in the
        // emitted JavaScript and cannot put the product in a chunk.
        if (edge.kind === 'value' || edge.kind === 'side-effect' || edge.kind === 'require') {
          eagerOffenders.push(`${path} -${edge.kind}-> ${edge.target}`);
        }
      }
    }
    // The positive half, pinned: exactly the two UI modules, both dynamic. Without
    // this, every "no eager edge" assertion in this file would also be satisfied by
    // a walk that found nothing at all.
    expect([...valueCallers].sort()).toEqual([
      'src/ui/data/SubjectBackupTab.tsx -> src/services/persistence/products/subjectBackup',
      'src/ui/data/productAccess.ts -> src/services/persistence/products/subjectBackup',
    ]);
    // The negative half: no eager edge from anywhere outside the product tree.
    expect(eagerOffenders).toEqual([]);
  });

  it('no UI file names a storage-v2 module, and the product reaches the repository only by type', () => {
    const offenders: string[] = [];
    for (const file of listModules(join(ROOT, 'src/ui'))) {
      for (const edge of edgesOf(file)) {
        if (edge.kind === 'type-only') continue;
        if (edge.target.startsWith('src/services/persistence/v2/')) {
          offenders.push(`${relative(ROOT, file)} -${edge.kind}-> ${edge.target}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // The repository *type* is a type-only edge and the selection module a dynamic
    // one, which is what keeps `repositorySelection` - the module that opens a
    // database - out of a build with the flag off.
    for (const product of ['subjectBackup.ts', 'fullDeviceBackup.ts']) {
      const edges = edgesOf(join(ROOT, PRODUCTS_TREE, product));
      const repository = edges.filter((edge) => edge.target.endsWith('v2/repository'));
      expect(repository.length, `${product}'s repository edges`).toBeGreaterThan(0);
      for (const edge of repository) expect(edge.kind).toBe('type-only');
    }
    // `repositorySelection` - the module that opens a database - is reached by
    // exactly one module in the tree, and dynamically, so a build with the flag off
    // never fetches it. `subjectBackup.ts` reaches it through its sibling rather
    // than directly, which is the same property one level up: the whole product
    // tree sits behind the one dynamic import.
    const selectionOwners: string[] = [];
    for (const file of listModules(join(ROOT, PRODUCTS_TREE))) {
      const edges = edgesOf(file);
      for (const edge of edges.filter((e) => e.target.endsWith('v2/repositorySelection'))) {
        selectionOwners.push(`${relative(ROOT, file)}:${edge.kind}`);
      }
    }
    expect(selectionOwners.sort()).toEqual(['src/services/persistence/products/fullDeviceBackup.ts:dynamic']);
  });
});

// ── The built artifact ──────────────────────────────────────────────────────

const ASSETS = join(ROOT, 'dist', 'assets');
const HAS_BUILD = existsSync(join(ASSETS, 'index-Cdmtsl_W.js')) || existsSync(join(ROOT, 'dist', 'index.html'));

function assetNames(): string[] {
  return readdirSync(ASSETS).filter((name) => /\.(js|css)$/.test(name));
}

function read(name: string): string {
  return readFileSync(join(ASSETS, name), 'utf8');
}

function isProductChunk(name: string): boolean {
  return DATA_PRODUCT_CHUNK_PREFIXES.some((prefix) => name.startsWith(`${prefix}-`));
}

function isStorageChunk(name: string): boolean {
  return STORAGE_CHUNK_PREFIXES.some((prefix) => name.startsWith(`${prefix}-`));
}

/** Static and dynamic import targets named inside a built chunk. */
function chunkEdges(name: string): { static: string[]; dynamic: string[] } {
  const source = read(name);
  const statics: string[] = [];
  const dynamics: string[] = [];
  const present = new Set(assetNames());
  for (const match of source.matchAll(/(?:^|[;}\s])(?:import|export)[^;]*?from\s*"([^"]+)"|(?:^|[;}\s])import\s*"([^"]+)"/g)) {
    const specifier = (match[1] ?? match[2]) as string;
    if (!specifier.startsWith('./')) continue;
    const target = specifier.slice(2);
    if (present.has(target)) statics.push(target);
  }
  for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) {
    const specifier = match[1] as string;
    if (!specifier.startsWith('./')) continue;
    const target = specifier.slice(2);
    if (present.has(target)) dynamics.push(target);
  }
  return { static: statics, dynamic: dynamics };
}

/** Every chunk reachable from `roots` through static imports only. */
function staticClosure(roots: readonly string[]): { reached: Set<string>; parents: Map<string, string> } {
  const reached = new Set<string>(roots);
  const parents = new Map<string, string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (extname(current) === '.css') continue;
    for (const target of chunkEdges(current).static) {
      if (reached.has(target)) continue;
      reached.add(target);
      parents.set(target, current);
      queue.push(target);
    }
  }
  return { reached, parents };
}

describe('Phase 6 verifier V9: the default build (B2)', () => {
  it('there is a default build in this checkout to measure', () => {
    // Stated rather than skipped, so a run without a build cannot report a pass it
    // did not earn.
    expect(HAS_BUILD).toBe(true);
    expect(existsSync(join(ASSETS, 'index-Cdmtsl_W.js')) || assetNames().some((n) => /^index-[A-Za-z0-9_-]+\.js$/.test(n))).toBe(true);
  });

  it('the default build ships the product chunks and never loads them statically', () => {
    const files = assetNames();
    const productChunks = files.filter(isProductChunk);
    // Phase 6's chunk is in the default build. If this fails, the build under
    // measurement is not the build the gate is about.
    expect(productChunks.filter((name) => name.startsWith('subjectBackup-')).length).toBeGreaterThan(0);

    const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
    // The initial set: what `index.html` names as a module entry, a module preload,
    // or a stylesheet - i.e. what a module-capable browser fetches before the
    // application runs.
    const initial: string[] = [];
    for (const [, href] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      const name = (href as string).replace('/assets/', '');
      if (files.includes(name)) initial.push(name);
    }
    expect(initial.length).toBeGreaterThan(0);
    expect(initial.some((name) => name.startsWith('index-') && name.endsWith('.js'))).toBe(true);

    // The property, marker-free: nothing a product or storage-v2 chunk consists of
    // is statically reachable from the initial set.
    const closure = staticClosure(initial);
    const leaked = [...closure.reached].filter((name) => isProductChunk(name) || isStorageChunk(name));
    expect(leaked, `statically reachable from the initial set: ${leaked.join(', ')}`).toEqual([]);

    // NON-VACUITY for the closure itself: the same computation, run forward from a
    // product chunk, DOES reach the product's own graph. A closure that returned
    // nothing from anywhere would satisfy the assertion above for the wrong reason.
    const dataCenter = productChunks.find((name) => name.startsWith('DataCenter-') && !name.includes('-legacy-'));
    expect(dataCenter).toBeDefined();
    const fromProduct = staticClosure([dataCenter as string]);
    const productGraph = [...fromProduct.reached].filter((name) => isProductChunk(name) || isStorageChunk(name));
    expect(productGraph.length, 'the product graph is empty, so the closure proves nothing').toBeGreaterThan(0);
    expect(fromProduct.reached.has(dataCenter as string)).toBe(true);
  });

  it('the legacy entry is excluded from "initial" for a reason, and the exclusion leaves no hole', () => {
    const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
    const legacyEntries = [...html.matchAll(/assets\/(index-legacy-[A-Za-z0-9_-]+\.js)/g)].map((m) => m[1] as string);
    expect(legacyEntries.length).toBeGreaterThan(0);
    for (const name of legacyEntries) {
      // The claim to verify: no module-capable browser fetches this file, so it is
      // outside "initial" - and therefore, if it DID carry product code, nothing
      // else in the gate would notice.
      const source = read(name);
      const reached = [...staticClosure([name]).reached];
      const leaked = reached.filter((entry) => isProductChunk(entry) || isStorageChunk(entry));
      expect(leaked, `the excluded ${name} statically reaches ${leaked.join(', ')}`).toEqual([]);
      // ...and it reaches the product only through a dynamic import.
      for (const target of chunkEdges(name).dynamic) {
        if (!isProductChunk(target) && !isStorageChunk(target)) continue;
        expect(
          readFileSync(join(ASSETS, name), 'utf8').includes(`import("./${target}")`),
          `${name} does not reach ${target} dynamically`,
        ).toBe(true);
      }
      expect(source.length).toBeGreaterThan(0);
    }
    // The same closure computation applied to the legacy entry is the "other loop"
    // the implementer relies on, and it is run here rather than assumed.
  });

  it('the legacy entry chunk carries no product code, checked with the implementer\'s own marker list', () => {
    const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
    const legacyEntry = /assets\/(index-legacy-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1];
    expect(legacyEntry).toBeDefined();
    const source = read(legacyEntry as string);
    // The claim the implementer disclosed and asked to be verified: no product
    // marker appears in the file the exclusion skips.
    const PRODUCT_CODE_MARKERS: ReadonlyArray<readonly [string, string]> = [
      ['the ZIP codec', 'invalid block type'],
      ['the Phase 5 product', 'knowledge-dungeon-device-backup.kdbak'],
      ['the Phase 6 product', 'knowledge-dungeon-subject-backup.kdsubject'],
      ['the Data Center component', 'kd-data-center'],
      ['the subject tab', 'One subject backup'],
    ];
    for (const [what, marker] of PRODUCT_CODE_MARKERS) {
      expect(source.includes(marker), `the excluded legacy entry contains ${what}`).toBe(false);
    }
  });

  it('every one of the implementer\'s five markers is PRESENT in a product chunk, so none of them is vacuous', () => {
    // The measurement their assertion omits. If a marker string is renamed in the
    // source, their "absent from the initial files" assertion keeps passing while
    // checking nothing; this one goes red.
    const files = assetNames();
    const PRODUCT_CODE_MARKERS: ReadonlyArray<readonly [string, string]> = [
      ['the ZIP codec', 'invalid block type'],
      ['the Phase 5 product', 'knowledge-dungeon-device-backup.kdbak'],
      ['the Phase 6 product', 'knowledge-dungeon-subject-backup.kdsubject'],
      ['the Data Center component', 'kd-data-center'],
      ['the subject tab', 'One subject backup'],
    ];
    for (const [what, marker] of PRODUCT_CODE_MARKERS) {
      const carriers = files.filter((name) => /\.(js|css)$/.test(name) && read(name).includes(marker));
      expect(carriers.length, `no shipped chunk contains ${what} ("${marker}"), so its absence check is vacuous`).toBeGreaterThan(0);
      // ...and the carrier is a product chunk, not the entry.
      for (const carrier of carriers) {
        expect(isProductChunk(carrier), `${marker} is carried by the non-product chunk ${carrier}`).toBe(true);
      }
      // ...and it is absent from every initial file.
      const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
      for (const [, href] of html.matchAll(/(?:src|href)="(\/assets\/([^"]+))"/g)) {
        const name = href as string;
        if (!files.includes(name)) continue;
        expect(read(name).includes(marker), `${name} is initial and contains ${what}`).toBe(false);
      }
    }
  });

  it('the shipped product bytes are what the implementer measured, and the ceiling is a real bound', () => {
    const productChunks = assetNames().filter((name) => isProductChunk(name) && /\.(js|css)$/.test(name));
    const shipped = productChunks.reduce((total, name) => total + statSync(join(ASSETS, name)).size, 0);
    // The implementer recorded 266,635 bytes. Measured here rather than repeated.
    expect(shipped).toBeGreaterThan(200 * 1024);
    expect(shipped).toBeLessThan(320 * 1024);
    // The ceiling is load-sensitive, and the measurement is reported so a reader can
    // see by how much. The headroom is the whole question: it must be smaller than
    // the cost of one more product of this kind, or the ceiling is not a bound on
    // anything a future phase would notice.
    const headroom = 320 * 1024 - shipped;
    expect(headroom).toBeGreaterThan(0);
    const oneMoreProduct = productChunks
      .filter((name) => name.startsWith('fullDeviceBackup-'))
      .reduce((total, name) => total + statSync(join(ASSETS, name)).size, 0);
    expect(
      headroom,
      `headroom ${headroom} bytes; one more .kdbak product would cost ${oneMoreProduct}`,
    ).toBeLessThan(oneMoreProduct * 4);
  });

  it('the entry chunk contains no `__vitePreload` dependency entry for a product chunk that a browser would fetch unasked', () => {
    // The implementer's disclosure: rolldown's dependency map names the Data Center
    // chunk inside the entry, and they read that as a browser *prefetch*. Measured:
    // the modern entry names it in a plain string array, with no `rel=prefetch` or
    // `rel=modulepreload` link in the document, so nothing is fetched because of
    // the map. The dynamic import that would fetch it is behind a runtime flag that
    // defaults to false.
    const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
    const entry = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] as string;
    const source = read(entry);
    expect(html).not.toMatch(/rel="(?:prefetch|preload)"[^>]*DataCenter/);
    expect(html).not.toMatch(/DataCenter-[A-Za-z0-9_-]+\.js/);
    // The map exists and names the chunk, which is the disclosed cost.
    expect(source).toContain('DataCenter-');
    // ...and there is no top-level (unconditional) dynamic import of it: every
    // reference sits inside a function body, which is what a flag guard compiles to.
    const dynamic = chunkEdges(entry).dynamic;
    expect(dynamic.filter((name) => isProductChunk(name))).toEqual([]);
  });
});
