import type { JSX } from 'react';
import type { LootItem } from '@/store/progressionStore';

interface InventoryBadgesPanelProps {
  view: 'inventory' | 'badges';
  inventory: readonly LootItem[];
  badges: readonly string[];
  xpTotal: number;
  rank: string;
  onSwitchView: (view: 'inventory' | 'badges') => void;
  onClose: () => void;
}

const RARITY_COLOR: Record<LootItem['rarity'], string> = {
  common: 'var(--text-secondary)',
  rare: 'var(--accent-cool)',
  epic: 'var(--accent)',
};

/**
 * Modal that surfaces collected loot and earned milestone badges. Mirrors
 * repo-dungeon's inventory/badge panels at a UI/icon level so players have
 * a clear "what have I earned" view without leaving the dungeon.
 */
export function InventoryBadgesPanel({
  view,
  inventory,
  badges,
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
        aria-label={view === 'inventory' ? 'Inventory' : 'Badges'}
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
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : badges.length === 0 ? (
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
                <span className="badge-label">{badge}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
