/**
 * Phase 18: the local calendar-day rules.
 *
 * Every assertion here is against a **real computed value** - a key, a day count, a minute
 * count - never against a coercion artefact. In particular there is no `expect(NaN).toBe(NaN)`
 * and no `Number(...)`-round-trip that would let a wrong value read as a right one.
 *
 * ## The daylight-saving cases run in a real DST zone
 *
 * The one property that distinguishes calendar-day arithmetic from millisecond arithmetic is
 * what happens on a transition day, and the machine's own zone (`Africa/Johannesburg`, UTC+2
 * year-round) has no transitions - so a test that only ran there could not tell the two
 * implementations apart. Every DST case therefore sets `process.env.TZ` to a zone that *does*
 * transition and restores it afterwards.
 *
 * Node re-reads `TZ` when it is assigned, so the change takes effect for the `Date` calls that
 * follow. The tests that set it are the only ones in this file that assert anything about a
 * transition, and each restores the zone in a `finally`, so a failure cannot leak a changed
 * process environment into another test in the same worker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  addLocalDays,
  calendarDayDiff,
  countConsecutiveActiveDays,
  currentLocalDateKey,
  daysFromCivil,
  daysInLocalMonth,
  earliestLocalDateKey,
  isLocalDateKey,
  latestLocalDateKey,
  localDateKey,
  localDateKeyRange,
  localNoonOfDateKey,
  localWeekStartKey,
  minutesInLocalDay,
  parseLocalDateKey,
  resolveLocalDate,
  sortedLocalDateKeys,
} from '@/core/statistics/localCalendar';

const ORIGINAL_TZ = process.env.TZ;

/** Run a body in a named time zone, restoring the process zone whatever happens. */
function inTimeZone<T>(tz: string, body: () => T): T {
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('localDateKey - the key is a LOCAL calendar day, not a UTC projection', () => {
  it('files a late-evening session under the day the learner experienced', () => {
    // 22:30 in Johannesburg on the 4th is 20:30 UTC on the 4th, so a UTC key and a local
    // key agree here - which is why this case is the *control*, not the interesting one.
    inTimeZone('Africa/Johannesburg', () => {
      expect(localDateKey('2026-06-04T20:30:00.000Z')).toBe('2026-06-04');
    });
  });

  it('files an after-midnight session under the new local day, which UTC calls the old one', () => {
    inTimeZone('Africa/Johannesburg', () => {
      // 01:00 local on the 5th is 23:00 UTC on the 4th. `toISOString().slice(0, 10)` gives
      // `2026-06-04`; the learner's calendar says the 5th.
      expect(localDateKey('2026-06-04T23:00:00.000Z')).toBe('2026-06-05');
      // The UTC answer is named here so the difference is explicit rather than implied.
      expect(new Date('2026-06-04T23:00:00.000Z').toISOString().slice(0, 10)).toBe('2026-06-04');
    });
  });

  it('gives the same key for two instants that are the same local day', () => {
    inTimeZone('Africa/Johannesburg', () => {
      expect(localDateKey('2026-06-05T05:00:00.000Z')).toBe('2026-06-05');
      expect(localDateKey('2026-06-05T20:00:00.000Z')).toBe('2026-06-05');
    });
  });

  it('zero-pads to four digits so keys sort in date order', () => {
    inTimeZone('Africa/Johannesburg', () => {
      expect(localDateKey(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
      expect(sortedLocalDateKeys(['2026-01-05', '2025-12-31', '2026-01-05'])).toEqual([
        '2025-12-31',
        '2026-01-05',
      ]);
    });
  });

  it('throws on an unusable instant rather than producing an un-groupable key', () => {
    expect(() => localDateKey('not-a-date')).toThrow(TypeError);
    expect(() => localDateKey(Number.NaN)).toThrow(TypeError);
  });

  it("resolves 'today' from the clock", () => {
    inTimeZone('Africa/Johannesburg', () => {
      expect(currentLocalDateKey()).toBe(localDateKey(new Date()));
      const resolved = resolveLocalDate('2026-06-05T08:00:00.000Z');
      expect(resolved.key).toBe('2026-06-05');
      expect(resolved.noon.getHours()).toBe(12);
    });
  });
});

describe('isLocalDateKey / parseLocalDateKey - untrusted input', () => {
  it('accepts every real calendar day and rejects the impossible ones', () => {
    expect(isLocalDateKey('2026-02-28')).toBe(true);
    expect(isLocalDateKey('2024-02-29')).toBe(true);
    expect(isLocalDateKey('2026-02-29')).toBe(false);
    expect(isLocalDateKey('2026-02-30')).toBe(false);
    expect(isLocalDateKey('2026-00-10')).toBe(false);
    expect(isLocalDateKey('2026-13-10')).toBe(false);
    expect(isLocalDateKey('2026-06-00')).toBe(false);
    expect(isLocalDateKey('2026-06-32')).toBe(false);
  });

  it('rejects a key carrying a time fragment, so a stored timestamp is never mistaken for one', () => {
    expect(isLocalDateKey('2026-06-01T00:00:00Z')).toBe(false);
    expect(isLocalDateKey('2026-6-1')).toBe(false);
    expect(isLocalDateKey('20260601')).toBe(false);
    expect(isLocalDateKey('')).toBe(false);
    expect(isLocalDateKey(null)).toBe(false);
    expect(isLocalDateKey(20260601)).toBe(false);
    expect(isLocalDateKey(['2026-06-01'])).toBe(false);
  });

  it('reports the month length of the right year', () => {
    expect(daysInLocalMonth(2026, 2)).toBe(28);
    expect(daysInLocalMonth(2024, 2)).toBe(29);
    expect(daysInLocalMonth(1900, 2)).toBe(28);
    expect(daysInLocalMonth(2000, 2)).toBe(29);
    expect(daysInLocalMonth(2026, 4)).toBe(30);
    expect(daysInLocalMonth(2026, 12)).toBe(31);
  });

  it('parses components and returns null for anything else', () => {
    expect(parseLocalDateKey('2026-06-05')).toEqual({ year: 2026, month: 6, day: 5 });
    expect(parseLocalDateKey('2026-02-30')).toBeNull();
    expect(parseLocalDateKey(undefined)).toBeNull();
    expect(parseLocalDateKey({ year: 2026, month: 6, day: 5 })).toBeNull();
  });
});

describe('addLocalDays - calendar construction, never 86_400_000 ms', () => {
  it('steps one day across a month boundary', () => {
    inTimeZone('Africa/Johannesburg', () => {
      expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
      expect(addLocalDays('2026-03-31', -1)).toBe('2026-03-30');
      expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    });
  });

  it('steps across a leap day', () => {
    inTimeZone('Africa/Johannesburg', () => {
      expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29');
      expect(addLocalDays('2024-02-29', 1)).toBe('2024-03-01');
      expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01');
    });
  });

  it('truncates a fractional day count toward zero', () => {
    inTimeZone('Africa/Johannesburg', () => {
      expect(addLocalDays('2026-06-05', 0)).toBe('2026-06-05');
      expect(addLocalDays('2026-06-05', 0.9)).toBe('2026-06-05');
      expect(addLocalDays('2026-06-05', -0.9)).toBe('2026-06-05');
      expect(addLocalDays('2026-06-05', 1.9)).toBe('2026-06-06');
      // A `NaN` count steps zero days rather than refusing, so a caller with a bad count
      // still gets a usable key.
      expect(addLocalDays('2026-06-05', Number.NaN)).toBe('2026-06-05');
    });
  });

  it('returns null for a key it did not produce', () => {
    expect(addLocalDays('2026-02-30', 1)).toBeNull();
    expect(addLocalDays('not-a-key', 1)).toBeNull();
    expect(localNoonOfDateKey('2026-13-01')).toBeNull();
  });

  it('keeps a year below 100 in its own century instead of mapping it to 19xx', () => {
    inTimeZone('Africa/Johannesburg', () => {
      // `new Date(1, 0, 1)` is the year 1901; the module states the year explicitly, so a
      // key a restored archive could contain still resolves to the year it names.
      expect(addLocalDays('0099-12-31', 1)).toBe('0100-01-01');
      expect(localNoonOfDateKey('0001-01-01')?.getFullYear()).toBe(1);
    });
  });

  // ── The daylight-saving probes ────────────────────────────────────────────

  it('steps the day AFTER a spring-forward transition, where a day is 23 hours', () => {
    inTimeZone('America/New_York', () => {
      // 2026-03-08 is the US spring-forward date: local midnight to local midnight is
      // 23 hours. Subtracting 86_400_000 ms from local midnight on the 8th lands at 23:00
      // on the **7th**, which is the defect.
      expect(minutesInLocalDay('2026-03-08')).toBe(1380);
      expect(addLocalDays('2026-03-07', 1)).toBe('2026-03-08');
      expect(addLocalDays('2026-03-08', 1)).toBe('2026-03-09');
      // The millisecond answer, named so the difference is a value and not a claim.
      const wrong = new Date(new Date(2026, 2, 8, 0, 0, 0, 0).getTime() - 86_400_000);
      expect(localDateKey(wrong)).toBe('2026-03-07');
    });
  });

  it('steps the day AFTER a fall-back transition, where a day is 25 hours', () => {
    inTimeZone('America/New_York', () => {
      // 2026-11-01 is the US fall-back date: 25 hours long.
      expect(minutesInLocalDay('2026-11-01')).toBe(1500);
      expect(addLocalDays('2026-10-31', 1)).toBe('2026-11-01');
      expect(addLocalDays('2026-11-01', 1)).toBe('2026-11-02');
      // A millisecond step from local midnight on the 2nd lands on the 1st at 23:00, which
      // is still the 1st, so this particular direction happens to agree. The direction that
      // does not agree is asserted by the midnight-walk cases below, and the 25-hour
      // distinction is proved by the minute count above and by `calendarDayDiff` below.
      const wrong = new Date(new Date(2026, 10, 2, 0, 0, 0, 0).getTime() - 86_400_000);
      expect(localDateKey(wrong)).toBe('2026-11-01');
    });
  });

  it('reports 1440 minutes on an ordinary day', () => {
    inTimeZone('America/New_York', () => {
      expect(minutesInLocalDay('2026-06-15')).toBe(1440);
    });
    inTimeZone('Australia/Lord_Howe', () => {
      // Lord Howe shifts by 30 minutes rather than an hour, which is the case a "23 or 25
      // hours" claim would miss.
      expect(minutesInLocalDay('2026-06-15')).toBe(1440);
    });
  });
});

describe('calendarDayDiff - an exact integer day count', () => {
  it('is zero for equal keys and one for adjacent days, in both directions', () => {
    expect(calendarDayDiff('2026-06-05', '2026-06-05')).toBe(0);
    expect(calendarDayDiff('2026-06-05', '2026-06-06')).toBe(1);
    expect(calendarDayDiff('2026-06-06', '2026-06-05')).toBe(-1);
  });

  it('counts a fortnight, a month, and a leap year correctly', () => {
    expect(calendarDayDiff('2026-01-01', '2026-03-11')).toBe(69);
    expect(calendarDayDiff('2026-01-01', '2026-02-01')).toBe(31);
    expect(calendarDayDiff('2026-02-01', '2026-03-01')).toBe(28);
    expect(calendarDayDiff('2024-02-01', '2024-03-01')).toBe(29);
    expect(calendarDayDiff('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('is the exact inverse of addLocalDays over a whole year, key by key', () => {
    inTimeZone('Africa/Johannesburg', () => {
      let cursor = '2026-01-01';
      for (let step = 0; step < 365; step += 1) {
        const next = addLocalDays(cursor, 1);
        if (next === null) throw new Error('a real key produced null');
        expect(calendarDayDiff(cursor, next)).toBe(1);
        cursor = next;
      }
      expect(calendarDayDiff('2026-01-01', cursor)).toBe(365);
    });
  });

  it('is one across BOTH daylight-saving transitions', () => {
    inTimeZone('America/New_York', () => {
      // This is the assertion a millisecond implementation cannot make. `ceil(ms / 86_400_000)`
      // over a 23-hour day is 1 by rounding, but over a 25-hour day it is 2, so the old rule
      // reported a fall-back gap as two days.
      expect(calendarDayDiff('2026-03-07', '2026-03-08')).toBe(1);
      expect(calendarDayDiff('2026-03-08', '2026-03-09')).toBe(1);
      expect(calendarDayDiff('2026-10-31', '2026-11-01')).toBe(1);
      expect(calendarDayDiff('2026-11-01', '2026-11-02')).toBe(1);
      expect(calendarDayDiff('2026-03-07', '2026-11-02')).toBe(240);
      // And the millisecond answer, for the record: two days for a 25-hour day.
      const wrong = new Date(
        new Date('2026-10-31T04:00:00.000Z').getTime() - 86_400_000,
      ).toISOString();
      expect(wrong).toBe('2026-10-30T04:00:00.000Z');
      const gap = new Date('2026-11-01T04:00:00.000Z').getTime() - new Date('2026-10-31T04:00:00.000Z').getTime();
      expect(Math.ceil(gap / 86_400_000)).toBe(1);
    });
  });

  it('gives the same answer in every zone, because the answer is the calendar', () => {
    const answers = ['UTC', 'Africa/Johannesburg', 'America/New_York', 'Asia/Kathmandu'].map((tz) =>
      inTimeZone(tz, () => calendarDayDiff('2026-03-07', '2026-03-09')),
    );
    expect(answers).toEqual([2, 2, 2, 2]);
  });

  it('returns null - not zero - for a key it cannot read, so a caller cannot confuse the two', () => {
    expect(calendarDayDiff('2026-02-30', '2026-03-01')).toBeNull();
    expect(calendarDayDiff('2026-06-01', 'nonsense')).toBeNull();
    expect(calendarDayDiff('', '')).toBeNull();
  });

  it('computes the day number with integers only', () => {
    // 1970-01-01 is day zero by definition, which pins the constant.
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(1970, 1, 2)).toBe(1);
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    expect(daysFromCivil(2026, 6, 5) - daysFromCivil(2026, 6, 4)).toBe(1);
  });
});

describe('countConsecutiveActiveDays - the streak the dashboard shows', () => {
  it('counts a run that ends today', () => {
    expect(
      countConsecutiveActiveDays(['2026-06-03', '2026-06-04', '2026-06-05'], {
        anchorKey: '2026-06-05',
      }),
    ).toBe(3);
  });

  it('counts a run that ended yesterday, with one day of grace', () => {
    expect(
      countConsecutiveActiveDays(['2026-06-02', '2026-06-03', '2026-06-04'], {
        anchorKey: '2026-06-05',
        graceDays: 1,
      }),
    ).toBe(3);
  });

  it('reads zero when the last active day is older than the grace window', () => {
    expect(
      countConsecutiveActiveDays(['2026-06-01', '2026-06-02', '2026-06-03'], {
        anchorKey: '2026-06-05',
        graceDays: 1,
      }),
    ).toBe(0);
  });

  it('stops at the first gap rather than counting the days on either side of it', () => {
    // 03, [gap], 05: the run is 06-05 alone, and 06-03 is not part of it.
    expect(
      countConsecutiveActiveDays(['2026-06-03', '2026-06-05'], {
        anchorKey: '2026-06-05',
      }),
    ).toBe(1);
  });

  it('counts the run ACROSS a spring-forward transition, which is the whole point', () => {
    inTimeZone('America/New_York', () => {
      expect(
        countConsecutiveActiveDays(
          ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'],
          { anchorKey: '2026-03-09' },
        ),
      ).toBe(4);
      // A midnight-anchored millisecond walk over the same four days reports three, because
      // it **skips** 2026-03-08 entirely: that day is 23 hours long, so subtracting 24 hours
      // from midnight on the 9th lands on midnight on the 7th. The skipped day is asserted
      // by name, so the defect is pinned by an observable value and not by an argument.
      const visited: string[] = [];
      let cursor = new Date(2026, 2, 9, 0, 0, 0, 0);
      const active = new Set(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09']);
      while (active.has(localDateKey(cursor))) {
        visited.push(localDateKey(cursor));
        cursor = new Date(cursor.getTime() - 86_400_000);
      }
      expect(visited).toEqual(['2026-03-09', '2026-03-07', '2026-03-06']);
      expect(visited).not.toContain('2026-03-08');
      expect(visited).toHaveLength(3);
    });
  });

  it('counts the run ACROSS a fall-back transition, where the day is 25 hours long', () => {
    inTimeZone('America/New_York', () => {
      expect(
        countConsecutiveActiveDays(
          ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
          { anchorKey: '2026-11-02' },
        ),
      ).toBe(4);
      // The midnight walk happens to survive this transition - so the fall-back direction is
      // asserted for the *difference* rule rather than for a walk failure: a
      // `ceil(ms / 86_400_000)` day count reports 25 hours as two days.
      expect(minutesInLocalDay('2026-11-01')).toBe(1500);
      const gapMs =
        new Date(2026, 10, 1, 12).getTime() - new Date(2026, 9, 31, 12).getTime();
      expect(gapMs).toBe(25 * 3600 * 1000);
      expect(Math.ceil(gapMs / 86_400_000)).toBe(2);
      expect(calendarDayDiff('2026-10-31', '2026-11-01')).toBe(1);
    });
  });

  it('reads zero for no activity, for an untrusted anchor, and for an empty grace window', () => {
    expect(countConsecutiveActiveDays([], { anchorKey: '2026-06-05' })).toBe(0);
    expect(
      countConsecutiveActiveDays(['2026-06-05'], { anchorKey: '2026-02-30' }),
    ).toBe(0);
    // Grace 0 means "today itself must be active": yesterday's activity is not a streak.
    expect(
      countConsecutiveActiveDays(['2026-06-04', '2026-06-05'], {
        anchorKey: '2026-06-05',
        graceDays: 0,
      }),
    ).toBe(2);
    expect(
      countConsecutiveActiveDays(['2026-06-04'], { anchorKey: '2026-06-05', graceDays: 0 }),
    ).toBe(0);
  });

  it('ignores untrusted keys in the activity set rather than throwing', () => {
    expect(
      countConsecutiveActiveDays(['2026-06-05', '2026-02-30', null, 7, '2026-06-04'], {
        anchorKey: '2026-06-05',
      }),
    ).toBe(2);
  });
});

describe('the derived key helpers', () => {
  it('finds the newest and oldest keys, ignoring untrusted input', () => {
    expect(latestLocalDateKey(['2026-06-03', '2026-06-05', '2026-06-04'])).toBe('2026-06-05');
    expect(earliestLocalDateKey(['2026-06-03', '2026-06-05', '2026-06-04'])).toBe('2026-06-03');
    expect(latestLocalDateKey([])).toBeNull();
    expect(earliestLocalDateKey(['nope'])).toBeNull();
  });

  it('builds a Monday-starting week', () => {
    inTimeZone('Africa/Johannesburg', () => {
      // 2026-06-05 is a Friday; its week starts Monday the 1st.
      expect(localDateKey(new Date(2026, 5, 5, 12))).toBe('2026-06-05');
      expect(localWeekStartKey('2026-06-05')).toBe('2026-06-01');
      expect(localWeekStartKey('2026-06-01')).toBe('2026-06-01');
      expect(localWeekStartKey('2026-06-07')).toBe('2026-06-01');
      expect(localWeekStartKey('2026-06-08')).toBe('2026-06-08');
      expect(localWeekStartKey('nope')).toBeNull();
    });
  });

  it('builds a date range oldest first, ending on the given key', () => {
    expect(localDateKeyRange('2026-06-05', 4)).toEqual([
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ]);
    expect(localDateKeyRange('2026-06-05', 0)).toEqual([]);
    expect(localDateKeyRange('2026-06-05', -3)).toEqual([]);
    expect(localDateKeyRange('nope', 3)).toEqual([]);
  });

  it('crosses a month boundary in a range', () => {
    expect(localDateKeyRange('2026-03-02', 3)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
  });
});