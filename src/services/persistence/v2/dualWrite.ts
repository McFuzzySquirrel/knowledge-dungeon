/**
 * Dual-write reporting: storage-v2 is authoritative, the legacy keys are a mirror.
 *
 * Plan section 7.1 step 7 and section 11: while the Phaser fallback remains
 * available, a successful storage-v2 write is mirrored to the legacy key so a
 * rollback to `VITE_STORAGE_REPOSITORY=legacy` can still read the device. Two
 * rules make that safe:
 *
 * 1. **The primary write is never sacrificed for the mirror.** A mirror failure
 *    is recorded and reported; it never fails the write the learner asked for.
 * 2. **A mirror failure is never swallowed.** Every run appends a sanitized
 *    {@link DualWriteReport} - a code, an operation name, and an outcome - and
 *    hands it to the installed sink. There is no free-text channel, so a report
 *    is safe to log, to attach to a bug report, or to render on a recovery
 *    screen.
 *
 * The reports carry a monotonic sequence number rather than a timestamp so the
 * whole surface stays deterministic and clock-free, exactly like the migration
 * report.
 *
 * Renderer-neutral: no renderer import, no storage access, no network.
 */

import type { StorageRepository } from '@/config/runtimeConfig';

/** Which app-owned write a report is about. A fixed set: no free text. */
export type DualWriteOperation =
  | 'subject.save'
  | 'subject.delete'
  | 'subject.index'
  | 'progression'
  | 'preferences'
  | 'shortcuts'
  | 'sessions'
  | 'attachment.bytes';

/** Machine-readable failure codes. No message ever carries record content. */
export type DualWriteFailureCode =
  | 'LEGACY_MIRROR_UNAVAILABLE'
  | 'LEGACY_MIRROR_WRITE_FAILED'
  | 'STORAGE_V2_WRITE_FAILED';

/**
 * What happened to one app-owned write.
 *
 * - `written` - the storage-v2 write succeeded. Independent of the mirror, so a
 *   write that landed and then failed to mirror reports both `written` and
 *   `mirror-failed`.
 * - `primary-failed` - the storage-v2 write did not happen. The learner is told.
 * - `mirror-failed` - the write happened, the legacy mirror did not take it.
 */
export type DualWriteOutcome = 'written' | 'primary-failed' | 'mirror-failed';

export interface DualWriteReport {
  /** Monotonic, per-process. Deterministic: no clock, no randomness. */
  readonly sequence: number;
  readonly operation: DualWriteOperation;
  readonly outcome: DualWriteOutcome;
  readonly code: DualWriteFailureCode | null;
}

/** Receives every report as it is produced. */
export interface DualWriteSink {
  onDualWriteReport(report: DualWriteReport): void;
}

/** Reports retained in memory. Bounded so a failing mirror cannot grow forever. */
export const DUAL_WRITE_REPORT_LIMIT = 200;

let reports: DualWriteReport[] = [];
let sequence = 0;
let sink: DualWriteSink | null = null;

/** Install the consumer that surfaces reports (the bootstrap records them). */
export function setDualWriteSink(next: DualWriteSink | null): void {
  sink = next;
}

/** Every retained report, oldest first. */
export function dualWriteReports(): readonly DualWriteReport[] {
  return reports;
}

/** Drop retained reports and the sequence counter. Test support. */
export function clearDualWriteReports(): void {
  reports = [];
  sequence = 0;
}

function record(operation: DualWriteOperation, outcome: DualWriteOutcome, code: DualWriteFailureCode | null): DualWriteReport {
  sequence += 1;
  const report: DualWriteReport = { sequence, operation, outcome, code };
  reports = [...reports, report].slice(-DUAL_WRITE_REPORT_LIMIT);
  sink?.onDualWriteReport(report);
  return report;
}

/**
 * Record a report without going through {@link writeThrough}.
 *
 * For a side-channel write whose failure must be reported but is not the primary
 * operation, such as copying a device-local attachment into the active
 * generation.
 */
export function recordDualWriteReport(
  operation: DualWriteOperation,
  outcome: DualWriteOutcome,
  code: DualWriteFailureCode | null,
): DualWriteReport {
  return record(operation, outcome, code);
}

/**
 * Start an asynchronous write and report its failure instead of hiding it.
 *
 * For a store action that is synchronous and must stay that way, so the
 * storage-v2 write it triggers cannot be awaited. This is the boundary: the
 * promise is not dropped, a rejection becomes a sanitized report, and nothing the
 * caller can observe changes. It lives here rather than beside the record adapter
 * so a store can reach it without importing the storage-v2 implementation, which
 * keeps that implementation out of the default artifact entirely.
 */
export function fireAndForget(operation: DualWriteOperation, work: Promise<unknown>): void {
  void work.catch(() => {
    recordDualWriteReport(operation, 'primary-failed', 'STORAGE_V2_WRITE_FAILED');
  });
}

/**
 * Start a {@link writeThrough} without awaiting it, and report its failure once.
 *
 * This is the composition a store actually wants: the write-through boundary
 * already records `primary-failed` before it rethrows, so wrapping it in
 * {@link fireAndForget} would report the same failure twice and inflate the
 * `primaryFailed` count a recovery screen shows. The rejection handler here
 * exists only to keep the promise handled - the write is a background effect and
 * the caller cannot act on it.
 */
export function writeThroughInBackground<T>(input: WriteThroughInput<T>): void {
  void writeThrough(input).catch(() => {
    // Reported by `writeThrough`. Swallowed here so an unhandled rejection
    // cannot reach the console, and so it is not counted twice.
  });
}

export interface WriteThroughInput<T> {
  operation: DualWriteOperation;
  /** The storage-v2 write. Its value is passed through untouched. */
  primary: () => Promise<T>;
  /**
   * The legacy mirror write. Returns `true` on success; a `false` return or a
   * throw is a mirror failure, which is recorded and never propagated.
   */
  mirror: () => boolean;
}

export interface WriteThroughResult<T> {
  /** The primary's value, or `null` when the primary failed. */
  readonly primaryValue: T | null;
  /** `false` only when the storage-v2 write itself failed. */
  readonly primaryOk: boolean;
  /** `false` when the legacy mirror did not accept the write. */
  readonly mirrorOk: boolean;
  readonly repository: StorageRepository;
}

/**
 * Write to the selected repository and mirror to the legacy keys.
 *
 * The mirror runs only after the primary has succeeded, so a failed primary can
 * never leave the legacy keys ahead of storage-v2. A mirror failure is recorded
 * and reported but does not reject.
 *
 * A primary failure rejects with the original error after recording a
 * `primary-failed` report, because a caller that asked for a write must be able
 * to tell the learner it did not happen.
 */
export async function writeThrough<T>(input: WriteThroughInput<T>): Promise<WriteThroughResult<T>> {
  let primaryValue: T;
  try {
    primaryValue = await input.primary();
  } catch (error) {
    record(input.operation, 'primary-failed', 'STORAGE_V2_WRITE_FAILED');
    throw error;
  }

  let mirrorOk = true;
  try {
    mirrorOk = input.mirror();
  } catch {
    mirrorOk = false;
  }
  // The primary succeeded, so that fact is reported too. `written` means "the
  // storage-v2 write happened", which is a different fact from whether the
  // mirror took it: a write that landed and then failed to mirror produces both
  // a `written` and a `mirror-failed` report, and `summarizeDualWriteReports`
  // counts them as independent counters for that reason.
  record(input.operation, 'written', null);
  if (!mirrorOk) record(input.operation, 'mirror-failed', 'LEGACY_MIRROR_WRITE_FAILED');

  return { primaryValue, primaryOk: true, mirrorOk, repository: 'v2' };
}

/**
 * How many reports of each outcome are retained. Counts only, for a screen.
 *
 * `written` counts successful primary writes, not successful operations: a write
 * that landed and then failed to mirror is counted in both `written` and
 * `mirrorFailed`, because both are true and both are worth showing.
 */
export function summarizeDualWriteReports(
  entries: readonly DualWriteReport[] = reports,
): { written: number; primaryFailed: number; mirrorFailed: number; lastCode: DualWriteFailureCode | null } {
  let written = 0;
  let primaryFailed = 0;
  let mirrorFailed = 0;
  for (const entry of entries) {
    if (entry.outcome === 'written') written += 1;
    else if (entry.outcome === 'primary-failed') primaryFailed += 1;
    else mirrorFailed += 1;
  }
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  return {
    written,
    primaryFailed,
    mirrorFailed,
    lastCode: last && last.code !== null ? last.code : null,
  };
}
