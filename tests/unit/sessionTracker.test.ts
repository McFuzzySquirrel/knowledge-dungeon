/**
 * Phase 18 gate 1: `src/services/sessionTracker.ts`, from outside.
 *
 * ## Why this file exists
 *
 * The plan's Phase 18 verification block names `tests/unit/sessionTracker.test.ts`. Before
 * this file the command
 *
 * ```bash
 * npm test -- tests/unit/sessionTracker.test.ts
 * ```
 *
 * matched **no file at all**, and a filter that matches nothing exits `0`. The named gate was
 * therefore vacuous: it reported success while testing nothing. This file is that gate.
 *
 * ## What it is allowed to assert, and how
 *
 * `tests/phase18/sessionTrackerStorage.test.ts` is the core-logic engineer's file and covers
 * the same module from the inside. This file deliberately takes a different tack on the two
 * things that matter, because two probes of the same property only help if they can *fail*
 * independently:
 *
 * - **Hard literals, never a re-derivation.** Every expected day key is a literal string
 *   written out by hand from the time-zone rule, not recomputed with `getFullYear()` /
 *   `getMonth()` / `getDate()` in the test body. Re-deriving the expected value with the same
 *   arithmetic the module uses is how a gate ends up agreeing with a broken module; a literal
 *   cannot drift with it.
 * - **A pinned time zone per case, restored afterwards.** The host's zone is
 *   `Africa/Johannesburg` today and would be UTC on a CI runner. Every case that depends on a
 *   local/UTC difference pins the zone it asserts in, and several cases pin two zones and
 *   require the *same* input to produce two different literal keys. That pair is what proves
 *   the assertion is live: if the reader returned a fixed or UTC-projected key, one of the two
 *   literals fails.
 *
 * Every metric is read as a `number` and compared with `toBe` against an integer written by
 * hand. Nothing here coerces a metric through `Number(...)`, and no assertion depends on a
 * value published as a string.
 *
 * ## Privacy
 *
 * Every fixture is synthetic and self-describing. No learner data, no real host, no URL, no
 * request body. The subject ids are prefixed `synthetic-` so a scan finds them by shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllSessions,
  computeSessionStats,
  discardOpenSession,
  mergeSessionRecord,
  parseSessionRecord,
  readSessionRecords,
  setSessionSource,
  type SessionRecord,
} from '@/services/sessionTracker';
import {
  resetRepositorySelection,
  selectLegacyRepository,
} from '@/services/persistence/v2/repositorySelection';

/** The single legacy key the shipping repository reads and writes. */
const STORAGE_KEY = 'knowledge-dungeon:v1:sessions';

const SUBJECT_A = 'synthetic-qa18-subject-a';
const SUBJECT_B = 'synthetic-qa18-subject-b';
const ROOM_1 = 'synthetic-qa18-room-1';
const ROOM_2 = 'synthetic-qa18-room-2';

/** A complete, valid record. Every hostile case is this record with one field replaced. */
function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'synthetic-qa18-session-1',
    subjectId: SUBJECT_A,
    subjectName: 'Synthetic QA18 Subject A',
    startedAt: '2026-06-05T09:00:00.000Z',
    endedAt: '2026-06-05T09:30:00.000Z',
    roomsVisited: [ROOM_1],
    notesSubmitted: 1,
    reviewsCompleted: 1,
    xpEarned: 31,
    ...overrides,
  };
}

/** Plant a hostile or friendly payload in the legacy key exactly as a restore would. */
function plant(payload: unknown): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** Plant a raw string, so a payload can be unparseable JSON rather than merely wrong. */
function plantRaw(raw: string): void {
  window.localStorage.setItem(STORAGE_KEY, raw);
}

const ORIGINAL_TZ = process.env.TZ;

function pinTimeZone(zone: string): void {
  process.env.TZ = zone;
}

function restoreTimeZone(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  selectLegacyRepository();
  setSessionSource(null);
  discardOpenSession();
});

afterEach(() => {
  discardOpenSession();
  setSessionSource(null);
  clearAllSessions();
  restoreTimeZone();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The corrected `computeSessionStats` shape
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSessionStats publishes the corrected shape', () => {
  /**
   * The shape gate, as an exact key set.
   *
   * A key-set assertion is used deliberately: a **numeric** total cannot tell a renamed
   * metric from a differently-typed one, and `toMatchObject` would accept a field quietly
   * removed. `totalRoomsVisited` is in this list because its *meaning* changed (see the
   * neighbouring cases) while its name stayed, which is exactly the kind of change a name-based
   * gate would miss.
   */
  it('publishes every documented metric, and nothing else', () => {
    plant([record()]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(Object.keys(stats).sort()).toEqual(
      [
        // Grouped: the session-derived counts.
        'totalSessions',
        'totalMinutesStudied',
        'averageSessionMinutes',
        'totalRoomsVisited',
        'totalNotesSubmitted',
        'totalReviewsCompleted',
        'totalXpEarned',
        'sessionsBySubject',
        'sessionsByDate',
        'recentStreak',
        // Grouped: the fields Phase 18 added.
        'roomVisits',
        'sessionsOpen',
        'studyTimeMs',
        'longestSessionMinutes',
        'activeDays',
        'consecutiveReviewDayStreak',
        'todayKey',
      ].sort(),
    );
  });

  it('counts a closed session with hard-literal minute, millisecond, and mean values', () => {
    // 09:00:00Z -> 09:30:00Z is exactly 30 minutes and 1 800 000 ms. Both are written as
    // literals rather than as `30 * 60_000`, so a change in the unit the module rounds to
    // fails here instead of being absorbed by the same multiplication.
    plant([record()]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalSessions).toBe(1);
    expect(stats.sessionsOpen).toBe(0);
    expect(stats.totalMinutesStudied).toBe(30);
    expect(stats.studyTimeMs).toBe(1800000);
    expect(stats.averageSessionMinutes).toBe(30);
    expect(stats.longestSessionMinutes).toBe(30);
    expect(stats.activeDays).toBe(1);
    expect(stats.totalNotesSubmitted).toBe(1);
    expect(stats.totalReviewsCompleted).toBe(1);
    expect(stats.totalXpEarned).toBe(31);
  });

  it('counts `totalRoomsVisited` as UNIQUE rooms and `roomVisits` as entries', () => {
    // The corrected meaning, pinned by a value. Five sessions that each entered the same room
    // are one room and five visits. Under the pre-Phase-18 definition - the sum of per-session
    // array lengths - this reported 5 rooms.
    plant([
      record({ sessionId: 's-1', roomsVisited: [ROOM_1] }),
      record({ sessionId: 's-2', roomsVisited: [ROOM_1] }),
      record({ sessionId: 's-3', roomsVisited: [ROOM_1] }),
      record({ sessionId: 's-4', roomsVisited: [ROOM_1] }),
      record({ sessionId: 's-5', roomsVisited: [ROOM_1] }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalRoomsVisited).toBe(1);
    expect(stats.roomVisits).toBe(5);
  });

  it('counts the same room id in two subjects as two unique rooms, because room ids are per-subject', () => {
    plant([
      record({ sessionId: 's-1', subjectId: SUBJECT_A, roomsVisited: [ROOM_1] }),
      record({ sessionId: 's-2', subjectId: SUBJECT_B, roomsVisited: [ROOM_1] }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalRoomsVisited).toBe(2);
    expect(Object.keys(stats.sessionsBySubject).sort()).toEqual([SUBJECT_A, SUBJECT_B]);
  });

  it('reports an open session separately and gives it no study time', () => {
    plant([record({ sessionId: 's-open', endedAt: null })]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.sessionsOpen).toBe(1);
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalMinutesStudied).toBe(0);
    expect(stats.studyTimeMs).toBe(0);
    expect(stats.averageSessionMinutes).toBe(0);
    expect(stats.longestSessionMinutes).toBe(0);
  });

  it('takes the longest session from the longest, not from the newest', () => {
    // Two sessions of 30 and 90 minutes in that order. A "last record wins" implementation
    // would report 30.
    plant([
      record({ sessionId: 's-short', startedAt: '2026-06-05T09:00:00.000Z', endedAt: '2026-06-05T09:30:00.000Z' }),
      record({ sessionId: 's-long', startedAt: '2026-06-05T10:00:00.000Z', endedAt: '2026-06-05T11:30:00.000Z' }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.longestSessionMinutes).toBe(90);
    expect(stats.totalMinutesStudied).toBe(120);
    // Mean is over both sessions: 120 / 2 = 60.
    expect(stats.averageSessionMinutes).toBe(60);
  });

  it('reports an all-zero aggregate for a device with nothing recorded', () => {
    plant([]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(stats.totalSessions).toBe(0);
    expect(stats.sessionsOpen).toBe(0);
    expect(stats.totalMinutesStudied).toBe(0);
    expect(stats.studyTimeMs).toBe(0);
    expect(stats.averageSessionMinutes).toBe(0);
    expect(stats.longestSessionMinutes).toBe(0);
    expect(stats.totalRoomsVisited).toBe(0);
    expect(stats.roomVisits).toBe(0);
    expect(stats.totalNotesSubmitted).toBe(0);
    expect(stats.totalReviewsCompleted).toBe(0);
    expect(stats.totalXpEarned).toBe(0);
    expect(stats.activeDays).toBe(0);
    expect(stats.recentStreak).toBe(0);
    expect(stats.sessionsBySubject).toEqual({});
    expect(stats.sessionsByDate).toEqual({});
  });

  it('reports a finite number for every numeric metric, whatever was planted', () => {
    // The end-to-end consequence of the validator. The hostile payload below is exactly the
    // defect the pre-Phase-18 reader had: any object with a string `sessionId` was accepted,
    // so `"lots"` reached every downstream sum and produced `NaN`.
    plant([
      {
        sessionId: 'hostile-1',
        subjectId: SUBJECT_A,
        startedAt: '2026-06-05T09:00:00.000Z',
        endedAt: '2026-06-05T09:30:00.000Z',
        roomsVisited: ['a', 7, null, 'b'],
        notesSubmitted: 'lots',
        reviewsCompleted: -3,
        xpEarned: Number.NaN,
      },
      record({ sessionId: 'hostile-2', notesSubmitted: 2, reviewsCompleted: 1, xpEarned: 7 }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    const numericKeys = Object.keys(stats).filter((key) => typeof stats[key as keyof typeof stats] === 'number');
    // The numeric key set is named rather than discovered, so a metric that silently became a
    // string (the failure mode that makes every `Number(...)` comparison unfailable) fails here.
    expect(numericKeys.sort()).toEqual(
      [
        'activeDays',
        'averageSessionMinutes',
        'consecutiveReviewDayStreak',
        'longestSessionMinutes',
        'recentStreak',
        'roomVisits',
        'sessionsOpen',
        'studyTimeMs',
        'totalMinutesStudied',
        'totalNotesSubmitted',
        'totalReviewsCompleted',
        'totalRoomsVisited',
        'totalSessions',
        'totalXpEarned',
      ].sort(),
    );
    for (const key of numericKeys) {
      expect(Number.isFinite(stats[key as keyof typeof stats] as number), `${key} is not finite`).toBe(true);
    }
    // And the values themselves: the hostile record contributes nothing, the good one all of it.
    expect(stats.totalNotesSubmitted).toBe(2);
    expect(stats.totalReviewsCompleted).toBe(1);
    expect(stats.totalXpEarned).toBe(7);
    // Two valid sessions of 30 minutes each. Rooms: the hostile record's list repaired to
    // `['a','b']` plus the good record's `[ROOM_1]`, so three distinct rooms and three visits.
    expect(stats.totalMinutesStudied).toBe(60);
    expect(stats.totalRoomsVisited).toBe(3);
    expect(stats.roomVisits).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Local-date keys
// ─────────────────────────────────────────────────────────────────────────────

describe('day keys are LOCAL calendar days, and the pair of zones proves it', () => {
  /**
   * The instant every case in this block uses.
   *
   * `2026-06-04T23:00:00Z` is:
   *
   * - `2026-06-05 01:00` in `Africa/Johannesburg` (UTC+2, no DST) → key `2026-06-05`
   * - `2026-06-04 19:00` in `America/New_York` (UTC-4, EDT) → key `2026-06-04`
   * - `2026-06-04 23:00` in `UTC` → key `2026-06-04`
   *
   * The UTC projection is `2026-06-04` in all three, which is precisely what the pre-Phase-18
   * reader filed every session under. Johannesburg is the discriminating zone.
   */
  const AFTER_LOCAL_MIDNIGHT = '2026-06-04T23:00:00.000Z';

  it('files an after-local-midnight session under the NEW local day, not the UTC day', () => {
    pinTimeZone('Africa/Johannesburg');
    plant([record({ sessionId: 's-1', startedAt: AFTER_LOCAL_MIDNIGHT, endedAt: AFTER_LOCAL_MIDNIGHT })]);

    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    // The literal, written from the UTC+2 rule rather than recomputed.
    expect(Object.keys(stats.sessionsByDate)).toEqual(['2026-06-05']);
    expect(stats.sessionsByDate['2026-06-05']).toHaveLength(1);
    // The UTC projection is explicitly absent. Unconditional: it is a plain literal compare,
    // not a branch guarded on "the zone happens to differ".
    expect(stats.sessionsByDate['2026-06-04']).toBeUndefined();
    expect(stats.activeDays).toBe(1);
  });

  it('CONTROL: the very same record files under the UTC day in a UTC host', () => {
    // This is the non-vacuity control for the case above, and it is what makes that case
    // falsifiable. The same stored record, the same call, one variable changed - and the key
    // must be a *different literal*. An implementation that returned a constant key, or
    // projected every instant to UTC, fails the Johannesburg case; an implementation that
    // ignored the host zone entirely fails this one. Neither can pass both.
    pinTimeZone('UTC');
    plant([record({ sessionId: 's-1', startedAt: AFTER_LOCAL_MIDNIGHT, endedAt: AFTER_LOCAL_MIDNIGHT })]);

    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(Object.keys(stats.sessionsByDate)).toEqual(['2026-06-04']);
    expect(stats.sessionsByDate['2026-06-05']).toBeUndefined();
  });

  it('CONTROL: a third zone produces a third literal for the same record', () => {
    pinTimeZone('America/New_York');
    plant([record({ sessionId: 's-1', startedAt: AFTER_LOCAL_MIDNIGHT, endedAt: AFTER_LOCAL_MIDNIGHT })]);

    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(Object.keys(stats.sessionsByDate)).toEqual(['2026-06-04']);
  });

  it('publishes `todayKey` as the local day of the supplied clock', () => {
    // 2026-06-05T21:00:00Z is 2026-06-05 23:00 in Johannesburg and 2026-06-05 17:00 in
    // New York, so "today" agrees in both - and the next instant does not.
    pinTimeZone('Africa/Johannesburg');
    expect(computeSessionStats(new Date('2026-06-05T21:00:00.000Z')).todayKey).toBe('2026-06-05');
    // 2026-06-06T01:00:00Z is 2026-06-06 03:00 Johannesburg. One hour later in UTC, and the
    // local key has already rolled over.
    expect(computeSessionStats(new Date('2026-06-06T01:00:00.000Z')).todayKey).toBe('2026-06-06');

    // New York: 2026-06-06T01:00:00Z is 2026-06-05 21:00, still the 5th.
    pinTimeZone('America/New_York');
    expect(computeSessionStats(new Date('2026-06-06T01:00:00.000Z')).todayKey).toBe('2026-06-05');
  });

  it('groups the two sides of one local midnight into two different days', () => {
    // One session at 23:30 local on the 4th and one at 00:30 local on the 5th, in
    // Johannesburg (UTC+2). Both instants are on the 4th in UTC, so the pre-Phase-18 reader
    // filed them under one day and reported `activeDays: 1`.
    pinTimeZone('Africa/Johannesburg');
    plant([
      record({ sessionId: 's-before', startedAt: '2026-06-04T21:30:00.000Z', endedAt: '2026-06-04T21:45:00.000Z' }),
      record({ sessionId: 's-after', startedAt: '2026-06-04T22:30:00.000Z', endedAt: '2026-06-04T22:45:00.000Z' }),
    ]);
    const stats = computeSessionStats(new Date('2026-06-05T12:00:00.000Z'));
    expect(Object.keys(stats.sessionsByDate).sort()).toEqual(['2026-06-04', '2026-06-05']);
    expect(stats.activeDays).toBe(2);
  });

  it('counts a streak over local days and stops at the gap', () => {
    // 18:00Z is 13:00 in Johannesburg on every one of these days, so each session sits safely
    // mid-day and cannot slide across a local midnight.
    pinTimeZone('Africa/Johannesburg');
    const day = (iso: string): SessionRecord =>
      record({ sessionId: `s-${iso.slice(0, 10)}`, startedAt: iso, endedAt: iso });
    plant([
      day('2026-06-03T18:00:00.000Z'),
      day('2026-06-04T18:00:00.000Z'),
      day('2026-06-05T18:00:00.000Z'),
    ]);
    expect(computeSessionStats(new Date('2026-06-05T20:00:00.000Z')).recentStreak).toBe(3);
    // One day of grace: the learner has not opened the app *today* and has not broken the run.
    expect(computeSessionStats(new Date('2026-06-06T20:00:00.000Z')).recentStreak).toBe(3);
    // Two days of grace is out of range, so the run is broken.
    expect(computeSessionStats(new Date('2026-06-07T20:00:00.000Z')).recentStreak).toBe(0);

    // A gap in the middle breaks the run *at the gap*: 3rd and 5th are one day apart in
    // elapsed time but two calendar days apart, so only the 5th counts.
    plant([day('2026-06-03T18:00:00.000Z'), day('2026-06-05T18:00:00.000Z')]);
    expect(computeSessionStats(new Date('2026-06-05T20:00:00.000Z')).recentStreak).toBe(1);
  });

  it('counts a streak across a spring-forward transition without losing a day', () => {
    // `America/New_York` springs forward on 2026-03-08, so the local day is 23 hours long.
    // The four instants are 18:00Z, which is 13:00 EST / 14:00 EDT - mid-day on all four, so
    // the only thing that can break this is day arithmetic that assumes 86 400 000 ms.
    pinTimeZone('America/New_York');
    const day = (iso: string): SessionRecord =>
      record({ sessionId: `s-${iso.slice(0, 10)}`, startedAt: iso, endedAt: iso });
    plant([
      day('2026-03-06T18:00:00.000Z'),
      day('2026-03-07T18:00:00.000Z'),
      day('2026-03-08T18:00:00.000Z'),
      day('2026-03-09T18:00:00.000Z'),
    ]);
    const stats = computeSessionStats(new Date('2026-03-09T23:00:00.000Z'));
    expect(stats.todayKey).toBe('2026-03-09');
    expect(Object.keys(stats.sessionsByDate).sort()).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    expect(stats.activeDays).toBe(4);
    expect(stats.recentStreak).toBe(4);
  });

  it('CONTROL: the spring-forward zone really does have a 23-hour day, so the case above is live', () => {
    // Without this control the previous case could be passing for the wrong reason - for
    // example if the pinned zone had no DST and the instants happened to be convenient. The
    // elapsed length of two consecutive local noons is read through the public calendar API.
    pinTimeZone('America/New_York');
    plant([
      record({ sessionId: 's-1', startedAt: '2026-03-07T17:00:00.000Z', endedAt: '2026-03-07T17:00:00.000Z' }),
      record({ sessionId: 's-2', startedAt: '2026-03-08T16:00:00.000Z', endedAt: '2026-03-08T16:00:00.000Z' }),
      record({ sessionId: 's-3', startedAt: '2026-03-09T16:00:00.000Z', endedAt: '2026-03-09T16:00:00.000Z' }),
    ]);
    // 2026-03-07T17:00Z is 12:00 EST; 2026-03-08T16:00Z is 12:00 EDT; 2026-03-09T16:00Z is
    // 12:00 EDT. Local noon to local noon is 23 hours across the transition.
    const noon7 = new Date('2026-03-07T17:00:00.000Z').getTime();
    const noon8 = new Date('2026-03-08T16:00:00.000Z').getTime();
    expect(noon8 - noon7).toBe(23 * 60 * 60 * 1000);

    // Three sessions on three consecutive local days, so the streak must be 3 even though the
    // first gap is 23 hours and the second is 24.
    const stats = computeSessionStats(new Date('2026-03-09T23:00:00.000Z'));
    expect(Object.keys(stats.sessionsByDate).sort()).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    expect(stats.recentStreak).toBe(3);
    expect(stats.activeDays).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Record validation against hostile restored input
// ─────────────────────────────────────────────────────────────────────────────

describe('a restored record is validated, not trusted', () => {
  it('refuses every non-object, because the pre-Phase-18 reader accepted any shape', () => {
    for (const hostile of [null, undefined, 0, 7, -1, '', 'session', true, false, Symbol.iterator]) {
      expect(parseSessionRecord(hostile)).toBeNull();
    }
    // Arrays are objects, so they need their own case: an array with a valid-looking member
    // must not be read as a record.
    expect(parseSessionRecord([record()])).toBeNull();
    expect(parseSessionRecord([])).toBeNull();
  });

  it('requires the three fields a record cannot be measured without', () => {
    for (const field of ['sessionId', 'subjectId', 'startedAt'] as const) {
      expect(parseSessionRecord({ ...record(), [field]: undefined }), field).toBeNull();
      expect(parseSessionRecord({ ...record(), [field]: '' }), field).toBeNull();
      expect(parseSessionRecord({ ...record(), [field]: '   ' }), field).toBeNull();
      expect(parseSessionRecord({ ...record(), [field]: 42 }), field).toBeNull();
      expect(parseSessionRecord({ ...record(), [field]: {} }), field).toBeNull();
      expect(parseSessionRecord({ ...record(), [field]: [] }), field).toBeNull();
    }
  });

  it('refuses a timestamp with no time zone, because its day key would depend on the reader', () => {
    // `2026-06-05` and `2026-06-05T09:00:00` both satisfy `Date.parse`, and a key derived
    // from either would be resolved against whatever zone the reading device happened to be in.
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05T09:00:00' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05 09:00:00' })).toBeNull();
    // Numeric epoch milliseconds are not an ISO timestamp and are refused rather than coerced,
    // so the persisted shape has exactly one representation.
    expect(parseSessionRecord({ ...record(), startedAt: 1780650000000 })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: new Date(0).toISOString() })).not.toBeNull();
    // An explicit offset is accepted, which is what a record written in another zone carries.
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05T11:00:00+02:00' })).not.toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: '2026-06-05T11:00:00.123456789+02:00' })).not.toBeNull();
  });

  it('refuses a record that ends before it starts, and accepts an equal pair', () => {
    expect(
      parseSessionRecord({
        ...record(),
        startedAt: '2026-06-05T10:00:00.000Z',
        endedAt: '2026-06-05T09:00:00.000Z',
      }),
    ).toBeNull();
    expect(
      parseSessionRecord({
        ...record(),
        startedAt: '2026-06-05T09:00:00.000Z',
        endedAt: '2026-06-05T09:00:00.000Z',
      }),
    ).not.toBeNull();
  });

  it('refuses a year outside 1..9999, because no calendar key can name it', () => {
    expect(parseSessionRecord({ ...record(), startedAt: '0000-01-01T00:00:00.000Z' })).toBeNull();
    expect(parseSessionRecord({ ...record(), startedAt: '10000-01-01T00:00:00.000Z' })).toBeNull();
    // The two boundaries are accepted, so the rule is a bound and not a blanket refusal.
    // `endedAt` moves with `startedAt`, or the record would be refused for ending before it
    // starts - which is a different rule and is asserted on its own above.
    expect(
      parseSessionRecord({ ...record(), startedAt: '0001-01-01T00:00:00.000Z', endedAt: '0001-01-01T00:00:00.000Z' }),
    ).not.toBeNull();
    expect(
      parseSessionRecord({ ...record(), startedAt: '9999-12-31T23:59:59.999Z', endedAt: '9999-12-31T23:59:59.999Z' }),
    ).not.toBeNull();
  });

  it('clamps a hostile counter to zero rather than letting it into a total', () => {
    const hostile = {
      ...record(),
      notesSubmitted: 'lots',
      reviewsCompleted: -5,
      xpEarned: Number.NaN,
    } as unknown;
    const parsed = parseSessionRecord(hostile);
    expect(parsed).not.toBeNull();
    expect(parsed?.notesSubmitted).toBe(0);
    expect(parsed?.reviewsCompleted).toBe(0);
    expect(parsed?.xpEarned).toBe(0);

    // Every other unusable number, one per call, so a fix that special-cased `'lots'` fails.
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, {}, [], true]) {
      expect(parseSessionRecord({ ...record(), xpEarned: bad })?.xpEarned, String(bad)).toBe(0);
    }
    // A string that *is* numeric is still refused rather than parsed, so the persisted shape
    // has exactly one representation and a future field rename cannot change a total silently.
    expect(parseSessionRecord({ ...record(), xpEarned: '31' })?.xpEarned).toBe(0);
  });

  it('truncates a fractional counter instead of carrying a fraction into a sum', () => {
    expect(parseSessionRecord({ ...record(), notesSubmitted: 3.9 })?.notesSubmitted).toBe(3);
    expect(parseSessionRecord({ ...record(), reviewsCompleted: 0.4 })?.reviewsCompleted).toBe(0);
  });

  it('repairs a bad room list rather than losing the session with it', () => {
    const parsed = parseSessionRecord({
      ...record(),
      roomsVisited: [ROOM_1, 7, null, '', '   ', { id: 'nope' }, ROOM_2],
    });
    // Non-empty strings survive in order; every other member is filtered out. Note that
    // `'   '` is dropped: `isNonEmptyString` trims before testing.
    expect(parsed?.roomsVisited).toEqual([ROOM_1, ROOM_2]);
    // A non-array becomes an empty list, not a rejection: the study time is worth more than
    // the room list.
    expect(parseSessionRecord({ ...record(), roomsVisited: ROOM_1 })?.roomsVisited).toEqual([]);
    expect(parseSessionRecord({ ...record(), roomsVisited: undefined })?.roomsVisited).toEqual([]);
    expect(parseSessionRecord({ ...record(), roomsVisited: null })?.roomsVisited).toEqual([]);
    expect(parseSessionRecord({ ...record(), roomsVisited: 5 })?.roomsVisited).toEqual([]);
  });

  it('drops an unusable `lastActivityAt` and keeps a usable one', () => {
    expect(parseSessionRecord(record())?.lastActivityAt).toBeUndefined();
    expect(Object.keys(parseSessionRecord(record()) as object)).not.toContain('lastActivityAt');
    for (const bad of ['nope', 5, {}, [], '', null, '2026-06-05']) {
      expect(parseSessionRecord({ ...record(), lastActivityAt: bad })?.lastActivityAt, String(bad)).toBeUndefined();
    }
    expect(parseSessionRecord({ ...record(), lastActivityAt: '2026-06-05T09:12:00.000Z' })?.lastActivityAt).toBe(
      '2026-06-05T09:12:00.000Z',
    );
  });

  it('keeps a string subject name verbatim and defaults every other type to the empty string', () => {
    expect(parseSessionRecord({ ...record(), subjectName: 'Kept' })?.subjectName).toBe('Kept');
    // Whitespace is preserved: the name is presentation, and trimming it would change what a
    // learner sees in a session card.
    expect(parseSessionRecord({ ...record(), subjectName: ' Padded ' })?.subjectName).toBe(' Padded ');
    for (const bad of [42, {}, [], true, null, undefined]) {
      expect(parseSessionRecord({ ...record(), subjectName: bad })?.subjectName).toBe('');
    }
  });

  it('trims the two identity fields but not the timestamps', () => {
    const parsed = parseSessionRecord({ ...record(), sessionId: '  s-1  ', subjectId: '  subj-a  ' });
    expect(parsed?.sessionId).toBe('s-1');
    expect(parsed?.subjectId).toBe('subj-a');
    expect(parsed?.startedAt).toBe('2026-06-05T09:00:00.000Z');
    expect(parsed?.endedAt).toBe('2026-06-05T09:30:00.000Z');
  });

  it('never throws for any payload JSON.parse can produce', () => {
    // The totality claim, scoped to the input the contract is actually stated over. A session
    // record reaches this module from `readArchiveJson`, which is `JSON.parse`, so the reachable
    // untrusted values are plain data: no getters, no prototypes, no proxies. Each value below
    // carries a member that throws if the module *calls* it rather than type-tests it, which is
    // the specific way a validator written as `toCount(value)` could become non-total.
    const hostile: unknown[] = [
      { sessionId: 's', subjectId: 'a', startedAt: { toString() { throw new Error('boom'); } }, endedAt: null },
      {
        sessionId: 's',
        subjectId: 'a',
        startedAt: '2026-06-05T09:00:00.000Z',
        endedAt: '2026-06-05T09:30:00.000Z',
        roomsVisited: { length: 3 },
      },
      {
        sessionId: 's',
        subjectId: 'a',
        startedAt: '2026-06-05T09:00:00.000Z',
        endedAt: '2026-06-05T09:30:00.000Z',
        notesSubmitted: { valueOf() { throw new Error('boom'); } },
      },
      {
        sessionId: 's',
        subjectId: 'a',
        startedAt: '2026-06-05T09:00:00.000Z',
        endedAt: '2026-06-05T09:30:00.000Z',
        lastActivityAt: { valueOf() { throw new Error('boom'); } },
      },
    ];
    for (const value of hostile) {
      expect(() => parseSessionRecord(value)).not.toThrow();
    }
    // And each of those resolves to `null` or to a repaired record rather than to a throw.
    expect(parseSessionRecord(hostile[0])).toBeNull();
    expect(parseSessionRecord(hostile[1])?.roomsVisited).toEqual([]);
    expect(parseSessionRecord(hostile[2])?.notesSubmitted).toBe(0);
    expect(parseSessionRecord(hostile[3])?.lastActivityAt).toBeUndefined();
  });
});

describe('the stored read is total, de-duplicating, and ordered', () => {
  it('keeps the first of two records sharing one id, and reports which one', () => {
    plant([
      record({ sessionId: 'dup', xpEarned: 10 }),
      record({ sessionId: 'dup', xpEarned: 20 }),
    ]);
    const records = readSessionRecords();
    expect(records).toHaveLength(1);
    expect(records[0].xpEarned).toBe(10);
    // And the aggregate reflects the survivor only.
    expect(computeSessionStats(new Date('2026-06-05T12:00:00.000Z')).totalXpEarned).toBe(10);
  });

  it('returns an empty list for every unusable payload rather than throwing', () => {
    for (const payload of [null, undefined, 0, 7, 'nonsense', '{}', true, { sessionId: 'x' }]) {
      plant(payload);
      expect(readSessionRecords()).toEqual([]);
    }
    plantRaw('{not json');
    expect(readSessionRecords()).toEqual([]);
    plantRaw('');
    expect(readSessionRecords()).toEqual([]);
    plantRaw('null');
    expect(readSessionRecords()).toEqual([]);
    // And a completely absent key.
    window.localStorage.removeItem(STORAGE_KEY);
    expect(readSessionRecords()).toEqual([]);
  });

  it('keeps the good records around the bad ones, in stored order', () => {
    plant([
      'not-a-session',
      { sessionId: 'no-subject' },
      record({ sessionId: 'good-1' }),
      null,
      record({ sessionId: 'good-2', endedAt: null }),
      [],
      record({ sessionId: 'good-3' }),
    ]);
    const records = readSessionRecords();
    expect(records.map((entry) => entry.sessionId)).toEqual(['good-1', 'good-2', 'good-3']);
    // The open record is preserved as an open record rather than being closed or dropped.
    expect(records[1].endedAt).toBeNull();
  });

  it('reads back exactly what it wrote, byte for byte, after a serialize/parse round trip', () => {
    const original = record({ sessionId: 's-1', roomsVisited: [ROOM_1, ROOM_2], lastActivityAt: '2026-06-05T09:20:00.000Z' });
    plant([original]);
    const raw = window.localStorage.getItem(STORAGE_KEY) as string;
    plantRaw(raw);
    expect(readSessionRecords()).toEqual([original]);
    // The persisted shape is the documented field set - nine fields plus the optional one -
    // so a field added to the record type without being persisted is caught here.
    expect(Object.keys(JSON.parse(raw)[0] as object).sort()).toEqual(
      [
        'endedAt',
        'lastActivityAt',
        'notesSubmitted',
        'reviewsCompleted',
        'roomsVisited',
        'sessionId',
        'startedAt',
        'subjectId',
        'subjectName',
        'xpEarned',
      ].sort(),
    );
  });
});

describe('mergeSessionRecord is the keyed write, and it is pinned by value', () => {
  it('replaces by id and appends otherwise, both in stored order', () => {
    const merged = mergeSessionRecord(
      [record({ sessionId: 'a' }), record({ sessionId: 'b' })],
      record({ sessionId: 'a', xpEarned: 99 }),
    );
    expect(merged.map((entry) => entry.sessionId)).toEqual(['b', 'a']);
    expect(merged[1].xpEarned).toBe(99);

    const appended = mergeSessionRecord([record({ sessionId: 'a' })], record({ sessionId: 'c' }));
    expect(appended.map((entry) => entry.sessionId)).toEqual(['a', 'c']);
  });

  it('converges on ONE record no matter how many times the same id is written', () => {
    let stored: SessionRecord[] = [];
    for (let index = 0; index < 25; index += 1) {
      stored = mergeSessionRecord(stored, record({ sessionId: 'same', xpEarned: index }));
    }
    expect(stored).toHaveLength(1);
    expect(stored[0].xpEarned).toBe(24);
  });

  it('never evicts the record being written, however small the retention', () => {
    const existing = [
      record({ sessionId: 'old-1' }),
      record({ sessionId: 'old-2' }),
      record({ sessionId: 'old-3' }),
    ];
    expect(mergeSessionRecord(existing, record({ sessionId: 'newest' }), 3).map((entry) => entry.sessionId)).toEqual([
      'old-2',
      'old-3',
      'newest',
    ]);
    // A retention of zero or less still keeps the write in flight, because dropping it would
    // report study time the learner did not lose.
    expect(mergeSessionRecord(existing, record({ sessionId: 'newest' }), 0).map((entry) => entry.sessionId)).toEqual([
      'newest',
    ]);
    expect(mergeSessionRecord(existing, record({ sessionId: 'newest' }), -5).map((entry) => entry.sessionId)).toEqual([
      'newest',
    ]);
  });

  it('does not mutate the list it was given', () => {
    const existing: SessionRecord[] = [record({ sessionId: 'a' })];
    const snapshot = JSON.stringify(existing);
    mergeSessionRecord(existing, record({ sessionId: 'b' }));
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('keeps BOTH records when two writers each built their write from their own earlier read', () => {
    // The read-modify-write race the keyed write replaces. The control is that the *whole-list*
    // approach loses one, computed here rather than asserted about the module:
    //
    //   writer 1 reads [] and writes [s1]
    //   writer 2 reads [] and writes [s2]   <- s1 is gone
    //
    // The module's own merge is then applied twice in that same order and must keep both,
    // because it re-reads whatever the store currently holds rather than a snapshot taken
    // before the other writer landed.
    const readByFirst: SessionRecord[] = [];
    const readBySecond: SessionRecord[] = [];
    const wholeListWrite1 = [...readByFirst, record({ sessionId: 's1' })];
    const wholeListWrite2 = [...readBySecond, record({ sessionId: 's2' })];
    expect(wholeListWrite2.map((entry) => entry.sessionId)).toEqual(['s2']);
    expect(wholeListWrite1.map((entry) => entry.sessionId)).not.toEqual(
      wholeListWrite2.map((entry) => entry.sessionId),
    );

    let stored: SessionRecord[] = [];
    stored = mergeSessionRecord(stored, record({ sessionId: 's1' }));
    stored = mergeSessionRecord(stored, record({ sessionId: 's2' }));
    expect(stored.map((entry) => entry.sessionId)).toEqual(['s1', 's2']);

    // And in the reverse order, so the property is not an artefact of argument order.
    let reversed: SessionRecord[] = [];
    reversed = mergeSessionRecord(reversed, record({ sessionId: 's2' }));
    reversed = mergeSessionRecord(reversed, record({ sessionId: 's1' }));
    expect(reversed.map((entry) => entry.sessionId)).toEqual(['s2', 's1']);
  });
});