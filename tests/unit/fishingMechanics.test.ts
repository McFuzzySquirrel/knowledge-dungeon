import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSeededRng,
  rollFishRarity,
  pullRecallQuestion,
  getClearedRooms,
} from '@/game/systems/fishingMechanics';
import type { RoomMetadata, DungeonRoomSummary } from '@/core/validation/persistence';

function makeRoomMeta(overrides: Partial<RoomMetadata> = {}): RoomMetadata {
  return {
    roomId: 'room-1',
    topic: 'Vector Spaces',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    state: 'EncounterDefeated',
    notePath: 'rooms/room-1/notes.md',
    artifactPath: 'rooms/room-1/artifact.md',
    noteText: '',
    artifactMarkdown: null,
    validationState: {
      wordCount: 120,
      requiredSectionsPresent: true,
      manualConfirmed: true,
      criterionScores: {
        sectionCompleteness: 80,
        conceptTermCoverage: 75,
        linkReferences: 70,
        recallQuestionQuality: 85,
        clarityReadability: 80,
      },
      failedChecks: [],
      qualityBonus: 4,
      finalPass: true,
    },
    reviewPassCount: 1,
    attachments: [],
    ...overrides,
  };
}

function makeDungeonRoomSummary(overrides: Partial<DungeonRoomSummary> = {}): DungeonRoomSummary {
  return {
    roomId: 'room-1',
    topic: 'Vector Spaces',
    status: 'EncounterDefeated',
    ...overrides,
  };
}

// ── rollFishRarity ──────────────────────────────────────────────────

describe('rollFishRarity', () => {
  it('returns common when random is 0', () => {
    // random=0 → roll=0 → <=65 → common
    const firstCallReturns = vi.fn<() => number>()
      .mockReturnValueOnce(0) // rarity roll
      .mockReturnValueOnce(0); // fish pick from candidates
    const result = rollFishRarity(firstCallReturns);
    expect(result.rarity).toBe('common');
  });

  it('returns common at the top of the common range (0.65)', () => {
    const rng = vi.fn<() => number>()
      .mockReturnValueOnce(0.65) // roll=65 → <=65 → common
      .mockReturnValueOnce(0);
    const result = rollFishRarity(rng);
    expect(result.rarity).toBe('common');
  });

  it('returns rare just above the common boundary (0.6501)', () => {
    const rng = vi.fn<() => number>()
      .mockReturnValueOnce(0.6501) // roll=65.01 → >65, next cumulative is 93 → rare
      .mockReturnValueOnce(0);
    const result = rollFishRarity(rng);
    expect(result.rarity).toBe('rare');
  });

  it('returns rare at the top of the rare range (0.93)', () => {
    const rng = vi.fn<() => number>()
      .mockReturnValueOnce(0.93) // roll=93 → <=93 → rare
      .mockReturnValueOnce(0);
    const result = rollFishRarity(rng);
    expect(result.rarity).toBe('rare');
  });

  it('returns epic just above the rare boundary (0.9301)', () => {
    const rng = vi.fn<() => number>()
      .mockReturnValueOnce(0.9301) // roll=93.01 → >93, next cumulative is 100 → epic
      .mockReturnValueOnce(0);
    const result = rollFishRarity(rng);
    expect(result.rarity).toBe('epic');
  });

  it('returns epic at 0.99', () => {
    const rng = vi.fn<() => number>()
      .mockReturnValueOnce(0.99) // roll=99 → >93, <=100 → epic
      .mockReturnValueOnce(0);
    const result = rollFishRarity(rng);
    expect(result.rarity).toBe('epic');
  });

  it('uses Math.random by default (no argument)', () => {
    // Just verify it doesn't throw and returns a valid shape
    const result = rollFishRarity();
    expect(result.rarity).toMatch(/^(common|rare|epic)$/);
    expect(result.entry).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        rarity: result.rarity,
        description: expect.any(String),
        sprite: expect.any(String),
      }),
    );
  });

  it('works with a seeded RNG and returns deterministic results', () => {
    const rng1 = createSeededRng(42);
    const rng2 = createSeededRng(42);

    const result1 = rollFishRarity(() => rng1());
    const result2 = rollFishRarity(() => rng2());
    expect(result1).toEqual(result2);
  });

  it('selects a fish entry matching the rolled rarity', () => {
    const rng = vi.fn<() => number>()
      .mockReturnValueOnce(0.5) // common
      .mockReturnValueOnce(0); // first common candidate
    const result = rollFishRarity(rng);
    expect(result.rarity).toBe('common');
    expect(result.entry.rarity).toBe('common');
  });
});

// ── createSeededRng ─────────────────────────────────────────────────

describe('createSeededRng', () => {
  it('same seed produces the same sequence of values', () => {
    const rng1 = createSeededRng(12345);
    const rng2 = createSeededRng(12345);

    for (let i = 0; i < 20; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('different seeds produce different values', () => {
    const rng1 = createSeededRng(111);
    const rng2 = createSeededRng(222);

    // At least one value should differ in the first 10 calls
    let anyDiff = false;
    for (let i = 0; i < 10; i++) {
      if (rng1() !== rng2()) {
        anyDiff = true;
        break;
      }
    }
    expect(anyDiff).toBe(true);
  });

  it('values are between 0 (inclusive) and 1 (exclusive)', () => {
    const rng = createSeededRng(42);
    for (let i = 0; i < 200; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces a reasonably uniform distribution', () => {
    const rng = createSeededRng(7);
    const buckets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 10 buckets
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const value = rng();
      const bucketIdx = Math.min(Math.floor(value * 10), 9);
      buckets[bucketIdx]++;
    }
    // Each bucket should have roughly N/10 = 100 values. With mulberry32,
    // the distribution should be fairly even. We check that no bucket is
    // completely empty.
    for (let i = 0; i < buckets.length; i++) {
      expect(buckets[i], `bucket ${i}`).toBeGreaterThan(0);
    }
  });
});

// ── getClearedRooms ─────────────────────────────────────────────────

describe('getClearedRooms', () => {
  it('filters out rooms that are not in a reviewable state', () => {
    const rooms: Record<string, RoomMetadata> = {
      'room-1': makeRoomMeta({ roomId: 'room-1', state: 'Created', validationState: { ...makeRoomMeta().validationState, finalPass: true } }),
      'room-2': makeRoomMeta({ roomId: 'room-2', state: 'EncounterDefeated', validationState: { ...makeRoomMeta().validationState, finalPass: true } }),
    };
    const cleared = getClearedRooms(rooms);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].roomId).toBe('room-2');
  });

  it('filters out rooms where finalPass is false', () => {
    const rooms: Record<string, RoomMetadata> = {
      'room-1': makeRoomMeta({ roomId: 'room-1', state: 'EncounterDefeated', validationState: { ...makeRoomMeta().validationState, finalPass: false } }),
      'room-2': makeRoomMeta({ roomId: 'room-2', state: 'EncounterDefeated', validationState: { ...makeRoomMeta().validationState, finalPass: true } }),
    };
    const cleared = getClearedRooms(rooms);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].roomId).toBe('room-2');
  });

  it('returns empty array when no rooms are cleared', () => {
    const rooms: Record<string, RoomMetadata> = {
      'room-1': makeRoomMeta({ roomId: 'room-1', state: 'Created', validationState: { ...makeRoomMeta().validationState, finalPass: false } }),
    };
    expect(getClearedRooms(rooms)).toEqual([]);
  });

  it('returns empty array for empty rooms record', () => {
    expect(getClearedRooms({})).toEqual([]);
  });

  it('includes rooms in ArtifactCollected state', () => {
    const rooms: Record<string, RoomMetadata> = {
      'room-1': makeRoomMeta({ roomId: 'room-1', state: 'ArtifactCollected', validationState: { ...makeRoomMeta().validationState, finalPass: true } }),
    };
    expect(getClearedRooms(rooms)).toHaveLength(1);
  });

  it('includes rooms in NeedsRevalidation state', () => {
    const rooms: Record<string, RoomMetadata> = {
      'room-1': makeRoomMeta({ roomId: 'room-1', state: 'NeedsRevalidation', validationState: { ...makeRoomMeta().validationState, finalPass: true } }),
    };
    expect(getClearedRooms(rooms)).toHaveLength(1);
  });
});

// ── pullRecallQuestion ──────────────────────────────────────────────

describe('pullRecallQuestion', () => {
  let mockRandom: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset Math.random so each call to pullRecallQuestion returns
    // deterministic results during tests.
    mockRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    mockRandom.mockRestore();
  });

  it('returns null when clearedRooms is empty', () => {
    const result = pullRecallQuestion({
      clearedRooms: [],
      dungeonRooms: [makeDungeonRoomSummary()],
      subjectName: 'Math',
    });
    expect(result).toBeNull();
  });

  it('returns a prompt when rooms have note text with headings', () => {
    const room = makeRoomMeta({
      roomId: 'room-1',
      topic: 'Vector Spaces',
      noteText: '## Summary\nA summary.\n## Key Points\n- Point 1\n## Recall Question\nWhat is a vector space?',
    });
    const result = pullRecallQuestion({
      clearedRooms: [room],
      dungeonRooms: [makeDungeonRoomSummary({ roomId: 'room-1', topic: 'Vector Spaces' })],
      subjectName: 'Linear Algebra',
    });
    expect(result).not.toBeNull();
    expect(result!.prompt.text.length).toBeGreaterThan(0);
    expect(result!.roomId).toBe('room-1');
  });

  it('returns a prompt when rooms have flat note text (no headings)', () => {
    const room = makeRoomMeta({
      roomId: 'room-1',
      topic: 'Linear Transformations',
      noteText: 'Some notes about linear transformations without any markdown headings.',
    });
    const result = pullRecallQuestion({
      clearedRooms: [room],
      dungeonRooms: [makeDungeonRoomSummary({ roomId: 'room-1', topic: 'Linear Transformations' })],
      subjectName: 'Linear Algebra',
    });
    expect(result).not.toBeNull();
    // Without headings, we still get the topic-based prompt
    expect(result!.prompt.text).toContain('Linear Transformations');
    expect(result!.roomId).toBe('room-1');
  });

  it('uses correct room data from dungeonRooms for related topics', () => {
    const room1 = makeRoomMeta({
      roomId: 'room-1',
      topic: 'Matrices',
      noteText: '## Summary\nMatrix multiplication notes.',
    });
    const dungeonRooms = [
      makeDungeonRoomSummary({ roomId: 'room-1', topic: 'Matrices' }),
      makeDungeonRoomSummary({ roomId: 'room-2', topic: 'Determinants' }),
      makeDungeonRoomSummary({ roomId: 'room-3', topic: 'Eigenvalues' }),
    ];
    const result = pullRecallQuestion({
      clearedRooms: [room1],
      dungeonRooms,
      subjectName: 'Linear Algebra',
    });
    expect(result).not.toBeNull();
    expect(result!.roomId).toBe('room-1');
    expect(result!.prompt.text).toContain('Matrices');
  });
});
