/**
 * The recall card: the prompt, and the rating control that records how well it was recalled.
 *
 * ## Why the rating is a radio group and not a `<select>` or five buttons
 *
 * This is the control the phase's scope line is really about. `src/data/gameGuide.ts` has
 * always told learners to "rate your recall on a 0-5 scale", and until this phase the code
 * had no such control at all: the rating was defaulted to `3` inside the subject store and
 * no surface could supply anything else.
 *
 * Three shapes were available and two are wrong here:
 *
 * - **A `<select>` of bare numbers** is what plan section 10.1 rules out for review
 *   controls: "0" through "5" tell a learner nothing about what they are choosing between,
 *   and the number is the whole meaning. The label has to travel with the value.
 * - **Five colour-coded buttons** would communicate the choice by hue, which 10.1 forbids
 *   outright ("No color-only state communication"), and it would also throw away the one
 *   thing SM-2 has that a 0-5 button does not: `QUALITY_LABELS`, the sentences that say what
 *   each number means.
 * - **A real `role="radiogroup"` of native `<input type="radio">`** carries the meaning in
 *   text, is arrow-key operable for free, is announced as "2 of 6" by every screen reader,
 *   and needs no `name` attribute at all - which is what keeps a room id out of the DOM.
 *
 * ## Why the short label is the visible word and the long label is the explanation
 *
 * The visible word is `QUALITY_SHORT_LABELS` ("Forgot" ... "Perfect") because six of those
 * in a row have to be scannable at a glance. The *full* `QUALITY_LABELS` sentence is bound
 * to each radio as its own accessible description, so a screen-reader user hears "Barely,
 * incorrect, but remembered after seeing the answer" rather than a bare number. Both come
 * from `@/core/review/spacedRepetition`; neither is written here.
 *
 * ## Why there is no `disabled` anywhere in the group
 *
 * `StudyActionButton`'s own header records the trap: a disabled control is not focusable, so
 * a reason carried only in `aria-describedby` is reachable exactly when it does not matter.
 * The group here is never disabled by a lock; when the room is locked the whole Complete
 * region is disabled and *that* control carries the refusal as visible text. A rating the
 * learner can pick but cannot submit is honest, and the sentence above it says so.
 */
import { useId, type ReactNode } from 'react';

import { QUALITY_LABELS, QUALITY_SHORT_LABELS, type QualityRating } from '@/core/review/spacedRepetition';

import { STUDY_TOUCH_TARGET_STYLE } from '../StudyControls';
import { ARCHAEOLOGIST_CONTROL_IDS } from '../controlIds';
import type { ReviewPromptRow } from './reviewViewModel';

/** The six SM-2 ratings, in ascending order. `0` first, because that is the scale. */
const RATINGS: readonly QualityRating[] = [0, 1, 2, 3, 4, 5];

export interface RecallCardProps {
  readonly prompts: readonly ReviewPromptRow[];
  /** The chosen rating, or `null` when the learner has not chosen. */
  readonly rating: QualityRating | null;
  /** Called only from the group's `onChange`. Never from an effect. */
  readonly onRatingChange: (rating: QualityRating) => void;
  /** True while a command is in flight, which disables nothing here but is reported. */
  readonly busy: boolean;
}

export function RecallCard({
  prompts,
  rating,
  onRatingChange,
  busy,
}: RecallCardProps): ReactNode {
  const groupLabelId = useId();
  const hintId = useId();

  return (
    <div className="archaeologist-recall">
      <div id={ARCHAEOLOGIST_CONTROL_IDS.recallPrompts} tabIndex={-1} className="archaeologist-recall__prompts">
        {prompts.length === 0 ? (
          <p className="archaeologist-hint">
            No recall prompt could be written for this room. Rate it below anyway if you still
            want to record this review.
          </p>
        ) : (
          <>
            <h4 className="archaeologist-subheading">Answer these out loud, in your own words</h4>
            <ol className="archaeologist-prompt-list">
              {prompts.map((prompt) => (
                /*
                 * The static ordinal as the key, never the domain's `${roomId}:prompt:N`
                 * `promptId`. Both are unique within this list, but a key is the one place a
                 * room id would end up in a React-internal attribute, and "no learner data in
                 * any id" is easier to keep true when the alternative is already static.
                 */
                <li key={prompt.ordinal} className="archaeologist-prompt">
                  {prompt.text}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <fieldset
        id={ARCHAEOLOGIST_CONTROL_IDS.qualityRating}
        /*
         * `role="radiogroup"` stated explicitly, not left to `<fieldset>`'s implicit `group`.
         *
         * A `<fieldset>` maps to `group`, and `radiogroup` is the role that tells assistive
         * technology the contained radios are *one question with one answer* rather than six
         * unrelated controls - which is what makes "2 of 6" and the arrow-key roving focus
         * behave the way a learner expects from a rating. The `role` and the `role="group"`
         * a fieldset would otherwise get coexist harmlessly: `radiogroup` is a subclass, and
         * the legend still names it.
         *
         * `tabIndex={-1}` so a next action can move focus here without adding a Tab stop: the
         * radios themselves are the stops, and `role="radiogroup"` containers take focus
         * programmatically only.
         */
        role="radiogroup"
        className="archaeologist-quality"
        tabIndex={-1}
        aria-labelledby={groupLabelId}
        aria-describedby={hintId}
      >
        <legend id={groupLabelId} className="archaeologist-quality__legend">
          How well did you recall it?
        </legend>
        <p id={hintId} className="archaeologist-hint">
          Move through the ratings with the arrow keys, or Tab to one and use the arrow keys.
          Your rating decides when this room comes back: low ratings return tomorrow, high ones
          wait longer.
        </p>
        <div className="archaeologist-quality__options">
          {RATINGS.map((value) => {
            const optionId = `${ARCHAEOLOGIST_CONTROL_IDS.qualityRating}-option-${value}`;
            const descriptionId = `${optionId}-description`;
            const chosen = rating === value;
            return (
              <div key={value} className="archaeologist-quality__option">
                <input
                  id={optionId}
                  type="radio"
                  /* No `name` attribute, and the reason is load-bearing: a radio group's
                   * uniqueness normally comes from a shared `name`, and the obvious value is
                   * the room id. `role="radiogroup"` on the fieldset plus the browser's own
                   * grouping by ancestor form-owner is enough for arrow-key navigation, and it
                   * means no room id is ever written into the DOM. */
                  className="archaeologist-quality__input"
                  value={value}
                  checked={chosen}
                  disabled={busy}
                  aria-describedby={descriptionId}
                  {...{ 'data-study-touch-target': `quality-${value}` }}
                  style={STUDY_TOUCH_TARGET_STYLE}
                  onChange={() => {
                    onRatingChange(value);
                  }}
                />
                <label htmlFor={optionId} className="archaeologist-quality__label">
                  {/*
                   * The number is visible *and* the word is visible, so the scale is legible
                   * to a learner who does not read "Perfect" as meaning 5, and neither half
                   * carries meaning the other lacks.
                   */}
                  <span className="archaeologist-quality__value">{value}</span>
                  <span className="archaeologist-quality__name">
                    {QUALITY_SHORT_LABELS[value]}
                  </span>
                  {/*
                   * The long SM-2 sentence, in the DOM as text. It is visually hidden rather
                   * than `aria-label`-only so it is also readable by a learner who wants it
                   * and by a test that asserts the real label reached the surface. Screen
                   * readers reach it through the `aria-describedby` above.
                   */}
                  <span
                    id={descriptionId}
                    className="archaeologist-quality__description study-visually-hidden"
                  >
                    {QUALITY_LABELS[value]}
                  </span>
                </label>
                {chosen ? (
                  <span className="archaeologist-quality__chosen" aria-hidden="true">
                    Chosen
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {/*
          * The chosen rating, as a sentence. `aria-checked` is what a screen reader announces
          * from the radio itself; this exists so the state is also visible, which 10.1's "no
          * colour-only state" requires and `aria-checked` alone does not give a sighted
          * learner who is not looking at the group.
          */}
        <p className="archaeologist-quality__readback" data-review-rating-readback>
          {rating === null
            ? 'No rating chosen yet.'
            : `Your rating: ${rating} of 5, ${QUALITY_LABELS[rating]}`}
        </p>
      </fieldset>
    </div>
  );
}