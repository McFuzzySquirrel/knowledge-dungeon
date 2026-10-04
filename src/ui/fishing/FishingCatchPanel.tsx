/**
 * The catch panel: the result of a catch, and the keep-or-release decision.
 *
 * ## What this component owns
 *
 * Two controls and one sentence, and the two controls are the only two legal outcomes of a
 * catch. `FishingRecallModal` is a *third* surface that only appears once the learner has
 * chosen to keep and a recall question exists; this one is what they choose from.
 *
 * Before Phase 17 this card lived inline in `src/ui/village/VillageLaunchers.tsx` as forty
 * lines of JSX with its keep and release wired to whatever the screen happened to pass. It is
 * its own module now for the same reason the HUD is: it is a surface with an accessibility
 * contract, and a contract needs a file to live in.
 *
 * ## Why this is a live region and not a dialog
 *
 * It arrives on its own - the pond reveals a fish and the screen swaps this card in without
 * the learner activating anything - and it asks for a decision. It is therefore a
 * `role="status"` region whose whole card is the announcement, so the fish's name, its rarity,
 * and its description are read aloud as one unit, and a polite live region rather than an
 * assertive one: an interruptive "Caught!" on every cast would be hostile by the tenth.
 *
 * It is deliberately **not** `role="dialog"`. It does not contain focus, it does not block the
 * pond controls behind it, and there is nothing to dismiss with `Escape` that would not also
 * have to be a decision. The recall dialog, which *does* own focus, is a dialog.
 *
 * ## The keep/release split and what each one means
 *
 * - **Keep** opens the recall question. It does not award anything by itself: the award is
 *   `fishing/catch-keep`, and which outcome it commits is the recall's, not this button's.
 * - **Release** throws the fish back. `fishing/catch-release` writes nothing at all - not a
 *   fish, not XP, not a badge - and the button says so in its own hint, so "release" is not
 *   read as "lose a reward I already earned".
 *
 * The wording is deliberately *not* "Keep Fish" / "Release" with nothing else. A learner
 * choosing between them needs to know that releasing is free and keeping asks a question.
 *
 * ## No learner data in any id or key
 *
 * `catalogId` is catalogue content and is carried for the transaction, but the card's React
 * key is nothing at all - the panel holds one catch. The card's own id is the static
 * `FISHING_CONTROL_IDS.catchPanel`, which is what makes focus land here when a fish is
 * revealed.
 */
import { useEffect, useRef, type JSX } from 'react';

import { FISHING_CONTROL_IDS } from '@/ui/study/controlIds';
import type { FishRarity } from '@/core/fishing/fishingTypes';

/** The catch being offered, and the decision about it. */
export interface FishingCatchPanelProps {
  /** The fish's catalogue display name. Resolved from `catalogId` on the DOM side. */
  readonly fishName: string;
  /** Catalogue content, and never a key. */
  readonly catalogId: string;
  readonly rarity: FishRarity;
  /** The catalogue's description, read aloud as part of the announcement. */
  readonly description: string;
  /** Open the recall question for this catch, or keep it without one. */
  readonly onKeep: () => void;
  /** Throw the fish back. Awards nothing and writes nothing. */
  readonly onRelease: () => void;
  /** Move focus here. Used when the card replaces something else on its own. */
  readonly autoFocus?: boolean;
}

export function FishingCatchPanel({
  fishName,
  catalogId,
  rarity,
  description,
  onKeep,
  onRelease,
  autoFocus = false,
}: FishingCatchPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Focus the card when it arrives, if the caller asked for it.
   *
   * The announcement alone would leave a keyboard user with focus still on the pond's hook
   * button - which the machine has just left `biting` for, so that button is now `disabled`
   * and focus would be sitting on a dead control. Focusing the card puts focus on the two
   * buttons that *are* live, which is the difference between a catch being answerable and a
   * catch being announced and then unreachable until the learner guesses where focus went.
   */
  useEffect(() => {
    if (!autoFocus) return;
    panelRef.current?.focus();
  }, [autoFocus]);

  return (
    <div className="modal-backdrop" style={{ zIndex: 350, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/*
        The whole card is the live region rather than a sentence inside it, so the fish's name,
        its rarity, and its description are announced as one unit. The rarity is spelled out
        as a word *and* carried by the badge, which is plan 10.1's no-colour-only rule.
      */}
      <div
        className="village-info-panel ui-skin screen-slide-up fishing-catch-panel"
        id={FISHING_CONTROL_IDS.catchPanel}
        ref={panelRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${fishName}, a ${rarity} fish, caught`}
        tabIndex={-1}
      >
        <div className="village-info-panel-header">
          <span className="village-info-portal-icon" aria-hidden="true">
            🎣
          </span>
          <div>
            <h3>{fishName}</h3>
            <p className="village-info-meta">
              {rarity.charAt(0).toUpperCase() + rarity.slice(1)} fish. Caught.
            </p>
          </div>
          <span className="fish-rarity-badge" data-rarity={rarity}>
            {rarity.toUpperCase()}
          </span>
        </div>
        <p className="village-info-desc">{description}</p>
        {/*
          `catalogId` reaches the DOM as a data attribute for the catch transaction and for
          nothing else. It is catalogue content - a stable slug of a species, not anything the
          learner chose - which is why it is the one identifier on this card that may appear
          as an attribute at all.
        */}
        <p className="fishing-recall__outcome" data-fishing-catalog-id={catalogId}>
          Keep this fish and answer a recall question, or release it and keep nothing. Releasing
          costs you nothing.
        </p>
        <div className="fishing-catch-panel__actions village-info-actions">
          <button
            type="button"
            className="village-enter-btn"
            onClick={onKeep}
            style={{ minWidth: '44px', minHeight: '44px' }}
            data-fishing-touch-target="keep-fish"
          >
            Keep Fish
          </button>
          <button
            type="button"
            className="village-action-btn"
            onClick={onRelease}
            style={{ minWidth: '44px', minHeight: '44px' }}
            data-fishing-touch-target="release-fish"
          >
            Release
          </button>
        </div>
      </div>
    </div>
  );
}