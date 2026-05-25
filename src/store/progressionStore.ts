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

interface PersistedProgression {
  xpTotal: number;
  rank: RankTier;
  badges: string[];
  inventory: LootItem[];
  streakCount: number;
}

const DEFAULT_PROGRESSION: PersistedProgression = {
  xpTotal: 0,
  rank: 'Novice',
  badges: [],
  inventory: [],
  streakCount: 0,
};

function loadPersisted(): PersistedProgression {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PROGRESSION;
    const raw = localStorage.getItem(STORAGE_KEYS.progression);
    if (!raw) return DEFAULT_PROGRESSION;
    const parsed = JSON.parse(raw) as PersistedProgression;
    return {
      xpTotal: typeof parsed.xpTotal === 'number' ? parsed.xpTotal : 0,
      rank: assignRankTier(parsed.xpTotal ?? 0),
      badges: Array.isArray(parsed.badges) ? parsed.badges : [],
      inventory: Array.isArray(parsed.inventory) ? parsed.inventory : [],
      streakCount: typeof parsed.streakCount === 'number' ? parsed.streakCount : 0,
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
  streakCount: number;
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
