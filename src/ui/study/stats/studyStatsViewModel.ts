/**
 * The statistics dashboard's view model: a pure projection of one
 * `StatisticsSnapshot` into the rows, sections and sentences the panel renders.
 *
 * ## Why the projection exists
 *
 * Three of this panel's requirements are decisions, not markup, and putting them in JSX
 * makes them invisible to a test and impossible to review:
 *
 * 1. **Empty is a state, not a set of zeros.** Whether the panel shows the dashboard or the
 *    empty explanation is decided here, by one rule, and the rule is stated: *no closed
 *    session and no open session* is empty. A learner who has made a dungeon but has not
 *    walked into one is empty too - and gets told so, with the dungeon they already have
 *    named, rather than fifteen rows of `0`.
 * 2. **No colour-only state.** {@link ReviewUrgency} and the mastery words come from the
 *    copy module; this module decides *which* state a subject is in and hands the panel a
 *    word to print.
 * 3. **No unfailable assertions.** Every row carries the number it was built from in
 *    `rawValue`, next to the string the learner reads. A test compares the number; the
 *    string is presentation. This is the discipline the phase brief asks for, and putting
 *    the two side by side in one object is what keeps a formatted string from becoming the
 *    only copy of a value.
 *
 * ## What is *not* computed here
 *
 * No statistic is recomputed. `src/core/statistics/statisticsMetrics.ts` is the single
 * implementation of every number, and this module only sums two families the domain
 * publishes per subject and does not publish device-wide - the graph-derived review counts -
 * and says so in `reviewScopeLimited`, which the panel prints. Recomputing `studyTimeMinutes`
 * here from session rows would be a second answer to the same question, which is the defect
 * the whole Phase 18 event model exists to remove.
 *
 * ## Renderer-neutral
 *
 * Imports `@/core/statistics` and the copy module. No React, no store, no DOM, no renderer.
 */
import type {
  DailyActivityBucket,
  RecentSessionSummary,
  StatisticsSnapshot,
  SubjectStatistics,
} from '@/core/statistics';

import {
  clearTallySentence,
  countWithUnit,
  describeActivityBucket,
  describeMastery,
  emptyStateCopy,
  formatActivityDayLabel,
  formatCompletionPercent,
  formatExperience,
  formatLocalShortDate,
  formatStudyMinutes,
  hasDayActivity,
  restoredStateCopy,
  REVIEW_SCOPE_NOTE,
  reviewUrgency,
  type ReviewUrgency,
} from './studyStatsCopy';
import {
  STUDY_STATS_RETENTION_KEYS,
  STUDY_STATS_TOTAL_KEYS,
  type StudyStatsRetentionKey,
  type StudyStatsTotalKey,
} from './studyStatsTestIds';

/** One `count`/`minutes` reading, with the number it was built from. */
export interface StudyStatRow<Id extends string> {
  /** The stable key for this row, from a frozen id object. */
  readonly id: Id;
  /** The `<dt>`. A noun phrase a learner reads. */
  readonly label: string;
  /** The `<dd>`. Formatted from `rawValue` and nothing else. */
  readonly value: string;
  /**
   * The number `value` was formatted from: a count, or a duration in whole minutes.
   *
   * `null` only for a row whose value is not a single number. Keeping it means a test can
   * assert `row.rawValue === 7` rather than asserting that a string contains `"7"`, which
   * a `"17"` would also satisfy.
   */
  readonly rawValue: number | null;
  /** What `rawValue` counts, so `data-*` consumers know the unit. */
  readonly unit: 'count' | 'minutes';
}

export type StudyTotalRow = StudyStatRow<StudyStatsTotalKey>;
export type StudyRetentionRow = StudyStatRow<StudyStatsRetentionKey>;

// ── Empty and restored '──────────────────────────────────────────────────────

/**
 * Whether the dashboard has anything to show.
 *
 * The rule is *sessions*, and it is deliberately not "any non-zero total": a subject whose
 * graph has ten rooms and none cleared has `roomsExplored: 0` and `notesWritten: 0` and is
 * still a learner who has not studied yet. Sessions are the one thing that only happens
 * when a learner walks into a dungeon, which is exactly the moment this page starts
 * meaning something.
 *
 * An **open** session counts. It is a session in progress, the dashboard has something to
 * say about it, and a page that empties itself while the learner is reading it is a page
 * that contradicts the `still open` row on it.
 */
export function hasRecordedSessions(snapshot: StatisticsSnapshot): boolean {
  return snapshot.totals.sessionsCompleted > 0 || snapshot.totals.sessionsOpen > 0;
}

/** The gate-off body. A sentence set, so the panel has no copy of its own to drift. */
export const STUDY_STATS_DISABLED_SENTENCES: readonly string[] = Object.freeze([
  'Your sessions, notes, reviews and catches are all still recorded - nothing was deleted, ' +
    'and no session stopped being counted. Only this page is hidden. Turning the dashboard ' +
    'back on shows everything again.',
]);

// ── Totals and retention '────────────────────────────────────────────────────

/**
 * The device-wide totals.
 *
 * Fourteen rows, each a distinct number. `subjectsWithProvenMastery` is deliberately
 * **not** here: it is a graph-derived rule, it belongs with the other review numbers, and
 * two sections publishing one number under two names is how a dashboard starts disagreeing
 * with itself.
 */
export function studyTotalRows(snapshot: StatisticsSnapshot): readonly StudyTotalRow[] {
  const t = snapshot.totals;
  return [
    row(STUDY_STATS_TOTAL_KEYS.sessionsCompleted, 'Sessions finished', countWithUnit(t.sessionsCompleted, 'session'), t.sessionsCompleted),
    row(STUDY_STATS_TOTAL_KEYS.studyTime, 'Time in the dungeon', formatStudyMinutes(t.studyTimeMinutes), t.studyTimeMinutes, 'minutes'),
    row(STUDY_STATS_TOTAL_KEYS.longestSession, 'Longest session', formatStudyMinutes(t.longestSessionMinutes), t.longestSessionMinutes, 'minutes'),
    row(STUDY_STATS_TOTAL_KEYS.averageSession, 'Average session', formatStudyMinutes(t.averageSessionMinutes), t.averageSessionMinutes, 'minutes'),
    row(STUDY_STATS_TOTAL_KEYS.activeDays, 'Days with activity', countWithUnit(t.activeDays, 'day'), t.activeDays),
    row(STUDY_STATS_TOTAL_KEYS.consecutiveStudyDayStreak, 'Study-day streak', countWithUnit(t.consecutiveStudyDayStreak, 'day in a row', 'days in a row'), t.consecutiveStudyDayStreak),
    row(STUDY_STATS_TOTAL_KEYS.uniqueRoomsVisited, 'Rooms explored', countWithUnit(t.uniqueRoomsVisited, 'room'), t.uniqueRoomsVisited),
    row(STUDY_STATS_TOTAL_KEYS.roomVisits, 'Room visits', countWithUnit(t.roomVisits, 'visit'), t.roomVisits),
    row(STUDY_STATS_TOTAL_KEYS.notesSubmitted, 'Notes written', countWithUnit(t.notesSubmitted, 'note'), t.notesSubmitted),
    row(STUDY_STATS_TOTAL_KEYS.reviewsCompleted, 'Reviews completed', countWithUnit(t.reviewsCompleted, 'review'), t.reviewsCompleted),
    row(STUDY_STATS_TOTAL_KEYS.xpEarned, 'Experience earned', formatExperience(t.xpEarned), t.xpEarned),
    row(STUDY_STATS_TOTAL_KEYS.fishKept, 'Fish kept', countWithUnit(t.fishKept, 'fish', 'fish'), t.fishKept),
    row(STUDY_STATS_TOTAL_KEYS.distinctFishSpecies, 'Different species', countWithUnit(t.distinctFishSpecies, 'species'), t.distinctFishSpecies),
    row(STUDY_STATS_TOTAL_KEYS.subjectsTracked, 'Dungeons on this device', countWithUnit(t.subjectsTracked, 'dungeon'), t.subjectsTracked),
  ];
}

/**
 * Whether the graph-derived review counts on this device are a partial picture.
 *
 * True when at least one subject's own map is not loaded - a subject this device holds
 * records for but has no rooms for. It is a boolean and not a count of such subjects,
 * because the domain deliberately does not publish which subjects those are, and a panel
 * that named them would be claiming something the snapshot does not say.
 */
export function reviewScopeLimited(snapshot: StatisticsSnapshot): boolean {
  return snapshot.subjects.some((subject) => subject.mastery.totalRooms === 0);
}

/** The device-wide review and retention rows. */
export function studyRetentionRows(snapshot: StatisticsSnapshot): readonly StudyRetentionRow[] {
  const subjects = snapshot.subjects;
  // Two sums over graph-derived per-subject counts. These are the only numbers this module
  // adds up, and `reviewScopeLimited` is the flag that tells the panel to say so out loud.
  const roomsReviewed = sum(subjects.map((s) => s.review.reviewedRoomCount));
  const reviewPasses = sum(subjects.map((s) => s.review.reviewPassCount));
  const fullReviewPasses = sum(subjects.map((s) => s.review.fullReviewPasses));
  const streak = snapshot.totals.consecutiveReviewDayStreak;
  return [
    row(STUDY_STATS_RETENTION_KEYS.consecutiveReviewDayStreak, 'Review-day streak', countWithUnit(streak, 'day in a row', 'days in a row'), streak),
    row(STUDY_STATS_RETENTION_KEYS.roomsReviewed, 'Rooms reviewed at least once', countWithUnit(roomsReviewed, 'room'), roomsReviewed),
    row(STUDY_STATS_RETENTION_KEYS.reviewPasses, 'Review passes recorded', countWithUnit(reviewPasses, 'pass'), reviewPasses),
    row(STUDY_STATS_RETENTION_KEYS.fullReviewPasses, 'Full passes through every reviewable room', countWithUnit(fullReviewPasses, 'full pass'), fullReviewPasses),
    row(STUDY_STATS_RETENTION_KEYS.subjectsWithProvenMastery, 'Dungeons with every room cleared and a full review', countWithUnit(snapshot.totals.subjectsWithProvenMastery, 'dungeon'), snapshot.totals.subjectsWithProvenMastery),
  ];
}

// ── Activity '────────────────────────────────────────────────────────────────

/** One bar of the daily-activity chart, with its own text. */
export interface StudyActivityEntry {
  /** The local `YYYY-MM-DD` this bar is. Carried for the title attribute and the test id. */
  readonly dateKey: string;
  /** `Today`, `Yesterday`, or a short local date. The `<li>`'s visible caption. */
  readonly label: string;
  /**
   * The whole day as one sentence: `"Today: 2 sessions, 35 min, 1 review"`, or
   * `"Tue 4 Nov: no activity"`.
   *
   * This is the text the `<li>` renders, not a `title` and not an `aria-label`. A chart
   * whose per-day detail lives in a tooltip is unreadable by keyboard, unannounced, and
   * absent on a touch device; and the brief for this phase names unfailable assertions as
   * the thing to avoid, so the sentence is a field a test can hold whole rather than a
   * string it reconstructs from two numbers.
   */
  readonly description: string;
  /** Minutes of study on this day, `0` for an empty day. */
  readonly minutes: number;
  /** Whether this is the snapshot's today, so it can carry a non-colour marker. */
  readonly isToday: boolean;
  /** Whether anything at all was recorded. Drives the "no activity" sentence. */
  readonly active: boolean;
  /** The bar's height as a percentage of the window's busiest day, `0` when empty. */
  readonly heightPercent: number;
}

export interface StudyActivityView {
  /** The entries, oldest first, exactly as the snapshot ordered them. */
  readonly entries: readonly StudyActivityEntry[];
  /** Days in the window. */
  readonly days: number;
  /** The busiest day in the window, or `null` when nothing was recorded. */
  readonly busiestMinutes: number | null;
  /**
   * One sentence for the whole chart, in words.
   *
   * A caption rather than a tooltip: a `<div title>` is not reachable by keyboard, not
   * announced, and disappears entirely at 200% zoom on a touch device. The caption is the
   * part a learner actually needs - "your quietest week in a while" - and the per-day
   * sentences carry the rest.
   */
  readonly caption: string;
}

/**
 * The daily-activity chart.
 *
 * The busiest day sets the scale, and a day with no activity gets a `0` bar and the words
 * `no activity`. It does not get a minimum-height stub: a stub is a mark that says
 * "something happened" in the one channel a chart speaks in, and the sentence beside it
 * would be the only thing contradicting it.
 */
export function studyActivityView(snapshot: StatisticsSnapshot): StudyActivityView {
  const buckets: readonly DailyActivityBucket[] = snapshot.dailyActivity;
  const busiest = buckets.reduce<number | null>(
    (max, bucket) => (max === null || bucket.studyMinutes > max ? bucket.studyMinutes : max),
    null,
  );
  const scaleMax = busiest === null || busiest <= 0 ? null : busiest;
  const entries = buckets.map((bucket): StudyActivityEntry => {
    const active = hasDayActivity(bucket);
    return {
      dateKey: bucket.dateKey,
      label: formatActivityDayLabel(bucket.dateKey, snapshot.todayKey),
      description: describeActivityBucket(bucket, snapshot.todayKey),
      minutes: bucket.studyMinutes,
      isToday: bucket.isToday,
      active,
      heightPercent:
        scaleMax === null || bucket.studyMinutes <= 0
          ? 0
          : Math.max(1, Math.round((bucket.studyMinutes / scaleMax) * 100)),
    };
  });
  return {
    entries,
    days: buckets.length,
    busiestMinutes: busiest,
    caption: activityCaption(buckets.length, busiest),
  };
}

function activityCaption(days: number, busiestMinutes: number | null): string {
  if (busiestMinutes === null || busiestMinutes <= 0) {
    return `No study time in the last ${countWithUnit(days, 'day')}.`;
  }
  return `Study time for each of the last ${countWithUnit(days, 'day')}. Your busiest was ${formatStudyMinutes(busiestMinutes)}.`;
}

// ── Subjects '────────────────────────────────────────────────────────────────

/** One number on a subject card. */
export interface StudySubjectRow {
  /** A stable, learner-free key for this row, unique within the card. */
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly rawValue: number | null;
  readonly unit: 'count' | 'minutes';
}

/** One subject's card. */
export interface StudySubjectCard {
  /**
   * The card's React key.
   *
   * The subject's **position** in the snapshot, which the domain orders by subject id - so
   * it is stable across renders and carries nothing. A subject id would also be stable, and
   * `src/ui/study/controlIds.ts` gives the reason not to use it: an id that reaches the DOM
   * is an id that reaches test output, issue reports and screenshots, and `subjectId` here
   * is an app-minted uuid that means nothing to a learner and everything to nobody else.
   */
  readonly position: number;
  /**
   * The subject's display name.
   *
   * `SubjectStatistics.subjectName` is the live subject's name where one is loaded and the
   * subject id otherwise - `buildSubjectStatisticsInputs` resolves it that way - so this is
   * always something a learner can read, and the panel has no path to a bare id even for a
   * subject that was deleted and whose map this device no longer holds.
   */
  readonly name: string;
  /** The mastery state, as a sentence. */
  readonly mastery: string;
  /** The proven-mastery sentence, or `null`. */
  readonly provenMastery: string | null;
  /** `12 of 30 rooms` plus the percentage, or the "no map" sentence. */
  readonly rooms: string;
  /** The room count the percentage is over, `0` when no map is loaded. */
  readonly totalRooms: number;
  /** Rooms cleared, for a numeric read. */
  readonly clearedRooms: number;
  /** The study rows: sessions, time, days, notes, reviews, experience, rank, fish. */
  readonly rows: readonly StudySubjectRow[];
  /** The review state, as one of three words. Never a colour. */
  readonly reviewUrgency: ReviewUrgency;
  /** Rooms due now. */
  readonly reviewDueCount: number;
  /** Rooms past due. */
  readonly reviewOverdueCount: number;
  /** The review rows: reviewable, reviewed, passes, full passes, ease. */
  readonly reviewRows: readonly StudySubjectRow[];
  /**
   * How the device's three room-clear tallies relate, and what the panel may say about it.
   *
   * Numbers and a sentence together, for the reason this module's header gives: a test asserts
   * the numbers, and the string is presentation. The panel publishes each number as a
   * `data-` attribute so a test never has to read the sentence back.
   */
  readonly clearReconciliation: StudyClearReconciliation;
  /** The subject's last active local day, or `null`. */
  readonly lastActiveLabel: string | null;
  /** A one-sentence note about the bonus run, when the counter is non-zero. */
  readonly bonusNote: string | null;
}

/**
 * One subject's three room-clear tallies, reconciled.
 *
 * Every number here is read straight off the published `SubjectStatistics`; none is recomputed,
 * and the count of cleared rooms a learner reads stays the graph-derived `mastery.clearedRooms`
 * the card already renders. See {@link clearTallySentence} for why three tallies and not two,
 * and for the direction each of the three cases can take.
 */
export interface StudyClearReconciliation {
  /** `roomsClearedCounter`, verbatim. */
  readonly counter: number;
  /** `roomsClearedAwarded`, verbatim. */
  readonly awarded: number;
  /** `notesSubmitted`, verbatim. */
  readonly countedNotes: number;
  /**
   * Clears the device's counter counts that no counted record backs: `max(0, counter - countedNotes)`.
   *
   * The one genuinely missing-work number. `0` on every lane that records a note for every clear
   * it awards, which includes the shipping lane.
   */
  readonly unrecordedClears: number;
  /**
   * Whether the three tallies agree, in which case there is nothing to reconcile.
   *
   * A test asserts this instead of the sentence, so "the panel stayed quiet" is a property
   * rather than the absence of a string.
   */
  readonly agrees: boolean;
  /** The sentence the panel prints, or `null`. */
  readonly sentence: string | null;
}

/**
 * Reconcile one subject's three room-clear tallies.
 *
 * A pure projection of published fields, and it *reads* three numbers without re-deriving any:
 * `src/core/statistics/statisticsMetrics.ts` is the single implementation of all three, and this
 * function's only decision is which sentence the difference supports.
 */
export function studyClearReconciliation(subject: SubjectStatistics): StudyClearReconciliation {
  const counter = subject.roomsClearedCounter;
  const awarded = subject.roomsClearedAwarded;
  const countedNotes = subject.notesSubmitted;
  return {
    counter,
    awarded,
    countedNotes,
    unrecordedClears: Math.max(0, counter - countedNotes),
    agrees: counter === awarded && counter === countedNotes,
    sentence: clearTallySentence({ counter, awarded, countedNotes }),
  };
}

/** Every subject the device holds records for, as a card. */
export function studySubjectCards(snapshot: StatisticsSnapshot): readonly StudySubjectCard[] {
  return snapshot.subjects.map((subject, position) => studySubjectCard(subject, position));
}

/** One subject's card. Exported so a test can build one card without a whole snapshot. */
export function studySubjectCard(subject: SubjectStatistics, position: number): StudySubjectCard {
  const mastery = describeMastery(subject.mastery.state, subject.mastery.mastered);
  const rows: StudySubjectRow[] = [
    subRow('sessions', 'Sessions finished', countWithUnit(subject.sessionsCompleted, 'session'), subject.sessionsCompleted, 'count'),
    subRow('study-time', 'Time in the dungeon', formatStudyMinutes(subject.studyTimeMinutes), subject.studyTimeMinutes, 'minutes'),
    subRow('active-days', 'Days with activity', countWithUnit(subject.activeDays, 'day'), subject.activeDays, 'count'),
    subRow('notes', 'Notes written', countWithUnit(subject.notesSubmitted, 'note'), subject.notesSubmitted, 'count'),
    subRow('reviews', 'Reviews completed', countWithUnit(subject.reviewsCompleted, 'review'), subject.reviewsCompleted, 'count'),
    subRow('experience', 'Experience earned', formatExperience(subject.xpEarned), subject.xpEarned, 'count'),
    subRow('rank', 'Rank', subject.rank ?? 'not set yet', null, 'count'),
    subRow('fish-kept', 'Fish kept', countWithUnit(subject.fishKept, 'fish', 'fish'), subject.fishKept, 'count'),
    subRow('species', 'Different species', countWithUnit(subject.distinctFishSpecies, 'species'), subject.distinctFishSpecies, 'count'),
  ];

  const reviewRows: StudySubjectRow[] = [
    subRow('reviewable', 'Reviewable rooms', countWithUnit(subject.review.reviewableRoomCount, 'room'), subject.review.reviewableRoomCount, 'count'),
    subRow('reviewed', 'Rooms reviewed', countWithUnit(subject.review.reviewedRoomCount, 'room'), subject.review.reviewedRoomCount, 'count'),
    subRow('review-passes', 'Review passes', countWithUnit(subject.review.reviewPassCount, 'pass'), subject.review.reviewPassCount, 'count'),
    subRow('full-passes', 'Full review passes', countWithUnit(subject.review.fullReviewPasses, 'full pass'), subject.review.fullReviewPasses, 'count'),
    // SM-2's ease factor is a real published number, but it is a scheduling input rather
    // than a thing a learner is taught, so it is labelled and left as a figure.
    subRow('ease', 'Average ease factor', subject.review.averageEaseFactor.toFixed(2), null, 'count'),
  ];

  const rooms =
    subject.mastery.totalRooms > 0
      ? `${subject.mastery.clearedRooms} of ${subject.mastery.totalRooms} rooms ` +
        `(${formatCompletionPercent(subject.mastery.clearedRooms, subject.mastery.totalRooms)})`
      : formatCompletionPercent(0, 0);

  // Three published tallies, reconciled once and handed to the panel with its numbers, so the
  // panel never re-reads a field to decide what to say. See `studyStatsCopy.clearTallySentence`
  // for why three and not two, and why this sentence must never claim a paid clear went unpaid.
  const clearReconciliation = studyClearReconciliation(subject);

  const bonusNote =
    subject.clearBonusStreak > 0
      ? `${countWithUnit(subject.clearBonusStreak, 'room clear')} since the last reset. This run adds to the room-clear bonus, so it is not a streak of days.`
      : null;

  return {
    position,
    name: subject.subjectName,
    mastery: mastery.state,
    provenMastery: mastery.proven,
    rooms,
    totalRooms: subject.mastery.totalRooms,
    clearedRooms: subject.mastery.clearedRooms,
    rows,
    reviewUrgency: reviewUrgency(subject.review),
    reviewDueCount: subject.review.reviewDueCount,
    reviewOverdueCount: subject.review.reviewOverdueCount,
    reviewRows,
    clearReconciliation,
    lastActiveLabel: subject.lastActiveDateKey === null ? null : formatLocalShortDate(subject.lastActiveDateKey),
    bonusNote,
  };
}

// ── Recent sessions '─────────────────────────────────────────────────────────

/** One recent session. */
export interface StudySessionRow {
  /** The session's position in the snapshot's list. Stable, and carries nothing. */
  readonly position: number;
  /** `Today`, `Yesterday`, or a short local date. */
  readonly dayLabel: string;
  /** The subject's display name. */
  readonly subjectName: string;
  /** The duration, or `still open`. */
  readonly duration: string;
  /** Minutes, or `null` for an open session. */
  readonly minutes: number | null;
  /** Whether this session has not been closed. */
  readonly open: boolean;
  /** The rooms this session entered. */
  readonly roomsVisited: number;
  /** The session record's own note counter. */
  readonly notes: number;
  /** The session record's own review counter. */
  readonly reviews: number;
  /** The session record's own experience counter. */
  readonly xp: number;
}

/** The recent-sessions rows, newest first, exactly as the snapshot ordered them. */
export function studySessionRows(snapshot: StatisticsSnapshot): readonly StudySessionRow[] {
  return snapshot.recentSessions.map((session, position) => studySessionRow(session, position, snapshot.todayKey));
}

/** One recent session. Exported so a test can build one row without a whole snapshot. */
export function studySessionRow(
  session: RecentSessionSummary,
  position: number,
  todayKey: string,
): StudySessionRow {
  return {
    position,
    dayLabel: formatActivityDayLabel(session.dateKey, todayKey),
    subjectName: session.subjectName,
    duration: formatStudyMinutes(session.studyMinutes),
    minutes: session.studyMinutes,
    open: session.endedAt === null,
    roomsVisited: session.roomsVisited,
    notes: session.notesSubmitted,
    reviews: session.reviewsCompleted,
    xp: session.xpEarned,
  };
}

// ── The whole view '──────────────────────────────────────────────────────────

/** Everything the panel renders, decided in one place. */
export interface StudyStatsView {
  /** `true` when no session has been closed and none is open. */
  readonly empty: boolean;
  /** The empty-state sentences, or `[]` when the dashboard renders. */
  readonly emptySentences: readonly string[];
  /** The restored-history sentences, or `[]` when every session has an event ledger. */
  readonly restoredSentences: readonly string[];
  /** The still-open-sessions sentence, or `null`. */
  readonly openSessionsSentence: string | null;
  /** The device-wide totals. Always built, so the panel never has to invent one. */
  readonly totals: readonly StudyTotalRow[];
  /** The device-wide review and retention rows. */
  readonly retention: readonly StudyRetentionRow[];
  /** Whether the review counts are a partial picture of the device. */
  readonly reviewScopeLimited: boolean;
  /** The standing note about which numbers are device-wide. */
  readonly reviewScopeNote: string;
  /** The activity chart. */
  readonly activity: StudyActivityView;
  /** One card per subject the device holds records for. */
  readonly subjects: readonly StudySubjectCard[];
  /** The recent sessions, newest first. */
  readonly sessions: readonly StudySessionRow[];
  /** The snapshot's local today, for headings that name the window. */
  readonly todayKey: string;
}

/** Build the whole view. Pure: same snapshot in, same view out. */
export function buildStudyStatsView(snapshot: StatisticsSnapshot): StudyStatsView {
  const empty = !hasRecordedSessions(snapshot);
  const sessionsBeforeLedger = snapshot.provenance.sessionsBeforeEventLedger;
  return {
    empty,
    emptySentences: empty ? emptyStateCopy(snapshot.totals.subjectsTracked) : [],
    restoredSentences: sessionsBeforeLedger > 0 ? restoredStateCopy(sessionsBeforeLedger) : [],
    openSessionsSentence:
      snapshot.totals.sessionsOpen > 0
        ? `Sessions still open: ${countWithUnit(snapshot.totals.sessionsOpen, 'session')}. It closes on its own when you change subject, come back to the village, or close the page.`
        : null,
    totals: studyTotalRows(snapshot),
    retention: studyRetentionRows(snapshot),
    reviewScopeLimited: reviewScopeLimited(snapshot),
    reviewScopeNote: REVIEW_SCOPE_NOTE,
    activity: studyActivityView(snapshot),
    subjects: studySubjectCards(snapshot),
    sessions: studySessionRows(snapshot),
    todayKey: snapshot.todayKey,
  };
}

// ── Helpers '─────────────────────────────────────────────────────────────────

function row<Id extends string>(
  id: Id,
  label: string,
  value: string,
  rawValue: number | null,
  unit: 'count' | 'minutes' = 'count',
): StudyStatRow<Id> {
  return { id, label, value, rawValue, unit };
}

function subRow(
  id: string,
  label: string,
  value: string,
  rawValue: number | null,
  unit: 'count' | 'minutes',
): StudySubjectRow {
  return { id, label, value, rawValue, unit };
}

function sum(values: readonly number[]): number {
  return values.reduce<number>((total, value) => total + value, 0);
}
