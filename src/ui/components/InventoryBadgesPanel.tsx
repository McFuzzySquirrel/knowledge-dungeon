import type { JSX } from 'react';
import {
  SCRIBE_CENTURY_120_BADGE_ID,
  SCRIBE_CENTURY_120_BADGE_LABEL,
} from '@/core/progression';
import type { CollectedNoteEntry, LootItem } from '@/store/progressionStore';

interface InventoryBadgesPanelProps {
  view: 'inventory' | 'badges' | 'journal';
  inventory: readonly LootItem[];
  badges: readonly string[];
  collectedNotes: readonly CollectedNoteEntry[];
  xpTotal: number;
  rank: string;
  onSwitchView: (view: 'inventory' | 'badges' | 'journal') => void;
  onClose: () => void;
}

const RARITY_COLOR: Record<LootItem['rarity'], string> = {
  common: 'var(--text-secondary)',
  rare: 'var(--accent-cool)',
  epic: 'var(--accent)',
};

const BADGE_LABELS: Record<string, string> = {
  [SCRIBE_CENTURY_120_BADGE_ID]: SCRIBE_CENTURY_120_BADGE_LABEL,
};

const BADGE_DESCRIPTIONS: Record<string, string> = {
  CreatorPhaseComplete: 'Mapped 90%+ of rooms in the creator phase.',
  ScribePhaseComplete: 'Cleared every room by completing scribe encounters.',
  ArchaeologistPhaseComplete: 'Completed at least two full archaeology review passes.',
  [SCRIBE_CENTURY_120_BADGE_ID]:
    'Awarded for writing a note with at least 120 words in a valid encounter.',
};

const RARITY_HINT: Record<LootItem['rarity'], string> = {
  common: 'Utility: baseline study support item.',
  rare: 'Utility: stronger navigation or recall support.',
  epic: 'Utility: highest-tier synthesis support item.',
};

function badgeLabel(badgeId: string): string {
  return BADGE_LABELS[badgeId] ?? badgeId;
}

function badgeDescription(badgeId: string): string {
  return BADGE_DESCRIPTIONS[badgeId] ?? 'Milestone badge earned during your dungeon journey.';
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Modal that surfaces collected loot and earned milestone badges. Mirrors
 * repo-dungeon's inventory/badge panels at a UI/icon level so players have
 * a clear "what have I earned" view without leaving the dungeon.
 */
export function InventoryBadgesPanel({
  view,
  inventory,
  badges,
  collectedNotes,
  xpTotal,
  rank,
  onSwitchView,
  onClose,
}: InventoryBadgesPanelProps): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal inventory-badges-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={view === 'inventory' ? 'Inventory' : view === 'badges' ? 'Badges' : 'Collected notes'}
      >
        <div className="inventory-badges-header">
          <div className="inventory-badges-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'inventory'}
              onClick={() => onSwitchView('inventory')}
            >
              <span className="ib-icon" aria-hidden="true">
                🎒
              </span>{' '}
              Inventory ({inventory.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'badges'}
              onClick={() => onSwitchView('badges')}
            >
              <span className="ib-icon" aria-hidden="true">
                🏅
              </span>{' '}
              Badges ({badges.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'journal'}
              onClick={() => onSwitchView('journal')}
            >
              <span className="ib-icon" aria-hidden="true">
                📚
              </span>{' '}
              Collected Notes ({collectedNotes.length})
            </button>
          </div>
          <div className="inventory-badges-rank">
            <span>{xpTotal} XP</span>
            <strong>{rank}</strong>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>

        {view === 'inventory' ? (
          inventory.length === 0 ? (
            <p className="room-help-text">
              No loot yet. Defeat encounters during the Scribe phase to earn artifacts.
            </p>
          ) : (
            <ul className="inventory-grid">
              {inventory.map((item) => (
                <li
                  key={item.id}
                  className="inventory-card"
                  style={{ borderColor: RARITY_COLOR[item.rarity] }}
                >
                  <div className="inventory-card-icon" aria-hidden="true">
                    📜
                  </div>
                  <div>
                    <div className="inventory-card-title">{item.name}</div>
                    <div className="inventory-card-rarity" style={{ color: RARITY_COLOR[item.rarity] }}>
                      {item.rarity}
                    </div>
                    <p className="inventory-card-desc">{item.description}</p>
                    <p className="inventory-card-desc">{RARITY_HINT[item.rarity]}</p>
                    <p className="room-help-text">Acquired: {formatTimestamp(item.acquiredAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : view === 'badges' ? (
          badges.length === 0 ? (
          <p className="room-help-text">
            No badges yet. Reach milestones (rooms cleared, ranks gained) to earn badges.
          </p>
        ) : (
          <ul className="badge-grid">
            {badges.map((badge) => (
              <li key={badge} className="badge-card">
                <span className="badge-icon" aria-hidden="true">
                  🏅
                </span>
                <div>
                  <div className="badge-label">{badgeLabel(badge)}</div>
                  <p className="room-help-text">{badgeDescription(badge)}</p>
                </div>
              </li>
            ))}
          </ul>
        )
        ) : collectedNotes.length === 0 ? (
          <p className="room-help-text">
            No collected notes yet. In archaeologist phase, walk over artifact loot to add entries.
          </p>
        ) : (
          <ul className="inventory-grid">
            {collectedNotes.map((entry) => (
              <li key={entry.noteId} className="inventory-card">
                <div className="inventory-card-icon" aria-hidden="true">
                  📓
                </div>
                <div>
                  <div className="inventory-card-title">{entry.topic}</div>
                  <div className="inventory-card-rarity">{entry.floorLabel}</div>
                  <p className="inventory-card-desc">{entry.artifactPreview || 'Artifact note collected.'}</p>
                  <p className="room-help-text">Collected: {formatTimestamp(entry.collectedAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
