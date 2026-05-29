import type { JSX } from 'react';
import { GraphicsModeToggle } from '@/ui/components/GraphicsModeToggle';

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
            In the <strong>Creator</strong> phase, use the Topic tab or Full Map graph-edit mode
            to bulk-add child topics and safely change a topic&rsquo;s parent.
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
            Press <kbd>?</kbd> to toggle this help overlay, or <kbd>M</kbd> to open the
            full mindmap view.
          </li>
          <li>
            Teleport from the HUD to jump to a chosen floor and room, then wait two minutes
            before using the spell again.
          </li>
        </ul>
        <div className="help-overlay__settings">
          <GraphicsModeToggle label="Graphics style" />
          <p className="help-overlay__settings-hint">
            Choose between the mind-map graph view and the RPG dungeon view. You can switch
            at any time — your saved subjects are unchanged.
          </p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
