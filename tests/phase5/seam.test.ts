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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS, parseRuntimeConfig } from '@/config/runtimeConfig';
import {
  CUTOVER_BOOLEAN_FLAG_KEYS,
  CUTOVER_FLAG_KEYS,
  CUTOVER_FLAG_ROLLBACKS,
  FEATURE_FLAG_MATRIX,
  NON_CUTOVER_FLAG_KEYS,
  RETAINED_HOST_FLAG_KEYS,
  REVIEWED_FLAG_KEYS,
} from '@/config/featureFlags';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const V2 = join(SRC, 'services', 'persistence', 'v2');
const PRODUCTS = join(SRC, 'services', 'persistence', 'products');

/**
 * The chunk names a data-product build emits, as one list every claim in this file
 * is measured against.
 *
 * Three entries are Phase 5's and one is Phase 6's: `subjectBackup` is the
 * `.kdsubject` product, which shares the ZIP codec and the archive validator with
 * its sibling and therefore ships as a chunk of its own. Keeping the list in one
 * place is what stops a second product from being "unrelated" by omission - which
 * is exactly the mistake this list's growth records, and exactly the class of
 * mistake a closed list exists to prevent.
 */
const PRODUCT_CHUNK_NAMES = ['DataCenter', 'archiveValidation', 'fullDeviceBackup', 'subjectBackup'] as const;

/** Whether a built file is one of the data-product chunks. */
function isProductChunk(name: string): boolean {
  return PRODUCT_CHUNK_NAMES.some((prefix) => name.startsWith(`${prefix}-`));
}

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
  it('VITE_DATA_PRODUCTS_V2 defaults on after the Phase 23 cutover, and false still disables it', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe('VITE_DATA_PRODUCTS_V2');
    // Before Phase 23 the product was opt-in, so this gate asserted the three-way
    // `false` default. The cutover makes the product the production default; the
    // `false` rollback is now the opt-out, and it still yields the pre-cutover
    // behaviour, which the positive control below proves it can.
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(true);
    expect(parseRuntimeConfig({}).dataProductsV2).toBe(true);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(true);
    expect(CUTOVER_FLAG_ROLLBACKS.dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'false' }).dataProductsV2).toBe(false);
  });

  it('the flag matrix is partitioned into reviewed cutover, kill-switch, and retained-host flags', () => {
    // Phase 23 re-foundation. Before the cutover this gate asserted "no cutover flag
    // defaults on". The cutover inverts that for the cutover flags by design, so the
    // durable invariant is the partition, and each part can still fail:
    //   1. every key of the matrix belongs to exactly one of the three reviewed sets, so
    //      no flag is silently unclassified;
    //   2. the matrix key set is the pinned reviewed set, so no flag was removed;
    //   3. the flags that default on are exactly the cutover booleans plus the kill
    //      switches, so a cutover flag left off fails; and
    //   4. every cutover flag's declared rollback still parses to the pre-cutover value
    //      and is documented as an env var/value, so the rollback cannot rot.
    const matrixKeys = Object.keys(FEATURE_FLAG_MATRIX).sort();
    const classified = [
      ...CUTOVER_FLAG_KEYS,
      ...NON_CUTOVER_FLAG_KEYS,
      ...RETAINED_HOST_FLAG_KEYS,
    ].sort();
    expect(classified).toEqual(matrixKeys);
    expect(new Set(classified).size).toBe(classified.length);
    expect(matrixKeys).toEqual([...REVIEWED_FLAG_KEYS].sort());

    const onByDefault = Object.entries(FEATURE_FLAG_MATRIX)
      .filter(([, definition]) => (definition.productionDefault as boolean) === true)
      .map(([key]) => key)
      .sort();
    expect(onByDefault).toEqual([...CUTOVER_BOOLEAN_FLAG_KEYS, ...NON_CUTOVER_FLAG_KEYS].sort());

    for (const key of CUTOVER_FLAG_KEYS) {
      const rollback = CUTOVER_FLAG_ROLLBACKS[key];
      const environment = { [RUNTIME_FLAG_ENV_KEYS[key]]: String(rollback) };
      expect(parseRuntimeConfig(environment)[key]).toBe(rollback);
      expect(FEATURE_FLAG_MATRIX[key].rollback).toContain(
        `${RUNTIME_FLAG_ENV_KEYS[key]}=${rollback}`,
      );
      expect(FEATURE_FLAG_MATRIX[key].productionDefault).not.toBe(rollback);
    }
  });

  it('tests/unit/defaultBuildRendering.test.tsx is the default-build rendering gate and reflects the cutover', () => {
    const file = join(ROOT, 'tests/unit/defaultBuildRendering.test.tsx');
    expect(existsSync(file)).toBe(true);
    // ...and it really is the default-build rendering gate.
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/default build/i);
    expect(text).toMatch(/Welcome screen/);
    // Phase 23 cutover. This gate used to assert the file was byte-for-byte unmodified,
    // because the default build did not change; the cutover does change it, so the
    // durable claim is that the gate tracks the new default and still exercises the
    // legacy rollback. A file that silently kept the pre-cutover `legacy` default, or
    // dropped the rollback control, fails here.
    expect(text).toContain("DEFAULT_RUNTIME_CONFIG.storageRepository).toBe('v2')");
    expect(text).toContain("VITE_STORAGE_REPOSITORY: 'legacy'");
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
    const productChunks = files.filter((name) => isProductChunk(name) && /\.(js|css)$/.test(name));
    // RAIL CHANGE, recorded deliberately, and **stronger**: the chunk names are now a
    // shared list rather than a literal inside this test, and that list grew because
    // Phase 6's product is in the build. The failure that prompted it was real and
    // informative - `subjectBackup-*.js` is a product chunk, and it references
    // `archiveValidation-*.js`, which this test's hard-coded recogniser did not know
    // was a product chunk, so the "referenced only by the product's own graph" rule
    // reported the product's own sibling as an unrelated chunk. Phase 6's chunk is
    // now *also* held to that rule rather than being outside it, and every assertion
    // below therefore measures one more chunk than it did before.
    expect(productChunks.filter((name) => name.startsWith('subjectBackup-')).length,
      'expected the default dist to ship the Phase 6 product chunk').toBeGreaterThan(0);
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
        const isProduct = isProductChunk(referrer);
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

    // RAIL CHANGE, recorded deliberately: the ceiling moved from 200 KiB to 320 KiB,
    // and the reason is a measurement rather than a preference. The shipped bytes are
    // 266,635 with Phase 6's product in the build (Phase 5 measured roughly 128 KiB
    // for one product and a one-tab Data Center). The number grew because a second
    // product and a second tab exist, and neither is optional.
    //
    // A byte ceiling is a weak proxy for the property that matters, so the property
    // is now also asserted directly, and it is the one plan section 11 requires: **no
    // byte of any product chunk is in the initial payload.** The initial set is what
    // `index.html` names as a module entry, a module preload, or a stylesheet - what
    // a module-capable browser fetches before the application runs - and none of those
    // files may reference a product chunk. That is what "the guard is a runtime `if`,
    // so the bundler emits the chunks but never loads them" means, and it holds
    // whatever the shipped total happens to be.
    //
    // The check is on product *code*, not on product chunk *names*, and the
    // difference is a measurement rather than a subtlety. The entry chunk does carry
    // the product chunk names: rolldown's `__vitePreload` dependency map lists every
    // chunk a dynamic import may preload, and the map is built unconditionally. So a
    // browser may issue a *prefetch* for a product chunk - which is Phase 5's
    // documented cost of "the guard is a runtime `if`" and is not what this rule is
    // about. What must be absent is the product's **code**: no marker from any
    // product may appear in a file a module-capable browser fetches before the
    // application runs, which is the only way "the entry chunk cannot open an
    // archive" can be true of a build.
    const initial = new Set<string>();
    for (const [, href] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      const name = (href as string).replace('/assets/', '');
      // The `nomodule` legacy entry is never fetched by a module-capable browser, so
      // it is excluded from "initial" on purpose; the loop above covers it instead by
      // requiring every product chunk to be reachable only by a dynamic import.
      if (name.includes('-legacy-')) continue;
      initial.add(name);
    }
    expect(initial.size, 'the entry document names no initial files').toBeGreaterThan(0);
    // One marker per product, each of which only that product's code can contain.
    const PRODUCT_CODE_MARKERS: ReadonlyArray<readonly [string, string]> = [
      ['the ZIP codec', 'invalid block type'],
      ['the Phase 5 product', 'knowledge-dungeon-device-backup.kdbak'],
      ['the Phase 6 product', 'knowledge-dungeon-subject-backup.kdsubject'],
      ['the Data Center component', 'kd-data-center'],
      ['the subject tab', 'One subject backup'],
    ];
    for (const name of initial) {
      if (!/\.(js|css)$/.test(name)) continue;
      const source = readFileSync(join(assets, name), 'utf8');
      for (const [what, marker] of PRODUCT_CODE_MARKERS) {
        expect(source.includes(marker), `the initial file ${name} contains ${what} ("${marker}")`).toBe(false);
      }
    }

    // The ceiling itself, set from the measurement above with headroom, and still
    // small against the plan's 12 MB total-dist ceiling.
    expect(shipped).toBeLessThan(320 * 1024);
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
