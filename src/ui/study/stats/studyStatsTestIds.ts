/**
 * The static ids and section keys the statistics dashboard exposes to tests.
 *
 * ## Why a fifth object rather than entries on `src/ui/study/controlIds.ts`
 *
 * That file's own rule is that "Phase 14's vocabulary is not where Phase 15's controls
 * belong", and three phases have already added one object each for exactly that reason.
 * Phase 18's ids belong to Phase 18's surfaces, and adding to a shared file that four
 * earlier phases' gates pin would make an unrelated id rename a statistics failure.
 *
 * ## What may appear here
 *
 * Static literals only, and that is the rule for this file in particular: **no opaque
 * identifier**. No subject id, room id, session id, note id, or event id reaches the DOM as an
 * attribute, because an id reaches test output, issue reports and screenshots, and those ids
 * are app-minted values that mean nothing to a learner and single out one person's records to
 * a reader of a bug report. The one place identity is needed - telling one subject card from
 * another in a test - is handled by the *position* the view model assigns, which is a
 * structural index and carries nothing.
 *
 * **One learner-derived value is allowed, and it is a local calendar day.**
 * `data-study-stats-day="2026-06-05"` and `data-study-stats-last-active="5 Jun"` appear on
 * the activity cells and the subject cards. That is deliberate rather than a lapse: the day is
 * already the cell's *visible text* in the same row, in the learner's own locale, so the
 * attribute reveals nothing the panel has not already shown - and it is the value a test
 * actually needs. "The cell for 5 June says 45 minutes" cannot be expressed by an index, and
 * parsing `Tue 4 Nov` back out of a locale-formatted string would make the assertion depend on
 * the machine's ICU data. A local day is not an identifier: it does not point at one record.
 *
 * The reverse rule matters as much: every value here is rendered **unconditionally**, by
 * the element that owns it, in the same commit. An attribute that appears only when some
 * other condition happens to hold is one a test can assert and the component can lie about,
 * and where the dashboard has a choice - a count that is zero, a list that is empty - it puts
 * the attribute on a container that always renders.
 */
export const STUDY_STATS_IDS = Object.freeze({
  /** The dialog frame, which receives focus on open. */
  dialog: 'study-stats-dialog',
  /** The dialog's own heading. */
  title: 'study-stats-title',
  /** The close control in the header. */
  close: 'study-stats-close',
  /** The whole panel body: totals, activity, retention, subjects, sessions. */
  dashboard: 'study-stats-dashboard',
  /** The empty-state block, rendered instead of the dashboard body. */
  empty: 'study-stats-empty',
  /** The restored-history notice. Present with the body, or without it. */
  restored: 'study-stats-restored',
  /** The still-open-sessions note. */
  openSessions: 'study-stats-open-sessions',
  /** The standing note about which numbers are device-wide. */
  reviewScope: 'study-stats-review-scope',
  /** The privacy sentence in the footer. */
  privacy: 'study-stats-privacy',
  /** The whole totals definition list. */
  totals: 'study-stats-totals',
  /** The whole review-and-retention definition list. */
  retention: 'study-stats-retention',
  /** The activity chart's list. */
  activity: 'study-stats-activity',
  /** The activity chart's window control group. */
  activityWindow: 'study-stats-activity-window',
  /** The list of subject cards. */
  subjects: 'study-stats-subjects',
  /** The list of recent sessions. */
  sessions: 'study-stats-sessions',
  /** The panel body rendered while the dashboard is switched off. */
  disabled: 'study-stats-disabled',
  /** The HUD's explanation for a disabled Stats control. */
  hudDisabledNote: 'study-stats-hud-disabled-note',
});

export type StudyStatsId = (typeof STUDY_STATS_IDS)[keyof typeof STUDY_STATS_IDS];

/**
 * The `data-study-stats-section` values, one per block of the panel.
 *
 * A union of eight literals rather than free strings, so a typo in a test is a type error
 * rather than an assertion that silently finds nothing.
 */
export const STUDY_STATS_SECTIONS = Object.freeze({
  totals: 'totals',
  activity: 'activity',
  retention: 'retention',
  subjects: 'subjects',
  sessions: 'sessions',
  empty: 'empty',
  restored: 'restored',
  disabled: 'disabled',
} as const);

export type StudyStatsSection = (typeof STUDY_STATS_SECTIONS)[keyof typeof STUDY_STATS_SECTIONS];

/**
 * The `data-study-stats-total` keys: one per published total.
 *
 * The union is the point: {@link import('./studyStatsViewModel').StudyTotalId} is built from
 * this object, so a total added to the view model without adding its key here fails the
 * typecheck rather than shipping a row no test can reach.
 */
export const STUDY_STATS_TOTAL_KEYS = Object.freeze({
  sessionsCompleted: 'sessions-completed',
  studyTime: 'study-time',
  longestSession: 'longest-session',
  averageSession: 'average-session',
  activeDays: 'active-days',
  consecutiveStudyDayStreak: 'study-day-streak',
  uniqueRoomsVisited: 'rooms-explored',
  roomVisits: 'room-visits',
  notesSubmitted: 'notes-written',
  reviewsCompleted: 'reviews-completed',
  xpEarned: 'experience-earned',
  fishKept: 'fish-kept',
  distinctFishSpecies: 'species-collected',
  subjectsTracked: 'subjects-tracked',
} as const);

export type StudyStatsTotalKey =
  (typeof STUDY_STATS_TOTAL_KEYS)[keyof typeof STUDY_STATS_TOTAL_KEYS];

/**
 * The `data-study-stats-retention` keys.
 *
 * Disjoint from {@link STUDY_STATS_TOTAL_KEYS} on purpose. Two sections publishing the same
 * number under two names is how a learner concludes the dashboard disagrees with itself,
 * and a duplicate would also make it possible to change one and not the other.
 */
export const STUDY_STATS_RETENTION_KEYS = Object.freeze({
  consecutiveReviewDayStreak: 'review-day-streak',
  roomsReviewed: 'rooms-reviewed',
  reviewPasses: 'review-passes',
  fullReviewPasses: 'full-review-passes',
  subjectsWithProvenMastery: 'subjects-mastered',
} as const);

export type StudyStatsRetentionKey =
  (typeof STUDY_STATS_RETENTION_KEYS)[keyof typeof STUDY_STATS_RETENTION_KEYS];
