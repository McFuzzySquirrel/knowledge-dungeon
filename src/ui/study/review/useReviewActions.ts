/**
 * The review workspace's only path to a review mutation.
 *
 * ## Why this exists rather than a bare controller call in each component
 *
 * The same argument `useScribeEncounterActions` makes, unchanged and over the four review
 * verbs:
 *
 * 1. **Every dispatch comes from an event handler.** There is no `useEffect` in this file
 *    that dispatches, and none of the workspace's effects dispatch either - the workspace's
 *    effects only move focus and re-read the durable marker. StrictMode re-runs effects; it
 *    does not re-fire clicks.
 * 2. **A ref guard swallows a re-entrant dispatch of the same scope.** A double tap on a
 *    touch screen, an Enter keydown that a surrounding form also submits, or a key held down
 *    all reach the handler twice inside one tick. The second attempt is refused *before* the
 *    controller is called, and reports `skipped` rather than pretending to succeed.
 * 3. **Pending state disables the control.** The guard is the correctness property; the
 *    disabled control is what stops the second attempt from being offered. Both are needed:
 *    a guard alone leaves a learner clicking a button that appears broken.
 *
 * ## The two layers of idempotency, and why the review phase needs both more than Scribe did
 *
 * The guard answers "was this asked twice?". The durable (room, pass) ledger in
 * `progressionStore.awardReviewPass` answers "has this pass been awarded before?". The
 * second is what makes the first merely an optimisation here: `review/pass-complete` is
 * *synchronous*, so two clicks in one tick are not two ticks of state and the guard is the
 * only thing between them; while a resubmission minutes later, a StrictMode double render,
 * or a retried write gets straight past the guard and is still awarded exactly once by the
 * ledger.
 *
 * `awarded: false` alone is **not** the discriminator. It covers three causes and only one
 * of them is "already awarded": the ledger suppressing a repeat, the ledger having no entry
 * to make, and the progression store having no active subject. Telling a learner "this pass
 * was already awarded" when nothing was ever awarded is a sentence that is simply false, so
 * `duplicate` is read separately in {@link describePassComplete}.
 *
 * ## Why `passComplete` is the only verb that awards
 *
 * `sessionSave` writes a resumable marker and no SM-2 state at all; `sessionDiscard` removes
 * one; `sessionResume` writes nothing. All three report `progression: null` in their own
 * outcome types, and the messages here say so in words rather than leaving a learner
 * wondering whether they earned anything.
 *
 * ## The feedback channel
 *
 * One {@link StudyFeedback} value, rendered by the shell's single `role="status"` region.
 * Every sentence is built from the command's own outcome: counts and verbs, never a topic,
 * a room id, a note, or a file name. A refusal is the command's own `error.message`, passed
 * through verbatim, so the wording cannot drift from the domain's.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ReviewController } from '@/application/reviewCommands';
import type {
  ReviewCommandResult,
  ReviewOutcome,
  ReviewPassCompleteOutcome,
  ReviewSessionDiscardOutcome,
  ReviewSessionResumeOutcome,
  ReviewSessionSaveOutcome,
} from '@/application/reviewCommands';
import type { QualityRating } from '@/core/review/spacedRepetition';
import { reviewController } from '@/store/reviewCommands';

import type { StudyFeedback } from '../StudyShell';

/**
 * The scope strings the guard and the pending flags agree on, per verb.
 *
 * Static vocabulary, and deliberately *not* per-room: the workspace reviews one room at a
 * time, and two different verbs for the same room and the same tick are the same learner
 * making two decisions that must not race.
 */
export const REVIEW_COMMAND_SCOPES = Object.freeze({
  passComplete: 'pass-complete',
  sessionSave: 'session-save',
  sessionDiscard: 'session-discard',
  sessionResume: 'session-resume',
});

export type ReviewCommandScope =
  (typeof REVIEW_COMMAND_SCOPES)[keyof typeof REVIEW_COMMAND_SCOPES];

export type ReviewCommandStatus = 'applied' | 'refused' | 'skipped' | 'failed';

export interface ReviewCommandResultView {
  readonly status: ReviewCommandStatus;
  /** The sentence to show, or `null` for a skipped dispatch, which shows nothing. */
  readonly message: string | null;
  /** The raw result, so a caller can branch on the outcome's own discriminants. */
  readonly outcome: ReviewOutcome | null;
}

export interface ReviewActions {
  /** True while the given scope has a command in flight. */
  readonly isPending: (scope: ReviewCommandScope) => boolean;
  /** The live status/refusal sentence, or `null` before the first command. */
  readonly feedback: StudyFeedback | null;
  /** `review/pass-complete`. The only verb that awards. */
  readonly passComplete: (payload: {
    readonly roomId: string;
    readonly qualityRating: QualityRating;
  }) => ReviewCommandResultView;
  /** `review/session-save`. Parks an unfinished review; awards nothing. */
  readonly sessionSave: (payload: {
    readonly roomId: string;
    readonly qualityRating: QualityRating | null;
  }) => ReviewCommandResultView;
  /** `review/session-discard`. Abandons an unfinished review. */
  readonly sessionDiscard: (payload: { readonly roomId: string }) => ReviewCommandResultView;
  /** `review/session-resume`. Read-only; reports whether a marker existed. */
  readonly sessionResume: (payload: { readonly roomId: string }) => ReviewCommandResultView;
  /** Dismiss the live sentence. */
  readonly clearFeedback: () => void;
}

export interface ReviewActionsOptions {
  /**
   * The controller to dispatch through.
   *
   * Defaults to the store-bound `reviewController`. Injectable so a test can count dispatches
   * without a store, and so the workspace never has to know that the default controller
   * happens to be bound to one.
   */
  readonly controller?: ReviewController;
}

type Applied<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } };

function dismissed(): ReviewCommandResultView {
  return { status: 'skipped', message: null, outcome: null };
}

/**
 * What a completed pass actually awarded, in one sentence.
 *
 * Three branches, not two, and the third is the reason this function exists separately:
 * `!awarded` is false for a suppressed duplicate *and* for a store with no active subject,
 * and those two are different events. `duplicate` is the only field carrying the
 * distinction, and a learner told their review "was already counted" when no reward was ever
 * paid has been told something untrue about their own progress.
 */
export function describePassComplete(outcome: ReviewPassCompleteOutcome): string {
  const { progression } = outcome;
  if (!progression.awarded) {
    return progression.duplicate
      ? 'This pass for this room was already counted, so nothing was added this time.'
      : 'The review was recorded, but no reward was added because no subject is open.';
  }
  const parts: string[] = [`Review pass recorded. +${progression.xpGained} XP.`];
  parts.push(
    `${outcome.passProgress.roomsTowardNextPass}/${outcome.passProgress.totalRooms} rooms toward pass ${outcome.passProgress.nextPassTarget}.`,
  );
  if (outcome.resumedSessionDiscarded) {
    parts.push('The unfinished session for this room was cleared.');
  }
  return parts.join(' ');
}

/** `review/session-save` in one sentence. Says plainly that it awarded nothing. */
export function describeSessionSave(outcome: ReviewSessionSaveOutcome): string {
  const pass = outcome.session.passNumber;
  return `Review saved in pass ${pass}. Nothing was awarded yet, because the review is not finished.`;
}

/** `review/session-discard` in one sentence, distinguishing the two "nothing to remove" causes. */
export function describeSessionDiscard(outcome: ReviewSessionDiscardOutcome): string {
  if (outcome.discarded) return 'Saved review discarded. Nothing was awarded.';
  return outcome.keptForOtherRoom === null
    ? 'There was no saved review for this room, so nothing changed.'
    : 'There was no saved review for this room, so nothing changed. The saved review for another room was left alone.';
}

/** `review/session-resume` in one sentence. */
export function describeSessionResume(outcome: ReviewSessionResumeOutcome): string {
  if (outcome.resumed && outcome.session !== null) {
    const remembered =
      outcome.session.qualityRating === null
        ? ''
        : ` Your rating was ${outcome.session.qualityRating} of 5.`;
    return `Picked the saved review back up in pass ${outcome.session.passNumber}.${remembered}`;
  }
  return outcome.waitingForRoomId === null
    ? 'There was no saved review to pick up for this room.'
    : 'There was no saved review for this room. A different room has one waiting.';
}

export function useReviewActions(options: ReviewActionsOptions = {}): ReviewActions {
  const controller = options.controller ?? reviewController;
  const [pendingScopes, setPendingScopes] = useState<ReadonlySet<string>>(() => new Set());
  const [feedback, setFeedback] = useState<StudyFeedback | null>(null);

  /*
   * The guard. A ref rather than state because it has to be readable synchronously inside the
   * handler: state is committed on the next render, so a second activation in the same tick
   * would read `false` and dispatch again - which is exactly the bug.
   *
   * `mounted` is here rather than beside the render-time read because StrictMode runs this
   * file's effects twice on mount, and an effect cleanup that set `mounted.current = false`
   * without the matching re-arming effect would leave every later command silently dropped.
   */
  const inFlight = useRef<ReadonlySet<string>>(new Set());
  /*
   * A mutable `Map`, not a `ReadonlyMap`: the timer callback removes its own entry, and a
   * `ReadonlyMap` would reject that with a type error while the runtime `Map` did the right
   * thing - which is exactly the kind of mismatch that makes the next reader distrust the
   * annotation rather than the code.
   */
  const releaseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mounted = useRef(true);

  /*
   * `mounted` is armed on every effect run and disarmed on every cleanup, in one effect.
   *
   * Both halves in one effect is the load-bearing detail, and it was a bug before it was a
   * comment. StrictMode runs mount effects twice: effect, cleanup, effect. A cleanup that set
   * `mounted.current = false` in a *separate* effect from the one that armed it left the flag
   * `false` after the second pass, so every later `setFeedback` was gated off and the shell's
   * `role="status"` stayed empty forever - in development only, and silently.
   */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Clear every pending release, so a timer cannot fire after unmount and write state into
      // a component that is gone. The commands themselves are synchronous, so nothing is in
      // flight at this point - only the guard's tail is.
      for (const timer of releaseTimers.current.values()) clearTimeout(timer);
      releaseTimers.current = new Map();
    };
  }, []);

  /*
   * Every command here is synchronous, so `run` is synchronous too - and that changes what the
   * guard has to do.
   *
   * A *synchronous* release would be worthless here. `review/pass-complete` completes inside
   * the handler, so a guard released at the end of that same handler is already open again by
   * the time a second click arrives, and a double tap would dispatch twice. The guard is
   * therefore held closed for one *macrotask* - a `setTimeout(0)` - rather than one microtask,
   * because two clicks in the same task is the exact case being refused, and a microtask
   * boundary falls between them.
   *
   * The delay is bounded by one timer and always clears, so the guard cannot wedge a verb.
   * And it is not load-bearing for correctness: the durable (room, pass) ledger is what makes
   * the award once-only, and this only stops the second *request* from being made.
   */
  const run = useCallback(
    <T extends ReviewOutcome>(
      scope: ReviewCommandScope,
      invoke: () => Applied<T>,
      describe: (value: T) => string,
    ): ReviewCommandResultView => {
      if (inFlight.current.has(scope)) return dismissed();

      inFlight.current = new Set(inFlight.current).add(scope);
      if (mounted.current) {
        setPendingScopes((current) => new Set(current).add(scope));
        setFeedback({ tone: 'progress', message: 'Working on it…' });
      }

      /*
       * The result is computed in the `try` and returned *after* the `finally`, never from
       * inside it. A `return` in a `finally` block replaces the `try`'s value, which would
       * silently turn every applied command into `undefined` - and the type checker caught it
       * here rather than a learner discovering it, which is the only good outcome of a
       * control-flow mistake.
       */
      let view: ReviewCommandResultView;
      try {
        const result = invoke();
        if (result.ok) {
          const message = describe(result.value);
          view = { status: 'applied', message, outcome: result.value };
          if (mounted.current) setFeedback({ tone: 'done', message });
        } else {
          /*
           * The domain's own sentence, verbatim. A surface that showed `error.message` would
           * read the same words whichever lane answered, which is what the command layer's
           * refusals are written for.
           */
          view = { status: 'refused', message: result.error.message, outcome: null };
          if (mounted.current) setFeedback({ tone: 'refusal', message: result.error.message });
        }
      } catch (error) {
        /*
         * A throw is not a domain refusal: every precondition in the review commands is a typed
         * refusal, so a throw came from the persistence step below them. The thrown message is
         * the only description that exists, and `StudyFeedback` is the one channel for it.
         */
        const message =
          error instanceof Error ? error.message : 'That could not be saved to this device.';
        view = { status: 'failed', message, outcome: null };
        if (mounted.current) setFeedback({ tone: 'refusal', message });
      }

      /*
       * Release the guard a macrotask later, not now. See the comment above `run` for why a
       * synchronous release would be worthless against a double tap, and why one microtask is
       * not enough either.
       */
      const timer = setTimeout(() => {
        releaseTimers.current.delete(scope);
        inFlight.current = new Set([...inFlight.current].filter((entry) => entry !== scope));
        if (!mounted.current) return;
        setPendingScopes((current) => {
          const next = new Set(current);
          next.delete(scope);
          return next;
        });
      }, 0);
      releaseTimers.current = new Map(releaseTimers.current).set(scope, timer);
      return view;
    },
    [],
  );

  const passComplete = useCallback(
    (payload: { roomId: string; qualityRating: QualityRating }) =>
      run<ReviewPassCompleteOutcome>(
        REVIEW_COMMAND_SCOPES.passComplete,
        () => controller.passComplete(payload),
        describePassComplete,
      ),
    [controller, run],
  );

  const sessionSave = useCallback(
    (payload: { roomId: string; qualityRating: QualityRating | null }) =>
      run<ReviewSessionSaveOutcome>(
        REVIEW_COMMAND_SCOPES.sessionSave,
        () => controller.sessionSave(payload),
        describeSessionSave,
      ),
    [controller, run],
  );

  const sessionDiscard = useCallback(
    (payload: { roomId: string }) =>
      run<ReviewSessionDiscardOutcome>(
        REVIEW_COMMAND_SCOPES.sessionDiscard,
        () => controller.sessionDiscard(payload),
        describeSessionDiscard,
      ),
    [controller, run],
  );

  const sessionResume = useCallback(
    (payload: { roomId: string }) =>
      run<ReviewSessionResumeOutcome>(
        REVIEW_COMMAND_SCOPES.sessionResume,
        () => controller.sessionResume(payload),
        describeSessionResume,
      ),
    [controller, run],
  );

  const isPending = useCallback(
    (scope: ReviewCommandScope): boolean => pendingScopes.has(scope),
    [pendingScopes],
  );

  const clearFeedback = useCallback((): void => {
    if (mounted.current) setFeedback(null);
  }, []);

  return useMemo(
    () => ({
      clearFeedback,
      feedback,
      isPending,
      passComplete,
      sessionDiscard,
      sessionResume,
      sessionSave,
    }),
    [
      clearFeedback,
      feedback,
      isPending,
      passComplete,
      sessionDiscard,
      sessionResume,
      sessionSave,
    ],
  );
}

/** The result shape the command layer returns, re-exported so a caller can narrow it. */
export type { ReviewCommandResult };