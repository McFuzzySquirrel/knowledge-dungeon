/**
 * The Phase 22 route-aware performance budget gate: pure functions and CLI red proofs.
 *
 * The gate is infrastructure, so it is tested the way the sibling gates are tested:
 * its pure measurement and evaluation functions against synthetic fixtures, and its
 * CLI by spawning `node scripts/check-performance.mjs` against a throwaway `dist`.
 * The tests never read a real build, so they pass on a clean checkout before anything
 * has been compiled.
 *
 * The over-limit cases are the important ones. A budget gate that has never been
 * observed red is a gate whose arithmetic is unverified, so both the pure evaluator
 * and the CLI are driven over the ceiling and then back under it.
 *
 * Privacy: nothing here reads, writes, or asserts on learner data. The fixtures are
 * filler bytes in a temporary directory, and no subject, note, attachment,
 * progression, statistic, preference, or assistance value is read or named.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOfflineBoundary,
  evaluatePerformanceGate,
  gzipSize,
  kib,
  LAZY_BOUNDARY_GZIP_BYTES,
  mib,
  measureBoundaryChunks,
  normalizeBoundary,
  parseCensus,
  sumRawBytes,
  TOTAL_DIST_BYTES,
} from '../../scripts/check-performance.mjs';
import {
  boundaryOf,
  bytesOf,
  censusFixture,
  incompressible,
  makeDist,
  readerOf,
  TOTAL_DIST_RAW_BYTES,
} from './support/performanceGate';

import type { SyntheticDist } from './support/performanceGate';
import type { PerformanceBoundary } from '../../scripts/check-performance.mjs';

const tempDists: SyntheticDist[] = [];
afterEach(() => {
  while (tempDists.length > 0) tempDists.pop()?.cleanup();
});

function track(dist: SyntheticDist): SyntheticDist {
  tempDists.push(dist);
  return dist;
}

describe('the budget constants are the plan numbers, imported not redeclared', () => {
  it('enforces the 800 KiB lazy-boundary ceiling', () => {
    expect(LAZY_BOUNDARY_GZIP_BYTES).toBe(819_200);
    expect(LAZY_BOUNDARY_GZIP_BYTES).toBe(800 * 1024);
  });

  it('enforces the 12 MB raw dist ceiling', () => {
    expect(TOTAL_DIST_BYTES).toBe(12_000_000);
    expect(TOTAL_DIST_BYTES).toBe(TOTAL_DIST_RAW_BYTES);
  });
});

describe('pure measurement', () => {
  it('gzips high-entropy bytes near their raw size and repeated bytes to almost nothing', () => {
    const random = bytesOf(incompressible(64 * 1024));
    const repeated = bytesOf('a'.repeat(64 * 1024));
    expect(gzipSize(random)).toBeGreaterThan(48 * 1024);
    expect(gzipSize(random)).toBeLessThan(random.length);
    expect(gzipSize(repeated)).toBeLessThan(1024);
  });

  it('formats sizes for the report', () => {
    expect(kib(1024)).toBe('1.00 KiB');
    expect(kib(819_200)).toBe('800.00 KiB');
    expect(mib(12_000_000)).toBe('11.44 MB');
  });

  it('sums raw bytes over a map and over rows', () => {
    expect(sumRawBytes(new Map([['a', 1], ['b', 2]]))).toBe(3);
    expect(sumRawBytes([{ rawBytes: 4 }, { rawBytes: 5 }])).toBe(9);
  });
});

describe('parseCensus', () => {
  it('accepts a well-formed census', () => {
    const parsed = parseCensus(JSON.stringify(censusFixture()));
    expect(parsed.problem).toBeUndefined();
    expect(parsed.census?.schemaVersion).toBe(1);
  });

  it('fails closed on invalid JSON', () => {
    expect(parseCensus('{not json').problem).toContain('not valid JSON');
  });

  it('fails closed on an unknown schema version rather than reading it optimistically', () => {
    const parsed = parseCensus(JSON.stringify(censusFixture({ schemaVersion: 99 })));
    expect(parsed.problem).toContain('schemaVersion 99');
  });

  it('fails closed when the census names no module entry', () => {
    const parsed = parseCensus(JSON.stringify(censusFixture({ moduleEntryChunks: [] })));
    expect(parsed.problem).toContain('no module entry chunk');
  });

  it('fails closed when the census has no boundaries', () => {
    const parsed = parseCensus(JSON.stringify(censusFixture({ boundaries: undefined })));
    expect(parsed.problem).toContain('no boundaries array');
  });
});

describe('normalizeBoundary', () => {
  it('tolerates a hand-written fixture missing fields', () => {
    const normalized = normalizeBoundary({ id: 'lane:share', chunks: ['a', 7, 'b'] });
    expect(normalized.kind).toBe('lane');
    expect(normalized.present).toBe(false);
    expect(normalized.chunks).toEqual(['a', 'b']);
    expect(normalized.eagerChunks).toEqual([]);
  });

  it('keeps a renderer kind and its label', () => {
    const normalized = normalizeBoundary(boundaryOf({ kind: 'renderer', label: 'Phaser' }));
    expect(normalized.kind).toBe('renderer');
    expect(normalized.label).toBe('Phaser');
  });
});

describe('measureBoundaryChunks', () => {
  it('measures each distinct chunk once and records an unreadable one as an error', async () => {
    const files = new Map([
      ['assets/a.js', bytesOf('a'.repeat(1000))],
      ['assets/b.js', bytesOf(incompressible(2048))],
    ]);
    const boundaries: PerformanceBoundary[] = [
      boundaryOf({ id: 'lane:share', chunks: ['assets/a.js', 'assets/b.js'] }),
      boundaryOf({ id: 'lane:assistance', chunks: ['assets/a.js', 'assets/missing.js'] }),
    ];
    const sizes = await measureBoundaryChunks(boundaries, readerOf(files));
    const measured = (key: string) =>
      sizes.get(key) as { rawBytes?: number; gzipBytes?: number; error?: string } | undefined;
    expect(sizes.size).toBe(3);
    expect(measured('assets/a.js')?.rawBytes).toBe(1000);
    expect(measured('assets/b.js')?.gzipBytes).toBe(gzipSize(files.get('assets/b.js')!));
    expect(measured('assets/missing.js')).toEqual({ error: 'ENOENT' });
  });
});

describe('buildOfflineBoundary', () => {
  it('marks the offline shell absent when none of its files exist', () => {
    const boundary = buildOfflineBoundary(new Set(['assets/index-a1.js']));
    expect(boundary.present).toBe(false);
    expect(boundary.chunks).toEqual([]);
  });

  it('measures the offline shell files that exist', () => {
    const boundary = buildOfflineBoundary(new Set(['sw.js', 'offline-shell-manifest.js']));
    expect(boundary.present).toBe(true);
    expect(boundary.chunks).toEqual(['sw.js', 'offline-shell-manifest.js']);
  });
});

describe('evaluatePerformanceGate', () => {
  const smallSizes = () =>
    new Map([
      ['assets/vendor-phaser-a1.js', { rawBytes: 100_000, gzipBytes: 20_000 }],
    ]);

  it('passes a boundary within budget and counts it as measured', () => {
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf())],
      sizes: smallSizes(),
      distTotalRawBytes: 1_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.measuredCount).toBe(1);
    expect(result.boundaries[0].gzipBytes).toBe(20_000);
  });

  it('does not treat an absent boundary as a finding, but reports it as not measured', () => {
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf({ id: 'renderer:pixi', present: false, chunks: [] }))],
      sizes: smallSizes(),
      distTotalRawBytes: 1_000_000,
    });
    // The only finding is non-vacuity: nothing was measured at all.
    expect(result.findings.map((finding) => finding.code)).toEqual(['no-lazy-boundary']);
    expect(result.measuredCount).toBe(0);
  });

  it('fails an over-limit boundary by name', () => {
    const over = LAZY_BOUNDARY_GZIP_BYTES + 1;
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf({ id: 'lane:assistance' }))],
      sizes: new Map([['assets/vendor-phaser-a1.js', { rawBytes: 2_000_000, gzipBytes: over }]]),
      distTotalRawBytes: 1_000_000,
    });
    expect(result.ok).toBe(false);
    const finding = result.findings.find((entry) => entry.code === 'oversized-boundary');
    expect(finding?.boundary).toBe('lane:assistance');
    expect(finding?.message).toContain('800 KiB');
    expect(result.boundaries[0].over).toBe(true);
  });

  it('fails a named boundary chunk that is not in the build', () => {
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf({ chunks: ['assets/vendor-phaser-a1.js', 'assets/gone.js'] }))],
      sizes: smallSizes(),
      distTotalRawBytes: 1_000_000,
    });
    const finding = result.findings.find((entry) => entry.code === 'missing-boundary-chunk');
    expect(finding?.boundary).toBe('renderer:phaser');
    expect(finding?.message).toContain('assets/gone.js');
  });

  it('fails a stale census whose accounted files are gone', () => {
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf())],
      sizes: smallSizes(),
      distTotalRawBytes: 1_000_000,
      missingAccountedFiles: ['assets/index-old.js'],
    });
    expect(result.findings.some((entry) => entry.code === 'stale-census')).toBe(true);
  });

  it('fails a raw dist over the 12 MB ceiling', () => {
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf())],
      sizes: smallSizes(),
      distTotalRawBytes: TOTAL_DIST_BYTES + 1,
    });
    expect(result.findings.some((entry) => entry.code === 'dist-over-budget')).toBe(true);
  });

  it('fails a build with no measured lazy boundary at all', () => {
    const result = evaluatePerformanceGate({
      boundaries: [normalizeBoundary(boundaryOf({ present: true, chunks: [] }))],
      sizes: new Map(),
      distTotalRawBytes: 1_000_000,
    });
    expect(result.findings.map((finding) => finding.code)).toEqual(['no-lazy-boundary']);
  });
});

describe('CLI red proof: an over-limit artifact fails by name, and restoring it passes', () => {
  const census = censusFixture({
    boundaries: [boundaryOf({ id: 'renderer:phaser', chunks: ['assets/vendor-phaser-a1.js'] })],
    accountedChunkFiles: ['assets/vendor-phaser-a1.js', 'assets/index-a1.js'],
  });

  it('fails with a named oversized boundary when a chunk is over 800 KiB gzip', () => {
    const over = track(
      makeDist(census, {
        'assets/index-a1.js': 'console.log(1)',
        'assets/vendor-phaser-a1.js': incompressible(1_300_000),
      }),
    );
    const result = over.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('oversized-boundary');
    expect(result.output).toContain('renderer:phaser');
  });

  it('passes the same boundary once it is under the ceiling again', () => {
    const under = track(
      makeDist(census, {
        'assets/index-a1.js': 'console.log(1)',
        'assets/vendor-phaser-a1.js': incompressible(8_000),
      }),
    );
    const result = under.run();
    expect(result.code).toBe(0);
    expect(result.output).toContain('Performance budget gate passed');
  });
});

describe('CLI does not pass a build it could not measure', () => {
  it('fails with the command to run when the census is missing', () => {
    const dist = track(makeDist(null, { 'index.html': '<!doctype html>' }));
    const result = dist.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('no bundle census');
    expect(result.output).toContain('npm run build:web');
  });

  it('fails when a boundary chunk the census names is missing from the build', () => {
    const census = censusFixture({
      boundaries: [boundaryOf({ chunks: ['assets/vendor-phaser-a1.js'] })],
      accountedChunkFiles: ['assets/vendor-phaser-a1.js'],
    });
    const dist = track(makeDist(census, { 'assets/index-a1.js': 'x' }));
    const result = dist.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('missing-boundary-chunk');
  });
});
