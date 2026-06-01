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
import { STORAGE_KEYS, getActiveSubjectId } from '@/services/persistence/subjectPersistence';

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
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
}

const REVIEW_PASS_XP = 6;

interface PersistedProgressionV2 {
  version: 2;
  bySubject: Record<string, PersistedSubjectProgression>;
}

function cloneDefaultSubjectProgression(): PersistedSubjectProgression {
  return {
    xpTotal: 0,
    rank: 'Novice',
    badges: [],
    inventory: [],
    collectedNotes: [],
    streakCount: 0,
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
    collectedNotes: normalizeCollectedNotes(record.collectedNotes),
    streakCount: typeof record.streakCount === 'number' ? Math.max(0, Math.trunc(record.streakCount)) : 0,
  };
}

function notesForSubject(notes: readonly CollectedNoteEntry[], subjectId: string): CollectedNoteEntry[] {
  return notes.filter((note) => note.dungeonId === subjectId);
}

function loadPersistedBySubject(): Record<string, PersistedSubjectProgression> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEYS.progression);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const parsedRecord = parsed as Record<string, unknown>;

    if (parsedRecord.version === 2 && typeof parsedRecord.bySubject === 'object' && parsedRecord.bySubject !== null) {
      const bySubjectRecord = parsedRecord.bySubject as Record<string, unknown>;
      const normalized: Record<string, PersistedSubjectProgression> = {};
      for (const [subjectId, subjectProgression] of Object.entries(bySubjectRecord)) {
        normalized[subjectId] = normalizeSubjectProgression(subjectProgression);
      }
      return normalized;
    }

    const legacy = normalizeSubjectProgression(parsedRecord);
    const activeSubjectId = getActiveSubjectId();
    const subjectId = activeSubjectId && activeSubjectId.trim().length > 0 ? activeSubjectId : '__legacy__';
    return { [subjectId]: legacy };
  } catch {
    return {};
  }
}

function savePersistedBySubject(bySubject: Record<string, PersistedSubjectProgression>): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const payload: PersistedProgressionV2 = {
        version: 2,
        bySubject,
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
  collectedNotes: CollectedNoteEntry[];
  streakCount: number;
  setActiveSubject: (subjectId: string | null) => void;
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
  awardReviewPass: () => {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
  };
  resetStreak: () => void;
  reset: () => void;
}

const initialBySubject = loadPersistedBySubject();
const initialActiveSubject = getActiveSubjectId();
const initialSubjectId =
  initialActiveSubject && initialActiveSubject.trim().length > 0
    ? initialActiveSubject
    : Object.keys(initialBySubject)[0] ?? null;
const initialSubjectProgression = getSubjectProgression(initialBySubject, initialSubjectId);

export const useProgressionStore = create<ProgressionStoreState>((set, get) => ({
  activeSubjectId: initialSubjectId,
  bySubject: initialBySubject,
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
    savePersistedBySubject(bySubject);
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
    savePersistedBySubject(bySubject);
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
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject);
    return true;
  },

  awardRoomClear({
    qualityBonus,
    totalRooms,
    creatorMappedRooms,
    scribeClearedRooms,
    archaeologistFullReviewPasses,
  }) {
    const state = get();
    if (!state.activeSubjectId) {
      return {
        xpGained: 0,
        newRank: 'Novice' as RankTier,
        rankChanged: false,
        unlockedBadges: [],
        loot: null,
      };
    }
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const nextStreak = current.streakCount + 1;
    const result = awardRoomClearProgression({
      currentXpTotal: current.xpTotal,
      existingBadges: current.badges,
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
      return {
        xpGained: 0,
        newRank: current.rank,
        rankChanged: false,
        unlockedBadges: [],
        loot: null,
      };
    }

    const value = result.value;
    const loot = rollLoot(qualityBonus);
    const inventory = loot ? [...current.inventory, loot] : current.inventory;

    const nextSubject: PersistedSubjectProgression = {
      xpTotal: value.xpTotalAfter,
      rank: value.rankAfter,
      badges: value.progressionSnapshot.badges,
      inventory,
      collectedNotes: current.collectedNotes,
      streakCount: nextStreak,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject);

    return {
      xpGained: value.xpBreakdown.totalDelta,
      newRank: value.rankAfter,
      rankChanged: value.rankBefore !== value.rankAfter,
      unlockedBadges: value.unlockedBadges,
      loot,
    };
  },

  awardReviewPass() {
    const state = get();
    if (!state.activeSubjectId) {
      return {
        xpGained: 0,
        newRank: 'Novice' as RankTier,
        rankChanged: false,
      };
    }

    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const nextXp = current.xpTotal + REVIEW_PASS_XP;
    const nextRank = assignRankTier(nextXp);
    const nextSubject: PersistedSubjectProgression = {
      ...current,
      xpTotal: nextXp,
      rank: nextRank,
    };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject);

    return {
      xpGained: REVIEW_PASS_XP,
      newRank: nextRank,
      rankChanged: nextRank !== current.rank,
    };
  },

  resetStreak: () => {
    const state = get();
    if (!state.activeSubjectId) return;
    const current = getSubjectProgression(state.bySubject, state.activeSubjectId);
    const nextSubject = { ...current, streakCount: 0 };
    const bySubject = { ...state.bySubject, [state.activeSubjectId]: nextSubject };
    set({ bySubject, ...nextSubject });
    savePersistedBySubject(bySubject);
  },

  reset: () => {
    const state = get();
    if (!state.activeSubjectId) {
      savePersistedBySubject({});
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
    savePersistedBySubject(bySubject);
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
