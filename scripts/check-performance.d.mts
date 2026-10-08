/**
 * Type declarations for `scripts/check-performance.mjs`.
 *
 * The enforcer is plain ESM run by `node`, like every other script in `scripts/`.
 * Its pure measurement and evaluation functions are exported so a test can exercise
 * them against synthetic fixtures rather than mirroring them, and those exports have
 * no declarations unless this file provides them. Mirrors `check-memory.d.mts`: the
 * declarations below are the enforcer's real exports and nothing else, so a new
 * export fails the build here until it is declared.
 *
 * This file has no runtime content and is not part of any bundle.
 */

/** The 800 KiB lazy-boundary ceiling, read from `scripts/check-memory.mjs`. */
export const LAZY_BOUNDARY_GZIP_BYTES: number;
export const LAZY_BOUNDARY_GZIP_KIB: number;

/** The 12 MB raw `dist` ceiling, read from `scripts/check-bundle-size.mjs`. */
export const TOTAL_DIST_BYTES: number;

/** The offline static shell's boundary id. */
export const OFFLINE_BOUNDARY_ID: string;

/** Runtime properties this gate does not measure, each paired with what would establish it. */
export const NOT_MEASURED: ReadonlyArray<{ readonly property: string; readonly needs: string }>;

/** A declared lazy boundary, normalized from the census. */
export interface PerformanceBoundary {
  readonly id: string;
  readonly kind: 'renderer' | 'lane';
  readonly label: string;
  readonly present: boolean;
  readonly chunks: readonly string[];
  readonly eagerChunks: readonly string[];
  readonly note: string;
}

/** One boundary's measured row in the report. */
export interface BoundaryReport extends PerformanceBoundary {
  readonly chunkCount: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly over: boolean;
  readonly missing: number;
}

/** One thing the gate refuses to let through, with the reason in a sentence. */
export interface PerformanceFinding {
  readonly code: string;
  readonly boundary: string | null;
  readonly message: string;
}

/** The gate's verdict. */
export interface PerformanceGateResult {
  readonly findings: readonly PerformanceFinding[];
  readonly ok: boolean;
  readonly boundaries: readonly BoundaryReport[];
  readonly measuredCount: number;
  readonly distTotalRawBytes: number;
  readonly totalLimitBytes: number;
  readonly lazyLimitBytes: number;
}

/** A measured file: bytes and gzip, or an error code. */
export type MeasuredFile =
  | { readonly rawBytes: number; readonly gzipBytes: number }
  | { readonly error: string };

export function gzipSize(bytes: Uint8Array): number;
export function kib(bytes: number): string;
export function mib(bytes: number): string;

/** Validates census text. Returns `{ census }` or `{ problem }`, never both. */
export function parseCensus(
  text: string,
): { census: Record<string, unknown>; problem?: undefined } | { census?: undefined; problem: string };

export function normalizeBoundary(raw: unknown): PerformanceBoundary;

export function buildOfflineBoundary(existingPaths: ReadonlySet<string>): PerformanceBoundary;

export function measureBoundaryChunks(
  boundaries: readonly PerformanceBoundary[],
  readFile: (relativePath: string) => Promise<Uint8Array>,
): Promise<Map<string, MeasuredFile>>;

export function sumRawBytes(entries: ReadonlyMap<string, number> | ReadonlyArray<{ rawBytes: number }>): number;

export function evaluatePerformanceGate(input: {
  boundaries: readonly PerformanceBoundary[];
  sizes: ReadonlyMap<string, MeasuredFile>;
  distTotalRawBytes: number;
  missingAccountedFiles?: readonly string[];
  lazyLimitBytes?: number;
  totalLimitBytes?: number;
}): PerformanceGateResult;

/** Every regular file under `distDir`, keyed by a dist-relative POSIX path. */
export function collectDistFiles(distDir: string): Promise<Map<string, number>>;
