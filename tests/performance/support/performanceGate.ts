/**
 * Test support for the Phase 22 route-aware performance budget gate.
 *
 * The gate is a CLI plus a set of pure functions. The pure functions are exercised
 * against **synthetic census and dist fixtures** - the same shape the build emits and
 * the same shape the gate reads - so the unit suite never needs a real `dist`. The
 * CLI is exercised by spawning `node scripts/check-performance.mjs` against a
 * throwaway directory, exactly as `tests/phase8/support/welcomeBudgetGate.ts` spawns
 * the Welcome budget gate. That is deliberate: a test that reimplemented the budget
 * arithmetic would keep passing while the script CI runs computed something else.
 *
 * Privacy: the fixtures are filler bytes in a temporary directory. Nothing here
 * reads, copies, or reproduces learner data, and no subject, note, attachment,
 * progression, statistic, preference, or assistance value is read or named. Nothing
 * is written inside the repository.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPO_ROOT = process.cwd();
export const ENFORCER = path.join(REPO_ROOT, 'scripts', 'check-performance.mjs');
export const CENSUS_FILENAME = 'bundle-census.json';

/** The 800 KiB gzip ceiling, read here only to assert the enforcer agrees with it. */
export const LAZY_BOUNDARY_GZIP_BYTES = 800 * 1024;
/** The 12 MB raw `dist` ceiling. */
export const TOTAL_DIST_RAW_BYTES = 12_000_000;

/** Highly compressible filler, for a case that needs a file to be *small* on the wire. */
export function filler(bytes: number): string {
  return 'a'.repeat(bytes);
}

/**
 * Deterministic, high-entropy filler, for a case that needs a file to be *large* on
 * the wire. A run of identical characters gzips to almost nothing, so a "900 KB"
 * fixture built from `filler` would measure a few hundred bytes and the gate would
 * correctly pass it. A 32-bit LCG over a 64-character alphabet does not compress and
 * is reproducible with no `Math.random` and no clock.
 */
export function incompressible(bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = 0x2f6e2b1 >>> 0;
  let out = '';
  for (let index = 0; index < bytes; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet[(state >>> 24) & 63];
  }
  return out;
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** An in-memory `readFile` over a `Map<path, Uint8Array>`, for the pure functions. */
export function readerOf(files: ReadonlyMap<string, Uint8Array>): (relative: string) => Promise<Uint8Array> {
  return async (relative: string) => {
    const bytes = files.get(relative);
    if (bytes === undefined) {
      const error = new Error(`ENOENT: ${relative}`) as Error & { code?: string };
      error.code = 'ENOENT';
      throw error;
    }
    return bytes;
  };
}

/** A census boundary fixture, defaulting to a present one with one chunk. */
export function boundaryOf(overrides: Record<string, unknown> = {}) {
  return {
    id: 'renderer:phaser',
    kind: 'renderer' as const,
    label: 'Phaser',
    present: true,
    chunks: ['assets/vendor-phaser-a1.js'],
    eagerChunks: [] as string[],
    note: 'fixture',
    ...overrides,
  };
}

/** A census fixture with one present renderer boundary. */
export function censusFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    gzipLevel: 9,
    moduleEntryChunks: ['assets/index-a1.js'],
    legacyEntryChunks: [],
    entryClosure: ['assets/index-a1.js'],
    fetchableClosure: ['assets/index-a1.js'],
    boundaries: [boundaryOf()],
    accountedChunkFiles: ['assets/vendor-phaser-a1.js'],
    ...overrides,
  };
}

export interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Everything the process printed, in the order a reader would see it. */
  output: string;
}

export interface SyntheticDist {
  root: string;
  distDir: string;
  run(): GateResult;
  cleanup(): void;
}

function runEnforcer(distDir: string): GateResult {
  const result = spawnSync(process.execPath, [ENFORCER, `--dist=${distDir}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * Builds a throwaway `dist` from a census object and a set of files.
 *
 * `files` maps a dist-relative path to its bytes; `census === null` writes no census,
 * which is how the "no vacuous pass" case is provoked.
 */
export function makeDist(
  census: unknown | null,
  files: Record<string, string | Uint8Array> = {},
  options: { mutateCensus?: (census: Record<string, unknown>) => Record<string, unknown> } = {},
): SyntheticDist {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kd-perf-gate-'));
  const distDir = path.join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(distDir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (census !== null) {
    const value =
      options.mutateCensus && typeof census === 'object' && census !== null
        ? options.mutateCensus(census as Record<string, unknown>)
        : census;
    writeFileSync(path.join(distDir, CENSUS_FILENAME), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  return {
    root,
    distDir,
    run() {
      return runEnforcer(distDir);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
