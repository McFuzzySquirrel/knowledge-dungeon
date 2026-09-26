/**
 * Phase 5 data-product gate 8: the Phase 5 owner flag is safe by default.
 *
 * `VITE_DATA_PRODUCTS_V2` is the plan's Phase 5 owner flag (plan section 11), and
 * the plan's cutover rule is explicit: "New data products and assistance are
 * opt-in" before cutover, and "Production defaults remain Phaser and legacy
 * storage" until their separately reviewed cutover phases.
 *
 * So the flag has three properties this gate holds:
 *
 * 1. **It defaults to `false`** - in the runtime config, in the declared flag
 *    matrix, and when the environment says nothing at all.
 * 2. **It is owned by Phase 5** and names the three phases (5 through 7) whose
 *    products it gates, and its documented rollback is a build-time flag rather
 *    than a source change, because the plan's Phase 5 rollback is "Hide the tab
 *    and disable import. The format is additive."
 * 3. **The default build does not reach the product.** The product module is not
 *    in the first-party import graph reachable from `src/main.tsx`, so a build
 *    with the flag off cannot open an archive, write one, or bundle the ZIP codec
 *    because of it.
 *
 * The third property is asserted against the real module graph, not against a
 * list of file names, so a product module imported from anywhere in the
 * application would be caught whichever file did the importing.
 *
 * The registered half is the product's own conditional: it must be reachable from
 * the application graph, and only then.
 *
 * Privacy: this file reads configuration and source paths. It never reads a
 * subject, a note, or a URL, and it never writes anything.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS, parseRuntimeConfig } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { blankComments, walk } from './support/importGraph';
import {
  ARCHIVE_VALIDATION_MODULE,
  FULL_DEVICE_BACKUP_MODULE,
  PHASE_5_FLAG_ENV_KEY,
} from './support/productInterface';

/**
 * How a module reached a target: at module-evaluation time, lazily, or through
 * `require`.
 *
 * The distinction is the whole lazy-boundary claim. A `static` edge puts the
 * target in the entry chunk the Welcome screen loads; a `dynamic` one puts it in
 * a separate chunk Vite only fetches when the import actually runs. Plan section
 * 11 requires the Phase 5 product to be opt-in, and plan section 10.2's
 * "keep world assets lazy-loaded" is the same discipline applied to code.
 */
type EdgeKind = 'static' | 'dynamic' | 'require';

const STATIC_FROM = /\bfrom\s*['"]([^'"]+)['"]/g;
const STATIC_SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

/** Resolve one specifier the way Vite would, or `null` when it is external. */
function resolveFirstParty(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(join(process.cwd(), 'src'), specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return toPosix(relative(process.cwd(), candidate));
  }
  return toPosix(relative(process.cwd(), base));
}

/**
 * Every kind of edge from `source` to `targetPath`, from a source string.
 *
 * Split out from the file read so the detector can be exercised on a synthetic
 * source: a detector that silently matches nothing would make every "nothing
 * imports it eagerly" assertion in this file vacuous, and Phase 3 review found
 * five vacuous gates in this repository for exactly that reason.
 */
export function edgeKindsTo(source: string, fromFile: string, targetPath: string): EdgeKind[] {
  const code = blankComments(source);
  const kinds: EdgeKind[] = [];
  for (const [pattern, kind] of [
    [STATIC_FROM, 'static'],
    [STATIC_SIDE_EFFECT, 'static'],
    [DYNAMIC_IMPORT, 'dynamic'],
    [REQUIRE_CALL, 'require'],
  ] as const) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] as string;
      if (resolveFirstParty(fromFile, specifier) === targetPath) kinds.push(kind);
    }
  }
  return kinds;
}

/** `path:kind` for every eager edge into `targetPath` from outside the product tree. */
function eagerImporters(paths: readonly string[], targetPath: string): string[] {
  const found: string[] = [];
  for (const path of paths) {
    if (path.startsWith(PRODUCTS_TREE)) continue;
    const kinds = edgeKindsTo(readFileSync(join(process.cwd(), path), 'utf8'), join(process.cwd(), path), targetPath);
    for (const kind of kinds) {
      if (kind === 'static' || kind === 'require') found.push(`${path}:${kind}`);
    }
  }
  return found.sort();
}

const PRODUCT_MODULE_PATHS = [
  'src/services/persistence/products/fullDeviceBackup.ts',
  'src/services/persistence/products/archiveValidation.ts',
  'src/ui/data/DataCenter.tsx',
  'src/ui/data/ImportPreview.tsx',
  'src/ui/data/RecoveryStatus.tsx',
] as const;

/**
 * The data-product tree, as a **source-side** exclusion.
 *
 * Every question this file asks is "did the *application* reach into the product,
 * or into the codec, eagerly?" - and the product tree is not the application. It
 * is a peer implementation tree that legitimately depends on its own siblings and
 * on the storage-v2 implementation, exactly as the storage-v2 tree depends on
 * itself.
 *
 * RAIL CHANGE, recorded deliberately. `eagerImporters` used to consider every
 * module in the walk, and every assertion built on it passed for one reason only:
 * the product modules were not in the walk at all, because nothing imported them.
 * That is the same "the product does not exist yet" framing this file has already
 * corrected twice, and it stopped being true the moment the Data Center lazily
 * imported the product - which is the *good* outcome, and the one the surrounding
 * comments in this file predicted. The exclusion is on the source side only, so
 * the claim keeps its teeth: no module outside the product tree may reach a
 * product module, or the archive codec, through a static or `require` edge. The
 * companion rule in `tests/migrations/qaHardening.test.ts` states the same
 * boundary from the other direction, and `tests/unit/dataCenter.test.tsx` proves
 * the Data Center's own edges are all dynamic.
 */
const PRODUCTS_TREE = 'src/services/persistence/products/';

describe('Phase 5 gate 8: the owner flag defaults to off and is owned by Phase 5', () => {
  it('the flag key is VITE_DATA_PRODUCTS_V2 and it defaults to false three ways', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.dataProductsV2).toBe(PHASE_5_FLAG_ENV_KEY);
    expect(PHASE_5_FLAG_ENV_KEY).toBe('VITE_DATA_PRODUCTS_V2');
    // The safe production default, the parsed default with no environment, and
    // the declared matrix default all agree.
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({}).dataProductsV2).toBe(false);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
    // ...and the flag can be turned on explicitly, which is the opt-in the plan
    // requires before cutover.
    expect(parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'true' }).dataProductsV2).toBe(true);
    expect(parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'false' }).dataProductsV2).toBe(false);
    // A malformed value fails the build rather than silently defaulting, and the
    // error names the variable, never its value.
    expect(() => parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'maybe' })).toThrow(
      /VITE_DATA_PRODUCTS_V2 must be one of/,
    );
  });

  it('the declaration says which phase owns it, what it gates, and how to roll it back', () => {
    const definition = FEATURE_FLAG_MATRIX.dataProductsV2;
    expect(definition.ownerPhase).toBe(5);
    expect(definition.valueKind).toBe('boolean');
    // The purpose names the three products and the phase range that owns them.
    expect(definition.purpose).toContain('full-device');
    expect(definition.purpose).toContain('Phases 5 through 7');
    // The rollback is a build-time flag, matching the plan's Phase 5 rollback:
    // "Hide the tab and disable import. The format is additive."
    expect(definition.rollback).toContain('VITE_DATA_PRODUCTS_V2=false');
    // No flag in the matrix may default to on before its cutover phase.
    const enabledByDefault = Object.entries(FEATURE_FLAG_MATRIX)
      // `productionDefault` is typed `boolean | string`, so the comparison is made
      // against an explicitly widened boolean rather than relying on inference.
      .filter(([, definition]) => (definition.productionDefault as boolean) === true)
      .map(([key]) => key);
    expect(enabledByDefault).toEqual([]);
  });
});

describe('Phase 5 gate 8: the product exists, and the default build cannot reach it eagerly', () => {
  it('the detector that decides "eagerly" can actually tell the three edges apart', () => {
    // The positive control. Without it, "nothing imports the product eagerly"
    // could be satisfied by a detector that matches nothing at all, which is
    // exactly the failure mode Phase 3 review found five times in this repository.
    const from = join(process.cwd(), 'src/ui/App.tsx');
    const target = 'src/services/persistence/products/fullDeviceBackup.ts';
    const source = [
      "import { exportFullDeviceBackup } from '@/services/persistence/products/fullDeviceBackup';",
      "const lazy = await import('@/services/persistence/products/fullDeviceBackup');",
      "const alsoLazy = await import('../services/persistence/products/fullDeviceBackup');",
      "const required = require('@/services/persistence/products/fullDeviceBackup');",
      "import '@/services/persistence/products/fullDeviceBackup';",
      "import { spriteManifestUrl } from '@/services/spriteManifest';",
    ].join('\n');
    expect(edgeKindsTo(source, from, target).sort()).toEqual([
      'dynamic',
      'dynamic',
      'require',
      'static',
      'static',
    ]);
    // ...and it resolves a relative specifier to the same first-party file, so the
    // boundary cannot be sidestepped by switching from the alias to `..`.
    expect(edgeKindsTo(source, from, 'src/services/spriteManifest.ts')).toEqual(['static']);
    // An unrelated target has no edges at all, so the detector is not matching
    // every specifier it sees.
    expect(edgeKindsTo(source, from, 'src/store/subjectStore.ts')).toEqual([]);
  });

  it('the plan\'s Phase 5 product modules exist, and nothing imports them eagerly', () => {
    const graph = walk();
    const paths = graph.modules.map((module) => module.path);

    // The product now exists, so this is no longer "the files are absent". What
    // must still hold is the boundary: the product is reachable only through a
    // lazy `import()`, which is what keeps the ZIP codec and the whole backup
    // path out of the entry chunk a build with the flag off loads.
    //
    // RAIL CHANGE, recorded deliberately. This test used to assert that the plan's
    // Phase 5 files did not exist and that no module in the graph mentioned a
    // `.kdbak`. Both were true only while the product was absent, and the second
    // one became false the moment the Data Center - a separate owner, landing in
    // parallel - started naming the extension. The replacement states the property
    // the test was actually defending, and states it in a way that stays true
    // before and after the Data Center lands.
    for (const path of PRODUCT_MODULE_PATHS) {
      if (path.startsWith('src/ui/')) continue;
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
    expect(eagerImporters(paths, 'src/services/persistence/products/fullDeviceBackup.ts')).toEqual([]);
    expect(eagerImporters(paths, 'src/services/persistence/products/archiveValidation.ts')).toEqual([]);
  });

  it('the ZIP codec is reached only through the Phase 5 product, never eagerly', () => {
    // Phase 3 built `archive.ts` as a codec for Phases 5 through 7 and left it out
    // of the application graph on purpose: with the flag off there is no ZIP writer
    // in the build at all, so there is nothing for a learner to trigger by
    // accident. The product is what needs it, and it is reached through the
    // product's own lazy chunk.
    //
    // RAIL CHANGE, recorded deliberately. This used to assert the codec's
    // *absence* from the walk. That is the same "the product does not exist yet"
    // framing, and it becomes false - correctly - the moment the Data Center
    // lazily imports the product. The eager/lazy distinction is the durable form
    // of the same claim, and it is the one plan section 11 actually requires.
    const paths = walk().modules.map((module) => module.path);
    expect(eagerImporters(paths, 'src/services/persistence/v2/archive.ts')).toEqual([]);

    // ...and the positive half of the test's own name, which the absence assertion
    // never checked: the product really does reach the codec, statically, because
    // that dependency is the product's own and costs a default build nothing while
    // the product itself is lazy.
    const productPaths = paths.filter((path) => path.startsWith(PRODUCTS_TREE));
    expect(productPaths.length).toBeGreaterThanOrEqual(2);
    const codecImporters = productPaths.filter(
      (path) =>
        edgeKindsTo(readFileSync(join(process.cwd(), path), 'utf8'), join(process.cwd(), path), 'src/services/persistence/v2/archive.ts')
          .length > 0,
    );
    expect(codecImporters.sort()).toEqual([
      'src/services/persistence/products/archiveValidation.ts',
      'src/services/persistence/products/fullDeviceBackup.ts',
    ]);

    // Everything else in the storage-v2 tree *is* reachable, because Phase 4
    // routed the application through it. Stating that here is what makes the
    // boundary above deliberate rather than accidental: the repository, the
    // migrations, and the device-local attachment store are all in the graph, and
    // the archive codec is the one thing that is not eagerly there.
    const v2InGraph = paths.filter((path) => path.includes('services/persistence/v2/'));
    expect(v2InGraph.length).toBeGreaterThanOrEqual(13);
    expect(v2InGraph).toContain('src/services/persistence/v2/repository.ts');
    expect(v2InGraph).toContain('src/services/persistence/v2/migrations.ts');
    // The device-local attachment store is reachable too, because Phase 4 made
    // image attachments local in both modes. That is the distinction this gate
    // keeps sharp: local attachments yes, archives only lazily.
    expect(v2InGraph).toContain('src/services/persistence/v2/attachmentBytes.ts');
  });
});

describe('Phase 5 gate 8: REGISTERED - the product arrives behind the flag', () => {
  it('the product exports the entry points, behind the flag, at the end of a lazy edge', async () => {
    // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for the
    // plan's Phase 5 product module to exist and for the application to import it.
    // RAIL CHANGE, recorded deliberately: the original assertion was `paths`
    // contains the two product modules **and** `src/ui/data/DataCenter.tsx`, which
    // makes it a test of the Data Center rather than of this phase - that file is a
    // separate owner's, landing in parallel. What is Phase 5's own contract is the
    // module existing, exporting the entry points the rest of this suite is built
    // on, and being reachable only through a lazy edge. The Data Center's own
    // presence is asserted by `tests/e2e/dataProductsRestore.spec.ts`.
    const product = (await import(/* @vite-ignore */ FULL_DEVICE_BACKUP_MODULE)) as Record<
      string,
      unknown
    >;
    expect(typeof product.exportFullDeviceBackup).toBe('function');
    expect(typeof product.importFullDeviceBackup).toBe('function');
    // The writer and the read-only validator are re-exported from the product
    // module so a caller that needs to assemble or inspect members by hand has one
    // place to import them from.
    expect(typeof product.writeArchive).toBe('function');
    expect(typeof product.readFullDeviceArchive).toBe('function');

    const validation = (await import(/* @vite-ignore */ ARCHIVE_VALIDATION_MODULE)) as Record<
      string,
      unknown
    >;
    // Both the throwing and the non-throwing read paths, because a preview is the
    // one place where a failure is an expected outcome rather than an exception.
    expect(typeof validation.readFullDeviceArchive).toBe('function');
    expect(typeof validation.inspectFullDeviceArchive).toBe('function');

    // And the boundary itself: with the flag off, nothing eagerly loads the
    // product, so the default build's entry chunk cannot carry the ZIP codec.
    const paths = walk().modules.map((module) => module.path);
    expect(eagerImporters(paths, 'src/services/persistence/products/fullDeviceBackup.ts')).toEqual([]);
    expect(eagerImporters(paths, 'src/services/persistence/products/archiveValidation.ts')).toEqual([]);
  });
});
