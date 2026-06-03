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
            Move with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow keys, and
            press <kbd>E</kbd> or tap <kbd>Interact</kbd> to open the room you&rsquo;re standing in.
          </li>
          <li>
            Use the HUD <kbd>Map</kbd> button or <kbd>M</kbd> to open the full map. From there you
            can drag the canvas, zoom, and drag individual room nodes to reshape the layout.
          </li>
          <li>
            The room panel&rsquo;s <strong>Inventory</strong>, <strong>Badges</strong>, and
            <strong>Diary</strong> buttons open your collected loot, milestone badges, and saved
            notes.
          </li>
          <li>
            Use <kbd>Teleport</kbd> to arm Teleport Mode and jump to a room from the map. After
            teleporting, wait for the cooldown before using it again.
          </li>
          <li>
            In the <strong>Creator</strong> phase, use the Topic tab or the map edit tools to add,
            reparent, or delete topics. In the <strong>Scribe</strong> phase, defeat encounters by
            writing the required notes. Once the dungeon is cleared, the
            <strong>Archaeologist</strong> phase turns room interactions into review passes.
          </li>
          <li>
            Room images are managed in the note editor during the
            <strong>Scribe</strong> phase. Press <kbd>E</kbd> to open the editor, then use
            <strong>Insert in note</strong> from an image card to place an image in your note. Use
            <strong>Expand</strong> on the room panel when you want a larger writing/media workspace.
          </li>
          <li>
            Press <kbd>I</kbd> to open or close the room info panel (topic details, notes, and
            review stats for the current room).
          </li>
          <li>
            Press <kbd>?</kbd> to toggle this Help overlay.
          </li>
        </ul>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
