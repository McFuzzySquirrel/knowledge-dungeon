import { type JSX } from 'react';
import type { GamePhase } from '@/store/sessionStore';
import { Tooltip } from '@/ui/components/Tooltip';

interface HudProps {
  subjectName: string;
  roomCount: number;
  xpTotal: number;
  rank: string;
  reviewPassesCompleted: number;
  reviewRoomsTowardNextPass: number;
  reviewNextPassTarget: number;
  reviewTotalRooms: number;
  phase: GamePhase;
  currentFloorLabel: string;
  teleportRemainingMs: number;
  teleportModeArmed: boolean;
  phaseChangeNeedsConfirmation: boolean;
  showScribeNudge: boolean;
  infoOpen: boolean;
  focusedRoomTopic: string | null;
  inventoryCount: number;
  badgeCount: number;
  journalCount: number;
  onPhaseChange: (phase: GamePhase) => void;
  onHelp: () => void;
  onOpenSettings: () => void;
  onOpenMap: () => void;
  onTeleport: () => void;
  onHome: () => void;
  onToggleInfo: () => void;
  onOpenInventory: () => void;
  onOpenBadges: () => void;
  onOpenJournal: () => void;
}

const PHASE_LABELS: Record<GamePhase, string> = {
  creator: 'Creator',
  scribe: 'Scribe',
  archaeologist: 'Archaeologist',
};

const MAX_TOPIC_DISPLAY_LENGTH = 18;

export function Hud({
  subjectName,
  roomCount,
  xpTotal,
  rank,
  reviewPassesCompleted,
  reviewRoomsTowardNextPass,
  reviewNextPassTarget,
  reviewTotalRooms,
  phase,
  currentFloorLabel,
  teleportRemainingMs,
  teleportModeArmed,
  phaseChangeNeedsConfirmation,
  onPhaseChange,
  onHelp,
  onOpenSettings,
  onOpenMap,
  onTeleport,
  onHome,
  showScribeNudge,
  infoOpen,
  focusedRoomTopic,
  onToggleInfo,
  inventoryCount,
  badgeCount,
  journalCount,
  onOpenInventory,
  onOpenBadges,
  onOpenJournal,
}: HudProps): JSX.Element {
  const teleportSeconds = Math.ceil(teleportRemainingMs / 1000);
  const reviewProgressPercent =
    reviewTotalRooms > 0
      ? Math.min(100, Math.round((reviewRoomsTowardNextPass / reviewTotalRooms) * 100))
      : 0;
  const teleportCountdownLabel =
    teleportRemainingMs > 0
      ? `${Math.floor(teleportSeconds / 60)}:${String(teleportSeconds % 60).padStart(2, '0')}`
      : null;

  function requestPhaseChange(nextPhase: GamePhase): void {
    if (nextPhase === phase) return;
    if (phaseChangeNeedsConfirmation) {
      const ok = window.confirm(
        'Switch phase now? Active overlays may interrupt your current flow.',
      );
      if (!ok) return;
    }
    onPhaseChange(nextPhase);
  }

  return (
    <div className="hud-rail" role="banner">
      <div className="hud-subject-label" title={subjectName}>
        {subjectName}
      </div>

      <div className="hud-stat">
        <span>Rooms</span>
        <strong>{roomCount}</strong>
      </div>
      <div className="hud-stat">
        <span>XP / Rank</span>
        <strong>
          <span className="hud-rank-badge">{rank}</span> · {xpTotal} XP
        </strong>
      </div>
      <div className="hud-stat">
        <span>Review Passes</span>
        <strong>{reviewPassesCompleted}</strong>
        <span className="hud-stat-subtle">
          {reviewRoomsTowardNextPass}/{reviewTotalRooms} toward pass {reviewNextPassTarget}
        </span>
        <div className="rpg-stat-bar" role="progressbar"
          aria-label="Review progress toward next pass"
          aria-valuemin={0}
          aria-valuemax={reviewTotalRooms}
          aria-valuenow={Math.min(reviewRoomsTowardNextPass, reviewTotalRooms)}>
          <span className="rpg-stat-bar-fill"
            style={{ width: `${reviewProgressPercent}%` }} />
        </div>
      </div>
      <div className="hud-stat">
        <span>Phase</span>
        <strong>{PHASE_LABELS[phase]}</strong>
      </div>
      <div className="hud-stat">
        <span>Floor</span>
        <strong>{currentFloorLabel}</strong>
      </div>

      <div className="hud-collections" aria-label="Collections">
        <button
          type="button"
          className="hud-collection-btn"
          onClick={onOpenInventory}
          aria-label={`Open inventory (${inventoryCount} items)`}
          title="Inventory"
        >
          <span className="hud-collection-icon" aria-hidden="true">🎒</span>
          <span className="hud-collection-count">{inventoryCount}</span>
        </button>
        <button
          type="button"
          className="hud-collection-btn"
          onClick={onOpenBadges}
          aria-label={`Open badges (${badgeCount} earned)`}
          title="Badges"
        >
          <span className="hud-collection-icon" aria-hidden="true">🏅</span>
          <span className="hud-collection-count">{badgeCount}</span>
        </button>
        <button
          type="button"
          className="hud-collection-btn"
          onClick={onOpenJournal}
          aria-label={`Open diary (${journalCount} notes)`}
          title="Diary"
        >
          <span className="hud-collection-icon" aria-hidden="true">📚</span>
          <span className="hud-collection-count">{journalCount}</span>
        </button>
      </div>

      <div className="hud-spacer" />

      <div className="hud-actions">
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="hud-info-button"
            aria-pressed={infoOpen}
            onClick={onToggleInfo}
            aria-label={infoOpen ? 'Close room info panel' : 'Open room info panel'}
            title="Press I to toggle room info"
          >
            {infoOpen ? 'Info ✕' : focusedRoomTopic ? `Info: ${focusedRoomTopic.slice(0, MAX_TOPIC_DISPLAY_LENGTH)}…` : 'Info (I)'}
          </button>
          <Tooltip id="hud-info">
            View room details - notes, images, artifact summaries, and self-check prompts.
          </Tooltip>
        </div>

        <div className="hud-phase-controls" aria-label="Phase controls">
          <span className="hud-phase-controls-label">Switch Phase</span>
          {(Object.keys(PHASE_LABELS) as GamePhase[]).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === phase}
              onClick={() => requestPhaseChange(p)}
            >
              {PHASE_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="hud-action-row">
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="hud-action-icon-btn"
              onClick={onOpenMap}
              aria-label="Open full map"
              title="Map (M)"
            >
              <span aria-hidden="true">🗺️</span>
              <span className="hud-action-icon-label">Map</span>
            </button>
            <Tooltip id="hud-map">
              Open the dungeon map to see all rooms. Drag rooms to rearrange, or click a room to teleport.
            </Tooltip>
          </div>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="hud-action-icon-btn"
              onClick={onTeleport}
              disabled={teleportRemainingMs > 0}
              aria-pressed={teleportModeArmed}
              aria-label={
                teleportModeArmed
                  ? 'Cancel teleport mode'
                  : teleportRemainingMs > 0
                    ? `Teleport on cooldown (${teleportCountdownLabel})`
                    : 'Teleport'
              }
              title="Teleport"
            >
              <span aria-hidden="true">⚡</span>
              <span className="hud-action-icon-label">
                {teleportCountdownLabel ?? (teleportModeArmed ? 'Pick' : 'Warp')}
              </span>
            </button>
            <Tooltip id="hud-teleport">
              Instantly travel to any room. Opens the map to pick a destination. Has a 2-minute cooldown.
            </Tooltip>
          </div>
          <button
            type="button"
            className="hud-action-icon-btn"
            onClick={onHome}
            aria-label="Return to subject selection"
            title="Home"
          >
            <span aria-hidden="true">🏠</span>
            <span className="hud-action-icon-label">Home</span>
          </button>
          <button
            type="button"
            className="hud-action-icon-btn"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
          >
            <span aria-hidden="true">⚙️</span>
            <span className="hud-action-icon-label">Settings</span>
          </button>
          <button
            type="button"
            className="hud-action-icon-btn hud-help-button"
            onClick={onHelp}
            aria-label="Open help"
            title="Help (?)"
          >
            <span aria-hidden="true">❓</span>
            <span className="hud-action-icon-label">Help</span>
          </button>
        </div>

        {showScribeNudge ? (
          <div className="hud-scribe-nudge" role="status" aria-live="polite">
            <span>Your map has enough rooms to start Scribe encounters.</span>
            <button type="button" onClick={() => requestPhaseChange('scribe')}>
              Switch to Scribe
            </button>
          </div>
        ) : null}
      </div>
      {teleportModeArmed ? (
        <p className="hud-inline-hint" role="status" aria-live="polite">
          Teleport Mode armed: open map, pick a destination room, then confirm teleport.
        </p>
      ) : null}
    </div>
  );
}
