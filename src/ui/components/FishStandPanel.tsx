import { useEffect, useMemo, useState, type JSX } from 'react';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { FISH_CATALOG } from '@/game/systems/fishingTypes';
import type { FishEntry } from '@/game/systems/fishingTypes';
import { listSubjectIds } from '@/services/persistence/subjectPersistence';

interface FishStandPanelProps {
  onClose: () => void;
}

export function FishStandPanel({ onClose }: FishStandPanelProps): JSX.Element {
  const colorTheme = usePreferencesStore((s) => s.colorTheme);
  const bySubject = useProgressionStore((s) => s.bySubject);

  const [existingSubjectIds, setExistingSubjectIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void listSubjectIds().then((ids) => setExistingSubjectIds(new Set(ids)));
  }, []);

  const allFish: (FishEntry & { isSubjectDeleted: boolean })[] = useMemo(() => {
    const fish: (FishEntry & { isSubjectDeleted: boolean })[] = [];
    for (const progression of Object.values(bySubject)) {
      for (const entry of progression.fishCollection) {
        fish.push({
          ...entry,
          isSubjectDeleted:
            existingSubjectIds.size > 0 && !existingSubjectIds.has(entry.subjectId),
        });
      }
    }
    return fish;
  }, [bySubject, existingSubjectIds]);

  const hasAllTypes = useMemo(() => {
    if (allFish.length === 0) return false;
    const caughtCatalogIds = new Set(allFish.map((f) => f.id.split(':')[0]));
    return FISH_CATALOG.every((c) => caughtCatalogIds.has(c.id));
  }, [allFish]);

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  const uniqueSubjectCount = new Set(allFish.map((f) => f.subjectName)).size;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="village-info-panel ui-skin fish-stand-panel"
        data-theme={colorTheme}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="village-info-panel-header">
          <span className="village-info-portal-icon">🐟</span>
          <div>
            <h3>Fish Collection</h3>
            <p className="village-info-meta">
              {allFish.length > 0
                ? `${allFish.length} fish caught across ${uniqueSubjectCount} subject${uniqueSubjectCount !== 1 ? 's' : ''}`
                : 'No fish caught yet'}
            </p>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Completion banner */}
        {hasAllTypes && (
          <div className="fish-collection-complete-banner">
            You've caught every type of fish! Your collection is complete! 🎉
          </div>
        )}

        {/* Empty state */}
        {allFish.length === 0 ? (
          <div className="fish-collection-empty">
            <span role="img" aria-hidden="true" style={{ fontSize: 48 }}>
              🐟
            </span>
            <p>
              No fish caught yet! Visit a fishing pond near a dungeon portal to
              start your collection.
            </p>
          </div>
        ) : (
          /* Fish grid */
          <div className="fish-collection-grid">
            {allFish.map((fish) => (
              <div key={fish.id} className="fish-collection-card">
                <span className="fish-collection-card-name">{fish.name}</span>
                <span className="fish-rarity-badge" data-rarity={fish.rarity}>
                  {fish.rarity}
                </span>
                <span
                  className={
                    'fish-collection-card-subject' +
                    (fish.isSubjectDeleted
                      ? ' fish-collection-card-subject--deleted'
                      : '')
                  }
                >
                  {fish.isSubjectDeleted
                    ? '(Deleted Subject)'
                    : fish.subjectName}
                </span>
                <span className="fish-collection-card-date">
                  {formatDate(fish.caughtAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
