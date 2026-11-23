/**
 * World-first dungeon shell (variant B).
 *
 * Presentation only: the data comes from the stores, the actions dispatch the
 * existing DOM controls (the renderer's mirror and the hidden HUD command layer),
 * and every control here is a real, labelled, keyboard-operable button.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { usePreferencesStore } from '@/store/preferencesStore';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';

import {
  GameplayButton,
  GameplayChip,
  GameplayQuestCard,
  GameplayRail,
  GameplaySheet,
} from './gameplayPrimitives';

type SheetKind = 'controls' | 'rooms' | 'menu' | null;

interface ProbeAction {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly status: string;
}

interface ProbeRoom {
  readonly label: string;
  readonly topic: string;
  readonly disabled: boolean;
}

interface Probe {
  readonly actions: readonly ProbeAction[];
  readonly rooms: readonly ProbeRoom[];
  readonly artifactLabel: string;
  readonly artifactStatus: string;
  readonly artifactDisabled: boolean;
}

const EMPTY_PROBE: Probe = Object.freeze({
  actions: [],
  rooms: [],
  artifactLabel: 'Collect artifact',
  artifactStatus: '',
  artifactDisabled: true,
});

function query<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function clickAction(id: string): void {
  const button = query<HTMLButtonElement>(`[data-action-id="${id}"]`);
  if (button !== null && !button.disabled) button.click();
}

function clickArtifact(): void {
  const button = query<HTMLButtonElement>('[data-dungeon-artifact-action="collect"]');
  if (button !== null && !button.disabled) button.click();
}

function clickLabel(label: string): void {
  const button = query<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (button !== null && !button.disabled) button.click();
}

function clickLabelPrefix(prefix: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? '').startsWith(prefix),
  );
  if (button !== undefined && !button.disabled) button.click();
}

function toggleRoomPanel(): void {
  const button = query<HTMLButtonElement>(
    'button[aria-label="Open room info panel"], button[aria-label="Close room info panel"]',
  );
  if (button !== null && !button.disabled) button.click();
}

function travelToRoom(label: string): void {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.pixi-dungeon-world [aria-label="Room navigation"] button',
    ),
  ].find((candidate) => candidate.getAttribute('aria-label') === label);
  if (button !== undefined && !button.disabled) button.click();
}

function readProbe(): Probe {
  const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-action-id]')].map(
    (button): ProbeAction => {
      const id = button.dataset.actionId ?? '';
      return {
        id,
        label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? id,
        disabled: button.disabled,
        status:
          query<HTMLElement>(`[data-action-status="${id}"]`)?.textContent?.trim() ?? '',
      };
    },
  );
  const rooms = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.pixi-dungeon-world [aria-label="Room navigation"] button',
    ),
  ].map((button): ProbeRoom => {
    const label = button.getAttribute('aria-label') ?? '';
    return {
      label,
      topic: button.textContent?.trim() ?? label.replace(/^Go to /, ''),
      disabled: button.disabled,
    };
  });
  const artifact = query<HTMLButtonElement>('[data-dungeon-artifact-action="collect"]');
  return {
    actions,
    rooms,
    artifactLabel: artifact?.getAttribute('aria-label') ?? 'Collect artifact',
    artifactStatus:
      query<HTMLElement>('[data-dungeon-artifact-status="collect"]')?.textContent?.trim() ?? '',
    artifactDisabled: artifact?.disabled ?? true,
  };
}

function useProbe(): Probe {
  const [probe, setProbe] = useState<Probe>(EMPTY_PROBE);
  useEffect(() => {
    const read = (): void => setProbe(readProbe());
    read();
    const timer = window.setInterval(read, 600);
    return () => window.clearInterval(timer);
  }, []);
  return probe;
}

export function DungeonGameplayHud({
  onFitFloor,
}: {
  readonly onFitFloor: () => void;
}): ReactNode {
  const [sheet, setSheet] = useState<SheetKind>(null);
  const snapshot = useSubjectStore((state) => state.snapshot);
  const focusedRoomId = useSessionStore((state) => state.focusedRoomId);
  const phase = useSessionStore((state) => state.phase);
  const xpTotal = useProgressionStore((state) => state.xpTotal);
  const rank = useProgressionStore((state) => state.rank);
  const inventory = useProgressionStore((state) => state.inventory);
  const badges = useProgressionStore((state) => state.badges);
  const collectedNotes = useProgressionStore((state) => state.collectedNotes);
  const colorTheme = usePreferencesStore((state) => state.colorTheme);
  const probe = useProbe();

  const room =
    focusedRoomId !== null && snapshot !== null ? (snapshot.rooms[focusedRoomId] ?? null) : null;
  const totalRooms = snapshot?.dungeon.rooms.length ?? 0;
  const clearedRooms =
    snapshot === null
      ? 0
      : Object.values(snapshot.rooms).filter((entry) => entry.validationState.finalPass).length;
  const isTutorial = snapshot?.dungeon.subjectName.includes('Tutorial') ?? false;
  const prompt =
    probe.actions.find((action) => action.id === 'dungeon-interact')?.status ?? '';

  const closeSheet = useMemo(() => () => setSheet(null), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      setSheet(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const objective = room?.validationState.finalPass
    ? 'Room cleared. Move on or review the artifact.'
    : room !== null && room.validationState.wordCount > 0
      ? `${room.validationState.wordCount} words drafted. Keep going.`
      : 'Write this room up, then confirm the note to defeat the encounter.';


  return (
    <div className="ui-skin gameplay-layer gameplay-layer--dungeon" data-theme={colorTheme}>
      <div className="gameplay-root gameplay-root--dungeon">
        <GameplayRail label="Dungeon menu">
          <GameplayButton
            label="Map"
            ariaLabel="Open full map"
            glyph="▦"
            iconOnly
            onClick={() => clickLabel('Open full map')}
          />
          <GameplayButton
            label="Rooms"
            glyph="≡"
            iconOnly
            onClick={() => setSheet('rooms')}
          />
          <GameplayButton
            label="This room"
            ariaLabel="Open room info panel"
            glyph="⌂"
            iconOnly
            onClick={toggleRoomPanel}
          />
          <GameplayButton
            label="Inventory"
            ariaLabel="Open inventory"
            glyph="🎒"
            iconOnly
            onClick={() => clickLabelPrefix('Open inventory')}
          />
          <GameplayButton
            label="Journal"
            ariaLabel="Open diary"
            glyph="📖"
            iconOnly
            onClick={() => clickLabelPrefix('Open diary')}
          />
          <GameplayButton
            label="Menu"
            glyph="⋯"
            iconOnly
            onClick={() => setSheet('menu')}
          />
          <GameplayButton
            label="Village"
            ariaLabel="Return to subject selection"
            glyph="🏘"
            iconOnly
            onClick={() => clickLabel('Return to subject selection')}
          />
        </GameplayRail>

        <div className="gameplay-subject">
          <span className="gameplay-subject__name">{snapshot?.dungeon.subjectName ?? 'Dungeon'}</span>
          <span className="gameplay-hint">
            {room?.topic ?? 'No room'} · {phase} · {rank} · {xpTotal} XP
          </span>
        </div>

        <GameplayQuestCard
          eyebrow={
            isTutorial ? (
              <span className="gameplay-chip gameplay-chip--accent">
                Tutorial {clearedRooms}/{totalRooms}
              </span>
            ) : (
              <GameplayChip accent>{phase}</GameplayChip>
            )
          }
          title={room?.topic ?? 'Dungeon'}
          body={objective}
          meta={prompt}
        />

        <p className="gameplay-verb__prompt" role="status">
          {prompt}
        </p>

        <div className="gameplay-verb">
          <GameplayButton
            label="Interact"
            ariaLabel="Interact (E or Space)"
            glyph="⚔"
            primary
            onClick={() => clickAction('dungeon-interact')}
          />
          <GameplayButton
            label="Actions"
            glyph="✣"
            onClick={() => setSheet('controls')}
          />
        </div>

        {sheet === 'controls' ? (
          <GameplaySheet title="Controls and status" onClose={closeSheet}>
            <div className="gameplay-action-list">
              {probe.actions.map((action) => (
                <div key={action.id} className="gameplay-action">
                  <GameplayButton
                    label={action.label}
                    onClick={() => clickAction(action.id)}
                    disabled={action.disabled}
                  />
                  <p className="gameplay-action__status" data-action-status={action.id}>
                    {action.status}
                  </p>
                </div>
              ))}
              <div className="gameplay-action">
                <GameplayButton
                  label={probe.artifactLabel}
                  glyph="◆"
                  onClick={clickArtifact}
                  disabled={probe.artifactDisabled}
                />
                <p className="gameplay-action__status" data-dungeon-artifact-status="collect">
                  {probe.artifactStatus}
                </p>
              </div>
            </div>
            <div className="gameplay-sheet__divider" />
            <GameplayButton label="Fit floor" glyph="⤢" onClick={onFitFloor} />
            <div className="gameplay-phase">
              {(['creator', 'scribe', 'archaeologist'] as const).map((nextPhase) => (
                <button
                  key={nextPhase}
                  type="button"
                  className={`gameplay-phase__btn${phase === nextPhase ? ' is-active' : ''}`}
                  aria-pressed={phase === nextPhase}
                  onClick={() => useSessionStore.getState().setPhase(nextPhase)}
                >
                  {nextPhase === 'creator'
                    ? 'Creator'
                    : nextPhase === 'scribe'
                      ? 'Scribe'
                      : 'Archaeologist'}
                </button>
              ))}
            </div>
          </GameplaySheet>
        ) : null}

        {sheet === 'rooms' ? (
          <GameplaySheet title="Rooms on this floor" onClose={closeSheet}>
            {probe.rooms.length === 0 ? (
              <p className="gameplay-hint">No rooms are visible on this floor.</p>
            ) : (
              <div className="gameplay-room-list" role="group" aria-label="Room navigation">
                {probe.rooms.map((roomRow) => (
                  <button
                    key={roomRow.label}
                    type="button"
                    className="gameplay-room-list__row"
                    aria-label={`Go to ${roomRow.topic}`}
                    disabled={roomRow.disabled}
                    onClick={() => {
                      travelToRoom(roomRow.label);
                      setSheet(null);
                    }}
                  >
                    {roomRow.topic}
                  </button>
                ))}
              </div>
            )}
          </GameplaySheet>
        ) : null}

        {sheet === 'menu' ? (
          <GameplaySheet title="Menu" onClose={closeSheet}>
            <div className="gameplay-menu-grid">
              <GameplayButton
                label="Map"
                ariaLabel="Open full map"
                glyph="▦"
                onClick={() => {
                  clickLabel('Open full map');
                  setSheet(null);
                }}
              />
              <GameplayButton
                label="Inventory"
                ariaLabel="Open inventory"
                glyph="🎒"
                onClick={() => {
                  clickLabelPrefix('Open inventory');
                  setSheet(null);
                }}
              />
              <GameplayButton
                label="Badges"
                ariaLabel="Open badges"
                glyph="🏅"
                onClick={() => {
                  clickLabelPrefix('Open badges');
                  setSheet(null);
                }}
              />
              <GameplayButton
                label="Journal"
                ariaLabel="Open diary"
                glyph="📖"
                onClick={() => {
                  clickLabelPrefix('Open diary');
                  setSheet(null);
                }}
              />
              <GameplayButton
                label="Help"
                ariaLabel="Open help"
                glyph="?"
                onClick={() => {
                  clickLabel('Open help');
                  setSheet(null);
                }}
              />
              <GameplayButton
                label="Settings"
                ariaLabel="Open settings"
                glyph="⚙"
                onClick={() => {
                  clickLabel('Open settings');
                  setSheet(null);
                }}
              />
              <GameplayButton
                label="Village"
                ariaLabel="Return to subject selection"
                glyph="🏘"
                onClick={() => {
                  clickLabel('Return to subject selection');
                  setSheet(null);
                }}
              />
            </div>
            <p className="gameplay-hint">
              {inventory.length} item{inventory.length === 1 ? '' : 's'} · {badges.length} badge
              {badges.length === 1 ? '' : 's'} · {collectedNotes.length} journal note
              {collectedNotes.length === 1 ? '' : 's'}
            </p>
          </GameplaySheet>
        ) : null}
      </div>
    </div>
  );
}
