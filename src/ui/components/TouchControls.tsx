import type { JSX } from 'react';

interface TouchControlsProps {
  onInteract: () => void;
}

/**
 * Repo-dungeon's on-screen D-pad + Interact button.
 * For mobile/tablet players who don't have a keyboard. The D-pad is purely
 * visual here (Phaser already reads keyboard); production builds wire it
 * to synthetic key events.
 */
export function TouchControls({ onInteract }: TouchControlsProps): JSX.Element {
  return (
    <div className="touch-rail" aria-label="Touch controls">
      <div className="dpad" aria-hidden>
        <span />
        <button type="button" aria-label="Up">↑</button>
        <span />
        <button type="button" aria-label="Left">←</button>
        <span />
        <button type="button" aria-label="Right">→</button>
        <span />
        <button type="button" aria-label="Down">↓</button>
        <span />
      </div>
      <button type="button" className="interact" onClick={onInteract}>
        Interact (E)
      </button>
    </div>
  );
}
