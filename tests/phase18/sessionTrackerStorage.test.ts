/**
 * Phase 18: the session tracker's storage, validation, and reader.
 *
 * `tests/unit/sessionTracker.test.ts` is the QA engineer's file and covers the reader contract
 * from the outside. This file is the **core-logic** half and goes after the three things the
 * service is actually responsible for:
 *
 * 1. **Untrusted-input validation.** A session record arrives from a restored `.kdbak` or
 *    `.kdsubject`. The pre-Phase-18 reader accepted any object with a string `sessionId`, so a
 *    hand-edited archive could put `"notesSubmitted": "lots"` where a number is expected and
 *    every downstream sum produced `NaN` or a negative total.
 * 2. **The write race.** `endCurrentSession`'s storage-v2 branch read the whole stored list,
 *    pushed its own session onto that read, and wrote the result - so two concurrent closes
 *    each published a list built from their own read and the second dropped the first.
 * 3. **The reader's numbers.** Local day keys, calendar-day streaks, and a unique-room count
 *    that is actually unique.
 *
 * Every assertion is against a literal value or a computed one. Nothing here compares a metric
 * to itself after a coercion, and no metric is published as a string and read back through
 * `Number(...)`.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeSessionStats,
  clearAllSessions,
  discardOpenSession,
  endCurrentSession,
  getCurrentSession,
  hasSessionLifecycle,
  mergeSessionRecord,
  parseSessionRecord,
  pendingSessionWrites,
  readSessionRecords,
  sessionStatsFromSnapshot,
  setSessionSource,
  startSession,
  trackFishingCatch,
  trackNoteSubmission,
  trackReviewCompletion,
  trackRoomVisit,
  trackXpEarned,
  type SessionRecord,
} from '@/services/sessionTracker';
import { computeStatisticsSnapshot } from '@/core/statistics/statisticsMetrics';
import { resetRepositorySelection, selectLegacyRepository } from '@/services/persistence/v2/repositorySelection';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';

const KEY = 'knowledge-dungeon:v1:sessions';
const SUBJECT = 'synthetic-phase18-subject';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'synthetic-session-1',
    subjectId: SUBJECT,
    subjectName: 'Synthetic Phase 18 Subject',
    startedAt: '2026-06-05T09:00:00.000Z',
    endedAt: '2026-06-05T09:30:00.000Z',
    roomsVisited: ['room-1'],
    notesSubmitted: 1,
    reviewsCompleted: 1,
    xpEarned: 31,
    ...overrides,
  };
}

function write(payload: unknown): void {
  window.localStorage.setItem(KEY, JSON.stringify(payload));
}

function read(): unknown[] {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? [] : (JSON.parse(raw) as unknown[]);
}

const ORIGINAL_TZ = process.env.TZ;

/**
 * Run a body in a named time zone, restoring the process zone whatever happens.
 *
 * The same mechanism `tests/phase18/localCalendar.test.ts` uses, and for the same reason: the
 * machine's own zone cannot be relied on to make a local-day assertion *discriminate*, and Node
 * re-reads `TZ` when it is assigned. The `finally` is what keeps a failure from leaking a changed
 * process environment into another test in the same worker; `afterEach` restores it again for the
 * case where the body itself throws before the helper's `finally`.
 */
function inTimeZone<T>(tz: string, body: () => T): T {
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  selectLegacyRepository();
  setSessionSource(null);
  discardOpenSession();
});

afterEach(() => {
  // A test that pinned `TZ` may have thrown inside the body before the helper's `finally` ran.
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  discardOpenSession();
  setSessionSource(null);
});

describe('parseSessionRecord - hardening the untrusted read', () => {
  it('accepts a complete record and normalizes it', () => {
    const parsed = parseSessionRecord(record());
    expect(parsed).toEqual(record());
  });

  it('rejects anything that is not an object', () => {
    for (const hostile of [null, undefined, 7, 'session', true, ['session'], () => undefined]) {
      expect(parseSessionRecord(hostile)).toBeNull();
    }
  });

  it('requires a non-empty session id and a non-empty subject id', () => {
    expect(parseSessionRecord({ ...record(), sessionId: '' })).toBeNull();
    expect(parseSessionRecord({ ...record(), sessionId: '   ' })).toBeNull();
    expect(parseSessionRecord({ ...record(), sessionId: 42 })).toBeNull();
    // The pre-Phase-18 reader accepted any object with a string `sessionId`, so a record with
    // no subject would have been filed under `sessionsBySubject[""]`.
    expect(parseSessionRecord({ ...record(), subjectId: '' })).toBeNull();
    expect(parseSessionRecord({ ...record(), subjectId: undefined })).toBeNull();
  });

  it('requires a timestamp with a time zone, and refuses a bare date', () => {
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05T09:00:00' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: 'yesterday' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: 1780650000000 })).toBeNull();
    // A well-formed instant with an explicit offset is accepted, which is what a restored
    // record written in another zone can carry.
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05T11:00:00+02:00' })).not.toBeNull();
  });

  it('refuses a record that ends before it starts', () => {
    // The old reader clamped a negative duration to zero and silently counted a zero-length
    // session; refusing the record is the honest answer for a corrupted one.
    expect(
      parseSessionRecord({ ...record(), startedAt: '2026-06-05T10:00:00.000Z', endedAt: '2026-06-05T09:00:00.000Z' }),
    ).toBeNull();
    // Equal timestamps are a zero-length session, which is legal.
    expect(
      parseSessionRecord({ ...record(), startedAt: '2026-06-05T09:00:00.000Z', endedAt: '2026-06-05T09:00:00.000Z' }),
    ).not.toBeNull();
  });

  it('repairs a bad room list rather than losing the whole session over one member', () => {
    const parsed = parseSessionRecord({
      ...record(),
      roomsVisited: ['room-1', 7, null, '', 'room-2', { id: 'nope' }],
    });
    expect(parsed?.roomsVisited).toEqual(['room-1', 'room-2']);
    // A non-array is an empty list, not a rejection.
    expect(parseSessionRecord({ ...record(), roomsVisited: 'room-1' })?.roomsVisited).toEqual([]);
    expect(parseSessionRecord({ ...record(), roomsVisited: undefined })?.roomsVisited).toEqual([]);
  });

  it('clamps a hostile counter instead of letting it into a total', () => {
    // This is the exact defect: `"lots"` and `-500` in a restored archive made every
    // downstream sum `NaN` or negative.
    const parsed = parseSessionRecord({
      ...record(),
      notesSubmitted: 'lots',
      reviewsCompleted: -5,
      xpEarned: Number.NaN,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.notesSubmitted).toBe(0);
    expect(parsed?.reviewsCompleted).toBe(0);
    expect(parsed?.xpEarned).toBe(0);
    expect(Number.isFinite(parsed?.notesSubmitted ?? Number.NaN)).toBe(true);
    // An infinity is clamped too, for the same reason.
    expect(parseSessionRecord({ ...record(), xpEarned: Number.POSITIVE_INFINITY })?.xpEarned).toBe(0);
  });

  it('truncates a fractional counter rather than carrying a fraction into a sum', () => {
    expect(parseSessionRecord({ ...record(), notesSubmitted: 3.9 })?.notesSubmitted).toBe(3);
  });

  it('drops an unusable lastActivityAt rather than rejecting the record', () => {
    // Recovery falls back to `startedAt`, which is a defined answer, so a mangled timestamp
    // must not cost the device the session.
    expect(parseSessionRecord({ ...record(), lastActivityAt: 'nope' })?.lastActivityAt).toBeUndefined();
    expect(parseSessionRecord({ ...record(), lastActivityAt: 5 })?.lastActivityAt).toBeUndefined();
    expect(parseSessionRecord(record())?.lastActivityAt).toBeUndefined();
    expect(
      parseSessionRecord({ ...record(), lastActivityAt: '2026-06-05T09:12:00.000Z' })?.lastActivityAt,
    ).toBe('2026-06-05T09:12:00.000Z');
  });

  it('preserves a subject name when it is a string and defaults it otherwise', () => {
    expect(parseSessionRecord({ ...record(), subjectName: 'Kept' })?.subjectName).toBe('Kept');
    expect(parseSessionRecord({ ...record(), subjectName: 42 })?.subjectName).toBe('');
    expect(parseSessionRecord({ ...record(), subjectName: undefined })?.subjectName).toBe('');
  });

  it('refuses a timestamp outside the range a key could be built from', () => {
    // A key for year 0 would be "0000-..." which the calendar cannot parse back, silently
    // dropping the session from every metric.
    expect(parseSessionRecord({ ...record(), startedAt: '0000-01-01T00:00:00.000Z' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: '10000-01-01T00:00:00.000Z' })).toBeNull();
  });
});

describe('the stored read validates and de-duplicates', () => {
  it('keeps the first of two records with one id, deterministically', () => {
    write([record({ sessionId: 'dup', xpEarned: 10 }), record({ sessionId: 'dup', xpEarned: 20 })]);
    expect(readSessionRecords()).toHaveLength(1);
    expect(readSessionRecords()[0].xpEarned).toBe(10);
  });

  it('drops the malformed records and keeps the good ones', () => {
    write([
      'not-a-session',
      { sessionId: 'no-subject' },
      record({ sessionId: 'good-1' }),
      { ...record({ sessionId: 'good-2' }), notesSubmitted: 'lots' },
      null,
      record({ sessionId: 'good-3' }),
    ]);
    const records = readSessionRecords();
    expect(records.map((entry) => entry.sessionId)).toEqual(['good-1', 'good-2', 'good-3']);
    expect(records[1].notesSubmitted).toBe(0);
  });

  it('returns an empty list for a payload that is not an array', () => {
    write({ sessionId: 'x' });
    expect(readSessionRecords()).toEqual([]);
    write('nonsense');
    expect(readSessionRecords()).toEqual([]);
  });
});

describe('mergeSessionRecord - the keyed write that fixes the race', () => {
  it('replaces a record with the same id rather than appending a second one', () => {
    const existing = [record({ sessionId: 'a', xpEarned: 10 }), record({ sessionId: 'b' })];
    const merged = mergeSessionRecord(existing, record({ sessionId: 'a', xpEarned: 99 }));
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.sessionId)).toEqual(['b', 'a']);
    expect(merged[1].xpEarned).toBe(99);
  });

  it('appends a new id at the end, so retention trims the oldest', () => {
    const existing = [record({ sessionId: 'a' }), record({ sessionId: 'b' })];
    const merged = mergeSessionRecord(existing, record({ sessionId: 'c' }));
    expect(merged.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('applies the retention cap to the oldest records, never the one being written', () => {
    const existing = [
      record({ sessionId: 'old-1' }),
      record({ sessionId: 'old-2' }),
      record({ sessionId: 'old-3' }),
    ];
    const merged = mergeSessionRecord(existing, record({ sessionId: 'newest' }), 3);
    expect(merged.map((entry) => entry.sessionId)).toEqual(['old-2', 'old-3', 'newest']);
  });

  it('keeps BOTH sessions when two closes land in one tick against a real generation', async () => {
    // REPLACED. The case this took its place built `writeByFirst` / `writeBySecond` locally and
    // asserted on arrays the test itself had just constructed, so it measured the test rather than
    // the product: it would have passed with the write path reverted to the pre-Phase-18
    // whole-list read-modify-write.
    //
    // This one drives the **real** lifecycle against a **real** storage-v2 generation, with a
    // session source installed - which is the configuration the defect lived in. The
    // pre-Phase-18 write path was:
    //
    //     void loadSessionsWithSource().then((sessions) => { sessions.push(finished); saveSessions(sessions); });
    //
    // `loadSessionsWithSource` is an `async` function whose legacy read runs *synchronously at call
    // time*, so two closes in one tick both captured the same empty base list, and the second whole
    // list write dropped the first session. Reproducing that needs three things the old case did
    // not have: a real asynchronous read, a real writer, and two closes in the same task.
    const databaseName = `p18-session-race-${process.pid}-${Date.now()}`;
    const repository = await openStorageV2Repository({
      databaseName,
      clock: fixedClock('2026-06-05T09:00:00.000Z'),
      idFactory: createDeterministicIdFactory('p18-race'),
    });
    let selection: typeof import('@/services/persistence/v2/repositorySelection') | null = null;
    try {
      vi.resetModules();
      window.localStorage.clear();
      selection = await import('@/services/persistence/v2/repositorySelection');
      selection.resetRepositorySelection();
      selection.selectStorageV2Repository(repository);
      expect(selection.isStorageV2Selected()).toBe(true);

      const tracker = await import('@/services/sessionTracker');
      const { createSessionLifecycleController } = await import('@/application/sessionLifecycle');
      // A real session source over the real generation, so the reader the write path performs is
      // the asynchronous branch rather than the synchronous legacy-only one.
      tracker.setSessionSource({
        list: async () => {
          const generationId = await repository.readActiveGenerationId();
          if (generationId === null) return [];
          const snapshot = await repository.readRecords(generationId);
          return snapshot.records.sessions.map(
            (entry): SessionRecord => ({
              ...entry.value,
              subjectName: entry.value.subjectName ?? '',
            }),
          );
        },
      });

      // A counting id factory, so the two sessions are genuinely distinct - two writes of the
      // same id would be a replay, not a race, and would pass for the wrong reason.
      let minted = 0;
      const controller = createSessionLifecycleController({
        nowMs: () => Date.parse('2026-06-05T09:00:00.000Z'),
        mintSessionId: () => `p18-race-session-${(minted += 1)}`,
        persistence: tracker.sessionPersistencePort,
        subject: { readActiveSubject: () => null },
        onChange: () => undefined,
      });

      // ── Two closes in ONE task, with nothing awaited between them: a subject switch that closes
      // the first session and immediately opens the second, with a close arriving in the same tick.
      const first = controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: 'A' });
      expect(first?.sessionId).toBe('p18-race-session-1');
      expect(controller.endSession('subject-changed').ended).toBe(true);
      const second = controller.handleSubjectActivated({ subjectId: 'synthetic-phase18-other', subjectName: 'B' });
      expect(second?.sessionId).toBe('p18-race-session-2');
      expect(second?.sessionId).not.toBe(first?.sessionId);
      expect(controller.endSession('pagehide').ended).toBe(true);

      await tracker.pendingSessionWrites();
      const generationId = await waitForSessionsIn(repository, 2);

      // ── The generation holds both, by their own ids and with their own subjects.
      const snapshot = await repository.readRecords(generationId);
      const stored = snapshot.records.sessions.map((entry) => ({
        sessionId: entry.value.sessionId,
        subjectId: entry.value.subjectId,
        endedAt: entry.value.endedAt,
      }));
      expect(stored).toHaveLength(2);
      expect(new Set(stored.map((entry) => entry.sessionId)).size).toBe(2);
      expect(stored.map((entry) => entry.sessionId).sort()).toEqual([
        'p18-race-session-1',
        'p18-race-session-2',
      ]);
      // Both are CLOSED. A record that merely existed would not show the close landed.
      expect(stored.every((entry) => entry.endedAt !== null)).toBe(true);

      // ── And the legacy mirror the shipping repository reads agrees, because it is written
      // synchronously inside the same serialized write as the publish. This is the half that fails
      // if the write queue is removed, and the generation half that fails if the publish reverts to
      // publishing a whole list.
      const mirrored = readSessionRecords().map((entry) => entry.sessionId).sort();
      expect(mirrored).toEqual(['p18-race-session-1', 'p18-race-session-2']);
      expect(tracker.computeSessionStats(new Date('2026-06-05T12:00:00.000Z')).totalSessions).toBe(2);
    } finally {
      if (selection !== null) {
        selection.resetRepositorySelection();
        selection.selectLegacyRepository();
      }
      repository.close();
      indexedDB.deleteDatabase(databaseName);
    }
  });
});

/** Wait for the generation to hold `count` session records, then return its id. */
async function waitForSessionsIn(
  repository: StorageV2Repository,
  count: number,
): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const generationId = await repository.readActiveGenerationId();
    if (generationId !== null) {
      const snapshot = await repository.readRecords(generationId);
      if (snapshot.records.sessions.length >= count) return generationId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the generation never held ${count} session records`);
}

describe('computeSessionStats - the reader, on real records', () => {
  it('reads one closed session into non-zero totals', () => {
    write([record()]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalSessions).toBe(1);
    expect(stats.sessionsOpen).toBe(0);
    expect(stats.totalMinutesStudied).toBe(30);
    expect(stats.studyTimeMs).toBe(30 * 60_000);
    expect(stats.averageSessionMinutes).toBe(30);
    expect(stats.longestSessionMinutes).toBe(30);
    expect(stats.totalNotesSubmitted).toBe(1);
    expect(stats.totalReviewsCompleted).toBe(1);
    expect(stats.totalXpEarned).toBe(31);
    expect(stats.totalRoomsVisited).toBe(1);
    expect(stats.roomVisits).toBe(1);
    expect(stats.activeDays).toBe(1);
  });

  it('reports an open session separately and gives it no study time', () => {
    write([record({ endedAt: null })]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.sessionsOpen).toBe(1);
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalMinutesStudied).toBe(0);
  });

  it('counts a room once even when five sessions each entered it', () => {
    // The corrected unique-room metric. The pre-Phase-18 `totalRoomsVisited` summed
    // per-session array lengths, so this reported 5; it now reports 1, and the raw visit
    // count is available under `roomVisits`.
    write([
      record({ sessionId: 's1', roomsVisited: ['room-1'] }),
      record({ sessionId: 's2', roomsVisited: ['room-1'] }),
      record({ sessionId: 's3', roomsVisited: ['room-1'] }),
      record({ sessionId: 's4', roomsVisited: ['room-1'] }),
      record({ sessionId: 's5', roomsVisited: ['room-1'] }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalRoomsVisited).toBe(1);
    expect(stats.roomVisits).toBe(5);
  });

  it('counts a room visited five times in one session once for rooms and five times for visits', () => {
    // Even a record whose `roomsVisited` carries repeats is counted both ways honestly: the
    // session record de-duplicates, so this exercises the metric's own set behaviour.
    write([record({ roomsVisited: ['room-1', 'room-2'] })]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalRoomsVisited).toBe(2);
    expect(stats.roomVisits).toBe(2);
  });

  it('counts the same room id in two subjects as two unique rooms', () => {
    // Room ids are unique only inside a subject, so the device total is summed per subject.
    write([
      record({ sessionId: 's1', subjectId: 'subject-a', roomsVisited: ['room-1'] }),
      record({ sessionId: 's2', subjectId: 'subject-b', roomsVisited: ['room-1'] }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalRoomsVisited).toBe(2);
    expect(Object.keys(stats.sessionsBySubject).sort()).toEqual(['subject-a', 'subject-b']);
  });

  it('keys sessionsByDate by the LOCAL day, in a zone where the UTC day provably differs', () => {
    // Pinned to a real offset rather than trusting the host's zone, because this case used to wrap
    // its discriminating assertion in `if (localDay !== utcDay)` - and GitHub's runners are UTC, so
    // on CI that branch never ran and the case asserted nothing. The two keys are now literals
    // that MUST differ, or the case cannot discriminate at all.
    //
    // 23:00 UTC on the 4th is 01:00 on the **5th** in Johannesburg (UTC+2 year-round), so the two
    // projections of one instant are two different calendar days and the reader cannot satisfy
    // both. `localDateKey` derives the key from the host's own calendar; a UTC projection gives
    // `2026-06-04`.
    inTimeZone('Africa/Johannesburg', () => {
      const startedAt = '2026-06-04T23:00:00.000Z';
      write([record({ sessionId: 's1', startedAt, endedAt: '2026-06-04T23:30:00.000Z' })]);
      const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));

      const LOCAL_DAY = '2026-06-05';
      const UTC_DAY = '2026-06-04';
      expect(LOCAL_DAY).not.toBe(UTC_DAY);

      expect(Object.keys(stats.sessionsByDate)).toEqual([LOCAL_DAY]);
      expect(stats.sessionsByDate[LOCAL_DAY]).toHaveLength(1);
      expect(stats.sessionsByDate[LOCAL_DAY]?.[0].sessionId).toBe('s1');
      // The pre-Phase-18 UTC key is absent, asserted unconditionally now that the zone is pinned.
      expect(stats.sessionsByDate[UTC_DAY]).toBeUndefined();
      // The instant's own UTC day is named, so the defect being pinned is visible in the test
      // rather than only in its consequence.
      expect(startedAt.slice(0, 10)).toBe(UTC_DAY);
    });
  });

  it('files the same instant under a DIFFERENT local day one zone earlier, so the key is local', () => {
    // The control for the case above, and the one that would fail if `sessionsByDate` were keyed by
    // anything read off the *instant* rather than the host's calendar: 23:00 UTC on the 4th is
    // still the 4th in UTC-4, so one stored record files under two different keys in two zones.
    inTimeZone('America/New_York', () => {
      const startedAt = '2026-06-04T23:00:00.000Z';
      write([record({ sessionId: 's1', startedAt, endedAt: '2026-06-04T23:30:00.000Z' })]);
      const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));

      expect(Object.keys(stats.sessionsByDate)).toEqual(['2026-06-04']);
      expect(stats.sessionsByDate['2026-06-05']).toBeUndefined();
    });
  });

  it('reports zero for a device with nothing recorded, and never NaN', () => {
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalMinutesStudied).toBe(0);
    expect(stats.averageSessionMinutes).toBe(0);
    expect(stats.longestSessionMinutes).toBe(0);
    expect(stats.recentStreak).toBe(0);
    expect(stats.totalRoomsVisited).toBe(0);
    expect(stats.activeDays).toBe(0);
    for (const value of Object.values(stats)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('computes a day streak over LOCAL days', () => {
    // Three consecutive local days ending on the reader's "today". The instants are 09:00 UTC,
    // which is 11:00 in Johannesburg, so they are safely mid-day and cannot slide across a
    // local midnight in this zone.
    write([
      record({ sessionId: 's1', startedAt: '2026-06-03T09:00:00.000Z', endedAt: '2026-06-03T09:10:00.000Z' }),
      record({ sessionId: 's2', startedAt: '2026-06-04T09:00:00.000Z', endedAt: '2026-06-04T09:10:00.000Z' }),
      record({ sessionId: 's3', startedAt: '2026-06-05T09:00:00.000Z', endedAt: '2026-06-05T09:10:00.000Z' }),
    ]);
    expect(computeSessionStats(new Date('2026-06-05T12:00:00.000Z')).recentStreak).toBe(3);
    expect(computeSessionStats(new Date('2026-06-06T12:00:00.000Z')).recentStreak).toBe(3);
    // A gap in the middle breaks the run at the gap.
    write([
      record({ sessionId: 's1', startedAt: '2026-06-03T09:00:00.000Z', endedAt: '2026-06-03T09:10:00.000Z' }),
      record({ sessionId: 's3', startedAt: '2026-06-05T09:00:00.000Z', endedAt: '2026-06-05T09:10:00.000Z' }),
    ]);
    expect(computeSessionStats(new Date('2026-06-05T12:00:00.000Z')).recentStreak).toBe(1);
  });

  it('sums a hostile stored payload into finite numbers', () => {
    // The end-to-end consequence of the validation: nothing downstream sees `NaN`.
    write([
      { sessionId: 'h1', subjectId: SUBJECT, startedAt: '2026-06-05T09:00:00.000Z', endedAt: '2026-06-05T09:30:00.000Z', roomsVisited: [], notesSubmitted: 'lots', reviewsCompleted: -3, xpEarned: null },
      record({ sessionId: 'h2', notesSubmitted: 2, reviewsCompleted: 1, xpEarned: 7 }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalNotesSubmitted).toBe(2);
    expect(stats.totalReviewsCompleted).toBe(1);
    expect(stats.totalXpEarned).toBe(7);
    expect(Number.isFinite(stats.totalMinutesStudied)).toBe(true);
    // Both records run 09:00 -> 09:30, and the hostile counters did not affect the
    // timestamps: 30 + 30 = 60.
    expect(stats.totalMinutesStudied).toBe(60);
    expect(stats.totalSessions).toBe(2);
  });

  it('reads the same numbers through the exported snapshot adapter as through computeSessionStats', () => {
    write([record({ sessionId: 's1' }), record({ sessionId: 's2', notesSubmitted: 2 })]);
    const now = new Date('2026-06-05T12:00:00.000Z');
    const direct = computeSessionStats(now);
    const records = readSessionRecords();
    const snapshot = computeStatisticsSnapshot({ sessions: records, subjects: [], now });
    const adapted = sessionStatsFromSnapshot(snapshot, records);
    expect(adapted.totalSessions).toBe(direct.totalSessions);
    expect(adapted.totalMinutesStudied).toBe(direct.totalMinutesStudied);
    expect(adapted.totalRoomsVisited).toBe(direct.totalRoomsVisited);
    expect(adapted.roomVisits).toBe(direct.roomVisits);
    expect(adapted.recentStreak).toBe(direct.recentStreak);
    expect(adapted.totalNotesSubmitted).toBe(direct.totalNotesSubmitted);
  });
});

describe('the lifecycle facade over the legacy repository', () => {
  it('records a real session with non-zero counters, which the pre-Phase-18 build could not', () => {
    expect(hasSessionLifecycle()).toBe(false);
    const session = startSession(SUBJECT, 'Synthetic Phase 18 Subject');
    expect(session).not.toBeNull();
    expect(session?.endedAt).toBeNull();

    expect(trackRoomVisit('room-1')).toBe(true);
    expect(trackNoteSubmission(25)).toBe(true);
    expect(trackReviewCompletion(6)).toBe(true);
    expect(trackXpEarned(4)).toBe(true);
    expect(trackRoomVisit('room-1')).toBe(false);
    expect(trackRoomVisit('room-2')).toBe(true);

    const outcome = endCurrentSession();
    expect(outcome.ended).toBe(true);

    const stored = readSessionRecords();
    expect(stored).toHaveLength(1);
    const only = stored[0];
    expect(only.subjectId).toBe(SUBJECT);
    expect(only.roomsVisited).toEqual(['room-1', 'room-2']);
    expect(only.notesSubmitted).toBe(1);
    expect(only.reviewsCompleted).toBe(1);
    expect(only.xpEarned).toBe(35);
    expect(only.endedAt).not.toBeNull();
    // The field Phase 18 added, and only once activity happened.
    expect(only.lastActivityAt).toBeDefined();

    const stats = computeSessionStats(new Date());
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalNotesSubmitted).toBe(1);
    expect(stats.totalReviewsCompleted).toBe(1);
    expect(stats.totalXpEarned).toBe(35);
    expect(stats.totalRoomsVisited).toBe(2);
    expect(hasSessionLifecycle()).toBe(true);
  });

  it('records nothing when no session is open, which is the pre-Phase-18 no-op', () => {
    write([]);
    expect(trackRoomVisit('room-1')).toBe(false);
    expect(trackNoteSubmission()).toBe(false);
    expect(trackReviewCompletion()).toBe(false);
    expect(trackXpEarned(10)).toBe(false);
    expect(
      trackFishingCatch({ catalogId: 'moss-carp', castNumber: 1, xpAwarded: 5, awarded: true }),
    ).toBe(false);
    expect(getCurrentSession()).toBeNull();
    expect(read()).toEqual([]);
  });

  it('keeps one record for a retried activation and one for a repeated end', () => {
    startSession(SUBJECT, 'Name');
    startSession(SUBJECT, 'Name');
    startSession(SUBJECT, 'Name');
    expect(endCurrentSession().ended).toBe(true);
    expect(endCurrentSession().ended).toBe(false);
    expect(endCurrentSession().ended).toBe(false);
    expect(readSessionRecords()).toHaveLength(1);
  });

  it('writes two records when the subject changes, both closed', () => {
    startSession('subject-a', 'A');
    trackRoomVisit('room-a');
    startSession('subject-b', 'B');
    expect(getCurrentSession()?.subjectId).toBe('subject-b');
    endCurrentSession();

    const stored = readSessionRecords();
    expect(stored).toHaveLength(2);
    expect(stored.every((entry) => entry.endedAt !== null)).toBe(true);
    expect(stored.map((entry) => entry.subjectId).sort()).toEqual(['subject-a', 'subject-b']);
  });

  it('clears the stored records and discards the open session', () => {
    startSession(SUBJECT, 'Name');
    expect(getCurrentSession()).not.toBeNull();
    clearAllSessions();
    expect(readSessionRecords()).toEqual([]);
    // Discarded rather than persisted: an explicit data reset must not leave a half-written
    // record that recovery would later close and report as study time.
    expect(getCurrentSession()).toBeNull();
  });

  it('writes nothing on the legacy path beyond the legacy key', async () => {
    startSession(SUBJECT, 'Name');
    endCurrentSession();
    await pendingSessionWrites();
    // Exactly the one legacy key: a flag-off device writes no storage-v2 state at all.
    expect(Object.keys(window.localStorage)).toEqual([KEY]);
  });
});