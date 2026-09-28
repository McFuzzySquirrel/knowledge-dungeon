/**
 * MINOR-1: impossible calendar dates were accepted as provenance.
 *
 * ## The defect
 *
 * `validateProvenance` rejected a date with
 * `!ISO_DATE.test(entry.date) || Number.isNaN(Date.parse(\`${date}T00:00:00Z\`))`.
 * `Date.parse` does not return `NaN` for `2026-02-30T00:00:00Z`; it rolls it over to
 * 2026-03-02 and returns a perfectly good timestamp. So a retrieval date that names
 * a day which does not exist passed the gate, while the message it printed
 * alongside promised "must be an ISO calendar date". A provenance record is a claim
 * about when something happened, and a claim that cannot have happened is not a
 * weaker claim - it is a wrong one.
 *
 * ## What replaced it
 *
 * The parsed date has to round-trip: `new Date(\`${date}T00:00:00Z\`)` is serialised
 * back to ISO and has to equal the input. That rejects a day the calendar does not
 * have while keeping the format check it already had, and it gets the leap-year rule
 * right for free, including the century rule that a hand-written check usually
 * misses.
 *
 * ## What is asserted here
 *
 * 1. Every impossible calendar date QA found is rejected, and the ones already
 *    rejected stay rejected.
 * 2. Real leap days are accepted, and non-leap February 29th is not - so the check is
 *    about the calendar rather than about the number 29.
 * 3. Ordinary dates are untouched, including the last day of a month and a leap day.
 * 4. The committed registry's dates are all real days, and so are the dates on its
 *    commit facts.
 * 5. The message says what the code now does, so the red run's promise and the
 *    green run's behaviour are the same claim.
 *
 * Privacy: no learner data is read, written, printed, or asserted on.
 *
 * Phase: 8.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { codesOf, makeFixture, type Fixture } from './support/licenseGate';

const REPO_ROOT = process.cwd();
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-cc0-assets.mjs');
const REGISTRY = path.join(REPO_ROOT, 'public', 'assets', 'asset-licenses.json');

/** A day that does not exist in the calendar. */
const IMPOSSIBLE = [
  '2026-02-30', // February has 28 days in 2026
  '2026-02-29', // 2026 is not a leap year
  '2023-02-29', // 2023 is not a leap year either
  '1900-02-29', // divisible by 100, not by 400
  '2026-04-31', // April has 30
  '2026-06-31', // June has 30
  '2026-09-31', // September has 30
  '2026-11-31', // November has 30
  '2026-01-32',
  '2026-01-00',
  '2026-00-10', // there is no month zero
  '2026-13-01',
];

/** A day that exists, so a test that is not about dates cannot fail on one. */
const REAL = [
  '2024-02-29', // a leap day, and the century rule agrees: 2000 was a leap year
  '2000-02-29',
  '2026-01-01',
  '2026-12-31',
  '1999-12-31',
  '2026-06-30',
];

const MALFORMED = ['2026-13-45', '27/09/2026', '2026-9-7', 'yesterday', '2026-01-01T00:00:00Z', '20260101'];

const open: Fixture[] = [];
function fixture(): Fixture {
  const made = makeFixture();
  open.push(made);
  return made;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

function withDate(date: string): Fixture {
  const made = fixture();
  const registry = made.registry();
  registry.assets = registry.assets.map((entry) =>
    entry.id === 'fixture-placeholder' ? { ...entry, date } : entry,
  );
  made.writeRegistry(registry);
  return made;
}

describe('a provenance date has to be a day the calendar has', () => {
  it.each(IMPOSSIBLE)('FAILS on %s', (date) => {
    const made = withDate(date);
    const result = made.gate();
    expect(result.code, `${date} was accepted: ${result.output}`).toBe(1);
    expect(codesOf(result), date).toContain('E-DATE-FORMAT');
  });

  it.each(REAL)('accepts %s', (date) => {
    const made = withDate(date);
    const result = made.gate();
    expect(result.code, `${date} was refused: ${result.output}`).toBe(0);
    expect(codesOf(result), date).toEqual([]);
  });

  it.each(MALFORMED)('still FAILS on the malformed %s', (date) => {
    // The format half of the rule was already right, and a fix for the calendar half
    // that lost it would be a regression rather than a repair.
    const made = withDate(date);
    const result = made.gate();
    expect(result.code, `${date} was accepted: ${result.output}`).toBe(1);
    expect(codesOf(result), date).toContain('E-DATE-FORMAT');
  });

  it('the entry date is the one that fails, so the rule is not reading another field', () => {
    // `introducedBy.date` is a different field and the gate does not date-check it
    // today. That boundary is asserted rather than left implied: the entry's own
    // date stays valid, the run stays green, and nobody later mistakes this test for
    // a guarantee about commit facts. (Every commit date the committed registry does
    // record is a real day - see below - but that is checked there, by reading it.)
    const made = fixture();
    const registry = made.registry();
    registry.assets = registry.assets.map((entry) =>
      entry.id === 'legacy-fixture-sprite'
        ? { ...entry, introducedBy: { commit: '0000000', date: '2026-02-30', subject: 'Fixture.' } }
        : entry,
    );
    made.writeRegistry(registry);
    const result = made.gate();
    expect(result.code, result.output).toBe(0);
    expect(codesOf(result), result.output).toEqual([]);
  });

  it('names the promise the code now keeps, so the red run is not a promise it breaks', () => {
    const made = withDate('2026-02-30');
    const result = made.gate();
    expect(result.output).toMatch(/`date` must be a real ISO calendar date/);
    // ...and the example it gives is the one that used to pass.
    expect(result.output).toContain('2026-02-30');
  });

  it('the checker decides by round-tripping, not by trusting Date.parse', () => {
    // A regression guard on the mechanism rather than the message: the fix is that
    // the parsed value has to equal the input, and a future edit that goes back to a
    // NaN check would reintroduce 2026-02-30 while leaving every message intact.
    const source = readFileSync(CHECKER, 'utf8');
    expect(source).not.toMatch(/Date\.parse\(`\$\{entry\.date\}/);
    const roundTrip = /function isCalendarDate\(value\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(roundTrip, 'the checker has no isCalendarDate function').not.toBe('');
    expect(roundTrip).toMatch(/toISOString\(\)/);
  });
});

describe('every date the committed registry records is a real day', () => {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as {
    assets: { id?: string; date?: string; introducedBy?: { date?: string | null } }[];
  };

  it('every entry date and commit date names a day that exists', () => {
    for (const entry of registry.assets) {
      const date = String(entry.date);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(date), `${String(entry.id)} date ${date}`).toBe(true);
      const parsed = new Date(`${date}T00:00:00Z`);
      expect(Number.isNaN(parsed.getTime()), `${String(entry.id)} date ${date}`).toBe(false);
      expect(parsed.toISOString().slice(0, 10), `${String(entry.id)} date ${date}`).toBe(date);
      const introduced = entry.introducedBy?.date;
      if (typeof introduced === 'string' && introduced.length > 0) {
        expect(new Date(`${introduced}T00:00:00Z`).toISOString().slice(0, 10), String(entry.id)).toBe(
          introduced,
        );
      }
    }
    expect(registry.assets.length).toBeGreaterThan(0);
  });
});
