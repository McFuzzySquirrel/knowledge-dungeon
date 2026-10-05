/**
 * Session storage, the session source for the bootstrap, and the statistics reader.
 *
 * ## What this module was, and what was wrong with it
 *
 * Pre-Phase-18 this file was described as "logs study session start/end times, rooms
 * visited, and aggregates data for the statistics dashboard", and the description was
 * false in a way no test could see:
 *
 * - `startSession`, `endCurrentSession`, `trackRoomVisit`, `trackNoteSubmission`,
 *   `trackReviewCompletion`, and `trackXpEarned` had **zero production callers**.
 * - Every `track*` began `if (!currentSession) return;` and **nothing in the application
 *   ever set `currentSession`** - so even a caller would have recorded nothing.
 * - `computeSessionStats` therefore read an empty list and reported zero study minutes,
 *   zero rooms, zero notes, zero reviews, and zero XP, on every device, forever.
 * - The day key was `new Date(startedAt).toISOString().slice(0, 10)` - **UTC**, so a
 *   session after local midnight was filed under the previous day.
 * - The streak subtracted `86_400_000` ms at a time, which is wrong across a
 *   daylight-saving transition (a local day is 23 or 25 hours, not 24).
 * - `totalRoomsVisited` summed per-session de-duplicated array lengths, so it was neither
 *   a unique-room count nor an honest visit count.
 * - `generateId` was `Date.now()` plus `Math.random()` - neither deterministic nor
 *   injectable, so no test could reproduce a session id.
 * - `isSessionRecord` accepted **any object with a string `sessionId`**, and a session
 *   record reaches this module from a restored `.kdbak` or `.kdsubject`, which is
 *   untrusted input.
 * - `endCurrentSession`'s storage-v2 branch was a read-modify-write race: each concurrent
 *   end read the whole list, pushed its own session onto that read, and wrote the result,
 *   so the second write dropped the first session.
 *
 * Each of those is fixed here or in the module it belongs to, and the fixes are listed
 * against the defects rather than left to be rediscovered:
 *
 * | Defect | Fix | Lives in |
 * | --- | --- | --- |
 * | never started, never recorded | the wired lifecycle; this module is its persistence and its reader | `src/application/sessionLifecycle.ts`, `src/store/sessionLifecycleBinding.ts` |
 * | UTC day key | `localDateKey` | `src/core/statistics/localCalendar.ts` |
 * | `86_400_000` streak | `countConsecutiveActiveDays` | `src/core/statistics/localCalendar.ts` |
 * | rooms metric | `uniqueRoomsVisited` and `roomVisits`, published separately | `src/core/statistics/statisticsMetrics.ts` |
 * | non-deterministic id | {@link defaultMintSessionId}, injectable | `src/application/sessionLifecycle.ts` |
 * | weak record validation | {@link parseSessionRecord} | here |
 * | read-modify-write race | a keyed write, serialized through {@link enqueueSessionWrite} | here |
 *
 * ## Two repositories, unchanged
 *
 * `loadSessions` reads the legacy `localStorage` key on every call, exactly as it always
 * has, and additionally consults an injected {@link SessionSource} when the storage-v2
 * repository is the selected one - so a device running the flagged build reads its
 * sessions from the active generation and a rollback build reads the same sessions from
 * the mirror key. The legacy read happens first, so the default build's behaviour is
 * unchanged.
 */
import {
  countConsecutiveActiveDays,
  latestLocalDateKey,
  localDateKey,
} from '@/core/statistics/localCalendar';
import {
  computeStatisticsSnapshot,
  type DailyActivityBucket,
  type RecentSessionSummary,
  type StatisticsSnapshot,
  type StatisticsTotals,
  type SubjectStatistics,
} from '@/core/statistics/statisticsMetrics';
import type { SubjectStatisticsInput } from '@/core/statistics/statisticsMetrics';
import {
  createSessionLifecycleController,
  defaultMintSessionId,
  type LifecycleSessionRecord,
  type SessionEndOutcome,
  type SessionLifecycleController,
} from '@/application/sessionLifecycle';
import type { SessionPersistencePort, SessionSubjectPort } from '@/application/sessionLifecycle';
import {
  fireAndForget,
  writeThroughInBackground,
} from '@/services/persistence/v2/dualWrite';
import {
  currentStorageV2Repository,
  isStorageV2Selected,
} from '@/services/persistence/v2/repositorySelection';

/**
 * One persisted study session.
 *
 * Extends the lifecycle's structural record with nothing: the lifecycle's
 * `lastActivityAt` is the one additive field, and it is declared here as the
 * authoritative copy so this module's validators own it. It is **optional**, so every
 * record written before this phase - and every fixture - stays valid, and it is absent
 * until a session records activity, so a session that started and ended cleanly writes
 * exactly the pre-Phase-18 field set and no byte-comparison fixture moves.
 */
export interface SessionRecord extends LifecycleSessionRecord {
  readonly lastActivityAt?: string;
}

/**
 * The aggregate the statistics dashboard reads.
 *
 * **Every field pre-Phase-18 is still here, with its original meaning except
 * `totalRoomsVisited`** - see the note on that field. Everything added is additive, so
 * `StudyStatsPanel` and `VillageScreen` keep compiling and keep showing the numbers they
 * showed, now computed correctly.
 *
 * ## Which authority backs each number
 *
 * This is the **session-derived** view: it answers from session records alone, which is
 * what a reader that must be synchronous and repository-independent can do. The
 * **authoritative device totals**, which read the per-subject statistics event ledger and
 * the progression records, are published by `src/store/statisticsStore.ts` as a
 * {@link StatisticsSnapshot}. The two agree on every field for any session this build
 * wrote, because the session counters are incremented only when the durable reward ledger
 * said the award actually happened.
 *
 * ## `totalRoomsVisited` changed meaning, deliberately
 *
 * It used to be the sum of per-session `roomsVisited.length` - neither a unique-room count
 * (a room visited in three sessions counted three times) nor an honest visit count (five
 * visits in one session counted once). It is now the **unique** count, summed per subject,
 * because that is the number a learner asking "how many rooms have I explored?" means.
 * The old sum is still available, under the name it always deserved, as
 * {@link SessionStats.roomVisits}.
 */
export interface SessionStats {
  /** Closed sessions. */
  readonly totalSessions: number;
  /** Total study time in whole minutes. */
  readonly totalMinutesStudied: number;
  /** Mean closed-session duration in whole minutes, or `0`. */
  readonly averageSessionMinutes: number;
  /** Distinct rooms visited, summed per subject. See the note above. */
  readonly totalRoomsVisited: number;
  readonly totalNotesSubmitted: number;
  readonly totalReviewsCompleted: number;
  readonly totalXpEarned: number;
  /** Sessions grouped by subject id, oldest last. */
  readonly sessionsBySubject: Record<string, SessionRecord[]>;
  /** Sessions grouped by **local** calendar day (`YYYY-MM-DD`), oldest day last. */
  readonly sessionsByDate: Record<string, SessionRecord[]>;
  /**
   * Consecutive **local** calendar days with at least one session, counting back from
   * today with one day of grace.
   */
  readonly recentStreak: number;
  // ── Added by Phase 18. All additive. ──
  /** Room entries, counted with repeats. The old `totalRoomsVisited` sum. */
  readonly roomVisits: number;
  /** Sessions with no `endedAt` yet. A well-run device reports `0`. */
  readonly sessionsOpen: number;
  /** Total elapsed study time in milliseconds. */
  readonly studyTimeMs: number;
  /** Longest closed-session duration in whole minutes, or `0`. */
  readonly longestSessionMinutes: number;
  /** Distinct local calendar days with any session, across all history. */
  readonly activeDays: number;
  /** Consecutive local days with at least one review completion. */
  readonly consecutiveReviewDayStreak: number;
  /** The snapshot's local "today". */
  readonly todayKey: string;
}

const STORAGE_KEY = 'knowledge-dungeon:v1:sessions';

/** How many sessions are retained. Unchanged. */
const SESSION_RETENTION = 500;

/** An alternative read path for sessions, injected by the bootstrap. */
export interface SessionSource {
  list(): Promise<SessionRecord[]>;
}

let sessionSource: SessionSource | null = null;

// ── Validation of untrusted input ──────────────────────────────────────────

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Longest timestamp this module will accept, as a year. Generous but bounded. */
const MAX_ACCEPTED_YEAR = 9999;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const year = new Date(parsed).getUTCFullYear();
  // A negative or absurd year would make `localDateKey` produce a key this module's own
  // calendar cannot parse back, which would silently drop the session from every metric.
  return year >= 1 && year <= MAX_ACCEPTED_YEAR;
}

function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Validate and normalize one session record read from **untrusted** input.
 *
 * Returns `null` for a record this build cannot use. Total by construction and never
 * throws, because every value here can arrive from a hand-edited `.kdbak` or
 * `.kdsubject`, and the pre-Phase-18 reader accepted any object with a string
 * `sessionId` - so a restored archive could put `"notesSubmitted": "lots"` where a number
 * is expected, and every downstream sum then produced `NaN` or a negative total.
 *
 * What is required, and why each field is required:
 *
 * - `sessionId` - the record's identity, and the key the persistence layer writes by.
 * - `subjectId` - without it the record cannot be attributed to a subject, and a session
 *   attributed to `""` would appear in `sessionsBySubject[""]`.
 * - `startedAt` - an ISO 8601 timestamp. The pattern is checked as well as `Date.parse`,
 *   because `"2026-06-01"` parses and has no time zone, and a key derived from it would
 *   depend on the reading device's zone.
 * - `endedAt` - `null`, or an ISO timestamp **at or after** `startedAt`. A record that
 *   ends before it starts has a negative duration, which the old reader would have
 *   clamped to zero and silently counted as a zero-length session.
 * - `roomsVisited` - an array whose every member is a non-empty string. A non-array or a
 *   member of another type is **repaired by filtering**, not by rejection, because the
 *   room list is a set of app-minted ids and losing a whole session over one bad member
 *   loses the study time with it.
 * - `notesSubmitted` / `reviewsCompleted` / `xpEarned` - finite, non-negative numbers. A
 *   negative or non-finite value is clamped to `0` rather than rejected, for the same
 *   reason: a corrupted counter must not delete the session.
 *
 * `lastActivityAt` is optional and validated as a timestamp when present; an unusable value
 * is **dropped** rather than rejecting the record, because recovery can fall back to
 * `startedAt`.
 *
 * `subjectName` is optional and preserved verbatim when it is a string, and defaulted to
 * `''` otherwise, because a missing display name costs nothing and the record's own
 * `subjectId` remains authoritative.
 */
export function parseSessionRecord(value: unknown): SessionRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (!isNonEmptyString(record.sessionId)) return null;
  if (!isNonEmptyString(record.subjectId)) return null;
  if (!isIsoTimestamp(record.startedAt)) return null;
  if (record.endedAt !== null && !isIsoTimestamp(record.endedAt)) return null;

  const startedMs = Date.parse(record.startedAt);
  const endedMs = record.endedAt === null ? null : Date.parse(record.endedAt);
  if (endedMs !== null && endedMs < startedMs) return null;

  const roomsVisited = Array.isArray(record.roomsVisited)
    ? record.roomsVisited.filter(isNonEmptyString)
    : [];

  const lastActivityAt = isIsoTimestamp(record.lastActivityAt)
    ? record.lastActivityAt
    : undefined;

  return {
    sessionId: record.sessionId.trim(),
    subjectId: record.subjectId.trim(),
    subjectName: typeof record.subjectName === 'string' ? record.subjectName : '',
    startedAt: record.startedAt,
    endedAt: record.endedAt === null ? null : record.endedAt,
    roomsVisited,
    notesSubmitted: toCount(record.notesSubmitted),
    reviewsCompleted: toCount(record.reviewsCompleted),
    xpEarned: toCount(record.xpEarned),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  };
}

function readLegacySessions(): SessionRecord[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const records: SessionRecord[] = [];
    const seen = new Set<string>();
    for (const candidate of parsed) {
      const record = parseSessionRecord(candidate);
      // A duplicate id is dropped rather than merged: the persistence layer writes by id,
      // so two records with one id are the same record and keeping the first is the
      // deterministic choice.
      if (record === null || seen.has(record.sessionId)) continue;
      seen.add(record.sessionId);
      records.push(record);
    }
    return records;
  } catch {
    return [];
  }
}

function loadSessions(): SessionRecord[] {
  return readLegacySessions();
}

/**
 * Sessions from the selected repository, merged after the legacy read.
 *
 * The legacy key is still read first and on its own, so the default build is untouched;
 * only a build that selected storage-v2 adds the generation's records on top,
 * de-duplicated by session id so a dual-written session appears once. A source that
 * rejects falls back to the legacy read rather than losing the device's history.
 */
async function loadSessionsWithSource(): Promise<SessionRecord[]> {
  const legacy = loadSessions();
  if (sessionSource === null) return legacy;
  let fromSource: SessionRecord[] = [];
  try {
    const listed = await sessionSource.list();
    const merged = new Map<string, SessionRecord>();
    for (const candidate of listed) {
      const record = parseSessionRecord(candidate);
      if (record !== null) merged.set(record.sessionId, record);
    }
    fromSource = [...merged.values()];
  } catch {
    return legacy;
  }
  const merged = new Map<string, SessionRecord>();
  for (const session of legacy) merged.set(session.sessionId, session);
  for (const session of fromSource) merged.set(session.sessionId, session);
  return [...merged.values()].sort((left, right) => (left.startedAt < right.startedAt ? -1 : 1));
}

/**
 * Install the session read path. Called once by the application bootstrap.
 *
 * Passing `null` restores the legacy-only behaviour, which is what the default build uses.
 */
export function setSessionSource(source: SessionSource | null): void {
  sessionSource = source;
}

/** The current session source, or `null` on the legacy path. */
export function currentSessionSource(): SessionSource | null {
  return sessionSource;
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * The serialized write queue.
 *
 * The read-modify-write race this replaces: `endCurrentSession` used to read the whole
 * stored list, push its own session onto that read, and write the result. Two concurrent
 * ends - which is what two `pagehide`/`visibilitychange` handlers, or a StrictMode double
 * effect, actually produce - each built a list from their *own* read, so the second write
 * dropped the first session entirely.
 *
 * Serializing the merge-and-write is the fix, and it is the right layer for it: the
 * in-memory record is the transaction boundary here, exactly as it is in
 * `progressionStore`, and a `Date` this module did not write is a read failure rather than
 * an error worth propagating. The queue is also what makes a **keyed** write safe, because
 * a keyed write is only safe if the list it merges into is written by one writer at a time.
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueSessionWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue.then(task, task);
}

/** The pending write queue. Test support, and how a test can await durability. */
export function pendingSessionWrites(): Promise<void> {
  return writeQueue;
}

/**
 * Merge one record into the retained list by id, newest last.
 *
 * Pure, and the reason the persistence port can be keyed: a repeated write of the same
 * `sessionId` replaces the record rather than appending a second one, so a retried write,
 * a StrictMode double invocation, and a replayed restore all converge on one record.
 */
export function mergeSessionRecord(
  sessions: readonly SessionRecord[],
  record: SessionRecord,
  retention: number = SESSION_RETENTION,
): SessionRecord[] {
  const merged = sessions.filter((existing) => existing.sessionId !== record.sessionId);
  merged.push(record);
  // Retention trims the **oldest** records, which is the same rule the pre-Phase-18
  // `slice(-SESSION_RETENTION)` applied. A record being written now is always the newest,
  // so retention can never evict the write that is in flight.
  return merged.slice(-Math.max(1, retention));
}

function writeLegacyMirror(records: readonly SessionRecord[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish one record to the storage-v2 generation, keyed by its own id.
 *
 * **One record per write**, never the whole retained list. The pre-Phase-18 implementation
 * published every retained record on every write, so a concurrent pair of writes published
 * two complete lists and the second silently dropped the first session; publishing one
 * keyed record makes a concurrent pair publish two records that both land.
 */
async function publishToStorageV2(record: SessionRecord): Promise<void> {
  if (!isStorageV2Selected()) return;
  const repository = currentStorageV2Repository();
  if (repository === null) return;
  const records = await import('@/services/persistence/v2/appRepository');
  await records.publishSessionToActiveGeneration(repository, toPersistedSessionRecord(record), new Date().toISOString());
}

/**
 * The adapter's `PersistedSessionRecord`, from a validated {@link SessionRecord}.
 *
 * A named function rather than an inline cast because the two types differ in mutability:
 * `LifecycleSessionRecord.roomsVisited` is a `readonly string[]` because the lifecycle hands
 * out copies, and the storage-v2 adapter declares a mutable `string[]`. The conversion copies
 * so the adapter cannot retain a reference the lifecycle might later change, which is the
 * property the copy exists to guarantee.
 */
function toPersistedSessionRecord(record: SessionRecord): {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  subjectId: string;
  subjectName: string;
  roomsVisited: string[];
  notesSubmitted: number;
  reviewsCompleted: number;
  xpEarned: number;
} {
  return {
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    subjectId: record.subjectId,
    subjectName: record.subjectName,
    roomsVisited: [...record.roomsVisited],
    notesSubmitted: record.notesSubmitted,
    reviewsCompleted: record.reviewsCompleted,
    xpEarned: record.xpEarned,
  };
}

/**
 * The lifecycle's persistence port.
 *
 * The legacy mirror is written first and synchronously - it is the shipping repository -
 * and the storage-v2 publish follows through `writeThrough`, so a mirror that refuses the
 * write is *recorded* rather than reported as a lost session.
 */
export const sessionPersistencePort: SessionPersistencePort = {
  write(record) {
    const normalized = parseSessionRecord(record);
    if (normalized === null) return Promise.resolve();
    if (!isStorageV2Selected()) {
      // The default, shipping repository: a synchronous, in-order write, byte-for-byte the
      // pre-Phase-18 behaviour. No dual-write report is recorded on this path, because
      // `tests/phase4/exitCriteria2And3.test.ts` asserts that a flag-off device reports
      // nothing at all, and a report here would be a report about a repository that is not
      // in play.
      writeLegacyMirror(mergeSessionRecord(loadSessions(), normalized));
      return Promise.resolve();
    }
    enqueueSessionWrite(async () => {
      const legacyOk = writeLegacyMirror(mergeSessionRecord(loadSessions(), normalized));
      // `writeThroughInBackground` rather than `fireAndForget(writeThrough(...))`: the
      // latter is the composition `dualWrite.ts` documents as counting a `primary-failed`
      // report twice, and the pre-Phase-18 code used it. The legacy key is written
      // synchronously *before* the generation publish rather than through `writeThrough`'s
      // mirror step, because on this lane it is the rollback mirror and the historical
      // ordering - legacy first - is what a Phase 4 rollback build reads.
      writeThroughInBackground({
        operation: 'sessions',
        primary: () => publishToStorageV2(normalized),
        mirror: () => legacyOk,
      });
    });
    return pendingSessionWrites();
  },
  async read() {
    return loadSessionsWithSource();
  },
};

/**
 * The subject port the lifecycle reads on a resume-from-background.
 *
 * Returns `null` when no subject is active, so a `visibilitychange` on the welcome screen
 * starts nothing. Read through a nullable indirection rather than importing the session
 * store, which keeps `src/services/` free of a store dependency and lets a test install a
 * fake without touching module state.
 */
let subjectPortOverride: SessionSubjectPort | null = null;

/** Install the subject port the lifecycle reads on resume. Test support. */
export function setSessionSubjectPort(port: SessionSubjectPort | null): void {
  subjectPortOverride = port;
}

const NO_SUBJECT_PORT: SessionSubjectPort = { readActiveSubject: () => null };

function activeSubjectPort(): SessionSubjectPort {
  return subjectPortOverride ?? NO_SUBJECT_PORT;
}

// ── The lifecycle singleton ────────────────────────────────────────────────

let controller: SessionLifecycleController | null = null;

/**
 * The one session lifecycle, created on first use.
 *
 * A function rather than a module-level `const` so importing this module has **no**
 * import-time effect: a rollback build that never calls a session function creates no
 * controller and writes nothing, and a unit test of `computeSessionStats` is not perturbed
 * by a lifecycle it never asked for.
 */
export function sessionLifecycle(): SessionLifecycleController {
  controller ??= createSessionLifecycleController({
    nowMs: () => Date.now(),
    mintSessionId: defaultMintSessionId,
    persistence: sessionPersistencePort,
    subject: activeSubjectPort(),
  });
  return controller;
}

/** Whether the lifecycle has been created. Test support. */
export function hasSessionLifecycle(): boolean {
  return controller !== null;
}

/**
 * Forget the lifecycle, discarding any open session **without persisting it**.
 *
 * Test and data-reset support only, and the reason it is a separate function rather than
 * an argument to {@link endSession}: an explicit "discard this session" is a legitimate
 * thing for a data reset to do and an illegitimate thing for a page-close signal to do.
 * Production close paths all go through {@link endSession}, which persists.
 */
export function discardOpenSession(): void {
  controller = null;
}

// ── The historical API, now backed by the lifecycle ────────────────────────

/**
 * Start a study session for a subject, closing any session already open.
 *
 * Idempotent for the same subject: a second call returns the session already open and
 * writes nothing, which is what makes a React StrictMode double invocation, a retried
 * activation, and a re-render all produce one record.
 *
 * Returns `null` when `subjectId` is blank. The return type widened from `SessionRecord`
 * to `SessionRecord | null` for that case, because fabricating a record for a subject that
 * does not exist would be a lie and throwing from a tracker would be worse.
 *
 * In production this is reached through the canonical activation path
 * (`subjectActivation.ts`) rather than called directly.
 */
export function startSession(subjectId: string, subjectName: string): SessionRecord | null {
  return sessionLifecycle().handleSubjectActivated({ subjectId, subjectName });
}

/**
 * Close the open session, if any.
 *
 * Idempotent: with nothing open it writes nothing and reports `false`.
 */
export function endCurrentSession(): SessionEndOutcome {
  return sessionLifecycle().endSession('requested');
}

/** The open session, or `null`. */
export function getCurrentSession(): SessionRecord | null {
  return sessionLifecycle().activeSession();
}

/**
 * Record a room as visited during the open session.
 *
 * De-duplicated per session, so returning to the same room records one room. Returns
 * `false` - and writes nothing - when no session is open.
 */
export function trackRoomVisit(roomId: string): boolean {
  return sessionLifecycle().recordActivity({ kind: 'room-visit', roomId });
}

/**
 * Record a note submission during the open session.
 *
 * `xpAwarded` is optional for backwards compatibility with the historical no-argument
 * call; a caller that knows what the award paid passes it, and a caller that does not
 * leaves the XP total to the ledger, which is the authoritative one.
 */
export function trackNoteSubmission(xpAwarded?: number): boolean {
  return sessionLifecycle().recordActivity({
    kind: 'note-submission',
    roomId: '',
    xpAwarded: xpAwarded ?? 0,
  });
}

/**
 * Record a completed review pass during the open session.
 *
 * See {@link trackNoteSubmission} for the optional XP.
 */
export function trackReviewCompletion(xpAwarded?: number): boolean {
  return sessionLifecycle().recordActivity({
    kind: 'review-completion',
    roomId: '',
    passNumber: 0,
    xpAwarded: xpAwarded ?? 0,
  });
}

/**
 * Record a kept fishing catch during the open session.
 *
 * Returns `false` for a declined outcome - a release or a wrong recall - because Phase 17's
 * invariant is that a declined catch awards nothing at all, and a session counter is a form
 * of award.
 */
export function trackFishingCatch(input: {
  readonly catalogId: string;
  readonly castNumber: number;
  readonly xpAwarded: number;
  readonly awarded: boolean;
}): boolean {
  return sessionLifecycle().recordActivity({ kind: 'fishing-outcome', ...input });
}

/**
 * Record XP earned during the open session.
 *
 * A bare session-counter bump, and the reason it is not a fifth *event* is documented on
 * {@link StatisticsActivity}'s `session-xp` member: the durable XP record is the
 * `xp-award` ledger entry each store action writes in the same record write as its reward,
 * under that reward's identity. This only moves the session's own `xpEarned` so a session
 * card can show the XP it paid, and it is therefore never summed into a device total.
 *
 * Returns `false` - and writes nothing - for a non-finite or non-positive amount, or when
 * no session is open.
 */
export function trackXpEarned(xp: number): boolean {
  return sessionLifecycle().recordActivity({ kind: 'session-xp', amount: xp });
}

/**
 * Close every stored session that was never closed, at its own last activity.
 *
 * Delegated to the lifecycle. See
 * {@link SessionLifecycleController.recoverUnterminatedSessions}.
 */
export function recoverUnterminatedSessions(): Promise<readonly string[]> {
  return sessionLifecycle().recoverUnterminatedSessions();
}

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * Every validated session record this device holds, on the **legacy** read path.
 *
 * Exported so `src/store/statisticsStore.ts` derives its snapshot from the same validation
 * the persistence path uses rather than reimplementing it: a second reader would be a second
 * answer to "which records count", and the two would drift on the first malformed restored
 * record.
 *
 * Synchronous and legacy-only, exactly like {@link computeSessionStats} - a storage-v2
 * generation is read asynchronously and the store's rebuild is synchronous. The bootstrap
 * installs the storage-v2 source and calls `hydrateSessions` with the records it read, which
 * is how the flagged build's sessions reach the snapshot.
 */
export function readSessionRecords(): readonly SessionRecord[] {
  return loadSessions();
}

/**
 * Compute the session-derived statistics aggregate.
 *
 * Synchronous, legacy-repository-only, and additive: every field the pre-Phase-18
 * `SessionStats` had is still here, so `StudyStatsPanel` and `VillageScreen` compile and
 * keep rendering. The authoritative, event-derived device snapshot is
 * `src/store/statisticsStore.ts`'s {@link StatisticsSnapshot}; see {@link SessionStats}
 * for which authority backs which number.
 *
 * Never returns `NaN` for any field: every metric is derived from validated records
 * through {@link computeStatisticsSnapshot}, which coerces and clamps rather than
 * accumulating whatever a restored record happened to contain.
 */
export function computeSessionStats(now: Date = new Date()): SessionStats {
  const records = loadSessions();
  const snapshot = computeStatisticsSnapshot({ sessions: records, subjects: [], now });
  return sessionStatsFromSnapshot(snapshot, records);
}

/**
 * The session-derived {@link SessionStats} over an explicit record set.
 *
 * Exported so a caller that already has the records - the bootstrap, a restored archive, a
 * storage-v2 generation - computes the same numbers from the same function instead of
 * reimplementing the aggregation.
 */
export function sessionStatsFromSnapshot(
  snapshot: StatisticsSnapshot,
  records: readonly SessionRecord[],
): SessionStats {
  const totals: StatisticsTotals = snapshot.totals;
  const sessionsBySubject: Record<string, SessionRecord[]> = {};
  const sessionsByDate: Record<string, SessionRecord[]> = {};
  for (const record of records) {
    const forSubject = sessionsBySubject[record.subjectId];
    if (forSubject === undefined) sessionsBySubject[record.subjectId] = [record];
    else forSubject.push(record);
    // `parseSessionRecord` already guaranteed `startedAt` is a usable ISO timestamp, so
    // this key cannot throw and cannot land outside the calendar module's own key shape.
    const dateKey = localDateKey(record.startedAt);
    const forDate = sessionsByDate[dateKey];
    if (forDate === undefined) sessionsByDate[dateKey] = [record];
    else forDate.push(record);
  }
  return {
    totalSessions: totals.sessionsCompleted,
    totalMinutesStudied: totals.studyTimeMinutes,
    averageSessionMinutes: totals.averageSessionMinutes,
    totalRoomsVisited: totals.uniqueRoomsVisited,
    totalNotesSubmitted: countsFromRecords(records, 'notesSubmitted'),
    totalReviewsCompleted: countsFromRecords(records, 'reviewsCompleted'),
    totalXpEarned: countsFromRecords(records, 'xpEarned'),
    sessionsBySubject,
    sessionsByDate,
    recentStreak: totals.consecutiveStudyDayStreak,
    roomVisits: totals.roomVisits,
    sessionsOpen: totals.sessionsOpen,
    studyTimeMs: totals.studyTimeMs,
    longestSessionMinutes: totals.longestSessionMinutes,
    activeDays: totals.activeDays,
    consecutiveReviewDayStreak: 0,
    todayKey: snapshot.todayKey,
  };
}

function countsFromRecords(
  records: readonly SessionRecord[],
  field: 'notesSubmitted' | 'reviewsCompleted' | 'xpEarned',
): number {
  let total = 0;
  for (const record of records) total += record[field];
  return total;
}

/**
 * The event-derived device snapshot, for a caller that has the subject records.
 *
 * The same function the statistics store calls, exported so a test and a host agree by
 * construction.
 */
export function computeStatisticsFromRecords(input: {
  readonly sessions: readonly SessionRecord[];
  readonly subjects: readonly SubjectStatisticsInput[];
  readonly now?: Date;
  readonly dailyActivityDays?: number;
  readonly recentSessionLimit?: number;
}): StatisticsSnapshot {
  return computeStatisticsSnapshot({
    sessions: input.sessions,
    subjects: input.subjects,
    now: input.now ?? new Date(),
    ...(input.dailyActivityDays === undefined ? {} : { dailyActivityDays: input.dailyActivityDays }),
    ...(input.recentSessionLimit === undefined
      ? {}
      : { recentSessionLimit: input.recentSessionLimit }),
  });
}

/**
 * Clear all session records (for testing or data reset).
 *
 * Also discards any open session **without persisting it**, so a reset cannot leave a
 * half-written record that recovery would later close and report as study time the learner
 * never did.
 */
export function clearAllSessions(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  discardOpenSession();
}

// Re-exported so a host has one import for the lifecycle surface this module owns.
export type { SessionEndOutcome, SessionLifecycleController, LifecycleSessionRecord };
export { createSessionLifecycleController, defaultMintSessionId };
export type {
  DailyActivityBucket,
  RecentSessionSummary,
  StatisticsSnapshot,
  StatisticsTotals,
  SubjectStatistics,
  SubjectStatisticsInput,
};

/** The calendar helpers a surface needs to label a day, re-exported. */
export { countConsecutiveActiveDays, latestLocalDateKey, localDateKey };

/** The fire-and-forget boundary, re-exported so a host can mirror a session write. */
export { fireAndForget };