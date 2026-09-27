/**
 * The Data Center's explicit confirmation, for both products.
 *
 * Phase 5 built this dialog once, for the `.kdbak` restore. Phase 6 needs the
 * same dialog for a `.kdsubject` import, where the wording is different, the
 * decision is different, and one mode of it is destructive in a way a
 * whole-device restore never is. So the dialog is this component and the two tabs
 * supply the words.
 *
 * ## What is fixed here, and why it is not a prop
 *
 * The three things plan section 10.1 requires of every dialog are implemented
 * once, in `useModalFocus`, and this component is the only thing that calls it
 * with a modal's arguments:
 *
 * - `role="dialog"` with `aria-modal="true"`, `aria-labelledby`, and
 *   `aria-describedby` all pointing at elements this component renders, so the
 *   accessible name and the accessible description cannot drift from the visible
 *   title and body;
 * - **initial focus on the dialog container**, which is the ARIA authoring
 *   practice's choice for a dialog whose first content is a heading and a
 *   description. Focusing the first button instead would put a destructive
 *   action under the learner's next Enter - and this dialog is used by a
 *   destructive confirmation, so that mistake is available here;
 * - focus containment on Tab and Shift+Tab, and restoration to the element that
 *   had focus when the dialog opened.
 *
 * Escape is here too, and it is `null` while `busy` is true. That is not a
 * stylistic choice: a surface that looks dismissible and ignores the key is worse
 * than one that does not, and an import in flight has already promised the
 * learner a result. Phase 5 established this and Phase 6 keeps it - the same
 * rule, one implementation, two callers.
 *
 * ## Why the confirm control is a caller-supplied prop and not a form
 *
 * There is no `<form>` in this file, and there must never be one: a form is
 * where an implicit submission comes from, and an implicit submission is a
 * destructive action one stray Enter away. Every control is `type="button"`, so
 * Enter activates exactly the control that has focus. This is the structural half
 * of "a replace must never be reachable by an Enter keypress"; the other half is
 * in `SubjectBackupTab`, which does not put a text field anywhere near it.
 *
 * ## Tone
 *
 * Both callers pass `danger`. That is deliberate rather than a missing option: the
 * `.kdbak` restore discards which generation the device is using, and the
 * `.kdsubject` replace destroys a named subject. There is no non-destructive
 * "just close this" commit path in the Data Center, and adding one would create
 * exactly the ambiguity this dialog exists to remove.
 */

import { useId, type ReactNode } from 'react';

import { useModalFocus } from '@/ui/hooks/useModalFocus';

export interface ConfirmDialogProps {
  /** Whether the dialog is on screen. */
  readonly open: boolean;
  /**
   * The visible heading, and therefore the dialog's accessible name.
   *
   * Written as a question wherever the answer destroys something, because the
   * heading is what a screen reader announces on arrival.
   */
  readonly title: string;
  /** The body: what will happen, what is kept, and what is disclosed. */
  readonly children: ReactNode;
  /** `true` while the operation is in flight. Escape stops working. */
  readonly busy: boolean;
  /** Label of the control that abandons the operation. */
  readonly dismissLabel: string;
  /** Label of the control that commits it. */
  readonly confirmLabel: string;
  /**
   * `true` only when committing is actually possible right now.
   *
   * A caller that has not finished reading the file, or that has not established
   * what the file does, passes `false` and the confirm control is disabled - so
   * "there is no route to the operation" is a property of the control rather
   * than a property of the learner's care.
   */
  readonly confirmDisabled: boolean;
  readonly onDismiss: () => void;
  readonly onConfirm: () => void;
  /** Announced while `busy`, explaining why the window will not close. */
  readonly busyMessage?: string | null;
  /**
   * The `data-kd-surface` value this dialog carries.
   *
   * Two dialogs, one per product, so a test can address the one it means and
   * assert the other is absent. It is never used to select behaviour.
   */
  readonly surface: string;
}

/**
 * Note for a caller adding a third confirmation.
 *
 * There is deliberately no `restoreFocusTo` prop. `useModalFocus` restores to
 * whatever had focus when the dialog opened, and both tabs therefore move focus
 * to their own "choose a file" button *before* opening. A prop here would invite
 * a caller to believe it overrides that, which it would not.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  busy,
  dismissLabel,
  confirmLabel,
  confirmDisabled,
  onDismiss,
  onConfirm,
  busyMessage = null,
  surface,
}: ConfirmDialogProps): ReactNode {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>({
    active: open && !busy,
    onEscape: open && !busy ? onDismiss : null,
  });

  if (!open) return null;

  return (
    <div className="kd-dialog-layer">
      <div
        className="kd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        ref={dialogRef}
        data-kd-surface={surface}
      >
        <h3 className="kd-dialog-title" id={titleId}>
          {title}
        </h3>
        <div id={bodyId}>{children}</div>
        {busy && busyMessage !== null ? (
          <p className="kd-dialog-line" role="status" aria-live="polite">
            {busyMessage}
          </p>
        ) : null}
        <div className="kd-actions">
          <button type="button" className="kd-button" onClick={onDismiss} disabled={busy}>
            {dismissLabel}
          </button>
          <button
            type="button"
            className="kd-button kd-button--danger"
            onClick={onConfirm}
            disabled={confirmDisabled || busy}
            aria-busy={busy || undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
