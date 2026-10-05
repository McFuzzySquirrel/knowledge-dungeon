/**
 * Phase 18: the published statistics metrics.
 *
 * The metrics module is the **only** implementation of every number the dashboard shows, so
 * these tests are the gate on what that dashboard can claim. They come in three groups:
 *
 * 1. **The corrected metrics.** Each one starts from the pre-Phase-18 value, states the defect
 *    it replaces, and asserts a real computed number.
 * 2. **The mastery rule**, which replaces a flag nothing ever set.
 * 3. **The snapshot's shape**, because a surface reads it and a field that is missing or
 *    `NaN` is a crash in someone else's panel.
 *
 * ## No tautologies
 *
 * Every number asserted here is a literal the reader computed by hand from the fixture, or a
 * value computed from two independently-derived quantities. There is no
 * `expect(NaN).toBe(NaN)`, no `Number(...)`-round-trip of a stringified metric, and no
 * comparison of a value to itself after a coercion.
 */
import { describe, expect, it } from 'vitest';
import {
  computeStatisticsSnapshot,
  deriveSubjectMastery,
  emptyStatisticsSnapshot,
  type StatisticsSessionRecord,
  type SubjectStatisticsInput,
} from '@/core/statistics/statisticsMetrics';
import {
  toFishingOutcomeEvent,
  toNoteSubmissionEvent,
  toReviewCompletionEvent,
  toXpAwardEvent,
  noteSubmissionEventSourceIdentity,
  reviewCompletionEventSourceIdentity,
  fishingOutcomeEventSourceIdentity,
  type StatisticsEvent,
} from '@/core/statistics/statisticsEvents';
import {
  makeDefaultSubjectProgression,
  type CanonicalSubjectProgressionWriteShape,
} from '@/core/progression/canonicalProgression';
import { writeRoomClearRewardLedgerToFields } from '@/core/progression/roomClearRewards';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { normalizeProgressionRecord } from '@/core/progression/canonicalProgression';
import type { Sm2State } from '@/core/review';

const SUBJECT = 'synthetic-phase18-subject';
const SUBJECT_B = 'synthetic-phase18-subject-b';
const DAY = '2026-06-05';
const PREVIOUS_DAY = '2026-06-04';
const AT = `${DAY}T09:00:00.000Z`;

/** Local noon on `DAY`, as the calendar module would resolve it in a UTC device. */
function noonOn(day: string, offsetMinutes = 0): string {
  // Constructed through UTC arithmetic so the fixture does not depend on the machine's zone;
  // `localDateKey` in the machine's zone then agrees for a mid-day instant, which is what the
  // metric asserts. The zone-sensitive behaviour itself is pinned in `localCalendar.test.ts`.
  const [year, month, date] = day.split('-').map(Number);
  const base = Date.UTC(year, month - 1, date, 12);
  return new Date(base + offsetMinutes * 60_000).toISOString();
}

function session(overrides: Partial<StatisticsSessionRecord> = {}): StatisticsSessionRecord {
  return {
    sessionId: 'synthetic-session-1',
    subjectId: SUBJECT,
    subjectName: 'Synthetic Phase 18 Subject',
    startedAt: noonOn(DAY),
    endedAt: noonOn(DAY, 30),
    roomsVisited: ['room-1'],
    notesSubmitted: 0,
    reviewsCompleted: 0,
    xpEarned: 0,
    ...overrides,
  };
}

function room(roomId: string, options: { finalPass?: boolean; reviewPassCount?: number; sm2?: Partial<Sm2State> } = {}): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: AT }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: options.finalPass ?? true },
    reviewPassCount: options.reviewPassCount ?? 0,
    ...(options.sm2 === undefined ? {} : { sm2State: options.sm2 as Sm2State }),
  };
}

function snapshotOf(rooms: Record<string, RoomMetadata>): SubjectSnapshot {
  const roomIds = Object.keys(rooms);
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT,
    subjectName: 'Synthetic Phase 18 Subject',
    createdAt: AT,
    updatedAt: AT,
    phaseState: 'ArchaeologistActive',
    rootRoomId: roomIds[0],
    rooms: roomIds.map((roomId) => ({ roomId, topic: `synthetic-topic-${roomId}`, status: 'ArtifactCollected' })),
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms };
}

function progressionOf(overrides: Partial<CanonicalSubjectProgressionWriteShape> = {}): CanonicalSubjectProgressionWriteShape {
  return { ...makeDefaultSubjectProgression(), ...overrides };
}

function subjectInput(overrides: Partial<SubjectStatisticsInput> = {}): SubjectStatisticsInput {
  return {
    subjectId: SUBJECT,
    subjectName: 'Synthetic Phase 18 Subject',
    snapshot: null,
    progression: null,
    events: [],
    ...overrides,
  };
}

// ── The corrected metrics ──────────────────────────────────────────────────

describe('study time', () => {
  it('sums elapsed time across closed sessions and rounds to whole minutes', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [
        // 12:00 -> 12:30: 30 minutes.
        session({ sessionId: 's1', startedAt: noonOn(DAY), endedAt: noonOn(DAY, 30) }),
        // 13:00 -> 13:45: 45 minutes.
        session({ sessionId: 's2', startedAt: noonOn(DAY, 60), endedAt: noonOn(DAY, 105) }),
      ],
      subjects: [],
      now: noonOn(DAY, 120),
    });
    expect(snapshot.totals.sessionsCompleted).toBe(2);
    // 30 + 45 = 75 minutes.
    expect(snapshot.totals.studyTimeMs).toBe(75 * 60_000);
    expect(snapshot.totals.studyTimeMinutes).toBe(75);
    // 75 / 2 = 37.5, which rounds to 38.
    expect(snapshot.totals.averageSessionMinutes).toBe(38);
    expect(snapshot.totals.longestSessionMinutes).toBe(45);
  });

  it('gives an open session no study time, and reports it as open', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ endedAt: null })],
      subjects: [],
      now: noonOn(DAY, 120),
    });
    expect(snapshot.totals.sessionsOpen).toBe(1);
    expect(snapshot.totals.sessionsCompleted).toBe(0);
    expect(snapshot.totals.studyTimeMs).toBe(0);
    expect(snapshot.totals.studyTimeMinutes).toBe(0);
  });

  it('reports zero for an average rather than NaN with no sessions', () => {
    const snapshot = computeStatisticsSnapshot({ sessions: [], subjects: [], now: noonOn(DAY) });
    expect(snapshot.totals.averageSessionMinutes).toBe(0);
    expect(snapshot.totals.longestSessionMinutes).toBe(0);
    expect(Number.isNaN(snapshot.totals.averageSessionMinutes)).toBe(false);
  });

  it('clamps a negative duration to zero rather than reporting negative study time', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ startedAt: noonOn(DAY, 60), endedAt: noonOn(DAY) })],
      subjects: [],
      now: noonOn(DAY, 120),
    });
    expect(snapshot.totals.studyTimeMs).toBe(0);
    expect(snapshot.totals.studyTimeMinutes).toBe(0);
  });

  it('rounds a day bucket PER SESSION, so three 40-second sessions read 3 minutes, not 2', () => {
    // The distinguishing case: per-session, each 40 seconds rounds to 1 minute, so three of
    // them read 3. Accumulating first, 120 seconds rounds to 2. Both are defensible answers;
    // per-session is the one published, and the assertion names the difference rather than
    // asserting a value both would agree on.
    const start = noonOn(DAY);
    const fortySeconds = new Date(Date.parse(start) + 40_000).toISOString();
    const snapshot = computeStatisticsSnapshot({
      sessions: Array.from({ length: 3 }, (_unused, index) =>
        session({ sessionId: `s${index}`, startedAt: start, endedAt: fortySeconds }),
      ),
      subjects: [],
      now: noonOn(DAY, 60),
      dailyActivityDays: 1,
    });
    expect(snapshot.dailyActivity).toHaveLength(1);
    expect(snapshot.dailyActivity[0].studyMinutes).toBe(3);
    // The device total is a separate, unrounded quantity: 120 seconds is 2 minutes, and a
    // device that studied for two minutes has not studied for three.
    expect(snapshot.totals.studyTimeMs).toBe(120_000);
    expect(snapshot.totals.studyTimeMinutes).toBe(2);
    expect(snapshot.totals.sessionsCompleted).toBe(3);
  });
});

describe('unique rooms visited - the metric that was neither unique nor a visit count', () => {
  it('counts a room once however many sessions entered it', () => {
    // The pre-Phase-18 `totalRoomsVisited` summed per-session array lengths and reported 5.
    const snapshot = computeStatisticsSnapshot({
      sessions: Array.from({ length: 5 }, (_unused, index) =>
        session({ sessionId: `s${index}`, roomsVisited: ['room-1'] }),
      ),
      subjects: [subjectInput()],
      now: noonOn(DAY),
    });
    expect(snapshot.totals.uniqueRoomsVisited).toBe(1);
    // The old number is still available, under the name it always deserved.
    expect(snapshot.totals.roomVisits).toBe(5);
  });

  it('counts the same room id in two subjects as two unique rooms', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [
        session({ sessionId: 's1', subjectId: SUBJECT, roomsVisited: ['room-1'] }),
        session({ sessionId: 's2', subjectId: SUBJECT_B, roomsVisited: ['room-1'] }),
      ],
      subjects: [subjectInput(), subjectInput({ subjectId: SUBJECT_B, subjectName: 'B' })],
      now: noonOn(DAY),
    });
    expect(snapshot.totals.uniqueRoomsVisited).toBe(2);
  });

  it('counts a subject that has sessions but no progression record', () => {
    // A subject the learner opened and left is still rooms they explored; keying this off the
    // progression rows would report zero for every brand-new subject.
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ subjectId: 'brand-new', roomsVisited: ['room-1', 'room-2'] })],
      subjects: [],
      now: noonOn(DAY),
    });
    expect(snapshot.totals.uniqueRoomsVisited).toBe(2);
  });

  it('reports per-subject room counts', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [
        session({ sessionId: 's1', roomsVisited: ['room-1', 'room-2'] }),
        session({ sessionId: 's2', roomsVisited: ['room-2'] }),
      ],
      subjects: [subjectInput()],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects[0].uniqueRoomsVisited).toBe(2);
    expect(snapshot.subjects[0].roomVisits).toBe(3);
  });
});

describe('notes, reviews, XP, and fish, read from the events', () => {
  function eventsOf(): StatisticsEvent[] {
    const noteIdentity = { roomId: 'room-1', clearIdentity: 'clear-a' };
    const reviewIdentity = { roomId: 'room-1', passNumber: 1, reviewIdentity: 'rpass-a' };
    const fishIdentity = { catalogId: 'moss-carp', contextId: 'ctx-1', castNumber: 1, catchIdentity: 'catch-a' };
    return [
      toNoteSubmissionEvent({ subjectId: SUBJECT, identity: noteIdentity, localDate: DAY, recordedAt: AT, xpAwarded: 28 }),
      toXpAwardEvent({
        subjectId: SUBJECT,
        source: 'note-submission',
        sourceIdentity: noteSubmissionEventSourceIdentity(noteIdentity),
        localDate: DAY,
        recordedAt: AT,
        amount: 28,
      }),
      toReviewCompletionEvent({ subjectId: SUBJECT, identity: reviewIdentity, localDate: DAY, recordedAt: AT, xpAwarded: 6 }),
      toXpAwardEvent({
        subjectId: SUBJECT,
        source: 'review-completion',
        sourceIdentity: reviewCompletionEventSourceIdentity(reviewIdentity),
        localDate: DAY,
        recordedAt: AT,
        amount: 6,
      }),
      toFishingOutcomeEvent({ subjectId: SUBJECT, identity: fishIdentity, localDate: DAY, recordedAt: AT, xpAwarded: 11 }),
      toXpAwardEvent({
        subjectId: SUBJECT,
        source: 'fishing-outcome',
        sourceIdentity: fishingOutcomeEventSourceIdentity(fishIdentity),
        localDate: DAY,
        recordedAt: AT,
        amount: 11,
      }),
    ];
  }

  it('counts each kind once and sums the XP awards', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ events: eventsOf() })],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.notesSubmitted).toBe(1);
    expect(snapshot.totals.reviewsCompleted).toBe(1);
    expect(snapshot.totals.xpEarned).toBe(45);
    expect(snapshot.totals.fishKept).toBe(1);
    expect(snapshot.totals.distinctFishSpecies).toBe(1);
  });

  it('reports the catalogue ids behind the distinct species count', () => {
    const identity = (catalogId: string, castNumber: number) => ({
      catalogId,
      contextId: 'ctx-1',
      castNumber,
      catchIdentity: `catch-${catalogId}-${castNumber}`,
    });
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({
          events: [
            toFishingOutcomeEvent({ subjectId: SUBJECT, identity: identity('lunar-trout', 1), localDate: DAY, recordedAt: AT, xpAwarded: 5 }),
            toFishingOutcomeEvent({ subjectId: SUBJECT, identity: identity('moss-carp', 2), localDate: DAY, recordedAt: AT, xpAwarded: 5 }),
            toFishingOutcomeEvent({ subjectId: SUBJECT, identity: identity('moss-carp', 3), localDate: DAY, recordedAt: AT, xpAwarded: 5 }),
          ],
        }),
      ],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.fishKept).toBe(3);
    expect(snapshot.totals.distinctFishSpecies).toBe(2);
    expect(snapshot.subjects[0].fishSpeciesCatalogIds).toEqual(['lunar-trout', 'moss-carp']);
  });

  it('does NOT sum the session counters, because the events are the authority', () => {
    // Both series agree for any session this build wrote, because the session counter only
    // moves when the durable reward ledger said the award happened. Asserting the ledger is
    // the authority means a legacy session's counters cannot inflate a total.
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ notesSubmitted: 99, reviewsCompleted: 99, xpEarned: 9999 })],
      subjects: [subjectInput({ events: [toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c' }, localDate: DAY, recordedAt: AT, xpAwarded: 28 })] })],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.notesSubmitted).toBe(1);
    expect(snapshot.totals.reviewsCompleted).toBe(0);
    expect(snapshot.totals.xpEarned).toBe(0);
    // The session's own row still carries its counters, so a session card can show them.
    expect(snapshot.recentSessions[0].notesSubmitted).toBe(99);
    // And the provenance block makes the divergence observable rather than silent.
    expect(snapshot.provenance.sessionsRead).toBe(1);
    expect(snapshot.provenance.subjectsWithEvents).toBe(1);
    expect(snapshot.provenance.sessionsBeforeEventLedger).toBe(0);
  });

  it('counts an event with a mangled date in the subject totals but places it on no day', () => {
    // A restored archive whose `localDate` was corrupted still counts as an event; it simply
    // cannot be placed on a calendar day. Dropping it would under-report the achievement.
    const mangled = { ...toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c' }, localDate: DAY, recordedAt: AT, xpAwarded: 5 }), localDate: 'not-a-day' };
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ events: [mangled] })],
      now: noonOn(DAY, 60),
      dailyActivityDays: 1,
    });
    expect(snapshot.totals.notesSubmitted).toBe(1);
    expect(snapshot.dailyActivity[0].notes).toBe(0);
    expect(snapshot.totals.activeDays).toBe(0);
  });
});

describe('subject mastery - replacing a flag nothing ever set', () => {
  it('is "untouched" with no rooms, and never "mastered" on absent evidence', () => {
    const mastery = deriveSubjectMastery({ totalRooms: 0, clearedRooms: 0, fullReviewPasses: 0 });
    expect(mastery.state).toBe('untouched');
    expect(mastery.mastered).toBe(false);
    expect(mastery.completionRatio).toBe(0);
    // Vacuous evidence is not evidence: every room cleared is vacuously true for no rooms.
    expect(mastery.mastered).not.toBe(true);
  });

  it('is "in-progress" while some rooms are uncleared, and never mastered', () => {
    const mastery = deriveSubjectMastery({ totalRooms: 4, clearedRooms: 2, fullReviewPasses: 0 });
    expect(mastery.state).toBe('in-progress');
    expect(mastery.mastered).toBe(false);
    expect(mastery.completionRatio).toBe(0.5);
  });

  it('is "cleared" once every room is cleared, but still not mastered without a review', () => {
    const cleared = deriveSubjectMastery({ totalRooms: 4, clearedRooms: 4, fullReviewPasses: 0 });
    expect(cleared.state).toBe('cleared');
    expect(cleared.mastered).toBe(false);
    expect(cleared.completionRatio).toBe(1);
  });

  it('is "reviewed" and mastered only with every room cleared and one full review pass', () => {
    const mastery = deriveSubjectMastery({ totalRooms: 4, clearedRooms: 4, fullReviewPasses: 1 });
    expect(mastery.state).toBe('reviewed');
    expect(mastery.mastered).toBe(true);
    // And a room short of full clears, with a review pass, is not mastery.
    expect(deriveSubjectMastery({ totalRooms: 4, clearedRooms: 3, fullReviewPasses: 3 }).mastered).toBe(false);
  });

  it('clamps a completion ratio above one', () => {
    expect(deriveSubjectMastery({ totalRooms: 2, clearedRooms: 9, fullReviewPasses: 0 }).completionRatio).toBe(1);
  });

  it('rounds the ratio to two places', () => {
    expect(deriveSubjectMastery({ totalRooms: 3, clearedRooms: 1, fullReviewPasses: 0 }).completionRatio).toBe(0.33);
  });

  it('counts subjects with proven mastery in the device total', () => {
    // One review pass per room: two rooms, two passes in total, is exactly one full pass.
    const twoRooms = { 'room-1': room('room-1', { reviewPassCount: 1 }), 'room-2': room('room-2', { reviewPassCount: 1 }) };
    const base = snapshotOf(twoRooms);
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({ subjectId: SUBJECT, snapshot: base }),
        subjectInput({ subjectId: SUBJECT_B, snapshot: base }),
        // One room short of full clears on a third subject, so never mastery however many
        // review passes it has.
        subjectInput({
          subjectId: 'partial',
          snapshot: {
            dungeon: base.dungeon,
            rooms: {
              'room-1': room('room-1', { reviewPassCount: 1 }),
              'room-2': room('room-2', { finalPass: false, reviewPassCount: 1 }),
            },
          },
        }),
      ],
      now: noonOn(DAY, 60),
    });
    // Rows are sorted by subject id, and `partial` sorts before `synthetic-phase18-...`.
    expect(snapshot.subjects.map((entry) => entry.subjectId)).toEqual([
      'partial',
      SUBJECT,
      SUBJECT_B,
    ]);
    expect(snapshot.subjects.map((entry) => entry.mastery.fullReviewPasses)).toEqual([1, 1, 1]);
    expect(snapshot.subjects.map((entry) => entry.mastery.mastered)).toEqual([false, true, true]);
    expect(snapshot.totals.subjectsWithProvenMastery).toBe(2);
    expect(snapshot.totals.subjectsTracked).toBe(3);
  });

  it('reports the empty state for a subject whose graph the device does not have', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ snapshot: null, progression: progressionOf({ xpTotal: 500, rank: 'Scholar' }) })],
      now: noonOn(DAY),
    });
    const row = snapshot.subjects[0];
    expect(row.mastery).toEqual({
      totalRooms: 0,
      clearedRooms: 0,
      completionRatio: 0,
      fullReviewPasses: 0,
      state: 'untouched',
      mastered: false,
    });
    expect(row.review.reviewableRoomCount).toBe(0);
    // The XP they earned in it is still theirs, and is reported.
    expect(row.xpTotal).toBe(500);
    expect(row.rank).toBe('Scholar');
  });
});

describe('the room-clear and clear-bonus metrics', () => {
  it('publishes the clear-bonus counter under the name it deserves', () => {
    // `streakCount` is rooms cleared since the last `resetStreak`, and it feeds the room-clear
    // quality bonus. It is a clear-count bonus, not a streak, and `clearBonusStreak` is the
    // name that says so.
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ progression: progressionOf({ streakCount: 7, roomsCleared: 9 }) })],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects[0].clearBonusStreak).toBe(7);
    expect(snapshot.subjects[0].roomsClearedCounter).toBe(9);
  });

  it('publishes the awarded clears and the counter separately, because they genuinely differ', () => {
    // The counter is incremented by the no-identity award lane too, which exists for the
    // Phase 15 rollback and the byte-comparison fixtures.
    const ledger = writeRoomClearRewardLedgerToFields(
      undefined,
      {
        version: 1,
        entries: [
          { roomId: 'room-1', clearIdentity: 'clear-a', awardedAt: AT },
          { roomId: 'room-2', clearIdentity: 'clear-b', awardedAt: AT },
        ],
      },
    );
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ progression: progressionOf({ roomsCleared: 5, extraFields: ledger }) })],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects[0].roomsClearedAwarded).toBe(2);
    expect(snapshot.subjects[0].roomsClearedCounter).toBe(5);
  });

  it('reports zero awarded clears for a subject with no ledger', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ progression: progressionOf({ roomsCleared: 3 }) })],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects[0].roomsClearedAwarded).toBe(0);
  });
});

describe('review due and overdue', () => {
  it('reports no review state for a subject with no graph', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ snapshot: null })],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects[0].review).toEqual({
      reviewableRoomCount: 0,
      reviewedRoomCount: 0,
      reviewPassCount: 0,
      fullReviewPasses: 0,
      reviewDueCount: 0,
      reviewOverdueCount: 0,
      averageEaseFactor: 2.5,
    });
  });

  it('counts reviewable rooms, reviewed rooms, and full passes from the room state alone', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({
          snapshot: snapshotOf({
            'room-1': room('room-1', { reviewPassCount: 3 }),
            'room-2': room('room-2', { reviewPassCount: 1 }),
            'room-3': room('room-3', { reviewPassCount: 0 }),
          }),
        }),
      ],
      now: noonOn(DAY),
    });
    const review = snapshot.subjects[0].review;
    expect(review.reviewableRoomCount).toBe(3);
    expect(review.reviewedRoomCount).toBe(2);
    expect(review.reviewPassCount).toBe(4);
    // 4 passes over 3 reviewable rooms is one complete pass, and the remainder.
    expect(review.fullReviewPasses).toBe(1);
  });

  it('reports the review streak as consecutive DAYS, not as the clear counter', () => {
    // The pre-Phase-18 panel passed `subject.streakCount` as `currentReviewStreak` and a
    // hard `0` as `longestReviewStreak`, so both published streaks were meaningless. The
    // replacement is derived from the recorded review completions' days.
    const events = [PREVIOUS_DAY, DAY, DAY].map((day, index) =>
      toReviewCompletionEvent({
        subjectId: SUBJECT,
        identity: { roomId: `room-${index}`, passNumber: 1, reviewIdentity: `rpass-${index}` },
        localDate: day,
        recordedAt: AT,
        xpAwarded: 6,
      }),
    );
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [subjectInput({ events })],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.consecutiveReviewDayStreak).toBe(2);
    // The old inputs are not consulted at all, so a clear counter cannot leak into it.
    expect(snapshot.subjects[0].clearBonusStreak).toBe(0);
  });

  it('reports zero review days for a subject with no recorded reviews', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session()],
      subjects: [subjectInput()],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.consecutiveReviewDayStreak).toBe(0);
    expect(snapshot.totals.consecutiveStudyDayStreak).toBe(1);
  });
});

describe('the study-day streak', () => {
  it('counts a run of local days ending today, from sessions and events together', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [
        session({ sessionId: 's1', startedAt: noonOn('2026-06-03'), endedAt: noonOn('2026-06-03', 10) }),
        session({ sessionId: 's2', startedAt: noonOn('2026-06-04'), endedAt: noonOn('2026-06-04', 10) }),
      ],
      subjects: [
        subjectInput({
          events: [toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c' }, localDate: DAY, recordedAt: AT, xpAwarded: 5 })],
        }),
      ],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.consecutiveStudyDayStreak).toBe(3);
    expect(snapshot.totals.activeDays).toBe(3);
  });

  it('reads zero when the last active day is older than one day of grace', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ startedAt: noonOn('2026-06-01'), endedAt: noonOn('2026-06-01', 10) })],
      subjects: [],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.consecutiveStudyDayStreak).toBe(0);
    expect(snapshot.totals.activeDays).toBe(1);
  });

  it('reports active days from the events even with no sessions at all', () => {
    // A device whose sessions were lost but whose progression survived still reports the days
    // it was active, because the events carry their own dates.
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({
          events: [
            toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c1' }, localDate: DAY, recordedAt: AT, xpAwarded: 5 }),
            toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c2' }, localDate: PREVIOUS_DAY, recordedAt: AT, xpAwarded: 5 }),
          ],
        }),
      ],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.totals.activeDays).toBe(2);
    expect(snapshot.totals.consecutiveStudyDayStreak).toBe(2);
  });
});

describe('daily activity', () => {
  it('emits exactly the requested number of zero-filled buckets, oldest first', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ startedAt: noonOn(DAY), endedAt: noonOn(DAY, 20) })],
      subjects: [],
      now: noonOn(DAY, 60),
      dailyActivityDays: 7,
    });
    expect(snapshot.dailyActivity).toHaveLength(7);
    expect(snapshot.dailyActivity[6].isToday).toBe(true);
    expect(snapshot.dailyActivity[6].dateKey).toBe(snapshot.todayKey);
    // Seven buckets ending today, so the oldest is 2026-06-05 minus six days.
    expect(snapshot.dailyActivity[0].dateKey).toBe('2026-05-30');
    expect(snapshot.dailyActivity.map((bucket) => bucket.dateKey)).toEqual([
      '2026-05-30',
      '2026-05-31',
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ]);
    // Only the last bucket has anything in it.
    expect(snapshot.dailyActivity.slice(0, 6).every((bucket) => bucket.sessions === 0)).toBe(true);
    expect(snapshot.dailyActivity[6].sessions).toBe(1);
    expect(snapshot.dailyActivity[6].studyMinutes).toBe(20);
  });

  it('places an event on its own local day, not on today', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({
          events: [
            toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c' }, localDate: '2026-06-02', recordedAt: AT, xpAwarded: 42 }),
            toXpAwardEvent({ subjectId: SUBJECT, source: 'note-submission', sourceIdentity: ['room:r', 'clear:c'], localDate: '2026-06-02', recordedAt: AT, amount: 42 }),
          ],
        }),
      ],
      now: noonOn(DAY, 60),
      dailyActivityDays: 5,
    });
    const byKey = new Map(snapshot.dailyActivity.map((bucket) => [bucket.dateKey, bucket]));
    expect(byKey.get('2026-06-02')?.notes).toBe(1);
    expect(byKey.get('2026-06-02')?.xp).toBe(42);
    expect(byKey.get(snapshot.todayKey)?.notes).toBe(0);
  });

  it('drops an event dated outside the window rather than extending it', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({
          events: [toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c' }, localDate: '2020-01-01', recordedAt: AT, xpAwarded: 5 })],
        }),
      ],
      now: noonOn(DAY, 60),
      dailyActivityDays: 3,
    });
    expect(snapshot.dailyActivity).toHaveLength(3);
    expect(snapshot.dailyActivity.every((bucket) => bucket.notes === 0)).toBe(true);
    // The subject total still counts it.
    expect(snapshot.totals.notesSubmitted).toBe(1);
  });

  it('emits an empty window for zero days rather than throwing', () => {
    const snapshot = computeStatisticsSnapshot({ sessions: [], subjects: [], now: noonOn(DAY), dailyActivityDays: 0 });
    expect(snapshot.dailyActivity).toEqual([]);
  });
});

describe('recent sessions and sessions by day', () => {
  it('orders recent sessions newest first, with a stable tiebreak', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [
        session({ sessionId: 'old', startedAt: noonOn('2026-06-03'), endedAt: noonOn('2026-06-03', 10) }),
        session({ sessionId: 'new', startedAt: noonOn(DAY), endedAt: noonOn(DAY, 10) }),
      ],
      subjects: [],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.recentSessions.map((entry) => entry.sessionId)).toEqual(['new', 'old']);
    expect(snapshot.recentSessions[0].studyMinutes).toBe(10);
    expect(snapshot.recentSessions[0].roomsVisited).toBe(1);
    expect(snapshot.recentSessions[0].dateKey).toBe(snapshot.todayKey);
  });

  it('limits the recent list and keeps every session in sessionsByDate', () => {
    const sessions = Array.from({ length: 15 }, (_unused, index) =>
      session({ sessionId: `s${String(index).padStart(2, '0')}`, startedAt: noonOn(DAY, index), endedAt: noonOn(DAY, index + 5) }),
    );
    const snapshot = computeStatisticsSnapshot({
      sessions,
      subjects: [],
      now: noonOn(DAY, 60),
      recentSessionLimit: 3,
    });
    expect(snapshot.recentSessions).toHaveLength(3);
    // sessionsByDate is the whole picture, not the trimmed list.
    const dayCount = Object.values(snapshot.sessionsByDate).reduce((total, list) => total + list.length, 0);
    expect(dayCount).toBe(15);
  });

  it('reports a null study duration for an open session, not zero', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ endedAt: null })],
      subjects: [],
      now: noonOn(DAY, 60),
    });
    expect(snapshot.recentSessions[0].studyMinutes).toBeNull();
    expect(snapshot.recentSessions[0].endedAt).toBeNull();
  });
});

describe('the snapshot shape', () => {
  it('orders subjects by id, so the panel order is deterministic', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({ subjectId: 'zzz' }),
        subjectInput({ subjectId: 'aaa' }),
        subjectInput({ subjectId: 'mmm' }),
      ],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects.map((entry) => entry.subjectId)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('carries no NaN and no negative count anywhere', () => {
    const snapshot = computeStatisticsSnapshot({
      sessions: [session({ endedAt: null, notesSubmitted: -3, xpEarned: -9 })],
      subjects: [
        subjectInput({
          progression: progressionOf({ streakCount: 2, xpTotal: 0, roomsCleared: 0 }),
          snapshot: snapshotOf({ 'room-1': room('room-1') }),
          events: [toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c' }, localDate: DAY, recordedAt: AT, xpAwarded: -4 })],
        }),
      ],
      now: noonOn(DAY),
    });
    const numbers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'number') numbers.push(value);
      else if (Array.isArray(value)) for (const entry of value) walk(entry);
      else if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) walk(entry);
      }
    };
    walk(snapshot);
    expect(numbers.length).toBeGreaterThan(10);
    for (const value of numbers) {
      expect(Number.isFinite(value), `${value} is not finite`).toBe(true);
      expect(value, `${value} is negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports a hostile progression record without producing NaN', () => {
    const raw = { version: 3, bySubject: { [SUBJECT]: { xpTotal: 'lots', streakCount: -4 } }, crossSubjectAchievements: [] };
    const normalized = normalizeProgressionRecord(raw, { activeSubjectId: SUBJECT, createId: () => 'x' });
    const snapshot = computeStatisticsSnapshot({
      sessions: [],
      subjects: [
        subjectInput({
          progression: normalized.bySubject[SUBJECT] as CanonicalSubjectProgressionWriteShape,
        }),
      ],
      now: noonOn(DAY),
    });
    expect(snapshot.subjects[0].xpTotal).toBe(0);
    expect(snapshot.subjects[0].clearBonusStreak).toBe(0);
    expect(Number.isNaN(snapshot.subjects[0].xpTotal)).toBe(false);
  });

  it('emptyStatisticsSnapshot has the same shape as a real one, with zeros', () => {
    const empty = emptyStatisticsSnapshot(noonOn(DAY));
    const real = computeStatisticsSnapshot({ sessions: [session()], subjects: [subjectInput()], now: noonOn(DAY) });
    expect(Object.keys(empty).sort()).toEqual(Object.keys(real).sort());
    expect(Object.keys(empty.totals).sort()).toEqual(Object.keys(real.totals).sort());
    expect(empty.subjects).toEqual([]);
    expect(empty.recentSessions).toEqual([]);
    expect(empty.sessionsByDate).toEqual({});
    expect(empty.dailyActivity).toHaveLength(14);
    expect(empty.totals.sessionsCompleted).toBe(0);
    expect(empty.provenance.subjectsTracked).toBe(0);
    expect(empty.provenance.sessionsRead).toBe(0);
    expect(empty.todayKey).toBe('2026-06-05');
  });

  it('reports its own generation instant and today key', () => {
    const now = noonOn(DAY, 60);
    const snapshot = computeStatisticsSnapshot({ sessions: [], subjects: [], now });
    expect(snapshot.generatedAt).toBe(now);
    expect(snapshot.todayKey).toBe('2026-06-05');
  });
});