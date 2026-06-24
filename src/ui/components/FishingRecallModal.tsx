import type { JSX } from 'react';
import type { FishRarity } from '@/game/systems/fishingTypes';
import type { SelfCheckPrompt } from '@/core/review/types';

export interface FishingRecallModalProps {
  fishName: string;
  rarity: FishRarity;
  catalogId: string;
  description: string;
  recallQuestion: { prompt: SelfCheckPrompt; roomId: string } | null;
  onSelfEvaluate: (result: 'correct' | 'incorrect') => void;
  onCancel: () => void;
}

export function FishingRecallModal({
  fishName,
  rarity,
  recallQuestion,
  onSelfEvaluate,
  onCancel,
}: FishingRecallModalProps): JSX.Element {
  return (
    <div
      className="modal-backdrop fishing-recall-modal"
      style={{ zIndex: 360 }}
      role="presentation"
    >
      <div
        className="village-info-panel ui-skin fishing-recall-panel"
        role="dialog"
        aria-modal="true"
        aria-label={recallQuestion ? `Recall question for ${fishName}` : `Keep ${fishName}`}
        onClick={(event) => event.stopPropagation()}
        style={{ position: 'relative', left: 'auto', transform: 'none' }}
      >
        <div className="village-info-panel-header">
          <span className="village-info-portal-icon">🎣</span>
          <div>
            <h3>{fishName}</h3>
            <p className="village-info-meta">
              {recallQuestion
                ? 'Test your knowledge — did you remember this?'
                : 'No review material available'}
            </p>
          </div>
          <span className="fish-rarity-badge" data-rarity={rarity}>
            {rarity.toUpperCase()}
          </span>
        </div>

        {recallQuestion ? (
          <>
            <p className="village-info-desc">{recallQuestion.prompt.text}</p>
            <div className="village-info-actions">
              <button
                type="button"
                className="village-enter-btn"
                onClick={() => onSelfEvaluate('correct')}
              >
                I got it right
              </button>
              <button
                type="button"
                className="village-action-btn"
                onClick={() => onSelfEvaluate('incorrect')}
              >
                I need to review
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="village-info-desc">
              No review material available — you can keep this fish without a question.
            </p>
            <div className="village-info-actions">
              <button
                type="button"
                className="village-enter-btn"
                onClick={() => onSelfEvaluate('correct')}
              >
                Keep Fish
              </button>
              <button
                type="button"
                className="village-action-btn"
                onClick={onCancel}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
