/**
 * The village NPC dialogue bubble.
 *
 * ## What this is
 *
 * The pre-Phase-12 markup, with two things added and one thing replaced.
 *
 * **Replaced:** the anchor was a bare `{x, y}` this screen kept in its own state.
 * It is now a `VillageNpcDialogAnchor` - `{npcId, clientX, clientY}` in **CSS
 * viewport pixels** - which is the contract's own type. That matters because the
 * number the bubble positions itself from is now the number a renderer contract
 * says it is in, rather than a coordinate the screen hopes means the same thing
 * in both renderers. `VillageNpcDialogAnchorMatchesTheEvent` in
 * `src/application/contracts/villageNpc.ts` is what makes that a checked fact.
 *
 * **Added, 1 - a polite live region.** The line changes as a conversation cycles
 * and as a quest step changes underneath it, and a learner using a screen reader
 * otherwise has no way to learn that anything was said. The live region is on a
 * **stable** wrapper and the typing animation's `key` is on the inner paragraph,
 * so replacing the animated node does not tear down the region that announces it.
 *
 * **Added, 2 - words for the state.** A cycling conversation shows "line 2 of 4"
 * as a word, not as four dots, and a wanderer's line is labelled with where it came
 * from, so "what is this NPC saying now" is answerable without the canvas.
 *
 * ## Anchoring
 *
 * The measurement is `offsetWidth` / `offsetHeight` of the bubble itself plus the
 * viewport, which is why the effect runs on `npcDialogAnchor` and on `resize` but
 * not on a frame loop: a bubble's size changes when its *text* changes, and the
 * text is a prop, so a prop change is the trigger. Anchoring to the renderer at
 * 60 Hz would be the same mistake the compass had.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';

import type { VillageNpcDialogAnchor, VillageNpcLineSource } from '@/application/contracts/villageNpc';

export interface NpcDialogProps {
  /** The line to show. Render nothing at all when empty - see the note below. */
  readonly line: string;
  /** Which NPC is speaking, or `null` before the first approach. */
  readonly npcId: string | null;
  /** The NPC's display label, or `null`. */
  readonly label: string | null;
  /** Where to attach, in CSS viewport pixels, or `null` for the resting position. */
  readonly anchor?: VillageNpcDialogAnchor | null;
  /** Which pool the line came from, when the surface knows. */
  readonly source?: VillageNpcLineSource | null;
  /** How many lines the pool has, when the surface knows. A floor of 1. */
  readonly lineCount?: number;
  /** Index within the pool, when the surface knows. */
  readonly lineIndex?: number;
  /** The glyph for the speaking NPC. Decorative. */
  readonly icon?: string;
  /** The `data-theme` value the screen is themed with. */
  readonly colorTheme: string;
  /** The "how to make it say the next line" sentence. */
  readonly continueHint?: string;
}

const MARGIN = 12;
const GAP = 24;
const VERTICAL_GAP = 8;
const FALLBACK_WIDTH = 360;
const FALLBACK_HEIGHT = 140;

/** Where a line came from, in words. A wanderer's quote reads differently on purpose. */
const SOURCE_WORDS: Readonly<Record<VillageNpcLineSource, string>> = Object.freeze({
  quest: 'Quest guidance',
  quote: 'Small talk',
  greeting: 'Greeting',
  dialogue: 'Small talk',
});

/**
 * The bubble.
 *
 * Returns an empty fragment for an empty `line`, which is the contract's stated
 * content signal rather than a transient state: `selectVillageNpcLine` returns
 * `line: ''` **only** when the NPC has no authored content anywhere, and a panel
 * that retried or rendered an empty box would be hiding an authoring mistake
 * behind a plausible-looking empty dialog.
 */
export function NpcDialog({
  line,
  npcId,
  label,
  anchor = null,
  source = null,
  lineCount,
  lineIndex,
  icon,
  colorTheme,
  continueHint = 'Press E to continue',
}: NpcDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [anchoredStyle, setAnchoredStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (anchor === null) {
      setAnchoredStyle(null);
      return;
    }

    const updatePosition = (): void => {
      const dialog = dialogRef.current;
      if (dialog === null) return;

      // jsdom reports 0 for every box, so the fallbacks are what a non-rendering
      // environment sees; in a browser the real measurements win.
      const dialogWidth = dialog.offsetWidth || FALLBACK_WIDTH;
      const dialogHeight = dialog.offsetHeight || FALLBACK_HEIGHT;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Prefer the right of the NPC, flip to the left when that would run off the
      // edge, then clamp - so the bubble is always fully on screen even when the
      // NPC is standing in a corner.
      const fitsRight = anchor.clientX + dialogWidth + GAP <= viewportWidth - MARGIN;
      const preferredLeft = fitsRight
        ? anchor.clientX + GAP
        : anchor.clientX - dialogWidth - GAP;
      const above = anchor.clientY - dialogHeight - VERTICAL_GAP;
      const preferredTop = above >= MARGIN ? above : anchor.clientY + VERTICAL_GAP;

      const maxLeft = Math.max(MARGIN, viewportWidth - dialogWidth - MARGIN);
      const maxTop = Math.max(MARGIN, viewportHeight - dialogHeight - MARGIN);
      const left = Math.min(Math.max(preferredLeft, MARGIN), maxLeft);
      const top = Math.min(Math.max(preferredTop, MARGIN), maxTop);

      setAnchoredStyle({ left: `${left}px`, top: `${top}px` });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [anchor, line]);

  if (line === '') return <></>;

  const anchored = anchor !== null;
  const progress =
    typeof lineCount === 'number' && typeof lineIndex === 'number' && lineCount > 0
      ? `Line ${lineIndex + 1} of ${lineCount}. `
      : '';
  const sourceWord = source === null ? '' : `${SOURCE_WORDS[source]}. `;

  return (
    <div
      // The live region sits on this stable wrapper; the animated paragraph below
      // is the only thing that is remounted, so the region survives the key change
      // and still announces the new line.
      className={`village-npc-dialog ui-skin${anchored ? ' village-npc-dialog--anchored' : ''}`}
      data-theme={colorTheme}
      // The NPC id goes into the DOM rather than into the accessible name: it is
      // what identifies *whose* conversation this is when two bubbles' worth of
      // state is being reasoned about, and the label is already what a screen
      // reader should hear.
      data-npc-id={npcId ?? undefined}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      ref={dialogRef}
      style={anchored ? (anchoredStyle ?? undefined) : undefined}
    >
      <div className="village-npc-dialog-header">
        <span className="village-npc-dialog-icon" aria-hidden="true">
          {icon ?? '🧙'}
        </span>
        <strong>{label ?? 'Villager'}</strong>
      </div>
      <p className="village-npc-dialog-text village-npc-dialog-text--typing" key={line}>
        {line}
      </p>
      <p className="village-npc-dialog-hint">
        <span className="village-npc-dialog-progress">{progress + sourceWord}</span>
        {continueHint}
      </p>
    </div>
  );
}
