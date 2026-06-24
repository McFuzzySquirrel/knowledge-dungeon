/**
 * Spaced Repetition - SM-2 Algorithm
 *
 * Implements the SuperMemo 2 (SM-2) algorithm for scheduling review sessions
 * on a per-room basis. The algorithm uses quality response ratings (0–5) to
 * compute ease factors, intervals, and next review dates.
 *
 * References:
 *   - Wozniak, P. (1998). SuperMemo 2 Algorithm.
 *   - https://www.supermemo.com/english/ol/sm2.htm
 */

/**
 * Quality response rating: 0–5 scale.
 *   - 0 = complete blackout
 *   - 1 = incorrect; correct answer remembered upon review
 *   - 2 = incorrect; answer seemed easy to recall
 *   - 3 = correct with serious difficulty
 *   - 4 = correct after hesitation
 *   - 5 = perfect response
 */
export type QualityRating = 0 | 1 | 2 | 3 | 4 | 5;

/** Minimum ease factor - prevents intervals from collapsing to zero. */
export const MIN_EASE_FACTOR = 1.3;

/** Starting ease factor for new items. */
export const DEFAULT_EASE_FACTOR = 2.5;

/** Initial interval in days after the first successful review. */
export const INITIAL_INTERVAL_DAYS = 1;

/** Multiplier applied to interval after second successful review (quality ≥ 3). */
export const SECOND_INTERVAL_MULTIPLIER = 6;

/** Maximum quality rating allowed by SM-2. */
export const MAX_QUALITY_RATING = 5;

/** Minimum quality rating. */
export const MIN_QUALITY_RATING = 0;

export interface Sm2State {
  /** The quality response (0–5) from the last review. */
  qualityResponse: QualityRating;
  /** Current ease factor (≥ 1.3). */
  easeFactor: number;
  /** Current interval in days before the next review. */
  intervalDays: number;
  /** ISO 8601 date string for the next scheduled review. */
  nextReviewDate: string;
  /** Number of consecutive correct reviews (quality ≥ 3). */
  consecutiveCorrect: number;
}

export interface Sm2Input {
  /** The quality rating given by the user (or computed) for this review. */
  quality: QualityRating;
  /** Previous SM-2 state, or null for a first-time review. */
  previousState: Sm2State | null;
  /** ISO 8601 date string of when the review occurred. */
  reviewedAtIso: string;
}

/**
 * Validate that a quality rating is in range 0–5.
 */
export function isValidQualityRating(value: number): value is QualityRating {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

/**
 * Clamp a value to the valid quality rating range.
 */
export function clampQualityRating(value: number): QualityRating {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(MIN_QUALITY_RATING, Math.min(MAX_QUALITY_RATING, Math.round(value)));
  return clamped as QualityRating;
}

/**
 * Compute the next SM-2 state given a quality rating and previous state.
 *
 * SM-2 Algorithm:
 *   1. If quality < 3: reset interval to 1 day, reset consecutive counter.
 *   2. If quality ≥ 3 and consecutiveCorrect = 0: interval = 1 day.
 *   3. If quality ≥ 3 and consecutiveCorrect = 1: interval = 6 days.
 *   4. If quality ≥ 3 and consecutiveCorrect ≥ 2: interval = previous interval * ease factor.
 *   5. Ease factor: EF' = EF + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
 *      Clamped to minimum 1.3.
 */
export function updateSm2State(input: Sm2Input): Sm2State {
  const { quality, previousState, reviewedAtIso } = input;

  // Compute new ease factor.
  let easeFactor = previousState?.easeFactor ?? DEFAULT_EASE_FACTOR;
  const qDiff = 5 - quality;
  easeFactor = easeFactor + (0.1 - qDiff * (0.08 + qDiff * 0.02));
  easeFactor = Math.max(MIN_EASE_FACTOR, easeFactor);

  let intervalDays: number;
  let consecutiveCorrect: number;

  if (quality < 3) {
    // Reset on poor quality - restart interval.
    intervalDays = INITIAL_INTERVAL_DAYS;
    consecutiveCorrect = 0;
  } else {
    consecutiveCorrect = (previousState?.consecutiveCorrect ?? 0) + 1;

    if (consecutiveCorrect === 1) {
      intervalDays = INITIAL_INTERVAL_DAYS;
    } else if (consecutiveCorrect === 2) {
      intervalDays = SECOND_INTERVAL_MULTIPLIER;
    } else {
      // For consecutiveCorrect ≥ 3, multiply previous interval by ease factor.
      const prevInterval = previousState?.intervalDays ?? SECOND_INTERVAL_MULTIPLIER;
      intervalDays = Math.round(prevInterval * easeFactor);
    }
  }

  const nextReviewDate = addDaysToIso(reviewedAtIso, intervalDays);

  return {
    qualityResponse: quality,
    easeFactor,
    intervalDays,
    nextReviewDate,
    consecutiveCorrect,
  };
}

/**
 * Compute the default SM-2 state for a room that has never been reviewed.
 */
export function makeDefaultSm2State(): Sm2State {
  return {
    qualityResponse: 0,
    easeFactor: DEFAULT_EASE_FACTOR,
    intervalDays: INITIAL_INTERVAL_DAYS,
    nextReviewDate: new Date().toISOString(),
    consecutiveCorrect: 0,
  };
}

/**
 * Determine if a room's review is overdue based on its next review date.
 */
export function isReviewOverdue(nextReviewDate: string, nowIso?: string): boolean {
  const now = nowIso ?? new Date().toISOString();
  return nextReviewDate <= now;
}

/**
 * Calculate the number of days until the next review.
 * Returns 0 if overdue or today.
 */
export function daysUntilReview(nextReviewDate: string, nowIso?: string): number {
  const now = nowIso ?? new Date().toISOString();
  const nextDate = new Date(nextReviewDate);
  const nowDate = new Date(now);

  // If same calendar day, return 0
  if (nextDate.toDateString() === nowDate.toDateString()) return 0;

  const diffMs = nextDate.getTime() - nowDate.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Add N days to an ISO 8601 date string and return a new ISO string.
 */
function addDaysToIso(iso: string, days: number): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return new Date().toISOString();
  date.setDate(date.getDate() + Math.max(0, Math.trunc(days)));
  return date.toISOString();
}

/**
 * Quality rating labels for UI display.
 */
export const QUALITY_LABELS: Record<QualityRating, string> = {
  0: 'Complete blackout - could not recall anything',
  1: 'Incorrect - but remembered after seeing the answer',
  2: 'Incorrect - answer seemed easy to recall upon seeing it',
  3: 'Correct - required serious mental effort',
  4: 'Correct - after brief hesitation',
  5: 'Perfect - immediate and confident recall',
};

/**
 * Short quality labels for UI buttons.
 */
export const QUALITY_SHORT_LABELS: Record<QualityRating, string> = {
  0: 'Forgot',
  1: 'Barely',
  2: 'Shaky',
  3: 'Solid',
  4: 'Good',
  5: 'Perfect',
};
