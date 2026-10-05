/**
 * Phase 18: the statistics events written by the progression store's three award actions.
 *
 * The ledger in `src/core/statistics/statisticsEvents.ts` is only worth anything if the award
 * sites actually write it, in the **same record write** as the reward. These tests prove that
 * against the real store, because the alternative is a ledger nothing writes - which is exactly
 * the shape of the pre-Phase-18 defect this phase exists to remove.
 *
 * ## What is asserted, and what would make each assertion fail
 *
 * - **Atomicity.** A suppressed duplicate leaves the ledger unchanged, so the statistic cannot
 *   be counted without the reward or the reward without the statistic.
 * - **Same-record writes.** Each event lands under the identity the reward used, so a replay
 *   of the reward's own decision finds the event already there.
 * - **Both lanes record.** The Phase 15 clear-identity lane and the shipping lane that names
 *   only a room. A call that names no room cannot record, because a `note-submission` event
 *   requires an app-minted `roomId` - a type-level fact, not a byte-shape preference.
 * - **A declined catch writes nothing.** Phase 17's invariant, re-checked on the statistics
 *   side rather than assumed.
 * - **The session sink fires exactly once per award** and never for a declined outcome.
 *
 * The store modules are re-imported per test, because hydration in this codebase is explicit
 * and anything less than a fresh module is not a reload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { deriveRoomClearIdentity, readRoomClearRewardLedger } from '@/core/progression/roomClearRewards';
import { toReviewPassRewardIdentity } from '@/core/review/reviewPassRewards';
import {
  readStatisticsEventLedger,
  readStatisticsEventLedgerFromFields,
  STATISTICS_EVENT_LEDGER_KEY,
  totalXpAwarded,
} from '@/core/statistics/statisticsEvents';
import { resetStatisticsSinks } from '@/core/statistics/activitySink';
import type { StatisticsActivity } from '@/core/statistics/activitySink';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';

const SUBJECT_ID = 'synthetic-phase18-progression-subject';
const ROOM_A = 'synthetic-phase18-room-a';
const ROOM_B = 'synthetic-phase18-room-b';
const ROOM_C = 'synthetic-phase18-room-c';
const NOW = '2026-06-05T09:00:00.000Z';

function room(roomId: string, finalPass = true): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass },
  };
}

function snapshot(): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: 'Synthetic Phase 18 Progression Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM_A,
    rooms: [ROOM_A, ROOM_B, ROOM_C].map((roomId) => ({
      roomId,
      topic: `synthetic-topic-${roomId}`,
      status: 'ArtifactCollected',
    })),
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B), [ROOM_C]: room(ROOM_C) } };
}

/** A fresh store module, with an activity sink installed and the emitted activities kept. */
async function bind(): Promise<{
  progression: typeof import('@/store/progressionStore').useProgressionStore;
  subject: typeof import('@/store/subjectStore').useSubjectStore;
  activities: StatisticsActivity[];
}> {
  vi.resetModules();
  const activities: StatisticsActivity[] = [];
  const subjectMod = await import('@/store/subjectStore');
  const progressionMod = await import('@/store/progressionStore');
  // The sink module is imported **after** the reset, so it is the same module instance the
  // freshly-imported progression store holds. Importing it before the reset would install a
  // sink on a module the store never reaches, and every activity assertion would be vacuous.
  const sinkMod = await import('@/core/statistics/activitySink');
  subjectMod.useSubjectStore.getState().setSnapshot(snapshot());
  progressionMod.useProgressionStore
    .getState()
    .hydrateProgression(progressionMod.readPersistedProgressionPayload());
  progressionMod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
  sinkMod.setStatisticsActivitySink((activity) => activities.push(activity));
  return { progression: progressionMod.useProgressionStore, subject: subjectMod.useSubjectStore, activities };
}

/** The preserved-field key names, sorted, for an exact-set assertion. */
function sortedKeys(preserved: Record<string, unknown> | undefined): string[] {
  return Object.keys(preserved ?? {}).sort();
}

type ProgressionStore = typeof import('@/store/progressionStore').useProgressionStore;

/** The preserved fields of the active subject's record. */
function fields(progression: ProgressionStore): Record<string, unknown> | undefined {
  return progression.getState().readProgressionPreservedFields();
}

/** Badge inputs that satisfy no badge threshold, so an award rolls no loot and unlocks nothing. */
const BADGE_PROGRESS = {
  qualityBonus: 0,
  totalRooms: 3,
  creatorMappedRooms: 0,
  scribeClearedRooms: 1,
  archaeologistFullReviewPasses: 0,
};

beforeEach(() => {
  window.localStorage.clear();
  resetStatisticsSinks();
});

describe('awardRoomClear records the note and its XP in the reward record', () => {
  it('records both events, and the record carries them in one write', async () => {
    const bound = await bind();
    const reward = bound.progression.getState().awardRoomClear({
      ...BADGE_PROGRESS,
      qualityBonus: 2,
      clear: { roomId: ROOM_A, clearIdentity: 'clear-aaaa1111' },
    });
    expect(reward.awarded).toBe(true);
    expect(reward.xpGained).toBeGreaterThan(0);

    const preserved = fields(bound.progression) ?? {};
    const ledger = readStatisticsEventLedgerFromFields(preserved);
    expect(ledger.events.map((event) => event.kind).sort()).toEqual(['note-submission', 'xp-award']);
    const note = ledger.events.find((event) => event.kind === 'note-submission');
    expect(note).toMatchObject({ kind: 'note-submission', roomId: ROOM_A, xpAwarded: reward.xpGained });
    const xp = ledger.events.find((event) => event.kind === 'xp-award');
    expect(xp).toMatchObject({ kind: 'xp-award', source: 'note-submission', amount: reward.xpGained });
    // The two ledgers sit in ONE bag, which is what makes the record a single write.
    expect(sortedKeys(preserved)).toEqual(['roomClearRewardLedger', STATISTICS_EVENT_LEDGER_KEY]);
    // And the local day is a real key, not a UTC projection of the timestamp.
    expect(ledger.events[0].localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('records nothing for a suppressed duplicate: the statistic and the reward are one fact', async () => {
    const bound = await bind();
    const clear = { roomId: ROOM_A, clearIdentity: 'clear-bbbb2222' };
    bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, clear });
    const afterFirst = fields(bound.progression) ?? {};
    const afterFirstEvents = readStatisticsEventLedgerFromFields(afterFirst).events.length;

    const duplicate = bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, clear });
    expect(duplicate.awarded).toBe(false);
    expect(duplicate.duplicate).toBe(true);

    const afterSecond = fields(bound.progression) ?? {};
    expect(readStatisticsEventLedgerFromFields(afterSecond).events).toHaveLength(afterFirstEvents);
    // The XP total is byte-identical, so nothing was minted and nothing was counted.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('records again when the room is re-cleared against a NEW graph generation', async () => {
    const bound = await bind();
    bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, clear: { roomId: ROOM_A, clearIdentity: 'gen-1' } });
    const second = bound.progression.getState().awardRoomClear({
      ...BADGE_PROGRESS,
      clear: { roomId: ROOM_A, clearIdentity: 'gen-2' },
    });
    // A different generation is a genuine second clear, and it is counted twice.
    expect(second.awarded).toBe(true);
    expect(readStatisticsEventLedgerFromFields(fields(bound.progression)).events).toHaveLength(4);
  });

  it('gains NO extraFields key on a call that names no room, which is now a type-level fact', async () => {
    // CHANGED IN PHASE 18. This case used to read "the no-identity lane is the Phase 15 rollback
    // and the byte-comparison fixtures, and a statistics event would give those records an
    // `extraFields` key they have never had" - and that carve-out was inherited by the **shipping**
    // lane, because `NoteEditorModal` supplied no identity either. The result was a completed note
    // on the default artifact that awarded XP and recorded nothing anywhere.
    //
    // The carve-out now rests on something that cannot be traded away: a `note-submission` event
    // carries a required app-minted `roomId`, so a call that names no room has no honest event to
    // write. The byte-comparison fixtures' call shape is still pinned, as the rollback lane rather
    // than as a description of what the shipping build does - see `qaLegacyByteComparison`
    // case 5 and case 5b.
    const bound = await bind();
    const reward = bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS });
    expect(reward.awarded).toBe(true);
    expect(reward.duplicate).toBe(false);
    expect(fields(bound.progression)).toBeUndefined();
    expect(bound.activities).toEqual([]);
  });

  it('records on the shipping lane too, which is the lane the default artifact renders', async () => {
    // The regression guard for the blocker itself, in the file that owns the award actions' event
    // writes. `tests/phase18/shippingLaneNoteStatistics.test.ts` proves the same thing end to end
    // through the session record and the legacy key; this is the narrow assertion.
    const bound = await bind();
    const reward = bound.progression
      .getState()
      .awardRoomClear({ ...BADGE_PROGRESS, roomId: ROOM_A });
    expect(reward.awarded).toBe(true);
    expect(reward.xpGained).toBeGreaterThan(0);

    const preserved = fields(bound.progression) ?? {};
    expect(sortedKeys(preserved)).toEqual([STATISTICS_EVENT_LEDGER_KEY]);
    const ledger = readStatisticsEventLedgerFromFields(preserved);
    expect(ledger.events.map((event) => event.kind).sort()).toEqual(['note-submission', 'xp-award']);
    expect(totalXpAwarded(ledger)).toBe(reward.xpGained);
    expect(bound.activities).toEqual([
      { kind: 'note-submission', roomId: ROOM_A, xpAwarded: reward.xpGained },
    ]);

    // And the resubmit that Phase 15's `clear` identity would have suppressed, on the lane that
    // has no `clear`: released, counted once, paid once.
    const resubmit = bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, roomId: ROOM_A });
    expect(resubmit.awarded).toBe(false);
    expect(resubmit.duplicate).toBe(true);
    expect(readStatisticsEventLedgerFromFields(fields(bound.progression)).events).toHaveLength(2);
    expect(bound.activities).toHaveLength(1);
    expect(bound.progression.getState().roomsCleared).toBe(1);
  });

  it('emits exactly one session activity, carrying the XP the award paid', async () => {
    const bound = await bind();
    const reward = bound.progression
      .getState()
      .awardRoomClear({ ...BADGE_PROGRESS, clear: { roomId: ROOM_A, clearIdentity: 'clear-cccc3333' } });
    expect(bound.activities).toEqual([
      { kind: 'note-submission', roomId: ROOM_A, xpAwarded: reward.xpGained },
    ]);

    // A duplicate emits nothing, so the session counter is exactly-once by the same durable
    // fact that makes the award exactly-once.
    bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, clear: { roomId: ROOM_A, clearIdentity: 'clear-cccc3333' } });
    expect(bound.activities).toHaveLength(1);
  });

  it('uses the identity the command layer derives, so a command-driven clear is the same award', async () => {
    const bound = await bind();
    const identity = deriveRoomClearIdentity({ roomId: ROOM_A, dungeon: snapshot().dungeon });
    bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, clear: { roomId: ROOM_A, clearIdentity: identity } });
    const ledger = readStatisticsEventLedgerFromFields(fields(bound.progression));
    const note = ledger.events.find((event) => event.kind === 'note-submission');
    // A second clear with the same derived identity is suppressed, which is what the Phase 15
    // command layer relies on.
    const repeat = bound.progression.getState().awardRoomClear({ ...BADGE_PROGRESS, clear: { roomId: ROOM_A, clearIdentity: identity } });
    expect(repeat.duplicate).toBe(true);
    expect(readStatisticsEventLedgerFromFields(fields(bound.progression)).events).toHaveLength(ledger.events.length);
    expect(note?.roomId).toBe(ROOM_A);
  });
});

describe('awardReviewPass records the completion and its XP', () => {
  it('records both events beside the review ledger', async () => {
    const bound = await bind();
    const identity = toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 });
    const reward = bound.progression.getState().awardReviewPass(identity);
    expect(reward.awarded).toBe(true);

    const preserved = fields(bound.progression) ?? {};
    const ledger = readStatisticsEventLedgerFromFields(preserved);
    expect(ledger.events.map((event) => event.kind).sort()).toEqual(['review-completion', 'xp-award']);
    expect(ledger.events.find((event) => event.kind === 'review-completion')).toMatchObject({
      roomId: ROOM_A,
      passNumber: 1,
      xpAwarded: reward.xpGained,
    });
    expect(ledger.events.find((event) => event.kind === 'xp-award')).toMatchObject({
      source: 'review-completion',
      amount: reward.xpGained,
    });
    // The interrupted-review marker is not written here (nothing armed one), and the three
    // reward ledgers share the one bag.
    expect(sortedKeys(preserved)).toEqual(['reviewPassRewardLedger', STATISTICS_EVENT_LEDGER_KEY]);
  });

  it('records nothing for a same-pass duplicate', async () => {
    const bound = await bind();
    const identity = toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 });
    bound.progression.getState().awardReviewPass(identity);
    const afterFirst = JSON.parse(JSON.stringify(fields(bound.progression) ?? {}));
    const duplicate = bound.progression.getState().awardReviewPass(identity);
    expect(duplicate.duplicate).toBe(true);
    expect(JSON.parse(JSON.stringify(fields(bound.progression) ?? {}))).toEqual(afterFirst);
    expect(bound.activities).toHaveLength(1);
  });

  it('records again on the next pass of the same room, because the pass is part of the identity', async () => {
    const bound = await bind();
    bound.progression.getState().awardReviewPass(toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 1 }));
    const nextPass = bound.progression.getState().awardReviewPass(
      toReviewPassRewardIdentity({ roomId: ROOM_A, passNumber: 2 }),
    );
    expect(nextPass.awarded).toBe(true);
    const ledger = readStatisticsEventLedgerFromFields(fields(bound.progression));
    expect(ledger.events.filter((event) => event.kind === 'review-completion')).toHaveLength(2);
  });

  it('gains NO extraFields key on the no-identity lane', async () => {
    const bound = await bind();
    const reward = bound.progression.getState().awardReviewPass();
    expect(reward.awarded).toBe(true);
    expect(fields(bound.progression)).toBeUndefined();
    expect(bound.activities).toEqual([]);
  });

  it('emits one session activity carrying the room, pass, and XP', async () => {
    const bound = await bind();
    const reward = bound.progression.getState().awardReviewPass(
      toReviewPassRewardIdentity({ roomId: ROOM_B, passNumber: 1 }),
    );
    expect(bound.activities).toEqual([
      { kind: 'review-completion', roomId: ROOM_B, passNumber: 1, xpAwarded: reward.xpGained },
    ]);
  });
});

describe('recordCatch records a kept catch and its XP', () => {
  const catalogEntry = {
    id: 'moss-carp',
    name: 'Moss Carp',
    rarity: 'common',
    description: 'A synthetic catalogue entry.',
    difficulty: 1,
  } as unknown as import('@/core/fishing/fishingTypes').FishCatalogEntry;

  const identity = {
    contextId: 'synthetic-pond-context-1',
    catalogId: 'moss-carp',
    castNumber: 1,
    catchIdentity: 'catch-moss-carp-1',
  };

  it('records both events beside the catch ledger', async () => {
    const bound = await bind();
    const outcome = bound.progression.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity,
      outcome: 'answered-correct',
      catalogEntry,
      subjectName: 'Synthetic Phase 18 Progression Subject',
      recallRoomId: ROOM_A,
    });
    expect(outcome.awarded).toBe(true);

    const preserved = fields(bound.progression) ?? {};
    const ledger = readStatisticsEventLedgerFromFields(preserved);
    expect(ledger.events.map((event) => event.kind).sort()).toEqual(['fishing-outcome', 'xp-award']);
    expect(ledger.events.find((event) => event.kind === 'fishing-outcome')).toMatchObject({
      catalogId: 'moss-carp',
      contextId: 'synthetic-pond-context-1',
      castNumber: 1,
      xpAwarded: outcome.xpGained,
    });
    expect(totalXpAwarded(readStatisticsEventLedgerFromFields(preserved))).toBe(outcome.xpGained);
  });

  it('writes NOTHING for a declined outcome: not the reward, not the statistic', async () => {
    // Phase 17's invariant, re-checked on the statistics side. A release and a wrong recall
    // must not mutate progression, and a session counter is a form of award.
    const bound = await bind();
    for (const outcome of ['released', 'answered-incorrect'] as const) {
      const declined = bound.progression.getState().recordCatch({
        subjectId: SUBJECT_ID,
        identity: { ...identity, castNumber: outcome === 'released' ? 1 : 2, catchIdentity: `catch-declined-${outcome}` },
        outcome,
        catalogEntry,
        subjectName: 'Synthetic Phase 18 Progression Subject',
        recallRoomId: ROOM_A,
      });
      expect(declined.awarded).toBe(false);
      expect(declined.duplicate).toBe(false);
      expect(declined.declinedReason).toBe(outcome);
      expect(fields(bound.progression)).toBeUndefined();
      expect(bound.progression.getState().fishCollection).toHaveLength(0);
    }
    // And the session sink was never reached.
    expect(bound.activities).toEqual([]);
  });

  it('records nothing for a duplicate catch, and mints no second fish', async () => {
    const bound = await bind();
    const first = bound.progression.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity,
      outcome: 'answered-correct',
      catalogEntry,
      subjectName: 'Synthetic Phase 18 Progression Subject',
      recallRoomId: ROOM_A,
    });
    expect(first.awarded).toBe(true);
    const afterFirst = JSON.parse(JSON.stringify(fields(bound.progression) ?? {}));

    const duplicate = bound.progression.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity,
      outcome: 'answered-correct',
      catalogEntry,
      subjectName: 'Synthetic Phase 18 Progression Subject',
      recallRoomId: ROOM_A,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(bound.progression.getState().fishCollection).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(fields(bound.progression) ?? {}))).toEqual(afterFirst);
    expect(bound.activities).toHaveLength(1);
  });

  it('records the second cast of the same species, which is the case a cast number exists for', async () => {
    const bound = await bind();
    for (const castNumber of [1, 2]) {
      const outcome = bound.progression.getState().recordCatch({
        subjectId: SUBJECT_ID,
        identity: { ...identity, castNumber, catchIdentity: `catch-moss-carp-${castNumber}` },
        outcome: 'answered-correct',
        catalogEntry,
        subjectName: 'Synthetic Phase 18 Progression Subject',
        recallRoomId: ROOM_A,
      });
      expect(outcome.awarded).toBe(true);
    }
    expect(bound.progression.getState().fishCollection).toHaveLength(2);
    expect(
      readStatisticsEventLedgerFromFields(fields(bound.progression)).events.filter(
        (event) => event.kind === 'fishing-outcome',
      ),
    ).toHaveLength(2);
  });

  it('emits one session activity for a kept catch and none for a declined one', async () => {
    const bound = await bind();
    const outcome = bound.progression.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity,
      outcome: 'answered-correct',
      catalogEntry,
      subjectName: 'Synthetic Phase 18 Progression Subject',
      recallRoomId: ROOM_A,
    });
    expect(bound.activities).toEqual([
      {
        kind: 'fishing-outcome',
        catalogId: 'moss-carp',
        castNumber: 1,
        xpAwarded: outcome.xpGained,
        awarded: true,
      },
    ]);
  });
});

describe('the three award sites compose in one record', () => {
  it('keeps one statistics ledger holding all three kinds, with a summed XP total', async () => {
    const bound = await bind();
    const noteReward = bound.progression
      .getState()
      .awardRoomClear({ ...BADGE_PROGRESS, qualityBonus: 2, clear: { roomId: ROOM_A, clearIdentity: 'composed-clear' } });
    const reviewReward = bound.progression.getState().awardReviewPass(
      toReviewPassRewardIdentity({ roomId: ROOM_B, passNumber: 1 }),
    );
    const catalogEntry = {
      id: 'lunar-trout',
      name: 'Lunar Trout',
      rarity: 'rare',
      description: 'A synthetic catalogue entry.',
      difficulty: 2,
    } as unknown as import('@/core/fishing/fishingTypes').FishCatalogEntry;
    const catchReward = bound.progression.getState().recordCatch({
      subjectId: SUBJECT_ID,
      identity: {
        contextId: 'synthetic-pond-context-1',
        catalogId: 'lunar-trout',
        castNumber: 1,
        catchIdentity: 'catch-lunar-trout-1',
      },
      outcome: 'answered-correct',
      catalogEntry,
      subjectName: 'Synthetic Phase 18 Progression Subject',
      recallRoomId: ROOM_B,
    });

    const preserved = fields(bound.progression) ?? {};
    const ledger = readStatisticsEventLedger(preserved[STATISTICS_EVENT_LEDGER_KEY]);
    expect(ledger.events).toHaveLength(6);
    expect(ledger.events.filter((event) => event.kind === 'note-submission')).toHaveLength(1);
    expect(ledger.events.filter((event) => event.kind === 'review-completion')).toHaveLength(1);
    expect(ledger.events.filter((event) => event.kind === 'fishing-outcome')).toHaveLength(1);
    expect(totalXpAwarded(ledger)).toBe(noteReward.xpGained + reviewReward.xpGained + catchReward.xpGained);
    // Four ledgers share one bag, and the three reward ledgers are all still readable.
    expect(sortedKeys(preserved)).toEqual([
      'catchRewardLedger',
      'reviewPassRewardLedger',
      'roomClearRewardLedger',
      STATISTICS_EVENT_LEDGER_KEY,
    ]);
    expect(readRoomClearRewardLedger(preserved['roomClearRewardLedger']).entries).toHaveLength(1);
    expect(bound.activities).toHaveLength(3);
  });

  it('does not lose an unknown app-owned field the record already carried', async () => {
    // Phase 15 fixed a preservation bug where a room clear rebuilt the record field by field
    // and dropped every preserved field. The statistics write must not reintroduce it.
    const bound = await bind();
    const state = bound.progression;
    const current = state.getState().bySubject[SUBJECT_ID];
    state.getState().hydrateProgression({
      version: 3,
      bySubject: { [SUBJECT_ID]: { ...current, fixtureUnknownField: { marker: 'synthetic-phase18' } } },
      crossSubjectAchievements: [],
    });
    state.getState().setActiveSubject(SUBJECT_ID);
    state.getState().awardRoomClear({
      ...BADGE_PROGRESS,
      clear: { roomId: ROOM_A, clearIdentity: 'preserving-clear' },
    });

    const preserved = fields(state) ?? {};
    expect(preserved.fixtureUnknownField).toEqual({ marker: 'synthetic-phase18' });
    expect(preserved[STATISTICS_EVENT_LEDGER_KEY]).toBeDefined();
  });

  it('survives a reload: the ledger is read back out of the persisted record', async () => {
    const bound = await bind();
    bound.progression
      .getState()
      .awardRoomClear({ ...BADGE_PROGRESS, qualityBonus: 2, clear: { roomId: ROOM_A, clearIdentity: 'reload-clear' } });
    const before = JSON.parse(JSON.stringify(bound.progression.getState().readProgressionPreservedFields() ?? {}));

    // A reload: a fresh module plus an explicit hydration, which is what this codebase's
    // hydration contract means by one.
    vi.resetModules();
    const reloaded = await import('@/store/progressionStore');
    reloaded.useProgressionStore.getState().hydrateProgression(reloaded.readPersistedProgressionPayload());
    reloaded.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    const after = reloaded.useProgressionStore.getState().readProgressionPreservedFields() ?? {};

    expect(after).toEqual(before);
    expect(readStatisticsEventLedgerFromFields(after).events).toHaveLength(2);
    expect(totalXpAwarded(readStatisticsEventLedgerFromFields(after))).toBeGreaterThan(0);

    // And the suppression survives the reload: the same clear derives the same identity.
    const duplicate = reloaded.useProgressionStore.getState().awardRoomClear({
      ...BADGE_PROGRESS,
      qualityBonus: 2,
      clear: { roomId: ROOM_A, clearIdentity: 'reload-clear' },
    });
    expect(duplicate.duplicate).toBe(true);
    expect(
      readStatisticsEventLedgerFromFields(
        reloaded.useProgressionStore.getState().readProgressionPreservedFields(),
      ).events,
    ).toHaveLength(2);
  });

  it('writes nothing at all when no statistics sink is installed', async () => {
    // A rollback build and every unit test of the award sites that has not installed one: the
    // events are still written (they are part of the record), but nothing reaches a session.
    vi.resetModules();
    const progressionMod = await import('@/store/progressionStore');
    const subjectMod = await import('@/store/subjectStore');
    subjectMod.useSubjectStore.getState().setSnapshot(snapshot());
    progressionMod.useProgressionStore.getState().hydrateProgression(progressionMod.readPersistedProgressionPayload());
    progressionMod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    resetStatisticsSinks();

    expect(() =>
      progressionMod.useProgressionStore.getState().awardRoomClear({
        ...BADGE_PROGRESS,
        clear: { roomId: ROOM_A, clearIdentity: 'no-sink-clear' },
      }),
    ).not.toThrow();
    expect(readStatisticsEventLedgerFromFields(fields(progressionMod.useProgressionStore)).events).toHaveLength(2);
  });
});