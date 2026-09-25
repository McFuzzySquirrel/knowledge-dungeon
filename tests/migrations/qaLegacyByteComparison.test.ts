/**
 * INDEPENDENT QA gate: no default behavior change on the live legacy key.
 *
 * The exact strings below were produced by running the SAME scenario in a clean
 * `git worktree` of the pre-phase HEAD (5345493) and in the phase worktree, and
 * diffing the two outputs. See the phase evidence for the two artefacts.
 *
 * Three cases are byte-identical to the pre-phase build. Two differ, in exactly
 * one documented way: unknown app-owned fields are now PRESERVED instead of
 * being dropped on rewrite. That is a deliberate, tested change to the live
 * `knowledge-dungeon:v1:progression` write path, recorded here so it cannot be
 * discovered later as a surprise.
 *
 * All values are synthetic. `Math.random` and the clock are pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
const ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';

type ProgressionStoreModule = typeof import('@/store/progressionStore');

async function loadStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  return import('@/store/progressionStore');
}

function raw(): string {
  const value = window.localStorage.getItem(PROGRESSION_KEY);
  if (value === null) throw new Error('the store wrote nothing to the progression key');
  return value;
}

/** Byte-identical to the pre-phase HEAD build. */
const HEAD_FRESH_SUBJECT =
  '{"version":3,"bySubject":{"subject-qa-fresh":{"xpTotal":0,"rank":"Novice","badges":[],"inventory":[],"equippedItems":[],"collectedNotes":[],"streakCount":0,"subjectsMastered":0,"roomsCleared":0,"reviewPasses":0,"artifacts":0,"bossesDefeated":0,"fishCollection":[]}},"crossSubjectAchievements":[]}';

const HEAD_ROOM_CLEAR = "{\"version\":3,\"bySubject\":{\"subject-qa-roomclear\":{\"xpTotal\":26,\"rank\":\"Novice\",\"badges\":[\"CreatorPhaseComplete\"],\"inventory\":[{\"id\":\"gear-mufil8k5-4fzz\",\"name\":\"Scholar's Cap\",\"description\":\"A velvet cap that sharpens the mind. +1 quality bonus on note submissions.\",\"rarity\":\"common\",\"acquiredAt\":\"2026-09-24T12:34:56.789Z\",\"equipSlot\":\"head\",\"qualityBonus\":1,\"equipped\":false}],\"equippedItems\":[],\"collectedNotes\":[],\"streakCount\":1,\"subjectsMastered\":0,\"roomsCleared\":1,\"reviewPasses\":0,\"artifacts\":0,\"bossesDefeated\":0,\"fishCollection\":[]}},\"crossSubjectAchievements\":[]}";

const V1_FLAT = JSON.stringify({
  xpTotal: 315,
  rank: 'Novice',
  badges: ['synthetic-v1-badge', 7, null],
  inventory: [
    { id: 'loot-v1-synthetic', name: 'Synthetic Legacy Relic', description: 'synthetic', rarity: 'rare', acquiredAt: '2026-02-01T03:04:05.000Z' },
    { name: 'Synthetic Item Without Identifier', description: 'synthetic', rarity: 'mystery' },
  ],
  collectedNotes: [
    { noteId: 'subject-v1:room-v1-root', dungeonId: 'subject-v1', roomId: 'room-v1-root', topic: 'Synthetic V1 Topic', floorLabel: 'Synthetic Floor', artifactPreview: 'Synthetic preview', noteMarkdown: 'Synthetic note', artifactMarkdown: 'Synthetic artifact', collectedAt: '2026-02-01T04:00:00.000Z' },
  ],
  fishCollection: [
    { id: 'moss-carp:v1-1', name: 'Moss Carp', rarity: 'common', subjectId: 'subject-v1', subjectName: 'Synthetic V1 Subject', caughtAt: '2026-02-01T05:00:00.000Z' },
  ],
  legacyOnlyField: 'synthetic-legacy-only',
});

const V3_WITH_UNKNOWN = JSON.stringify({
  version: 3,
  bySubject: {
    'subject-qa-unknown': {
      xpTotal: 320,
      rank: 'Stale Rank',
      badges: ['synthetic-badge'],
      inventory: [],
      equippedItems: [],
      collectedNotes: [],
      streakCount: 0,
      subjectsMastered: 0,
      roomsCleared: 1,
      reviewPasses: 0,
      artifacts: 0,
      bossesDefeated: 0,
      fishCollection: [],
      qaUnknownField: { marker: 'synthetic-unknown-field' },
      anotherUnknown: 42,
    },
  },
  crossSubjectAchievements: ['meta-subjects-5'],
});

describe('QA no default behavior change: legacy progression key vs pre-phase HEAD', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:34:56.789Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('case 1 - a fresh subject writes the pre-phase bytes exactly', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-fresh');
    expect(raw()).toBe(HEAD_FRESH_SUBJECT);
  });

  it('case 5 - a room clear writes the pre-phase bytes exactly', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-roomclear');
    useProgressionStore.getState().awardRoomClear({
      qualityBonus: 5,
      totalRooms: 2,
      creatorMappedRooms: 2,
      scribeClearedRooms: 1,
      archaeologistFullReviewPasses: 0,
    });
    expect(raw()).toBe(HEAD_ROOM_CLEAR);
  });

  it('case 4 - a v2 payload is left untouched until a write happens', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V3_WITH_UNKNOWN.replace('"version":3', '"version":2').replace('subject-qa-unknown', 'subject-qa-v2').replace('subject-qa-unknown', 'subject-qa-v2'));
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-v2');
    const before = raw();
    await loadStore();
    // Hydration alone must not rewrite the key.
    expect(raw()).toBe(before);
    expect(JSON.parse(before).version).toBe(2);
    // The in-memory state matches what the pre-phase build produced.
    const { useProgressionStore } = await import('@/store/progressionStore');
    expect(useProgressionStore.getState().xpTotal).toBe(320);
    expect(useProgressionStore.getState().rank).toBe('Scholar');
  });

  it('case 2 - a v1 flat payload differs ONLY by the preserved unknown field', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V1_FLAT);
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-v1');
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-v1');
    useProgressionStore.getState().awardBadge('synthetic-v1-written-badge');

    const written = JSON.parse(raw()) as {
      version: number;
      bySubject: Record<string, Record<string, unknown>>;
      crossSubjectAchievements: string[];
    };
    const record = written.bySubject['subject-qa-v1']!;

    // Everything the pre-phase build wrote is present, in the pre-phase order.
    const PRE_PHASE_KEYS = [
      'xpTotal', 'rank', 'badges', 'inventory', 'equippedItems', 'collectedNotes',
      'streakCount', 'subjectsMastered', 'roomsCleared', 'reviewPasses', 'artifacts',
      'bossesDefeated', 'fishCollection',
    ];
    expect(Object.keys(record).slice(0, PRE_PHASE_KEYS.length)).toEqual(PRE_PHASE_KEYS);
    // The ONLY difference: the unknown envelope field survives.
    expect(Object.keys(record).slice(PRE_PHASE_KEYS.length)).toEqual(['legacyOnlyField']);
    expect(record.legacyOnlyField).toBe('synthetic-legacy-only');
    // Nothing canonical-only leaked onto the legacy key.
    expect(record).not.toHaveProperty('subjectId');
    expect(record).not.toHaveProperty('extraFields');
    expect(Object.keys(written).sort()).toEqual(['bySubject', 'crossSubjectAchievements', 'version']);
    expect(written.version).toBe(3);
  });

  it('case 3 - a v3 payload with unknown fields differs ONLY by their preservation', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V3_WITH_UNKNOWN);
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-unknown');
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-unknown');
    useProgressionStore.getState().awardBadge('synthetic-second-badge');

    const written = JSON.parse(raw()) as {
      bySubject: Record<string, Record<string, unknown>>;
      crossSubjectAchievements: string[];
    };
    const record = written.bySubject['subject-qa-unknown']!;
    const PRE_PHASE_KEYS = [
      'xpTotal', 'rank', 'badges', 'inventory', 'equippedItems', 'collectedNotes',
      'streakCount', 'subjectsMastered', 'roomsCleared', 'reviewPasses', 'artifacts',
      'bossesDefeated', 'fishCollection',
    ];
    expect(Object.keys(record).slice(0, PRE_PHASE_KEYS.length)).toEqual(PRE_PHASE_KEYS);
    expect(Object.keys(record).slice(PRE_PHASE_KEYS.length)).toEqual(['qaUnknownField', 'anotherUnknown']);
    expect(record.qaUnknownField).toEqual({ marker: 'synthetic-unknown-field' });
    expect(record.anotherUnknown).toBe(42);
    expect(written.crossSubjectAchievements).toEqual(['meta-subjects-5']);
    // The pre-phase build dropped both; the phase build keeps them. The exact
    // pre-phase string is reproduced here so the difference is the whole story.
    expect(raw()).not.toBe(
      '{"version":3,"bySubject":{"subject-qa-unknown":{"xpTotal":320,"rank":"Scholar","badges":["synthetic-badge","synthetic-second-badge"],"inventory":[],"equippedItems":[],"collectedNotes":[],"streakCount":0,"subjectsMastered":0,"roomsCleared":1,"reviewPasses":0,"artifacts":0,"bossesDefeated":0,"fishCollection":[]}},"crossSubjectAchievements":["meta-subjects-5"]}',
    );
  });

  it('the storage-v2 serializer stays off the legacy key', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V3_WITH_UNKNOWN);
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-unknown');
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-unknown');
    useProgressionStore.getState().awardBadge('synthetic-second-badge');
    const written = raw();
    for (const canonicalOnly of ['"kind"', '"sourceVersion"', '"activeSubjectId"', '"legacyBucketSubjectId"']) {
      expect(written, canonicalOnly).not.toContain(canonicalOnly);
    }
  });
});
