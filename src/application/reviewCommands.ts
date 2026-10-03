/**
 * Archaeologist review application layer.
 *
 * ## The defects this exists for
 *
 * `studyFlow.finalizePendingReview` did four things wrong, and the first three are
 * about one of them:
 *
 * 1. **The award could be double-counted.** It computed
 *    `shouldAwardReviewXp = room.reviewPassCount < fullReviewPasses + 1` from a
 *    live read, then called `void store.recordReviewPass(roomId)` - an
 *    unawaited async write to a *different* store - and then
 *    `store.awardReviewPass()`. Two finalizations in one tick both read the same
 *    committed counter and both paid. Plan 5.2 requires "review completion is
 *    recorded exactly once per room per pass", and a comparison against a counter
 *    an asynchronous writer owns cannot enforce it. Here the award is a durable
 *    (room, pass) ledger entry written in the same record write as the XP.
 * 2. **The rating could never be supplied.** `subjectStore.recordReviewPass`
 *    defaulted `qualityRating` to `3` and the `StudyFlowStorePort` signature was
 *    `recordReviewPass(roomId: string)`, so SM-2 always advanced as "correct with
 *    serious difficulty" - while `src/data/gameGuide.ts` told learners "rate your
 *    recall on a 0-5 scale" and "easy cards get longer intervals; hard cards
 *    repeat sooner". The payload of `review/pass-complete` requires the rating,
 *    so it is now in the type.
 * 3. **The unlock was displayed but not enforced.** `evaluateReviewUnlock` was
 *    drawn in `RoomPanel` and consulted nowhere else, and `roomInteract` armed a
 *    review for any `finalPass` room. Every precondition here asks
 *    `canReviewRoom`, which *calls* `evaluateReviewUnlock`.
 * 4. **An interrupted review was lost on exit.** See
 *    `src/core/review/interruptedReviewSession.ts`.
 *
 * ## Plain TypeScript, like `encounterCommands.ts`
 *
 * No React, no renderer, no DOM, no store import, no clock of its own. Every side
 * effect - read the snapshot, write the reward, write the marker, record the SM-2
 * update - is an injected port. No renderer imports appear anywhere in the closure
 * of this module.
 *
 * ## Why these commands are synchronous
 *
 * `finalizePendingReview` returns `void` and is called from a synchronous
 * `closeInfoPanel`, and `tests/contracts/phase-2-study-flow.test.ts` pins that the
 * panel closes *before* the review is recorded - an assertion about
 * `mock.invocationCallOrder`, which is only meaningful if the call happens in the
 * same tick. The one async write in the transaction,
 * `subjectStore.recordReviewPass`, was already fire-and-forget before Phase 16
 * (`void store.recordReviewPass(roomId)`), so making the commands synchronous
 * preserves the contract exactly and changes no durability: the write whose
 * atomicity matters - the progression record - is synchronous.
 *
 * The consequence is stated rather than hidden: there is no promise here to
 * reject, so a subject-store persistence failure is unobserved by the caller, as
 * it was before this phase. `saveSubjectSnapshot` reports failure as
 * `{ success: false }` rather than throwing, and `recordReviewPass` does not read
 * it, so there is no rejection to surface in any case.
 *
 * ## The ordering of the four writes
 *
 * `review/pass-complete` performs exactly three writes, in this order:
 *
 * | # | Write | Store | Atomic with |
 * |---|-------|-------|--------------|
 * | 1 | durable ledger entry + XP + rank + `reviewPasses` + marker clear | progression | itself - one `set` of one record |
 * | 2 | `reviewPassCount` + the SM-2 schedule, only when (1) awarded | subject | nothing |
 * | 3 | phase badges | progression | nothing |
 *
 * **Pay first, then schedule.** That order is the whole argument:
 *
 * - If (2) landed first and (1) then failed, the room's `reviewPassCount` would
 *   have advanced with no XP and no guard. On the next finalize the pass number
 *   moves up, so the reward for the pass the learner actually completed would be
 *   **permanently skipped** - a reward lost with nothing to suppress it.
 * - With (1) first, a failed (2) leaves the ledger entry and the XP. The next
 *   finalize of the same pass re-derives the *same* pass number (the totals that
 *   determine it did not change) and is correctly suppressed. The worst case is
 *   that `reviewPassCount` and the SM-2 schedule lag one review behind; the
 *   learner's XP and awarded-once history are intact and the pass completes on
 *   the next review.
 *
 * The marker clear rides inside (1) for the same reason: a finished review must
 * not be left resumable even if the SM-2 write fails.
 *
 * **What cannot be made atomic, plainly:** (1) and (2) are two different stores.
 * There is no cross-store transaction in this application, and adding one would be
 * a data-format change outside this phase. A single-storage device therefore can
 * still end up with the ledger ahead of the SM-2 state. The chosen order makes
 * that direction the recoverable one. (3) is a separate `set` per badge and is
 * already idempotent (`awardBadge` returns `false` for a badge already held).
 *
 * **`review/session-save` writes no SM-2 state at all.** A review the learner did
 * not finish has not been recalled, so scheduling the next review from it would
 * make SM-2 reward an unfinished session and would inflate `reviewPassCount`,
 * which is the input to the pass number. It writes one thing - a resumable marker,
 * in one record write - and records the learner's rating beside it for the surface
 * to restore.
 *
 * ## Refusals, not throws
 *
 * The four preconditions (no active subject, unknown room, room not reviewable,
 * review not unlocked) are typed refusals carrying a condition message, in the
 * same register as `encounterCommands.ts`. The two the subject store already throws
 * for reuse `submitNote`'s own strings, so a surface that toasts `error.message`
 * shows the same words whichever lane answered.
 *
 * ## Two routes into one command, and one deliberate disagreement
 *
 * `review/pass-complete` has two callers and they do not agree about the rating,
 * which is the only place in this layer where two routes differ:
 *
 * | Route | Rating that reaches SM-2 |
 * |---|---|
 * | the Archaeologist workspace's own explicit pass-complete | the learner's rating |
 * | the room panel's close button, via `studyFlow.finalizePendingReview` | {@link CLOSED_WITHOUT_RATING_QUALITY}, always |
 *
 * That is a decision, not an oversight, and its full argument - including the cost
 * a learner on the panel-close route pays - is on the constant. {@link CLOSED_WITHOUT_RATING_QUALITY}
 * is where to look; this paragraph exists so it is found from the header, and
 * `finalizePendingReview` carries a second copy at the call site.
 *
 * ## Privacy
 *
 * No renderer imports. No learner data in any id, key, message, or log: identities
 * are app-minted room ids and an integer pass number, and every message here is a
 * condition sentence. Nothing fetches, uploads, or forms a request.
 */
import {
  isInterruptedReviewSessionForRoom,
  readInterruptedReviewSessionFromFields,
  type InterruptedReviewSession,
  type InterruptedReviewSessionWrite,
} from '@/core/review/interruptedReviewSession';
import {
  canReviewRoom,
  currentReviewPassNumber,
  deriveReviewPassProgress,
  type ReviewPassProgressSnapshot,
} from '@/core/review/reviewPasses';
import { toReviewPassRewardIdentity } from '@/core/review/reviewPassRewards';
import type { QualityRating } from '@/core/review/spacedRepetition';
import type { RankTier } from '@/core/progression/types';
import type { ReviewPassRewardIdentity } from '@/core/review/reviewPassRewards';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import type {
  ReviewCommand,
  ReviewCommandName,
  ReviewPassCompletePayload,
  ReviewSessionDiscardPayload,
  ReviewSessionResumePayload,
  ReviewSessionSavePayload,
} from './contracts/commands';

/**
 * The rating the panel-close route records: the learner closed the room panel
 * without ever answering a rating question.
 *
 * **This is a real rating of `3` - "Correct, required serious mental effort" - not
 * the absence of one.** It is written into SM-2 and it moves the room's next review
 * date. The name says *when* it applies rather than what the value is, because
 * "when" is the part a caller has to get right and the number is stated here. An
 * earlier name, `UNRATED_REVIEW_QUALITY`, said the opposite of what the constant
 * does and was the reason a learner-facing sentence had to correct its own
 * upstream name.
 *
 * ## Why the panel-close route ignores the learner's chosen rating
 *
 * The route predates this phase, is reachable from `closeInfoPanel` in every host,
 * and must stay reachable **with no rating control anywhere on screen** - the
 * rollback lane, where the Phase 16 workspace flag is off, renders the pre-Phase-16
 * notes tab and its "Done reviewing" button with nothing to rate. So "honour the
 * rating" is not a rule that lane can satisfy; there is no rating on it to honour.
 *
 * The case for keeping the divergence rather than deferring the whole question:
 *
 * - **The ledger makes it safe, not merely defensible.** The award is keyed on
 *   `(roomId, passNumber)` and the SM-2 write is gated on `!duplicate`, so a panel
 *   close can neither double-pay nor double-schedule. The cost is scheduling
 *   drift, not corrupted or repeated progression.
 * - **The drift is in the conservative direction.** A learner on this route always
 *   gets `3`, so SM-2 schedules them as "correct, with effort" - shorter intervals
 *   than a self-rated `4` or `5` would produce, longer than a `0`-`2`. The error
 *   direction is *more* review of the room, not less.
 * - **The learner is told the number.** The workspace states this rating verbatim
 *   before they close the panel, so the outcome is disclosed rather than implied.
 *
 * **The cost, stated rather than hidden: a learner who rates a room `5` in the
 * workspace and then closes the panel is recorded as a `3`, and their schedule
 * drifts toward "correct with serious difficulty".** One learner action, two
 * different SM-2 outcomes depending on the surface that carried it out. It is
 * accepted for this phase because closing the gap is a user-visible behaviour
 * change, because it moves the Phase 2 contract pin (`recordReviewPass` called with
 * exactly one argument), and because the honest copy is available immediately
 * while the behaviour change needs its own phase.
 *
 * A unification exists and is deliberately **not** implemented here. The naive
 * form - "let the workspace complete the pass explicitly and let the panel close be
 * a duplicate the ledger suppresses" - is wrong in one case and needs more than the
 * ledger: `finalizePendingReview` says why.
 *
 * ## The one-argument carve-out
 *
 * `subjectStore.recordReviewPass` has treated "no rating" as `3` since Phase 4a.
 * `studyFlow` therefore routes this value to the **one-argument** store call, which
 * keeps `tests/contracts/phase-2-study-flow.test.ts`'s assertion and the rollback
 * lane's narrower store signature working. An explicit learner rating of `3`
 * therefore also reaches the one-argument call and computes the identical SM-2
 * update: there is no second rating path for the same number. That store-side
 * default is the store's own decision and is deliberately *not* shared by import -
 * see the note at `recordReviewPass` in `src/store/subjectStore.ts` for why, and
 * what would break if the two ever stopped agreeing.
 */
export const CLOSED_WITHOUT_RATING_QUALITY: QualityRating = 3;

// ── Ports ───────────────────────────────────────────────────────────────────

/** The subject store, as this module is allowed to see it. */
export interface ReviewSubjectStorePort {
  /** Live subject snapshot, or `null` when no subject is loaded. */
  readSnapshot(): SubjectSnapshot | null;
  /**
   * Increment `reviewPassCount` and advance SM-2 from the rating.
   *
   * Resolves with nothing. Fire-and-forget here for the reason this module's
   * header gives; the store itself returns early when the room has vanished, which
   * is why the outcome reports the reward rather than the SM-2 write.
   */
  recordReviewPass(roomId: string, qualityRating: QualityRating): Promise<void>;
}

/** What the reward transaction reports about the award itself. */
export interface ReviewPassRewardOutcome {
  /**
   * False when the ledger already held this exact (room, pass), **or** when the
   * progression store had no active subject to pay. Read with {@link duplicate}.
   */
  awarded: boolean;
  /**
   * True when the award was suppressed because the durable ledger already held
   * this (room, pass).
   *
   * The mandatory discriminator: `awarded: false` alone covers a repeat, a
   * suppressed duplicate under React StrictMode, and a store with no active
   * subject, and a caller that branches on `!awarded` alone will tell a learner a
   * sentence about one cause when a different one produced it.
   */
  duplicate: boolean;
  xpGained: number;
  newRank: RankTier;
  rankChanged: boolean;
  unlockedAchievements: string[];
}

/**
 * The reward transaction and the durable marker store, as this module sees them.
 *
 * `readPreservedFields` / `writeReviewSession` are how the interrupted-review
 * marker is persisted. They are progression-store writes because the marker
 * rides in the same record as the ledger - see
 * `src/core/review/interruptedReviewSession.ts` for the four options weighed and
 * why the subject record's carrier was rejected on evidence.
 */
export interface ReviewProgressionPort {
  /**
   * Award the review pass, consulting and writing the durable ledger in the same
   * record write as the XP.
   */
  awardReviewPass(review: ReviewPassRewardIdentity): ReviewPassRewardOutcome;
  /**
   * The active subject record's preserved app-owned fields, as they stand.
   *
   * Read once per command so "decide, then write one record" is possible.
   */
  readPreservedFields(): Record<string, unknown> | undefined;
  /** Write or drop the interrupted-review marker. One record write. */
  writeReviewSession(write: InterruptedReviewSessionWrite): void;
}

/** Everything {@link createReviewController} needs. */
export interface ReviewCommandDeps {
  subject: ReviewSubjectStorePort;
  progression: ReviewProgressionPort;
  /** Wall clock, so every injected timestamp is deterministic in a test. */
  nowIso(): string;
}

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * Refusal codes.
 *
 * `NO_ACTIVE_SUBJECT` and `ROOM_NOT_FOUND` restate the two conditions the subject
 * store throws for. `ROOM_NOT_REVIEWABLE` and `REVIEW_LOCKED` are this layer's
 * own: the first is the room's own state, the second is
 * `canReviewRoom`'s verdict, which is the same call `RoomPanel` renders.
 */
export type ReviewCommandErrorCode =
  | 'NO_ACTIVE_SUBJECT'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_NOT_REVIEWABLE'
  | 'REVIEW_LOCKED';

/** A refusal: a condition the learner can be told about, not an exception. */
export interface ReviewCommandError {
  code: ReviewCommandErrorCode;
  /** A condition message. Never learner content. */
  message: string;
  /** The room the command was about, when there was one. */
  details?: Record<string, unknown>;
}

/** The result of one review command. */
export type ReviewCommandResult<T> = { ok: true; value: T } | { ok: false; error: ReviewCommandError };

// ── Outcomes ────────────────────────────────────────────────────────────────

/** `review/pass-complete`. */
export interface ReviewPassCompleteOutcome {
  command: 'review/pass-complete';
  roomId: string;
  /** The rating that reached SM-2. */
  qualityRating: QualityRating;
  /** The durable (room, pass) identity the award was decided on. */
  reviewIdentity: ReviewPassRewardIdentity;
  /**
   * Pass progress **as it stands after this review**.
   *
   * Derived from the pre-increment snapshot with this room's count advanced by
   * one, because the SM-2 write is asynchronous and the snapshot the caller holds
   * has not moved. Deriving it afterwards from a re-read would report a number
   * that is one review stale, which is exactly the badge-input drift plan 5.2
   * warns about.
   */
  passProgress: ReviewPassProgressSnapshot;
  /** Whether the award happened, and whether it was a repeat. */
  progression: ReviewPassRewardOutcome;
  /** Whether this call found and cleared a resumable marker for this room. */
  resumedSessionDiscarded: boolean;
}

/** `review/session-save`. */
export interface ReviewSessionSaveOutcome {
  command: 'review/session-save';
  roomId: string;
  /** The marker now durable for this subject. */
  session: InterruptedReviewSession;
  /**
   * Always `null`.
   *
   * Present so "no reward" is in the type: a saved-but-unfinished review must not
   * be able to award.
   */
  progression: null;
}

/** `review/session-discard`. */
export interface ReviewSessionDiscardOutcome {
  command: 'review/session-discard';
  roomId: string;
  /** Whether a marker for **this** room existed and was removed. */
  discarded: boolean;
  /** The marker for another room, left untouched. */
  keptForOtherRoom: InterruptedReviewSession | null;
  /** Always `null`. An abandoned review awards nothing. */
  progression: null;
}

/** `review/session-resume`. */
export interface ReviewSessionResumeOutcome {
  command: 'review/session-resume';
  roomId: string;
  /** Whether a resumable review for this room existed. */
  resumed: boolean;
  /** The marker, when this room had one. */
  session: InterruptedReviewSession | null;
  /** A marker for a different room, so a surface can say what is waiting. */
  waitingForRoomId: string | null;
  /** Always `null`. Resuming awards nothing on its own. */
  progression: null;
}

/** Every review outcome, discriminated by command. */
export type ReviewOutcome =
  | ReviewPassCompleteOutcome
  | ReviewSessionSaveOutcome
  | ReviewSessionDiscardOutcome
  | ReviewSessionResumeOutcome;

/** The result of one named review command. */
export type ReviewResult<C extends ReviewCommandName> = ReviewCommandResult<
  Extract<ReviewOutcome, { command: C }>
>;

// ── Shared answers ──────────────────────────────────────────────────────────

/**
 * The messages the subject store throws for its two preconditions.
 *
 * Not invented: they are `submitNote`'s own strings, so a surface that toasts
 * `error.message` shows the same words whichever lane answered. A condition
 * message is not learner data.
 */
const NO_ACTIVE_SUBJECT_MESSAGE = 'No active subject';
const ROOM_NOT_FOUND_MESSAGE = 'Room not found';

/** The room-has-not-been-defeated refusal. */
const ROOM_NOT_REVIEWABLE_MESSAGE =
  'Defeat this room encounter before reviewing it.';

/** The dungeon's completion ratio has not reached the review unlock yet. */
const REVIEW_LOCKED_MESSAGE = 'Clear every room encounter to unlock full review mode.';

/** The no-active-subject refusal. */
function noActiveSubject(): ReviewCommandResult<never> {
  return { ok: false, error: { code: 'NO_ACTIVE_SUBJECT', message: NO_ACTIVE_SUBJECT_MESSAGE } };
}

/** The unknown-room refusal, carrying the room that was asked for. */
function roomNotFound(roomId: string): ReviewCommandResult<never> {
  return {
    ok: false,
    error: { code: 'ROOM_NOT_FOUND', message: ROOM_NOT_FOUND_MESSAGE, details: { roomId } },
  };
}

/**
 * The room, plus the two review preconditions, or the typed refusal.
 *
 * `requireReviewableRoom` is where `canReviewRoom` is called, so no review command
 * can reach the reward transaction without passing the unlock the room panel is
 * displaying.
 */
function requireReviewableRoom(
  deps: ReviewCommandDeps,
  roomId: string,
): ReviewCommandResult<{ snapshot: SubjectSnapshot; roomId: string }> {
  const snapshot = deps.subject.readSnapshot();
  if (!snapshot) return noActiveSubject();
  const room = snapshot.rooms[roomId];
  if (!room) return roomNotFound(roomId);

  const permission = canReviewRoom({
    dungeon: snapshot.dungeon,
    rooms: snapshot.rooms,
    roomId,
  });
  if (!permission.allowed) {
    return permission.reason === 'room-not-cleared'
      ? {
          ok: false,
          error: {
            code: 'ROOM_NOT_REVIEWABLE',
            message: ROOM_NOT_REVIEWABLE_MESSAGE,
            details: { roomId },
          },
        }
      : {
          ok: false,
          error: {
            code: 'REVIEW_LOCKED',
            message: REVIEW_LOCKED_MESSAGE,
            details: {
              roomId,
              clearedRooms: permission.unlock.clearedRooms,
              totalRooms: permission.unlock.totalRooms,
            },
          },
        };
  }
  return { ok: true, value: { snapshot, roomId } };
}

// ── Commands ────────────────────────────────────────────────────────────────

/** `review/pass-complete`. */
function runPassComplete(
  deps: ReviewCommandDeps,
  payload: ReviewPassCompletePayload,
): ReviewCommandResult<ReviewPassCompleteOutcome> {
  const lookup = requireReviewableRoom(deps, payload.roomId);
  if (!lookup.ok) return lookup as ReviewCommandResult<ReviewPassCompleteOutcome>;
  const { snapshot } = lookup.value;

  // Pre-increment, and from the snapshot the reward is about to be decided
  // against. `fullReviewPasses + 1` is the pass number, which is stable for every
  // room in one pass and identical across same-tick duplicates because both read
  // the same committed totals. See `src/core/review/reviewPassRewards.ts`.
  const before = deriveReviewPassProgress({ dungeon: snapshot.dungeon, rooms: snapshot.rooms });
  const passNumber = currentReviewPassNumber(before);
  const reviewIdentity = toReviewPassRewardIdentity({ roomId: payload.roomId, passNumber });

  const markerBefore = readInterruptedReviewSessionFromFields(
    deps.progression.readPreservedFields(),
  );
  const resumedSessionDiscarded = isInterruptedReviewSessionForRoom(
    markerBefore,
    payload.roomId,
  );

  // 1. The durable write: ledger + XP + rank + `reviewPasses` + the marker clear,
  //    all in one `set` of one record. Paid before the schedule is recorded -
  //    see this module's header for why that order is the recoverable one.
  const progression = deps.progression.awardReviewPass(reviewIdentity);

  // 2. The SM-2 schedule and `reviewPassCount`, in the subject store, which is a
  //    different record and not in that transaction.
  //
  //    **Gated on the award**, and that is a Phase 16 behaviour change with a
  //    reason: `reviewPassCount` is the input to `fullReviewPasses`, which is a
  //    badge threshold, so a duplicate close that incremented it would inflate a
  //    badge *and* walk the pass number forward - the next sibling room's genuine
  //    first-pass review would then be labelled pass 2. Recording it once per
  //    (room, pass) is what plan 5.2's "review completion is recorded exactly once
  //    per room per pass" means for the scheduling half of the write.
  if (!progression.duplicate) {
    void deps.subject.recordReviewPass(payload.roomId, payload.qualityRating);
  }

  const room = snapshot.rooms[payload.roomId];
  const after = deriveReviewPassProgress({
    dungeon: snapshot.dungeon,
    rooms: {
      ...snapshot.rooms,
      [payload.roomId]: room ? { ...room, reviewPassCount: room.reviewPassCount + 1 } : room,
    },
  });

  return {
    ok: true,
    value: {
      command: 'review/pass-complete',
      roomId: payload.roomId,
      qualityRating: payload.qualityRating,
      reviewIdentity,
      passProgress: after,
      progression,
      resumedSessionDiscarded,
    },
  };
}

/** `review/session-save`. */
function runSessionSave(
  deps: ReviewCommandDeps,
  payload: ReviewSessionSavePayload,
): ReviewCommandResult<ReviewSessionSaveOutcome> {
  const lookup = requireReviewableRoom(deps, payload.roomId);
  if (!lookup.ok) return lookup as ReviewCommandResult<ReviewSessionSaveOutcome>;
  const { snapshot } = lookup.value;

  const existing = readInterruptedReviewSessionFromFields(deps.progression.readPreservedFields());
  const passNumber = currentReviewPassNumber(
    deriveReviewPassProgress({ dungeon: snapshot.dungeon, rooms: snapshot.rooms }),
  );
  const nowIso = deps.nowIso();
  const session: InterruptedReviewSession = {
    version: 1,
    roomId: payload.roomId,
    passNumber,
    // A re-save of the same room keeps the original start, so "how long has this
    // been open" stays one number instead of resetting on every save.
    startedAt: existing?.roomId === payload.roomId ? existing.startedAt || nowIso : nowIso,
    savedAt: nowIso,
    qualityRating: payload.qualityRating,
  };

  // One record write. No reward and no SM-2 state: the learner has not recalled
  // this room yet, and scheduling from an unfinished review would reward it.
  deps.progression.writeReviewSession({ kind: 'save', session });

  return {
    ok: true,
    value: {
      command: 'review/session-save',
      roomId: payload.roomId,
      session,
      progression: null,
    },
  };
}

/** `review/session-discard`. */
function runSessionDiscard(
  deps: ReviewCommandDeps,
  payload: ReviewSessionDiscardPayload,
): ReviewCommandResult<ReviewSessionDiscardOutcome> {
  const lookup = deps.subject.readSnapshot();
  if (!lookup) return noActiveSubject() as ReviewCommandResult<ReviewSessionDiscardOutcome>;
  if (!lookup.rooms[payload.roomId]) {
    return roomNotFound(payload.roomId) as ReviewCommandResult<ReviewSessionDiscardOutcome>;
  }

  const existing = readInterruptedReviewSessionFromFields(deps.progression.readPreservedFields());
  const discarded = isInterruptedReviewSessionForRoom(existing, payload.roomId);

  // `applyInterruptedReviewSessionWrite` is a no-op for a discard that names a
  // room with no marker, or a different room, so a discard can never remove
  // somebody else's resumable session on its way to reporting "nothing to
  // discard". The store still performs its one record write so the decision and
  // the write cannot be reordered.
  deps.progression.writeReviewSession({ kind: 'discard', roomId: payload.roomId });

  return {
    ok: true,
    value: {
      command: 'review/session-discard',
      roomId: payload.roomId,
      discarded,
      keptForOtherRoom:
        existing !== null && existing.roomId !== payload.roomId ? existing : null,
      progression: null,
    },
  };
}

/** `review/session-resume`. */
function runSessionResume(
  deps: ReviewCommandDeps,
  payload: ReviewSessionResumePayload,
): ReviewCommandResult<ReviewSessionResumeOutcome> {
  const lookup = deps.subject.readSnapshot();
  if (!lookup) return noActiveSubject() as ReviewCommandResult<ReviewSessionResumeOutcome>;
  if (!lookup.rooms[payload.roomId]) {
    return roomNotFound(payload.roomId) as ReviewCommandResult<ReviewSessionResumeOutcome>;
  }

  const existing = readInterruptedReviewSessionFromFields(deps.progression.readPreservedFields());
  const session = isInterruptedReviewSessionForRoom(existing, payload.roomId) ? existing : null;

  // A read-only command: it writes nothing. Resuming is "there is something to
  // resume", and completing is `review/pass-complete`.
  return {
    ok: true,
    value: {
      command: 'review/session-resume',
      roomId: payload.roomId,
      resumed: session !== null,
      session,
      waitingForRoomId:
        existing !== null && existing.roomId !== payload.roomId ? existing.roomId : null,
      progression: null,
    },
  };
}

/**
 * Apply a marker write without running a command.
 *
 * Exported because `studyFlow` needs to keep the marker in step with an *armed*
 * review - opening a cleared room's panel is `session-save` with no rating - and
 * it must be the same write, not a second one.
 */
export function writeReviewSessionMarker(
  deps: ReviewCommandDeps,
  write: InterruptedReviewSessionWrite,
): void {
  deps.progression.writeReviewSession(write);
}

/**
 * Read the marker a record currently carries.
 *
 * For a surface that wants to offer "resume" before any command runs, and for the
 * exit branch of the flow that reports what it left behind.
 */
export function readReviewSessionMarker(
  deps: ReviewCommandDeps,
): InterruptedReviewSession | null {
  return readInterruptedReviewSessionFromFields(deps.progression.readPreservedFields());
}

// ── Controller ──────────────────────────────────────────────────────────────

/** The Archaeologist review surface. */
export interface ReviewController {
  /** `review/pass-complete` - rate the recall, take the reward, clear the marker. */
  passComplete(payload: ReviewPassCompletePayload): ReviewResult<'review/pass-complete'>;
  /** `review/session-save` - park an unfinished review. No SM-2, no reward. */
  sessionSave(payload: ReviewSessionSavePayload): ReviewResult<'review/session-save'>;
  /** `review/session-discard` - abandon an unfinished review. Awards nothing. */
  sessionDiscard(payload: ReviewSessionDiscardPayload): ReviewResult<'review/session-discard'>;
  /** `review/session-resume` - report whether an interrupted review exists. */
  sessionResume(payload: ReviewSessionResumePayload): ReviewResult<'review/session-resume'>;
  /** Execute any review command held as a tagged value. */
  dispatch(command: ReviewCommand): ReviewCommandResult<ReviewOutcome>;
}

/**
 * Build the review controller.
 *
 * @param deps Injected ports and clock. No defaults: the application layer must not
 * reach for a real store, a real `Date`, or a real `Math.random` on its own.
 */
export function createReviewController(deps: ReviewCommandDeps): ReviewController {
  const passCompleteCommand = (payload: ReviewPassCompletePayload) => runPassComplete(deps, payload);
  const sessionSaveCommand = (payload: ReviewSessionSavePayload) => runSessionSave(deps, payload);
  const sessionDiscardCommand = (payload: ReviewSessionDiscardPayload) =>
    runSessionDiscard(deps, payload);
  const sessionResumeCommand = (payload: ReviewSessionResumePayload) =>
    runSessionResume(deps, payload);

  return {
    passComplete: passCompleteCommand,
    sessionSave: sessionSaveCommand,
    sessionDiscard: sessionDiscardCommand,
    sessionResume: sessionResumeCommand,
    // Both entry points reach the same runner for each command, so `dispatch` and
    // the named methods cannot drift apart: one implementation per command.
    dispatch: (command) => {
      switch (command.type) {
        case 'review/pass-complete':
          return passCompleteCommand(command.payload);
        case 'review/session-save':
          return sessionSaveCommand(command.payload);
        case 'review/session-discard':
          return sessionDiscardCommand(command.payload);
        case 'review/session-resume':
          return sessionResumeCommand(command.payload);
        default: {
          // Structural exhaustiveness rather than an incidental one: adding a
          // `review/*` command to the payload map without a runner here fails
          // `npm run typecheck` at this line, instead of silently returning
          // `undefined` to a caller that awaited it.
          const unhandled: never = command;
          return unhandled;
        }
      }
    },
  };
}
