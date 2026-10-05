/**
 * Phase 16: the store binding, end to end.
 *
 * `tests/phase16/reviewCommands.test.ts` proves the command layer's semantics over
 * in-memory ports. This file proves the *binding* is real: the ready-made
 * `reviewController` in `src/store/reviewCommands.ts` reaches the actual subject
 * and progression stores, a rating from the command reaches SM-2, and the
 * interrupted-review marker survives a reload in the persisted progression
 * record.
 *
 * The store modules are re-imported per test because hydration is explicit in
 * Phase 4: a reload is a fresh module plus a fresh `hydrateProgression`, and
 * anything less is not a reload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import { updateSm2State } from '@/core/review/spacedRepetition';

const SUBJECT_ID = 'synthetic-binding-subject';
const ROOM_A = 'synthetic-binding-room-a';
const ROOM_B = 'synthetic-binding-room-b';
const NOW = '2026-07-07T07:07:07.000Z';

function room(roomId: string, reviewPassCount = 0): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
    reviewPassCount,
  };
}

/**
 * A two-room, fully cleared dungeon.
 *
 * Two rooms and not one is the point: a *pass* is a property of the whole subject,
 * so with a single reviewable room every review would be its own pass and
 * "once per room per pass" would be indistinguishable from "award every review".
 * With two, reviewing one room twice is a same-pass repeat and reviewing both is
 * the next pass.
 */
function snapshot(): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: 'Synthetic Binding Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM_A,
    rooms: [
      { roomId: ROOM_A, topic: `synthetic-topic-${ROOM_A}`, status: 'ArtifactCollected' },
      { roomId: ROOM_B, topic: `synthetic-topic-${ROOM_B}`, status: 'ArtifactCollected' },
    ],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B) } };
}

/** The controller under test, plus both stores, freshly imported. */
async function bind(): Promise<{
  controller: import('@/application/reviewCommands').ReviewController;
  subject: typeof import('@/store/subjectStore').useSubjectStore;
  progression: typeof import('@/store/progressionStore').useProgressionStore;
}> {
  vi.resetModules();
  const subjectMod = await import('@/store/subjectStore');
  const progressionMod = await import('@/store/progressionStore');
  const binding = await import('@/store/reviewCommands');
  subjectMod.useSubjectStore.getState().setSnapshot(snapshot());
  progressionMod.useProgressionStore
    .getState()
    .hydrateProgression(progressionMod.readPersistedProgressionPayload());
  progressionMod.useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
  return {
    controller: binding.reviewController,
    subject: subjectMod.useSubjectStore,
    progression: progressionMod.useProgressionStore,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('reviewController against the real stores', () => {
  it('pays a same-pass repeat exactly once and pays the next pass again', async () => {
    const bound = await bind();

    const first = bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 5 });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.reviewIdentity.passNumber).toBe(1);
    expect(bound.progression.getState().xpTotal).toBe(6);

    // The same room again, while its sibling is still unreviewed: still pass 1.
    const repeat = bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 5 });
    if (repeat.ok) {
      expect(repeat.value.reviewIdentity.passNumber).toBe(1);
      expect(repeat.value.progression.awarded).toBe(false);
      expect(repeat.value.progression.duplicate).toBe(true);
    }
    expect(bound.progression.getState().xpTotal).toBe(6);
    expect(bound.progression.getState().reviewPasses).toBe(1);

    // The sibling completes the pass, so the next review of A is pass 2.
    const sibling = bound.controller.passComplete({ roomId: ROOM_B, qualityRating: 5 });
    if (sibling.ok) expect(sibling.value.reviewIdentity.passNumber).toBe(1);
    expect(bound.progression.getState().xpTotal).toBe(12);

    const nextPass = bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 5 });
    if (nextPass.ok) {
      expect(nextPass.value.reviewIdentity.passNumber).toBe(2);
      expect(nextPass.value.progression.awarded).toBe(true);
    }
    expect(bound.progression.getState().xpTotal).toBe(18);
    expect(bound.progression.getState().reviewPasses).toBe(3);
  });

  it('carries the learner rating all the way into SM-2', async () => {
    const bound = await bind();

    bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 5 });

    // `recordReviewPass` is fire-and-forget, so let its microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();

    const recorded = bound.subject.getState().snapshot?.rooms[ROOM_A];
    expect(recorded?.reviewPassCount).toBe(1);
    expect(recorded?.sm2QualityResponse).toBe(5);
    // The canonical SM-2 output for a first perfect recall.
    const expected = updateSm2State({ quality: 5, previousState: null, reviewedAtIso: expect.any(String) as never });
    expect(recorded?.sm2IntervalDays).toBe(expected.intervalDays);
    expect(recorded?.sm2ConsecutiveCorrect).toBe(expected.consecutiveCorrect);
    expect(recorded?.sm2EaseFactor).toBeCloseTo(expected.easeFactor, 5);
  });

  it('a low rating advances SM-2 differently, proving the rating is not defaulted', async () => {
    const bound = await bind();

    bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 0 });
    await Promise.resolve();
    await Promise.resolve();

    const recorded = bound.subject.getState().snapshot?.rooms[ROOM_A];
    // Quality 0 resets the interval and the consecutive counter - the behaviour
    // the pre-Phase-16 default of 3 could never produce.
    expect(recorded?.sm2QualityResponse).toBe(0);
    expect(recorded?.sm2IntervalDays).toBe(1);
    expect(recorded?.sm2ConsecutiveCorrect).toBe(0);
  });

  it('a save writes no SM-2 state and no reward', async () => {
    const bound = await bind();

    const saved = bound.controller.sessionSave({ roomId: ROOM_A, qualityRating: 4 });
    await Promise.resolve();
    await Promise.resolve();

    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.progression).toBeNull();
    const recorded = bound.subject.getState().snapshot?.rooms[ROOM_A];
    expect(recorded?.reviewPassCount).toBe(0);
    expect(recorded?.sm2QualityResponse).toBeUndefined();
    expect(bound.progression.getState().xpTotal).toBe(0);
    expect(bound.progression.getState().reviewPasses).toBe(0);
  });

  it('a discard awards nothing and clears the marker', () => {
    return bind().then((bound) => {
      bound.controller.sessionSave({ roomId: ROOM_A, qualityRating: 2 });
      expect(bound.controller.sessionResume({ roomId: ROOM_A })).toMatchObject({
        ok: true,
        value: { resumed: true },
      });

      const discarded = bound.controller.sessionDiscard({ roomId: ROOM_A });

      expect(discarded.ok && discarded.value.discarded).toBe(true);
      expect(bound.progression.getState().xpTotal).toBe(0);
      expect(bound.progression.getState().readProgressionPreservedFields()).not.toHaveProperty(
        'interruptedReviewSession',
      );
    });
  });

  it('the marker reaches the persisted progression record and survives a reload', async () => {
    const first = await bind();

    first.controller.sessionSave({ roomId: ROOM_A, qualityRating: 3 });

    // The legacy mirror is the shipping repository, so this is the record a real
    // page load reads.
    const raw = window.localStorage.getItem(STORAGE_KEYS.progression);
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw as string) as {
      bySubject: Record<string, { interruptedReviewSession?: { roomId: string } }>;
    };
    expect(payload.bySubject[SUBJECT_ID]?.interruptedReviewSession?.roomId).toBe(ROOM_A);

    // A reload.
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEYS.progression, JSON.stringify(payload));
    const second = await bind();

    const resumed = second.controller.sessionResume({ roomId: ROOM_A });
    expect(resumed.ok && resumed.value.resumed).toBe(true);
  });

  it('a saved marker is removed when the same review is completed', async () => {
    return bind().then((bound) => {
      bound.controller.sessionSave({ roomId: ROOM_A, qualityRating: 4 });
      bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

      const resumed = bound.controller.sessionResume({ roomId: ROOM_A });
      expect(resumed.ok && resumed.value.resumed).toBe(false);
      expect(bound.progression.getState().readProgressionPreservedFields()).not.toHaveProperty(
        'interruptedReviewSession',
      );
    });
  });

  it('the review ledger and the room-clear ledger share one preserved bag', () => {
    return bind().then((bound) => {
      bound.progression.getState().awardRoomClear({
        qualityBonus: 5,
        totalRooms: 1,
        creatorMappedRooms: 1,
        scribeClearedRooms: 1,
        archaeologistFullReviewPasses: 0,
        clear: { roomId: ROOM_A, clearIdentity: 'clear-0000abcd' },
      });
      bound.controller.sessionSave({ roomId: ROOM_A, qualityRating: null });

      const fields = bound.progression.getState().readProgressionPreservedFields() ?? {};
      // Phase 18 added a third ledger to the same bag: the statistics event ledger, written
      // in the same record write as each reward and sharing its identity. The point of this
      // assertion is that they *share one bag* and that none of them costs another one, so
      // the exact list grows by the new key and the "share" property is unchanged.
      expect(Object.keys(fields).sort()).toEqual([
        'interruptedReviewSession',
        'roomClearRewardLedger',
        'statisticsEventLedger',
      ]);
    });
  });

  it('refuses a locked dungeon before touching either store', () => {
    return bind().then((bound) => {
      // A third room that has never been defeated drops the completion ratio.
      const current = bound.subject.getState().snapshot;
      if (current === null) throw new Error('expected a snapshot');
      const roomC = 'synthetic-binding-room-c';
      bound.subject.getState().setSnapshot({
        ...current,
        dungeon: {
          ...current.dungeon,
          rooms: [
            ...current.dungeon.rooms,
            { roomId: roomC, topic: 'synthetic-topic-c', status: 'Created' },
          ],
        },
        rooms: {
          ...current.rooms,
          [roomC]: {
            ...room(roomC),
            state: 'Created',
            validationState: { ...makeEmptyValidationState(), finalPass: false },
          },
        },
      });

      const result = bound.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error.code).toBe('REVIEW_LOCKED');
      expect(result.error.details).toEqual({
        roomId: ROOM_A,
        clearedRooms: 2,
        totalRooms: 3,
      });
      expect(bound.progression.getState().xpTotal).toBe(0);
    });
  });
});
