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
import type { ColorTheme } from '@/store/preferencesStore';

import { VILLAGE_TOUCH_TARGET_STYLE } from './villageTypes';

export interface VillageFishCatch {
  readonly fishName: string;
  readonly rarity: string;
  readonly catalogId: string;
  readonly description: string;
}

export interface VillageLaunchersProps {
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
  /** The recall question for the current catch, or `null`. */
  readonly recallQuestion: { prompt: SelfCheckPrompt; roomId: string } | null;
  readonly onSelfEvaluate: (result: 'correct' | 'incorrect') => void;
  readonly onCancelRecall: () => void;
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
    recallQuestion,
    onSelfEvaluate,
    onCancelRecall,
    welcomeMessage,
    onDismissWelcome,
  } = props;
  const catchTitleId = useId();
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

      {fishCatch !== null ? (
        <div
          className="modal-backdrop"
          style={{ zIndex: 350, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {/*
            The whole card is the live region rather than a sentence inside it, so
            the fish's name, its rarity, and its description are announced as one
            unit. The rarity is stated as a word as well as carried by the badge's
            colour, which is plan 10.1's no-colour-only rule.
          */}
          <div
            className="village-info-panel ui-skin screen-slide-up"
            data-theme={colorTheme}
            style={{ maxWidth: 420, width: '90%' }}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-labelledby={catchTitleId}
          >
            <div className="village-info-panel-header">
              <span className="village-info-portal-icon" aria-hidden="true">
                🎣
              </span>
              <div>
                <h3 id={catchTitleId}>{fishCatch.fishName}</h3>
                <p className="village-info-meta">
                  {fishCatch.rarity.charAt(0).toUpperCase() + fishCatch.rarity.slice(1)} fish.
                  Caught.
                </p>
              </div>
              <span className="fish-rarity-badge" data-rarity={fishCatch.rarity}>
                {fishCatch.rarity.toUpperCase()}
              </span>
            </div>
            <p className="village-info-desc">{fishCatch.description}</p>
            <div className="village-info-actions">
              <button
                type="button"
                className="village-enter-btn"
                onClick={onKeepFish}
                style={VILLAGE_TOUCH_TARGET_STYLE}
                data-village-touch-target="keep-fish"
              >
                Keep Fish
              </button>
              <button
                type="button"
                className="village-action-btn"
                onClick={onReleaseFish}
                style={VILLAGE_TOUCH_TARGET_STYLE}
                data-village-touch-target="release-fish"
              >
                Release
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {fishCatch !== null && recallQuestion !== null ? (
        <FishingRecallModal
          fishName={fishCatch.fishName}
          rarity={fishCatch.rarity as 'common' | 'rare' | 'epic'}
          catalogId={fishCatch.catalogId}
          description={fishCatch.description}
          recallQuestion={recallQuestion}
          onSelfEvaluate={onSelfEvaluate}
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
