/**
 * Progression store — XP, rank, badges, inventory. Persists to localStorage
 * mirroring repo-dungeon's progression-store wiring.
 */
import { create } from 'zustand';
import {
  assignRankTier,
  awardRoomClearProgression,
  type RankTier,
} from '@/core/progression';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';

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
  artifactMarkdown: string;
  collectedAt: string;
}

interface PersistedProgression {
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: LootItem[];
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
}

const DEFAULT_PROGRESSION: PersistedProgression = {
  xpTotal: 0,
  rank: 'Novice',
  badges: [],
  inventory: [],
  collectedNotes: [],
  streakCount: 0,
};

function loadPersisted(): PersistedProgression {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PROGRESSION;
    const raw = localStorage.getItem(STORAGE_KEYS.progression);
    if (!raw) return DEFAULT_PROGRESSION;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_PROGRESSION;
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const collectedNotes = Array.isArray(parsedRecord.collectedNotes)
      ? parsedRecord.collectedNotes
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map((entry) => ({
            noteId: typeof entry.noteId === 'string' ? entry.noteId : '',
            dungeonId: typeof entry.dungeonId === 'string' ? entry.dungeonId : '',
            roomId: typeof entry.roomId === 'string' ? entry.roomId : '',
            topic: typeof entry.topic === 'string' ? entry.topic : 'Collected note',
            floorLabel: typeof entry.floorLabel === 'string' ? entry.floorLabel : 'Unknown floor',
            artifactPreview: typeof entry.artifactPreview === 'string' ? entry.artifactPreview : '',
            artifactMarkdown:
              typeof entry.artifactMarkdown === 'string'
                ? entry.artifactMarkdown
                : typeof entry.artifactPreview === 'string'
                  ? entry.artifactPreview
                  : 'Artifact note collected.',
            collectedAt: typeof entry.collectedAt === 'string' ? entry.collectedAt : new Date(0).toISOString(),
          }))
          .filter((entry) => entry.noteId.length > 0)
      : [];

    const xpTotal = typeof parsedRecord.xpTotal === 'number' ? parsedRecord.xpTotal : 0;

    return {
      xpTotal,
      rank: assignRankTier(xpTotal),
      badges: Array.isArray(parsedRecord.badges)
        ? parsedRecord.badges.filter((badge): badge is string => typeof badge === 'string')
        : [],
      inventory: Array.isArray(parsedRecord.inventory) ? (parsedRecord.inventory as LootItem[]) : [],
      collectedNotes,
      streakCount: typeof parsedRecord.streakCount === 'number' ? parsedRecord.streakCount : 0,
    };
  } catch {
    return DEFAULT_PROGRESSION;
  }
}

function savePersisted(state: PersistedProgression): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.progression, JSON.stringify(state));
    }
  } catch {
    /* ignore */
  }
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
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: LootItem[];
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
  awardBadge: (badgeId: string) => boolean;
  collectArtifactNote: (entry: Omit<CollectedNoteEntry, 'noteId' | 'collectedAt'>) => boolean;
  awardRoomClear: (input: {
    qualityBonus: number;
    totalRooms: number;
    creatorMappedRooms: number;
    scribeClearedRooms: number;
    archaeologistFullReviewPasses: number;
  }) => {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
    unlockedBadges: string[];
    loot: LootItem | null;
  };
  resetStreak: () => void;
  reset: () => void;
}

export const useProgressionStore = create<ProgressionStoreState>((set, get) => ({
  ...loadPersisted(),

  awardBadge(badgeId) {
    const normalized = badgeId.trim();
    if (normalized.length === 0) return false;
    const state = get();
    if (state.badges.includes(normalized)) return false;

    const next: PersistedProgression = {
      xpTotal: state.xpTotal,
      rank: state.rank,
      badges: [...state.badges, normalized],
      inventory: state.inventory,
      collectedNotes: state.collectedNotes,
      streakCount: state.streakCount,
    };
    set(next);
    savePersisted(next);
    return true;
  },

  collectArtifactNote(entry) {
    const state = get();
    const normalizedRoom = entry.roomId.trim();
    const normalizedDungeon = entry.dungeonId.trim();
    if (normalizedRoom.length === 0 || normalizedDungeon.length === 0) return false;

    const noteId = `${normalizedDungeon}:${normalizedRoom}`;
    if (state.collectedNotes.some((note) => note.noteId === noteId)) return false;

    const collectedAt = new Date().toISOString();
    const nextEntry: CollectedNoteEntry = {
      ...entry,
      noteId,
      collectedAt,
    };

    const next: PersistedProgression = {
      xpTotal: state.xpTotal,
      rank: state.rank,
      badges: state.badges,
      inventory: state.inventory,
      collectedNotes: [nextEntry, ...state.collectedNotes],
      streakCount: state.streakCount,
    };
    set(next);
    savePersisted(next);
    return true;
  },

  awardRoomClear({
    qualityBonus,
    totalRooms,
    creatorMappedRooms,
    scribeClearedRooms,
    archaeologistFullReviewPasses,
  }) {
    const { xpTotal, badges, streakCount, rank } = get();
    const nextStreak = streakCount + 1;
    const result = awardRoomClearProgression({
      currentXpTotal: xpTotal,
      existingBadges: badges,
      qualityBonus,
      streakCount: nextStreak,
      badgeProgress: {
        totalRooms,
        creatorMappedRooms,
        scribeClearedRooms,
        archaeologistFullReviewPasses,
      },
    });

    if (!result.ok) {
      return { xpGained: 0, newRank: rank, rankChanged: false, unlockedBadges: [], loot: null };
    }

    const value = result.value;
    const loot = rollLoot(qualityBonus);
    const inventory = loot ? [...get().inventory, loot] : get().inventory;

    const next: PersistedProgression = {
      xpTotal: value.xpTotalAfter,
      rank: value.rankAfter,
      badges: value.progressionSnapshot.badges,
      inventory,
      collectedNotes: get().collectedNotes,
      streakCount: nextStreak,
    };
    set(next);
    savePersisted(next);

    return {
      xpGained: value.xpBreakdown.totalDelta,
      newRank: value.rankAfter,
      rankChanged: value.rankBefore !== value.rankAfter,
      unlockedBadges: value.unlockedBadges,
      loot,
    };
  },

  resetStreak: () => set({ streakCount: 0 }),

  reset: () => {
    savePersisted(DEFAULT_PROGRESSION);
    set(DEFAULT_PROGRESSION);
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
