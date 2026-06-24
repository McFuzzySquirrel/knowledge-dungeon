/**
 * Progression store - XP, rank, badges, inventory. Persists to localStorage
 * mirroring repo-dungeon's progression-store wiring.
 *
 * Phase 3c additions: equippable loot/gear system, cross-subject achievements.
 */
import { create } from 'zustand';
import {
  assignRankTier,
  awardRoomClearProgression,
  type RankTier,
  type EquippableLootItem,
  type EquipSlot,
  type CrossSubjectProgress,
  EQUIP_SLOTS,
  computeEquipBonuses,
  rollEquippableLoot,
  computeCrossSubjectProgress,
  evaluateAchievementUnlocks,
  FSH_XP_PER_CORRECT_ANSWER,
  FISHING_BADGE_DEFS,
  FISHING_BADGE_IDS,
  type FishingBadgeId,
} from '@/core/progression';
import { STORAGE_KEYS, getActiveSubjectId } from '@/services/persistence/subjectPersistence';
import type { FishEntry, FishRarity, FishCollection } from '@/game/systems/fishingTypes';
import { FISH_RARITY_XP_MULTIPLIER, FISH_CATALOG } from '@/game/systems/fishingTypes';
import { deserializeFishCollection, createFishId, addFishToCollection, countUniqueTypes } from '@/core/fishing/fishCollectionService';

export interface LootItem {
  id: string;
  name: string;
  description: string;
  rarity: 'common' | 'rare' | 'epic';
  acquiredAt: string;
}

export interface CollectedNoteEntry {
  noteId: string;
  dungeonId: string;
  roomId: string;
  topic: string;
  floorLabel: string;
  artifactPreview: string;
  noteMarkdown: string;
  artifactMarkdown: string;
  collectedAt: string;
}

interface PersistedSubjectProgression {
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: LootItem[];
  equippedItems: EquippableLootItem[];
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
  /** Phase 3c: subjects mastered count */
  subjectsMastered: number;
  roomsCleared: number;
  reviewPasses: number;
  artifacts: number;
  bossesDefeated: number;
  /** Fisher's Rest: fish caught in this subject */
  fishCollection: FishEntry[];
}

const REVIEW_PASS_XP = 6;

interface PersistedProgressionV3 {
  version: 3;
  bySubject: Record<string, PersistedSubjectProgression>;
  crossSubjectAchievements: string[];
}

function cloneDefaultSubjectProgression(): PersistedSubjectProgression {
  return {
    xpTotal: 0,
    rank: 'Novice',
    badges: [],
    inventory: [],
    equippedItems: [],
    collectedNotes: [],
    streakCount: 0,
    subjectsMastered: 0,
    roomsCleared: 0,
    reviewPasses: 0,
    artifacts: 0,
    bossesDefeated: 0,
    fishCollection: [],
  };
}

function normalizeCollectedNotes(raw: unknown): CollectedNoteEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      noteId: typeof entry.noteId === 'string' ? entry.noteId : '',
      dungeonId: typeof entry.dungeonId === 'string' ? entry.dungeonId : '',
      roomId: typeof entry.roomId === 'string' ? entry.roomId : '',
      topic: typeof entry.topic === 'string' ? entry.topic : 'Collected note',
      floorLabel: typeof entry.floorLabel === 'string' ? entry.floorLabel : 'Unknown floor',
      artifactPreview: typeof entry.artifactPreview === 'string' ? entry.artifactPreview : '',
      noteMarkdown: typeof entry.noteMarkdown === 'string' ? entry.noteMarkdown : '',
      artifactMarkdown:
        typeof entry.artifactMarkdown === 'string'
          ? entry.artifactMarkdown
          : typeof entry.artifactPreview === 'string'
            ? entry.artifactPreview
            : 'Artifact note collected.',
      collectedAt: typeof entry.collectedAt === 'string' ? entry.collectedAt : new Date(0).toISOString(),
    }))
    .filter((entry) => entry.noteId.length > 0);
}

function normalizeInventory(raw: unknown): LootItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : `loot-${Math.random().toString(36).slice(2, 8)}`,
      name: typeof entry.name === 'string' ? entry.name : 'Unknown artifact',
      description: typeof entry.description === 'string' ? entry.description : '',
      rarity: entry.rarity === 'rare' || entry.rarity === 'epic' ? entry.rarity : 'common',
      acquiredAt: typeof entry.acquiredAt === 'string' ? entry.acquiredAt : new Date(0).toISOString(),
    }));
}

function normalizeSubjectProgression(raw: unknown): PersistedSubjectProgression {
  if (typeof raw !== 'object' || raw === null) return cloneDefaultSubjectProgression();
  const record = raw as Record<string, unknown>;
  const xpTotal = typeof record.xpTotal === 'number' ? Math.max(0, Math.trunc(record.xpTotal)) : 0;
  return {
    xpTotal,
    rank: assignRankTier(xpTotal),
    badges: Array.isArray(record.badges)
      ? record.badges.filter((badge): badge is string => typeof badge === 'string')
      : [],
    inventory: normalizeInventory(record.inventory),
    equippedItems: normalizeEquippedItems(record.equippedItems),
    collectedNotes: normalizeCollectedNotes(record.collectedNotes),
    streakCount: typeof record.streakCount === 'number' ? Math.max(0, Math.trunc(record.streakCount)) : 0,
    subjectsMastered: typeof record.subjectsMastered === 'number' ? Math.max(0, Math.trunc(record.subjectsMastered)) : 0,
    roomsCleared: typeof record.roomsCleared === 'number' ? Math.max(0, Math.trunc(record.roomsCleared)) : 0,
    reviewPasses: typeof record.reviewPasses === 'number' ? Math.max(0, Math.trunc(record.reviewPasses)) : 0,
    artifacts: typeof record.artifacts === 'number' ? Math.max(0, Math.trunc(record.artifacts)) : 0,
    bossesDefeated: typeof record.bossesDefeated === 'number' ? Math.max(0, Math.trunc(record.bossesDefeated)) : 0,
    fishCollection: deserializeFishCollection(record.fishCollection),
  };
}

function normalizeEquippedItems(raw: unknown): EquippableLootItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry): EquippableLootItem => ({
      id: typeof entry.id === 'string' ? entry.id : `gear-${Math.random().toString(36).slice(2, 8)}`,
      name: typeof entry.name === 'string' ? entry.name : 'Unknown gear',
      description: typeof entry.description === 'string' ? entry.description : '',
      rarity: entry.rarity === 'rare' || entry.rarity === 'epic' ? entry.rarity : 'common',
      acquiredAt: typeof entry.acquiredAt === 'string' ? entry.acquiredAt : new Date(0).toISOString(),
      equipSlot: isValidEquipSlot(entry.equipSlot) ? entry.equipSlot : 'accessory',
      qualityBonus: typeof entry.qualityBonus === 'number' ? entry.qualityBonus : undefined,
      xpMultiplier: typeof entry.xpMultiplier === 'number' ? entry.xpMultiplier : undefined,
      xpBonus: typeof entry.xpBonus === 'number' ? entry.xpBonus : undefined,
      streakBonus: typeof entry.streakBonus === 'number' ? entry.streakBonus : undefined,
      equipped: typeof entry.equipped === 'boolean' ? entry.equipped : false,
    }));
}

function isValidEquipSlot(slot: unknown): slot is EquipSlot {
  if (typeof slot !== 'string') return false;
  return (EQUIP_SLOTS as readonly string[]).includes(slot);
}

function notesForSubject(notes: readonly CollectedNoteEntry[], subjectId: string): CollectedNoteEntry[] {
  return notes.filter((note) => note.dungeonId === subjectId);
}

function loadPersistedBySubject(): { bySubject: Record<string, PersistedSubjectProgression>; crossSubjectAchievements: string[] } {
  try {
    if (typeof localStorage === 'undefined') return { bySubject: {}, crossSubjectAchievements: [] };
    const raw = localStorage.getItem(STORAGE_KEYS.progression);
    if (!raw) return { bySubject: {}, crossSubjectAchievements: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { bySubject: {}, crossSubjectAchievements: [] };
    const parsedRecord = parsed as Record<string, unknown>;

    let crossSubjectAchievements: string[] = [];
    if (parsedRecord.version === 3) {
      crossSubjectAchievements = Array.isArray(parsedRecord.crossSubjectAchievements)
        ? parsedRecord.crossSubjectAchievements.filter((a): a is string => typeof a === 'string')
        : [];
    }

    if ((parsedRecord.version === 3 || parsedRecord.version === 2) && typeof parsedRecord.bySubject === 'object' && parsedRecord.bySubject !== null) {
      const bySubjectRecord = parsedRecord.bySubject as Record<string, unknown>;
      const normalized: Record<string, PersistedSubjectProgression> = {};
      for (const [subjectId, subjectProgression] of Object.entries(bySubjectRecord)) {
        normalized[subjectId] = normalizeSubjectProgression(subjectProgression);
      }
      return { bySubject: normalized, crossSubjectAchievements };
    }

    const legacy = normalizeSubjectProgression(parsedRecord);
    const activeSubjectId = getActiveSubjectId();
    const subjectId = activeSubjectId && activeSubjectId.trim().length > 0 ? activeSubjectId : '__legacy__';
    return { bySubject: { [subjectId]: legacy }, crossSubjectAchievements };
  } catch {
    return { bySubject: {}, crossSubjectAchievements: [] };
  }
}

function savePersistedBySubject(
  bySubject: Record<string, PersistedSubjectProgression>,
  crossSubjectAchievements: string[],
): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const payload: PersistedProgressionV3 = {
        version: 3,
        bySubject,
        crossSubjectAchievements,
      };
      localStorage.setItem(STORAGE_KEYS.progression, JSON.stringify(payload));
    }
  } catch {
    /* ignore */
  }
}

function getSubjectProgression(
  bySubject: Record<string, PersistedSubjectProgression>,
  subjectId: string | null,
): PersistedSubjectProgression {
  if (!subjectId) return cloneDefaultSubjectProgression();
  const current = bySubject[subjectId] ?? cloneDefaultSubjectProgression();
  return {
    ...current,
    collectedNotes: notesForSubject(current.collectedNotes, subjectId),
  };
}

const LOOT_POOL: Omit<LootItem, 'id' | 'acquiredAt'>[] = [
  {
    name: 'Inkwell of Insight',
    description: 'A small ceramic inkwell that hums when a recall question is well-formed.',
    rarity: 'common',
  },
  {
    name: 'Cartographer’s Compass',
    description: 'Points toward the next unresolved room in your subject graph.',
    rarity: 'rare',
  },
  {
    name: 'Tome of Cross-References',
    description: 'A worn volume whose pages refuse to stay closed until you write a link.',
    rarity: 'epic',
  },
];

export interface ProgressionStoreState {
  activeSubjectId: string | null;
  bySubject: Record<string, PersistedSubjectProgression>;
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: LootItem[];
  equippedItems: EquippableLootItem[];
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
  /** Phase 3c: per-subject extended stats exposed at top level */
  subjectsMastered: number;
  roomsCleared: number;
  reviewPasses: number;
  artifacts: number;
  bossesDefeated: number;
  /** Phase 3c: cross-subject achievements */
  crossSubjectAchievements: string[];
  /** Fisher's Rest: fish caught in the active subject */
  fishCollection: FishEntry[];
  setActiveSubject: (subjectId: string | null) => void;
  awardBadge: (badgeId: string) => boolean;
  collectArtifactNote: (entry: Omit<CollectedNoteEntry, 'noteId' | 'collectedAt'>) => boolean;
  awardRoomClear: (input: {
    qualityBonus: number;
    totalRooms: number;
    creatorMappedRooms: number;
    scribeClearedRooms: number;
    archaeologistFullReviewPasses: number;
    /** Track 3c: is this a boss encounter? */
    isBossEncounter?: boolean;
    /** Track 3c: boss loot rarity minimum */
    bossMinLootRarity?: 'rare' | 'epic';
  }) => {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
    unlockedBadges: string[];
    loot: LootItem | null;
    /** Track 3c: newly unlocked cross-subject achievements */
    unlockedAchievements: string[];
  };
  awardReviewPass: () => {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
    unlockedAchievements: string[];
  };
  /** Fisher's Rest: add a caught fish to the active subject's collection */
  addFish: (input: { name: string; rarity: FishEntry['rarity']; subjectId: string; subjectName: string }) => FishEntry;
  /** Fisher's Rest: award XP for correctly answering a fishing recall question */
  awardFishingXp: (rarity: FishRarity) => { xpGained: number; newRank: RankTier; rankChanged: boolean };
  /** Fisher's Rest: check and award any fishing badges based on current collection */
  checkFishingBadges: () => FishingBadgeId[];
  /** Track 3c: equip an equippable item */
  equipItem: (itemId: string) => boolean;
  /** Track 3c: unequip an item */
  unequipItem: (itemId: string) => boolean;
  /** Track 3c: compute bonuses from currently equipped items */
  getEquipBonuses: () => { qualityBonus: number; xpMultiplier: number; xpBonus: number; streakBonus: number };
  /** Track 3c: get cross-subject progress */
  getCrossSubjectProgress: () => CrossSubjectProgress;
  /** Track 3c: check for new cross-subject achievements */
  checkCrossSubjectAchievements: () => string[];
  resetStreak: () => void;
  reset: () => void;
}

const { bySubject: initialBySubject, crossSubjectAchievements: initialCrossSubjectAchs } = loadPersistedBySubject();
const initialActiveSubject = getActiveSubjectId();
const initialSubjectId =
  initialActiveSubject && initialActiveSubject.trim().length > 0
    ? initialActiveSubject
    : Object.keys(initialBySubject)[0] ?? null;
const initialSubjectProgression = getSubjectProgression(initialBySubject, initialSubjectId);

export const useProgressionStore = create<ProgressionStoreState>((set, get) => ({
  activeSubjectId: initialSubjectId,
  bySubject: initialBySubject,
  crossSubjectAchievements: initialCrossSubjectAchs,
  ...initialSubjectProgression,

  setActiveSubject(subjectId) {
    const normalizedSubjectId = subjectId && subjectId.trim().length > 0 ? subjectId : null;
    const state = get();
    if (normalizedSubjectId === null) {
      set({
        activeSubjectId: null,
        ...cloneDefaultSubjectProgression(),
      });
      return;
    }

    const current = state.bySubject[normalizedSubjectId] ?? cloneDefaultSubjectProgression();
    const bySubject = state.bySubject[normalizedSubjectId]
      ? state.bySubject
      : { ...state.bySubject, [normalizedSubjectId]: current };

    set({
      activeSubjectId: normalizedSubjectId,
      bySubject,
      ...current,
    });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
  },

  awardBadge(badgeId) {
    const normalized = badgeId.trim();
    if (normalized.length === 0) return false;
    const state = get();
    if (!state.activeSubjectId) return false;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    if (current.badges.includes(normalized)) return false;

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      badges: [...current.badges, normalized],
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return true;
  },

  collectArtifactNote(entry) {
    const state = get();
    if (!state.activeSubjectId) return false;
    if (entry.dungeonId !== state.activeSubjectId) return false;
    const normalizedRoom = entry.roomId.trim();
    const normalizedDungeon = entry.dungeonId.trim();
    if (normalizedRoom.length === 0 || normalizedDungeon.length === 0) return false;

    const noteId = `${normalizedDungeon}:${normalizedRoom}`;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    if (current.collectedNotes.some((note) => note.noteId === noteId)) return false;

    const collectedAt = new Date().toISOString();
    const nextEntry: CollectedNoteEntry = {
      ...entry,
      noteId,
      collectedAt,
    };

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      collectedNotes: [nextEntry, ...current.collectedNotes],
      artifacts: current.artifacts + 1,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    // Check cross-subject achievements
    const newAchs = get().checkCrossSubjectAchievements();
    if (newAchs.length > 0) {
      return true;
    }
    return true;
  },

  // ── Fisher's Rest: addFish ──────────────────────────

  addFish({ name, rarity, subjectId, subjectName }) {
    const state = get();
    if (!state.activeSubjectId) {
      // If no active subject, still return a valid entry but don't persist
      return {
        id: createFishId('unknown'),
        name,
        rarity,
        subjectId,
        subjectName,
        caughtAt: new Date().toISOString(),
      };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const entry: FishEntry = {
      id: createFishId(name.toLowerCase().replace(/\s+/g, '-')),
      name,
      rarity,
      subjectId,
      subjectName,
      caughtAt: new Date().toISOString(),
    };

    const updatedCollection = addFishToCollection(current.fishCollection, entry);
    const nextSubject: PersistedSubjectProgression = {
      ...current,
      fishCollection: updatedCollection,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return entry;
  },

  // ── Fisher's Rest: awardFishingXp ─────────────────

  awardFishingXp(rarity) {
    const state = get();
    if (!state.activeSubjectId) {
      return { xpGained: 0, newRank: 'Novice' as RankTier, rankChanged: false };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const multiplier = FISH_RARITY_XP_MULTIPLIER[rarity] ?? 1.0;
    const xpGained = Math.round(FSH_XP_PER_CORRECT_ANSWER * multiplier);
    const nextXp = current.xpTotal + xpGained;
    const nextRank = assignRankTier(nextXp);

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      xpTotal: nextXp,
      rank: nextRank,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    return {
      xpGained,
      newRank: nextRank,
      rankChanged: nextRank !== current.rank,
    };
  },

  // ── Fisher's Rest: checkFishingBadges ──────────────

  checkFishingBadges() {
    const state = get();
    if (!state.activeSubjectId) return [];

    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const collection: FishCollection = current.fishCollection;
    const totalFish = collection.length;
    const uniqueCount = countUniqueTypes(collection);
    const existingBadges = new Set(current.badges);
    const newlyAwarded: FishingBadgeId[] = [];

    for (const badgeId of FISHING_BADGE_IDS) {
      if (existingBadges.has(badgeId)) continue;

      const def = FISHING_BADGE_DEFS[badgeId];
      let earned = false;

      if (badgeId === 'FshFullCreel') {
        // -1 threshold means all unique fish types caught
        earned = uniqueCount >= FISH_CATALOG.length;
      } else {
        earned = totalFish >= def.threshold;
      }

      if (earned) {
        const awarded = get().awardBadge(badgeId);
        if (awarded) {
          newlyAwarded.push(badgeId);
        }
      }
    }

    return newlyAwarded;
  },

  awardRoomClear({
    qualityBonus,
    totalRooms,
    creatorMappedRooms,
    scribeClearedRooms,
    archaeologistFullReviewPasses,
    isBossEncounter = false,
    bossMinLootRarity,
  }) {
    const state = get();
    if (!state.activeSubjectId) {
      return {
        xpGained: 0,
        newRank: 'Novice' as RankTier,
        rankChanged: false,
        unlockedBadges: [] as string[],
        loot: null as LootItem | null,
        unlockedAchievements: [] as string[],
      };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);

    // Compute equip bonuses
    const equipBonuses = computeEquipBonuses(current.equippedItems ?? []);
    const effectiveQualityBonus = qualityBonus + equipBonuses.qualityBonus + current.streakCount;

    const nextStreak = current.streakCount + 1 + equipBonuses.streakBonus;
    const result = awardRoomClearProgression({
      currentXpTotal: current.xpTotal,
      existingBadges: current.badges,
      qualityBonus: effectiveQualityBonus,
      streakCount: nextStreak,
      badgeProgress: {
        totalRooms,
        creatorMappedRooms,
        scribeClearedRooms,
        archaeologistFullReviewPasses,
      },
    });

    if (!result.ok) {
      return {
        xpGained: 0,
        newRank: current.rank,
        rankChanged: false,
        unlockedBadges: [],
        loot: null,
        unlockedAchievements: [],
      };
    }

    const value = result.value;

    // Roll for equippable loot (preferred) or legacy loot
    let loot: LootItem | null = null;
    if (isBossEncounter || qualityBonus >= 4) {
      loot = rollEquippableLoot(qualityBonus, bossMinLootRarity);
    }
    if (!loot) {
      loot = rollLoot(qualityBonus);
    }

    const inventory = loot ? [...current.inventory, loot] : current.inventory;
    const roomsCleared = current.roomsCleared + 1;
    const bossesDefeated = isBossEncounter ? current.bossesDefeated + 1 : current.bossesDefeated;

    const nextSubject: PersistedSubjectProgression = {
      xpTotal: value.xpTotalAfter,
      rank: value.rankAfter,
      badges: value.progressionSnapshot.badges,
      inventory,
      equippedItems: current.equippedItems ?? [],
      collectedNotes: current.collectedNotes,
      streakCount: nextStreak,
      subjectsMastered: current.subjectsMastered,
      roomsCleared,
      reviewPasses: current.reviewPasses,
      artifacts: current.artifacts,
      bossesDefeated,
      fishCollection: current.fishCollection,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    // Check cross-subject achievements
    const unlockedAchievements = get().checkCrossSubjectAchievements();

    return {
      xpGained: value.xpBreakdown.totalDelta,
      newRank: value.rankAfter,
      rankChanged: value.rankBefore !== value.rankAfter,
      unlockedBadges: value.unlockedBadges,
      loot,
      unlockedAchievements,
    };
  },

  awardReviewPass() {
    const state = get();
    if (!state.activeSubjectId) {
      return {
        xpGained: 0,
        newRank: 'Novice' as RankTier,
        rankChanged: false,
        unlockedAchievements: [] as string[],
      };
    }

    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const equipBonuses = computeEquipBonuses(current.equippedItems ?? []);
    const xpEarned = REVIEW_PASS_XP + equipBonuses.xpBonus;
    const nextXp = current.xpTotal + xpEarned;
    const nextRank = assignRankTier(nextXp);
    const nextSubject: PersistedSubjectProgression = {
      ...current,
      xpTotal: nextXp,
      rank: nextRank,
      reviewPasses: current.reviewPasses + 1,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);

    const unlockedAchievements = get().checkCrossSubjectAchievements();

    return {
      xpGained: xpEarned,
      newRank: nextRank,
      rankChanged: nextRank !== current.rank,
      unlockedAchievements,
    };
  },

  // ── Phase 3c: Equippable loot methods ──────────────────────

  equipItem(itemId) {
    const state = get();
    if (!state.activeSubjectId) return false;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const item = current.inventory.find((i) => i.id === itemId);
    if (!item || !('equipSlot' in item)) return false;

    const equippable = item as EquippableLootItem;
    if (equippable.equipped) return false;

    // Unequip any item in the same slot
    const updatedEquipped = current.equippedItems
      ?.filter((e) => e.equipSlot !== equippable.equipSlot) ?? [];

    updatedEquipped.push({ ...equippable, equipped: true });

    // Mark item as equipped in inventory
    const updatedInventory = current.inventory.map((i) =>
      i.id === itemId ? { ...i, equipped: true } as EquippableLootItem : i,
    );

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      inventory: updatedInventory,
      equippedItems: updatedEquipped,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return true;
  },

  unequipItem(itemId) {
    const state = get();
    if (!state.activeSubjectId) return false;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const updatedEquipped = current.equippedItems?.filter((e) => e.id !== itemId) ?? [];

    const updatedInventory = current.inventory.map((i) =>
      i.id === itemId ? { ...i, equipped: false } as EquippableLootItem : i,
    );

    const nextSubject: PersistedSubjectProgression = {
      ...current,
      inventory: updatedInventory,
      equippedItems: updatedEquipped,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    return true;
  },

  getEquipBonuses() {
    const state = get();
    if (!state.activeSubjectId) return { qualityBonus: 0, xpMultiplier: 1, xpBonus: 0, streakBonus: 0 };
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    return computeEquipBonuses(current.equippedItems ?? []);
  },

  getCrossSubjectProgress() {
    const state = get();
    return computeCrossSubjectProgress({
      bySubject: state.bySubject,
      totalSubjectsCreated: Object.keys(state.bySubject).length,
    });
  },

  checkCrossSubjectAchievements() {
    const state = get();
    const progress = state.getCrossSubjectProgress();
    const newlyUnlocked = evaluateAchievementUnlocks(progress, state.crossSubjectAchievements);

    if (newlyUnlocked.length > 0) {
      const updatedAchs = [
        ...state.crossSubjectAchievements,
        ...newlyUnlocked.map((a) => a.id),
      ];
      set({ crossSubjectAchievements: updatedAchs });
      savePersistedBySubject(state.bySubject, updatedAchs);
      return newlyUnlocked.map((a) => a.id);
    }
    return [];
  },

  resetStreak: () => {
    const state = get();
    if (!state.activeSubjectId) return;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const nextSubject = { ...current, streakCount: 0 };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
  },

  reset: () => {
    const state = get();
    if (!state.activeSubjectId) {
      savePersistedBySubject({}, state.crossSubjectAchievements);
      set({
        bySubject: {},
        ...cloneDefaultSubjectProgression(),
      });
      return;
    }

    const bySubject = {
      ...state.bySubject,
      [state.activeSubjectId]: cloneDefaultSubjectProgression(),
    };
    const resetSubject = bySubject[state.activeSubjectId] ?? cloneDefaultSubjectProgression();
    savePersistedBySubject(bySubject, state.crossSubjectAchievements);
    set({ bySubject, ...resetSubject });
  },
}));

function rollLoot(qualityBonus: number): LootItem | null {
  if (qualityBonus < 4) return null;
  const pool = qualityBonus >= 8 ? LOOT_POOL : LOOT_POOL.filter((l) => l.rarity !== 'epic');
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return {
    id: `loot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: pick.name,
    description: pick.description,
    rarity: pick.rarity,
    acquiredAt: new Date().toISOString(),
  };
}
