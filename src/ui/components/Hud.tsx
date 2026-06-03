import type { JSX } from 'react';
import type { GamePhase } from '@/store/sessionStore';

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
  onPhaseChange: (phase: GamePhase) => void;
  onHelp: () => void;
  onOpenSettings: () => void;
  onOpenMap: () => void;
  onTeleport: () => void;
  onHome: () => void;
  onToggleInfo: () => void;
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
}: HudProps): JSX.Element {
  const teleportSeconds = Math.ceil(teleportRemainingMs / 1000);
  const reviewProgressPercent =
    reviewTotalRooms > 0
      ? Math.min(100, Math.round((reviewRoomsTowardNextPass / reviewTotalRooms) * 100))
      : 0;
  const teleportLabel =
    teleportRemainingMs > 0
      ? `Teleport ${Math.floor(teleportSeconds / 60)}:${String(teleportSeconds % 60).padStart(2, '0')}`
      : teleportModeArmed
        ? 'Choose teleport'
        : 'Teleport';

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
          {xpTotal} · {rank}
        </strong>
      </div>
      <div className="hud-stat">
        <span>Review Passes</span>
        <strong>{reviewPassesCompleted}</strong>
        <span className="hud-stat-subtle">
          {reviewRoomsTowardNextPass}/{reviewTotalRooms} toward pass {reviewNextPassTarget}
        </span>
        <div
          className="review-progress-bar"
          role="progressbar"
          aria-label="Review progress toward next pass"
          aria-valuemin={0}
          aria-valuemax={reviewTotalRooms}
          aria-valuenow={Math.min(reviewRoomsTowardNextPass, reviewTotalRooms)}
        >
          <span
            className="review-progress-bar-fill"
            style={{ width: `${reviewProgressPercent}%` }}
          />
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

      <div className="hud-spacer" />

      <div className="hud-actions">
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
        <button type="button" onClick={onOpenMap} aria-label="Open full map">
          Map
        </button>
        <button
          type="button"
          onClick={onTeleport}
          disabled={teleportRemainingMs > 0}
          aria-pressed={teleportModeArmed}
        >
          {teleportLabel}
        </button>
        <button type="button" onClick={onHome} aria-label="Return to subject selection">
          Home
        </button>
        <button type="button" onClick={onOpenSettings} aria-label="Open settings">
          Settings
        </button>
        {showScribeNudge ? (
          <div className="hud-scribe-nudge" role="status" aria-live="polite">
            <span>Your map has enough rooms to start Scribe encounters.</span>
            <button type="button" onClick={() => requestPhaseChange('scribe')}>
              Switch to Scribe
            </button>
          </div>
        ) : null}
        <button type="button" onClick={onHelp} aria-label="Open help" className="hud-help-button">
          Help (?)
        </button>
      </div>
      {teleportModeArmed ? (
        <p className="hud-inline-hint" role="status" aria-live="polite">
          Teleport Mode armed: open map, pick a destination room, then confirm teleport.
        </p>
      ) : null}
    </div>
  );
}
