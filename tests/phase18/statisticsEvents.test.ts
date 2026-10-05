/**
 * Phase 18: the idempotent statistics-event ledger.
 *
 * Every assertion is against a real computed value - an event id, a count, a sum - read back
 * through the same reader the metrics module uses. No assertion compares a value to itself
 * after a coercion, and none would pass for a wrong implementation: the identity digests are
 * literal strings so a change to the identity *rule* is visible as a changed digest rather
 * than as a test that still agrees with itself.
 *
 * ## The property under test
 *
 * A statistic that is recorded beside a reward, in the reward's own record write, under the
 * reward's own identity, cannot disagree with that reward. So the cases that matter here are:
 *
 * - the identity is a pure function of its components (the same components give the same id,
 *   and any component change gives a different id);
 * - recording the same event twice is a no-op, not a second row;
 * - a ledger read from **untrusted** input drops what it cannot use rather than counting it;
 * - and writing the ledger preserves every other preserved app-owned field, so it cannot cost
 *   a device the room-clear ledger, the review-pass ledger, the catch ledger, or the
 *   interrupted-review marker.
 */
import { describe, expect, it } from 'vitest';
import {
  STATISTICS_EVENT_LEDGER_KEY,
  STATISTICS_EVENT_LEDGER_VERSION,
  activeDateKeys,
  countEventsOfKind,
  decideStatisticsEvent,
  deriveStatisticsEventId,
  distinctFishingCatalogIds,
  distinctNoteRooms,
  distinctReviewRooms,
  emptyStatisticsEventLedger,
  eventsOfKind,
  fishingOutcomeEventSourceIdentity,
  hasStatisticsEvent,
  noteSubmissionEventSourceIdentity,
  readStatisticsEventLedger,
  readStatisticsEventLedgerFromFields,
  recordStatisticsEvent,
  reviewCompletionEventSourceIdentity,
  toFishingOutcomeEvent,
  toNoteSubmissionEvent,
  toReviewCompletionEvent,
  toXpAwardEvent,
  totalXpAwarded,
  writeStatisticsEventLedgerToFields,
  type StatisticsEvent,
  type StatisticsNoteSubmissionEvent,
  type StatisticsXpAwardEvent,
} from '@/core/statistics/statisticsEvents';
import { ROOM_CLEAR_REWARD_LEDGER_KEY } from '@/core/progression/roomClearRewards';
import { REVIEW_PASS_REWARD_LEDGER_KEY } from '@/core/review/reviewPassRewards';
import { CATCH_REWARD_LEDGER_KEY } from '@/core/fishing/catchRewards';
import { INTERRUPTED_REVIEW_SESSION_KEY } from '@/core/review/interruptedReviewSession';

const SUBJECT = 'synthetic-phase18-subject';
const LOCAL_DATE = '2026-06-05';
const AT = '2026-06-05T09:30:00.000Z';

function note(roomId: string, clearIdentity: string, xp = 25): StatisticsEvent {
  return toNoteSubmissionEvent({
    subjectId: SUBJECT,
    identity: { roomId, clearIdentity },
    localDate: LOCAL_DATE,
    recordedAt: AT,
    xpAwarded: xp,
  });
}

function review(roomId: string, passNumber: number, xp = 6): StatisticsEvent {
  return toReviewCompletionEvent({
    subjectId: SUBJECT,
    identity: { roomId, passNumber, reviewIdentity: `rpass-${roomId}${passNumber}` },
    localDate: LOCAL_DATE,
    recordedAt: AT,
    xpAwarded: xp,
  });
}

function fish(catalogId: string, castNumber: number, xp = 5): StatisticsEvent {
  return toFishingOutcomeEvent({
    subjectId: SUBJECT,
    identity: { catalogId, contextId: 'pond-context-1', castNumber, catchIdentity: `catch-${catalogId}-${castNumber}` },
    localDate: LOCAL_DATE,
    recordedAt: AT,
    xpAwarded: xp,
  });
}

function xpEvent(amount: number, sourceIdentity: readonly string[]): StatisticsEvent {
  return toXpAwardEvent({
    subjectId: SUBJECT,
    source: 'note-submission',
    sourceIdentity,
    localDate: LOCAL_DATE,
    recordedAt: AT,
    amount,
  });
}

describe('the event identity is a pure function of its components', () => {
  it('gives the same id for the same components and a different one for any change', () => {
    const first = deriveStatisticsEventId({
      kind: 'note-submission',
      subjectId: SUBJECT,
      sourceIdentity: ['room:r1', 'clear:c1'],
    });
    const same = deriveStatisticsEventId({
      kind: 'note-submission',
      subjectId: SUBJECT,
      sourceIdentity: ['room:r1', 'clear:c1'],
    });
    expect(same).toBe(first);
    // The digest is a concrete value, not merely "a string", so a change to the identity rule
    // - a reordering, a dropped component, a version bump - shows up here as a changed
    // literal rather than as two tests that still agree with each other.
    expect(first).toBe('sevt-a5e30195');

    for (const changed of [
      { kind: 'review-completion' as const, subjectId: SUBJECT, sourceIdentity: ['room:r1', 'clear:c1'] },
      { kind: 'note-submission' as const, subjectId: 'other-subject', sourceIdentity: ['room:r1', 'clear:c1'] },
      { kind: 'note-submission' as const, subjectId: SUBJECT, sourceIdentity: ['room:r2', 'clear:c1'] },
      { kind: 'note-submission' as const, subjectId: SUBJECT, sourceIdentity: ['room:r1', 'clear:c2'] },
      { kind: 'note-submission' as const, subjectId: SUBJECT, sourceIdentity: ['room:r1', 'clear:c1', 'extra'] },
    ]) {
      expect(deriveStatisticsEventId(changed)).not.toBe(first);
    }
  });

  it('cannot be made ambiguous by concatenating components', () => {
    // `["room:ab", "clear:c"]` and `["room:a", "clear:bc"]` differ as component lists, and
    // the identity must differ too - otherwise a room named `ab` with one identity would
    // collide with a room named `a` and another.
    const left = deriveStatisticsEventId({
      kind: 'note-submission',
      subjectId: SUBJECT,
      sourceIdentity: ['room:ab', 'clear:c'],
    });
    const right = deriveStatisticsEventId({
      kind: 'note-submission',
      subjectId: SUBJECT,
      sourceIdentity: ['room:a', 'clear:bc'],
    });
    expect(left).not.toBe(right);
  });

  it('derives the source components from the identity the reward site already computed', () => {
    const identity = { roomId: 'room-1', clearIdentity: 'clear-0000abcd' };
    expect(noteSubmissionEventSourceIdentity(identity)).toEqual(['room:room-1', 'clear:clear-0000abcd']);
    expect(
      reviewCompletionEventSourceIdentity({ roomId: 'room-1', passNumber: 3, reviewIdentity: 'rpass-x' }),
    ).toEqual(['room:room-1', 'pass:3', 'review:rpass-x']);
    expect(
      fishingOutcomeEventSourceIdentity({
        catalogId: 'moss-carp',
        contextId: 'ctx-1',
        castNumber: 2,
        catchIdentity: 'catch-x',
      }),
    ).toEqual(['catalog:moss-carp', 'context:ctx-1', 'cast:2', 'catch:catch-x']);
  });

  it('normalises an unusable pass or cast number rather than refusing', () => {
    // A total identity means a caller with a bad number gets a stable, countable event
    // instead of an exception in the middle of a reward write.
    expect(
      reviewCompletionEventSourceIdentity({ roomId: 'r', passNumber: Number.NaN, reviewIdentity: 'x' }),
    ).toEqual(['room:r', 'pass:0', 'review:x']);
    expect(
      fishingOutcomeEventSourceIdentity({
        catalogId: 'c',
        contextId: 'ctx',
        castNumber: -4,
        catchIdentity: 'x',
      }),
    ).toEqual(['catalog:c', 'context:ctx', 'cast:0', 'catch:x']);
  });

  it('stores the components the identity was derived from, so the two cannot disagree', () => {
    const built = toNoteSubmissionEvent({
      subjectId: SUBJECT,
      identity: { roomId: 'room-1', clearIdentity: 'clear-abc' },
      localDate: LOCAL_DATE,
      recordedAt: AT,
      xpAwarded: 30,
    });
    // Narrowed to the note kind, because the union's `xp-award` variant has no `xpAwarded`.
    expect(built as StatisticsNoteSubmissionEvent).toEqual({
      kind: 'note-submission',
      eventId: deriveStatisticsEventId({
        kind: 'note-submission',
        subjectId: SUBJECT,
        sourceIdentity: ['room:room-1', 'clear:clear-abc'],
      }),
      localDate: LOCAL_DATE,
      recordedAt: AT,
      roomId: 'room-1',
      xpAwarded: 30,
    });
  });

  it('coerces a negative or non-finite XP amount to zero', () => {
    expect((note('room-1', 'clear-1', -50) as StatisticsNoteSubmissionEvent).xpAwarded).toBe(0);
    expect((note('room-1', 'clear-1', Number.NaN) as StatisticsNoteSubmissionEvent).xpAwarded).toBe(0);
    expect((xpEvent(Number.POSITIVE_INFINITY, ['x']) as StatisticsXpAwardEvent).amount).toBe(0);
  });
});

describe('recording is idempotent', () => {
  it('records an event once and suppresses a repeat of the same identity', () => {
    const event = note('room-1', 'clear-abc');
    const first = decideStatisticsEvent({ extraFields: undefined, event });
    expect(first.outcome).toBe('recorded');
    expect(first.ledger.events).toHaveLength(1);

    const repeat = decideStatisticsEvent({ extraFields: writeStatisticsEventLedgerToFields(undefined, first.ledger), event });
    expect(repeat.outcome).toBe('already-recorded');
    // The suppressed decision returns the ledger it *read back*, holding the one event - so
    // a caller that writes it back preserves what was there rather than replacing it with an
    // empty ledger. Reference identity is deliberately not asserted: the ledger travels through
    // JSON in a real record, so object identity is not a property anything can rely on.
    expect(repeat.ledger.events).toHaveLength(1);
    expect(repeat.ledger.events[0].eventId).toBe(first.ledger.events[0].eventId);
  });

  it('records a second room as a second event and leaves the first in place', () => {
    const one = decideStatisticsEvent({ extraFields: undefined, event: note('room-1', 'clear-a') });
    const two = decideStatisticsEvent({
      extraFields: writeStatisticsEventLedgerToFields(undefined, one.ledger),
      event: note('room-2', 'clear-b'),
    });
    expect(two.outcome).toBe('recorded');
    expect(two.ledger.events).toHaveLength(2);
    // Newest first, so a reader that takes the first entry takes the most recent.
    expect(two.ledger.events.map((event) => (event.kind === 'note-submission' ? event.roomId : null))).toEqual([
      'room-2',
      'room-1',
    ]);
  });

  it('records a re-award of the same room as a new event, because the generation changed', () => {
    const first = decideStatisticsEvent({ extraFields: undefined, event: note('room-1', 'clear-generation-1') });
    const rewritten = decideStatisticsEvent({
      extraFields: writeStatisticsEventLedgerToFields(undefined, first.ledger),
      event: note('room-1', 'clear-generation-2'),
    });
    expect(rewritten.outcome).toBe('recorded');
    expect(rewritten.ledger.events).toHaveLength(2);
  });

  it('`recordStatisticsEvent` itself is a no-op for a repeat', () => {
    const event = note('room-1', 'clear-abc');
    const once = recordStatisticsEvent(emptyStatisticsEventLedger(), event);
    const twice = recordStatisticsEvent(once, event);
    expect(twice).toBe(once);
    expect(hasStatisticsEvent(twice, event.eventId)).toBe(true);
  });

  it('keeps note, review, fish, and XP events distinguishable', () => {
    let fields: Record<string, unknown> | undefined;
    for (const event of [note('room-1', 'clear-a'), review('room-1', 1), fish('moss-carp', 1), xpEvent(31, ['room:room-1', 'clear:clear-a'])]) {
      const decision = decideStatisticsEvent({ extraFields: fields, event });
      fields = writeStatisticsEventLedgerToFields(fields, decision.ledger);
    }
    const ledger = readStatisticsEventLedgerFromFields(fields);
    expect(countEventsOfKind(ledger, 'note-submission')).toBe(1);
    expect(countEventsOfKind(ledger, 'review-completion')).toBe(1);
    expect(countEventsOfKind(ledger, 'fishing-outcome')).toBe(1);
    expect(countEventsOfKind(ledger, 'xp-award')).toBe(1);
    expect(totalXpAwarded(ledger)).toBe(31);
  });
});

describe('the ledger survives untrusted restored input', () => {
  it('reads an empty ledger from anything it does not recognise', () => {
    for (const hostile of [undefined, null, 7, 'ledger', [], { version: 99 }, { events: 'nope' }]) {
      expect(readStatisticsEventLedger(hostile)).toEqual(emptyStatisticsEventLedger());
    }
    expect(readStatisticsEventLedger({ events: {} }).events).toEqual([]);
  });

  it('drops an entry with no usable identity, rather than counting it', () => {
    const ledger = readStatisticsEventLedger({
      version: 1,
      events: [
        { kind: 'note-submission', eventId: '', localDate: LOCAL_DATE, roomId: 'r1' },
        { kind: 'note-submission', eventId: 'sevt-1', localDate: '', roomId: 'r1' },
        { kind: 'note-submission', eventId: 'sevt-2', localDate: LOCAL_DATE },
        { kind: 'not-a-kind', eventId: 'sevt-3', localDate: LOCAL_DATE },
        { kind: 'note-submission', eventId: 'sevt-4', localDate: LOCAL_DATE, roomId: 'r-kept' },
      ],
    });
    expect(ledger.events).toEqual([
      { kind: 'note-submission', eventId: 'sevt-4', localDate: LOCAL_DATE, recordedAt: '', roomId: 'r-kept', xpAwarded: 0 },
    ]);
  });

  it('drops a review entry with no usable pass number, because the pass is part of its identity', () => {
    const ledger = readStatisticsEventLedger({
      events: [
        { kind: 'review-completion', eventId: 'sevt-a', localDate: LOCAL_DATE, roomId: 'r1', passNumber: 0 },
        { kind: 'review-completion', eventId: 'sevt-b', localDate: LOCAL_DATE, roomId: 'r1', passNumber: -3 },
        { kind: 'review-completion', eventId: 'sevt-c', localDate: LOCAL_DATE, roomId: 'r1', passNumber: 2.9 },
      ],
    });
    expect(ledger.events.map((event) => (event.kind === 'review-completion' ? event.passNumber : null))).toEqual([2]);
  });

  it('drops a fish entry with no usable catalogue id, context, or cast', () => {
    const ledger = readStatisticsEventLedger({
      events: [
        { kind: 'fishing-outcome', eventId: 'a', localDate: LOCAL_DATE, catalogId: '', contextId: 'c', castNumber: 1 },
        { kind: 'fishing-outcome', eventId: 'b', localDate: LOCAL_DATE, catalogId: 'x', contextId: '', castNumber: 1 },
        { kind: 'fishing-outcome', eventId: 'c', localDate: LOCAL_DATE, catalogId: 'x', contextId: 'c', castNumber: 0 },
        { kind: 'fishing-outcome', eventId: 'd', localDate: LOCAL_DATE, catalogId: 'x', contextId: 'c', castNumber: 1 },
      ],
    });
    expect(ledger.events.map((event) => (event.kind === 'fishing-outcome' ? event.eventId : null))).toEqual(['d']);
  });

  it('drops an XP event with an unrecognised source', () => {
    const ledger = readStatisticsEventLedger({
      events: [
        { kind: 'xp-award', eventId: 'a', localDate: LOCAL_DATE, source: 'mining', amount: 10 },
        { kind: 'xp-award', eventId: 'b', localDate: LOCAL_DATE, source: 'fishing-outcome', amount: 10 },
      ],
    });
    expect(ledger.events.map((event) => (event.kind === 'xp-award' ? event.eventId : null))).toEqual(['b']);
  });

  it('clamps a hostile negative or non-finite amount instead of letting it into a total', () => {
    const ledger = readStatisticsEventLedger({
      events: [
        { kind: 'xp-award', eventId: 'a', localDate: LOCAL_DATE, source: 'note-submission', amount: -500 },
        { kind: 'xp-award', eventId: 'b', localDate: LOCAL_DATE, source: 'note-submission', amount: 'lots' },
        { kind: 'xp-award', eventId: 'c', localDate: LOCAL_DATE, source: 'note-submission', amount: 25 },
      ],
    });
    // 0 + 0 + 25: never negative, never NaN, so a total built from it is always a number.
    expect(totalXpAwarded(ledger)).toBe(25);
  });

  it('stamps the version it read, so a reader can refuse an envelope it does not know', () => {
    const ledger = readStatisticsEventLedger({ version: 999, events: [note('r', 'c')] });
    expect(ledger.version).toBe(STATISTICS_EVENT_LEDGER_VERSION);
    // The events survive, because an unrecognised *envelope version* does not make the
    // entries unreadable; refusing them would under-report rather than protect.
    expect(ledger.events).toHaveLength(1);
  });

  it('reads the ledger back out of the preserved-field carrier', () => {
    const decision = decideStatisticsEvent({ extraFields: undefined, event: note('room-1', 'clear-a') });
    const fields = writeStatisticsEventLedgerToFields(undefined, decision.ledger);
    expect(Object.keys(fields)).toEqual([STATISTICS_EVENT_LEDGER_KEY]);
    expect(readStatisticsEventLedgerFromFields(fields).events).toHaveLength(1);
    expect(readStatisticsEventLedgerFromFields(undefined).events).toEqual([]);
    expect(readStatisticsEventLedgerFromFields({ [STATISTICS_EVENT_LEDGER_KEY]: 'rubbish' }).events).toEqual([]);
  });
});

describe('writing the ledger preserves every other preserved app-owned field', () => {
  it('carries the other three ledgers and an unknown field through untouched', () => {
    const preserved = {
      [ROOM_CLEAR_REWARD_LEDGER_KEY]: { version: 1, entries: [{ roomId: 'r', clearIdentity: 'c', awardedAt: AT }] },
      [REVIEW_PASS_REWARD_LEDGER_KEY]: { version: 1, entries: [{ roomId: 'r', passNumber: 1, reviewIdentity: 'x', awardedAt: AT }] },
      [CATCH_REWARD_LEDGER_KEY]: { version: 1, entries: [{ catchIdentity: 'k' }] },
      [INTERRUPTED_REVIEW_SESSION_KEY]: { roomId: 'r' },
      fixtureUnknownField: { marker: 'synthetic-phase18-unknown' },
    };
    const decision = decideStatisticsEvent({ extraFields: preserved, event: note('room-1', 'clear-a') });
    const fields = writeStatisticsEventLedgerToFields(preserved, decision.ledger);
    expect(Object.keys(fields).sort()).toEqual(Object.keys(preserved).concat(STATISTICS_EVENT_LEDGER_KEY).sort());
    // Both sides widened: a literal's inferred type has no index signature, and indexing it
    // with a runtime key is exactly the case this assertion is about.
    const readBack: Record<string, unknown> = fields;
    const before: Record<string, unknown> = preserved;
    for (const key of Object.keys(before)) {
      expect(readBack[key], key).toEqual(before[key]);
    }
  });

  it('adds the key to an absent carrier without inventing a value', () => {
    const fields = writeStatisticsEventLedgerToFields(undefined, emptyStatisticsEventLedger());
    expect(fields[STATISTICS_EVENT_LEDGER_KEY]).toEqual(emptyStatisticsEventLedger());
  });
});

describe('the reads over a ledger', () => {
  function ledgerOf(events: readonly StatisticsEvent[]) {
    return readStatisticsEventLedger({ events });
  }

  it('filters by kind, newest first', () => {
    const ledger = ledgerOf([fish('lunar-trout', 1), note('room-2', 'clear-b'), review('room-2', 1), note('room-1', 'clear-a')]);
    expect(eventsOfKind(ledger, 'note-submission')).toHaveLength(2);
    expect(countEventsOfKind(ledger, 'note-submission')).toBe(2);
    expect(countEventsOfKind(ledger, 'fishing-outcome')).toBe(1);
    expect(countEventsOfKind(ledger, 'review-completion')).toBe(1);
    expect(countEventsOfKind(ledger, 'xp-award')).toBe(0);
  });

  it('reports distinct rooms per kind, not the number of events', () => {
    // One room reviewed three times is one room - which is the room-level metric the plan
    // names, as distinct from "how many reviews".
    // Newest first, so the first-seen room is the most recently reviewed one.
    const ledger = ledgerOf([review('room-2', 1), review('room-1', 1), review('room-1', 2), review('room-1', 3)]);
    expect(distinctReviewRooms(ledger)).toEqual(['room-2', 'room-1']);
    expect(distinctNoteRooms(ledgerOf([note('r1', 'c1'), note('r1', 'c2')]))).toEqual(['r1']);
  });

  it('reports distinct catalogue ids, newest first', () => {
    const ledger = ledgerOf([fish('moss-carp', 1), fish('lunar-trout', 1), fish('moss-carp', 2)]);
    expect(distinctFishingCatalogIds(ledger)).toEqual(['moss-carp', 'lunar-trout']);
    expect(distinctFishingCatalogIds(ledger)).toHaveLength(2);
  });

  it('sums the XP events, which is the authoritative XP total for a subject', () => {
    const ledger = ledgerOf([xpEvent(25, ['a']), xpEvent(6, ['b']), xpEvent(5, ['c'])]);
    expect(totalXpAwarded(ledger)).toBe(36);
    // The `xpAwarded` field on a note or review event is deliberately **not** summed here:
    // two answers to one question is the duplication the plan forbids, and the `xp-award`
    // event is the one that is written under the same identity.
    expect(totalXpAwarded(ledgerOf([note('r', 'c', 900)]))).toBe(0);
  });

  it('lists the active days ascending, de-duplicated', () => {
    const ledger = ledgerOf([
      toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c1' }, localDate: '2026-06-05', recordedAt: AT, xpAwarded: 1 }),
      toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c2' }, localDate: '2026-06-03', recordedAt: AT, xpAwarded: 1 }),
      toNoteSubmissionEvent({ subjectId: SUBJECT, identity: { roomId: 'r', clearIdentity: 'c3' }, localDate: '2026-06-05', recordedAt: AT, xpAwarded: 1 }),
    ]);
    expect(activeDateKeys(ledger)).toEqual(['2026-06-03', '2026-06-05']);
  });
});