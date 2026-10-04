/**
 * The recall dialog for a caught fish: three distinct outcomes, and four dialog rules.
 *
 * ## The defect this rewrite removes
 *
 * The pre-Phase-17 modal had a "Keep Fish" button on its *no question* branch, wired to
 * `onSelfEvaluate('correct')`. That reached `VillageScreen.handleKeepFish`, which awarded
 * `FSH_XP_PER_CORRECT_ANSWER`. So **keeping a fish with no recall material was recorded as a
 * correct answer and paid learning XP.** Phase 17's scope names the fix in one line: "Record
 * a distinct outcome when a fish is kept without recall material rather than treating it as a
 * correct answer."
 *
 * There are therefore **three** outcomes here, and they are three different *events*, not three
 * ways of saying the same one:
 *
 * | Outcome | Fish | XP | How the learner reaches it |
 * |---------|------|----|---------------------------|
 * | answered correct | kept | yes, by rarity | the question exists and they got it |
 * | answered incorrect | returned | no | the question exists and they could not |
 * | kept with no recall | kept | **no** | the pond had no question to ask |
 *
 * The third is the one that was missing, and it is in `FishingRecallOutcome` in
 * `src/application/contracts/commands.ts` as its own member -
 * `{ kind: 'kept-without-recall' }` - precisely so that conflating it with a correct answer
 * would take a deliberate act in a payload rather than happen by default. This dialog's whole
 * job is to make the third case *reachable* and to make it read, in its own words, as what it
 * is: a catch that was not a learning event.
 *
 * ## The failed-recall branch is a rule now, not an accident
 *
 * The old "I need to review" branch called `setFishCaughtData(null)` and nothing else, which
 * meant it awarded nothing *by omission*. That is not the same as a rule: the next edit to that
 * callback could have written anything. Phase 17's exit criterion is "release and failed
 * recall do not mutate progression", so both branches now dispatch an explicit
 * `fishing/catch-keep` with a named outcome, and `fishing/catch-release` is the release path.
 * `tests/phase17/fishing-keep-transaction.test.tsx` diffs the entire progression value across
 * each branch and asserts it is byte-identical for the two that must not mutate.
 *
 * ## The four dialog rules, and what each one is here
 *
 * Plan 10.1 requires "dialog focus trapping, initial focus, Escape handling, and focus
 * restoration" for every dialog. All four come from the shared `useModalFocus`, which is the
 * single implementation of all three focus behaviours plus Escape that the rest of the app
 * uses (`DataManagementDialog`, `CreateSubjectDialog`, `ScribeEncounter`, `ConfirmDialog`):
 *
 * 1. **Initial focus** on the dialog container rather than the first button - focusing
 *    "I got it right" would put a reward-claiming action under the learner's next `Enter`.
 * 2. **Tab containment** in the capture phase, so a control cannot swallow the Tab that would
 *    have contained it.
 * 3. **Restoration** to whatever had focus when the dialog opened. The card this dialog
 *    replaced is unmounted by then, so `useModalFocus` only restores to something still
 *    connected, and the catch panel is the thing that has to be focusable for the round trip
 *    to land anywhere - which is why `FishingCatchPanel` takes `autoFocus`.
 * 4. **Escape** closes it, and closing is the *cancel* outcome: nothing is committed, the fish
 *    is not lost silently, and the caller clears the catch. Escape is not "I need to review" -
 *    a key that discards a fish should not be one keystroke away from a key that means "I got
 *    it right", and the two are on separate controls with separate labels.
 *
 * The dialog also carries `aria-modal="true"`, `aria-labelledby` pointing at its own heading,
 * and `aria-describedby` pointing at its body, so a screen reader announces what this is before
 * it announces what is inside it.
 *
 * ## The route back to the room
 *
 * When the question exists, this dialog offers one more control: open the room the question
 * came from. That route is local and offline, and `fishingRecallNavigation.ts` explains in
 * full why. Its refusal is rendered here, as text, next to the control that caused it -
 * never as a tint and never only as a live-region announcement the learner may have missed.
 *
 * ## No learner data in any id, attribute, or key
 *
 * `catalogId` is catalogue content and is carried as a data attribute for the transaction.
 * `roomId` and `subjectId` are app-minted and reach the DOM **nowhere**: they are props the
 * controls close over, not attributes they carry. The only id on this dialog is the static
 * `FISHING_CONTROL_IDS.recallRoom`.
 */
import { useEffect, useId, useState, type JSX } from 'react';

import type { FishRarity } from '@/core/fishing/fishingTypes';
import type { SelfCheckPrompt } from '@/core/review/types';
import { useModalFocus } from '@/ui/hooks/useModalFocus';
import { FISHING_CONTROL_IDS } from '@/ui/study/controlIds';
import {
  RECALL_ROOM_UNAVAILABLE_MESSAGE,
  useRecallRoomNavigation,
  type RecallRoomDestination,
} from '@/ui/fishing/fishingRecallNavigation';

import '@/ui/fishing/fishing.css';

/**
 * What the learner chose, as three separate values.
 *
 * Deliberately **not** `'correct' | 'incorrect'`. The old two-value union is what made
 * "kept with no recall" inexpressible, and the fix for that is a third member rather than an
 * `any`, because `any` would also admit a fourth wrong value tomorrow.
 */
export type FishingRecallChoice =
  /** The question existed and the learner recalled it. Keeps the fish and pays XP. */
  | 'answered-correct'
  /** The question existed and the learner could not recall it. Returns the fish, pays nothing. */
  | 'answered-incorrect'
  /** The pond had no question. Keeps the fish and pays no XP. */
  | 'kept-without-recall';

/**
 * Every value {@link FishingRecallChoice} can take, at run time.
 *
 * A union is erased, so the type above could silently lose a member - which is how the
 * pre-Phase-17 two-value union lost `kept-without-recall` in the first place, and how a test
 * that only clicked buttons would have passed against a dialog that still conflated keeping a
 * question-less fish with answering one correctly. This set is the run-time statement of the
 * same three facts, and
 * `tests/phase17/fishing-keep-transaction.test.tsx` asserts it has three members and that the
 * old vocabulary is absent.
 */
export const FISHING_RECALL_CHOICES: ReadonlySet<FishingRecallChoice> = new Set<FishingRecallChoice>([
  'answered-correct',
  'answered-incorrect',
  'kept-without-recall',
]);

export interface FishingRecallModalProps {
  /** Catalogue display name, resolved from `catalogId` on the DOM side. Never a key. */
  readonly fishName: string;
  readonly rarity: FishRarity;
  /** Catalogue content. Carried for the transaction; never a DOM key. */
  readonly catalogId: string;
  readonly description: string;
  /**
   * The question, or `null` when the pond had none.
   *
   * `null` is the whole of the third outcome: not "the room was blank", not "loading", and
   * not a question whose text failed to render.
   */
  readonly recallQuestion: { readonly prompt: SelfCheckPrompt; readonly roomId: string } | null;
  /**
   * The subject the pond was entered from, for the "open that room" route.
   *
   * Optional, and `null` simply hides the route rather than rendering a control that cannot
   * work - which is the same rule the whole app follows for a capability it does not have.
   */
  readonly destination?: RecallRoomDestination | null;
  /** The learner chose an outcome. Commits exactly one of the three. */
  readonly onDecide: (choice: FishingRecallChoice, roomId: string | null) => void;
  /** Dismiss without committing. Nothing is written; the caller clears the catch. */
  readonly onCancel: () => void;
}

export function FishingRecallModal({
  fishName,
  rarity,
  catalogId,
  description,
  recallQuestion,
  destination,
  onDecide,
  onCancel,
}: FishingRecallModalProps): JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>({ active: true, onEscape: onCancel });
  const { openRecallRoom } = useRecallRoomNavigation();
  const [routeRefusal, setRouteRefusal] = useState<string | null>(null);

  const hasQuestion = recallQuestion !== null;
  const roomId = recallQuestion?.roomId ?? null;

  /**
   * Clear a stale refusal when the question changes.
   *
   * Without this, a learner who hit the route on one fish, was refused, and then answered the
   * next fish correctly would still be reading the previous fish's refusal - because the modal
   * is mounted once per pond session and every catch reuses it.
   */
  useEffect(() => {
    setRouteRefusal(null);
  }, [roomId, catalogId]);

  const goToRoom = (): void => {
    if (roomId === null || destination === null || destination === undefined) return;
    void openRecallRoom({ subjectId: destination.subjectId, roomId }).then((result) => {
      setRouteRefusal(result.ok ? null : result.message);
    });
  };

  const canOpenRoom = roomId !== null && destination != null;

  return (
    <div
      className="modal-backdrop fishing-recall-modal"
      style={{ zIndex: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      // `presentation`, not a click target: the pre-Phase-17 modal closed on a backdrop click,
      // and a dialog that discards a decision because the learner tapped a few pixels outside
      // it is a dialog that loses catches.
      role="presentation"
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="village-info-panel ui-skin fishing-recall-panel fishing-recall__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        ref={dialogRef}
        data-fishing-catalog-id={catalogId}
      >
        <div className="village-info-panel-header">
          <span className="village-info-portal-icon" aria-hidden="true">
            🎣
          </span>
          <div>
            <h3 id={titleId}>{fishName}</h3>
            <p className="village-info-meta">
              {hasQuestion
                ? 'Test your knowledge - did you remember this?'
                : 'No review material available'}
            </p>
          </div>
          <span className="fish-rarity-badge" data-rarity={rarity}>
            {rarity.toUpperCase()}
          </span>
        </div>

        <div id={bodyId}>
          {/*
            The catalogue description, in both branches.

            The pre-Phase-17 modal received `description` and never rendered it - the catch card
            above had already shown it, so it read as redundant. That reasoning stops holding once
            the dialog is the *third* surface in the sequence, and it stopped holding earlier for
            the no-question branch, where there is no question to read instead. A description that
            appears on one branch and vanishes on the other reads as a bug.
          */}
          <p className="village-info-desc">{description}</p>
          {hasQuestion ? (
            <>
              {/*
                The question, in a block of its own rather than as body text, because it is
                the thing the whole dialog exists to show and it should be findable by a
                screen-reader user reading the dialog linearly.
              */}
              <p className="fishing-recall__question">{recallQuestion.prompt.text}</p>
              {/*
                What each button *means* for this catch, in words, before the learner chooses.

                "Keeping this fish pays experience" and "this returns the fish" are not
                decoration: they are the difference between two controls whose names are
                four words long and which would otherwise be a guess.
              */}
              <p className="fishing-recall__outcome">
                Keeping this fish records a correct answer and adds experience for its rarity.
                Choosing that you need to review sends the fish back and adds nothing.
              </p>
              {routeRefusal !== null ? (
                <p className="fishing-recall__refusal" role="alert">
                  {routeRefusal}
                </p>
              ) : null}
              <div className="fishing-recall__actions">
                <button
                  type="button"
                  className="village-enter-btn"
                  onClick={() => onDecide('answered-correct', roomId)}
                  style={{ minWidth: '44px', minHeight: '44px' }}
                  data-fishing-touch-target="recall-correct"
                >
                  I got it right
                </button>
                <button
                  type="button"
                  className="village-action-btn"
                  onClick={() => onDecide('answered-incorrect', roomId)}
                  style={{ minWidth: '44px', minHeight: '44px' }}
                  data-fishing-touch-target="recall-incorrect"
                >
                  I need to review
                </button>
                {canOpenRoom ? (
                  <button
                    type="button"
                    className="village-action-btn"
                    id={FISHING_CONTROL_IDS.recallRoom}
                    onClick={goToRoom}
                    style={{ minWidth: '44px', minHeight: '44px' }}
                    data-fishing-touch-target="recall-open-room"
                  >
                    Open the room this question came from
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              {/*
                The third outcome, in its own words.

                This is the branch that used to say "you can keep this fish without a
                question" above a button labelled "Keep Fish" that paid a correct answer. It now
                says what actually happens: the fish joins the collection, it counts toward the
                fishing badges, and it is not a learning event so it adds no experience.
              */}
              <p className="fishing-recall__outcome">
                This subject has no cleared rooms yet, so there is no question to ask. You can
                still keep the fish. It joins your collection and counts toward your fishing
                badges, and it adds no experience: keeping a fish with no question to answer is
                not the same event as answering one correctly.
              </p>
              <div className="fishing-recall__actions">
                <button
                  type="button"
                  className="village-enter-btn"
                  onClick={() => onDecide('kept-without-recall', null)}
                  style={{ minWidth: '44px', minHeight: '44px' }}
                  data-fishing-touch-target="keep-without-recall"
                >
                  Keep this fish (no question, no experience)
                </button>
                <button
                  type="button"
                  className="village-action-btn"
                  onClick={onCancel}
                  style={{ minWidth: '44px', minHeight: '44px' }}
                  data-fishing-touch-target="recall-cancel"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>

        {/*
          Escape, and the reason it is not one of the two decisions.

          The dialog is dismissible - a learner who opened it by accident must be able to back
          out - and dismissing writes nothing, so the fish is not silently lost by a keypress.
          `useModalFocus` wires Escape to `onCancel`, which is the same handler the visible Cancel
          control calls, so the two routes to "nothing happened" are one function rather than two
          that could disagree. Stated in words as well, because a key a learner cannot discover is
          not a route.
        */}
        <p className="fishing-recall__outcome">
          Press Escape, or use Cancel, to close this without recording anything.
        </p>
      </div>
    </div>
  );
}

export { RECALL_ROOM_UNAVAILABLE_MESSAGE };