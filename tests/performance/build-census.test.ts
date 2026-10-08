/**
 * The Phase 22 bundle census: what the build writes, and what the gate reads.
 *
 * The census is the build's statement about the lazy boundaries it emitted. It is
 * produced by `buildBundleCensus` in `vite.config.ts` from the **same** emitter
 * census that fails the build on an eager Pixi chunk, and `scripts/check-performance.mjs`
 * budgets the chunk files it names. A test that did not pin the census contract would
 * let the writer and the reader drift by one field, and the drift would surface only
 * as a gate that measured the wrong thing.
 *
 * These cases are pure over synthetic `EmittedBundle` fixtures, so they need no build
 * and pass on a clean checkout.
 *
 * Privacy: no learner data, no asset, no IndexedDB, and nothing written to the
 * repository.
 */

import { describe, expect, it } from 'vitest';

import { ASSISTANCE_LANE_PATHS, buildBundleCensus, SHARE_LANE_PATHS, type EmittedBundle } from '../../vite.config';
import { BUNDLE_CENSUS_SCHEMA_VERSION, GZIP_LEVEL } from '../../scripts/performance-budgets.mjs';

/** One emitted chunk fixture. */
interface ChunkFixture {
  imports?: readonly string[];
  dynamicImports?: readonly string[];
  isEntry?: boolean;
  type?: string;
  modules?: Readonly<Record<string, unknown>>;
  importedCss?: readonly string[];
}

function bundleOf(entries: Readonly<Record<string, ChunkFixture>>): EmittedBundle {
  const bundle: Record<string, EmittedBundle[string]> = {};
  for (const [fileName, entry] of Object.entries(entries)) {
    bundle[fileName] = {
      fileName,
      type: entry.type ?? 'chunk',
      imports: entry.imports ?? [],
      dynamicImports: entry.dynamicImports ?? [],
      isEntry: entry.isEntry === true,
      modules: entry.modules ?? {},
      viteMetadata: entry.importedCss ? { importedCss: new Set(entry.importedCss) } : undefined,
    } as EmittedBundle[string];
  }
  return bundle;
}

const REACT_ID = '/repo/node_modules/react/index.js';

/** A Phaser build with no Pixi and no lane code: the production default shape. */
function phaserOnlyBundle(): EmittedBundle {
  return bundleOf({
    'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
    'assets/vendor-phaser-b2.js': { modules: { [REACT_ID]: {} } },
  });
}

function boundaryById(census: ReturnType<typeof buildBundleCensus>, id: string) {
  return census.boundaries.find((boundary) => boundary.id === id);
}

describe('buildBundleCensus', () => {
  it('states schema, gzip level, and the module entry chunks', () => {
    const census = buildBundleCensus(phaserOnlyBundle());
    expect(census.schemaVersion).toBe(BUNDLE_CENSUS_SCHEMA_VERSION);
    expect(census.gzipLevel).toBe(GZIP_LEVEL);
    expect(census.moduleEntryChunks).toEqual(['assets/index-a1.js']);
    expect(census.legacyEntryChunks).toEqual([]);
  });

  it('declares both renderer families, present or absent, in a stable order', () => {
    const census = buildBundleCensus(phaserOnlyBundle());
    expect(census.boundaries.map((boundary) => boundary.id)).toEqual([
      'renderer:phaser',
      'renderer:pixi',
      'lane:assistance',
      'lane:share',
    ]);
    const phaser = boundaryById(census, 'renderer:phaser');
    const pixi = boundaryById(census, 'renderer:pixi');
    expect(phaser?.present).toBe(true);
    expect(phaser?.chunks).toEqual(['assets/vendor-phaser-b2.js']);
    // The eager renderer is reported as eager, not hidden.
    expect(phaser?.eagerChunks).toEqual(['assets/vendor-phaser-b2.js']);
    expect(pixi?.present).toBe(false);
    expect(pixi?.chunks).toEqual([]);
  });

  it('finds a lazily reached Pixi chunk as a lazy renderer boundary', () => {
    const census = buildBundleCensus(
      bundleOf({
        'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/vendor-pixi-b2.js'] },
        'assets/vendor-pixi-b2.js': {},
      }),
    );
    const pixi = boundaryById(census, 'renderer:pixi');
    expect(pixi?.present).toBe(true);
    expect(pixi?.chunks).toEqual(['assets/vendor-pixi-b2.js']);
    expect(pixi?.eagerChunks).toEqual([]);
  });

  it('excludes legacy re-emissions from the accounted chunk files', () => {
    const census = buildBundleCensus(
      bundleOf({
        'assets/index-a1.js': { isEntry: true, imports: ['assets/vendor-phaser-b2.js'] },
        'assets/vendor-phaser-b2.js': {},
        'assets/index-legacy-a1.js': { imports: ['assets/vendor-phaser-legacy-b2.js'] },
        'assets/vendor-phaser-legacy-b2.js': {},
        'assets/index-a1.css': { type: 'asset' },
      }),
    );
    expect(census.accountedChunkFiles).toEqual([
      'assets/index-a1.css',
      'assets/index-a1.js',
      'assets/vendor-phaser-b2.js',
    ]);
  });

  it('identifies a lazy assistance lane from module membership, not a chunk name', () => {
    const census = buildBundleCensus(
      bundleOf({
        'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/assistance-a1.js'] },
        'assets/assistance-a1.js': {
          modules: {
            [`/repo/${ASSISTANCE_LANE_PATHS[0]}.ts`]: {},
            [`/repo/${ASSISTANCE_LANE_PATHS[1]}.ts`]: {},
          },
        },
      }),
    );
    const assistance = boundaryById(census, 'lane:assistance');
    expect(assistance?.present).toBe(true);
    // The lane's own lazy chunk set, and the entry chunk is not in it.
    expect(assistance?.chunks).toEqual(['assets/assistance-a1.js']);
    expect(assistance?.eagerChunks).toEqual([]);
    // The share lane is absent from this build.
    expect(boundaryById(census, 'lane:share')?.present).toBe(false);
  });

  it('counts the CSS a lane imports with the lane chunk set', () => {
    const census = buildBundleCensus(
      bundleOf({
        'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/share-a1.js'] },
        'assets/share-a1.js': {
          modules: { [`/repo/${SHARE_LANE_PATHS[2]}.tsx`]: {} },
          importedCss: ['assets/share-a1.css'],
        },
      }),
    );
    const share = boundaryById(census, 'lane:share');
    expect(share?.present).toBe(true);
    expect(share?.chunks).toEqual(['assets/share-a1.css', 'assets/share-a1.js']);
  });

  it('excludes chunks the entry already downloads from a lane boundary', () => {
    const census = buildBundleCensus(
      bundleOf({
        'assets/index-a1.js': { isEntry: true, imports: ['assets/shared-a1.js'], dynamicImports: ['assets/share-a1.js'] },
        'assets/shared-a1.js': {},
        'assets/share-a1.js': {
          imports: ['assets/shared-a1.js'],
          modules: { [`/repo/${SHARE_LANE_PATHS[2]}.tsx`]: {} },
        },
      }),
    );
    const share = boundaryById(census, 'lane:share');
    expect(share?.chunks).toEqual(['assets/share-a1.js']);
  });

  it('follows dynamic imports in the fetchable closure but not the entry closure', () => {
    const census = buildBundleCensus(
      bundleOf({
        'assets/index-a1.js': { isEntry: true, dynamicImports: ['assets/share-a1.js'] },
        'assets/share-a1.js': {},
      }),
    );
    expect(census.entryClosure).toEqual(['assets/index-a1.js']);
    expect(census.fetchableClosure).toEqual(['assets/index-a1.js', 'assets/share-a1.js']);
  });

  it('is deterministic: two builds of the same bundle produce equal censuses', () => {
    expect(buildBundleCensus(phaserOnlyBundle())).toEqual(buildBundleCensus(phaserOnlyBundle()));
  });
});
