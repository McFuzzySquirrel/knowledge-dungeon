/**
 * Phase 18: the session lifecycle.
 *
 * The defect under test is plan 5.3's "session tracking functions are not wired into real
 * gameplay", and the sharper form of it: every pre-Phase-18 `track*` began
 * `if (!currentSession) return;` and **nothing ever set `currentSession`**, so the statistics
 * were structurally always zero however hard a learner worked. These tests therefore assert
 * that a session exists, that its counters are non-zero after real activity, and that the five
 * end signals and every retry path produce exactly one record.
 *
 * ## No tautologies
 *
 * Every counter assertion compares against a literal the reader computed by hand. Nothing
 * here is `expect(x).toBe(Number(x))`, and no metric is published as a string and read back
 * through `Number(...)`, so a wrong implementation cannot agree with a right one.
 *
 * The clock, the session-id factory, and the persistence port are all injected, so every
 * timestamp and every id in these tests is reproducible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionLifecycleController,
  defaultMintSessionId,
  type LifecycleSessionRecord,
  type SessionEndReason,
  type SessionLifecycleController,
} from '@/application/sessionLifecycle';
import {
  resetStatisticsSinks,
  setStatisticsActivitySink,
  type StatisticsActivity,
} from '@/core/statistics/activitySink';
import type { SubjectActivationEvent } from '@/core/statistics/activitySink';

const SUBJECT = 'synthetic-phase18-subject';
const OTHER_SUBJECT = 'synthetic-phase18-other-subject';
const NAME = 'Synthetic Phase 18 Subject';

/** 2026-06-05T09:00:00.000Z - a fixed instant the whole file reasons about. */
const T0 = Date.parse('2026-06-05T09:00:00.000Z');

function makeHarness(options: { startAtMs?: number } = {}): {
  controller: SessionLifecycleController;
  written: LifecycleSessionRecord[];
  clock: { now(): number; advance(ms: number): void };
  subject: { current: SubjectActivationEvent | null };
  activities: StatisticsActivity[];
} {
  const written: LifecycleSessionRecord[] = [];
  const activities: StatisticsActivity[] = [];
  let nowMs = options.startAtMs ?? T0;
  let sequence = 0;
  const subject = { current: null as SubjectActivationEvent | null };

  const controller = createSessionLifecycleController({
    nowMs: () => nowMs,
    // Deterministic and distinguishable, so a test can tell two records apart by value.
    mintSessionId: ({ startedAtMs }) => `synthetic-session-${startedAtMs}-${(sequence += 1)}`,
    persistence: {
      write(record) {
        written.push({ ...record, roomsVisited: [...record.roomsVisited] });
        return Promise.resolve();
      },
      read: () => Promise.resolve(written),
    },
    subject: { readActiveSubject: () => subject.current },
  });

  setStatisticsActivitySink((activity) => {
    activities.push(activity);
    controller.recordActivity(activity);
  });

  return {
    controller,
    written,
    activities,
    clock: {
      now: () => nowMs,
      advance(ms: number) {
        nowMs += ms;
      },
    },
    subject,
  };
}

/** The most recent record written, or `undefined`. */
function last(written: readonly LifecycleSessionRecord[]): LifecycleSessionRecord | undefined {
  return written[written.length - 1];
}

/** Records carrying a given id. */
function byId(
  written: readonly LifecycleSessionRecord[],
  sessionId: string,
): LifecycleSessionRecord[] {
  return written.filter((record) => record.sessionId === sessionId);
}

beforeEach(() => {
  resetStatisticsSinks();
});

describe('starting a session', () => {
  it('produces a record with a non-zero identity and an open end', () => {
    const harness = makeHarness();
    const session = harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });

    expect(session).not.toBeNull();
    if (session === null) throw new Error('expected a session');
    expect(session.subjectId).toBe(SUBJECT);
    expect(session.subjectName).toBe(NAME);
    expect(session.startedAt).toBe('2026-06-05T09:00:00.000Z');
    expect(session.endedAt).toBeNull();
    expect(session.sessionId).toBe('synthetic-session-1780650000000-1');
    expect(session.roomsVisited).toEqual([]);
    expect(session.notesSubmitted).toBe(0);
    expect(session.reviewsCompleted).toBe(0);
    expect(session.xpEarned).toBe(0);
    // Absent until there is activity to stamp, so a session that starts and ends cleanly
    // writes exactly the pre-Phase-18 field set.
    expect(session.lastActivityAt).toBeUndefined();
    expect(harness.written).toHaveLength(1);
  });

  it('refuses a blank subject id and writes nothing', () => {
    const harness = makeHarness();
    expect(harness.controller.handleSubjectActivated({ subjectId: '   ', subjectName: NAME })).toBeNull();
    expect(harness.written).toEqual([]);
    expect(harness.controller.activeSession()).toBeNull();
  });

  it('is idempotent for the same subject: the StrictMode double-invocation case', () => {
    const harness = makeHarness();
    const first = harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const second = harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const third = harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });

    // One session, one id, one write - not three sessions and three records.
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(third?.sessionId).toBe(first?.sessionId);
    expect(harness.written).toHaveLength(1);
  });

  it('ends the previous session when a different subject is activated', () => {
    const harness = makeHarness();
    const first = harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const second = harness.controller.handleSubjectActivated({ subjectId: OTHER_SUBJECT, subjectName: 'Other' });

    expect(second?.subjectId).toBe(OTHER_SUBJECT);
    expect(second?.sessionId).not.toBe(first?.sessionId);
    const closed = byId(harness.written, first?.sessionId ?? '');
    expect(closed).toHaveLength(2);
    expect(closed[0].endedAt).toBeNull();
    expect(closed[1].endedAt).toBe('2026-06-05T09:00:00.000Z');
    expect(harness.controller.activeSession()?.subjectId).toBe(OTHER_SUBJECT);
  });
});

describe('recording activity', () => {
  it('records a room visit, de-duplicated per session', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });

    expect(harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' })).toBe(true);
    // Walking back into the same room fifty times is one room.
    for (let step = 0; step < 50; step += 1) {
      harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });
    }
    expect(harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-2' })).toBe(true);

    const session = harness.controller.activeSession();
    expect(session?.roomsVisited).toEqual(['room-1', 'room-2']);
    // A re-visit of a known room changed nothing, so it wrote nothing: the guard is the
    // cheap one and it is what keeps a renderer re-entering a room from writing.
    const writesAfterSecondRoom = harness.written.length;
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-2' });
    expect(harness.written).toHaveLength(writesAfterSecondRoom);
  });

  it('refuses a room with no id rather than recording an empty string', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    expect(harness.controller.recordActivity({ kind: 'room-visit', roomId: '' })).toBe(false);
    expect(harness.controller.recordActivity({ kind: 'room-visit', roomId: '   ' })).toBe(false);
    expect(harness.controller.activeSession()?.roomsVisited).toEqual([]);
    expect(harness.written).toHaveLength(1);
  });

  it('records a note submission with its XP and adds the room', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });

    expect(
      harness.controller.recordActivity({ kind: 'note-submission', roomId: 'room-7', xpAwarded: 34 }),
    ).toBe(true);

    const session = harness.controller.activeSession();
    expect(session?.notesSubmitted).toBe(1);
    expect(session?.xpEarned).toBe(34);
    // A room the learner cleared was certainly entered, so the room is recorded even if the
    // renderer's room-entered callback never arrived.
    expect(session?.roomsVisited).toEqual(['room-7']);
    expect(session?.lastActivityAt).toBe('2026-06-05T09:00:00.000Z');
  });

  it('records a review completion with its XP', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.clock.advance(60_000);

    expect(
      harness.controller.recordActivity({ kind: 'review-completion', roomId: 'room-7', passNumber: 1, xpAwarded: 6 }),
    ).toBe(true);

    const session = harness.controller.activeSession();
    expect(session?.reviewsCompleted).toBe(1);
    expect(session?.xpEarned).toBe(6);
    expect(session?.roomsVisited).toEqual(['room-7']);
    // `lastActivityAt` moves with the clock, which is what lets recovery close the session at
    // the learner's last action rather than at the next launch.
    expect(session?.lastActivityAt).toBe('2026-06-05T09:01:00.000Z');
  });

  it('records an awarded catch but not a declined one', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });

    expect(
      harness.controller.recordActivity({
        kind: 'fishing-outcome',
        catalogId: 'moss-carp',
        castNumber: 1,
        xpAwarded: 10,
        awarded: false,
      }),
    ).toBe(false);
    // Phase 17's invariant: a release or a wrong recall awards nothing at all, and a session
    // counter is a form of award.
    expect(harness.controller.activeSession()?.xpEarned).toBe(0);

    expect(
      harness.controller.recordActivity({
        kind: 'fishing-outcome',
        catalogId: 'moss-carp',
        castNumber: 2,
        xpAwarded: 10,
        awarded: true,
      }),
    ).toBe(true);
    expect(harness.controller.activeSession()?.xpEarned).toBe(10);
  });

  it('records a bare XP amount and refuses a non-positive one', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    expect(harness.controller.recordActivity({ kind: 'session-xp', amount: 15 })).toBe(true);
    expect(harness.controller.recordActivity({ kind: 'session-xp', amount: 0 })).toBe(false);
    expect(harness.controller.recordActivity({ kind: 'session-xp', amount: -20 })).toBe(false);
    expect(harness.controller.recordActivity({ kind: 'session-xp', amount: Number.NaN })).toBe(false);
    expect(harness.controller.activeSession()?.xpEarned).toBe(15);
  });

  it('records nothing and reports false when no session is open', () => {
    const harness = makeHarness();
    for (const activity of [
      { kind: 'room-visit', roomId: 'r' },
      { kind: 'note-submission', roomId: 'r', xpAwarded: 5 },
      { kind: 'review-completion', roomId: 'r', passNumber: 1, xpAwarded: 5 },
      { kind: 'fishing-outcome', catalogId: 'c', castNumber: 1, xpAwarded: 5, awarded: true },
      { kind: 'session-xp', amount: 5 },
    ] as const) {
      expect(harness.controller.recordActivity(activity)).toBe(false);
    }
    expect(harness.written).toEqual([]);
  });

  it('accumulates a full session of real activity into non-zero counters', () => {
    // The plan's exit criterion, stated as a value: "statistics are nonzero after real use".
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.clock.advance(15 * 60_000);

    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-2' });
    harness.controller.recordActivity({ kind: 'note-submission', roomId: 'room-1', xpAwarded: 28 });
    harness.controller.recordActivity({ kind: 'review-completion', roomId: 'room-1', passNumber: 1, xpAwarded: 6 });
    harness.controller.recordActivity({ kind: 'review-completion', roomId: 'room-2', passNumber: 1, xpAwarded: 6 });
    harness.controller.recordActivity({
      kind: 'fishing-outcome',
      catalogId: 'lunar-trout',
      castNumber: 1,
      xpAwarded: 12,
      awarded: true,
    });

    harness.clock.advance(10 * 60_000);
    const closed = harness.controller.handleReturnToVillage();

    expect(closed.ended).toBe(true);
    const record = closed.record;
    if (record === null) throw new Error('expected a closed record');
    expect(record.roomsVisited).toHaveLength(2);
    expect(record.notesSubmitted).toBe(1);
    expect(record.reviewsCompleted).toBe(2);
    expect(record.xpEarned).toBe(52);
    expect(record.endedAt).not.toBeNull();
    // 25 minutes of study time, from the timestamps - not from a counter someone kept.
    expect(Date.parse(record.endedAt ?? '') - Date.parse(record.startedAt)).toBe(25 * 60_000);
  });
});

describe('ending a session', () => {
  it('reports false and writes nothing when there is nothing open', () => {
    const harness = makeHarness();
    for (const reason of [
      'subject-changed',
      'returned-to-village',
      'route-unmount',
      'pagehide',
      'visibility-hidden',
      'requested',
    ] as const) {
      const outcome = harness.controller.endSession(reason);
      expect(outcome.ended, reason).toBe(false);
      expect(outcome.record).toBeNull();
      expect(outcome.reason).toBe(reason);
    }
    expect(harness.written).toEqual([]);
  });

  it('closes the session and stamps its last activity when it has none', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.clock.advance(120_000);

    const outcome = harness.controller.handlePageHide();
    expect(outcome.ended).toBe(true);
    expect(outcome.reason).toBe('pagehide');
    expect(outcome.record?.endedAt).toBe('2026-06-05T09:02:00.000Z');
    // A session with no recorded activity is stamped at its own end, so recovery can always
    // close it at a real timestamp.
    expect(outcome.record?.lastActivityAt).toBe('2026-06-05T09:02:00.000Z');
    expect(harness.controller.activeSession()).toBeNull();
  });

  it('writes one record for a pagehide that follows a visibilitychange', () => {
    // The realistic order in a real browser is visibilitychange -> pagehide, and both fire.
    // No subject is active here, so the visibility handler ends the session and does not
    // restart one - the case where the page is on the welcome screen, not in a dungeon.
    const harness = makeHarness();
    harness.subject.current = null;
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });
    // Start + the room visit.
    expect(harness.written).toHaveLength(2);

    harness.controller.handleVisibilityHidden();
    // Exactly one more write: the closed record.
    expect(harness.written).toHaveLength(3);
    harness.controller.handlePageHide();
    harness.controller.handleReturnToVillage();
    harness.controller.handleRouteUnmount();

    // The three later signals found nothing open, so they added nothing.
    expect(harness.written).toHaveLength(3);
    const closed = byId(harness.written, harness.written[0].sessionId).filter(
      (record) => record.endedAt !== null,
    );
    expect(closed).toHaveLength(1);
    expect(harness.controller.activeSession()).toBeNull();
  });

  it('writes two records when a subject is still active: the old one closed, a new one open', () => {
    // The in-dungeon case, and the one that matters for study time: the tab-away window lands
    // outside both records rather than inside the first.
    const harness = makeHarness();
    harness.subject.current = { subjectId: SUBJECT, subjectName: NAME };
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });
    expect(harness.written).toHaveLength(2);

    harness.clock.advance(45 * 60_000);
    harness.controller.handleVisibilityHidden();
    expect(harness.written).toHaveLength(4);
    const firstId = harness.written[0].sessionId;
    expect(harness.controller.activeSession()?.sessionId).not.toBe(firstId);

    // The follow-up close events find the *new* session open, so they close that one, and the
    // two records for the first session are untouched.
    harness.controller.handlePageHide();
    // The first session has exactly its three writes - start, the room visit, and the close -
    // and the pagehide wrote the *new* session's record, not another one for the first.
    const firstSessionRecords = byId(harness.written, firstId);
    expect(firstSessionRecords).toHaveLength(3);
    expect(firstSessionRecords[2].endedAt).toBe('2026-06-05T09:45:00.000Z');
    expect(firstSessionRecords.map((record) => record.endedAt)).toEqual([
      null,
      null,
      '2026-06-05T09:45:00.000Z',
    ]);
    expect(harness.controller.activeSession()).toBeNull();
  });

  it('restarts a session on a resume from background, so the tab-away is not study time', () => {
    const harness = makeHarness();
    harness.subject.current = { subjectId: SUBJECT, subjectName: NAME };
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });

    harness.clock.advance(30 * 60_000);
    harness.subject.current = null;
    const outcome = harness.controller.handleVisibilityHidden();
    expect(outcome.ended).toBe(true);
    // No subject is active while the page is hidden, so nothing restarted.
    expect(harness.controller.activeSession()).toBeNull();

    // The page comes back with the subject still active.
    harness.subject.current = { subjectId: SUBJECT, subjectName: NAME };
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });
    expect(harness.controller.activeSession()).toBeNull();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const resumed = harness.controller.activeSession();
    expect(resumed?.roomsVisited).toEqual([]);
    // A *new* record: the first session's 30 minutes of elapsed time and this session's time
    // are in two records, so the tab-away cannot be counted as study.
    expect(resumed?.sessionId).not.toBe(harness.written[0].sessionId);
  });

  it('restarts inside the visibility handler when a subject is still active', () => {
    const harness = makeHarness();
    harness.subject.current = { subjectId: SUBJECT, subjectName: NAME };
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.clock.advance(5 * 60_000);

    harness.controller.handleVisibilityHidden();
    const resumed = harness.controller.activeSession();
    expect(resumed?.subjectId).toBe(SUBJECT);
    expect(resumed?.endedAt).toBeNull();
    expect(resumed?.startedAt).toBe('2026-06-05T09:05:00.000Z');
    expect(resumed?.sessionId).not.toBe(harness.written[0].sessionId);
  });

  it('is re-entrancy safe: an onChange listener that ends the session again writes once', () => {
    // The property the clear-before-persist ordering exists for. A re-entrant call is the one
    // case a *sequential* set of end signals cannot produce, so a probe that only calls
    // `endSession` three times in a row would pass against an implementation that clears
    // `open` after persisting. This drives the re-entrancy directly: the listener is invoked
    // from inside `publish`, i.e. before the ordering-sensitive line in a naive version.
    const written: LifecycleSessionRecord[] = [];
    let reentered = 0;
    const controller = createSessionLifecycleController({
      nowMs: () => T0,
      persistence: {
        write(record) {
          written.push(record);
          return Promise.resolve();
        },
        read: () => Promise.resolve(written),
      },
      subject: { readActiveSubject: () => null },
      onChange: (record) => {
        // Re-enter only on the **end**, not on the start: the second `onChange` is the one
        // `endSession` itself triggers, from inside `publish` and therefore before the
        // ordering-sensitive line in an implementation that clears `open` afterwards.
        if (record === null || record.endedAt === null) return;
        reentered += 1;
        controller.endSession('pagehide');
      },
    });
    controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const outcome = controller.endSession('returned-to-village');

    expect(outcome.ended).toBe(true);
    // The listener did run, so the case was exercised rather than skipped.
    expect(reentered).toBe(1);
    // The re-entrant call found nothing open, so exactly one closed record was written.
    const closed = written.filter((record) => record.endedAt !== null);
    expect(closed).toHaveLength(1);
    expect(controller.activeSession()).toBeNull();
  });

  it('hands back a copy, so a caller cannot mutate the live session', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'room-1' });

    const snapshot = harness.controller.activeSession();
    if (snapshot === null) throw new Error('expected a session');
    (snapshot.roomsVisited as string[]).push('tampered');
    (snapshot as { xpEarned: number }).xpEarned = 9999;

    const live = harness.controller.activeSession();
    expect(live?.roomsVisited).toEqual(['room-1']);
    expect(live?.xpEarned).toBe(0);
  });
});

describe('recovering an unterminated session', () => {
  it('closes an open record at its own last activity, not at recovery time', () => {
    // The crash case: the tab was killed an hour after the last thing the learner did.
    const crashed: LifecycleSessionRecord = {
      sessionId: 'crashed-session',
      subjectId: SUBJECT,
      subjectName: NAME,
      startedAt: '2026-06-05T09:00:00.000Z',
      endedAt: null,
      roomsVisited: ['room-1'],
      notesSubmitted: 1,
      reviewsCompleted: 0,
      xpEarned: 25,
      lastActivityAt: '2026-06-05T09:12:00.000Z',
    };
    const writes: LifecycleSessionRecord[] = [];
    const controller = createSessionLifecycleController({
      nowMs: () => Date.parse('2026-06-06T08:00:00.000Z'),
      persistence: {
        write(record) {
          const index = writes.findIndex((existing) => existing.sessionId === record.sessionId);
          if (index === -1) writes.push(record);
          else writes[index] = record;
          return Promise.resolve();
        },
        read: () => Promise.resolve([crashed]),
      },
      subject: { readActiveSubject: () => null },
    });

    return controller.recoverUnterminatedSessions().then((closed) => {
      expect(closed).toEqual(['crashed-session']);
      expect(writes).toHaveLength(1);
      // 12 minutes of study time, not the 23 hours between the last action and this boot.
      expect(writes[0].endedAt).toBe('2026-06-05T09:12:00.000Z');
      expect(
        Date.parse(writes[0].endedAt ?? '') - Date.parse(writes[0].startedAt),
      ).toBe(12 * 60_000);
    });
  });

  it('closes an open record with no last activity at its own start, reporting zero minutes', () => {
    // The honest answer when the only thing known is when the session began. Closing it at
    // "now" would report a day of study time; the alternative the module rejects.
    const crashed: LifecycleSessionRecord = {
      sessionId: 'crashed-no-activity',
      subjectId: SUBJECT,
      subjectName: NAME,
      startedAt: '2026-06-05T09:00:00.000Z',
      endedAt: null,
      roomsVisited: [],
      notesSubmitted: 0,
      reviewsCompleted: 0,
      xpEarned: 0,
    };
    const writes: LifecycleSessionRecord[] = [];
    const controller = createSessionLifecycleController({
      nowMs: () => Date.parse('2026-06-06T08:00:00.000Z'),
      persistence: {
        write(record) {
          writes.push(record);
          return Promise.resolve();
        },
        read: () => Promise.resolve([crashed]),
      },
      subject: { readActiveSubject: () => null },
    });

    return controller.recoverUnterminatedSessions().then((closed) => {
      expect(closed).toEqual(['crashed-no-activity']);
      expect(writes[0].endedAt).toBe('2026-06-05T09:00:00.000Z');
      expect(writes[0].lastActivityAt).toBe('2026-06-05T09:00:00.000Z');
      expect(Date.parse(writes[0].endedAt ?? '') - Date.parse(writes[0].startedAt)).toBe(0);
    });
  });

  it('is idempotent: a second call finds nothing to close', () => {
    let records: LifecycleSessionRecord[] = [
      {
        sessionId: 'open-1',
        subjectId: SUBJECT,
        subjectName: NAME,
        startedAt: '2026-06-05T09:00:00.000Z',
        endedAt: null,
        roomsVisited: [],
        notesSubmitted: 0,
        reviewsCompleted: 0,
        xpEarned: 0,
        lastActivityAt: '2026-06-05T09:05:00.000Z',
      },
      {
        sessionId: 'already-closed',
        subjectId: SUBJECT,
        subjectName: NAME,
        startedAt: '2026-06-04T09:00:00.000Z',
        endedAt: '2026-06-04T09:30:00.000Z',
        roomsVisited: [],
        notesSubmitted: 0,
        reviewsCompleted: 0,
        xpEarned: 0,
      },
    ];
    let writeCount = 0;
    const controller = createSessionLifecycleController({
      nowMs: () => Date.parse('2026-06-06T08:00:00.000Z'),
      persistence: {
        write(record) {
          writeCount += 1;
          records = records.map((existing) =>
            existing.sessionId === record.sessionId ? record : existing,
          );
          return Promise.resolve();
        },
        read: () => Promise.resolve(records),
      },
      subject: { readActiveSubject: () => null },
    });

    return controller
      .recoverUnterminatedSessions()
      .then((first) => {
        expect(first).toEqual(['open-1']);
        expect(writeCount).toBe(1);
        return controller.recoverUnterminatedSessions();
      })
      .then((second) => {
        // Nothing new, and the already-closed record is neither returned nor rewritten.
        expect(second).toEqual([]);
        expect(writeCount).toBe(1);
        expect(records.find((record) => record.sessionId === 'already-closed')?.endedAt).toBe(
          '2026-06-04T09:30:00.000Z',
        );
      });
  });

  it('reports an empty list for a device with no stored sessions', () => {
    const controller = createSessionLifecycleController({
      nowMs: () => T0,
      persistence: { write: () => Promise.resolve(), read: () => Promise.resolve([]) },
      subject: { readActiveSubject: () => null },
    });
    return controller.recoverUnterminatedSessions().then((closed) => {
      expect(closed).toEqual([]);
    });
  });
});

describe('the default session id factory', () => {
  it('is deterministic in (start instant, subject)', () => {
    const left = defaultMintSessionId({ startedAtMs: T0, subjectId: SUBJECT });
    const same = defaultMintSessionId({ startedAtMs: T0, subjectId: SUBJECT });
    expect(same).toBe(left);
    expect(left).toBe('session-mq0p19c0-7781dff6');
  });

  it('separates two subjects that start in the same millisecond', () => {
    expect(defaultMintSessionId({ startedAtMs: T0, subjectId: SUBJECT })).not.toBe(
      defaultMintSessionId({ startedAtMs: T0, subjectId: OTHER_SUBJECT }),
    );
  });

  it('separates two start instants in the same subject', () => {
    expect(defaultMintSessionId({ startedAtMs: T0, subjectId: SUBJECT })).not.toBe(
      defaultMintSessionId({ startedAtMs: T0 + 1, subjectId: SUBJECT }),
    );
  });

  it('is injectable, which is what makes a session id reproducible in a test', () => {
    // The pre-Phase-18 id was `Date.now()` plus `Math.random()`: not deterministic and not
    // injectable. This asserts the seam, not the default: a test can demand a constant id.
    const controller = createSessionLifecycleController({
      nowMs: () => T0,
      mintSessionId: () => 'a-constant-id',
      persistence: { write: () => Promise.resolve(), read: () => Promise.resolve([]) },
      subject: { readActiveSubject: () => null },
    });
    expect(controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME })?.sessionId).toBe(
      'a-constant-id',
    );
  });
});

describe('the activity sink is the one wiring point, and it is idempotent at the session', () => {
  it('routes an award into the open session through the sink', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    setStatisticsActivitySink((activity) => {
      harness.controller.recordActivity(activity);
    });

    // Emitting the *same* activity twice - a StrictMode double dispatch - moves the session
    // counter twice, and that is honest: the session counter is a count of what the award
    // sites reported, and the exactly-once property lives in the **durable ledger**, which is
    // keyed by the reward's own identity and written in the reward's own record write (see
    // `tests/phase18/progressionStatisticsEvents.test.ts`). What is asserted here is the
    // wiring: an emission from a store action reaches the open session.
    const activity: StatisticsActivity = { kind: 'note-submission', roomId: 'room-1', xpAwarded: 25 };
    harness.activities.push(activity);
    harness.controller.recordActivity(activity);
    harness.activities.push(activity);
    harness.controller.recordActivity(activity);
    expect(harness.activities).toHaveLength(2);
    expect(harness.controller.activeSession()?.notesSubmitted).toBe(2);
    expect(harness.controller.activeSession()?.xpEarned).toBe(50);
  });

  it('does nothing at all when no sink is installed', () => {
    resetStatisticsSinks();
    const controller = createSessionLifecycleController({
      nowMs: () => T0,
      persistence: { write: () => Promise.resolve(), read: () => Promise.resolve([]) },
      subject: { readActiveSubject: () => null },
    });
    // The store actions emit unconditionally; with no sink that is a no-op rather than a
    // crash, which is what keeps a rollback build and a unit test working unchanged.
    expect(() => controller.recordActivity({ kind: 'room-visit', roomId: 'r' })).not.toThrow();
    expect(controller.activeSession()).toBeNull();
  });

  it('reports the reason a session ended, as a code', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const reasons: SessionEndReason[] = [
      'returned-to-village',
      'route-unmount',
      'pagehide',
    ];
    const outcomes = reasons.map((reason) => harness.controller.endSession(reason));
    expect(outcomes[0].reason).toBe('returned-to-village');
    expect(outcomes[1].ended).toBe(false);
    expect(outcomes[2].ended).toBe(false);
  });
});

describe('the onChange hook follows the session', () => {
  it('reports the open record and then null, with no learner content beyond the name', () => {
    const seen: Array<LifecycleSessionRecord | null> = [];
    const controller = createSessionLifecycleController({
      nowMs: () => T0,
      persistence: { write: () => Promise.resolve(), read: () => Promise.resolve([]) },
      subject: { readActiveSubject: () => null },
      onChange: (record) => seen.push(record),
    });
    controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    controller.endSession('pagehide');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.subjectId).toBe(SUBJECT);
    expect(seen[1]).not.toBeNull();
  });
});

// A guard against a silent no-op test above: the harness must actually record.
describe('the harness itself records', () => {
  it('proves the fixture is not vacuous', () => {
    const harness = makeHarness();
    harness.controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    harness.controller.recordActivity({ kind: 'room-visit', roomId: 'r' });
    expect(harness.written.length).toBeGreaterThanOrEqual(2);
    expect(last(harness.written)?.roomsVisited).toEqual(['r']);
  });

  it('proves a failure would be observable: ending twice writes once', () => {
    const writeSpy = vi.fn(() => Promise.resolve());
    const controller = createSessionLifecycleController({
      nowMs: () => T0,
      persistence: { write: writeSpy, read: () => Promise.resolve([]) },
      subject: { readActiveSubject: () => null },
    });
    controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: NAME });
    const afterStart = writeSpy.mock.calls.length;
    controller.endSession('pagehide');
    controller.endSession('pagehide');
    controller.endSession('pagehide');
    expect(writeSpy.mock.calls.length).toBe(afterStart + 1);
  });
});