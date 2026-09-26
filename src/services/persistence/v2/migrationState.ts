/**
 * The migration state model the UI renders.
 *
 * Plan section 7.2 step 14: "If any step fails, leave the legacy generation
 * active and show a recovery screen", and section 2.3: "Existing external-only
 * attachments must be disclosed honestly". Phase 4 needs four *distinguishable*
 * outcomes, not two:
 *
 * - **preview** - what a migration would move, before anything is written;
 * - **migrated** - a clean success with every byte on the device;
 * - **partial** - a success that carries a disclosure, which today means one or
 *   more attachments whose bytes could not be recovered;
 * - **recovery-required** - a failure. The legacy generation is still
 *   authoritative and `activeGeneration` was never flipped.
 *
 * Every field is a code, a count, a version, an opaque id, or a boolean. No
 * subject name, room topic, note, filename, or URL can appear in any of these
 * states, so they are safe to render, log, and attach to a bug report.
 *
 * This module is pure and renderer-neutral: it takes a report and returns a
 * state. It performs no storage access.
 */

import type { MigrationReport, StorageV2ErrorCode } from './schema';
import type { ValidationProblem } from './validation';
import { countBlockingProblems } from './validation';
import type { LegacyAppState } from './legacyReader';
import type { StorageRepository } from '@/config/runtimeConfig';

// ── Blocking policy ───────────────────────────────────────────────────────

/**
 * Which problems prevent activation, stated once.
 *
 * `ValidationSeverity` is not decoration: `error` means "activation is refused",
 * and `warning` means "disclosed, activation proceeds". This module owns that
 * sentence; `validateGeneration` refuses to activate on any `error`, and the
 * migration reads its report's `status` from the same rule.
 *
 * The one place the distinction matters is a record the migration could not read
 * out of the *source* device - a corrupt subject payload, an unparsable
 * progression blob, a duplicate identifier that was replaced. That record is
 * never in the staged generation, so there is nothing for generation validation
 * to refuse, and the migration is reported with a `warning` plus a disclosed
 * count. Blocking the whole device on one unreadable record would be a worse
 * outcome than migrating the rest and saying so.
 */
export const MIGRATION_BLOCKING_POLICY = 'error-blocks-warning-discloses' as const;

export type MigrationBlockingPolicy = typeof MIGRATION_BLOCKING_POLICY;

/** Whether a problem refuses activation. The single implementation. */
export function isActivationBlocking(problem: ValidationProblem): boolean {
  return problem.severity === 'error';
}

export interface PartitionedProblems {
  readonly blocking: readonly ValidationProblem[];
  readonly disclosed: readonly ValidationProblem[];
  readonly blockingCount: number;
  readonly disclosedCount: number;
}

/** Split a report's problems into the ones that block and the ones disclosed. */
export function partitionMigrationProblems(
  problems: readonly ValidationProblem[],
): PartitionedProblems {
  const blocking = problems.filter(isActivationBlocking);
  const disclosed = problems.filter((problem) => !isActivationBlocking(problem));
  return {
    blocking,
    disclosed,
    blockingCount: countBlockingProblems(problems),
    disclosedCount: disclosed.reduce((total, problem) => total + problem.count, 0),
  };
}

// ── Shared shape ──────────────────────────────────────────────────────────

export type MigrationStateKind =
  | 'preview'
  | 'running'
  | 'migrated'
  | 'partial'
  | 'recovery-required'
  | 'no-source-data';

/** Counts only. The same numbers a migration report carries. */
export interface MigrationStateCounts {
  readonly subjects: number;
  readonly progression: number;
  readonly sessions: number;
  readonly preferences: number;
  readonly shortcuts: number;
  readonly assistance: number;
  readonly attachmentMetadata: number;
  readonly attachmentBlobs: number;
  readonly customSprites: number;
  readonly recovery: number;
}

export interface MigrationStateBase {
  readonly kind: MigrationStateKind;
  readonly repository: StorageRepository;
  /** {@link MIGRATION_BLOCKING_POLICY}, so a screen can state the rule it used. */
  readonly blockingPolicy: MigrationBlockingPolicy;
  /**
   * What a learner can be offered next, as codes.
   *
   * A state that only says what happened leaves a screen to invent the button,
   * and two screens then disagree about whether a retry is safe. This is the
   * whole per-state affordance list, so a screen renders what the core says is
   * possible and nothing more. Empty means "there is nothing to offer", which is
   * a real answer and not a missing one.
   */
  readonly nextActions: readonly MigrationNextAction[];
  /** Present once a generation was staged. */
  readonly stagedGenerationId: string | null;
  /** The generation the pointer named before this run. */
  readonly previousActiveGenerationId: string | null;
  /**
   * Whether `activeGeneration` names this run's generation. A caller that only
   * reads this can never conclude a device is migrated when its data is
   * unreachable.
   */
  readonly activeGenerationFlipped: boolean;
  readonly counts: MigrationStateCounts;
  /** Problems that refused activation. Empty on every non-failed state. */
  readonly blockingProblems: readonly ValidationProblem[];
  /** Problems that were disclosed and allowed the migration to finish. */
  readonly disclosedProblems: readonly ValidationProblem[];
  readonly disclosedProblemCount: number;
}

/**
 * An action a state can offer, as a fixed set of codes.
 *
 * Declarative on purpose: the core names the affordance, and the UI owner binds
 * it to a button. `start-migration` and `retry-migration` are the two the core
 * can actually perform - both run the same staged migration - and differ only in
 * what a screen says about them.
 */
export type MigrationNextAction = 'start-migration' | 'retry-migration' | 'review-disclosures';

/**
 * The next actions for a state, stated once.
 *
 * - `preview` can be started.
 * - `running` offers nothing, because a migration is already in flight and a
 *   second offer would be a race.
 * - `migrated` offers nothing: the device is migrated.
 * - `partial` succeeded and disclosed something, so the disclosures are
 *   reviewable. It is not a failure and offers no retry, because re-running
 *   would not recover bytes the device does not hold.
 * - `recovery-required` offers a retry only when the failure is one a retry can
 *   fix. `INDEXEDDB_UNAVAILABLE` is not: the store is gone, and a screen that
 *   offered a retry there would be lying.
 * - `no-source-data` offers nothing: there is nothing to migrate.
 */
export function nextActionsFor(kind: MigrationStateKind, retryable: boolean): readonly MigrationNextAction[] {
  switch (kind) {
    case 'preview':
      return ['start-migration'];
    case 'partial':
      return ['review-disclosures'];
    case 'recovery-required':
      return retryable ? ['retry-migration'] : [];
    default:
      return [];
  }
}

export interface MigrationPreviewState extends MigrationStateBase {
  readonly kind: 'preview';
  /** How many source payloads could not be read and would not be carried. */
  readonly unreadableSourceRecords: number;
  /** How many attachments would become `external-only`. */
  readonly externalOnlyAttachments: number;
  readonly legacyKeys: MigrationReport['legacyKeys'];
}

export interface MigrationRunningState extends MigrationStateBase {
  readonly kind: 'running';
  readonly stage: string;
}

export interface MigrationSucceededState extends MigrationStateBase {
  readonly kind: 'migrated' | 'partial';
  /** `true` for `partial`; the reason a run is partial. */
  readonly hasDisclosure: boolean;
  /** Attachments whose bytes are not on this device. */
  readonly externalOnlyAttachments: number;
  /** Reason codes for those attachments. Fixed set, no URLs. */
  readonly externalOnlyReasons: readonly string[];
  readonly contentChecksum: string | null;
  readonly receiptId: string | null;
}

export interface MigrationRecoveryRequiredState extends MigrationStateBase {
  readonly kind: 'recovery-required';
  readonly recovery: { readonly code: StorageV2ErrorCode; readonly stage: string };
  /** True in every recovery state: the legacy generation is still authoritative. */
  readonly legacyAuthoritative: true;
  /** True in every recovery state: the pointer was never moved. */
  readonly activeGenerationFlipped: false;
  /**
   * True in every recovery state: the learner's data is still there.
   *
   * A failed run stages a generation, validates it, and only then flips the
   * pointer, so a `recovery-required` state means the staged generation was never
   * activated and the legacy keys were never written. Nothing was lost and
   * nothing is half-migrated - which is the fact a recovery screen most needs and
   * the one it cannot infer from a code.
   */
  readonly dataIsIntact: true;
  /** Whether a plain retry is the documented next step. */
  readonly retryable: boolean;
}

export interface MigrationNoSourceDataState extends MigrationStateBase {
  readonly kind: 'no-source-data';
  readonly legacyKeys: MigrationReport['legacyKeys'];
}

export type MigrationState =
  | MigrationPreviewState
  | MigrationRunningState
  | MigrationSucceededState
  | MigrationRecoveryRequiredState
  | MigrationNoSourceDataState;

// ── Construction ──────────────────────────────────────────────────────────

function countsOf(report: MigrationReport): MigrationStateCounts {
  return {
    subjects: report.recordCounts.subjects,
    progression: report.recordCounts.progression,
    sessions: report.recordCounts.sessions,
    preferences: report.recordCounts.preferences,
    shortcuts: report.recordCounts.shortcuts,
    assistance: report.recordCounts.assistance,
    attachmentMetadata: report.recordCounts.attachments,
    attachmentBlobs: report.recordCounts.attachmentBlobs,
    customSprites: report.recordCounts.customSprites,
    recovery: report.recordCounts.recovery,
  };
}

function baseOf(
  report: MigrationReport,
  kind: MigrationStateKind,
  retryable = false,
): MigrationStateBase {
  const partitioned = partitionMigrationProblems(report.problems);
  return {
    kind,
    repository: 'v2',
    blockingPolicy: MIGRATION_BLOCKING_POLICY,
    nextActions: nextActionsFor(kind, retryable),
    stagedGenerationId: report.stagedGenerationId,
    previousActiveGenerationId: report.previousActiveGenerationId,
    activeGenerationFlipped: report.activated,
    counts: countsOf(report),
    blockingProblems: partitioned.blocking,
    disclosedProblems: partitioned.disclosed,
    disclosedProblemCount: partitioned.disclosedCount,
  };
}

/**
 * Turn a migration report into the state a screen renders.
 *
 * The partial case is a *success with a disclosure*, never a silent success: a
 * report carrying any `external-only` attachment maps to `partial`, so a screen
 * cannot render a clean success for a run that did not carry every byte.
 */
export function classifyMigrationReport(report: MigrationReport): MigrationState {
  if (report.status === 'recovery-required') {
    const recovery = report.recovery ?? { code: 'MIGRATION_FAILED' as StorageV2ErrorCode, stage: 'unknown' };
    const retryable = recovery.code !== 'INDEXEDDB_UNAVAILABLE';
    return {
      ...baseOf(report, 'recovery-required', retryable),
      kind: 'recovery-required',
      activeGenerationFlipped: false,
      recovery: { code: recovery.code, stage: recovery.stage },
      legacyAuthoritative: true,
      // The pointer was never flipped and the legacy keys were never written, so
      // the device still holds everything it held before the run.
      dataIsIntact: true,
      retryable,
    };
  }

  if (report.status === 'no-source-data') {
    return { ...baseOf(report, 'no-source-data'), kind: 'no-source-data', legacyKeys: report.legacyKeys };
  }

  const externalOnly = report.externalOnlyAttachments.length;
  const reasons = [...new Set(report.externalOnlyAttachments.map((entry) => entry.reason))].sort();
  const kind: MigrationSucceededState['kind'] = externalOnly > 0 ? 'partial' : 'migrated';
  return {
    ...baseOf(report, kind),
    kind,
    hasDisclosure: externalOnly > 0 || report.problems.length > 0,
    externalOnlyAttachments: externalOnly,
    externalOnlyReasons: reasons,
    contentChecksum: report.contentChecksum,
    receiptId: report.receiptId,
  };
}

/**
 * Preview what a migration would move, without writing anything.
 *
 * Built from a read-only legacy state, so a preview is always safe to render
 * before the learner commits. Counts and codes only.
 */
export function buildMigrationPreview(
  state: LegacyAppState,
  legacyKeys: MigrationReport['legacyKeys'],
  unreadableSourceRecords: number,
): MigrationPreviewState {
  let attachmentCandidates = 0;
  let unreadable = unreadableSourceRecords;
  for (const subject of state.subjects) {
    if (subject.parsed === null) {
      unreadable += 1;
      continue;
    }
    const rooms = (subject.parsed as { rooms?: Record<string, { attachments?: unknown[] }> }).rooms ?? {};
    for (const room of Object.values(rooms)) {
      attachmentCandidates += Array.isArray(room?.attachments) ? room.attachments.length : 0;
    }
  }
  return {
    kind: 'preview',
    repository: 'v2',
    blockingPolicy: MIGRATION_BLOCKING_POLICY,
    nextActions: nextActionsFor('preview', false),
    stagedGenerationId: null,
    previousActiveGenerationId: null,
    activeGenerationFlipped: false,
    counts: {
      subjects: Math.max(0, state.subjects.length - unreadable),
      progression: state.progressionRaw === null ? 0 : 1,
      sessions: 0,
      preferences: state.preferencesRaw === null && state.locale === null ? 0 : 1,
      shortcuts: state.shortcutsRaw === null ? 0 : 1,
      assistance: 0,
      attachmentMetadata: attachmentCandidates,
      attachmentBlobs: 0,
      customSprites: state.customSprites.length,
      recovery: state.recovery.length,
    },
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    unreadableSourceRecords: unreadable,
    externalOnlyAttachments: attachmentCandidates,
    legacyKeys,
  };
}

/** A running state for a stage, so a screen can show progress honestly. */
export function buildRunningMigrationState(
  repository: StorageRepository,
  stage: string,
  counts: MigrationStateCounts,
): MigrationRunningState {
  return {
    kind: 'running',
    repository,
    blockingPolicy: MIGRATION_BLOCKING_POLICY,
    // Nothing is offered while a migration is in flight; a second offer is a race.
    nextActions: nextActionsFor('running', false),
    stagedGenerationId: null,
    previousActiveGenerationId: null,
    activeGenerationFlipped: false,
    counts,
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    stage,
  };
}

/**
 * The invariant a caller can rely on: `migrated` never describes a generation
 * that is still only `staged`.
 *
 * `migrated` means "this migration completed and its generation is either the
 * active one or was later superseded by a later generation". A generation left
 * `staged` by a run that failed after its stage commit is an abandoned partial
 * run, not a migrated device: its records exist but nothing points at them, so a
 * caller reading only `status` would conclude the device is migrated while its
 * data is unreachable. The migration therefore discards and redoes such a
 * generation instead of reporting success, and this guard is what keeps a future
 * caller from reintroducing the ambiguity.
 *
 * @param report The report to check.
 * @param observedGenerationStatus The status the repository actually holds for
 *   the report's `stagedGenerationId`, or `null` when there is no such
 *   generation.
 * @throws when the report claims a reachable outcome it does not have.
 */
export function assertMigrationStatusReachable(
  report: MigrationReport,
  observedGenerationStatus: 'staged' | 'active' | 'superseded' | null,
): void {
  if (report.status !== 'migrated') return;
  if (report.stagedGenerationId === null) {
    throw new Error('A migrated report must name the generation it migrated.');
  }
  if (report.problems.some(isActivationBlocking)) {
    throw new Error('A migrated report must not carry an activation-blocking problem.');
  }
  if (observedGenerationStatus === 'staged') {
    throw new Error(
      'A migrated report must not describe a generation that is still only staged: its data is unreachable.',
    );
  }
  if (observedGenerationStatus === null) {
    throw new Error('A migrated report must describe a generation that still exists.');
  }
}
