/**
 * The durable interrupted-review marker.
 *
 * ## The defect this exists for
 *
 * `pendingReviewRoomId` was a closure variable inside
 * `createStudyFlowController`. `returnToVillage()` set it to `null` with no
 * decision, so a learner who walked out mid-review silently lost it - plan 5.3:
 * "Interrupted review state can be lost on exit", and plan exit criterion:
 * "Exiting during review does not silently lose committed work."
 *
 * A closure variable cannot be fixed in place: a reload destroys it. So the
 * marker has to be persisted, and the question is where.
 *
 * ## Where the marker lives, and why
 *
 * **In the canonical per-subject progression record's preserved app-owned-field
 * carrier (`extraFields`), under the static-vocabulary key
 * `interruptedReviewSession`, beside the review-pass reward ledger.** Weighed
 * against the same four options the Phase 15 ledger header weighs:
 *
 * - **A new storage-v2 store.** Rejected: a new object store is a data-format
 *   change, and it is outside Phase 16's boundary (working rule 3).
 * - **Inside `RoomMetadata` on the subject.** Rejected: the subject schema stays
 *   `1.1.0` (working rule 4). A review session is not room metadata; putting it
 *   there would make every room's record carry a field only one room uses, and it
 *   would need a `1.2.0` migration to be honest about the shape change.
 * - **A bare `localStorage` key.** Rejected: no migration, no generation
 *   membership, and therefore no backup membership. A marker a `.kdbak` restore
 *   silently drops is exactly the defect this module exists to fix.
 * - **`extraFields`.** Chosen, because it gets migration, generation membership,
 *   both backup products, and subject-copy ID remapping for free.
 *
 * ## The subject record's carrier was checked, and it does not exist
 *
 * The task of putting this in the **subject** record's carrier was taken
 * seriously and **verified rather than assumed**, and the answer is no. The
 * subject path has no unknown-field carrier:
 *
 * - `withRooms` in `src/store/subjectStore.ts` rebuilds every snapshot as
 *   `{ dungeon, rooms }` - an object literal, so any other key is dropped on the
 *   very next room write.
 * - `migrateToV11` in `src/services/persistence/subjectPersistence.ts` is
 *   configured `unknownTopLevelFields: 'drop'`.
 * - `validateSubjectRecord` in `src/services/persistence/v2/validation.ts`
 *   validates the snapshot's known shape and has no carrier to preserve
 *   anything else in.
 *
 * `JSON.stringify` would round-trip an unknown top-level key in isolation, which
 * is exactly the kind of thing that looks fine in a test and vanishes in the app:
 * the next `recordReviewPass` rebuilds the snapshot and the key is gone. So the
 * marker lives in the progression record's carrier instead, and this header is
 * the honest reason rather than a preference.
 *
 * ## Privacy
 *
 * A marker is a room id, an injected timestamp, and the pass number the review
 * was started in. No topic, no note text, no artifact markdown, no subject name,
 * no learner content of any kind.
 */
import type { QualityRating } from './spacedRepetition';
import { isValidQualityRating } from './spacedRepetition';
import { readReviewPassRewardLedgerFromFields } from './reviewPassRewards';

/**
 * The preserved app-owned field the marker is carried under.
 *
 * Static vocabulary. A different key from {@link REVIEW_PASS_REWARD_LEDGER_KEY}
 * on purpose: the marker is overwritten on every review open and every explicit
 * save, the ledger is append-only, and giving them separate keys is what lets
 * {@link writeInterruptedReviewSessionToFields} replace one without reading or
 * rebuilding the other.
 */
export const INTERRUPTED_REVIEW_SESSION_KEY = 'interruptedReviewSession';

/** Marker envelope version. Bumped only if the shape changes. */
export const INTERRUPTED_REVIEW_SESSION_VERSION = 1;

/** One interrupted, resumable review session for a subject. */
export interface InterruptedReviewSession {
  version: number;
  /**
   * The room whose review was started and not finalized.
   *
   * App-minted. A marker naming a room the dungeon no longer lists reads as no
   * marker at all - see {@link readInterruptedReviewSession}.
   */
  roomId: string;
  /** The pass number the review was started in, one-based. */
  passNumber: number;
  /** ISO timestamp from the caller's clock. Injected, never read here. */
  startedAt: string;
  /** ISO timestamp of the most recent {@link review/session-save}. */
  savedAt: string;
  /**
   * A rating the learner chose before leaving, or `null` for none.
   *
   * Stored so a resumed review can restore the choice, and **never applied to
   * SM-2**: `review/session-save` writes no SM-2 state at all. See the header of
   * `src/application/reviewCommands.ts` for why.
   */
  qualityRating: QualityRating | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toPassNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function toQualityRating(value: unknown): QualityRating | null {
  return isValidQualityRating(typeof value === 'number' ? value : Number.NaN)
    ? (value as QualityRating)
    : null;
}

/** A marker for a subject that has never interrupted a review. */
export function emptyInterruptedReviewSession(): InterruptedReviewSession | null {
  return null;
}

/**
 * Read a marker out of any persisted value.
 *
 * Total by construction. A malformed, truncated, or hand-edited value reads as
 * **`null`**, not as an empty session: the difference matters, because `null` is
 * the "there is nothing to resume" answer and a non-null placeholder would make
 * `review/session-resume` claim a session exists when none does.
 */
export function readInterruptedReviewSession(raw: unknown): InterruptedReviewSession | null {
  if (!isRecord(raw)) return null;
  const roomId = toTrimmedString(raw.roomId);
  const passNumber = toPassNumber(raw.passNumber);
  if (roomId.length === 0 || passNumber <= 0) return null;
  return {
    version: INTERRUPTED_REVIEW_SESSION_VERSION,
    roomId,
    passNumber,
    startedAt: toTrimmedString(raw.startedAt),
    savedAt: toTrimmedString(raw.savedAt) || toTrimmedString(raw.startedAt),
    qualityRating: toQualityRating(raw.qualityRating),
  };
}

/** Read the marker a canonical record's preserved fields carry, if any. */
export function readInterruptedReviewSessionFromFields(
  extraFields: Record<string, unknown> | undefined,
): InterruptedReviewSession | null {
  if (!extraFields) return null;
  return readInterruptedReviewSession(extraFields[INTERRUPTED_REVIEW_SESSION_KEY]);
}

/** Return the preserved fields with `session` written under the marker key. */
export function writeInterruptedReviewSessionToFields(
  extraFields: Record<string, unknown> | undefined,
  session: InterruptedReviewSession,
): Record<string, unknown> {
  return { ...(extraFields ?? {}), [INTERRUPTED_REVIEW_SESSION_KEY]: session };
}

/**
 * Return the preserved fields with the marker **removed**.
 *
 * The key is deleted rather than written as `null`, so a completed or discarded
 * review leaves no trace in the record and the byte shape of an untouched record
 * is unchanged.
 */
export function clearInterruptedReviewSessionFromFields(
  extraFields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extraFields || !(INTERRUPTED_REVIEW_SESSION_KEY in extraFields)) {
    return { ...(extraFields ?? {}) };
  }
  const next = { ...extraFields };
  delete next[INTERRUPTED_REVIEW_SESSION_KEY];
  return next;
}

/** Whether the marker names this room. A marker for another room is not a match. */
export function isInterruptedReviewSessionForRoom(
  session: InterruptedReviewSession | null,
  roomId: string,
): boolean {
  return session !== null && session.roomId === roomId;
}

/**
 * The one write the command layer performs for `review/session-save` and
 * `review/session-discard`.
 *
 * A discriminated union rather than two parameters, so "write a marker" and
 * "remove a marker" cannot be confused at a call site and so the discard branch
 * carries the room whose marker it is dropping.
 */
export type InterruptedReviewSessionWrite =
  | { readonly kind: 'save'; readonly session: InterruptedReviewSession }
  | { readonly kind: 'discard'; readonly roomId: string };

/**
 * Apply a marker write to a record's preserved fields.
 *
 * Pure, and the only place a marker is written or removed, so
 * `progressionStore.writeReviewSession` and `awardReviewPass` cannot disagree
 * about how a marker leaves a record.
 */
export function applyInterruptedReviewSessionWrite(
  extraFields: Record<string, unknown> | undefined,
  write: InterruptedReviewSessionWrite,
): Record<string, unknown> {
  if (write.kind === 'save') {
    return writeInterruptedReviewSessionToFields(extraFields, write.session);
  }
  const existing = readInterruptedReviewSessionFromFields(extraFields);
  // A discard for a room with no marker, or for a different room, is a no-op
  // rather than a clear: `review/session-discard` must never remove a *different*
  // room's resumable session on its way to reporting "nothing to discard".
  if (existing === null || existing.roomId !== write.roomId) {
    return { ...(extraFields ?? {}) };
  }
  return clearInterruptedReviewSessionFromFields(extraFields);
}

/**
 * Read the review-pass ledger *and* the marker out of one preserved-fields bag.
 *
 * The command layer needs both, and the store writes both in one record. Taking
 * them together from one read is what makes "decide, then write one record"
 * possible; splitting it would invite two reads of a value between them.
 */
export function readReviewRewardStateFromFields(
  extraFields: Record<string, unknown> | undefined,
): {
  ledger: ReturnType<typeof readReviewPassRewardLedgerFromFields>;
  session: InterruptedReviewSession | null;
} {
  return {
    ledger: readReviewPassRewardLedgerFromFields(extraFields),
    session: readInterruptedReviewSessionFromFields(extraFields),
  };
}
