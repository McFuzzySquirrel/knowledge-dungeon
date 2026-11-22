/**
 * World-first village shell (variant B).
 *
 * Data and handlers come from VillageScreen. The shell owns only presentation:
 * the rail, quest card, primary verb pair, and one sheet at a time.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import type { VillageNearbyTarget } from '@/application/contracts/villageNpc';
import { PLAYER_CLASSES } from '@/game/systems/playerClasses';
import { QUEST_LABELS, QUEST_ORDER, type QuestStep } from '@/store/sessionStore';
import type { ColorTheme } from '@/store/preferencesStore';
import { STUDY_STATS_DISABLED_HUD_NOTE } from '@/ui/study/stats/studyStatsCopy';
import { useStudyStatsDashboardEnabled } from '@/ui/study/stats/studyStatsGate';
import { NearbyActionList, villageActionLabel } from '@/ui/village/NearbyActionList';
import type { VillageSubjectSummary } from '@/ui/village/villageTypes';

import {
  GameplayButton,
  GameplayChip,
  GameplayQuestCard,
  GameplayRail,
  GameplayRailButton,
  GameplaySheet,
} from './gameplayPrimitives';

type SheetKind = 'nearby' | 'quest' | 'archetype' | 'dungeons' | 'menu' | null;

const THEMES: readonly { readonly id: ColorTheme; readonly label: string }[] = Object.freeze([
  { id: 'dark', label: 'Night' },
  { id: 'colorful', label: 'Arcade' },
  { id: 'aurora', label: 'Aurora' },
]);

export interface VillageGameplayHudProps {
  readonly questStep: QuestStep;
  readonly subjects: readonly VillageSubjectSummary[];
  readonly selectedClass: string | null;
  readonly onSelectClass: (cls: string | null) => void;
  readonly nearbyTargets: readonly VillageNearbyTarget[];
  readonly nearbyListAvailable: boolean;
  readonly nearbyInvokeAvailable: boolean;
  readonly onInvokeNearby: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onQuestClick: (step: QuestStep) => void;
  readonly onCreateSubject: () => void;
  readonly onOpenData: () => void;
  readonly onStatsClick: () => void;
  readonly onSettingsClick: () => void;
  readonly colorTheme: ColorTheme;
  readonly onColorThemeChange: (theme: ColorTheme) => void;
  readonly onInteract: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
}

export function VillageGameplayHud({
  questStep,
  subjects,
  selectedClass,
  onSelectClass,
  nearbyTargets,
  nearbyListAvailable,
  nearbyInvokeAvailable,
  onInvokeNearby,
  onQuestClick,
  onCreateSubject,
  onOpenData,
  onStatsClick,
  onSettingsClick,
  colorTheme,
  onColorThemeChange,
  onInteract,
  onZoomIn,
  onZoomOut,
}: VillageGameplayHudProps): ReactNode {
  const [sheet, setSheet] = useState<SheetKind>(null);
  const statsEnabled = useStudyStatsDashboardEnabled();
  const selectedClassDef = PLAYER_CLASSES.find((cls) => cls.id === selectedClass);
  const quest = QUEST_LABELS[questStep];
  const nearbyLine =
    nearbyTargets.length > 0
      ? `Nearby: ${villageActionLabel(nearbyTargets[0])}`
      : 'Nothing is in reach right now.';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A real dialog owns Escape while it is open. The shell sheet is not modal,
      // and closing it here would unmount the Settings/Data launcher before the
      // dialog's own focus restoration runs.
      if (document.querySelector('[role="dialog"]') !== null) return;
      setSheet(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const closeSheet = (): void => setSheet(null);

  return (
    <div className="ui-skin gameplay-layer gameplay-layer--village" data-theme={colorTheme}>
      <div className="gameplay-root gameplay-root--village">
        <GameplayRail label="Village menu">
          <GameplayRailButton
            label="Nearby"
            glyph="📍"
            onClick={() => setSheet('nearby')}
          />
          <GameplayRailButton label="Quest" glyph="📜" onClick={() => setSheet('quest')} />
          <GameplayRailButton
            label="Class"
            ariaLabel="Archetype"
            glyph="🎓"
            onClick={() => setSheet('archetype')}
          />
          <GameplayRailButton
            label="Dungeons"
            glyph="🏰"
            onClick={() => setSheet('dungeons')}
          />
          <GameplayRailButton
            label="Menu"
            ariaLabel="Open village status and controls"
            glyph="⋯"
            onClick={() => setSheet('menu')}
          />
        </GameplayRail>

        <div className="gameplay-subject">
          <span className="gameplay-subject__name">Dungeon Village</span>
          <span className="gameplay-hint">
            {selectedClassDef?.name ?? 'Archetype not set'} · {subjects.length} dungeon
            {subjects.length === 1 ? '' : 's'}
          </span>
        </div>

        <GameplayQuestCard
          eyebrow={<GameplayChip accent>Quest</GameplayChip>}
          title={quest.label}
          body={quest.hint}
          meta={nearbyLine}
        />

        <div className="gameplay-verb">
          <GameplayButton
            label="Interact"
            ariaLabel="Interact (E or Space)"
            glyph="⚔"
            primary
            onClick={onInteract}
          />
          <GameplayButton label="Nearby" glyph="📍" onClick={() => setSheet('nearby')} />
        </div>

        {sheet === 'nearby' ? (
          <GameplaySheet title="Nearby" onClose={closeSheet}>
            <NearbyActionList
              targets={nearbyTargets}
              onInvoke={onInvokeNearby}
              invokeAvailable={nearbyInvokeAvailable}
              listAvailable={nearbyListAvailable}
              heading="In reach"
            />
          </GameplaySheet>
        ) : null}

        {sheet === 'quest' ? (
          <GameplaySheet title="Quest" onClose={closeSheet}>
            <div className="gameplay-room-list">
              {QUEST_ORDER.map((step) => {
                const currentIndex = QUEST_ORDER.indexOf(questStep);
                const index = QUEST_ORDER.indexOf(step);
                const done = index <= currentIndex;
                const current = step === questStep;
                return (
                  <button
                    key={step}
                    type="button"
                    className={`gameplay-quest-row${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                    onClick={() => {
                      onQuestClick(step);
                      closeSheet();
                    }}
                  >
                    <span>{QUEST_LABELS[step].label}</span>
                    <span className="gameplay-hint">{done ? 'done' : 'not yet'}</span>
                  </button>
                );
              })}
            </div>
          </GameplaySheet>
        ) : null}

        {sheet === 'archetype' ? (
          <GameplaySheet title="Study archetype" onClose={closeSheet}>
            <div className="gameplay-room-list">
              {PLAYER_CLASSES.map((cls) => (
                <button
                  key={cls.id}
                  type="button"
                  className={`gameplay-room-list__row${selectedClass === cls.id ? ' is-active' : ''}`}
                  aria-pressed={selectedClass === cls.id}
                  onClick={() => {
                    onSelectClass(cls.id);
                    closeSheet();
                  }}
                >
                  <strong>{cls.name}</strong>
                  <span className="gameplay-hint">{cls.tagline}</span>
                  {selectedClass === cls.id ? (
                    <span className="gameplay-hint">{cls.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </GameplaySheet>
        ) : null}

        {sheet === 'dungeons' ? (
          <GameplaySheet title="Dungeons" onClose={closeSheet}>
            <p className="gameplay-hint">
              Walk to a subject portal in the village and press Interact to enter.
            </p>
            {subjects.length === 0 ? (
              <p className="gameplay-hint">No dungeons yet. Create your first subject.</p>
            ) : (
              <div className="gameplay-room-list">
                {subjects.map((subject) => (
                  <div key={subject.id} className="gameplay-room-list__row">
                    <strong>{subject.subjectName}</strong>
                    <span className="gameplay-hint">
                      {subject.clearedRoomCount}/{subject.roomCount} rooms cleared
                    </span>
                  </div>
                ))}
              </div>
            )}
            <GameplayButton
              label="Create a subject"
              glyph="+"
              primary
              onClick={onCreateSubject}
            />
          </GameplaySheet>
        ) : null}

        {sheet === 'menu' ? (
          <GameplaySheet title="Menu" onClose={closeSheet}>
            <div className="gameplay-menu-grid">
              <GameplayButton
                label="Create subject"
                glyph="+"
                onClick={onCreateSubject}
              />
              <GameplayButton label="Data" glyph="🛡" onClick={onOpenData} />
              <GameplayButton
                label="Stats"
                glyph="📊"
                disabled={!statsEnabled}
                onClick={onStatsClick}
              />
              <GameplayButton label="Settings" glyph="⚙" onClick={onSettingsClick} />
              <GameplayButton label="Zoom in" glyph="＋" onClick={onZoomIn} />
              <GameplayButton label="Zoom out" glyph="－" onClick={onZoomOut} />
            </div>
            {statsEnabled ? null : <p className="gameplay-hint">{STUDY_STATS_DISABLED_HUD_NOTE}</p>}
            <div className="gameplay-sheet__divider" />
            <p className="gameplay-hint">Theme</p>
            <div className="gameplay-room-list">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`gameplay-room-list__row${colorTheme === theme.id ? ' is-active' : ''}`}
                  aria-pressed={colorTheme === theme.id}
                  onClick={() => onColorThemeChange(theme.id)}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </GameplaySheet>
        ) : null}
      </div>
    </div>
  );
}
