import { type JSX } from 'react';
import { MakeItYoursTab } from '@/ui/components/MakeItYoursTab';
import { useTranslation } from 'react-i18next';

interface MakeItYoursModalProps {
  onClose: () => void;
}

export function MakeItYoursModal({ onClose }: MakeItYoursModalProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal make-it-yours-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('makeItYours.title', 'Make It Yours')}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{t('makeItYours.title', 'Make It Yours')}</h2>
        <MakeItYoursTab />
        <div className="onboarding-actions" style={{ marginTop: 12 }}>
          <button type="button" className="ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
