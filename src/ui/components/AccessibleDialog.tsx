/**
 * The reusable accessible dialog: role, labelling, initial focus, Tab containment, Escape, and
 * restoration, from one component.
 *
 * ## Why a component and not only a hook
 *
 * `useModalFocus` already implements the four behaviours plan section 10.1 requires, and fourteen
 * files already call it. Phase 21 asked for `src/ui/components/AccessibleDialog.tsx` as a reusable
 * dialog, and the honest question is what a component adds over the hook. The answer is the part the
 * hook cannot own: **the markup**.
 *
 * The hook is a ref. It cannot put `role="dialog"`, `aria-modal`, `tabIndex={-1}`, or
 * `aria-labelledby` on anything, so every one of those is a decision each of those fourteen files
 * made independently - and Phase 21's audit found the ones that got it wrong. Four dialogs declared
 * `role="dialog"` with **no** `useModalFocus` call at all, so they had no trap, no initial focus, no
 * restoration and no Escape: `SettingsModal`, `NoteEditorModal`, `FullMapView`, `MakeItYoursModal`,
 * `GameplayOnboardingModal` and `HelpOverlay`. Six surfaces, each of which a keyboard user could Tab
 * straight out of and back into the page behind. That is not a keyboard-contract bug in the hook; it
 * is a markup bug, and markup is exactly what a component fixes.
 *
 * The component is therefore **thin on purpose**. It renders the role, the modality, the focusable
 * frame and the labelling, delegates all four behaviours to the hook, and renders `children`
 * untouched. It does not style, it does not own a backdrop, it does not decide a layout, and it does
 * not wrap the twenty working dialogs - a dialog that already gets all four behaviours right is not
 * made more correct by being rewritten, and rewriting them would put twenty working surfaces behind
 * a migration nobody asked for. What changed is the set of dialogs that were **wrong**.
 *
 * ## The five props, and why each exists
 *
 * | prop | what it decides | what it prevents |
 * | --- | --- | --- |
 * | `label` | `aria-label` on the dialog | an unlabelled dialog a screen reader calls "dialog" |
 * | `labelledBy` | `aria-labelledby` at the caller's own heading | the same, and a second copy of the title |
 * | `onEscape` | Escape, or `null` while it must not be dismissed | a dialog that looks dismissible and ignores the key |
 * | `active` | whether focus is managed at all | a trap on a surface that is not open |
 * | `className` | the caller's own classes | a second styling system |
 *
 * `initialFocusRef` is deliberately **not** a prop. The ARIA authoring-practice default - focus the
 * dialog frame - is what `useModalFocus` already does, and it is right for the common case where the
 * first thing in a dialog is a heading: focusing the first button instead puts the most expensive or
 * most destructive action under the learner's next `Enter`. A caller that genuinely needs to start
 * somewhere else can call `.focus()` in an effect, and the two dialogs in this repository that do
 * (`FishingCatchPanel`) already own that decision explicitly.
 *
 * ## `aria-modal`
 *
 * Required, and defaulted to `true`. A dialog that is not modal - a sheet beside live content the
 * learner is meant to keep using - is the honest exception and `VillagePanel` keeps its own
 * hand-written element for that, because it is a different thing with a different contract. This
 * component is for dialogs that are modal, and it says so in the markup rather than leaving it to a
 * reader.
 *
 * ## What this is not
 *
 * It is not a `Modal` that knows about panels and headers and footers. Nineteen surfaces here have
 * genuinely different interiors - a two-button confirmation, a share-card preview, a room panel, a
 * migration surface with its own nested dialog - and a component that grew props for all of them
 * would be a worse dialog than the one it replaced. The value here is the five lines of semantics
 * that were being written by hand, twenty times, six times wrong.
 */
import type { ReactNode } from 'react';

import { useModalFocus } from '@/ui/hooks/useModalFocus';

export interface AccessibleDialogProps {
  /** The dialog's children, in whatever layout the caller needs. Rendered untouched. */
  readonly children: ReactNode;
  /**
   * The accessible name, when the dialog has no visible heading of its own to point at.
   *
   * Ignored when `labelledBy` is given, because `aria-labelledby` wins over `aria-label` in the
   * accessible-name computation and having both is the kind of disagreement axe reports.
   */
  readonly label?: string;
  /**
   * The id of the dialog's own visible heading.
   *
   * Preferred over `label` whenever the dialog *has* a heading: the name then comes from the same
   * text the learner is reading, so the two cannot disagree - which is the failure mode of a
   * hardcoded `aria-label` on a surface whose `<h2>` was edited.
   */
  readonly labelledBy?: string;
  /** Whether the dialog is open. Focus is managed only while this is `true`. */
  readonly active: boolean;
  /**
   * Escape handler, or `null` while the dialog must not be dismissed.
   *
   * `null` is a real state, not a missing prop: a dialog whose action is in flight has already
   * promised the learner a result, and Escape must genuinely not close it. See `ConfirmDialog` and
   * `CreateSubjectDialog`, which both pass `null` while submitting for exactly this reason.
   */
  readonly onEscape: (() => void) | null;
  /** The caller's own class names. */
  readonly className?: string;
  /** Anything else the caller needs on the dialog element. */
  readonly extraProps?: Record<string, unknown>;
}

export function AccessibleDialog({
  children,
  label,
  labelledBy,
  active,
  onEscape,
  className,
  extraProps,
}: AccessibleDialogProps): ReactNode {
  const dialogRef = useModalFocus<HTMLDivElement>({ active, onEscape });

  /*
   * Exactly one naming mechanism, chosen by which prop the caller supplied.
   *
   * `aria-labelledby` wins when the dialog has a visible heading, so the name comes from the same text the
   * learner is reading and the two cannot drift. `aria-label` is the fallback for a dialog with no heading
   * of its own. Both are never written together: `aria-labelledby` wins in the accessible-name
   * computation, so a dialog carrying both would have an `aria-label` that silently does nothing - a
   * second copy of the name, free to disagree with the first. That is the disagreement
   * `tests/phase21/dialogAudit.test.tsx` found here on the first run of this component.
   *
   * Neither is written when the caller supplied neither, and `data-dialog-unlabelled` records that. An
   * unnamed dialog is a defect, and a defect nobody can find is worse than one they can.
   */
  const nameProps =
    labelledBy !== undefined
      ? { 'aria-labelledby': labelledBy }
      : label !== undefined
        ? { 'aria-label': label }
        : { 'data-dialog-unlabelled': 'true' };

  return (
    <div
      ref={dialogRef}
      className={className}
      role="dialog"
      aria-modal="true"
      // The container must itself be focusable or `useModalFocus` has nothing to focus on open.
      tabIndex={-1}
      {...nameProps}
      {...extraProps}
    >
      {children}
    </div>
  );
}
