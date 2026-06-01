import type { JSX } from 'react';

interface GameplayOnboardingModalProps {
  subjectName: string;
  onClose: () => void;
}

export function GameplayOnboardingModal({ subjectName, onClose }: GameplayOnboardingModalProps): JSX.Element {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Gameplay onboarding">
      <div className="modal onboarding-modal">
        <h2>Welcome to your first run</h2>
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
          <button type="button" onClick={onClose}>
            Start exploring
          </button>
        </div>
      </div>
    </div>
  );
}
