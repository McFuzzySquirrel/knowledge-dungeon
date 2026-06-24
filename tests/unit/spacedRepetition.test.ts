import { describe, expect, it } from 'vitest';
import {
  updateSm2State,
  makeDefaultSm2State,
  isValidQualityRating,
  clampQualityRating,
  isReviewOverdue,
  daysUntilReview,
  MIN_EASE_FACTOR,
  DEFAULT_EASE_FACTOR,
  INITIAL_INTERVAL_DAYS,
  SECOND_INTERVAL_MULTIPLIER,
  type Sm2State,
} from '@/core/review';

function makeDummyState(overrides: Partial<Sm2State> = {}): Sm2State {
  return {
    qualityResponse: 3,
    easeFactor: DEFAULT_EASE_FACTOR,
    intervalDays: 1,
    nextReviewDate: '2026-01-01T00:00:00.000Z',
    consecutiveCorrect: 1,
    ...overrides,
  };
}

const REVIEWED_AT = '2026-06-01T00:00:00.000Z';

describe('spacedRepetition - SM-2', () => {
  // ── Validation helpers ──────────────────────────────────────────

  describe('isValidQualityRating', () => {
    it('accepts valid ratings', () => {
      for (let q = 0; q <= 5; q++) {
        expect(isValidQualityRating(q)).toBe(true);
      }
    });

    it('rejects out-of-range values', () => {
      expect(isValidQualityRating(-1)).toBe(false);
      expect(isValidQualityRating(6)).toBe(false);
    });

    it('rejects non-integers', () => {
      expect(isValidQualityRating(2.5)).toBe(false);
      expect(isValidQualityRating(NaN)).toBe(false);
      expect(isValidQualityRating(Infinity)).toBe(false);
    });
  });

  describe('clampQualityRating', () => {
    it('returns valid rating as-is', () => {
      expect(clampQualityRating(4)).toBe(4);
    });

    it('clamps low values to 0', () => {
      expect(clampQualityRating(-5)).toBe(0);
    });

    it('clamps high values to 5', () => {
      expect(clampQualityRating(10)).toBe(5);
    });

    it('rounds non-integers', () => {
      expect(clampQualityRating(3.7)).toBe(4);
      expect(clampQualityRating(2.3)).toBe(2);
    });

    it('returns 0 for NaN', () => {
      expect(clampQualityRating(NaN)).toBe(0);
    });
  });

  // ── Default state ───────────────────────────────────────────────

  describe('makeDefaultSm2State', () => {
    it('returns expected defaults', () => {
      const state = makeDefaultSm2State();
      expect(state.qualityResponse).toBe(0);
      expect(state.easeFactor).toBe(DEFAULT_EASE_FACTOR);
      expect(state.intervalDays).toBe(INITIAL_INTERVAL_DAYS);
      expect(state.consecutiveCorrect).toBe(0);
      expect(typeof state.nextReviewDate).toBe('string');
    });
  });

  // ── SM-2 Algorithm ──────────────────────────────────────────────

  describe('updateSm2State - first review (no previous state)', () => {
    it('quality 5 → initial interval 1, consecutive 1', () => {
      const result = updateSm2State({ quality: 5, previousState: null, reviewedAtIso: REVIEWED_AT });
      expect(result.qualityResponse).toBe(5);
      expect(result.intervalDays).toBe(1);
      expect(result.consecutiveCorrect).toBe(1);
      expect(result.easeFactor).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
    });

    it('quality 4 → initial interval 1', () => {
      const result = updateSm2State({ quality: 4, previousState: null, reviewedAtIso: REVIEWED_AT });
      expect(result.intervalDays).toBe(1);
      expect(result.consecutiveCorrect).toBe(1);
    });

    it('quality 3 → initial interval 1', () => {
      const result = updateSm2State({ quality: 3, previousState: null, reviewedAtIso: REVIEWED_AT });
      expect(result.intervalDays).toBe(1);
      expect(result.consecutiveCorrect).toBe(1);
    });

    it('quality 2 (< 3) → resets, interval 1, consecutive 0', () => {
      const result = updateSm2State({ quality: 2, previousState: null, reviewedAtIso: REVIEWED_AT });
      expect(result.intervalDays).toBe(1);
      expect(result.consecutiveCorrect).toBe(0);
      expect(result.qualityResponse).toBe(2);
    });

    it('quality 1 → resets', () => {
      const result = updateSm2State({ quality: 1, previousState: null, reviewedAtIso: REVIEWED_AT });
      expect(result.consecutiveCorrect).toBe(0);
    });

    it('quality 0 → resets', () => {
      const result = updateSm2State({ quality: 0, previousState: null, reviewedAtIso: REVIEWED_AT });
      expect(result.consecutiveCorrect).toBe(0);
    });
  });

  describe('updateSm2State - second review', () => {
    it('quality ≥ 3 and prev consecutive = 1 → interval = 6 days', () => {
      const prev = makeDummyState({ consecutiveCorrect: 1, intervalDays: 1 });
      const result = updateSm2State({ quality: 4, previousState: prev, reviewedAtIso: REVIEWED_AT });
      expect(result.intervalDays).toBe(SECOND_INTERVAL_MULTIPLIER);
      expect(result.consecutiveCorrect).toBe(2);
    });

    it('quality < 3 on second review → resets to interval 1', () => {
      const prev = makeDummyState({ consecutiveCorrect: 1, intervalDays: 1, easeFactor: 2.5 });
      const result = updateSm2State({ quality: 2, previousState: prev, reviewedAtIso: REVIEWED_AT });
      expect(result.intervalDays).toBe(1);
      expect(result.consecutiveCorrect).toBe(0);
    });
  });

  describe('updateSm2State - third+ review (interval scaling)', () => {
    it('quality ≥ 3 with consecutiveCorrect ≥ 2 → interval = prev * EF', () => {
      const prev = makeDummyState({ consecutiveCorrect: 2, intervalDays: 6, easeFactor: 2.5 });
      const result = updateSm2State({ quality: 5, previousState: prev, reviewedAtIso: REVIEWED_AT });
      // prev interval 6 * EF (approx 2.6 after quality 5 boost) ≈ round(15.6) = 16
      expect(result.intervalDays).toBeGreaterThanOrEqual(15);
      expect(result.intervalDays).toBeLessThanOrEqual(17);
      expect(result.consecutiveCorrect).toBe(3);
    });

    it('interval scales proportionally with ease factor', () => {
      const prevHighEf = makeDummyState({ consecutiveCorrect: 2, intervalDays: 6, easeFactor: 2.8 });
      const resultHigh = updateSm2State({ quality: 4, previousState: prevHighEf, reviewedAtIso: REVIEWED_AT });
      const prevLowEf = makeDummyState({ consecutiveCorrect: 2, intervalDays: 6, easeFactor: 1.3 });
      const resultLow = updateSm2State({ quality: 4, previousState: prevLowEf, reviewedAtIso: REVIEWED_AT });
      expect(resultHigh.intervalDays).toBeGreaterThan(resultLow.intervalDays);
    });
  });

  // ── Ease factor computation ─────────────────────────────────────

  describe('ease factor', () => {
    it('quality 5 increases ease factor', () => {
      const prev = makeDummyState({ easeFactor: 2.5, consecutiveCorrect: 1 });
      const result = updateSm2State({ quality: 5, previousState: prev, reviewedAtIso: REVIEWED_AT });
      expect(result.easeFactor).toBeGreaterThan(2.5);
      // EF' = 2.5 + (0.1 - 0 * (0.08 + 0 * 0.02)) = 2.5 + 0.1 = 2.6
      expect(result.easeFactor).toBeCloseTo(2.6, 1);
    });

    it('quality 4 mostly retains ease factor', () => {
      const prev = makeDummyState({ easeFactor: 2.5, consecutiveCorrect: 1 });
      const result = updateSm2State({ quality: 4, previousState: prev, reviewedAtIso: REVIEWED_AT });
      // EF' = 2.5 + (0.1 - 1 * (0.08 + 1 * 0.02)) = 2.5 + (0.1 - 0.10) = 2.5
      expect(result.easeFactor).toBeCloseTo(2.5, 1);
    });

    it('quality 3 decreases ease factor', () => {
      const prev = makeDummyState({ easeFactor: 2.5, consecutiveCorrect: 1 });
      const result = updateSm2State({ quality: 3, previousState: prev, reviewedAtIso: REVIEWED_AT });
      // EF' = 2.5 + (0.1 - 2 * (0.08 + 2 * 0.02)) = 2.5 + (0.1 - 2 * 0.12) = 2.5 + (0.1 - 0.24) = 2.36
      expect(result.easeFactor).toBeLessThan(2.5);
      expect(result.easeFactor).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
    });

    it('quality 0 heavily decreases ease factor', () => {
      const prev = makeDummyState({ easeFactor: 2.5, consecutiveCorrect: 1 });
      const result = updateSm2State({ quality: 0, previousState: prev, reviewedAtIso: REVIEWED_AT });
      // EF' = 2.5 + (0.1 - 5 * (0.08 + 5 * 0.02)) = 2.5 + (0.1 - 5 * 0.18) = 2.5 + (0.1 - 0.90) = 1.70
      expect(result.easeFactor).toBeLessThan(2.0);
      expect(result.easeFactor).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
    });

    it('ease factor never drops below MIN_EASE_FACTOR', () => {
      const prev = makeDummyState({ easeFactor: MIN_EASE_FACTOR, consecutiveCorrect: 1 });
      const result = updateSm2State({ quality: 0, previousState: prev, reviewedAtIso: REVIEWED_AT });
      expect(result.easeFactor).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
    });
  });

  // ── Next review date ────────────────────────────────────────────

  describe('nextReviewDate', () => {
    it('sets next review date to reviewedAt + interval days', () => {
      const result = updateSm2State({ quality: 5, previousState: null, reviewedAtIso: '2026-06-01T00:00:00.000Z' });
      const expected = new Date('2026-06-02T00:00:00.000Z');
      expect(new Date(result.nextReviewDate).toDateString()).toBe(expected.toDateString());
    });

    it('next review date is in the future for high quality', () => {
      const prev = makeDummyState({ consecutiveCorrect: 2, intervalDays: 6, easeFactor: 2.5 });
      const result = updateSm2State({ quality: 5, previousState: prev, reviewedAtIso: REVIEWED_AT });
      const nextDate = new Date(result.nextReviewDate);
      const reviewedDate = new Date(REVIEWED_AT);
      expect(nextDate.getTime()).toBeGreaterThan(reviewedDate.getTime());
    });
  });

  // ── Overdue and days-until helpers ──────────────────────────────

  describe('isReviewOverdue', () => {
    it('returns true when nextReviewDate is in the past', () => {
      expect(isReviewOverdue('2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(true);
    });

    it('returns false when nextReviewDate is in the future', () => {
      expect(isReviewOverdue('2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(false);
    });

    it('returns true when nextReviewDate equals now', () => {
      expect(isReviewOverdue('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(true);
    });
  });

  describe('daysUntilReview', () => {
    it('returns positive days for future date', () => {
      const nextYear = '2027-01-01T00:00:00.000Z';
      const days = daysUntilReview(nextYear, '2026-06-01T00:00:00.000Z');
      expect(days).toBeGreaterThan(180);
    });

    it('returns 0 for past date', () => {
      expect(daysUntilReview('2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(0);
    });

    it('returns 0 for same day', () => {
      expect(daysUntilReview('2026-06-01T12:00:00.000Z', '2026-06-01T14:00:00.000Z')).toBe(0);
    });

    it('returns 1 for next day', () => {
      expect(daysUntilReview('2026-06-02T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(1);
    });
  });

  // ── Integration-scenario: multi-review sequence ─────────────────

  describe('multi-review sequence', () => {
    it('builds up intervals over consecutive correct reviews', () => {
      let state: Sm2State | null = null;
      const dates = [
        '2026-06-01T00:00:00.000Z',
        '2026-06-02T00:00:00.000Z',
        '2026-06-08T00:00:00.000Z',
        '2026-06-24T00:00:00.000Z',
      ];

      // Review 1: quality 5
      state = updateSm2State({ quality: 5, previousState: state, reviewedAtIso: dates[0]! });
      expect(state.intervalDays).toBe(1);
      expect(state.consecutiveCorrect).toBe(1);

      // Review 2: quality 5
      state = updateSm2State({ quality: 5, previousState: state, reviewedAtIso: dates[1]! });
      expect(state.intervalDays).toBe(SECOND_INTERVAL_MULTIPLIER);
      expect(state.consecutiveCorrect).toBe(2);

      // Review 3: quality 4
      state = updateSm2State({ quality: 4, previousState: state, reviewedAtIso: dates[2]! });
      expect(state.intervalDays).toBeGreaterThan(SECOND_INTERVAL_MULTIPLIER);
      expect(state.consecutiveCorrect).toBe(3);

      // Review 4: quality 5
      state = updateSm2State({ quality: 5, previousState: state, reviewedAtIso: dates[3]! });
      expect(state.consecutiveCorrect).toBe(4);
    });

    it('resets after a low-quality review and rebuilds', () => {
      let state: Sm2State | null = makeDummyState({
        consecutiveCorrect: 2,
        intervalDays: 6,
        easeFactor: 2.5,
      });

      // Good review
      state = updateSm2State({ quality: 5, previousState: state, reviewedAtIso: REVIEWED_AT });
      expect(state.consecutiveCorrect).toBe(3);

      // Bad review resets
      state = updateSm2State({ quality: 1, previousState: state, reviewedAtIso: REVIEWED_AT });
      expect(state.consecutiveCorrect).toBe(0);
      expect(state.intervalDays).toBe(1);

      // Recover
      state = updateSm2State({ quality: 5, previousState: state, reviewedAtIso: REVIEWED_AT });
      expect(state.consecutiveCorrect).toBe(1);
    });
  });
});
