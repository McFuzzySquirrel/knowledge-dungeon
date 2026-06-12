import type { JSX } from 'react';

interface FloatingActionsProps {
  onOpenMap: () => void;
  onTeleport: () => void;
  onOpenInventory: () => void;
}

export function FloatingActions({ onOpenMap, onTeleport, onOpenInventory }: FloatingActionsProps): JSX.Element | null {
  return (
    <div className="floating-actions" aria-label="Quick actions">
      <button
        type="button"
        className="floating-action-btn"
        onClick={onOpenMap}
        aria-label="Open full map"
        title="Map"
      >
        <span className="floating-action-icon" aria-hidden="true">🗺️</span>
        <span className="floating-action-label">Map</span>
      </button>
      <button
        type="button"
        className="floating-action-btn"
        onClick={onTeleport}
        aria-label="Teleport"
        title="Teleport"
      >
        <span className="floating-action-icon" aria-hidden="true">⚡</span>
        <span className="floating-action-label">Warp</span>
      </button>
      <button
        type="button"
        className="floating-action-btn"
        onClick={onOpenInventory}
        aria-label="Inventory and badges"
        title="Inventory"
      >
        <span className="floating-action-icon" aria-hidden="true">🎒</span>
        <span className="floating-action-label">Items</span>
      </button>
    </div>
  );
}
