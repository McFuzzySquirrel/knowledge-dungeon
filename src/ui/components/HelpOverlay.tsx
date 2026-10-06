/**
 * The help overlay: the keyboard and touch reference, on the `?` key or the HUD's Help control.
 *
 * ## Phase 21: this was a dialog that trapped nothing
 *
 * It declared `role="dialog" aria-modal="true"` and had no focus management at all: no
 * `useModalFocus`, no `tabIndex={-1}`, no Escape handler, no restoration. The `<kbd>?</kbd>` line in
 * this very component's own copy claims "Press `?` to toggle this Help overlay" - and while the
 * overlay was open, focus could be anywhere, so a learner pressing `?` again had no route back. They
 * could Tab out of the overlay into the world behind it and would have had no way to tell they had
 * left a dialog.
 *
 * That is the specific failure plan section 10.1 names: "a keyboard user who tabs past the last
 * control lands in the page behind it and cannot tell they have left." This overlay was the easiest
 * surface in the product to trigger it on, because it is opened by a keypress and has no visible
 * close affordance in the header.
 *
 * It is `AccessibleDialog` now. `onEscape: onClose`, which also makes the copy's `?` claim true in
 * the direction that matters - a learner who opened help can get out of it.
 *
 * The 44-pixel floor is inline on the Close button for the Phase 20 reason: jsdom computes no layout,
 * so a stylesheet rule cannot be asserted by a component test and an inline declaration can.
 */
import { useId, type JSX } from 'react';

import { AccessibleDialog } from '@/ui/components/AccessibleDialog';

interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps): JSX.Element {
  const titleId = useId();

  return (
    <AccessibleDialog className="help-overlay" active onEscape={onClose} labelledBy={titleId}>
      <div className="panel">
        <h2 id={titleId}>How to play</h2>
        <ul>
          <li>
            Move with <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow keys, and
            press <kbd>E</kbd> or tap <kbd>Interact</kbd> to trigger the current phase action for
            the room you&rsquo;re standing in.
          </li>
          <li>
            On touch screens, <strong>drag</strong> on the game canvas to move your character,
            <strong>tap</strong> the canvas (or the <strong>⚔ Interact</strong> button) to trigger
            the room action, and <strong>pinch</strong> with two fingers to zoom in or out.
          </li>
          <li>
            Use the HUD <kbd>Map</kbd> button or <kbd>M</kbd> to open the full map. From there you
            can drag the canvas, zoom, and drag individual room nodes to reshape the layout.
          </li>
          <li>
            The HUD&rsquo;s <strong>Inventory</strong>, <strong>Badges</strong>, and
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
            writing the required notes. In the <strong>Archaeologist</strong> phase, revisit
            cleared rooms to run review passes &mdash; reviewing unlocks once every room encounter
            in the dungeon is cleared. Opening a room panel starts a pass but does not count it;
            the pass is counted when you complete the review or close the panel.
          </li>
          <li>
            Room images are managed in the note editor during the
            <strong>Scribe</strong> phase. Press <kbd>E</kbd> to open the editor, then use
            <strong>Insert in note</strong> from an image card to place an image in your note. Use
            <strong>Expand</strong> on the room panel when you want a larger writing/media workspace.
          </li>
          <li>
            Press <kbd>I</kbd> to open or close the room info panel. Its tabs follow the phase:
            topic tools in <strong>Creator</strong>, notes and review stats in
            <strong>Scribe</strong> and <strong>Archaeologist</strong>.
          </li>
          <li>
            Press <kbd>?</kbd> to toggle this Help overlay.
          </li>
        </ul>
        <button type="button" onClick={onClose} style={{ minWidth: '44px', minHeight: '44px' }}>
          Close
        </button>
      </div>
    </AccessibleDialog>
  );
}
