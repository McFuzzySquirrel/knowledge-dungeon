/**
 * Local calendar-day rules for statistics.
 *
 * ## Why this module exists
 *
 * The statistics dashboard groups activity by **day**, and the pre-Phase-18
 * implementation computed a day key with `new Date(iso).toISOString().slice(0, 10)`
 * and counted consecutive days by subtracting `86_400_000` ms at a time. Both are
 * wrong for a learner, and the second is wrong in a way that is easy to miss in
 * review:
 *
 * - **A day key is a local calendar day, not a UTC one.** A learner in
 *   `Africa/Johannesburg` who studies at 22:00 local on the 4th gets the key
 *   `2026-06-04`, which `toISOString()` agrees with - until the learner studies at
 *   01:00 local on the 5th, which is `2026-06-04T23:00:00Z` and is therefore filed
 *   under the **4th** by UTC. The daily-activity chart then draws a bar on the wrong
 *   day, a streak can break across a midnight that never happened locally, and a
 *   "days studied" total silently disagrees with the learner's own calendar.
 * - **A day is not 86 400 000 ms.** On a daylight-saving transition a local day is 23
 *   hours long (spring forward) or 25 hours long (fall back). Subtracting one day's
 *   milliseconds from a `Date` therefore lands on the *previous* day after a 23-hour
 *   day and *skips* a day after a 25-hour one, so a streak reads 0 where it should
 *   read 1 and a streak of 5 reads 4.
 *
 * ## The rules this module commits to
 *
 * 1. **A day key is derived from local calendar components**, never from a UTC
 *    projection of an instant. {@link localDateKey} is the only place a key is
 *    formatted.
 * 2. **Consecutive-day arithmetic steps calendar days.** Every step is
 *    `new Date(year, month - 1, day + n, NOON_HOUR)`, so the host's calendar does
 *    the addition and the host's time-zone rules decide what that means. No
 *    millisecond-day constant appears anywhere in this file, and
 *    `tests/phase18/localCalendar.test.ts` gates that structurally.
 * 3. **Steps are taken at local noon.** Local midnight does not exist on every
 *    transition day - several zones shift at 00:00 - and a `Date` constructed at a
 *    non-existent local midnight is normalised forward by the host, which can move
 *    it into the *previous* day in a zone that shifts at 23:00. Noon exists on every
 *    day of every zone, so a noon construction is total.
 * 4. **A difference between two keys is computed from the calendar, not from
 *    instants.** The distance between `2026-03-08` and `2026-03-09` is one day in
 *    every zone and for every clock reading, so {@link calendarDayDiff} uses an
 *    exact integer day count (see {@link daysFromCivil}) rather than a `Date`
 *    subtraction. Nothing here therefore depends on the *reader's* zone: two
 *    devices in different zones reading the same stored keys agree on every number
 *    this module reports.
 * 5. **A day key is an opaque string, not an instant.** It has no time, no zone, and
 *    no duration, and nothing in this module tries to reconstruct an instant from
 *    one, because the key is not reversible to one.
 * 6. **The year is set absolutely on every construction.** `new Date(1, 0, 1)`
 *    means the year 1901, so every construction here goes through `setFullYear`,
 *    which has no two-digit-year mapping. Without that, a key below `0100` -
 *    reachable from untrusted restored input - would silently resolve to a
 *    different century. `setFullYear` is the *only* year-setting mechanism, so
 *    there is no second path that could map a year differently.
 *
 * ## DST behaviour, stated exactly
 *
 * Given a local day key `K`:
 *
 * - `addLocalDays(K, 1)` returns the key of the **next calendar day**, which is
 *   exactly one calendar day later in every zone, including the 23-hour and 25-hour
 *   transition days. `addLocalDays(K, -1)` returns the previous one.
 * - `calendarDayDiff(from, to)` is the number of calendar days from `from` to `to`,
 *   signed: `0` for equal keys, `1` for the next day, `-1` for the previous one, and
 *   `16` for a fortnight and a day. It is exact for every year, because it is an
 *   integer day count rather than a `Date` subtraction.
 * - A learner therefore **never** loses a streak and never gains one because of a
 *   daylight-saving transition: consecutive-day counting steps keys and never
 *   compares elapsed milliseconds.
 *
 * ### The one millisecond walk that *is* safe, and why this module does not use it
 *
 * Subtracting `86_400_000` ms from a **local noon** instant happens to land on the
 * previous local noon on an ordinary day, on a 23-hour day, and on a 25-hour day alike -
 * because local noon to local noon is exactly 24 hours of wall-clock except across the two
 * transition days, and on those the offset cancels. That is why a noon-anchored walk passes
 * the transition tests while still being wrong in a way that is easy to miss: it is wrong
 * every other time the walk crosses a DST change, it has no way to *report* that it did so,
 * and it silently becomes wrong the day anyone anchors it at midnight.
 *
 * A **local-midnight** walk is wrong on the transition day itself, which is measurable:
 * in `America/New_York`, walking back from midnight on 2026-03-09 by 24 hours at a time
 * visits `2026-03-09`, then `2026-03-07` - it **skips** 2026-03-08 entirely, because that
 * day is 23 hours long. A streak of four days through the spring-forward weekend therefore
 * reads as three. `tests/phase18/localCalendar.test.ts` asserts both the corrected count and
 * the skipped day, so the fix is pinned by a value rather than by an argument.
 *
 * Calendar construction is what makes the answer total: the host's calendar does the
 * addition, so there is no case where a day is skipped or counted twice.
 * - What daylight saving *does* change is elapsed time, and this module measures
 *   that only where it says so: {@link minutesInLocalDay} reports 1380 or 1500 for a
 *   transition day and 1440 otherwise. Study duration is measured from timestamps by
 *   the caller, never from day keys, so a session that spans the transition reports
 *   the elapsed time the learner actually experienced.
 *
 * ## Privacy
 *
 * This module reads only the host clock and formats it. It performs no I/O, reads no
 * learner content, and returns no identifier. A day key carries a calendar date and
 * nothing else - no topic, no subject name, no room - so it is safe to group, store,
 * and display.
 */

/** Hour used for every calendar-day construction. See rule 3 above. */
const NOON_HOUR = 12;

/**
 * The one canonical shape of a local calendar-day key.
 *
 * Zero-padded so keys sort lexicographically in date order, which is what lets a
 * set of keys be sorted and scanned without parsing. Four digits is enough for every
 * year this application will produce; a wider year would need a wider pattern and
 * would break the lexicographic ordering.
 */
const LOCAL_DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local calendar day, as `YYYY-MM-DD`. */
export type LocalDateKey = string;

export interface LocalCalendarDate {
  /** Full year, e.g. `2026`. */
  readonly year: number;
  /** Month, 1-12. */
  readonly month: number;
  /** Day of month, 1-31. */
  readonly day: number;
}

/** One resolved calendar day and the instant it was resolved from. */
export interface ResolvedLocalDate {
  /** The formatted key. */
  readonly key: LocalDateKey;
  /** Local noon of that day, as constructed by {@link localNoonOfDateKey}. */
  readonly noon: Date;
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a month, 1-12. Proleptic Gregorian, matching `Date`'s own rule. */
export function daysInLocalMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 30;
  }
}

/**
 * Whether a value is a well-formed key this module produced.
 *
 * Also rejects impossible dates (`2026-02-30`, `2026-13-01`) and a key carrying a
 * time fragment (`2026-06-01T00:00:00Z`), because a key arriving from a restored
 * record or a hand-edited backup is untrusted input and {@link addLocalDays} must not
 * silently normalise `2026-02-30` into March.
 */
export function isLocalDateKey(value: unknown): value is LocalDateKey {
  if (typeof value !== 'string') return false;
  const match = LOCAL_DATE_KEY_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInLocalMonth(year, month);
}

/**
 * Parse a key into its calendar components, or `null` when it is not a key.
 *
 * Total over untrusted input, and never throws: a restored backup must not be able to
 * reach `Invalid Date`.
 */
export function parseLocalDateKey(key: unknown): LocalCalendarDate | null {
  if (!isLocalDateKey(key)) return null;
  const match = LOCAL_DATE_KEY_PATTERN.exec(key as string);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Format an instant as the local calendar day the learner experienced it in.
 *
 * The one place a key is produced. Uses `getFullYear` / `getMonth` / `getDate`, which
 * are the **local** accessors, so a key is the local calendar day and never a UTC
 * projection of the same instant.
 *
 * @throws {TypeError} for an unparseable instant, because a caller that cannot name
 * the day it is recording has a bug rather than an edge case, and silently returning
 * `"NaN-NaN-NaN"` would create an un-groupable record.
 */
export function localDateKey(instant: Date | number | string): LocalDateKey {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('localDateKey requires a valid instant');
  }
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** The key for "now" in the host's own time zone. */
export function currentLocalDateKey(): LocalDateKey {
  return localDateKey(new Date());
}

/**
 * Build the instant at local noon of a key.
 *
 * Exposed because it is the documented construction every calendar step uses, and
 * because a test that wants to prove a key denotes a 23- or 25-hour day needs it.
 * Returns `null` for a key this module did not produce rather than constructing an
 * `Invalid Date`.
 */
export function localNoonOfDateKey(key: LocalDateKey): Date | null {
  const parsed = parseLocalDateKey(key);
  if (parsed === null) return null;
  return constructLocalNoon(parsed.year, parsed.month, parsed.day);
}

/**
 * Local noon for an explicit `(year, month, day)`.
 *
 * ## Why it does not use `new Date(y, m, d, 12)`
 *
 * `Date`'s multi-argument constructor maps a year of 0-99 onto 1900-1999, so
 * `new Date(1, 0, 1, 12)` is the year **1901**. A key a restored archive could contain -
 * `0001-01-01` matches the key pattern - would therefore resolve to a different century, and
 * every derived key would be a day in 1901.
 *
 * The fix is `setFullYear`, which sets the year absolutely. It has to be the *only*
 * mechanism, though: building at `new Date(y, m, d, 12)` and then correcting the year works
 * for a year below 100 but **breaks a year rollover**, because the correction is applied to
 * the already-stepped date and resets a 2027-01-01 back to 2026.
 *
 * So the construction starts from an absolute reference, sets the full year first (with the
 * month and day, which `setFullYear` normalises and which is how a day overflow rolls into
 * the next month), and only then sets the time of day. `setFullYear` is order-independent
 * with respect to month/day, so this is not a subtle ordering that could be got wrong later.
 */
function constructLocalNoon(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setHours(NOON_HOUR, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

/** The key and its noon instant, resolved together. */
export function resolveLocalDate(instant: Date | number | string): ResolvedLocalDate {
  const key = localDateKey(instant);
  return { key, noon: localNoonOfDateKey(key) as Date };
}

/**
 * Days since 1970-01-01 for a proleptic-Gregorian date, as an exact integer.
 *
 * Howard Hinnant's `days_from_civil`, which is the standard closed form and uses only
 * integer arithmetic - no `Date`, no time zone, no floating point. It is used for
 * {@link calendarDayDiff} because the distance between two *calendar dates* is a
 * property of the calendar and not of any zone or clock reading: computing it from a
 * `Date` subtraction would reintroduce exactly the daylight-sensitivity this module
 * exists to remove, and would make the answer depend on which device asked.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Step a key by whole calendar days.
 *
 * `addLocalDays('2026-03-08', 1)` is `'2026-03-09'` in **every** time zone, which is
 * the whole point: on the spring-forward day in `America/New_York` that step is 23
 * hours of elapsed time, and the old `- 86_400_000` arithmetic turned it into
 * `'2026-03-07'`.
 *
 * Non-integral day counts truncate toward zero, so `addLocalDays(key, 0.9)` and
 * `addLocalDays(key, -0.9)` both return `key`, and `NaN` steps zero days rather than
 * returning `null` - a caller with a bad count still gets a usable key.
 * Returns `null` for a key this module did not produce.
 */
export function addLocalDays(key: LocalDateKey, days: number): LocalDateKey | null {
  const parsed = parseLocalDateKey(key);
  if (parsed === null) return null;
  const step = Number.isFinite(days) ? Math.trunc(days) : 0;
  // Calendar construction, not millisecond arithmetic. `setFullYear(year, month, day + n)`
  // normalises an out-of-range day number through the host's own calendar, so month and year
  // boundaries need no special case here.
  return localDateKey(constructLocalNoon(parsed.year, parsed.month, parsed.day + step));
}

/**
 * The number of calendar days from `from` to `to`, signed.
 *
 * `calendarDayDiff(a, a)` is `0`, `calendarDayDiff(a, addLocalDays(a, 1))` is `1`, and
 * `calendarDayDiff(a, addLocalDays(a, -1))` is `-1` - on every calendar day in every
 * zone, including both daylight-saving transitions. A leap day counts as one day.
 *
 * Exact for every year this module's key pattern admits, in constant time, and
 * identical on every device: there is no `Date`, no zone, and no millisecond in the
 * answer. Returns `null` when either key is not a key, which is deliberately distinct
 * from `0`, so a caller cannot mistake "untrusted input" for "the same day".
 */
export function calendarDayDiff(from: LocalDateKey, to: LocalDateKey): number | null {
  const fromParts = parseLocalDateKey(from);
  const toParts = parseLocalDateKey(to);
  if (fromParts === null || toParts === null) return null;
  return (
    daysFromCivil(toParts.year, toParts.month, toParts.day) -
    daysFromCivil(fromParts.year, fromParts.month, fromParts.day)
  );
}

/** The newest key in an iterable, or `null` when there is none. */
export function latestLocalDateKey(keys: Iterable<unknown>): LocalDateKey | null {
  let latest: LocalDateKey | null = null;
  for (const key of keys) {
    if (!isLocalDateKey(key)) continue;
    if (latest === null || key > latest) latest = key;
  }
  return latest;
}

/** The oldest key in an iterable, or `null` when there is none. */
export function earliestLocalDateKey(keys: Iterable<unknown>): LocalDateKey | null {
  let earliest: LocalDateKey | null = null;
  for (const key of keys) {
    if (!isLocalDateKey(key)) continue;
    if (earliest === null || key < earliest) earliest = key;
  }
  return earliest;
}

/** Keys in ascending date order, duplicates removed, untrusted keys dropped. */
export function sortedLocalDateKeys(keys: Iterable<unknown>): LocalDateKey[] {
  const unique = new Set<LocalDateKey>();
  for (const key of keys) {
    if (isLocalDateKey(key)) unique.add(key);
  }
  return [...unique].sort();
}

export interface ConsecutiveDayCountOptions {
  /**
   * The key to count back from. Injected rather than read from the clock so the
   * function is pure and a test can place "today" anywhere.
   */
  readonly anchorKey: LocalDateKey;
  /**
   * How many days before the anchor still count as "the streak is alive".
   *
   * `0` means "today itself must have activity". `1` - the value the statistics
   * dashboard uses - means "today or yesterday still counts", which is the
   * conventional reading of a study streak: a learner who has not opened the app
   * yet today has not broken yesterday.
   */
  readonly graceDays?: number;
}

/**
 * Count consecutive calendar days of activity, walking backwards from the anchor.
 *
 * `activity` is the set of keys that recorded any activity. The result is how many
 * consecutive days, counting backwards, all have activity; it is **not** capped by how
 * much activity a day had, so a day with two one-minute sessions counts the same as a
 * day with two hours.
 *
 * The walk is over calendar keys, so a daylight-saving transition cannot shorten or
 * lengthen the result. An empty activity set, an untrusted anchor, or an anchor whose
 * grace window contains no activity gives `0`.
 */
export function countConsecutiveActiveDays(
  activity: Iterable<unknown>,
  options: ConsecutiveDayCountOptions,
): number {
  const active = new Set(sortedLocalDateKeys(activity));
  if (active.size === 0) return 0;
  if (!isLocalDateKey(options.anchorKey)) return 0;
  const grace = Math.max(0, Math.trunc(options.graceDays ?? 0));

  // Seed the walk on the anchor, or on the newest active day inside the grace
  // window. Bounded by `grace` probes, so an anchor with no activity near it costs a
  // constant number of steps rather than a scan.
  let cursor: LocalDateKey | null = options.anchorKey;
  let graceUsed = 0;
  while (!active.has(cursor) && graceUsed < grace) {
    const previous = addLocalDays(cursor, -1);
    if (previous === null) return 0;
    cursor = previous;
    graceUsed += 1;
  }
  if (!active.has(cursor)) return 0;

  let count = 0;
  while (count < 400 * 366 && active.has(cursor)) {
    count += 1;
    const previous = addLocalDays(cursor, -1);
    if (previous === null) return count;
    cursor = previous;
  }
  return count;
}

/**
 * The local-week start key for a key. Weeks start on Monday.
 *
 * ISO-8601's week rule, so a weekly activity chart agrees with anything else that
 * labels weeks and the "this week" and "last 7 days" views cannot disagree about
 * where a week begins. Computed from the day-of-week of the noon construction, so a
 * Monday is a Monday regardless of what the clocks did that day.
 */
export function localWeekStartKey(key: LocalDateKey): LocalDateKey | null {
  const noon = localNoonOfDateKey(key);
  if (noon === null) return null;
  // `getDay()` is 0 (Sunday) through 6 (Saturday); shift so Monday is 0.
  const weekdayIndex = (noon.getDay() + 6) % 7;
  return addLocalDays(key, -weekdayIndex);
}

/**
 * The last `days` local calendar day keys, oldest first, ending at `endKey`.
 *
 * Used by the weekly-activity view so a learner always sees exactly the number of bars
 * they asked for, on a 23-hour day and a 25-hour day alike. `days` below 1 yields an
 * empty list.
 */
export function localDateKeyRange(endKey: LocalDateKey, days: number): LocalDateKey[] {
  const count = Math.max(0, Math.trunc(days));
  const keys: LocalDateKey[] = [];
  let cursor: LocalDateKey | null = endKey;
  for (let index = 0; index < count; index += 1) {
    if (cursor === null) return [];
    keys.unshift(cursor);
    cursor = addLocalDays(cursor, -1);
  }
  return keys;
}

/**
 * Minutes in a local calendar day: 1440, except 1380 or 1500 on a transition day.
 *
 * The only place this module reports a *duration*, and the reason the distinction is
 * documented rather than hidden: the answer is zone-dependent, unlike every other
 * function here, because the elapsed length of a local day is exactly the thing a
 * time zone changes. It exists so a caller - or a test - can observe that a day was
 * 23 or 25 hours long without having to know which zones do that.
 */
export function minutesInLocalDay(key: LocalDateKey): number | null {
  const parsed = parseLocalDateKey(key);
  if (parsed === null) return null;
  const start = constructLocalNoon(parsed.year, parsed.month, parsed.day);
  start.setHours(0, 0, 0, 0);
  const end = constructLocalNoon(parsed.year, parsed.month, parsed.day + 1);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 60000);
}