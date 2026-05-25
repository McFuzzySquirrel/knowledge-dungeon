import type { JSX } from 'react';

interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps): JSX.Element {
  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="Help">
      <div className="panel">
        <h2>How to play</h2>
        <ul>
          <li>
            Move with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow keys.
          </li>
          <li>
            Press <kbd>E</kbd> (or tap <kbd>Interact</kbd>) to open the encounter for the room
            you&rsquo;re standing in.
          </li>
          <li>
            In the <strong>Creator</strong> phase, use the Topic tab&rsquo;s &ldquo;Add child
            topic&rdquo; form to grow your subject graph.
          </li>
          <li>
            In the <strong>Scribe</strong> phase, write at least 120 words with Summary, Key
            Points, and Recall Question sections to defeat an encounter and earn XP, loot, and
            an artifact.
          </li>
          <li>
            Once every room is cleared, the <strong>Archaeologist</strong> phase unlocks and the
            interact button records a review pass on the room.
          </li>
          <li>
            Press <kbd>?</kbd> to toggle this help overlay.
          </li>
        </ul>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
