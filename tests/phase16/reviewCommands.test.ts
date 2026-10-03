/**
 * Phase 16: the interrupted-review marker and the review command layer.
 *
 * The command tests are the ones that matter for the phase's exit criteria:
 * same-tick double dispatch, a repeat across a reload, a locked refusal, a save
 * that must not advance SM-2, a discard that must award nothing, and a resume
 * that must report honestly.
 *
 * Every fixture below is obviously synthetic: `synthetic-*` ids and
 * `Synthetic *` topics, no learner data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyInterruptedReviewSessionWrite,
  clearInterruptedReviewSessionFromFields,
  emptyInterruptedReviewSession,
  INTERRUPTED_REVIEW_SESSION_KEY,
  isInterruptedReviewSessionForRoom,
  readInterruptedReviewSession,
  readInterruptedReviewSessionFromFields,
  writeInterruptedReviewSessionToFields,
  type InterruptedReviewSession,
} from '@/core/review/interruptedReviewSession';
import {
  createReviewController,
  type ReviewCommandDeps,
  type ReviewProgressionPort,
  type ReviewSubjectStorePort,
} from '@/application/reviewCommands';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { updateSm2State, type QualityRating } from '@/core/review/spacedRepetition';

const SUBJECT_ID = 'synthetic-review-subject';
const ROOM_A = 'synthetic-review-room-a';
const ROOM_B = 'synthetic-review-room-b';
const NOW = '2026-05-05T05:05:05.000Z';
const LATER = '2026-05-06T06:06:06.000Z';

// ── The pure marker ─────────────────────────────────────────────────────────

describe('interruptedReviewSession - persistence shape', () => {
  const session: InterruptedReviewSession = {
    version: 1,
    roomId: ROOM_A,
    passNumber: 2,
    startedAt: NOW,
    savedAt: LATER,
    qualityRating: 4,
  };

  it('has no session when there is nothing to resume', () => {
    expect(emptyInterruptedReviewSession()).toBeNull();
    expect(readInterruptedReviewSessionFromFields(undefined)).toBeNull();
    expect(readInterruptedReviewSessionFromFields({})).toBeNull();
  });

  it('reads a malformed or truncated value as no session, not as a placeholder', () => {
    expect(readInterruptedReviewSession(undefined)).toBeNull();
    expect(readInterruptedReviewSession('nope')).toBeNull();
    expect(readInterruptedReviewSession({ roomId: '' })).toBeNull();
    expect(readInterruptedReviewSession({ roomId: ROOM_A })).toBeNull();
    expect(readInterruptedReviewSession({ roomId: ROOM_A, passNumber: 0 })).toBeNull();
    expect(readInterruptedReviewSession({ roomId: ROOM_A, passNumber: -3 })).toBeNull();
  });

  it('round-trips a session, defaulting savedAt to startedAt', () => {
    expect(readInterruptedReviewSession(session)).toEqual(session);
    expect(
      readInterruptedReviewSession({
        roomId: ROOM_A,
        passNumber: 1,
        startedAt: NOW,
        qualityRating: 9,
      }),
    ).toEqual({
      version: 1,
      roomId: ROOM_A,
      passNumber: 1,
      startedAt: NOW,
      savedAt: NOW,
      // Out of range: read as "no rating", never clamped into a real rating.
      qualityRating: null,
    });
  });

  it('writes and removes its own key only, carrying every other field through', () => {
    const fields = writeInterruptedReviewSessionToFields(
      { reviewPassRewardLedger: { version: 1, entries: [] }, laterPhase: 'kept' },
      session,
    );
    expect(fields[INTERRUPTED_REVIEW_SESSION_KEY]).toEqual(session);
    expect(fields.reviewPassRewardLedger).toEqual({ version: 1, entries: [] });
    expect(fields.laterPhase).toBe('kept');

    const cleared = clearInterruptedReviewSessionFromFields(fields);
    expect(INTERRUPTED_REVIEW_SESSION_KEY in cleared).toBe(false);
    expect(cleared.laterPhase).toBe('kept');
    expect(cleared.reviewPassRewardLedger).toEqual({ version: 1, entries: [] });
  });

  it('leaves the record shape untouched when there was no marker to clear', () => {
    const fields = { laterPhase: 'kept' };
    expect(clearInterruptedReviewSessionFromFields(fields)).toEqual(fields);
    expect(clearInterruptedReviewSessionFromFields(undefined)).toEqual({});
  });

  it('uses a static-vocabulary carrier key', () => {
    expect(INTERRUPTED_REVIEW_SESSION_KEY).toBe('interruptedReviewSession');
  });

  it('matches a room only when the marker names it', () => {
    expect(isInterruptedReviewSessionForRoom(session, ROOM_A)).toBe(true);
    expect(isInterruptedReviewSessionForRoom(session, ROOM_B)).toBe(false);
    expect(isInterruptedReviewSessionForRoom(null, ROOM_A)).toBe(false);
  });

  it('never lets a discard remove another room\'s session', () => {
    const fields = writeInterruptedReviewSessionToFields(undefined, session);
    const afterOtherDiscard = applyInterruptedReviewSessionWrite(fields, {
      kind: 'discard',
      roomId: ROOM_B,
    });
    expect(readInterruptedReviewSessionFromFields(afterOtherDiscard)).toEqual(session);

    const afterOwnDiscard = applyInterruptedReviewSessionWrite(fields, {
      kind: 'discard',
      roomId: ROOM_A,
    });
    expect(readInterruptedReviewSessionFromFields(afterOwnDiscard)).toBeNull();
  });
});

// ── The review command layer ────────────────────────────────────────────────

function room(
  roomId: string,
  overrides: { finalPass?: boolean; state?: string; reviewPassCount?: number } = {},
): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: (overrides.state ?? 'ArtifactCollected') as RoomMetadata['state'],
    validationState: { ...makeEmptyValidationState(), finalPass: overrides.finalPass ?? true },
    reviewPassCount: overrides.reviewPassCount ?? 0,
  };
}

function dungeon(roomIds: readonly string[]): DungeonMetadata {
  return {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: 'Synthetic Review Subject',
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

interface Harness {
  deps: ReviewCommandDeps;
  controller: ReturnType<typeof createReviewController>;
  state: {
    snapshot: SubjectSnapshot | null;
    extraFields: Record<string, unknown> | undefined;
    recordReviewPass: ReturnType<typeof vi.fn>;
    awardReviewPass: ReturnType<typeof vi.fn>;
    writeReviewSession: ReturnType<typeof vi.fn>;
    clock: { now: string };
    sm2Calls: Array<{ roomId: string; qualityRating: QualityRating }>;
    /** Simulate a progression store with no active subject to pay. */
    noActiveProgressionSubject: boolean;
  };
  /** Simulate a reload: the snapshot and the preserved fields are re-read. */
  reload(): void;
}

/**
 * Build the controller over in-memory ports.
 *
 * The "progression record" is a single object mutated in place by both the reward
 * port and the marker port, which is what makes the same-tick and reload cases
 * below real tests rather than assertions about call counts.
 */
function createHarness(
  options: { snapshot?: SubjectSnapshot | null } = {},
): Harness {
  const state = {
    snapshot: options.snapshot === undefined ? null : options.snapshot,
    extraFields: undefined as Record<string, unknown> | undefined,
    recordReviewPass: vi.fn(),
    awardReviewPass: vi.fn(),
    writeReviewSession: vi.fn(),
    clock: { now: NOW },
    sm2Calls: [] as Array<{ roomId: string; qualityRating: QualityRating }>,
    noActiveProgressionSubject: false,
  };

  const subject: ReviewSubjectStorePort = {
    readSnapshot: () => state.snapshot,
    recordReviewPass: (roomId, qualityRating) => {
      state.sm2Calls.push({ roomId, qualityRating });
      return Promise.resolve();
    },
  };

  const progression: ReviewProgressionPort = {
    awardReviewPass: (review) => {
      state.awardReviewPass(review);
      if (state.noActiveProgressionSubject) {
        return {
          awarded: false,
          duplicate: false,
          xpGained: 0,
          newRank: 'Novice',
          rankChanged: false,
          unlockedAchievements: [],
        };
      }
      const ledger = readLedger(state.extraFields);
      const already = ledger.entries.some(
        (entry) => entry.roomId === review.roomId && entry.passNumber === review.passNumber,
      );
      if (already) {
        return {
          awarded: false,
          duplicate: true,
          xpGained: 0,
          newRank: 'Novice',
          rankChanged: false,
          unlockedAchievements: [],
        };
      }
      state.extraFields = applyInterruptedReviewSessionWrite(
        {
          ...(state.extraFields ?? {}),
          reviewPassRewardLedger: {
            version: 1,
            entries: [{ ...review, awardedAt: state.clock.now }, ...ledger.entries],
          },
        },
        // The real store clears this room's marker in the same record write.
        { kind: 'discard', roomId: review.roomId },
      );
      return {
        awarded: true,
        duplicate: false,
        xpGained: 6,
        newRank: 'Novice',
        rankChanged: false,
        unlockedAchievements: [],
      };
    },
    readPreservedFields: () => state.extraFields,
    writeReviewSession: (write) => {
      state.writeReviewSession(write);
      state.extraFields = applyInterruptedReviewSessionWrite(state.extraFields, write);
    },
  };

  const deps: ReviewCommandDeps = {
    subject,
    progression,
    nowIso: () => state.clock.now,
  };

  return {
    deps,
    controller: createReviewController(deps),
    state,
    reload() {
      // A reload keeps the persisted record and loses nothing else.
      state.snapshot = state.snapshot === null ? null : { ...state.snapshot };
    },
  };
}

function readLedger(
  extraFields: Record<string, unknown> | undefined,
): { entries: Array<{ roomId: string; passNumber: number }> } {
  const raw = extraFields?.reviewPassRewardLedger as
    | { entries?: Array<{ roomId: string; passNumber: number }> }
    | undefined;
  return { entries: raw?.entries ?? [] };
}

function fullyCleared(counts: Record<string, number> = {}): SubjectSnapshot {
  const roomIds = [ROOM_A, ROOM_B];
  return {
    dungeon: dungeon(roomIds),
    rooms: {
      [ROOM_A]: room(ROOM_A, { reviewPassCount: counts[ROOM_A] ?? 0 }),
      [ROOM_B]: room(ROOM_B, { reviewPassCount: counts[ROOM_B] ?? 0 }),
    },
  };
}

/** Every room cleared once, so `fullReviewPasses` is 1 and the target is 2. */
function onePassDone(): SubjectSnapshot {
  return fullyCleared({ [ROOM_A]: 1, [ROOM_B]: 1 });
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ snapshot: fullyCleared() });
});

describe('review/pass-complete', () => {
  it('takes the reward once, records SM-2, and reports the post-review pass progress', () => {
    const result = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an outcome');
    expect(result.value.progression).toMatchObject({
      awarded: true,
      duplicate: false,
      xpGained: 6,
    });
    expect(result.value.qualityRating).toBe(4);
    expect(result.value.reviewIdentity).toMatchObject({ roomId: ROOM_A, passNumber: 1 });
    expect(result.value.passProgress).toEqual({
      fullReviewPasses: 0,
      nextPassTarget: 1,
      roomsTowardNextPass: 1,
      totalRooms: 2,
      reviewedRoomIds: [ROOM_A],
    });
  });

  it('two same-tick calls award exactly once', () => {
    const first = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });
    const second = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 5 });

    expect(first.ok && first.value.progression.awarded).toBe(true);
    expect(second.ok && second.value.progression.awarded).toBe(false);
    // The discriminator a caller needs in order not to announce a reward twice.
    expect(second.ok && second.value.progression.duplicate).toBe(true);
    expect(readLedger(harness.state.extraFields).entries).toHaveLength(1);
  });

  it('a repeat after a reload awards nothing', () => {
    const first = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });
    harness.reload();

    const second = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(first.ok && first.value.progression.awarded).toBe(true);
    expect(second.ok && second.value.progression.awarded).toBe(false);
    expect(second.ok && second.value.progression.duplicate).toBe(true);
    expect(readLedger(harness.state.extraFields).entries).toHaveLength(1);
  });

  it('a genuine next pass awards again', () => {
    harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });
    harness.state.snapshot = onePassDone();

    const nextPass = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(nextPass.ok).toBe(true);
    if (!nextPass.ok) throw new Error('expected an outcome');
    expect(nextPass.value.reviewIdentity.passNumber).toBe(2);
    expect(nextPass.value.progression.awarded).toBe(true);
    expect(readLedger(harness.state.extraFields).entries).toHaveLength(2);
  });

  it('passes the learner rating through to the SM-2 write', () => {
    const result = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 0 });

    expect(result.ok).toBe(true);
    expect(harness.state.sm2Calls).toEqual([{ roomId: ROOM_A, qualityRating: 0 }]);
  });

  it('a suppressed award writes no SM-2 state, so a retry cannot inflate a badge', () => {
    harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });
    harness.state.sm2Calls.length = 0;

    const repeat = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    // `reviewPassCount` feeds `fullReviewPasses`, which is a badge threshold, so a
    // duplicate close that incremented it would inflate a badge and walk the pass
    // number forward. One (room, pass) is recorded once.
    expect(repeat.ok && repeat.value.progression.duplicate).toBe(true);
    expect(harness.state.sm2Calls).toHaveLength(0);
    expect(readLedger(harness.state.extraFields).entries).toHaveLength(1);
  });

  it('a refused or suppressed-by-subject reward still records the recall', () => {
    // `awarded: false, duplicate: false` is "there was no active subject to pay",
    // not "this review did not happen": the learner did recall the room, so SM-2
    // moves and only the payment is missing.
    harness.state.noActiveProgressionSubject = true;

    const result = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(result.ok && result.value.progression.awarded).toBe(false);
    expect(harness.state.sm2Calls).toEqual([{ roomId: ROOM_A, qualityRating: 4 }]);
  });

  it('clears a resumable marker for the same room in the same transaction', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: null });
    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)).not.toBeNull();

    const result = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(result.ok && result.value.resumedSessionDiscarded).toBe(true);
    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)).toBeNull();
  });

  it('leaves another room\'s marker alone', () => {
    harness.controller.sessionSave({ roomId: ROOM_B, qualityRating: null });

    harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)?.roomId).toBe(ROOM_B);
  });

  it('dispatches through the tagged union to the same runner', () => {
    const result = harness.controller.dispatch({
      type: 'review/pass-complete',
      payload: { roomId: ROOM_A, qualityRating: 5 },
    });
    expect(result.ok).toBe(true);
    expect(harness.state.sm2Calls).toEqual([{ roomId: ROOM_A, qualityRating: 5 }]);
  });
});

describe('review commands - refusals', () => {
  it('refuses with NO_ACTIVE_SUBJECT when nothing is loaded', () => {
    harness.state.snapshot = null;

    const result = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(result).toEqual({
      ok: false,
      error: { code: 'NO_ACTIVE_SUBJECT', message: 'No active subject' },
    });
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
  });

  it('refuses with ROOM_NOT_FOUND for a room the snapshot does not list', () => {
    const result = harness.controller.passComplete({
      roomId: 'synthetic-room-that-was-deleted',
      qualityRating: 4,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('ROOM_NOT_FOUND');
    expect(result.error.details).toEqual({ roomId: 'synthetic-room-that-was-deleted' });
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
  });

  it('refuses a room that has not been cleared, even in a fully cleared dungeon', () => {
    harness.state.snapshot = {
      dungeon: dungeon([ROOM_A, ROOM_B]),
      rooms: {
        [ROOM_A]: room(ROOM_A),
        [ROOM_B]: room(ROOM_B, { finalPass: false, state: 'Created' }),
      },
    };

    const result = harness.controller.passComplete({ roomId: ROOM_B, qualityRating: 4 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('ROOM_NOT_REVIEWABLE');
    expect(result.error.message).toBe('Defeat this room encounter before reviewing it.');
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
  });

  it('refuses a cleared room while the dungeon completion ratio has not unlocked review', () => {
    harness.state.snapshot = {
      dungeon: dungeon([ROOM_A, ROOM_B, 'synthetic-review-room-c']),
      rooms: {
        [ROOM_A]: room(ROOM_A),
        [ROOM_B]: room(ROOM_B),
        'synthetic-review-room-c': room('synthetic-review-room-c', {
          finalPass: false,
          state: 'Created',
        }),
      },
    };

    const result = harness.controller.passComplete({ roomId: ROOM_A, qualityRating: 4 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('REVIEW_LOCKED');
    expect(result.error.message).toBe('Clear every room encounter to unlock full review mode.');
    expect(result.error.details).toEqual({
      roomId: ROOM_A,
      clearedRooms: 2,
      totalRooms: 3,
    });
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
    expect(harness.state.sm2Calls).toHaveLength(0);
  });

  it('refuses a session save for a locked dungeon too, so no marker is written', () => {
    harness.state.snapshot = {
      dungeon: dungeon([ROOM_A, ROOM_B]),
      rooms: {
        [ROOM_A]: room(ROOM_A),
        [ROOM_B]: room(ROOM_B, { finalPass: false, state: 'Created' }),
      },
    };

    const result = harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: null });

    expect(result.ok).toBe(false);
    expect(harness.state.writeReviewSession).not.toHaveBeenCalled();
  });
});

describe('review/session-save', () => {
  it('writes a resumable marker and nothing else', () => {
    const result = harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an outcome');
    expect(result.value.session).toEqual({
      version: 1,
      roomId: ROOM_A,
      passNumber: 1,
      startedAt: NOW,
      savedAt: NOW,
      qualityRating: 2,
    });
    expect(result.value.progression).toBeNull();
    // The two things a save must not do.
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
    expect(harness.state.sm2Calls).toHaveLength(0);
  });

  it('does not advance SM-2 for an unrated save', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: null });
    expect(harness.state.sm2Calls).toHaveLength(0);
    // And SM-2 is reachable and unchanged for the same inputs: a rating of 5 from
    // `updateSm2State` still gives the canonical first interval, so the command's
    // refusal to write is the only reason nothing moved.
    const sm2 = updateSm2State({ quality: 5, previousState: null, reviewedAtIso: NOW });
    expect(sm2.intervalDays).toBe(1);
    expect(sm2.consecutiveCorrect).toBe(1);
  });

  it('keeps the original start time across a re-save and refreshes savedAt', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: 1 });
    harness.state.clock.now = LATER;

    const again = harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: 3 });

    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('expected an outcome');
    expect(again.value.session.startedAt).toBe(NOW);
    expect(again.value.session.savedAt).toBe(LATER);
    expect(again.value.session.qualityRating).toBe(3);
  });

  it('records the pass the session was started in', () => {
    harness.state.snapshot = onePassDone();
    const result = harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: null });
    expect(result.ok && result.value.session.passNumber).toBe(2);
  });

  it('survives a reload', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: 4 });
    harness.reload();
    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)).not.toBeNull();
  });
});

describe('review/session-discard', () => {
  it('removes the marker, awards nothing, and writes no SM-2 state', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: 4 });

    const result = harness.controller.sessionDiscard({ roomId: ROOM_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an outcome');
    expect(result.value.discarded).toBe(true);
    expect(result.value.keptForOtherRoom).toBeNull();
    expect(result.value.progression).toBeNull();
    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)).toBeNull();
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
    expect(harness.state.sm2Calls).toHaveLength(0);
  });

  it('leaves no resumable marker when there was nothing to discard', () => {
    const result = harness.controller.sessionDiscard({ roomId: ROOM_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an outcome');
    expect(result.value.discarded).toBe(false);
    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)).toBeNull();
  });

  it('refuses an unknown room rather than discarding nothing successfully', () => {
    const result = harness.controller.sessionDiscard({
      roomId: 'synthetic-room-that-was-deleted',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('reports another room\'s marker as kept', () => {
    harness.controller.sessionSave({ roomId: ROOM_B, qualityRating: null });

    const result = harness.controller.sessionDiscard({ roomId: ROOM_A });

    expect(result.ok && result.value.discarded).toBe(false);
    expect(result.ok && result.value.keptForOtherRoom?.roomId).toBe(ROOM_B);
    expect(readInterruptedReviewSessionFromFields(harness.state.extraFields)?.roomId).toBe(ROOM_B);
  });
});

describe('review/session-resume', () => {
  it('reports a session that existed, and writes nothing', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: 5 });
    harness.state.writeReviewSession.mockClear();

    const result = harness.controller.sessionResume({ roomId: ROOM_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an outcome');
    expect(result.value.resumed).toBe(true);
    expect(result.value.session?.qualityRating).toBe(5);
    expect(result.value.waitingForRoomId).toBeNull();
    expect(result.value.progression).toBeNull();
    expect(harness.state.writeReviewSession).not.toHaveBeenCalled();
    expect(harness.state.awardReviewPass).not.toHaveBeenCalled();
  });

  it('reports no session for a room that has none', () => {
    const result = harness.controller.sessionResume({ roomId: ROOM_A });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected an outcome');
    expect(result.value.resumed).toBe(false);
    expect(result.value.session).toBeNull();
  });

  it('says which room is waiting when the marker names another one', () => {
    harness.controller.sessionSave({ roomId: ROOM_B, qualityRating: null });

    const result = harness.controller.sessionResume({ roomId: ROOM_A });

    expect(result.ok && result.value.resumed).toBe(false);
    expect(result.ok && result.value.waitingForRoomId).toBe(ROOM_B);
  });

  it('refuses an unknown room', () => {
    const result = harness.controller.sessionResume({ roomId: 'synthetic-room-that-was-deleted' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('dispatches through the tagged union to the same runner', () => {
    harness.controller.sessionSave({ roomId: ROOM_A, qualityRating: null });
    const result = harness.controller.dispatch({
      type: 'review/session-resume',
      payload: { roomId: ROOM_A },
    });
    expect(result.ok && result.value.command === 'review/session-resume' && result.value.resumed).toBe(
      true,
    );
  });
});
