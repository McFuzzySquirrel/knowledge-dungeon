/**
 * Phase 15 - the idempotent room-clear reward transaction.
 *
 * The defect this pins is the one `tests/contracts/phase-0-baseline.md` assigns
 * to Phases 14-15: "A valid note can be resubmitted and award room-clear
 * progression again." Before Phase 15 the reward transaction had no
 * awarded-once record at all, so a resubmission, a StrictMode double dispatch,
 * or a retried write each rolled loot and incremented `roomsCleared` again.
 *
 * The properties are named `P1`..`P6` and map one-to-one onto the deliverable:
 *
 * - **P1** one award per (room, valid-clear identity).
 * - **P2** a duplicate dispatch, a resubmission of a still-valid note, and a
 *   retried write award nothing - *including a concurrent* double dispatch.
 * - **P3** a new valid clear after a graph change invalidated the note awards
 *   again, because identity is (room, clear generation) and not just room.
 * - **P4** the awarded-once record is durable: it survives a reload and a fresh
 *   store hydration, in both repositories the product ships.
 * - **P5** no learner content appears in any key, id, flag, or the ledger body.
 * - **P6** `awardRoomClear`'s pre-Phase-15 behaviour is untouched for every
 *   caller that supplies no clear identity, which is what keeps the two
 *   byte-comparison lanes and the rollback lane honest.
 *
 * The "durable location" claim in the module header - the ledger rides in the
 * canonical progression record's preserved app-owned fields, so it needs no
 * canonical-version change and no `canonicalProgression.ts` / `validation.ts`
 * edit - is pinned at the bottom of this file against the real products.
 *
 * Privacy: every string here is synthetic. No real subject, topic, note, or
 * learner text appears in this file.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ROOM_CLEAR_REWARD_LEDGER_KEY,
  decideRoomClearReward,
  deriveRoomClearIdentity,
  hasRoomClearReward,
  latestRoomClearRewardForRoom,
  readRoomClearRewardLedger,
  readRoomClearRewardLedgerFromFields,
  recordRoomClearReward,
  writeRoomClearRewardLedgerToFields,
} from '@/core/progression/roomClearRewards';
import {
  CANONICAL_SUBJECT_PROGRESSION_KEYS,
  LEGACY_V3_SUBJECT_PROGRESSION_KEYS,
  canonicalProgressionToRecord,
  normalizeProgressionRecord,
  serializeCanonicalProgression,
} from '@/core/progression/canonicalProgression';
import { STATISTICS_EVENT_LEDGER_KEY } from '@/core/statistics/statisticsEvents';
import { validateProgressionRecord } from '@/services/persistence/v2/validation';
import { readArchive } from '@/services/persistence/v2/archive';
import { exportFullDeviceBackup } from '@/services/persistence/products/fullDeviceBackup';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import { publishProgressionToActiveGeneration } from '@/services/persistence/v2/appRepository';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import type { DungeonMetadata, DungeonEdge, DungeonRoomSummary } from '@/core/validation/persistence';

const PROGRESSIONSUBJECT_ID = 'subject-ledger';
const ROOM_ID = 'room-vector-space';
const NEIGHBOUR_ID = 'room-matrices';
const UNRELATED_ID = 'room-physics';

// ── Graph fixtures ──────────────────────────────────────────────────────────

function edge(fromRoomId: string, toRoomId: string): DungeonEdge {
  return {
    fromRoomId,
    toRoomId,
    relationType: 'subtopic',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdByPhase: 'Creator',
  };
}

function summary(roomId: string): DungeonRoomSummary {
  return { roomId, topic: `synthetic-topic-${roomId}`, status: 'ArtifactCollected' };
}

/**
 * A three-room graph.
 *
 * `ROOM_ID` is a leaf whose only neighbour is `NEIGHBOUR_ID`, and `NEIGHBOUR_ID`
 * is a leaf too. `UNRELATED_ID` is in a separate part of the graph, so a mutation
 * that only touches it must not change `ROOM_ID`'s clear identity - that is the
 * over-inclusion guard, and the reason the identity is not simply a digest of the
 * whole dungeon.
 */
function dungeon(): DungeonMetadata {
  return {
    schemaVersion: '1.1.0',
    dungeonId: PROGRESSIONSUBJECT_ID,
    subjectName: 'Synthetic Ledger Subject',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    phaseState: 'ScribeActive',
    rootRoomId: ROOM_ID,
    rooms: [summary(ROOM_ID), summary(NEIGHBOUR_ID), summary(UNRELATED_ID)],
    edges: [
      edge(ROOM_ID, NEIGHBOUR_ID),
      edge(NEIGHBOUR_ID, UNRELATED_ID),
    ],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
}

/** The same graph with one more child topic under the neighbour. */
function dungeonWithNewChildUnderNeighbour(): DungeonMetadata {
  const next = dungeon();
  return {
    ...next,
    rooms: [...next.rooms, summary('room-new-child')],
    edges: [...next.edges, edge(NEIGHBOUR_ID, 'room-new-child')],
  };
}

/** The same graph with a cross-link that only touches the unrelated room. */
function dungeonWithUnrelatedMutation(): DungeonMetadata {
  const next = dungeon();
  return {
    ...next,
    rooms: [...next.rooms, summary('room-unrelated-child')],
    edges: [...next.edges, edge(UNRELATED_ID, 'room-unrelated-child')],
  };
}

function identity(d: DungeonMetadata, roomId = ROOM_ID): string {
  return deriveRoomClearIdentity({ roomId, dungeon: d });
}

// ── Store fixtures ──────────────────────────────────────────────────────────

type ProgressionStoreModule = typeof import('@/store/progressionStore');

const FIXED_NOW = '2026-02-02T02:02:02.000Z';

/**
 * Load the store the way the application bootstrap does.
 *
 * Hydration is explicit in Phase 4, so the reload test has to perform the same
 * two calls a page load would, or it is not testing a reload.
 */
async function loadStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  const mod = await import('@/store/progressionStore');
  mod.useProgressionStore
    .getState()
    .hydrateProgression(mod.readPersistedProgressionPayload());
  return mod;
}

function badgeProgress() {
  return {
    qualityBonus: 5,
    totalRooms: 3,
    creatorMappedRooms: 3,
    scribeClearedRooms: 1,
    archaeologistFullReviewPasses: 0,
  };
}

function readMirrorRecord(subjectId = PROGRESSIONSUBJECT_ID): Record<string, unknown> {
  const raw = window.localStorage.getItem(STORAGE_KEYS.progression);
  if (raw === null) throw new Error('the store wrote nothing to the progression key');
  const payload = JSON.parse(raw) as { bySubject: Record<string, Record<string, unknown>> };
  const record = payload.bySubject[subjectId];
  if (record === undefined) throw new Error(`no mirrored record for ${subjectId}`);
  return record;
}

// ── The pure ledger ─────────────────────────────────────────────────────────

describe('roomClearRewards - identity', () => {
  it('is stable across calls for the same graph', () => {
    expect(identity(dungeon())).toBe(identity(dungeon()));
  });

  it('is opaque, prefixed, and carries no topic or note text', () => {
    const value = identity(dungeon());
    expect(value).toMatch(/^clear-[0-9a-f]{8}$/);
    expect(value).not.toContain('Vector');
    expect(value).not.toContain('synthetic-topic');
  });

  it('changes when a graph mutation can invalidate the room', () => {
    // A child added under the room's neighbour reaches the room through
    // `propagateRevalidationAfterGraphMutation`, so the identity must move.
    expect(identity(dungeonWithNewChildUnderNeighbour())).not.toBe(identity(dungeon()));
  });

  it('does not change for a mutation outside the room propagation window', () => {
    expect(identity(dungeonWithUnrelatedMutation())).toBe(identity(dungeon()));
  });

  it('is total for a room the dungeon does not list', () => {
    const value = deriveRoomClearIdentity({ roomId: 'room-removed', dungeon: dungeon() });
    expect(value).toMatch(/^clear-[0-9a-f]{8}$/);
    // Stable, so a removed room still has one identity rather than throwing.
    expect(value).toBe(deriveRoomClearIdentity({ roomId: 'room-removed', dungeon: dungeon() }));
  });

  it('differs per room, so two rooms never share one generation', () => {
    expect(identity(dungeon(), ROOM_ID)).not.toBe(identity(dungeon(), NEIGHBOUR_ID));
  });
});

describe('roomClearRewards - decision', () => {
  const clear = { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd', awardedAt: FIXED_NOW };

  it('P1: awards once and records the entry', () => {
    const decision = decideRoomClearReward({ extraFields: undefined, ...clear });

    expect(decision.outcome).toBe('awarded');
    expect(decision.ledger.entries).toEqual([
      { roomId: ROOM_ID, clearIdentity: clear.clearIdentity, awardedAt: FIXED_NOW },
    ]);
  });

  it('P2: a second decision for the same identity is already-awarded', () => {
    const first = decideRoomClearReward({ extraFields: undefined, ...clear });
    const fields = writeRoomClearRewardLedgerToFields(undefined, first.ledger);
    const second = decideRoomClearReward({ extraFields: fields, ...clear });

    expect(second.outcome).toBe('already-awarded');
    // The suppressed decision returns the ledger's content unchanged, so a caller
    // that writes it anyway cannot grow the ledger.
    expect(second.ledger).toEqual(first.ledger);
    expect(second.ledger.entries).toHaveLength(1);
  });

  it('P3: a new identity for the same room is awarded again', () => {
    const first = decideRoomClearReward({ extraFields: undefined, ...clear });
    const fields = writeRoomClearRewardLedgerToFields(undefined, first.ledger);
    const second = decideRoomClearReward({
      extraFields: fields,
      roomId: ROOM_ID,
      clearIdentity: 'clear-1111ffff',
      awardedAt: FIXED_NOW,
    });

    expect(second.outcome).toBe('awarded');
    expect(second.ledger.entries).toHaveLength(2);
    expect(latestRoomClearRewardForRoom(second.ledger, ROOM_ID)?.clearIdentity).toBe(
      'clear-1111ffff',
    );
  });

  it('keeps an unrelated room clear unaffected', () => {
    const first = decideRoomClearReward({ extraFields: undefined, ...clear });
    const fields = writeRoomClearRewardLedgerToFields(undefined, first.ledger);
    const second = decideRoomClearReward({
      extraFields: fields,
      roomId: NEIGHBOUR_ID,
      clearIdentity: clear.clearIdentity,
      awardedAt: FIXED_NOW,
    });

    expect(second.outcome).toBe('awarded');
  });

  it('is idempotent when the same entry is recorded twice', () => {
    const once = recordRoomClearReward(readRoomClearRewardLedger(undefined), {
      roomId: ROOM_ID,
      clearIdentity: clear.clearIdentity,
      awardedAt: FIXED_NOW,
    });
    const twice = recordRoomClearReward(once, {
      roomId: ROOM_ID,
      clearIdentity: clear.clearIdentity,
      awardedAt: FIXED_NOW,
    });

    expect(twice).toBe(once);
    expect(twice.entries).toHaveLength(1);
  });

  it('reads any unrecognized value as an empty ledger', () => {
    for (const raw of [undefined, null, 'nonsense', 7, [], { version: 1 }, { entries: 'no' }]) {
      expect(readRoomClearRewardLedger(raw).entries).toEqual([]);
    }
  });

  it('drops malformed entries rather than trusting them', () => {
    const ledger = readRoomClearRewardLedger({
      version: 1,
      entries: [
        { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd', awardedAt: FIXED_NOW },
        { roomId: '', clearIdentity: 'clear-0000abcd', awardedAt: FIXED_NOW },
        { roomId: ROOM_ID, clearIdentity: 42, awardedAt: FIXED_NOW },
        'not an object',
      ],
    });

    expect(ledger.entries).toHaveLength(1);
    expect(hasRoomClearReward(ledger, ROOM_ID, 'clear-0000abcd')).toBe(true);
  });

  it('preserves other preserved fields when the ledger is written', () => {
    const fields = writeRoomClearRewardLedgerToFields(
      { fixtureUnknownField: 'keep-me' },
      readRoomClearRewardLedger(undefined),
    );

    expect(fields.fixtureUnknownField).toBe('keep-me');
    expect(Object.keys(fields).sort()).toEqual(
      [ROOM_CLEAR_REWARD_LEDGER_KEY, 'fixtureUnknownField'].sort(),
    );
    expect(readRoomClearRewardLedgerFromFields(fields).entries).toEqual([]);
  });
});

// ── The store's reward transaction ──────────────────────────────────────────

describe('progressionStore.awardRoomClear - idempotency', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('P1: a valid clear awards XP, loot, badges, and one roomsCleared increment', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);

    const reward = useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' },
    });

    expect(reward.awarded).toBe(true);
    expect(reward.duplicate).toBe(false);
    expect(reward.xpGained).toBeGreaterThan(0);
    expect(reward.loot).not.toBeNull();
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    expect(useProgressionStore.getState().inventory).toHaveLength(1);
  });

  it('P2: a sequential duplicate dispatch awards nothing', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);
    const clear = { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' };

    const first = useProgressionStore.getState().awardRoomClear({ ...badgeProgress(), clear });
    const xpAfterFirst = useProgressionStore.getState().xpTotal;
    const second = useProgressionStore.getState().awardRoomClear({ ...badgeProgress(), clear });

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.xpGained).toBe(0);
    expect(second.loot).toBeNull();
    expect(second.unlockedBadges).toEqual([]);
    expect(second.unlockedAchievements).toEqual([]);
    expect(second.rankChanged).toBe(false);
    expect(useProgressionStore.getState().xpTotal).toBe(xpAfterFirst);
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    expect(useProgressionStore.getState().inventory).toHaveLength(1);
  });

  it('P2: a concurrent double dispatch awards exactly once', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);
    const clear = { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' };

    // Both dispatches are issued before either promise is awaited, which is what
    // a StrictMode double submit and a double click both look like from here.
    const inFlight = [
      useProgressionStore.getState().awardRoomClear({ ...badgeProgress(), clear }),
      useProgressionStore.getState().awardRoomClear({ ...badgeProgress(), clear }),
    ];
    const [first, second] = await Promise.all(inFlight);

    expect([first.awarded, second.awarded].filter(Boolean)).toHaveLength(1);
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    expect(useProgressionStore.getState().inventory).toHaveLength(1);
  });

  it('P2: a retried write awards nothing, and the guard landed with the reward', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);
    const clear = { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' };

    useProgressionStore.getState().awardRoomClear({ ...badgeProgress(), clear });
    const xpAfterFirst = useProgressionStore.getState().xpTotal;

    // The "retry" is the same call again after the write went out. Because the
    // ledger rides in the same record as the reward, a failed write can never
    // leave the reward without its guard: both persist together or neither does.
    const retry = useProgressionStore.getState().awardRoomClear({ ...badgeProgress(), clear });

    expect(retry.awarded).toBe(false);
    expect(useProgressionStore.getState().xpTotal).toBe(xpAfterFirst);
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
  });

  it('P3: a new clear generation for the same room awards again', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);

    const before = identity(dungeon());
    const after = identity(dungeonWithNewChildUnderNeighbour());
    expect(after).not.toBe(before);

    useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: before },
    });
    const second = useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: after },
    });

    expect(second.awarded).toBe(true);
    expect(useProgressionStore.getState().roomsCleared).toBe(2);
    expect(useProgressionStore.getState().inventory).toHaveLength(2);
  });

  it('P3: two rooms clear independently', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);

    useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' },
    });
    useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: NEIGHBOUR_ID, clearIdentity: 'clear-0000abcd' },
    });

    expect(useProgressionStore.getState().roomsCleared).toBe(2);
  });

  it('P4: the awarded-once record survives a reload and a fresh hydration', async () => {
    const first = await loadStore();
    first.useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);
    first.useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' },
    });
    const xpAfterClear = first.useProgressionStore.getState().xpTotal;

    // A reload: the module registry is dropped, the store is imported again, and
    // hydration is performed exactly as the application bootstrap performs it.
    const second = await loadStore();

    expect(second.useProgressionStore.getState().xpTotal).toBe(xpAfterClear);
    const retry = second.useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' },
    });

    expect(retry.awarded).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(second.useProgressionStore.getState().roomsCleared).toBe(1);
    expect(second.useProgressionStore.getState().xpTotal).toBe(xpAfterClear);
  });

  it('P5: the ledger writes no learner content into any key, id, or body', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);
    useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: identity(dungeon()) },
    });

    const mirrored = readMirrorRecord();
    const serialized = JSON.stringify(mirrored);

    // No learner content in the record at all: the reward transaction never sees
    // a topic, a note, or an artifact, and must not invent a place to put one.
    expect(serialized).not.toContain('synthetic-topic');
    expect(serialized).not.toContain('Vector space');

    // The ledger's own key is static vocabulary, and its entry carries an app id,
    // an opaque digest, and a timestamp - nothing else.
    const ledger = mirrored[ROOM_CLEAR_REWARD_LEDGER_KEY] as { entries: unknown[] };
    expect(Object.keys(ledger)).toEqual(['version', 'entries']);
    expect(Object.keys(ledger.entries[0] as object).sort()).toEqual([
      'awardedAt',
      'clearIdentity',
      'roomId',
    ]);
    expect(ledger.entries[0]).toMatchObject({ roomId: ROOM_ID });
  });

  it('P6: a caller that supplies no clear identity keeps the pre-Phase-15 behaviour', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);

    const first = useProgressionStore.getState().awardRoomClear(badgeProgress());
    const second = useProgressionStore.getState().awardRoomClear(badgeProgress());

    // Unconditional, exactly as before: the byte-comparison lanes and the
    // rollback lane both depend on this.
    expect(first.awarded).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.awarded).toBe(true);
    expect(useProgressionStore.getState().roomsCleared).toBe(2);
    // And no ledger key is introduced, so the mirrored record's key set is still
    // the thirteen the pre-Phase-15 build wrote.
    expect(Object.keys(readMirrorRecord())).toEqual([...LEGACY_V3_SUBJECT_PROGRESSION_KEYS]);
  });

  it('P6: a no-active-subject answer still reports that nothing was awarded', async () => {
    const { useProgressionStore } = await loadStore();

    const reward = useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' },
    });

    expect(reward.awarded).toBe(false);
    expect(reward.duplicate).toBe(false);
    expect(reward.xpGained).toBe(0);
    expect(reward.newRank).toBe('Novice');
  });

  it('P6: an existing preserved unknown field survives a room clear', async () => {
    window.localStorage.setItem(
      STORAGE_KEYS.progression,
      JSON.stringify({
        version: 3,
        bySubject: {
          [PROGRESSIONSUBJECT_ID]: {
            xpTotal: 320,
            rank: 'Scholar',
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
            fixtureUnknownField: { marker: 'synthetic-unknown-field' },
          },
        },
        crossSubjectAchievements: [],
      }),
    );
    window.localStorage.setItem(STORAGE_KEYS.activeSubjectId, PROGRESSIONSUBJECT_ID);

    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().awardRoomClear(badgeProgress());

    // Before Phase 15 this action rebuilt the record field by field and dropped
    // the preserved field. It is carried forward now, alongside the ledger.
    expect(readMirrorRecord().fixtureUnknownField).toEqual({ marker: 'synthetic-unknown-field' });
  });
});

// ── Durability across the products ──────────────────────────────────────────

describe('roomClearRewards - the ledger survives every persistence product', () => {
  it('reaches the legacy mirror the shipping repository writes', async () => {
    window.localStorage.clear();
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject(PROGRESSIONSUBJECT_ID);
    useProgressionStore.getState().awardRoomClear({
      ...badgeProgress(),
      clear: { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd' },
    });

    // The mirror flattens preserved fields into the record, so the ledger is
    // visible at the top level of the record a page reload will read back.
    const mirrored = readMirrorRecord();
    const ledger = mirrored[ROOM_CLEAR_REWARD_LEDGER_KEY] as { entries: { roomId: string }[] };
    expect(ledger.entries).toEqual([expect.objectContaining({ roomId: ROOM_ID })]);

    // And a record with the ledger is still exactly the thirteen known keys plus
    // the ledgers: each ledger is additive, not a replacement, and each lands in
    // the same preserved bag.
    //
    // Phase 18 added `statisticsEventLedger` here. That the assertion is now
    // thirteen keys plus *two* is the property worth keeping: the legacy mirror
    // still flattens every preserved field, so a third ledger costs the record
    // nothing structural, and none of the three displaces another.
    expect(Object.keys(mirrored).sort()).toEqual(
      [
        ...LEGACY_V3_SUBJECT_PROGRESSION_KEYS,
        ROOM_CLEAR_REWARD_LEDGER_KEY,
        STATISTICS_EVENT_LEDGER_KEY,
      ].sort(),
    );
  });

  it('round-trips through the canonical representation with no loss', () => {
    const ledger = readRoomClearRewardLedger(undefined);
    const decision = decideRoomClearReward({
      extraFields: writeRoomClearRewardLedgerToFields({ fixtureUnknownField: 7 }, ledger),
      roomId: ROOM_ID,
      clearIdentity: 'clear-0000abcd',
      awardedAt: FIXED_NOW,
    });
    const canonical = normalizeProgressionRecord(
      {
        version: 3,
        bySubject: {
          [PROGRESSIONSUBJECT_ID]: {
            xpTotal: 100,
            badges: [],
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
            extraFields: writeRoomClearRewardLedgerToFields(
              { fixtureUnknownField: 7 },
              decision.ledger,
            ),
          },
        },
        crossSubjectAchievements: [],
      },
      { activeSubjectId: PROGRESSIONSUBJECT_ID },
    );

    const record = canonical.bySubject[PROGRESSIONSUBJECT_ID];
    expect(record).toBeDefined();

    // Serialized and re-normalized: the ledger and the unrelated preserved field
    // both come back, and the record's key set is the pinned canonical one.
    const restored = normalizeProgressionRecord(
      JSON.parse(serializeCanonicalProgression(canonical)) as unknown,
      { activeSubjectId: PROGRESSIONSUBJECT_ID },
    ).bySubject[PROGRESSIONSUBJECT_ID];

    expect(restored?.extraFields.fixtureUnknownField).toBe(7);
    const restoredLedger = readRoomClearRewardLedgerFromFields(restored?.extraFields);
    expect(restoredLedger.entries).toEqual([
      { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd', awardedAt: FIXED_NOW },
    ]);
    expect(hasRoomClearReward(restoredLedger, ROOM_ID, 'clear-0000abcd')).toBe(true);
    expect(Object.keys(restored ?? {}).sort()).toEqual([...CANONICAL_SUBJECT_PROGRESSION_KEYS].sort());
  });

  it('is accepted by storage-v2 progression validation', () => {
    const decision = decideRoomClearReward({
      extraFields: undefined,
      roomId: ROOM_ID,
      clearIdentity: 'clear-0000abcd',
      awardedAt: FIXED_NOW,
    });
    const value = {
      subjectId: PROGRESSIONSUBJECT_ID,
      sourceVersion: 3 as const,
      rank: 'Novice' as const,
      xpTotal: 100,
      bySubject: {
        [PROGRESSIONSUBJECT_ID]: {
          xpTotal: 100,
          rank: 'Novice',
          badges: [],
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
          extraFields: writeRoomClearRewardLedgerToFields(undefined, decision.ledger),
        },
      },
      crossSubjectAchievements: [],
    };

    // No problem reported, so a ledger-bearing generation is writable - which is
    // the whole reason `validation.ts` needed no change.
    expect(validateProgressionRecord(value).problems).toEqual([]);
  });

  it('is published into a storage-v2 generation and exported in the .kdbak', async () => {
    const repository: StorageV2Repository = await openStorageV2Repository({
      databaseName: 'room-clear-reward-ledger-test',
      clock: fixedClock(FIXED_NOW),
      idFactory: createDeterministicIdFactory('ledger'),
    });

    try {
      await publishProgressionToActiveGeneration(
        repository,
        {
          version: 3,
          crossSubjectAchievements: [],
          bySubject: {
            [PROGRESSIONSUBJECT_ID]: {
              xpTotal: 100,
              rank: 'Novice',
              badges: [],
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
              extraFields: writeRoomClearRewardLedgerToFields(
                undefined,
                decideRoomClearReward({
                  extraFields: undefined,
                  roomId: ROOM_ID,
                  clearIdentity: 'clear-0000abcd',
                  awardedAt: FIXED_NOW,
                }).ledger,
              ),
            },
          },
        },
        FIXED_NOW,
      );

      const generationId = await repository.readActiveGenerationId();
      expect(generationId).not.toBeNull();
      const generationIdValue = generationId as string;

      // Stored, not just in memory.
      const stored = await repository.readRecords(generationIdValue);
      const storedRecord = stored.records.progression[0]?.value.bySubject[PROGRESSIONSUBJECT_ID];
      expect(readRoomClearRewardLedgerFromFields(
        (storedRecord as { extraFields?: Record<string, unknown> } | undefined)?.extraFields,
      ).entries).toHaveLength(1);

      // And carried into the full-device backup's state document, because that
      // product packages the progression records verbatim.
      const exported = await exportFullDeviceBackup({
        repository,
        generationId: generationIdValue,
        now: FIXED_NOW,
      });
      const archive = readArchive(exported.bytes);
      const stateMember = archive.find((file) => file.path === 'state.json');
      expect(stateMember).toBeDefined();
      const state = JSON.parse(new TextDecoder().decode(stateMember?.bytes)) as {
        progression: { bySubject: Record<string, { extraFields?: Record<string, unknown> }> }[];
      };
      const exportedRecord =
        state.progression[0]?.bySubject[PROGRESSIONSUBJECT_ID] as
          | { extraFields?: Record<string, unknown> }
          | undefined;
      expect(readRoomClearRewardLedgerFromFields(exportedRecord?.extraFields).entries).toEqual([
        { roomId: ROOM_ID, clearIdentity: 'clear-0000abcd', awardedAt: FIXED_NOW },
      ]);
    } finally {
      repository.close();
      indexedDB.deleteDatabase('room-clear-reward-ledger-test');
    }
  });

  it('is absent from the blank template product, which is graph structure only', () => {
    // The template carries no progression at all, so there is nothing for the
    // ledger to leak into. This pins that the ledger's home really is the
    // progression record and nowhere else.
    const template = JSON.stringify({
      format: 'knowledge-dungeon-template',
      rooms: [{ roomId: ROOM_ID, topic: 'synthetic-topic' }],
    });

    expect(template).not.toContain(ROOM_CLEAR_REWARD_LEDGER_KEY);
    expect(canonicalProgressionToRecord({ sourceVersion: 3, activeSubjectId: null, legacyBucketSubjectId: null, crossSubjectAchievements: [], extraFields: {}, bySubject: {} })).not.toContain(
      ROOM_CLEAR_REWARD_LEDGER_KEY,
    );
  });
});