/**
 * The published statistics metrics.
 *
 * This module is the **only** implementation of every number the statistics dashboard
 * shows. `src/services/sessionTracker.ts` is its reader-side adapter; the store and the
 * application layer are its writers. Nothing computes a statistic anywhere else, which
 * is the fix for plan 5.3's "session tracking functions are not wired into real
 * gameplay" as a *structural* property rather than as a wiring accident: a dashboard
 * that sums its own counters cannot agree with a progression record that pays for the
 * same events.
 *
 * ## What was wrong with each metric, and what is published now
 *
 * | Pre-Phase-18 metric | Defect | Published now |
 * | --- | --- | --- |
 * | `totalSessions`, `totalMinutesStudied`, `totalRoomsVisited`, `totalNotesSubmitted`, `totalReviewsCompleted`, `totalXpEarned` | always `0`: nothing ever started a session, and every `track*` returned early on a `currentSession` that was never set | `sessionsCompleted`, `studyTimeMinutes`, `uniqueRoomsVisited`, `notesSubmitted`, `reviewsCompleted`, `xpEarned` |
 * | day keys from `toISOString().slice(0, 10)` | UTC, so a session after local midnight was filed under the previous day | every key from `src/core/statistics/localCalendar.ts` |
 * | `recentStreak` by subtracting `86_400_000` ms | wrong across a daylight-saving transition (23- or 25-hour days) | `consecutiveStudyDayStreak` / `consecutiveReviewDayStreak`, stepping calendar keys |
 * | `totalRoomsVisited` = sum of per-session `roomsVisited.length` | not a unique-room count: a room visited in three sessions counted three times, and five visits in one session counted once | `uniqueRoomsVisited` (unique rooms **per subject**, summed) **and** `roomVisits` (the raw entry count), so both meanings exist under honest names |
 * | `sessionsByDate` keyed by UTC date | the same UTC defect | keyed by local calendar day |
 * | `subjectsMastered` on the progression record | a per-subject flag **nothing ever sets**, so the count was structurally `0` and the two cross-subject badge thresholds (1 and 3) could never unlock | `subjectsWithProvenMastery`, derived from evidence: every room cleared **and** at least one full review pass |
 * | `streakCount` on the progression record, surfaced as a "review streak" | it is not a streak: it is "rooms cleared since the last `resetStreak`", and it is additionally fed into the room-clear quality bonus, so it grows without bound | `clearBonusStreak`, named for what it is; plus `roomsClearedAwarded` from the room-clear ledger and `roomsClearedCounter` from the progression counter, published **separately** because they genuinely differ when the no-identity award lane is used |
 * | `summarizeReviewAnalytics({ currentReviewStreak, longestReviewStreak })` | callers passed `subject.streakCount` as the *review* streak and a hard `0` as the *longest* review streak, so both published streaks were meaningless | `reviewPassCount`, `reviewedRoomCount`, `fullReviewPasses` from the analytics, and `consecutiveReviewDayStreak` from the events |
 *
 * ## Where the totals come from
 *
 * **The per-subject statistics event ledger is authoritative** for notes, reviews, XP,
 * and kept fish. It is written in the same `set` of one record as the reward that caused
 * it and shares that reward's identity, so "paid once" and "counted once" are the same
 * fact rather than two facts that have to be kept in step.
 *
 * **The session record is authoritative for study time and for rooms visited**, because
 * a session is the only thing that knows when the learner was present and which rooms
 * they walked into. Its `notesSubmitted` / `reviewsCompleted` / `xpEarned` counters
 * remain on the published per-session rows - that is what a single session card shows,
 * and keeping them keeps the persisted record's historical shape - but they are **not**
 * summed into the totals, precisely so there is one authority per number.
 *
 * The consequence is stated rather than hidden: a session recorded by a pre-Phase-18
 * build contributes its study time and rooms, and its note/review/XP counters appear on
 * its own row without being added to the device totals. No shipped build ever wrote such
 * a session - `startSession` had no production caller until this phase - so the case is
 * hypothetical, and {@link StatisticsProvenance.sessionsBeforeEventLedger} makes it
 * observable rather than merely documented.
 *
 * ## Renderer neutrality
 *
 * This module imports `@/core/review`, `@/core/progression`, and its own calendar and
 * event modules, and nothing else. No store, no service, no React, no renderer, no DOM,
 * no network.
 */
import {
  DEFAULT_EASE_FACTOR,
  isReviewableRoom,
  summarizeReviewAnalytics,
} from '@/core/review';
import type { CanonicalSubjectProgressionWriteShape } from '@/core/progression/canonicalProgression';
import { readRoomClearRewardLedgerFromFields } from '@/core/progression/roomClearRewards';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import {
  countConsecutiveActiveDays,
  isLocalDateKey,
  latestLocalDateKey,
  localDateKey,
  localDateKeyRange,
} from './localCalendar';
import type { StatisticsEvent } from './statisticsEvents';

// ── Inputs ─────────────────────────────────────────────────────────────────

/**
 * The session fields the metrics read.
 *
 * Declared structurally rather than imported, so `src/core/` does not depend on
 * `src/services/`. The service's `SessionRecord` satisfies it exactly, which
 * `tests/phase18/statisticsMetrics.test.ts` pins.
 */
export interface StatisticsSessionRecord {
  readonly sessionId: string;
  /** ISO 8601 timestamp. */
  readonly startedAt: string;
  /** ISO 8601 timestamp, or `null` for a session that has not been closed yet. */
  readonly endedAt: string | null;
  readonly subjectId: string;
  readonly subjectName: string;
  /** De-duplicated per session by the session record itself. */
  readonly roomsVisited: readonly string[];
  readonly notesSubmitted: number;
  readonly reviewsCompleted: number;
  readonly xpEarned: number;
}

/** One subject's contribution to the snapshot. */
export interface SubjectStatisticsInput {
  readonly subjectId: string;
  readonly subjectName: string;
  /**
   * The live subject graph, or `null` when the device has a progression record for a
   * subject whose graph is gone (deleted, or not carried by a migration).
   *
   * `null` is a real case and every graph-derived metric reports its empty value rather
   * than throwing: a learner who deleted a subject still owns the XP they earned in it.
   */
  readonly snapshot: SubjectSnapshot | null;
  /** The canonical per-subject progression record, or `null` when there is none. */
  readonly progression: CanonicalSubjectProgressionWriteShape | null;
  /** The subject's statistics events, newest first. */
  readonly events: readonly StatisticsEvent[];
}

/** Every input the snapshot is a pure function of. */
export interface StatisticsComputationInput {
  readonly sessions: readonly StatisticsSessionRecord[];
  readonly subjects: readonly SubjectStatisticsInput[];
  /** The clock. Injected so the snapshot is a pure function of its input. */
  readonly now: Date | string;
  /** Days in the daily-activity window. Defaults to 14. */
  readonly dailyActivityDays?: number;
  /** Sessions in the recent-sessions list. Defaults to 10. */
  readonly recentSessionLimit?: number;
}

// ── Published shapes ───────────────────────────────────────────────────────

/**
 * How complete a subject's graph and review state are.
 *
 * Replaces the pre-Phase-18 `subjectsMastered` flag, which nothing ever set. The states
 * are ordered and `mastered` is the strictest one, so a caller can render either a
 * progress bar over the ordered list or a boolean.
 */
export type SubjectMasteryState = 'untouched' | 'in-progress' | 'cleared' | 'reviewed';

export interface SubjectMastery {
  /** Rooms in the subject graph, or `0` when no graph is available. */
  readonly totalRooms: number;
  /** Rooms whose validation reached a final pass. */
  readonly clearedRooms: number;
  /** `clearedRooms / totalRooms`, rounded to two places, or `0` when there are none. */
  readonly completionRatio: number;
  /** Complete passes through every reviewable room. */
  readonly fullReviewPasses: number;
  /** The ordered state, and the strictest one at the same time. */
  readonly state: SubjectMasteryState;
  /**
   * Every room cleared **and** at least one full review pass.
   *
   * The rule is stated in one place so a badge threshold, a subject card, and this
   * boolean cannot each pick their own definition. `totalRooms > 0` is part of the rule:
   * a subject whose graph the device does not have is never "mastered", because vacuous
   * evidence is not evidence.
   */
  readonly mastered: boolean;
}

export interface SubjectReviewSummary {
  /** Rooms that can be reviewed at all. */
  readonly reviewableRoomCount: number;
  /** Reviewable rooms that have been reviewed at least once. */
  readonly reviewedRoomCount: number;
  /** Individual review passes recorded across the reviewable rooms. */
  readonly reviewPassCount: number;
  /** Complete passes through every reviewable room. */
  readonly fullReviewPasses: number;
  /** Reviewable rooms whose next review is due now or already past. */
  readonly reviewDueCount: number;
  /** Reviewable rooms whose next review is past. */
  readonly reviewOverdueCount: number;
  /** Mean SM-2 ease factor over the rooms that have one, or the SM-2 default. */
  readonly averageEaseFactor: number;
}

/** One subject's published row. */
export interface SubjectStatistics {
  readonly subjectId: string;
  readonly subjectName: string;
  /** Notes that validated and cleared a room. From the events. */
  readonly notesSubmitted: number;
  /** Completed review passes. From the events. */
  readonly reviewsCompleted: number;
  /** XP the events record as awarded. From the events. */
  readonly xpEarned: number;
  /** Kept catches. From the events. */
  readonly fishKept: number;
  /** Distinct catalogue ids among the kept catches. From the events. */
  readonly distinctFishSpecies: number;
  /**
   * The catalogue ids behind {@link distinctFishSpecies}, so a surface can name the
   * species it has collected without re-deriving them. Catalogue ids, never display
   * names: the catalogue is app-owned content with a stable identity.
   */
  readonly fishSpeciesCatalogIds: readonly string[];
  /** Distinct rooms of **this** subject the learner has entered. */
  readonly uniqueRoomsVisited: number;
  /** Room entries, counted with repeats. */
  readonly roomVisits: number;
  readonly sessionsCompleted: number;
  /** `null` when the subject has no closed session. */
  readonly studyTimeMinutes: number | null;
  /** Distinct local days with any recorded activity for this subject. */
  readonly activeDays: number;
  /** The newest local day key with activity for this subject, or `null`. */
  readonly lastActiveDateKey: string | null;
  /**
   * The progression record's `streakCount`, renamed for what it is.
   *
   * It is the number of room clears since the last `resetStreak`, and it is added into
   * the room-clear quality bonus, so it is a **clear-count bonus**, not a streak of days
   * and not a streak of anything else. Published under this name so no surface can label
   * it "streak".
   */
  readonly clearBonusStreak: number;
  /** Room clears the durable room-clear ledger records. */
  readonly roomsClearedAwarded: number;
  /**
   * The progression record's `roomsCleared` counter.
   *
   * Published separately from {@link roomsClearedAwarded} because the two genuinely
   * differ: the counter is incremented by the no-identity award lane too, which exists
   * for the Phase 15 rollback and for the byte-comparison fixtures.
   */
  readonly roomsClearedCounter: number;
  /** Notes collected into the progression record, for cross-checking the events. */
  readonly collectedNoteCount: number;
  readonly artifacts: number;
  readonly badgeCount: number;
  /** `null` when the device has no progression record for the subject. */
  readonly rank: string | null;
  readonly xpTotal: number;
  readonly mastery: SubjectMastery;
  readonly review: SubjectReviewSummary;
}

/** Device-wide totals. */
export interface StatisticsTotals {
  /** Sessions with an `endedAt`. */
  readonly sessionsCompleted: number;
  /**
   * Sessions still open.
   *
   * A well-run device reports `0` here: the lifecycle closes a session on subject change,
   * on return to the village, on route unmount, on `pagehide`, and on a reliable
   * visibility transition, and it recovers an unterminated session on the next start. A
   * non-zero value means a session was written without being closed.
   */
  readonly sessionsOpen: number;
  /** Total elapsed study time across closed sessions, in milliseconds. */
  readonly studyTimeMs: number;
  /** {@link studyTimeMs} rounded to whole minutes. */
  readonly studyTimeMinutes: number;
  /** Mean closed-session duration in whole minutes, or `0` with no sessions. */
  readonly averageSessionMinutes: number;
  /** Longest closed-session duration in whole minutes, or `0`. */
  readonly longestSessionMinutes: number;
  /**
   * Distinct rooms visited, counted **once per subject**.
   *
   * Room ids are unique only inside one subject, so two subjects that both have a room
   * `room-1` contribute two unique rooms. This is the corrected answer to "how many rooms
   * have I explored"; {@link roomVisits} is the raw entry count.
   */
  readonly uniqueRoomsVisited: number;
  /** Room entries, counted with repeats. */
  readonly roomVisits: number;
  /** Notes that validated and cleared a room. */
  readonly notesSubmitted: number;
  /** Completed review passes. */
  readonly reviewsCompleted: number;
  /** XP awarded, from the events. */
  readonly xpEarned: number;
  /** Kept catches. */
  readonly fishKept: number;
  /** Distinct catalogue ids among the kept catches. */
  readonly distinctFishSpecies: number;
  /** Distinct local calendar days with any recorded activity, across all history. */
  readonly activeDays: number;
  /**
   * Consecutive local days of study activity, counting back from today with one day of
   * grace, so a learner who has not opened the app yet today has not broken yesterday.
   */
  readonly consecutiveStudyDayStreak: number;
  /** Consecutive local days with at least one recorded review completion, same grace. */
  readonly consecutiveReviewDayStreak: number;
  /**
   * Subjects with proven mastery.
   *
   * Replaces `subjectsMastered`, which counted a per-subject flag nothing ever set and
   * was therefore always `0`.
   */
  readonly subjectsWithProvenMastery: number;
  /** Subjects present in the device's records at all. */
  readonly subjectsTracked: number;
}

/** One bar of the daily-activity chart. Always emitted, zero-filled. */
export interface DailyActivityBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly dateKey: string;
  /** `true` when this day is the snapshot's "today". */
  readonly isToday: boolean;
  readonly sessions: number;
  /** Study time on this day in whole minutes, summed per session. */
  readonly studyMinutes: number;
  readonly notes: number;
  readonly reviews: number;
  readonly xp: number;
  readonly fishKept: number;
}

/** One row of the recent-sessions list. */
export interface RecentSessionSummary {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Local calendar day the session started on, or `''` when `startedAt` is unusable. */
  readonly dateKey: string;
  /** Duration in whole minutes, or `null` for an open session. */
  readonly studyMinutes: number | null;
  /** Distinct rooms this session entered. */
  readonly roomsVisited: number;
  /**
   * The session record's own counter for the session.
   *
   * Per-session presentation only. It is deliberately **not** summed into
   * {@link StatisticsTotals}, which reads the events, so there is one authority for each
   * number.
   */
  readonly notesSubmitted: number;
  readonly reviewsCompleted: number;
  readonly xpEarned: number;
}

/**
 * Where the numbers came from, so a surface can say so.
 *
 * Deliberately counts and booleans only - no learner content, no names, nothing that
 * belongs in a log line.
 */
export interface StatisticsProvenance {
  readonly subjectsTracked: number;
  /** Subjects carrying at least one statistics event. */
  readonly subjectsWithEvents: number;
  readonly sessionsRead: number;
  /**
   * Sessions whose subject carries no statistics event, because the session predates the
   * event ledger or because its subject has no record at all.
   *
   * Always `0` on a device that has only ever run this build. Published so the "session
   * counters are not in the totals" rule is observable rather than merely documented.
   */
  readonly sessionsBeforeEventLedger: number;
}

export interface StatisticsSnapshot {
  /** ISO timestamp the snapshot was computed at. */
  readonly generatedAt: string;
  /** The snapshot's local "today". Every streak and window is relative to this. */
  readonly todayKey: string;
  readonly totals: StatisticsTotals;
  /** One row per subject, ordered by subject id. */
  readonly subjects: readonly SubjectStatistics[];
  /** Oldest first, ending on {@link todayKey}. */
  readonly dailyActivity: readonly DailyActivityBucket[];
  /** Newest first. */
  readonly recentSessions: readonly RecentSessionSummary[];
  /** Closed and open sessions grouped by local calendar day, newest day last. */
  readonly sessionsByDate: Readonly<Record<string, readonly RecentSessionSummary[]>>;
  readonly provenance: StatisticsProvenance;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function timestampMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function emptyReviewSummary(): SubjectReviewSummary {
  return {
    reviewableRoomCount: 0,
    reviewedRoomCount: 0,
    reviewPassCount: 0,
    fullReviewPasses: 0,
    reviewDueCount: 0,
    reviewOverdueCount: 0,
    // The SM-2 module's own default, so a subject with no scheduled review reports the
    // number a review of it would have started from.
    averageEaseFactor: DEFAULT_EASE_FACTOR,
  };
}

/**
 * Derive a subject's mastery from evidence.
 *
 * The rule lives here and nowhere else, so a badge threshold, a subject card, and the
 * device total cannot each pick their own definition: **every room in the graph cleared,
 * and at least one complete review pass.** A subject with no graph is `untouched` and
 * never `mastered`.
 */
export function deriveSubjectMastery(input: {
  readonly totalRooms: number;
  readonly clearedRooms: number;
  readonly fullReviewPasses: number;
}): SubjectMastery {
  const totalRooms = toCount(input.totalRooms);
  const clearedRooms = toCount(input.clearedRooms);
  const fullReviewPasses = toCount(input.fullReviewPasses);
  const completionRatio = totalRooms > 0 ? Math.min(1, clearedRooms / totalRooms) : 0;
  const allCleared = totalRooms > 0 && clearedRooms >= totalRooms;
  const reviewed = allCleared && fullReviewPasses >= 1;
  const state: SubjectMasteryState = reviewed
    ? 'reviewed'
    : allCleared
      ? 'cleared'
      : clearedRooms > 0
        ? 'in-progress'
        : 'untouched';
  return {
    totalRooms,
    clearedRooms,
    completionRatio: Math.round(completionRatio * 100) / 100,
    fullReviewPasses,
    state,
    mastered: reviewed,
  };
}

function computeSubjectReviewSummary(snapshot: SubjectSnapshot | null): SubjectReviewSummary {
  if (snapshot === null) return emptyReviewSummary();
  const reviewableRoomIds = Object.values(snapshot.rooms)
    .filter((room) => isReviewableRoom(room))
    .map((room) => room.roomId);
  const analytics = summarizeReviewAnalytics({
    rooms: snapshot.rooms,
    reviewableRoomIds,
    // Phase 18: the callers passed `subject.streakCount` here and a hard `0` for the
    // longest streak, so both published streaks were meaningless. They are now derived
    // from room state alone, and the honest streak - consecutive days with a recorded
    // review - is published separately as `consecutiveReviewDayStreak`.
    currentReviewStreak: 0,
    longestReviewStreak: 0,
  });
  return {
    reviewableRoomCount: analytics.totalReviewableRooms,
    reviewedRoomCount: analytics.reviewedRoomCount,
    reviewPassCount: analytics.reviewSessionCount,
    fullReviewPasses: analytics.fullReviewPasses,
    reviewDueCount: analytics.dueTodayCount,
    reviewOverdueCount: analytics.overdueReviewCount,
    averageEaseFactor: analytics.averageEaseFactor,
  };
}

interface SessionAggregate {
  completed: number;
  open: number;
  studyTimeMs: number;
  longestStudyTimeMs: number;
  rooms: Set<string>;
  roomVisits: number;
  dateKeys: Set<string>;
}

function emptyAggregate(): SessionAggregate {
  return {
    completed: 0,
    open: 0,
    studyTimeMs: 0,
    longestStudyTimeMs: 0,
    rooms: new Set<string>(),
    roomVisits: 0,
    dateKeys: new Set<string>(),
  };
}

function accumulateSession(aggregate: SessionAggregate, session: StatisticsSessionRecord): void {
  const startedMs = timestampMs(session.startedAt);
  if (startedMs !== null) aggregate.dateKeys.add(localDateKey(startedMs));
  for (const roomId of session.roomsVisited) {
    aggregate.rooms.add(roomId);
    aggregate.roomVisits += 1;
  }
  const endedMs = timestampMs(session.endedAt);
  if (endedMs === null) {
    aggregate.open += 1;
    return;
  }
  const durationMs = Math.max(0, endedMs - (startedMs ?? endedMs));
  aggregate.completed += 1;
  aggregate.studyTimeMs += durationMs;
  if (durationMs > aggregate.longestStudyTimeMs) aggregate.longestStudyTimeMs = durationMs;
}

function toRecentSession(session: StatisticsSessionRecord): RecentSessionSummary {
  const startedMs = timestampMs(session.startedAt);
  const endedMs = timestampMs(session.endedAt);
  const durationMs = endedMs === null ? null : Math.max(0, endedMs - (startedMs ?? endedMs));
  return {
    sessionId: session.sessionId,
    subjectId: session.subjectId,
    subjectName: session.subjectName,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    dateKey: startedMs === null ? '' : localDateKey(startedMs),
    studyMinutes: durationMs === null ? null : Math.round(durationMs / 60000),
    roomsVisited: new Set(session.roomsVisited).size,
    notesSubmitted: toCount(session.notesSubmitted),
    reviewsCompleted: toCount(session.reviewsCompleted),
    xpEarned: toCount(session.xpEarned),
  };
}

function aggregateSessions(sessions: readonly StatisticsSessionRecord[]): {
  completed: number;
  open: number;
  studyTimeMs: number;
  longestStudyTimeMs: number;
  roomVisits: number;
  dateKeys: Set<string>;
  roomsBySubject: Map<string, Set<string>>;
} {
  let completed = 0;
  let open = 0;
  let studyTimeMs = 0;
  let longestStudyTimeMs = 0;
  let roomVisits = 0;
  const dateKeys = new Set<string>();
  const roomsBySubject = new Map<string, Set<string>>();
  for (const session of sessions) {
    const aggregate = emptyAggregate();
    accumulateSession(aggregate, session);
    completed += aggregate.completed;
    open += aggregate.open;
    studyTimeMs += aggregate.studyTimeMs;
    roomVisits += aggregate.roomVisits;
    if (aggregate.longestStudyTimeMs > longestStudyTimeMs) {
      longestStudyTimeMs = aggregate.longestStudyTimeMs;
    }
    for (const key of aggregate.dateKeys) dateKeys.add(key);
    let rooms = roomsBySubject.get(session.subjectId);
    if (rooms === undefined) {
      rooms = new Set<string>();
      roomsBySubject.set(session.subjectId, rooms);
    }
    for (const roomId of aggregate.rooms) rooms.add(roomId);
  }
  return {
    completed,
    open,
    studyTimeMs,
    longestStudyTimeMs,
    roomVisits,
    dateKeys,
    roomsBySubject,
  };
}

// ── The computation ────────────────────────────────────────────────────────

/**
 * Compute the whole statistics snapshot.
 *
 * Pure: the same input and the same `now` always produce the same snapshot, which is
 * what makes it unit-testable without a browser and makes the metric values in a test
 * real numbers rather than tautologies.
 */
export function computeStatisticsSnapshot(input: StatisticsComputationInput): StatisticsSnapshot {
  const nowIso =
    input.now instanceof Date ? input.now.toISOString() : new Date(input.now).toISOString();
  const todayKey = localDateKey(input.now);
  const dailyDays = Math.max(0, Math.trunc(input.dailyActivityDays ?? 14));
  const recentLimit = Math.max(0, Math.trunc(input.recentSessionLimit ?? 10));

  const subjects = [...input.subjects].sort((left, right) =>
    left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0,
  );

  // ── Per-subject rows and the event-derived date buckets ──
  const rows: SubjectStatistics[] = [];
  const eventDateKeys = new Set<string>();
  const reviewDateKeys = new Set<string>();
  const eventDates: Record<string, { notes: number; reviews: number; xp: number; fishKept: number }> = {};
  let subjectsWithEvents = 0;

  for (const subject of subjects) {
    const bucketFor = (key: string): { notes: number; reviews: number; xp: number; fishKept: number } => {
      let bucket = eventDates[key];
      if (bucket === undefined) {
        bucket = { notes: 0, reviews: 0, xp: 0, fishKept: 0 };
        eventDates[key] = bucket;
      }
      return bucket;
    };

    let notesSubmitted = 0;
    let reviewsCompleted = 0;
    let xpEarned = 0;
    let fishKept = 0;
    const species = new Set<string>();
    for (const event of subject.events) {
      // An event with an unusable `localDate` still counts in the subject's totals; it
      // just cannot be placed on a day. Dropping it entirely would under-report a
      // restored record whose date field was mangled.
      const dateKey = isLocalDateKey(event.localDate) ? event.localDate : null;
      if (dateKey !== null) {
        eventDateKeys.add(dateKey);
        bucketFor(dateKey);
      }
      const bucket = dateKey === null ? null : bucketFor(dateKey);
      switch (event.kind) {
        case 'note-submission':
          notesSubmitted += 1;
          if (bucket !== null) bucket.notes += 1;
          break;
        case 'review-completion':
          reviewsCompleted += 1;
          if (dateKey !== null) reviewDateKeys.add(dateKey);
          if (bucket !== null) bucket.reviews += 1;
          break;
        case 'xp-award':
          xpEarned += event.amount;
          if (bucket !== null) bucket.xp += event.amount;
          break;
        case 'fishing-outcome':
          fishKept += 1;
          species.add(event.catalogId);
          if (bucket !== null) bucket.fishKept += 1;
          break;
      }
    }
    if (subject.events.length > 0) subjectsWithEvents += 1;

    const sessionsForSubject = input.sessions.filter(
      (session) => session.subjectId === subject.subjectId,
    );
    const aggregate = emptyAggregate();
    for (const session of sessionsForSubject) accumulateSession(aggregate, session);

    const review = computeSubjectReviewSummary(subject.snapshot);
    const record = subject.progression;
    const totalRooms = subject.snapshot === null ? 0 : subject.snapshot.dungeon.rooms.length;
    const clearedRooms =
      subject.snapshot === null
        ? 0
        : Object.values(subject.snapshot.rooms).filter((room) => room.validationState.finalPass).length;
    const roomClearLedger = readRoomClearRewardLedgerFromFields(record?.extraFields);

    rows.push({
      subjectId: subject.subjectId,
      subjectName: subject.subjectName,
      notesSubmitted,
      reviewsCompleted,
      xpEarned,
      fishKept,
      distinctFishSpecies: species.size,
      fishSpeciesCatalogIds: [...species].sort(),
      uniqueRoomsVisited: aggregate.rooms.size,
      roomVisits: aggregate.roomVisits,
      sessionsCompleted: aggregate.completed,
      studyTimeMinutes: aggregate.completed === 0 ? null : Math.round(aggregate.studyTimeMs / 60000),
      activeDays: aggregate.dateKeys.size,
      lastActiveDateKey: latestLocalDateKey(aggregate.dateKeys),
      clearBonusStreak: toCount(record?.streakCount),
      roomsClearedAwarded: roomClearLedger.entries.length,
      roomsClearedCounter: toCount(record?.roomsCleared),
      collectedNoteCount: record?.collectedNotes.length ?? 0,
      artifacts: toCount(record?.artifacts),
      badgeCount: record?.badges.length ?? 0,
      rank: record?.rank ?? null,
      xpTotal: toCount(record?.xpTotal),
      mastery: deriveSubjectMastery({
        totalRooms,
        clearedRooms,
        fullReviewPasses: review.fullReviewPasses,
      }),
      review,
    });
  }

  // ── Device totals ──
  const aggregate = aggregateSessions(input.sessions);
  const studyDateKeys = new Set<string>([...aggregate.dateKeys, ...eventDateKeys]);
  const distinctSpecies = new Set<string>();
  for (const row of rows) for (const catalogId of row.fishSpeciesCatalogIds) distinctSpecies.add(catalogId);
  let subjectsWithProvenMastery = 0;
  for (const row of rows) if (row.mastery.mastered) subjectsWithProvenMastery += 1;

  const totals: StatisticsTotals = {
    sessionsCompleted: aggregate.completed,
    sessionsOpen: aggregate.open,
    studyTimeMs: aggregate.studyTimeMs,
    studyTimeMinutes: Math.round(aggregate.studyTimeMs / 60000),
    averageSessionMinutes:
      aggregate.completed > 0 ? Math.round(aggregate.studyTimeMs / aggregate.completed / 60000) : 0,
    longestSessionMinutes: Math.round(aggregate.longestStudyTimeMs / 60000),
    // Summed over every subject that has a session, **not** over `rows`. A subject can have
    // sessions and no progression record - a brand-new subject the learner opened and left -
    // and its rooms are still rooms they explored. Keying this off `rows` would report zero
    // for the session-derived view, which has no rows at all.
    uniqueRoomsVisited: [...aggregate.roomsBySubject.values()].reduce(
      (total, rooms) => total + rooms.size,
      0,
    ),
    roomVisits: aggregate.roomVisits,
    notesSubmitted: rows.reduce((total, row) => total + row.notesSubmitted, 0),
    reviewsCompleted: rows.reduce((total, row) => total + row.reviewsCompleted, 0),
    xpEarned: rows.reduce((total, row) => total + row.xpEarned, 0),
    fishKept: rows.reduce((total, row) => total + row.fishKept, 0),
    distinctFishSpecies: distinctSpecies.size,
    activeDays: studyDateKeys.size,
    consecutiveStudyDayStreak: countConsecutiveActiveDays(studyDateKeys, {
      anchorKey: todayKey,
      graceDays: 1,
    }),
    consecutiveReviewDayStreak: countConsecutiveActiveDays(reviewDateKeys, {
      anchorKey: todayKey,
      graceDays: 1,
    }),
    subjectsWithProvenMastery,
    subjectsTracked: rows.length,
  };

  // ── Daily activity, recent sessions, sessions by day ──
  // Built as mutable drafts and frozen at the end, so the accumulation below is a plain
  // `+=` and the published type stays deeply readonly.
  const drafts = new Map<string, {
    dateKey: string;
    isToday: boolean;
    sessions: number;
    studyMinutes: number;
    notes: number;
    reviews: number;
    xp: number;
    fishKept: number;
  }>();
  for (const key of localDateKeyRange(todayKey, dailyDays)) {
    drafts.set(key, {
      dateKey: key,
      isToday: key === todayKey,
      sessions: 0,
      studyMinutes: 0,
      notes: 0,
      reviews: 0,
      xp: 0,
      fishKept: 0,
    });
  }
  for (const session of input.sessions) {
    const startedMs = timestampMs(session.startedAt);
    if (startedMs === null) continue;
    const bucket = drafts.get(localDateKey(startedMs));
    if (bucket === undefined) continue;
    bucket.sessions += 1;
    const endedMs = timestampMs(session.endedAt);
    if (endedMs !== null) {
      // Rounded per session rather than accumulated-then-rounded, so five 30-second
      // sessions read 3 minutes rather than 2.
      bucket.studyMinutes += Math.max(0, Math.round((endedMs - startedMs) / 60000));
    }
  }
  for (const [key, counts] of Object.entries(eventDates)) {
    const bucket = drafts.get(key);
    if (bucket === undefined) continue;
    bucket.notes += counts.notes;
    bucket.reviews += counts.reviews;
    bucket.xp += counts.xp;
    bucket.fishKept += counts.fishKept;
  }
  const buckets: DailyActivityBucket[] = [...drafts.values()];

  const orderedSessions = [...input.sessions].sort((left, right) => {
    const leftMs = timestampMs(left.startedAt) ?? 0;
    const rightMs = timestampMs(right.startedAt) ?? 0;
    if (leftMs !== rightMs) return rightMs - leftMs;
    // A stable tiebreak, so two sessions with the same start time never swap places
    // between runs and a test can assert an exact ordering.
    return left.sessionId < right.sessionId ? 1 : -1;
  });
  const recentSessions = orderedSessions.slice(0, recentLimit).map(toRecentSession);

  const sessionsByDate: Record<string, RecentSessionSummary[]> = {};
  for (const session of orderedSessions) {
    const summary = toRecentSession(session);
    if (summary.dateKey.length === 0) continue;
    const list = sessionsByDate[summary.dateKey];
    if (list === undefined) sessionsByDate[summary.dateKey] = [summary];
    else list.push(summary);
  }

  const subjectsWithEventList = new Set<string>();
  for (const subject of subjects) {
    if (subject.events.length > 0) subjectsWithEventList.add(subject.subjectId);
  }
  let sessionsBeforeEventLedger = 0;
  for (const session of input.sessions) {
    if (!subjectsWithEventList.has(session.subjectId)) sessionsBeforeEventLedger += 1;
  }

  return {
    generatedAt: nowIso,
    todayKey,
    totals,
    subjects: rows,
    dailyActivity: buckets,
    recentSessions,
    sessionsByDate,
    provenance: {
      subjectsTracked: rows.length,
      subjectsWithEvents,
      sessionsRead: input.sessions.length,
      sessionsBeforeEventLedger,
    },
  };
}

/**
 * An all-zero snapshot, for a device with nothing recorded.
 *
 * Exists so a surface can render a populated shell without a `null` check on every
 * field, and so the empty and restored states are the same shape.
 */
export function emptyStatisticsSnapshot(
  now: Date | string,
  options: { readonly dailyActivityDays?: number; readonly recentSessionLimit?: number } = {},
): StatisticsSnapshot {
  return computeStatisticsSnapshot({
    sessions: [],
    subjects: [],
    now,
    ...(options.dailyActivityDays === undefined ? {} : { dailyActivityDays: options.dailyActivityDays }),
    ...(options.recentSessionLimit === undefined
      ? {}
      : { recentSessionLimit: options.recentSessionLimit }),
  });
}