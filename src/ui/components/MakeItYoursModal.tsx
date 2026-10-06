/**
 * The sprite editor dialog.
 *
 * ## Phase 21: this was a dialog that trapped nothing
 *
 * It declared `role="dialog" aria-modal="true"` and had **no** focus management at all: no
 * `useModalFocus`, no `tabIndex={-1}`, no Escape, no restoration. A keyboard learner who opened
 * "Make It Yours" from Settings could Tab forward out of the dialog and into the Settings dialog
 * behind it, and could not leave with Escape. The axe suite did not report it as a violation -
 * `aria-modal` looks correct to a static analyser, which is exactly why this class of defect
 * survives a scan - so it was found by Phase 21's dialog audit rather than by the tool.
 *
 * It is `AccessibleDialog` now. `onEscape: onClose` because Escape should close a sprite editor, and
 * because a dialog that cannot be dismissed from the keyboard is a keyboard trap of the other kind.
 * The label comes from the visible `<h2>` through `aria-labelledby`, so renaming the dialog cannot
 * leave a stale `aria-label` behind.
 *
 * The backdrop stays outside the dialog, as everywhere else in this codebase: a click on it is a
 * separate affordance, not part of the dialog's semantics, and putting `role="presentation"` on the
 * same element that carries `role="dialog"` would be the `aria-allowed-attr` mistake Phase 21 fixed
 * in Settings.
 */
import { type JSX } from 'react';
import { MakeItYoursTab } from '@/ui/components/MakeItYoursTab';
import { AccessibleDialog } from '@/ui/components/AccessibleDialog';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

interface MakeItYoursModalProps {
  onClose: () => void;
}

export function MakeItYoursModal({ onClose }: MakeItYoursModalProps): JSX.Element {
  const { t } = useTranslation();
  const title = t('makeItYours.title', 'Make It Yours');
  const titleId = useId();

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <AccessibleDialog
        className="modal make-it-yours-modal"
        active
        onEscape={onClose}
        labelledBy={titleId}
        extraProps={{ onClick: (event: { stopPropagation(): void }) => event.stopPropagation() }}
      >
        <div className="make-it-yours-modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ghost modal-close-btn" onClick={onClose} aria-label={t('common.close', 'Close')}>
            ×
          </button>
        </div>
        <MakeItYoursTab />
      </AccessibleDialog>
    </div>
  );
}
