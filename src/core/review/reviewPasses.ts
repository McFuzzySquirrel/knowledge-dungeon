/**
 * Pass-progress and review-unlock derivation.
 *
 * ## Why this file exists
 *
 * Three different answers to "how far through this review pass is the learner?"
 * already existed before Phase 16, and they disagree under a partially-cleared
 * dungeon:
 *
 * 1. `summarizeReviewAnalytics` (`reviewDomain.ts`) counts `reviewSessionCount`
 *    over the **reviewable** rooms and divides by the **reviewable** room count.
 * 2. `GameScreen.reviewProgress` takes `fullReviewPasses` from (1) and then counts
 *    `reviewedTowardNextPass` across **all** `dungeon.rooms`, dividing by
 *    `dungeon.rooms.length`.
 * 3. `studyFlow.finalizePendingReview` computes the same two numbers as (2) for
 *    the same toast copy.
 *
 * On a fully cleared dungeon the two populations are identical and nothing
 * disagrees. On a *partially* cleared dungeon they are not: a room that has never
 * been cleared is in `dungeon.rooms` and not in `reviewableRoomIds`, so
 * `roomsTowardNextPass` counts against a denominator those rooms can never
 * satisfy. The HUD progress bar and `RoomPanel`'s review card therefore show
 * `k/N` with `k < N` on a dungeon where every *reviewable* room has been
 * reviewed.
 *
 * ## The decision, and what changed
 *
 * **Both definitions are kept, each on its own population, in one function.**
 * `summarizeReviewPassProgress` reports:
 *
 * - `fullReviewPasses`, `nextPassTarget` - over the **reviewable** rooms, exactly
 *   as `summarizeReviewAnalytics` computes them and unchanged by this phase.
 * - `roomsTowardNextPass`, `totalRooms` - over **all** `dungeon.rooms`, exactly
 *   as `GameScreen.reviewProgress` computes them and unchanged by this phase.
 *
 * **Nothing observable changes.** The chosen pass-number definition for the
 * ledger is the reviewable-room one, because that is the number
 * `evaluatePhaseBadgeUnlocks` consumes through
 * `archaeologistFullReviewPasses`, and a ledger keyed on a number that a badge
 * threshold reads would be keyed on the wrong one. The displayed pair stays on the
 * all-rooms definition because `GameScreen` and `RoomPanel` render it, and
 * `ui-engineer` owns those files in parallel with this phase.
 *
 * **What this file does is make the divergence nameable and put one function
 * behind both numbers.** `summarizeReviewAnalytics` is left exactly as it is:
 * Phase 18 owns the statistics dashboard, `StudyStatsPanel` renders
 * `reviewData.fullReviewPasses` straight from it, and
 * `tests/unit/reviewDomain.test.ts` pins it. Correcting the *denominator* is a
 * Phase 18 decision with a Phase 18 dashboard change attached to it; this phase
 * records the inconsistency, centralizes the derivation, and changes no
 * displayed number.
 *
 * ## Unlock: one implementation, displayed and enforced
 *
 * `canReviewRoom` is the flow's enforcement and `evaluateReviewUnlock` is what
 * `RoomPanel` renders, and `canReviewRoom` calls `evaluateReviewUnlock`. That is
 * the whole property: there is one unlock rule in the codebase and the room panel
 * and the flow cannot disagree about it, because the flow asks the same question.
 */
import type { DungeonMetadata, RoomMetadata } from '@/core/validation/persistence';
import { daysSinceReviewDue, daysUntilReview, isReviewOverdue } from './spacedRepetition';
import {
  isReviewableRoom,
  evaluateReviewUnlock,
} from './reviewDomain';
import type { ReviewUnlockStatus } from './types';

function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * The room ids that are currently reviewable, in dungeon order.
 *
 * The one place the "is this room reviewable" filter is applied to a dungeon's
 * room list, so the flow, the analytics, and the pass derivation cannot enumerate
 * different populations.
 */
export function collectReviewableRoomIds(input: {
  dungeon: DungeonMetadata;
  rooms: Record<string, RoomMetadata>;
}): string[] {
  return input.dungeon.rooms
    .map((summary) => summary.roomId)
    .filter((roomId) => {
      const room = input.rooms[roomId];
      return room ? isReviewableRoom(room) : false;
    });
}

/** One coherent answer to "where is this learner in their review passes?". */
export interface ReviewPassProgressSnapshot {
  /**
   * Completed full review passes, over the **reviewable** rooms.
   *
   * Unchanged from `summarizeReviewAnalytics.fullReviewPasses`, and the number
   * the award ledger's pass number is derived from.
   */
  fullReviewPasses: number;
  /** `fullReviewPasses + 1`. The pass a room is currently being reviewed in. */
  nextPassTarget: number;
  /**
   * Rooms whose `reviewPassCount` has reached {@link nextPassTarget}, over
   * **all** `dungeon.rooms`.
   *
   * Unchanged from `GameScreen.reviewProgress`. See this file's header.
   */
  roomsTowardNextPass: number;
  /** `dungeon.rooms.length`. The denominator {@link roomsTowardNextPass} uses. */
  totalRooms: number;
  /**
   * Room ids whose `reviewPassCount` has reached {@link nextPassTarget}.
   *
   * Derived rather than recomputed by each caller, so a surface that wants to
   * highlight the reviewed rooms cannot disagree with the count it is drawn from.
   */
  reviewedRoomIds: string[];
}

/**
 * Derive the review pass progress for a subject.
 *
 * Pure and total: an empty dungeon, a room the snapshot does not list, and a
 * non-integer `reviewPassCount` all produce a snapshot rather than throwing,
 * because a view model may ask about a room that has just been removed.
 */
export function summarizeReviewPassProgress(input: {
  rooms: Record<string, RoomMetadata>;
  reviewableRoomIds: readonly string[];
  /** Defaults to every room in `rooms`; only used for the all-rooms population. */
  roomIds?: readonly string[];
}): ReviewPassProgressSnapshot {
  const reviewableSet = new Set(input.reviewableRoomIds);
  const allRoomIds = input.roomIds ?? Object.keys(input.rooms);

  let reviewSessionCount = 0;
  for (const roomId of reviewableSet) {
    const room = input.rooms[roomId];
    if (!room) continue;
    reviewSessionCount += toNonNegativeInteger(room.reviewPassCount);
  }
  const totalReviewableRooms = reviewableSet.size;
  const fullReviewPasses =
    totalReviewableRooms > 0 ? Math.trunc(reviewSessionCount / totalReviewableRooms) : 0;
  const nextPassTarget = fullReviewPasses + 1;

  const reviewedRoomIds = allRoomIds.filter((roomId) => {
    const room = input.rooms[roomId];
    return room ? toNonNegativeInteger(room.reviewPassCount) >= nextPassTarget : false;
  });

  return {
    fullReviewPasses,
    nextPassTarget,
    roomsTowardNextPass: reviewedRoomIds.length,
    totalRooms: allRoomIds.length,
    reviewedRoomIds,
  };
}

/**
 * Convenience wrapper that derives both the reviewable set and the pass progress.
 *
 * What `studyFlow` and the Phase 16 workspace call, so the two never enumerate
 * the reviewable rooms differently.
 */
export function deriveReviewPassProgress(input: {
  dungeon: DungeonMetadata;
  rooms: Record<string, RoomMetadata>;
}): ReviewPassProgressSnapshot {
  return summarizeReviewPassProgress({
    rooms: input.rooms,
    reviewableRoomIds: collectReviewableRoomIds(input),
    roomIds: input.dungeon.rooms.map((summary) => summary.roomId),
  });
}

/**
 * The pass number a review of this room belongs to **right now**, one-based.
 *
 * `fullReviewPasses + 1` over the reviewable rooms, which is the identity input
 * for {@link toReviewPassRewardIdentity}. Named separately because it is the one
 * number the award ledger and the badge thresholds must agree on, and a caller
 * that recomputed it inline is how the two drifted apart in the first place.
 */
export function currentReviewPassNumber(progress: ReviewPassProgressSnapshot): number {
  return progress.fullReviewPasses + 1;
}

// ── Due state ───────────────────────────────────────────────────────────────

/**
 * Whether a room's review is due now, due today, or scheduled ahead.
 *
 * A discriminated union with the day count already resolved, so a surface cannot
 * compute a day number with its own arithmetic and disagree with the badge or the
 * sort order another surface used.
 */
export type ReviewDueState =
  | { readonly kind: 'overdue'; readonly days: number }
  | { readonly kind: 'due-today'; readonly days: 0 }
  | { readonly kind: 'due-in'; readonly days: number };

/**
 * Describe when a room is next due, using the SM-2 module's own date helpers.
 *
 * `isReviewOverdue`, `daysUntilReview`, and `daysSinceReviewDue` are imported,
 * never reimplemented: this phase changes review *policy*, and re-deriving SM-2's
 * date comparison here would be the second implementation that
 * `spacedRepetition.ts` exists to prevent.
 *
 * A room with no `nextReviewDateIso` is `due-in 0`: a room which has never been
 * scheduled is not overdue and not late, and inventing a fourth `never-scheduled`
 * variant would put a presentation decision ("new") in the domain.
 *
 * `days` means different things per branch and the branch says which: `overdue`
 * counts days **since** the date, `due-in` counts days **until** it, and
 * `due-today` is always 0.
 */
export function describeReviewDueState(input: {
  nextReviewDateIso: string | null | undefined;
  nowIso: string;
}): ReviewDueState {
  const nextReviewDateIso = input.nextReviewDateIso?.trim() ?? '';
  if (nextReviewDateIso.length === 0) {
    return { kind: 'due-in', days: 0 };
  }
  if (isReviewOverdue(nextReviewDateIso, input.nowIso)) {
    // `isReviewOverdue` is a timestamp comparison and the day helpers are
    // calendar-day comparisons, so an overdue room can still report 0 days: same
    // calendar day, earlier time. That is `due-today`, not `overdue`, and the
    // distinction is the difference between "due this morning" and "three days
    // late".
    const days = daysSinceReviewDue(nextReviewDateIso, input.nowIso);
    return days <= 0 ? { kind: 'due-today', days: 0 } : { kind: 'overdue', days };
  }
  const days = daysUntilReview(nextReviewDateIso, input.nowIso);
  return days <= 0 ? { kind: 'due-today', days: 0 } : { kind: 'due-in', days };
}

// ── Unlock enforcement ──────────────────────────────────────────────────────

/** Why a room may not be reviewed yet. */
export type ReviewRoomRefusal = 'room-not-cleared' | 'review-locked';

/** The flow's answer to "may this room be reviewed right now?". */
export type ReviewRoomPermission =
  | {
      readonly allowed: true;
      /** The same evaluation `RoomPanel` renders, returned rather than recomputed. */
      readonly unlock: ReviewUnlockStatus;
    }
  | {
      readonly allowed: false;
      readonly reason: ReviewRoomRefusal;
      /** The same evaluation `RoomPanel` renders, returned rather than recomputed. */
      readonly unlock: ReviewUnlockStatus;
    };

/**
 * The single unlock question, asked the single way.
 *
 * Delegates to {@link evaluateReviewUnlock} - the function `RoomPanel` calls to
 * draw the "Archaeologist unlock" card - so the displayed unlock and the enforced
 * unlock are literally the same call. There is no second ratio, no second
 * threshold, and no flow-local condition.
 *
 * `room-not-cleared` is checked first because it is the more specific condition:
 * a learner who has not defeated an encounter has no review to complete, whatever
 * the dungeon's completion ratio is.
 */
export function canReviewRoom(input: {
  dungeon: DungeonMetadata;
  rooms: Record<string, RoomMetadata>;
  roomId: string;
  requiredCompletionRatio?: number;
}): ReviewRoomPermission {
  const unlock = evaluateReviewUnlock({
    dungeon: input.dungeon,
    rooms: input.rooms,
    ...(input.requiredCompletionRatio === undefined
      ? {}
      : { requiredCompletionRatio: input.requiredCompletionRatio }),
  });
  const room = input.rooms[input.roomId];
  if (!room || !isReviewableRoom(room)) {
    return { allowed: false, reason: 'room-not-cleared', unlock };
  }
  if (!unlock.unlocked) {
    return { allowed: false, reason: 'review-locked', unlock };
  }
  return { allowed: true, unlock };
}

/**
 * The cleared-room count at which this unlock reports itself reached, derived from
 * the unlock's **own** ratio rather than from its total.
 *
 * `evaluateReviewUnlock` unlocks on `clearedRooms / totalRooms >= requiredCompletionRatio`,
 * and `clearedRooms` is an integer, so the smallest satisfying count is
 * `ceil(ratio * totalRooms)`.
 *
 * **`ceil`, and not `round` or `floor`,** because both of those can name a
 * threshold at which the room is *still locked*. At `requiredCompletionRatio: 0.24`
 * on ten rooms the predicate needs three cleared rooms; `Math.round(2.4)` says two.
 * The learner would clear "2/10 rooms", satisfy the sentence, and be refused again
 * - with nothing on screen to say which of the sentence and the rule is wrong. Only
 * `ceil` guarantees that the number printed here is one at which the unlock fires.
 *
 * The `?? 1` matches `evaluateReviewUnlock`'s own default, so a status that arrives
 * without a ratio - a hand-built one, or a persisted status from before the ratio
 * was carried - reads as the all-rooms rule this sentence has always described.
 */
function requiredRoomsForUnlock(unlock: ReviewUnlockStatus): number {
  const ratio = Number.isFinite(unlock.requiredCompletionRatio)
    ? Math.min(1, Math.max(0, unlock.requiredCompletionRatio))
    : 1;
  return Math.max(0, Math.min(unlock.totalRooms, Math.ceil(ratio * unlock.totalRooms)));
}

/**
 * The refusal sentence for a room that cannot be reviewed, in the same register
 * as the other flow messages.
 *
 * Carries the unlock's own counts so a surface can show *why*, without a second
 * evaluation. No topic, no room name, no learner content.
 */
export function describeReviewRefusal(input: {
  reason: ReviewRoomRefusal;
  unlock: ReviewUnlockStatus;
}): string {
  if (input.reason === 'room-not-cleared') {
    return 'Defeat this room encounter before reviewing it.';
  }
  // The threshold is the unlock's own `requiredRoomsForUnlock`, never `totalRooms`.
  // Printing `${totalRooms}/${totalRooms}` is right only for the default
  // `requiredCompletionRatio: 1`; at any lower ratio it overstates the requirement -
  // a learner on a half-required dungeon is told they need all ten cleared when five
  // would unlock review, and at eight of ten they would be reading a progress
  // sentence for a threshold the unlock stopped enforcing three rooms earlier. At
  // the default ratio this is byte-identical to the pre-Phase-16 sentence.
  const requiredRooms = requiredRoomsForUnlock(input.unlock);
  return `Review unlocks at ${requiredRooms}/${input.unlock.totalRooms} rooms cleared (${input.unlock.clearedRooms} so far).`;
}
