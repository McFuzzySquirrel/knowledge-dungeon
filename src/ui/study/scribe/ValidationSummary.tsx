/**
 * The Scribe workspace's validation presentation.
 *
 * ## This component holds no validation presentation of its own
 *
 * Every label, every message, every improvement hint, every score string, and the
 * quality-bonus sentence come from {@link ScribeEncounterViewModel}. None of the wording
 * that used to live in `NoteEditorModal.tsx` is restated here - it was *moved* into
 * `scribeViewModel.ts`, and a second copy would be the same drift defect
 * `src/application/creatorGraphCommands.ts` exists to prevent.
 *
 * That includes the neutral checklist. Before the learner has typed anything, the view
 * model reports requirements ("Keep headings: …") rather than failures, and this file
 * renders whichever list it is handed without knowing which is which.
 *
 * ## Nothing here is colour-only
 *
 * A check row carries its verdict three times over: a glyph, the validator's own message,
 * and a word (`Met`, `Not met`, `Bonus met`). The rubric row carries its score as `2/2`
 * plus a word for its band. The section rows carry `Present` or `Missing`. A learner who
 * cannot distinguish the colours still reads every verdict.
 *
 * The glyphs are `aria-hidden` on purpose: a screen reader should hear "Not met", not
 * "cross mark".
 */
import type { ReactNode } from 'react';

import type {
  ScribeCheckRow,
  ScribeEncounterViewModel,
  ScribeScoreTone,
} from './scribeViewModel';

/**
 * The word that carries a rubric row's band.
 *
 * Derived from the view model's own `tone`, which is already the classification - this is
 * the accessible rendering of a decision the model made, not a second decision.
 */
const TONE_WORD: Readonly<Record<ScribeScoreTone, string>> = Object.freeze({
  full: 'Full marks',
  partial: 'Partial marks',
  none: 'Not scored',
});

/** The word that carries a check's verdict, distinguishing a bonus from a requirement. */
function checkVerdict(check: ScribeCheckRow): string {
  if (check.passed) return check.blocking ? 'Met' : 'Bonus target met';
  return check.blocking ? 'Not met' : 'Bonus target not met yet';
}

export interface ValidationSummaryProps {
  readonly model: ScribeEncounterViewModel;
}

export function ValidationSummary({ model }: ValidationSummaryProps): ReactNode {
  const { sections, checks, rubric, wordCount } = model;

  return (
    <div className="scribe-validation">
      <section aria-labelledby="scribe-validation-sections">
        <h4 className="scribe-subheading" id="scribe-validation-sections">
          Required sections
        </h4>
        <ul className="scribe-rows">
          {sections.map((entry) => (
            <li
              key={entry.section}
              className={`scribe-row${entry.missing ? ' scribe-row--missing' : ''}`}
            >
              <span className="scribe-row__mark" aria-hidden="true">
                {entry.missing ? '○' : '●'}
              </span>
              <span className="scribe-row__text">{entry.section}</span>
              <span className="scribe-row__verdict">{entry.missing ? 'Missing' : 'Present'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="scribe-validation-checks">
        <h4 className="scribe-subheading" id="scribe-validation-checks">
          Checks
        </h4>
        <ul className="scribe-rows">
          {checks.map((check) => (
            <li
              key={check.code}
              className={`scribe-row${check.passed ? '' : ' scribe-row--missing'}`}
            >
              <span className="scribe-row__mark" aria-hidden="true">
                {check.display}
              </span>
              <span className="scribe-row__text">{check.message}</span>
              <span className="scribe-row__verdict">{checkVerdict(check)}</span>
            </li>
          ))}
          <li className="scribe-row">
            <span className="scribe-row__mark" aria-hidden="true">
              –
            </span>
            <span className="scribe-row__text">Words in this note</span>
            <span className="scribe-row__verdict">{wordCount}</span>
          </li>
        </ul>
      </section>

      <section aria-labelledby="scribe-validation-rubric">
        <h4 className="scribe-subheading" id="scribe-validation-rubric">
          Quality rubric
        </h4>
        <ul className="scribe-rows">
          {rubric.rows.map((row) => (
            <li key={row.criterion} className={`scribe-row scribe-row--${row.tone}`}>
              <span className="scribe-row__text">
                <strong>{row.label}</strong>
                <span className="scribe-row__detail">{row.rationale}</span>
                {row.hint === null ? null : (
                  <span className="scribe-row__detail">{row.hint}</span>
                )}
              </span>
              <span className="scribe-row__verdict">
                {`${row.displayScore} · ${TONE_WORD[row.tone]}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="scribe-hint">{rubric.qualityBonusLine}</p>
      </section>
    </div>
  );
}