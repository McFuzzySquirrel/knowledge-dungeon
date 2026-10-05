/**
 * The assistance settings: the manual override, and the only place the count is visible.
 *
 * ## Why this surface is not lazy-loaded, and why it is not in the Welcome closure either
 *
 * The card is lazy because it sits inside four flag-gated workspaces that are themselves
 * statically reachable from the entry. This surface is mounted from the existing Settings modal,
 * which is itself already reached through a lazy route, so an eager import here costs nothing a
 * learner pays for on Welcome. It is still mounted **only** when the settings modal is open, so
 * the engine is not fetched by merely loading the application - and it imports the store, not
 * the engine: the settings surface shows a mode and a count, never a suggestion.
 *
 * ## The two things a learner must be able to do
 *
 * 1. **Set the mode by hand.** Plan section 8 requires "assistance settings with a clear manual
 *    override". `Off` is a real choice here, available at any time, one control away, and it
 *    takes effect immediately rather than on the next visit.
 * 2. **Erase the dismissal count.** The store keeps the count so it can be shown, and a number
 *    a learner cannot delete is a number they have to live with. `clearDismissals` is one
 *    control, it changes nothing else, and the status line says so.
 *
 * ## What this surface does not do
 *
 * It does not say how many suggestions each mode would produce. That number would depend on the
 * learner's current state, so it would be a different number on every visit, and a learner who
 * saw it change would reasonably conclude the application had changed its mind. "Off shows
 * nothing anywhere" is the only claim made, and it is true regardless of state.
 *
 * ## Focus and the surrounding dialog
 *
 * This renders inside the settings modal's own focus trap. It adds no `keydown` handler, no
 * `autoFocus`, and no portal: the mode group is ordinary focusable content, so the trap's Tab
 * cycle passes through it in DOM order and Escape still reaches the modal. The status line is
 * `role="status"`, so a mode change is announced without moving focus - moving focus on a radio
 * change would fight the control the learner just used.
 */
import { useId, type ReactNode } from 'react';

import { ASSISTANCE_MODES, type AssistanceMode } from '@/core/assistance/types';
import { useAssistanceStore } from '@/store/assistanceStore';

import { ASSISTANCE_MODE_COPY, ASSISTANCE_SETTINGS_COPY, formatAssistanceTemplate } from './assistanceCopy';
import {
  ASSISTANCE_IDS,
  ASSISTANCE_ID_ATTRIBUTE,
} from './assistanceTestIds';

import './assistance.css';

export interface AssistanceSettingsProps {
  /** The locale to render in. */
  readonly locale: 'en' | 'es';
}

/** The per-mode explanation under each option, in the learner's words. */
const MODE_NOTE: Readonly<Record<AssistanceMode, keyof typeof ASSISTANCE_SETTINGS_COPY>> =
  Object.freeze({
    off: 'offNote',
    gentle: 'gentleNote',
    standard: 'standardNote',
  });

export function AssistanceSettings({ locale }: AssistanceSettingsProps): ReactNode {
  const mode = useAssistanceStore((state) => state.mode);
  const dismissalCount = useAssistanceStore((state) => state.dismissalCount);
  const setMode = useAssistanceStore((state) => state.setMode);
  const clearDismissals = useAssistanceStore((state) => state.clearDismissals);
  const groupId = useId();

  return (
    <section
      className="assistance-settings"
      aria-labelledby={`${groupId}-heading`}
      {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.settings }}
    >
      <h3 id={`${groupId}-heading`} className="assistance-settings__heading">
        {ASSISTANCE_SETTINGS_COPY.regionHeading[locale]}
      </h3>
      <p className="assistance-settings__purpose">{ASSISTANCE_SETTINGS_COPY.purpose[locale]}</p>

      <fieldset className="assistance-settings__modes" {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.modeGroup }}>
        <legend className="assistance-settings__modes-legend">
          {ASSISTANCE_SETTINGS_COPY.modeHeading[locale]}
        </legend>
        {/*
          Radios rather than a `<select>`: a mode is a choice among named alternatives with an
          explanation each, and a select hides two of the three explanations until it is opened.
          A radio group is one Tab stop and arrow-key navigation, which is what a three-way choice
          should cost. The mode names are the radio labels, so a learner hears "Standard" and not
          "assistance.mode.standard".
        */}
        {ASSISTANCE_MODES.map((candidate) => (
          <div className="assistance-settings__mode" key={candidate}>
            <input
              type="radio"
              id={`${groupId}-mode-${candidate}`}
              name={`${groupId}-mode`}
              value={candidate}
              checked={mode === candidate}
              onChange={() => setMode(candidate)}
            />
            <label htmlFor={`${groupId}-mode-${candidate}`}>
              {ASSISTANCE_MODE_COPY[candidate][locale]}
            </label>
            <p className="assistance-settings__mode-note" id={`${groupId}-note-${candidate}`}>
              {ASSISTANCE_SETTINGS_COPY[MODE_NOTE[candidate]][locale]}
            </p>
          </div>
        ))}
      </fieldset>

      <section
        className="assistance-settings__dismissals"
        aria-labelledby={`${groupId}-dismissals`}
        {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.dismissals }}
        data-assistance-dismissal-count={dismissalCount}
      >
        <h4 id={`${groupId}-dismissals`} className="assistance-settings__dismissals-heading">
          {ASSISTANCE_SETTINGS_COPY.dismissalHeading[locale]}
        </h4>
        <p className="assistance-settings__dismissals-note">
          {dismissalCount === 0
            ? ASSISTANCE_SETTINGS_COPY.dismissalNone[locale]
            : formatAssistanceTemplate(ASSISTANCE_SETTINGS_COPY.dismissalSome[locale], [
                dismissalCount,
              ])}
        </p>
        {dismissalCount === 0 ? null : (
          <button
            type="button"
            className="assistance-settings__clear"
            style={{ minWidth: '44px', minHeight: '44px' }}
            {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.clearDismissals }}
            data-assistance-touch-target="clear-dismissals"
            onClick={clearDismissals}
          >
            {ASSISTANCE_SETTINGS_COPY.clearDismissals[locale]}
          </button>
        )}
      </section>

      {/*
        The live channel. `role="status"` so a mode change or a cleared count is announced where
        the learner already is, without focus moving - the control they just used keeps focus,
        which is the behaviour a radio group is supposed to have. Two separate sentences rather
        than one composed string so a test can assert each independently.
      */}
      <p
        className="assistance-sr-only"
        role="status"
        {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.status }}
        data-assistance-mode={mode}
      >
        {formatAssistanceTemplate(ASSISTANCE_SETTINGS_COPY.modeChanged[locale], [
          ASSISTANCE_MODE_COPY[mode][locale],
        ])}
        {dismissalCount === 0
          ? ` ${ASSISTANCE_SETTINGS_COPY.clearDismissalsDone[locale]}`
          : ''}
      </p>
    </section>
  );
}