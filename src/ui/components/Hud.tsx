import type { JSX } from 'react';
import type { GamePhase } from '@/store/sessionStore';

interface HudProps {
  subjectName: string;
  roomCount: number;
  xpTotal: number;
  rank: string;
  phase: GamePhase;
  onPhaseChange: (phase: GamePhase) => void;
  onHelp: () => void;
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
  phase,
  onPhaseChange,
  onHelp,
}: HudProps): JSX.Element {
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
        <button type="button" onClick={onHelp} aria-label="Open help">
          ?
        </button>
      </div>
    </div>
  );
}
