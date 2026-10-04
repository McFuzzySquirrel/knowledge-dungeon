/**
 * The village's modal launchers: stats, settings, sprites, fish, and the catch.
 *
 * ## Why these are one module
 *
 * The plan's Phase 12 scope says to split the screen "into focused HUD, structure
 * panel, NPC dialogue, quest board, subject creation, stats, data, and settings
 * launchers". Subject creation and data have their own modules because they have
 * their own behaviour; the other four are one line each in the screen that opens
 * an already-built modal from `src/ui/components/`, so giving each its own file
 * would be four files of `open ? <Modal onClose={...}/> : null`.
 *
 * What this module adds over the pre-Phase-12 inline blocks:
 *
 * - **A live region for the fish catch and the welcome card.** Both replace what
 *   was on screen a moment ago and neither is opened by a control the learner just
 *   activated, so neither is announced by anything. Each is a `role="status"`
 *   sentence in words - the fish's name and rarity, the welcome text - so nothing
 *   is carried by the emoji or the colour of the rarity badge alone.
 * - **A labelled dismiss control on the fish-catch and welcome cards.** Both were
 *   dismissible only by clicking the backdrop. Both now say so.
 * - **The welcome card keeps its own heading and a real button** rather than a
 *   `div` that is only a heading plus a `span` pretending to be one.
 *
 * The two heavier modals it delegates to - `StudyStatsPanel` and `SettingsModal` -
 * are Phase 8/9 surfaces with their own owners, and are rendered here exactly as
 * the screen rendered them. Rewriting them is not this phase's work.
 */
import { useId, type ReactNode } from 'react';

import type { SelfCheckPrompt } from '@/core/review/types';
import type { FishRarity } from '@/core/fishing/fishingTypes';
import { MakeItYoursModal } from '@/ui/components/MakeItYoursModal';
import { SettingsModal } from '@/ui/components/SettingsModal';
import { StudyStatsPanel } from '@/ui/components/StudyStatsPanel';
import { FishStandPanel } from '@/ui/components/FishStandPanel';
import { FishingRecallModal } from '@/ui/components/FishingRecallModal';
import type { FishingRecallChoice } from '@/ui/components/FishingRecallModal';
import { FishingCatchPanel } from '@/ui/fishing/FishingCatchPanel';
import type { RecallRoomDestination } from '@/ui/fishing/fishingRecallNavigation';
import type { ColorTheme } from '@/store/preferencesStore';

import { VILLAGE_TOUCH_TARGET_STYLE } from './villageTypes';

export interface VillageFishCatch {
  readonly fishName: string;
  readonly rarity: string;
  readonly catalogId: string;
  readonly description: string;
}

/**
 * Whether the recall dialog is open.
 *
 * Separate from `recallQuestion` on purpose. Before Phase 17 the dialog rendered only when a
 * question existed, so "the pond had no question" was indistinguishable from "the question is
 * still loading" and from "the learner dismissed it" - and the only way to offer the
 * kept-without-recall outcome was to not render the dialog at all, which is precisely how that
 * outcome came to be recorded as a correct answer.
 */
export interface VillageLaunchersProps {
  /** Open the recall dialog for the current catch, whether or not it has a question. */
  readonly showRecallModal: boolean;
  readonly colorTheme: ColorTheme;
  readonly showStats: boolean;
  readonly onCloseStats: () => void;
  readonly settingsOpen: boolean;
  readonly onThemeChange: (theme: ColorTheme) => void;
  readonly onCloseSettings: () => void;
  readonly spriteEditorOpen: boolean;
  readonly onCloseSpriteEditor: () => void;
  readonly fishStandOpen: boolean;
  readonly onCloseFishStand: () => void;
  /** The catch being offered, or `null`. */
  readonly fishCatch: VillageFishCatch | null;
  readonly onKeepFish: () => void;
  readonly onReleaseFish: () => void;
  /**
   * The recall question for the current catch, or `null` when the pond had none.
   *
   * `null` is now a **reachable** state rather than an accident of an async load: Phase 17
   * gives "kept with no recall material" its own outcome, and that outcome's dialog is this
   * component's no-question branch. `FishingRecallModal` renders a distinct third decision
   * there - keep the fish, earn nothing - instead of the pre-Phase-17 "Keep Fish" button that
   * paid `FSH_XP_PER_CORRECT_ANSWER`.
   */
  readonly recallQuestion: { prompt: SelfCheckPrompt; roomId: string } | null;
  /**
   * The learner committed one of three outcomes.
   *
   * `'correct' | 'incorrect'` is gone, and its absence is the fix: two values could not express
   * "kept with no question", so that case was reported as a correct answer and paid learning XP.
   */
  readonly onRecallDecision: (choice: FishingRecallChoice, roomId: string | null) => void;
  readonly onCancelRecall: () => void;
  /**
   * The subject and room the recall question came from, for its "open that room" route.
   *
   * `null` hides the route rather than rendering a control that cannot work - the rule the whole
   * app follows for a capability it does not have.
   */
  readonly recallDestination: RecallRoomDestination | null;
  /** The one-shot welcome sentence, or `null`. */
  readonly welcomeMessage: string | null;
  readonly onDismissWelcome: () => void;
}

export function VillageLaunchers(props: VillageLaunchersProps): ReactNode {
  const {
    colorTheme,
    showStats,
    onCloseStats,
    settingsOpen,
    onThemeChange,
    onCloseSettings,
    spriteEditorOpen,
    onCloseSpriteEditor,
    fishStandOpen,
    onCloseFishStand,
    fishCatch,
    onKeepFish,
    onReleaseFish,
    showRecallModal,
    recallQuestion,
    onRecallDecision,
    onCancelRecall,
    recallDestination,
    welcomeMessage,
    onDismissWelcome,
  } = props;
  const welcomeTitleId = useId();

  return (
    <>
      {showStats ? <StudyStatsPanel onClose={onCloseStats} /> : null}

      {settingsOpen ? (
        <SettingsModal
          currentTheme={colorTheme}
          onThemeChange={(theme) => onThemeChange(theme as ColorTheme)}
          onClose={onCloseSettings}
        />
      ) : null}

      {spriteEditorOpen ? <MakeItYoursModal onClose={onCloseSpriteEditor} /> : null}

      {fishStandOpen ? <FishStandPanel onClose={onCloseFishStand} /> : null}

      {/*
        The catch card and its recall dialog, delegated.

        Both were inline JSX here before Phase 17. The card is now
        `src/ui/fishing/FishingCatchPanel.tsx` and the dialog is a three-outcome surface with a
        focus trap, an Escape route, and focus restoration - none of which belongs in a
        launcher whose job is "open this if it is switched on". The decision props are passed
        through verbatim; this module decides nothing about what a catch is worth.
      */}
      {fishCatch !== null ? (
        <FishingCatchPanel
          fishName={fishCatch.fishName}
          rarity={fishCatch.rarity as FishRarity}
          catalogId={fishCatch.catalogId}
          description={fishCatch.description}
          onKeep={onKeepFish}
          onRelease={onReleaseFish}
          // The card replaces the pond's hook control, which the machine has just left
          // `biting` for - so without this, focus would sit on a now-disabled button while the
          // card announced a catch nobody could reach.
          autoFocus
        />
      ) : null}

      {fishCatch !== null && showRecallModal ? (
        <FishingRecallModal
          fishName={fishCatch.fishName}
          rarity={fishCatch.rarity as FishRarity}
          catalogId={fishCatch.catalogId}
          description={fishCatch.description}
          recallQuestion={recallQuestion}
          destination={recallDestination}
          onDecide={onRecallDecision}
          onCancel={onCancelRecall}
        />
      ) : null}

      {welcomeMessage !== null ? (
        <div
          className="modal-backdrop"
          style={{ zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            className="village-info-panel ui-skin screen-fade-in"
            data-theme={colorTheme}
            style={{ maxWidth: 420, position: 'relative', zIndex: 301, left: 'auto', transform: 'none' }}
            role="status"
            aria-live="polite"
            aria-labelledby={welcomeTitleId}
          >
            <div className="village-info-panel-header">
              <span className="village-info-portal-icon" aria-hidden="true">
                🏘
              </span>
              <div>
                <h3 id={welcomeTitleId}>Welcome to the Dungeon Village</h3>
                <p className="village-info-meta">Your knowledge adventure begins here</p>
              </div>
            </div>
            <p className="village-info-desc">{welcomeMessage}</p>
            <div className="village-info-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="village-action-btn"
                onClick={onDismissWelcome}
                style={VILLAGE_TOUCH_TARGET_STYLE}
                data-village-touch-target="dismiss-welcome"
              >
                Begin your journey
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Re-exported so a caller does not have to reach into the fishing types module. */
export type { FishRarity };
