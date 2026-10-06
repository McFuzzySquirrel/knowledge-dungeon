/**
 * The first-run explanation of the three-phase loop.
 *
 * ## Phase 21: this was a dialog that trapped nothing
 *
 * It declared `role="dialog" aria-modal="true"` and had no focus management whatsoever: no
 * `useModalFocus`, no `tabIndex={-1}`, no Escape, no restoration. For a learner who reached this
 * surface - it is the *first* thing a new learner sees, before they have any other way to move -
 * that meant Tab walked out of the dialog into a page they did not yet understand, and there was no
 * keyboard route out other than the one button.
 *
 * `aria-modal="true"` on an element with no trap is a claim the markup makes and the behaviour does
 * not honour, and no static analyser can see the difference. That is the reason Phase 21 audited the
 * dialogs by hand as well as by axe.
 *
 * It is `AccessibleDialog` now. `onEscape: onClose`, because a learner who has read enough should
 * not have to find the button - and, more importantly, because this surface must never be a place a
 * keyboard learner can get stuck.
 */
import { useId, type JSX } from 'react';

import { AccessibleDialog } from '@/ui/components/AccessibleDialog';

interface GameplayOnboardingModalProps {
  subjectName: string;
  onClose: () => void;
}

export function GameplayOnboardingModal({ subjectName, onClose }: GameplayOnboardingModalProps): JSX.Element {
  const titleId = useId();

  return (
    <div className="modal-backdrop">
      <AccessibleDialog
        className="modal onboarding-modal"
        active
        onEscape={onClose}
        labelledBy={titleId}
        // A stable test hook for the browser lanes. The accessible name is deliberately derived
        // from the heading above (see `AccessibleDialog`), so a copy edit to that heading must not
        // silently move the locator the lanes dismiss this dialog by. This adds data to the dialog
        // element and changes no accessibility semantics.
        extraProps={{ 'data-testid': 'gameplay-onboarding' }}
      >
        <h2 id={titleId}>Welcome to your first run</h2>
        <p>
          You are entering <strong>{subjectName}</strong>. Knowledge Dungeon runs in a three-phase loop:
          map topics, write encounter notes, then review for retention.
        </p>
        <ol className="onboarding-steps">
          <li>
            <strong>Creator</strong>: grow your topic map with child rooms, links, and floor structure.
          </li>
          <li>
            <strong>Scribe</strong>: open encounters and write notes with Summary, Key Points, and Recall Question.
          </li>
          <li>
            <strong>Archaeologist</strong>: revisit cleared rooms and run review passes after full clear.
          </li>
        </ol>
        <p className="room-help-text">
          Quick controls: <kbd>E</kbd> interacts with the current room, <kbd>M</kbd> opens the map, and
          <kbd>?</kbd> opens help at any time.
        </p>
        <div className="onboarding-actions">
          <button type="button" onClick={onClose} style={{ minWidth: '44px', minHeight: '44px' }}>
            Start exploring
          </button>
        </div>
      </AccessibleDialog>
    </div>
  );
}
