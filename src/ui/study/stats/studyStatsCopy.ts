/**
 * Every user-visible string and every number format the statistics dashboard renders.
 *
 * ## Why the copy is a module and not inline in the JSX
 *
 * Two of this dashboard's requirements are properties of its *words*, and neither can be
 * asserted against JSX:
 *
 * 1. **No colour-only state.** Plan 10.1. The pre-Phase-18 panel coloured "due today"
 *    with `var(--accent)` and "overdue" with `var(--bad)` and nothing else, so a learner
 *    in greyscale, with a colour-vision deficiency, or in Windows High Contrast read
 *    "3" and "1" with no way to know that one of them wanted attention. Here the state is
 *    a {@link ReviewUrgency} that renders as a word *and* a glyph *and* a border weight,
 *    and the words are pinned by name so a rename cannot quietly drop one.
 * 2. **The empty state is an explanation, not zeros.** A learner with no sessions must be
 *    told what will appear here and why it is empty, which is prose, and prose is exactly
 *    the kind of thing that decays into `0` when someone tidies a component.
 *
 * ## The tautology trap this module is written against
 *
 * The brief for this phase names a specific failure: publish a stat as
 * `"{caught} of {total}"` and every before/after comparison of it is unfailable, because
 * the interesting number is buried inside a composite string. So:
 *
 * - no format function in this file emits a composite `x of y` for a count, because
 *   neither the totals nor any {@link import('@/core/statistics').SubjectStatistics} field
 *   carries the denominator - there is no honest `of` to print, and inventing one is how
 *   "2 of 41 species" style claims get made up;
 * - every count is formatted on its own (`countWithUnit`), so a test can compare a count
 *   before and after a mutation without parsing;
 * - every *duration* is one string from {@link formatStudyMinutes}, and the caller also
 *   carries the raw minute count in the view model, so a numeric assertion never has to
 *   read back a formatted string.
 *
 * ## Local dates only
 *
 * Day keys arrive as local `YYYY-MM-DD` from `src/core/statistics/localCalendar.ts`, and
 * every label here is derived from the key through {@link localNoonOfDateKey} rather than
 * from `new Date(key)`. `new Date('2026-03-08')` is UTC midnight, which in any negative
 * UTC offset is the *previous* local day - the exact UTC defect Phase 18 removed from the
 * metrics, reintroduced by the formatter that displays them.
 *
 * Renderer-neutral: imports `@/core/statistics` only. No React, no store, no DOM.
 */
import {
  addLocalDays,
  localNoonOfDateKey,
  type DailyActivityBucket,
  type SubjectMasteryState,
  type SubjectReviewSummary,
} from '@/core/statistics';

// ── Numbers '─────────────────────────────────────────────────────────────────

/**
 * A study duration, in words.
 *
 * `null` is a real case and not an error: `SubjectStatistics.studyTimeMinutes` and
 * `RecentSessionSummary.studyMinutes` are `null` for a session that has not been closed,
 * and printing "0 min" for it would say the learner studied for no time when the truth is
 * that the session has no end yet.
 *
 * Under a minute is its own case for the same reason: a closed session that lasted four
 * seconds is `0` minutes, and `0 min` reads as "nothing happened" rather than "very
 * briefly".
 */
export function formatStudyMinutes(minutes: number | null): string {
  if (minutes === null) return 'still open';
  const total = Math.max(0, Math.round(minutes));
  if (total < 1) return 'under a minute';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The singular or plural noun for `count`, so "1 sessions" cannot be rendered. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** `3`, `1 room`, `0 rooms` - a count and its noun, never a composite ratio. */
export function countWithUnit(count: number, singular: string, plural?: string): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

/** Experience points. A mass noun, so it does not pluralise. */
export function formatExperience(xp: number): string {
  return `${Math.max(0, Math.trunc(xp))} XP`;
}

/**
 * A ratio as words, for the one place a ratio is genuinely published.
 *
 * `completionRatio` is the domain's own `clearedRooms / totalRooms` to two places, and a
 * whole percentage of a two-place ratio is the honest presentation of it. It is only
 * rendered when `totalRooms > 0`; a subject with no map on this device reports `0` and a
 * percentage of zero would be a claim about nothing.
 */
export function formatCompletionPercent(clearedRooms: number, totalRooms: number): string {
  if (totalRooms <= 0) return 'no map on this device';
  const percent = Math.round((clearedRooms / totalRooms) * 100);
  return `${Math.max(0, Math.min(100, percent))}%`;
}

// ── Local dates '─────────────────────────────────────────────────────────────

/**
 * One local day as `Tue 4 Nov`, or `Today` / `Yesterday`.
 *
 * Built from local noon of the day key, so a daylight-saving transition cannot move the
 * label onto the wrong day and no UTC parsing is involved anywhere.
 */
export function formatActivityDayLabel(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return 'Today';
  if (dateKey === addLocalDays(todayKey, -1)) return 'Yesterday';
  return formatLocalShortDate(dateKey);
}

/** One local day as `Tue 4 Nov`. Returns the key itself if it is not a usable key. */
export function formatLocalShortDate(dateKey: string): string {
  const noon = localNoonOfDateKey(dateKey);
  if (noon === null) return dateKey;
  return noon.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** One local day in full, `Tuesday 4 November`, for a screen reader's first mention. */
export function formatLocalLongDate(dateKey: string): string {
  const noon = localNoonOfDateKey(dateKey);
  if (noon === null) return dateKey;
  return noon.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Whether a bucket had anything at all.
 *
 * A separate function because "was there activity" has three independent sources -
 * sessions, notes and reviews - and a chart that decides it from `studyMinutes` alone
 * would show an empty day for a session that lasted under a minute and rounded to zero.
 */
export function hasDayActivity(bucket: DailyActivityBucket): boolean {
  return (
    bucket.sessions > 0 ||
    bucket.studyMinutes > 0 ||
    bucket.notes > 0 ||
    bucket.reviews > 0 ||
    bucket.xp > 0 ||
    bucket.fishKept > 0
  );
}

/** The one line a day of the activity chart carries, in words. */
export function describeActivityBucket(bucket: DailyActivityBucket, todayKey: string): string {
  const day = formatActivityDayLabel(bucket.dateKey, todayKey);
  if (!hasDayActivity(bucket)) return `${day}: no activity`;
  const parts = [countWithUnit(bucket.sessions, 'session')];
  parts.push(formatStudyMinutes(bucket.studyMinutes));
  if (bucket.notes > 0) parts.push(countWithUnit(bucket.notes, 'note'));
  if (bucket.reviews > 0) parts.push(countWithUnit(bucket.reviews, 'review'));
  return `${day}: ${parts.join(', ')}`;
}

// ── Review state, as words '──────────────────────────────────────────────────

/**
 * How much attention a subject's reviews want.
 *
 * `overdue` wins over `due`, and both win over `clear`, because a subject with one
 * overdue room and three due rooms is an overdue subject: the strongest signal is the one
 * worth surfacing, and the counts beside the chip still say all four numbers.
 */
export type ReviewUrgency = 'clear' | 'due' | 'overdue';

export function reviewUrgency(review: SubjectReviewSummary): ReviewUrgency {
  if (review.reviewOverdueCount > 0) return 'overdue';
  if (review.reviewDueCount > 0) return 'due';
  return 'clear';
}

export interface ReviewUrgencyCopy {
  /** The state, as a word a screen reader reads and a learner reads. */
  readonly label: string;
  /**
   * A glyph, distinct per state.
   *
   * `aria-hidden`, because it is a second signal for the word beside it and not a
   * substitute for it - a screen reader announcing "exclamation mark" would be noise.
   */
  readonly glyph: string;
  /**
   * The whole chip as one sentence.
   *
   * Built here rather than in JSX so the number and the state cannot drift apart, and so
   * a test can hold the exact sentence instead of reconstructing it.
   */
  readonly sentence: (dueCount: number, overdueCount: number) => string;
}

/** The three review states, each with a word and a distinct glyph. */
export const REVIEW_URGENCY_COPY: Readonly<Record<ReviewUrgency, ReviewUrgencyCopy>> = Object.freeze({
  clear: {
    label: 'Nothing due',
    glyph: '✓',
    sentence: (due, overdue) =>
      overdue === 0 && due === 0
        ? 'Nothing due now, and nothing overdue.'
        : `${countWithUnit(due, 'room')} due now.`,
  },
  due: {
    label: 'Due now',
    glyph: '●',
    sentence: (due, overdue) =>
      overdue === 0
        ? `${countWithUnit(due, 'room')} due now.`
        : `${countWithUnit(due, 'room')} due now and ${countWithUnit(overdue, 'room')} overdue.`,
  },
  overdue: {
    label: 'Overdue',
    glyph: '▲',
    sentence: (due, overdue) =>
      `${countWithUnit(overdue, 'room')} overdue` +
      (due > 0 ? `, and ${countWithUnit(due, 'room')} due now.` : '.'),
  },
});

/** The sentence for a subject's review state, from its two counts. */
export function describeReviewState(review: SubjectReviewSummary): string {
  const urgency = reviewUrgency(review);
  return REVIEW_URGENCY_COPY[urgency].sentence(review.reviewDueCount, review.reviewOverdueCount);
}

// ── Room clears: three tallies, one honest sentence '─────────────────────────

/**
 * The three numbers a device keeps about "how many rooms did this learner clear".
 *
 * All three are **published by the snapshot**, and none is derived here:
 *
 * | Field | What it is | Written by |
 * | --- | --- | --- |
 * | {@link counter} | the progression record's `roomsCleared` | **every** awarded clear |
 * | {@link awarded} | entries in the durable room-clear reward ledger | only a clear that names a graph generation |
 * | {@link countedNotes} | counted `note-submission` events | every clear that named a room at all |
 *
 * ## Why three and not two
 *
 * The pre-Phase-18 panel reconciled `counter` against `awarded` alone and printed:
 *
 * > "The cleared-room counter reads 1 while 0 clears have a reward record. The extra 1 came
 * > from a clear made without a reward record, and the reward record is the one that paid out."
 *
 * Every clause of that is false on the shipping lane. The default lane names a room and **no**
 * graph generation, so its clear increments {@link counter} and writes a counted note event but
 * no reward-ledger entry - the two *always* differ there - and that clear was paid: XP in the
 * record, a counted event in the ledger. The sentence was telling a learner their work went
 * unrewarded when it was rewarded, on **every** default-lane subject.
 *
 * Reconciling against {@link countedNotes} as well makes the sentence true in every direction.
 * The sentence is suppressed only when **all three** agree; otherwise one of three branches runs:
 *
 * - `counter > countedNotes` - the counter counted a clear no counted record backs. Real signal,
 *   and the only case that says anything is missing. It fires whether or not `awarded` agrees,
 *   because the gap is against the counted records, not against the reward ledger.
 * - `counter < countedNotes` - the record holds more counted notes than the counter has clears.
 *   Also real, and never reported as missing work.
 * - `counter === countedNotes` with `counter !== awarded` - the difference is *fully explained*
 *   by counted notes. Nothing is missing, so nothing says anything is.
 *
 * ## What this function deliberately does not claim
 *
 * It never asserts that a counted note record and a counted room clear are the same event. The
 * domain derives a note-submission identity from a room id it does not validate
 * (`deriveNoteSubmissionSourceIdentity` accepts any string, so `''` and `'   '` mint two
 * distinct identities and each is counted), so a one-to-one correspondence is not a fact this
 * file is entitled to state. Consequently {@link StudyClearTally.counter} is quoted **only** in
 * the gap sentence, where it is a statement about the device's records rather than about rooms a
 * learner cleared. The learner-facing count of cleared rooms stays the graph-derived one the
 * subject card already renders.
 *
 * That is a **presentation** answer to an unvalidated identity, and it is deliberately not
 * mistaken for the fix. The durable fix belongs to `src/core/statistics/statisticsEvents.ts`,
 * where a blank room id has to stop minting an identity at all: nothing a view model does can
 * un-count two events the domain already recorded. What a view model *can* do is refuse to
 * present one of them to a learner as a room they cleared, and that is what this file does.
 */
export interface StudyClearTally {
  /** `SubjectStatistics.roomsClearedCounter`. Incremented by every awarded clear. */
  readonly counter: number;
  /** `SubjectStatistics.roomsClearedAwarded`. Entries in the durable room-clear reward ledger. */
  readonly awarded: number;
  /** `SubjectStatistics.notesSubmitted`. Counted note-submission events. */
  readonly countedNotes: number;
}

/**
 * One sentence reconciling the three tallies, or `null` when they agree.
 *
 * `null` is a real answer and not a missing one: three tallies that all read the same number
 * leave a learner with nothing to reconcile, and a second line saying so is noise.
 */
export function clearTallySentence(tally: StudyClearTally): string | null {
  const { counter, awarded, countedNotes } = tally;
  if (counter === awarded && counter === countedNotes) return null;

  // The shared first sentence. It is true in every branch, and it is the sentence that means a
  // learner never leaves this panel believing a paid note went unpaid: what the totals rest on is
  // named, and it is a counted record.
  const counted =
    `${countWithUnit(countedNotes, 'note')} ${pluralize(countedNotes, 'is', 'are')} counted above, ` +
    'and every total on this page is worked out from that same counted record.';

  if (counter > countedNotes) {
    const gap = counter - countedNotes;
    return (
      `${counted} This device's room-clear count reads ${counter}, and ${countWithUnit(gap, 'clear')} ` +
      `${pluralize(gap, 'has', 'have')} no counted record here, so this page has nothing to show ` +
      `for ${pluralize(gap, 'it', 'them')}.`
    );
  }

  if (counter < countedNotes) {
    return (
      `${counted} This device's room-clear count reads ${counter}, a separate tally, so the two ` +
      'can differ without anything being missing.'
    );
  }

  // `counter === countedNotes` and the reward ledger still disagrees: every counted clear has a
  // counted note with it. Nothing is missing, so this says so and explains the difference rather
  // than repeating a number that would only invite the question.
  return (
    `${counted} This device also keeps its own count of room clears, and a clear does not always ` +
    'reach every place it is recorded - so the two numbers can differ.'
  );
}

// ── Mastery, as words '───────────────────────────────────────────────────────

/**
 * The domain's four mastery states as four learner-facing sentences.
 *
 * `SubjectMasteryState` is an ordered scale, so `reviewed` is the strongest and `untouched`
 * the weakest, and the labels keep that order in their length: the strongest label is the
 * one that claims the most. The word is the state; nothing in this file or its CSS carries
 * it on colour.
 */
export const STUDY_MASTERY_LABELS: Readonly<Record<SubjectMasteryState, string>> = Object.freeze({
  untouched: 'Not started',
  'in-progress': 'In progress',
  cleared: 'Every room cleared',
  reviewed: 'Every room cleared and reviewed',
});

/** A subject's mastery sentence, plus the separate proven-mastery word when it applies. */
export function describeMastery(
  state: SubjectMasteryState,
  mastered: boolean,
): { readonly state: string; readonly proven: string | null } {
  return {
    state: STUDY_MASTERY_LABELS[state],
    // A separate line rather than a fifth state: `mastered` is a rule over two other
    // facts (`every room cleared` and `at least one full review pass`), and folding it into
    // the label would make the label wrong the moment either fact changed.
    proven: mastered ? 'Mastered: every room cleared and reviewed end to end' : null,
  };
}

// ── Copy blocks '─────────────────────────────────────────────────────────────

/** The dialog's own name, used by `aria-label` and by tests. */
export const STUDY_STATS_TITLE = 'Your study record';

/**
 * The empty state.
 *
 * The brief for this phase: a learner with no sessions gets a real, warm explanation, not
 * zeros and not a blank panel. So this block names what the page *is for*, names the first
 * action that fills it, and - when there are subjects on the device - says what is already
 * there. It never prints a `0`.
 *
 * @param subjectCount How many subjects the device holds.
 */
export function emptyStateCopy(subjectCount: number): readonly string[] {
  const opening =
    'Nothing has been counted yet. Your study record starts the first time you walk into ' +
    'a dungeon.';
  const how =
    'Enter a subject from the village, read or write a room, and this page fills in: ' +
    'sessions, time in the dungeon, notes, reviews, and what you catch.';
  const have =
    subjectCount > 0
      ? `You already have ${countWithUnit(subjectCount, 'dungeon')} ready. ` +
        'Nothing is missing - it just has not been walked yet.'
      : 'Once you create your first dungeon, this page keeps the story of every visit.';
  return [opening, how, have];
}

/**
 * The restored-history notice.
 *
 * Driven by `StatisticsProvenance.sessionsBeforeEventLedger`, which counts sessions whose
 * subject carries no statistics event - a session recorded by a build that predates the
 * event ledger, or restored from an archive written by one. The notice exists because the
 * domain publishes those sessions' study time and rooms into the totals while
 * deliberately **not** adding their note / review / experience counters, so the numbers on
 * screen would otherwise look like an arithmetic error. Saying so is the whole point.
 */
export function restoredStateCopy(sessionsBeforeEventLedger: number): readonly string[] {
  return [
    `${countWithUnit(sessionsBeforeEventLedger, 'session')} on this device ` +
      `${pluralize(sessionsBeforeEventLedger, 'was', 'were')} recorded before notes, reviews ` +
      'and experience were counted in one ledger.',
    'Their time and rooms are included above. The notes, reviews and experience on those ' +
      'sessions are shown on each session below, but are not added to the totals - that way ' +
      'nothing is ever counted twice.',
  ];
}

/** The note shown when a session is still open. */
export function openSessionCopy(openSessions: number): string {
  return (
    `${countWithUnit(openSessions, 'session')} ${pluralize(openSessions, 'is', 'are')} still open. ` +
    'It closes on its own when you change subject, come back to the village, or close the page.'
  );
}

/**
 * The standing note about which numbers are device-wide and which are not.
 *
 * The asymmetry is in the domain's type (`SubjectStatisticsInput.snapshot` is `null` for a
 * subject whose map this device does not hold) and it is a real limit on what the panel can
 * honestly claim. The panel states it rather than letting a learner infer a completion
 * percentage for a subject whose rooms are not on this device.
 */
export const REVIEW_SCOPE_NOTE =
  'Notes, reviews, experience, time and fish are counted for every subject. ' +
  'Rooms cleared and reviews due come from the subject map, and this device holds one map ' +
  'at a time - so those numbers are reported for the subject you have open, and read as ' +
  'not available for the others.';

/** The privacy sentence. Every number here is on this device. */
export const STUDY_STATS_PRIVACY_NOTE =
  'Everything on this page is stored on this device. Nothing here is uploaded, and there is ' +
  'no account and no leaderboard.';

/** The gate-off notice: display disabled, records kept. */
export const STUDY_STATS_DISABLED_TITLE = 'Study statistics are switched off in this build';
export const STUDY_STATS_DISABLED_BODY =
  'Your sessions, notes, reviews and catches are all still recorded - nothing was deleted, ' +
  'and no session stopped being counted. Only this page is hidden. Turning the dashboard ' +
  'back on shows everything again.';
export const STUDY_STATS_DISABLED_HUD_NOTE =
  'The statistics dashboard is switched off in this build. Your records are still being kept.';
