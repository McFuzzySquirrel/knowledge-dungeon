/**
 * The review-pass progress region.
 *
 * ## What is on screen, and why each piece is text
 *
 * Plan section 10.1 forbids colour-only state communication, and this is the region where
 * that bites hardest, because everything here *used* to be three stacked progress cards
 * differentiated by a bar fill. So:
 *
 * - **The bar is not the state.** It carries the same numbers the sentences above it carry,
 *   and its `role="progressbar"` names what it measures. A bar whose width is the only
 *   signal tells a screen-reader user nothing at all - `aria-valuenow` is a number with no
 *   unit and no denominator - which is why every sentence below is rendered in full.
 * - **`aria-valuemin` / `aria-valuemax` / `aria-valuenow` are correct for a *partially*
 *   cleared dungeon.** The denominator is `progress.totalRooms`, which is
 *   `dungeon.rooms.length` - the all-rooms population, exactly as the pre-Phase-16 HUD card
 *   and `RoomPanel` have always computed it. That is not the same denominator as
 *   `fullReviewPasses`, which counts reviewable rooms only, and
 *   `src/core/review/reviewPasses.ts` documents the divergence and Phase 18 owns the
 *   correction. Reporting the number this surface has always reported is what keeps the two
 *   panes agreeing; inventing a third denominator here would make them disagree.
 * - **A zero denominator yields `valuemax={1}`, not `valuemax={0}`.** `aria-valuemax` must
 *   be greater than `aria-valuemin`, and 0 over 0 is a range with no members - an assistive
 *   technology is then entitled to report an undefined percentage. A one-room range reads as
 *   "0 of 1", which is honest, and the sentence says "0/0 rooms" separately.
 *
 * ## Nothing here is a colour
 *
 * Overdue, due today, and scheduled ahead are three *different words*, produced by
 * `reviewDueSentence` in `reviewViewModel.ts`, and the class the word sits on changes only
 * the border weight. A learner in greyscale, in forced-colours mode, or with any colour
 * vision reads the same three states a learner with full colour does.
 */
import type { ReactNode } from 'react';

import { ARCHAEOLOGIST_CONTROL_IDS } from '../controlIds';
import type { ReviewDueView, ReviewPassView } from './reviewViewModel';

/** A readable rendering of an ISO date, or a sentence when there is none. */
function scheduleLine(due: ReviewDueView): string {
  if (due.nextReviewDateIso === null) return 'No next review date set yet.';
  return `Next review date: ${due.nextReviewDateIso.slice(0, 10)}.`;
}

export interface ReviewProgressProps {
  readonly pass: ReviewPassView;
  readonly due: ReviewDueView;
  /** How many times this room has been reviewed, in total. */
  readonly roomReviewPassCount: number;
  /** Whether this room counts toward the pass currently being worked. */
  readonly reviewedInCurrentPass: boolean;
}

export function ReviewProgress({
  pass,
  due,
  roomReviewPassCount,
  reviewedInCurrentPass,
}: ReviewProgressProps): ReactNode {
  // A one-room range when the dungeon has no rooms, so the ARIA values stay well-formed.
  const valueMax = Math.max(1, pass.totalRooms);
  const valueNow = Math.min(pass.roomsTowardNextPass, valueMax);

  return (
    <div id={ARCHAEOLOGIST_CONTROL_IDS.progress} tabIndex={-1} className="archaeologist-progress">
      <ul className="archaeologist-facts">
        {pass.lines.map((line, index) => (
          <li key={index} className="archaeologist-fact">
            {line}
          </li>
        ))}
        <li className="archaeologist-fact">
          Times this room has been reviewed: {roomReviewPassCount}.
        </li>
        <li className="archaeologist-fact">
          {reviewedInCurrentPass
            ? `Counted in the current pass (pass ${pass.nextPassTarget}).`
            : `Not yet counted in pass ${pass.nextPassTarget}.`}
        </li>
      </ul>

      {/*
        * The bar. `aria-valuetext` is what a screen reader actually reads, and it is a
        * sentence with the same words as the list above - which is the whole point of a
        * progressbar: the bar is the visual, the sentence is the fact.
        */}
      <div
        className="review-progress-bar"
        role="progressbar"
        aria-label="Room review progress toward the next full pass"
        aria-valuemin={0}
        aria-valuemax={valueMax}
        aria-valuenow={valueNow}
        aria-valuetext={`${pass.roomsTowardNextPass} of ${pass.totalRooms} rooms reviewed toward pass ${pass.nextPassTarget}`}
      >
        <span className="review-progress-bar-fill" style={{ width: `${pass.percent}%` }} />
      </div>

      {/*
        * The schedule. Three distinct words, never three fills: `archaeologist-due--*`
        * changes only the border width, and `due.sentence` is what says which state this is.
        */}
      <p
        className={`archaeologist-due archaeologist-due--${due.label}`}
        data-review-due-state={due.label}
      >
        {due.sentence}
      </p>
      <p className="archaeologist-hint">{scheduleLine(due)}</p>
    </div>
  );
}