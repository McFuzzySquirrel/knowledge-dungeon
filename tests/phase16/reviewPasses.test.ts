/**
 * Phase 16: pass-progress derivation, review due state, and the shared unlock.
 *
 * The partial-clear case is the important one: it is where the two pre-existing
 * definitions of "rooms toward the next pass" disagree, and the documented
 * decision is asserted here rather than left in a header.
 */
import { describe, expect, it } from 'vitest';
import {
  canReviewRoom,
  collectReviewableRoomIds,
  currentReviewPassNumber,
  deriveReviewPassProgress,
  describeReviewDueState,
  describeReviewRefusal,
  summarizeReviewAnalytics,
  summarizeReviewPassProgress,
} from '@/core/review';
import { evaluateReviewUnlock } from '@/core/review/reviewDomain';
import type { ReviewUnlockStatus } from '@/core/review/types';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
} from '@/core/validation/persistence';

const NOW = '2026-04-04T12:00:00.000Z';
const REVIEWED = 'ArtifactCollected';
const UNREVIEWED = 'Created';

function room(
  roomId: string,
  overrides: { finalPass?: boolean; state?: string; reviewPassCount?: number } = {},
): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: (overrides.state ?? REVIEWED) as RoomMetadata['state'],
    validationState: {
      ...makeEmptyValidationState(),
      finalPass: overrides.finalPass ?? true,
    },
    reviewPassCount: overrides.reviewPassCount ?? 0,
  };
}

function dungeon(roomIds: readonly string[]): DungeonMetadata {
  return {
    schemaVersion: '1.1.0',
    dungeonId: 'synthetic-progress-subject',
    subjectName: 'Synthetic Progress Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: roomIds[0] ?? 'synthetic-root',
    rooms: roomIds.map((roomId) => ({
      roomId,
      topic: `synthetic-topic-${roomId}`,
      status: 'ArtifactCollected' as const,
    })),
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice' as const, badges: [], fishCollection: [] },
  };
}

// ── Pass progress ───────────────────────────────────────────────────────────

describe('summarizeReviewPassProgress', () => {
  it('reads zero passes and target one on a fresh reviewable dungeon', () => {
    const rooms = { 'room-a': room('room-a'), 'room-b': room('room-b') };
    const progress = summarizeReviewPassProgress({
      rooms,
      reviewableRoomIds: ['room-a', 'room-b'],
      roomIds: ['room-a', 'room-b'],
    });

    expect(progress).toEqual({
      fullReviewPasses: 0,
      nextPassTarget: 1,
      roomsTowardNextPass: 0,
      totalRooms: 2,
      reviewedRoomIds: [],
    });
  });

  it('completes a pass only when every reviewable room reaches the target', () => {
    const rooms = {
      'room-a': room('room-a', { reviewPassCount: 1 }),
      'room-b': room('room-b', { reviewPassCount: 1 }),
    };
    const progress = summarizeReviewPassProgress({
      rooms,
      reviewableRoomIds: ['room-a', 'room-b'],
      roomIds: ['room-a', 'room-b'],
    });

    expect(progress.fullReviewPasses).toBe(1);
    expect(progress.nextPassTarget).toBe(2);
    // Both rooms are already in pass 2, so neither is counted toward it yet.
    expect(progress.roomsTowardNextPass).toBe(0);
  });

  it('derives the reviewed room ids from the same count it reports', () => {
    const rooms = {
      'room-a': room('room-a', { reviewPassCount: 1 }),
      'room-b': room('room-b', { reviewPassCount: 1 }),
      'room-c': room('room-c', { reviewPassCount: 0 }),
    };
    const progress = summarizeReviewPassProgress({
      rooms,
      reviewableRoomIds: ['room-a', 'room-b', 'room-c'],
      roomIds: ['room-a', 'room-b', 'room-c'],
    });

    // 2 of 3 reviews is not a completed pass, so the target is still 1 and the
    // two reviewed rooms are the ones toward it.
    expect(progress.fullReviewPasses).toBe(0);
    expect(progress.nextPassTarget).toBe(1);
    expect(progress.roomsTowardNextPass).toBe(progress.reviewedRoomIds.length);
    expect(progress.reviewedRoomIds).toEqual(['room-a', 'room-b']);
  });

  it('is total for a room the snapshot does not list and a nonsense counter', () => {
    const rooms = { 'room-a': { ...room('room-a'), reviewPassCount: Number.NaN } };
    const progress = summarizeReviewPassProgress({
      rooms,
      reviewableRoomIds: ['room-a', 'synthetic-room-that-was-deleted'],
      roomIds: ['room-a', 'synthetic-room-that-was-deleted'],
    });

    expect(progress.totalRooms).toBe(2);
    expect(progress.fullReviewPasses).toBe(0);
  });

  /**
   * The partial-clear divergence, pinned.
   *
   * `summarizeReviewAnalytics` divides the reviewable rooms' review count by the
   * **reviewable** room count, while `GameScreen.reviewProgress` counts
   * `reviewedTowardNextPass` across **all** `dungeon.rooms`. On a partially
   * cleared dungeon the two populations differ, and this asserts that
   * `summarizeReviewPassProgress` keeps each number on the population it has
   * always used - `fullReviewPasses` unchanged from the analytics (because it is a
   * badge input), `roomsTowardNextPass` unchanged from the HUD (because
   * `ui-engineer` renders it).
   */
  it('keeps each number on the population it already used, under a partial clear', () => {
    // Two rooms cleared, one never touched.
    const rooms = {
      'room-a': room('room-a', { reviewPassCount: 1 }),
      'room-b': room('room-b', { reviewPassCount: 1 }),
      'room-c': room('room-c', { finalPass: false, state: UNREVIEWED, reviewPassCount: 0 }),
    };
    const reviewableRoomIds = ['room-a', 'room-b'];
    const roomIds = ['room-a', 'room-b', 'room-c'];

    const analytics = summarizeReviewAnalytics({
      rooms,
      reviewableRoomIds,
      currentReviewStreak: 0,
      longestReviewStreak: 0,
    });
    const progress = summarizeReviewPassProgress({ rooms, reviewableRoomIds, roomIds });

    // `fullReviewPasses` still counts over the reviewable rooms: 2 / 2 = 1.
    expect(analytics.fullReviewPasses).toBe(1);
    expect(progress.fullReviewPasses).toBe(analytics.fullReviewPasses);
    expect(progress.nextPassTarget).toBe(analytics.fullReviewPasses + 1);

    // `roomsTowardNextPass` still counts over every room against every room, so
    // the HUD's `1/3`-style pair can never reach its denominator here. That is
    // the documented behaviour change *deferred*: correcting the denominator is a
    // Phase 18 decision with a dashboard change attached to it, and this phase
    // changes no displayed number.
    expect(progress.totalRooms).toBe(3);
    expect(progress.roomsTowardNextPass).toBe(0);
    expect(progress.roomsTowardNextPass).toBeLessThan(progress.totalRooms);
  });

  it('summarizeReviewAnalytics is left exactly as Phase 18 inherited it', () => {
    // The guard that keeps this phase from silently redefining a statistics input.
    const rooms = { 'room-a': room('room-a', { reviewPassCount: 3 }) };
    const analytics = summarizeReviewAnalytics({
      rooms,
      reviewableRoomIds: ['room-a'],
      currentReviewStreak: 2,
      longestReviewStreak: 5,
    });
    expect(analytics.reviewSessionCount).toBe(3);
    expect(analytics.fullReviewPasses).toBe(3);
    expect(analytics.reviewedRoomCount).toBe(1);
    expect(analytics.totalReviewableRooms).toBe(1);
    expect(analytics.currentReviewStreak).toBe(2);
  });

  it('collectReviewableRoomIds enumerates in dungeon order', () => {
    const d = dungeon(['room-a', 'room-b', 'room-c']);
    const rooms = {
      'room-a': room('room-a'),
      'room-b': room('room-b', { finalPass: false, state: UNREVIEWED }),
      'room-c': room('room-c'),
    };
    expect(collectReviewableRoomIds({ dungeon: d, rooms })).toEqual(['room-a', 'room-c']);
  });

  it('derives the whole snapshot from a dungeon and a room map', () => {
    const d = dungeon(['room-a', 'room-b']);
    const rooms = { 'room-a': room('room-a'), 'room-b': room('room-b') };
    const progress = deriveReviewPassProgress({ dungeon: d, rooms });
    expect(progress.totalRooms).toBe(2);
    expect(currentReviewPassNumber(progress)).toBe(1);
  });
});

// ── Due state ───────────────────────────────────────────────────────────────

describe('describeReviewDueState', () => {
  it('reads an unscheduled room as due with no days, rather than inventing one', () => {
    expect(describeReviewDueState({ nextReviewDateIso: null, nowIso: NOW })).toEqual({
      kind: 'due-in',
      days: 0,
    });
    expect(describeReviewDueState({ nextReviewDateIso: '  ', nowIso: NOW })).toEqual({
      kind: 'due-in',
      days: 0,
    });
  });

  it('reads a schedule in the future as due-in', () => {
    expect(
      describeReviewDueState({ nextReviewDateIso: '2026-04-09T09:00:00.000Z', nowIso: NOW }),
    ).toEqual({ kind: 'due-in', days: 5 });
  });

  it('reads the same calendar day as due-today, even when the time has passed', () => {
    expect(
      describeReviewDueState({ nextReviewDateIso: '2026-04-04T01:00:00.000Z', nowIso: NOW }),
    ).toEqual({ kind: 'due-today', days: 0 });
  });

  it('reads an earlier day as overdue, with the day count', () => {
    expect(
      describeReviewDueState({ nextReviewDateIso: '2026-04-01T12:00:00.000Z', nowIso: NOW }),
    ).toEqual({ kind: 'overdue', days: 3 });
  });

  it('agrees with spacedRepetition on the same inputs', () => {
    // The regression guard for "do not reimplement SM-2's date comparison".
    // `daysSinceReviewDue` shares `daysUntilReview`'s `ceil(diff / 86_400_000)`
    // rule, so a partial day rounds *up* on both sides of the comparison.
    const past = '2026-04-01T12:00:00.000Z';
    const future = '2026-04-20T12:00:00.000Z';
    expect(
      describeReviewDueState({ nextReviewDateIso: past, nowIso: NOW }),
    ).toEqual({ kind: 'overdue', days: 3 });
    expect(describeReviewDueState({ nextReviewDateIso: future, nowIso: NOW })).toEqual({
      kind: 'due-in',
      days: 16,
    });
  });
});

// ── Unlock ──────────────────────────────────────────────────────────────────

describe('canReviewRoom', () => {
  const fullyCleared = {
    dungeon: dungeon(['room-a', 'room-b']),
    rooms: { 'room-a': room('room-a'), 'room-b': room('room-b') },
  };
  const partiallyCleared = {
    dungeon: dungeon(['room-a', 'room-b']),
    rooms: {
      'room-a': room('room-a'),
      'room-b': room('room-b', { finalPass: false, state: UNREVIEWED }),
    },
  };

  it('allows a cleared room once the unlock ratio is reached', () => {
    const permission = canReviewRoom({ ...fullyCleared, roomId: 'room-a' });
    expect(permission.allowed).toBe(true);
    expect(permission.unlock.unlocked).toBe(true);
  });

  it('refuses a locked dungeon, reporting the same numbers RoomPanel renders', () => {
    const permission = canReviewRoom({ ...partiallyCleared, roomId: 'room-a' });
    expect(permission.allowed).toBe(false);
    if (permission.allowed) throw new Error('expected a refusal');
    expect(permission.reason).toBe('review-locked');
    expect(permission.unlock).toEqual(
      evaluateReviewUnlock({ dungeon: partiallyCleared.dungeon, rooms: partiallyCleared.rooms }),
    );
    expect(permission.unlock.clearedRooms).toBe(1);
    expect(permission.unlock.totalRooms).toBe(2);
  });

  it('reports room-not-cleared ahead of review-locked, because it is more specific', () => {
    const permission = canReviewRoom({ ...partiallyCleared, roomId: 'room-b' });
    expect(permission.allowed).toBe(false);
    if (permission.allowed) throw new Error('expected a refusal');
    expect(permission.reason).toBe('room-not-cleared');
  });

  it('refuses a room the snapshot does not list', () => {
    const permission = canReviewRoom({ ...fullyCleared, roomId: 'synthetic-room-that-was-deleted' });
    expect(permission.allowed).toBe(false);
    if (permission.allowed) throw new Error('expected a refusal');
    expect(permission.reason).toBe('room-not-cleared');
  });

  it('honours an explicit required ratio through the one evaluation', () => {
    const permission = canReviewRoom({
      ...partiallyCleared,
      roomId: 'room-a',
      requiredCompletionRatio: 0.5,
    });
    expect(permission.allowed).toBe(true);
    expect(permission.unlock.requiredCompletionRatio).toBe(0.5);
  });

  it('is the same call the room panel makes', () => {
    // One implementation: the enforced answer is byte-equal to the displayed one.
    const enforced = canReviewRoom({ ...partiallyCleared, roomId: 'room-a' });
    const displayed = evaluateReviewUnlock({
      dungeon: partiallyCleared.dungeon,
      rooms: partiallyCleared.rooms,
    });
    expect(enforced.unlock).toEqual(displayed);
  });
});

describe('describeReviewRefusal', () => {
  it('says what to do about an undefeated encounter', () => {
    const text = describeReviewRefusal({
      reason: 'room-not-cleared',
      unlock: { clearedRooms: 0, totalRooms: 3 } as never,
    });
    expect(text).toBe('Defeat this room encounter before reviewing it.');
  });

  it('says how far the unlock is, and never names a room', () => {
    const text = describeReviewRefusal({
      reason: 'review-locked',
      unlock: { clearedRooms: 1, totalRooms: 3 } as never,
    });
    expect(text).toContain('3/3');
    expect(text).toContain('1 so far');
    expect(text).not.toContain('synthetic');
  });

  it('pins the default-ratio sentence, character for character', () => {
    // `RoomPanel` and `studyFlow.pushReviewRefusedToast` both surface this string, so a
    // copy change has to be a deliberate one. At the default
    // `requiredCompletionRatio: 1` it must not move.
    expect(
      describeReviewRefusal({
        reason: 'review-locked',
        unlock: { clearedRooms: 1, totalRooms: 3, requiredCompletionRatio: 1 } as never,
      }),
    ).toBe('Review unlocks at 3/3 rooms cleared (1 so far).');
  });

  it('derives the threshold from the ratio rather than repeating the total', () => {
    // Ten rooms, half required, three cleared. The hardcoded `${total}/${total}` read
    // as "Review unlocks at 10/10 rooms cleared (3 so far)" - telling the learner they
    // needed all ten when five would open review.
    expect(
      describeReviewRefusal({
        reason: 'review-locked',
        unlock: { clearedRooms: 3, totalRooms: 10, requiredCompletionRatio: 0.5 } as never,
      }),
    ).toBe('Review unlocks at 5/10 rooms cleared (3 so far).');
  });

  /**
   * The invariant, asserted across ratios rather than one hand-picked number.
   *
   * The number the sentence prints is exactly the smallest cleared-room count at
   * which the *shared* predicate reports `unlocked`. `round` or `floor` would
   * produce a sentence the learner can satisfy while still being refused - `0.24`
   * on ten rooms is the case that shows it, needing three rooms and rounding to two.
   */
  it('names the exact count at which the shared unlock fires, at every ratio', () => {
    const roomIds = Array.from({ length: 10 }, (_, index) => `room-${index}`);
    const subjectDungeon = dungeon(roomIds);
    const roomsWith = (cleared: number): Record<string, RoomMetadata> =>
      Object.fromEntries(
        roomIds.map((roomId, index) => [
          roomId,
          index < cleared ? room(roomId) : room(roomId, { finalPass: false, state: UNREVIEWED }),
        ]),
      );

    for (const ratio of [0.1, 0.24, 0.5, 0.75, 1]) {
      const unlockAt = (cleared: number): ReviewUnlockStatus =>
        evaluateReviewUnlock({
          dungeon: subjectDungeon,
          rooms: roomsWith(cleared),
          requiredCompletionRatio: ratio,
        });

      // The smallest cleared count the shared predicate accepts, found by asking it.
      const smallestUnlocking = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((cleared) =>
        unlockAt(cleared).unlocked,
      );
      expect(smallestUnlocking).toBe(Math.ceil(ratio * roomIds.length));

      // One room short of it: locked, so the sentence is the one a learner sees.
      const clearedSoFar = (smallestUnlocking ?? 1) - 1;
      expect(unlockAt(clearedSoFar).unlocked).toBe(false);
      expect(
        describeReviewRefusal({ reason: 'review-locked', unlock: unlockAt(clearedSoFar) }),
      ).toBe(
        `Review unlocks at ${smallestUnlocking}/${roomIds.length} rooms cleared (${clearedSoFar} so far).`,
      );
    }
  });
});
