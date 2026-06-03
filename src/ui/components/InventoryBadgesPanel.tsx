import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  SCRIBE_CENTURY_120_BADGE_ID,
  SCRIBE_CENTURY_120_BADGE_LABEL,
} from '@/core/progression';
import type { CollectedNoteEntry, LootItem } from '@/store/progressionStore';
import {
  exportCollectionSnapshot,
  exportSubjectSummaryCard,
} from '@/ui/utils/progressionShareExport';
import { Markdown } from '@/ui/utils/markdown';

interface InventoryBadgesPanelProps {
  view: 'inventory' | 'badges' | 'journal';
  inventory: readonly LootItem[];
  badges: readonly string[];
  collectedNotes: readonly CollectedNoteEntry[];
  subjectName: string;
  clearedRoomCount: number;
  totalRoomCount: number;
  noteMarkdownByRoomId?: Readonly<Record<string, string>>;
  xpTotal: number;
  rank: string;
  autoOpenNoteId?: string | null;
  resolveCollectedNoteImage?: (roomId: string, attachmentId: string) => string | null;
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
  ArchaeologistReviewPass3: 'Completed at least 3 full archaeology review passes.',
  ArchaeologistReviewPass7: 'Completed at least 7 full archaeology review passes.',
  ArchaeologistReviewPass15: 'Completed at least 15 full archaeology review passes.',
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
  subjectName,
  clearedRoomCount,
  totalRoomCount,
  noteMarkdownByRoomId,
  xpTotal,
  rank,
  autoOpenNoteId,
  resolveCollectedNoteImage,
  onSwitchView,
  onClose,
}: InventoryBadgesPanelProps): JSX.Element {
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  useEffect(() => {
    if (!autoOpenNoteId) return;
    const noteExists = collectedNotes.some((entry) => entry.noteId === autoOpenNoteId);
    if (!noteExists) return;
    setSelectedNoteId(autoOpenNoteId);
  }, [autoOpenNoteId, collectedNotes]);

  const selectedNote = useMemo(
    () => collectedNotes.find((entry) => entry.noteId === selectedNoteId) ?? null,
    [collectedNotes, selectedNoteId],
  );

  const dialogLabel =
    selectedNote !== null
      ? `Collected note: ${selectedNote.topic}`
      : view === 'inventory'
        ? 'Inventory'
        : view === 'badges'
          ? 'Badges'
          : 'Collected notes';

  const selectedNoteMarkdown = useMemo(() => {
    if (!selectedNote) return '';
    const liveNote = noteMarkdownByRoomId?.[selectedNote.roomId]?.trim() ?? '';
    const persisted = selectedNote.noteMarkdown?.trim() ?? '';
    const looksLikeLegacyArtifact = /artifact id:/i.test(persisted);
    if (liveNote.length > 0) return liveNote;
    if (persisted.length > 0 && !looksLikeLegacyArtifact) return persisted;
    return selectedNote.artifactMarkdown;
  }, [selectedNote, noteMarkdownByRoomId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal inventory-badges-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={dialogLabel}
      >
        <div className="inventory-badges-header">
          <div className="inventory-badges-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'inventory'}
              onClick={() => {
                setSelectedNoteId(null);
                onSwitchView('inventory');
              }}
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
              onClick={() => {
                setSelectedNoteId(null);
                onSwitchView('badges');
              }}
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
              onClick={() => {
                setSelectedNoteId(null);
                onSwitchView('journal');
              }}
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
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void exportSubjectSummaryCard({
                subjectName,
                xpTotal,
                rank,
                badgeCount: badges.length,
                inventoryCount: inventory.length,
                collectedNoteCount: collectedNotes.length,
                clearedRoomCount,
                totalRoomCount,
              });
            }}
          >
            Export summary image
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void exportCollectionSnapshot({
                subjectName,
                xpTotal,
                rank,
                badges,
                inventory,
                collectedNotes,
              });
            }}
          >
            Export collections image
          </button>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>

        {selectedNote ? (
          <section className="journal-note-view" aria-label="Collected note details">
            <div className="journal-note-view-header">
              <div>
                <h3>{selectedNote.topic}</h3>
                <p className="room-help-text">
                  {selectedNote.floorLabel} · Collected {formatTimestamp(selectedNote.collectedAt)}
                </p>
              </div>
              <button type="button" className="ghost" onClick={() => setSelectedNoteId(null)}>
                Back to journal
              </button>
            </div>
            <div className="journal-note-markdown journal-note-markdown--wide">
              <Markdown
                source={selectedNoteMarkdown}
                resolveLocalImage={(attachmentId) =>
                  selectedNote ? resolveCollectedNoteImage?.(selectedNote.roomId, attachmentId) ?? null : null
                }
              />
            </div>
          </section>
        ) : view === 'inventory' ? (
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
                  <button
                    type="button"
                    className="journal-note-link"
                    onClick={() => setSelectedNoteId(entry.noteId)}
                  >
                    {entry.topic}
                  </button>
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
