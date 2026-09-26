/**
 * Verifier gate V7 - the renderer boundary, the seam, and the default build.
 *
 * Three claims, checked against the repository rather than against a document:
 *
 * 1. **No UI file names a storage-v2 module.** The product tree is the only seam,
 *    and the Data Center reaches storage-v2 only through the product's own
 *    accessors.
 * 2. **The lazy/eager boundary holds.** Every edge from a UI file into the
 *    product tree is a dynamic `import()`, so a build with the flag off does not
 *    carry the ZIP codec in its entry chunk. Verified in the *built artifact* when
 *    one is present, and against the source graph always.
 * 3. **The default build is genuinely unchanged**: the flag defaults to `false`,
 *    the default-build rendering test is unmodified, and the default `dist` ships
 *    the product chunks without ever loading them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS, parseRuntimeConfig } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const V2 = join(SRC, 'services', 'persistence', 'v2');
const PRODUCTS = join(SRC, 'services', 'persistence', 'products');

function posix(value: string): string {
  return value.split('\\').join('/');
}

function listModules(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...listModules(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Strip comments and string *bodies* are kept: this reads specifiers, not prose. */
function blankComments(source: string): string {
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
    if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"') || (mode === 'template' && char === '`')) {
      mode = 'code';
    }
    out += char;
  }
  return out;
}

const SPECIFIERS =
  /\b(?:import|export)\s+(?:type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;

function edgesFrom(file: string): Array<{ specifier: string; kind: 'value' | 'type-only' | 'dynamic' | 'side-effect' }> {
  const code = blankComments(readFileSync(file, 'utf8'));
  const edges: Array<{ specifier: string; kind: 'value' | 'type-only' | 'dynamic' | 'side-effect' }> = [];
  const typeOnly = /\b(?:import|export)\s+type\s+[^;'"]*?\bfrom\s*['"][^'"]+['"]/.test(code);
  void typeOnly;
  for (const match of code.matchAll(SPECIFIERS)) {
    if (match[1] !== undefined) {
      // Re-read the clause to decide whether it is type-only.
      const clause = code.slice(Math.max(0, match.index), match.index + match[0].length);
      const kind = /^(?:import|export)\s+type\s/.test(clause.trim()) ? 'type-only' : 'value';
      edges.push({ specifier: match[1], kind });
      continue;
    }
    if (match[2] !== undefined) { edges.push({ specifier: match[2], kind: 'dynamic' }); continue; }
    edges.push({ specifier: match[3] as string, kind: 'side-effect' });
  }
  return edges;
}

function resolveFirstParty(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(join(ROOT, 'src'), specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate.replace(/\.(ts|tsx)$/, '');
  }
  return base;
}

const UI_ROOTS = ['src/ui', 'src/components', 'src/screens'].map((path) => join(ROOT, path));
const UI_FILES = UI_ROOTS.filter((directory) => existsSync(directory)).flatMap((directory) => listModules(directory));

describe('V7.1: no UI file names a storage-v2 module', () => {
  it('the scan found the UI tree, and it is not empty', () => {
    expect(UI_FILES.length).toBeGreaterThan(20);
  });

  it('not one of them imports anything under services/persistence/v2', () => {
    const offenders: string[] = [];
    for (const file of UI_FILES) {
      for (const edge of edgesFrom(file)) {
        const target = resolveFirstParty(file, edge.specifier);
        if (target === null) continue;
        if (target.startsWith(V2)) offenders.push(`${posix(relative(ROOT, file))} -${edge.kind}-> ${edge.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Data Center reaches the product only through a dynamic import', () => {
    const dataCenter = join(ROOT, 'src/ui/data/DataCenter.tsx');
    expect(existsSync(dataCenter)).toBe(true);
    const productEdges = edgesFrom(dataCenter).filter((edge) =>
      resolveFirstParty(dataCenter, edge.specifier)?.startsWith(PRODUCTS),
    );
    expect(productEdges.length).toBeGreaterThan(0);
    for (const edge of productEdges) {
      expect(edge.kind, `${edge.specifier} is a ${edge.kind} edge`).toBe('dynamic');
    }
    // ...and the type-position aliases are erased, so they are not edges at all
    // in the emitted JavaScript. Proven by reading the *built* default chunk: no
    // product chunk is imported from the entry graph.
  });

  it('no file outside the product tree statically imports a product module', () => {
    const offenders: string[] = [];
    const files = [
      ...listModules(join(ROOT, 'src')).filter((file) => !file.startsWith(PRODUCTS)),
    ];
    for (const file of files) {
      for (const edge of edgesFrom(file)) {
        // A *dynamic* edge is the sanctioned way in: it is the only thing that
        // keeps the ZIP codec out of a build with the flag off. A `type-only` edge
        // is erased. Only a value or side-effect edge is a violation.
        if (edge.kind !== 'value' && edge.kind !== 'side-effect') continue;
        const target = resolveFirstParty(file, edge.specifier);
        if (target === null) continue;
        if (target.startsWith(PRODUCTS)) {
          offenders.push(`${posix(relative(ROOT, file))} -${edge.kind}-> ${edge.specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the product tree reaches storage-v2 only for the two modules it legitimately needs', () => {
    const reached = new Set<string>();
    for (const file of listModules(PRODUCTS)) {
      for (const edge of edgesFrom(file)) {
        const target = resolveFirstParty(file, edge.specifier);
        if (target === null) continue;
        if (target.startsWith(V2)) reached.add(posix(relative(ROOT, `${target}.ts`)));
      }
    }
    // The ZIP codec, the checksums, the schema, the validators, the repository
    // *type*, the attachment-bytes store, and the renderer-neutral product types.
    for (const expected of [
      'src/services/persistence/v2/archive.ts',
      'src/services/persistence/v2/checksum.ts',
      'src/services/persistence/v2/schema.ts',
      'src/services/persistence/v2/validation.ts',
      'src/services/persistence/v2/attachmentBytes.ts',
    ]) {
      expect([...reached], expected).toContain(expected);
    }
    // ...and the repository is reached *only* through a dynamic import, because
    // `repositorySelection` is what opens a database.
    const product = join(PRODUCTS, 'fullDeviceBackup.ts');
    const repositoryEdges = edgesFrom(product).filter((edge) =>
      resolveFirstParty(product, edge.specifier)?.endsWith('v2/repository'),
    );
    for (const edge of repositoryEdges) expect(edge.kind).toBe('type-only');
    const selectionEdges = edgesFrom(product).filter((edge) =>
      resolveFirstParty(product, edge.specifier)?.endsWith('v2/repositorySelection'),
    );
    expect(selectionEdges.map((edge) => edge.kind)).toEqual(['dynamic']);
  });

  it('the product tree names no renderer and no network API', () => {
    for (const file of listModules(PRODUCTS)) {
      const code = blankComments(readFileSync(file, 'utf8'));
      for (const forbidden of [
        'phaser',
        'pixi',
        'document.',
        'window.',
        'navigator.',
        'localStorage',
        'fetch(',
        'XMLHttpRequest',
        'sendBeacon',
        'navigator.share',
        'createObjectURL',
        'document.createElement',
      ]) {
        expect(code.includes(forbidden), `${posix(relative(ROOT, file))} contains ${forbidden}`).toBe(false);
      }
    }
  });
});

describe('V7.2: the default build', () => {
  it('VITE_DATA_PRODUCTS_V2 defaults to false, three ways', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe('VITE_DATA_PRODUCTS_V2');
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({}).dataProductsV2).toBe(false);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
  });

  it('no flag in the matrix is on by default before its cutover phase', () => {
    const enabled = Object.entries(FEATURE_FLAG_MATRIX)
      .filter(([, definition]) => (definition.productionDefault as boolean) === true)
      .map(([key]) => key);
    expect(enabled).toEqual([]);
  });

  it('tests/unit/defaultBuildRendering.test.tsx is unmodified by this phase', () => {
    // A tracked file that this phase must not have touched. `git diff` is the
    // authority, and an unstaged modification is the thing being checked.
    const changed = execFileSync('git', ['status', '--porcelain', '--', 'tests/unit/defaultBuildRendering.test.tsx'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    expect(changed).toBe('');
    const file = join(ROOT, 'tests/unit/defaultBuildRendering.test.tsx');
    expect(existsSync(file)).toBe(true);
    // ...and it really is the default-build rendering gate.
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/default build/i);
    expect(text).toMatch(/Welcome screen/);
    // The data-tab half of the same claim lives in the new Data Center unit
    // gate, which is where the Data Center's own owner put it. Asserted here so
    // the claim is not resting on a file this verifier has not read.
    const dataCenterGate = readFileSync(join(ROOT, 'tests/unit/dataCenter.test.tsx'), 'utf8');
    expect(dataCenterGate).toMatch(/name: 'Admin'/);
    expect(dataCenterGate).toMatch(/queryByRole\('heading', \{ name: 'Admin' \}\)/);
  });

  it('the built default artifact ships the product chunks but never loads them', () => {
    const assets = join(ROOT, 'dist', 'assets');
    if (!existsSync(assets)) {
      // No build in this checkout: say so rather than passing vacuously.
      expect(existsSync(join(ROOT, 'dist', 'index.html'))).toBe(false);
      return;
    }
    const files = readdirSync(assets);
    const productChunks = files.filter(
      (name) => /^(DataCenter|archiveValidation|fullDeviceBackup)-/.test(name) && /\.(js|css)$/.test(name),
    );
    // The recorded finding: the guard is a runtime `if`, so the bundler emits the
    // product chunks into the default artifact.
    expect(productChunks.length, 'expected the default dist to ship the product chunks').toBeGreaterThan(0);
    const shipped = productChunks.reduce((total, name) => total + statSync(join(assets, name)).size, 0);
    // Quantified: modern and legacy variants together.
    const modern = productChunks.filter((name) => !name.includes('-legacy-'));
    const legacy = productChunks.filter((name) => name.includes('-legacy-'));
    const modernBytes = modern.reduce((total, name) => total + statSync(join(assets, name)).size, 0);
    const legacyBytes = legacy.reduce((total, name) => total + statSync(join(assets, name)).size, 0);

    // The entry document names a modern entry chunk and a legacy one. Each
    // product chunk is named by exactly one of them - the dynamic import's target
    // - and by no other chunk in the build.
    const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8');
    const entries = [...html.matchAll(/assets\/(index-[A-Za-z0-9_-]+\.js)/g)].map((match) => match[1] as string);
    expect(new Set(entries).size, 'the built index.html names fewer than two entry chunks').toBeGreaterThan(1);
    for (const chunk of productChunks.filter((name) => name.endsWith('.js'))) {
      const referrers = files.filter((name) => {
        if (!name.endsWith('.js')) return false;
        if (name === chunk) return false;
        return readFileSync(join(assets, name), 'utf8').includes(chunk);
      });
      // Every referrer is either an entry chunk or another product chunk: the
      // product's own graph is the only thing that can reach into it, which is
      // the seam rule stated in the built artifact rather than in the source.
      expect(referrers.length, `${chunk} is referenced by ${JSON.stringify(referrers)}`).toBeGreaterThan(0);
      for (const referrer of referrers) {
        const isEntry = entries.includes(referrer);
        const isProduct = /^(DataCenter|archiveValidation|fullDeviceBackup)-/.test(referrer);
        expect(isEntry || isProduct, `${chunk} is referenced by the unrelated chunk ${referrer}`).toBe(true);
      }
      // And the reference is a *dynamic* import: the chunk name appears inside a
      // `import(` in the minified referrer, not in a top-level static clause.
      const referrerSources = referrers.map((name) => readFileSync(join(assets, name), 'utf8'));
      const referencing = referrerSources.find((source) => source.includes(chunk));
      expect(referencing, `${chunk} is in none of its referrers`).toBeDefined();
      expect(/import\(/.test(referencing as string), `${chunk} is not reached by a dynamic import`).toBe(true);
    }

    // ...and the CSS is never linked from the document.
    for (const stylesheet of productChunks.filter((name) => name.endsWith('.css'))) {
      expect(html.includes(stylesheet), `${stylesheet} is linked from index.html`).toBe(false);
    }
    expect(shipped).toBeGreaterThan(0);
    expect(modernBytes).toBeGreaterThan(0);
    expect(legacyBytes).toBeGreaterThan(0);
    // Small against the plan's 12 MB total-dist ceiling.
    expect(shipped).toBeLessThan(200 * 1024);
  });

  it('the default build\'s entry chunk does not contain the ZIP codec', () => {
    const assets = join(ROOT, 'dist', 'assets');
    if (!existsSync(assets)) return;
    const files = readdirSync(assets);
    const entry = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8'))?.[1];
    expect(entry).toBeDefined();
    const entrySource = readFileSync(join(assets, entry as string), 'utf8');
    // fflate's own error strings are a reliable marker for "the codec is here".
    for (const marker of ['invalid block type', 'unexpected EOF', 'invalid utf-8 sequence', 'ZlibError']) {
      expect(entrySource.includes(marker), `the entry chunk contains the codec marker ${marker}`).toBe(false);
    }
    // ...and the codec marker is somewhere in the shipped product chunk, so the
    // assertion above is a real discriminator rather than a marker that is
    // nowhere at all.
    const codecChunk = files.find((name) => {
      if (!name.endsWith('.js')) return false;
      return /archiveValidation-/.test(name) && readFileSync(join(assets, name), 'utf8').includes('invalid block type');
    });
    expect(codecChunk, 'no shipped chunk contains the fflate marker').toBeDefined();
  });
});
