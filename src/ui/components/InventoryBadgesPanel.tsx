import { Suspense, lazy, useEffect, useMemo, useState, type JSX } from 'react';
import { FISHING_BADGE_DEFS, FISHING_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression';
import type { EquippableLootItem, FishingBadgeId, PhaseBadgeId } from '@/core/progression';
import { EQUIP_SLOTS, EQUIP_SLOT_LABELS, type EquipSlot } from '@/core/progression';
import { canonicalBadgeLabel } from '@/core/share/shareCardContent';
import type { ShareCardKind } from '@/core/share/types';
import type { CollectedNoteEntry, LootItem } from '@/store/progressionStore';
import {
  SHARE_CARD_ID_ATTRIBUTE,
  SHARE_CARD_IDS,
  SHARE_CARD_KIND_ATTRIBUTE,
} from '@/ui/share/shareCardTestIds';
import type { ShareCardFacts } from '@/ui/share/shareCardFacts';
import { Markdown } from '@/ui/utils/markdown';

/**
 * The share dialog, reached only through a dynamic import.
 *
 * `vite.config.ts` fails the default production build if any declared share-lane module -
 * `src/core/share/shareCardPolicy`, `src/ui/share/renderShareCard`, `src/ui/share/ShareCardDialog` -
 * is statically reachable from the entry, and the whole application core is emitted into a **single**
 * entry chunk today, so a plain `import` here would make every Welcome visitor download a card
 * renderer they cannot use until they open a subject. `React.lazy` is the mechanism, and it is also
 * the right product behaviour: this panel is reachable from the game screen, and the chunk is
 * fetched the moment a learner opens the preview on purpose.
 *
 * Two properties worth stating rather than assuming:
 *
 * - **Module scope.** `lazy()` performs no import when it is called, so defining this inside the
 *   component would mint a new component type on every render and remount the dialog each time.
 * - **`fallback={null}`.** An element that exists only to be replaced is still an element, and this
 *   dialog opens on a deliberate click, so a frame of nothing is the honest loading state.
 */
const LazyShareCardDialog = lazy(
  async () => ({ default: (await import('@/ui/share/ShareCardDialog')).ShareCardDialog }),
);

interface InventoryBadgesPanelProps {
  view: 'inventory' | 'badges' | 'journal';
  inventory: readonly LootItem[];
  badges: readonly string[];
  collectedNotes: readonly CollectedNoteEntry[];
  equippedItems: readonly EquippableLootItem[];
  equipBonuses: { qualityBonus: number; xpMultiplier: number; xpBonus: number; streakBonus: number };
  onEquip: (itemId: string) => void;
  onUnequip: (itemId: string) => void;
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

/**
 * Everything a badge shows besides its name.
 *
 * Split from {@link BadgeDetail} because the name and the rest have **different sources**: the
 * name is published content owned by `canonicalBadgeLabel`, and the rest is this panel's own
 * explanation of a rule. Keeping them apart in the type is what stops the two being merged back
 * into one lookup, which is how the pre-Phase-20 defect happened.
 */
interface BadgePresentation {
  /** The one-line explanation under the name in the Badges tab. */
  description: string;
  /** The kind line under the name in the detail header. */
  category: string;
  /** The "Unlock" row of the detail card. */
  unlockDetail: string;
}

interface BadgeDetail extends BadgePresentation {
  label: string;
}

const RARITY_COLOR: Record<LootItem['rarity'], string> = {
  common: 'var(--text-secondary)',
  rare: 'var(--accent-cool)',
  epic: 'var(--accent)',
};

/**
 * The name shown for a badge id this build cannot name.
 *
 * ## Why this exists at all
 *
 * `canonicalBadgeLabel` answers `undefined` for an id it does not recognise, and `undefined`
 * means **omit**. That is the right contract for a published image: a card says "3 badges" and
 * invents no name for the third. This panel is not a published image - it is the learner's own
 * screen, they are looking up what they earned, and the tab header counts every badge they hold -
 * so dropping the row here would make the list disagree with the number above it, with nothing
 * saying why. A silently shorter list is the same class of lie as an invented name.
 *
 * So the row stays, and it is given a **neutral name that is visibly not an identifier**. The
 * three options the phase leaves open, and why this one:
 *
 * - **Omit the row.** Rejected above: the header would still count it.
 * - **Show the id, framed as unrecognised.** Rejected: it puts an internal identifier on screen,
 *   which is the rule this phase exists to remove, and "unrecognised" framing does not un-print
 *   it. It also teaches the learner an id the app has just admitted it cannot read.
 * - **A neutral name.** Chosen. It never asserts what the badge is, which is the one thing this
 *   panel genuinely does not know.
 *
 * ## What the copy does and does not claim
 *
 * It says **this version of the app** has no name and does not award it. It does not say the
 * record is corrupt, or that an earlier version earned it, or that it is a fishing badge: any of
 * those would be a guess about which badge a record meant, and `canonicalBadgeLabel` refuses the
 * same guess for the same reason. It also states the thing that would otherwise look like a bug -
 * the badge still counts - which is true: `badgeCount` counts ids with no published name too.
 */
const UNRECOGNISED_BADGE_LABEL = 'Unrecognised badge';

const UNRECOGNISED_BADGE: BadgePresentation = {
  description:
    'Your saved record lists a badge this version of the app has no name for. It still counts toward your badge total.',
  category: 'Badge in your saved record',
  // Not a milestone claim. The pre-Phase-20 fallback said "Earned by reaching a progression
  // milestone in the dungeon" about every id it did not recognise, which is a false statement
  // about a badge this build has no rule for at all.
  unlockDetail: 'Not shown: this version of the app does not award this badge.',
};

/**
 * The six phase badges, explained.
 *
 * Typed `Record<PhaseBadgeId, ...>` on purpose, for the reason
 * `canonicalBadgeLabel` documents for its own table: adding a seventh id to `PHASE_BADGE_IDS` is a
 * typecheck error here until somebody writes what it means. An id with no explanation would
 * otherwise fall through to {@link UNRECOGNISED_BADGE}, whose copy says this version does not award
 * it - true of no badge at all today, and a lie about a real badge the moment its award path lands.
 */
const PHASE_BADGE_PRESENTATIONS: Readonly<Record<PhaseBadgeId, BadgePresentation>> = Object.freeze({
  CreatorPhaseComplete: {
    description: 'Mapped 90%+ of rooms in the creator phase.',
    category: 'Creator milestone',
    unlockDetail: 'Map at least 90% of the dungeon rooms during the creator phase.',
  },
  ScribePhaseComplete: {
    description: 'Cleared every room by completing scribe encounters.',
    category: 'Scribe milestone',
    unlockDetail: 'Clear every room encounter by submitting valid scribe notes.',
  },
  ArchaeologistPhaseComplete: {
    description: 'Completed at least two full archaeology review passes.',
    category: 'Archaeologist milestone',
    unlockDetail: 'Complete at least two full archaeology review passes across the dungeon.',
  },
  ArchaeologistReviewPass3: {
    description: 'Completed at least 3 full archaeology review passes.',
    category: 'Review streak milestone',
    unlockDetail: 'Complete at least 3 full archaeology review passes for this subject.',
  },
  ArchaeologistReviewPass7: {
    description: 'Completed at least 7 full archaeology review passes.',
    category: 'Review streak milestone',
    unlockDetail: 'Complete at least 7 full archaeology review passes for this subject.',
  },
  ArchaeologistReviewPass15: {
    description: 'Completed at least 15 full archaeology review passes.',
    category: 'Review streak milestone',
    unlockDetail: 'Complete at least 15 full archaeology review passes for this subject.',
  },
});

/**
 * The note-length badge. Its only constant is its id; the name is published content.
 */
const SCRIBE_CENTURY_PRESENTATION: BadgePresentation = {
  description: 'Awarded for writing a note with at least 120 words in a valid encounter.',
  category: 'Bonus note badge',
  unlockDetail: 'Write at least 120 words in a valid encounter note for one room.',
};

/**
 * The four fishing badges, explained from the thresholds the fish domain already owns.
 *
 * Derived rather than transcribed, for two reasons. First, the number a fishing badge counts is
 * decided in `evaluateFishingBadgeUnlocks`, not here, and a hand-typed "10" next to a threshold of
 * 10 is a number that can go stale without anything failing. Second, these four are the badges
 * the pre-Phase-20 panel called "Milestone badge" and claimed were "earned by reaching a progression
 * milestone in the dungeon" - false, since they are earned at the pond by catching fish, and
 * visible now that each one finally has a name above that sentence.
 *
 * `FISHING_BADGE_DEFS` writes the full-creel threshold as `-1`, documented there as "all unique
 * fish types caught", so the count of every species is read off the threshold rather than matched
 * against the id - which keeps the copy correct for a future badge of the same shape.
 */
function fishingBadgePresentation(badgeId: FishingBadgeId): BadgePresentation {
  const { threshold } = FISHING_BADGE_DEFS[badgeId];
  if (threshold < 0) {
    return {
      description: 'Caught one of every fish species in the pond.',
      category: 'Fishing milestone',
      unlockDetail: 'Catch every fish species in the pond.',
    };
  }
  return {
    // "fish" is the same noun in the singular here, which is why the count is interpolated whole.
    description: `Caught ${threshold} fish at the pond.`,
    category: 'Fishing milestone',
    unlockDetail: `Catch ${threshold} fish at the pond.`,
  };
}

/**
 * The explanation for every badge id this build awards, as a `Map`.
 *
 * A `Map`, not an object literal, for the reason `canonicalBadgeLabel` gives for the same choice:
 * `BADGE_DESCRIPTIONS['constructor']` returned something truthy from `Object.prototype` for an id
 * the table had never heard of, so `??` never fired and the panel tried to render a function as a
 * React child. Every canonical id is present - a `Map` lookup that misses is
 * {@link UNRECOGNISED_BADGE}, which is a truthful statement rather than a wrong one - and every id
 * the app can award is in the construction above, so nothing lands there by accident.
 */
const BADGE_PRESENTATIONS: ReadonlyMap<string, BadgePresentation> = new Map<string, BadgePresentation>([
  ...Object.entries(PHASE_BADGE_PRESENTATIONS),
  [SCRIBE_CENTURY_120_BADGE_ID, SCRIBE_CENTURY_PRESENTATION],
  ...FISHING_BADGE_IDS.map((badgeId) => [badgeId, fishingBadgePresentation(badgeId)] as const),
]);

const RARITY_HINT: Record<LootItem['rarity'], string> = {
  common: 'Utility: baseline study support item.',
  rare: 'Utility: stronger navigation or recall support.',
  epic: 'Utility: highest-tier synthesis support item.',
};

function slotIcon(slot: EquipSlot): string {
  switch (slot) {
    case 'head': return '🪖';
    case 'body': return '🛡️';
    case 'accessory': return '💍';
    case 'weapon': return '⚔️';
  }
}

/**
 * Everything the panel shows for one badge id.
 *
 * The single resolver both surfaces use - the Badges tab list and the detail card - so a badge
 * cannot be named one way in the list and another way in the detail view.
 *
 * The name comes from `canonicalBadgeLabel` and from nowhere else. This function used to read
 * `BADGE_LABELS[badgeId] ?? badgeId` over a table holding exactly one entry, which put
 * `CreatorPhaseComplete`, `ArchaeologistReviewPass15`, and `FshMasterAngler` on screen as
 * badge *names* - ten of the eleven ids this build can award, on the screen a learner reads to
 * learn what they earned. There is no `?? badgeId` here, and no second table: one source of
 * labels, not two.
 */
function badgeDetail(badgeId: string): BadgeDetail {
  return {
    label: canonicalBadgeLabel(badgeId) ?? UNRECOGNISED_BADGE_LABEL,
    ...(BADGE_PRESENTATIONS.get(badgeId) ?? UNRECOGNISED_BADGE),
  };
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
  equippedItems,
  equipBonuses,
  onEquip,
  onUnequip,
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
  const [selectedBadgeId, setSelectedBadgeId] = useState<string | null>(null);
  /*
   * Which card the learner asked for, or `null` for "no dialog".
   *
   * A kind rather than a boolean, so the two controls that replaced the two instant-download buttons
   * open the card each of them names. The pre-Phase-20 buttons exported the moment they were
   * clicked - no preview, no choice - which is exactly what plan section 9 forbids.
   */
  const [shareCardKind, setShareCardKind] = useState<ShareCardKind | null>(null);

  /**
   * The counts the dialog is allowed to see.
   *
   * Note what is **not** here: `inventory` and `collectedNotes` are passed as their lengths, so the
   * card has no parameter through which a note body or an item description could arrive. The panel
   * holds those arrays; the card does not. `toShareCardBuildInput` in `@/ui/share/shareCardFacts`
   * does the same projection again at the boundary, so the guarantee does not rest on this call site
   * alone.
   */
  const shareFacts: ShareCardFacts = useMemo(
    () => ({
      subjectName,
      xpTotal,
      rank,
      clearedRoomCount,
      totalRoomCount,
      badgeIds: badges,
      inventoryCount: inventory.length,
      collectedNoteCount: collectedNotes.length,
      fish: null,
      statistics: null,
      assistance: null,
    }),
    [subjectName, xpTotal, rank, clearedRoomCount, totalRoomCount, badges, inventory, collectedNotes],
  );

  useEffect(() => {
    if (!autoOpenNoteId) return;
    const noteExists = collectedNotes.some((entry) => entry.noteId === autoOpenNoteId);
    if (!noteExists) return;
    setSelectedBadgeId(null);
    setSelectedNoteId(autoOpenNoteId);
  }, [autoOpenNoteId, collectedNotes]);

  const selectedNote = useMemo(
    () => collectedNotes.find((entry) => entry.noteId === selectedNoteId) ?? null,
    [collectedNotes, selectedNoteId],
  );
  const selectedBadge = useMemo(
    () => (selectedBadgeId && badges.includes(selectedBadgeId) ? badgeDetail(selectedBadgeId) : null),
    [badges, selectedBadgeId],
  );

  const dialogLabel =
    selectedNote !== null
      ? `Collected note: ${selectedNote.topic}`
      : selectedBadge !== null
        ? `Badge: ${selectedBadge.label}`
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
                setSelectedBadgeId(null);
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
                setSelectedBadgeId(null);
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
                setSelectedBadgeId(null);
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
          {/*
            The two pre-Phase-20 buttons exported the instant they were clicked: no preview, no
            choice about what was on the image, and - because the old collection exporter printed
            badge **ids** - an internal identifier on a picture a learner could publish. Both now open
            the preview-and-select dialog for the card each of them names.

            The inline 44x44 floor is on both for the same reason it is on every control in
            `ShareCardDialog`: jsdom computes no layout, so a stylesheet rule is not assertable, and
            the inline floor survives a stylesheet that failed to load.
          */}
          <button
            type="button"
            className="ghost"
            style={{ minWidth: '44px', minHeight: '44px' }}
            onClick={() => setShareCardKind('subject-summary')}
            {...{ [SHARE_CARD_ID_ATTRIBUTE]: SHARE_CARD_IDS.open }}
            {...{ [SHARE_CARD_KIND_ATTRIBUTE]: 'subject-summary' }}
          >
            Share a summary card
          </button>
          <button
            type="button"
            className="ghost"
            style={{ minWidth: '44px', minHeight: '44px' }}
            onClick={() => setShareCardKind('collection')}
            {...{ [SHARE_CARD_ID_ATTRIBUTE]: SHARE_CARD_IDS.open }}
            {...{ [SHARE_CARD_KIND_ATTRIBUTE]: 'collection' }}
          >
            Share a collection card
          </button>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>

        {shareCardKind === null ? null : (
          <Suspense fallback={null}>
            <LazyShareCardDialog
              open
              facts={shareFacts}
              initialKind={shareCardKind}
              onClose={() => setShareCardKind(null)}
            />
          </Suspense>
        )}

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
        ) : selectedBadge ? (
          <section className="journal-note-view" aria-label="Badge details">
            <div className="journal-note-view-header">
              <div>
                <h3>{selectedBadge.label}</h3>
                <p className="room-help-text">{selectedBadge.category}</p>
              </div>
              <button type="button" className="ghost" onClick={() => setSelectedBadgeId(null)}>
                Back to badges
              </button>
            </div>
            <div className="badge-detail-card">
              <div className="badge-detail-icon" aria-hidden="true">
                🏅
              </div>
              <p>{selectedBadge.description}</p>
              {/*
                One row, not two. This used to carry a second definition - "Badge ID", the raw id -
                which was the only remaining place an internal identifier was drawn as text in this
                panel once every badge had a published name. Nothing read it: no support flow asks a
                learner for a badge id, and a badge they cannot name is exactly what the name above
                now supplies. A support bundle that needs the id reads it from the record, where it
                is a field, rather than from a screen the learner is asked to transcribe.
              */}
              <dl className="badge-detail-meta">
                <div>
                  <dt>Unlock</dt>
                  <dd>{selectedBadge.unlockDetail}</dd>
                </div>
              </dl>
            </div>
          </section>
        ) : view === 'inventory' ? (
          <>
            {/* Equipment slots */}
            <section className="equip-slots-section" style={{ marginBottom: 12 }}>
              <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Equipment</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {EQUIP_SLOTS.map((slot) => {
                  const item = equippedItems.find((e) => e.equipSlot === slot);
                  return (
                    <div
                      key={slot}
                      className={`equip-slot${item ? ' equip-slot--filled' : ''}`}
                      title={item ? `${item.name} - ${item.description}` : `Empty ${EQUIP_SLOT_LABELS[slot]} slot`}
                    >
                      <span style={{ fontSize: 14 }}>{slotIcon(slot)}</span>
                      <span style={{ fontSize: 11, flex: 1 }}>{item ? item.name : EQUIP_SLOT_LABELS[slot]}</span>
                      {item ? (
                        <button
                          type="button"
                          className="ghost"
                          style={{ fontSize: 10, padding: '1px 4px' }}
                          onClick={() => onUnequip(item.id)}
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {(equipBonuses.qualityBonus > 0 || equipBonuses.xpMultiplier > 1) ? (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  +{equipBonuses.qualityBonus} quality &middot; {equipBonuses.xpMultiplier}x XP &middot; +{equipBonuses.xpBonus} flat &middot; +{equipBonuses.streakBonus} streak
                </p>
              ) : null}
            </section>

            {inventory.length === 0 ? (
            <p className="room-help-text">
              No loot yet. Defeat encounters during the Scribe phase to earn artifacts.
            </p>
          ) : (
            <ul className="inventory-grid">
              {inventory.map((item) => {
                const isEquippable = 'equipSlot' in item && (item as EquippableLootItem).equipSlot !== undefined;
                const isEquipped = isEquippable && equippedItems.some((e) => e.id === (item as EquippableLootItem).id);
                return (
                <li
                  key={item.id}
                  className="inventory-card"
                  style={{ borderColor: RARITY_COLOR[item.rarity] }}
                >
                  <div className="inventory-card-icon" aria-hidden="true">
                    {isEquippable ? slotIcon((item as EquippableLootItem).equipSlot) : '📜'}
                  </div>
                  <div>
                    <div className="inventory-card-title">
                      {item.name}
                      {isEquipped ? <span className="loot-equipped-badge" style={{ marginLeft: 6 }}>Equipped</span> : null}
                    </div>
                    <div className="inventory-card-rarity" style={{ color: RARITY_COLOR[item.rarity] }}>
                      {item.rarity}{isEquippable ? ` · ${EQUIP_SLOT_LABELS[(item as EquippableLootItem).equipSlot]}` : ''}
                    </div>
                    <p className="inventory-card-desc">{item.description}</p>
                    <p className="inventory-card-desc">{RARITY_HINT[item.rarity]}</p>
                    <p className="room-help-text">Acquired: {formatTimestamp(item.acquiredAt)}</p>
                    {isEquippable ? (
                      <button
                        type="button"
                        className="ghost"
                        style={{ marginTop: 4, fontSize: 11 }}
                        onClick={() => isEquipped ? onUnequip(item.id) : onEquip(item.id)}
                      >
                        {isEquipped ? 'Unequip' : 'Equip'}
                      </button>
                    ) : null}
                  </div>
                </li>
                );
              })}
            </ul>
          )}
          </>
        ) : view === 'badges' ? (
          badges.length === 0 ? (
          <p className="room-help-text">
            No badges yet. Reach milestones (rooms cleared, ranks gained) to earn badges.
          </p>
        ) : (
          <ul className="badge-grid">
            {badges.map((badge) => {
              // Resolved through the one resolver, so the list and the detail card cannot disagree
              // about what a badge is called.
              const detail = badgeDetail(badge);
              return (
                <li key={badge}>
                  <button
                    type="button"
                    className="badge-card badge-card-button"
                    onClick={() => {
                      setSelectedNoteId(null);
                      setSelectedBadgeId(badge);
                    }}
                  >
                    <span className="badge-icon" aria-hidden="true">
                      🏅
                    </span>
                    <div>
                      <div className="badge-label">{detail.label}</div>
                      <p className="room-help-text">{detail.description}</p>
                      <p className="room-help-text">Click for more detail.</p>
                    </div>
                  </button>
                </li>
              );
            })}
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
