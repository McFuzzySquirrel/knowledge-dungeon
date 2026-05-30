import type { JSX } from 'react';
import type { GamePhase } from '@/store/sessionStore';

interface HudProps {
  subjectName: string;
  roomCount: number;
  xpTotal: number;
  rank: string;
  inventoryCount: number;
  badgeCount: number;
  phase: GamePhase;
  currentFloorLabel: string;
  teleportRemainingMs: number;
  teleportModeArmed: boolean;
  onPhaseChange: (phase: GamePhase) => void;
  onHelp: () => void;
  onOpenMap: () => void;
  onTeleport: () => void;
  onHome: () => void;
  onOpenInventory: () => void;
  onOpenBadges: () => void;
}

const PHASE_LABELS: Record<GamePhase, string> = {
  creator: 'Creator',
  scribe: 'Scribe',
  archaeologist: 'Archaeologist',
};

export function Hud({
  subjectName,
  roomCount,
  xpTotal,
  rank,
  inventoryCount,
  badgeCount,
  phase,
  currentFloorLabel,
  teleportRemainingMs,
  teleportModeArmed,
  onPhaseChange,
  onHelp,
  onOpenMap,
  onTeleport,
  onHome,
  onOpenInventory,
  onOpenBadges,
}: HudProps): JSX.Element {
  const teleportSeconds = Math.ceil(teleportRemainingMs / 1000);
  const teleportLabel =
    teleportRemainingMs > 0
      ? `Teleport ${Math.floor(teleportSeconds / 60)}:${String(teleportSeconds % 60).padStart(2, '0')}`
      : teleportModeArmed
        ? 'Choose teleport'
        : 'Teleport';

  return (
    <div className="hud-rail" role="banner">
      <div style={{ display: 'flex', gap: 18 }}>
        <div className="hud-stat">
          <span>Subject</span>
          <strong>{subjectName}</strong>
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
          <span>Phase</span>
          <strong>{PHASE_LABELS[phase]}</strong>
        </div>
        <div className="hud-stat">
          <span>Floor</span>
          <strong>{currentFloorLabel}</strong>
        </div>
      </div>
      <div className="hud-actions">
        {(Object.keys(PHASE_LABELS) as GamePhase[]).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={p === phase}
            onClick={() => onPhaseChange(p)}
          >
            {PHASE_LABELS[p]}
          </button>
        ))}
        <button
          type="button"
          className="hud-icon-button"
          onClick={onOpenInventory}
          aria-label={`Open inventory (${inventoryCount} item${inventoryCount === 1 ? '' : 's'})`}
        >
          <span className="hud-icon-glyph" aria-hidden="true">
            🎒
          </span>
          <span className="hud-icon-count">{inventoryCount}</span>
        </button>
        <button
          type="button"
          className="hud-icon-button"
          onClick={onOpenBadges}
          aria-label={`Open badges (${badgeCount} earned)`}
        >
          <span className="hud-icon-glyph" aria-hidden="true">
            🏅
          </span>
          <span className="hud-icon-count">{badgeCount}</span>
        </button>
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
        <button type="button" onClick={onHelp} aria-label="Open help">
          ?
        </button>
      </div>
    </div>
  );
}
