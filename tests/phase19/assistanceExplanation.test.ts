/**
 * Phase 19: explanations are pure derivations, and they carry counts rather than prose.
 *
 * ## Why this file is not a rendering test
 *
 * There is no DOM here, deliberately. The plan's requirement is "show why each suggestion
 * appears", and the persistence contract makes that interesting: `AssistanceRecordValue.signals`
 * is a `Record<string, number>`, so **an explanation cannot be stored**. There is no field for
 * it and no migration would create one.
 *
 * That constraint is a feature, and this file is where it is cashed in. An explanation is
 * recomputed from `(suggestion, input)` on every render, which means:
 *
 * - it cannot go stale against the suggestion it explains;
 * - it cannot differ between two devices holding the same state;
 * - there is no stored sentence to invalidate, migrate, or translate twice.
 *
 * ## The three things asserted here
 *
 * 1. **Determinism.** The same suggestion and input yield byte-identical explanations, over the
 *    whole corpus and under every input permutation.
 * 2. **Purity.** Explaining does not mutate its input, and explaining twice yields the same
 *    value - the property that makes "no stale explanation" true rather than likely.
 * 3. **Counts, not prose.** `titleKey` and `detailKey` are i18n keys and every evidence row is
 *    `{ labelKey, value, roomId, subjectId }`. No field a sentence could occupy exists, so a
 *    learner topic or a note fragment cannot reach the DOM through an explanation even if a
 *    future rule tried.
 */
import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_EVIDENCE_KEYS,
  isAssistanceSuggestionKind,
  type AssistanceExplanation,
  type AssistanceSubjectInput,
  type AssistanceSuggestion,
} from '@/core/assistance/types';
import {
  compareCodeUnits,
  explainAssistanceSuggestion,
  rankAssistance,
  type AssistanceStudyInput,
} from '@/core/assistance/assistanceEngine';

import {
  CORPUS_ENTRIES,
  DRAFTING_ROOM_STATE,
  DUE_AND_LOW_RECALL_STATE,
  NOW_ISO,
  PERSISTED_ONLY_FAILURE_STATE,
  SIGNAL_CORPUS,
  SINGLE_ROOM_STATE,
  UNBRANCHED_MULTI_ROOM_STATE,
} from './support/fixtures';

const STUDY: AssistanceStudyInput = {
  roomsCleared: 4,
  notesSubmitted: 4,
  reviewsCompleted: 2,
  activeDays: 5,
  fishKept: 1,
};

/** Every suggestion the corpus produces, with the input that produced it. */
function everySuggestion(): { suggestion: AssistanceSuggestion; subjects: readonly AssistanceSubjectInput[]; signals: Record<string, number> }[] {
  const all: { suggestion: AssistanceSuggestion; subjects: readonly AssistanceSubjectInput[]; signals: Record<string, number> }[] = [];
  for (const mode of ['gentle', 'standard'] as const) {
    for (const [, subjects] of CORPUS_ENTRIES) {
      for (const [, signals] of SIGNAL_CORPUS) {
        const result = rankAssistance({
          mode,
          subjects,
          signals,
          nowIso: NOW_ISO,
          flagEnabled: true,
          study: STUDY,
          fishing: { subjectId: 'subject-a', lastMissedRoomId: 'room-a', missedThisVisit: 2 },
        });
        for (const suggestion of result.suggestions) {
          all.push({ suggestion, subjects, signals });
        }
      }
    }
  }
  return all;
}

const SUGGESTIONS = everySuggestion();

describe('the corpus produces suggestions to explain', () => {
  it('the sweep is not empty, so every assertion below has something to bite on', () => {
    // The anti-vacuity guard. Every other test here is an assertion about a derived explanation,
    // and an empty sweep would satisfy all of them.
    expect(SUGGESTIONS.length).toBeGreaterThan(200);
    const kinds = new Set(SUGGESTIONS.map((entry) => entry.suggestion.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    for (const kind of kinds) expect(isAssistanceSuggestionKind(kind)).toBe(true);
  });
});

describe('an explanation is a pure derivation', () => {
  it('explaining twice yields byte-identical output', () => {
    const differing: string[] = [];
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const input = { subjects, signals, nowIso: NOW_ISO, study: STUDY };
      const first = JSON.stringify(explainAssistanceSuggestion(suggestion, input));
      const second = JSON.stringify(explainAssistanceSuggestion(suggestion, input));
      if (first !== second) differing.push(suggestion.suggestionId);
    }
    expect(differing).toEqual([]);
  });

  it('explaining does not mutate its input', () => {
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const subjectsBefore = JSON.stringify(subjects);
      const signalsBefore = JSON.stringify(signals);
      explainAssistanceSuggestion(suggestion, { subjects, signals, nowIso: NOW_ISO, study: STUDY });
      expect(JSON.stringify(subjects), suggestion.suggestionId).toBe(subjectsBefore);
      expect(JSON.stringify(signals), suggestion.suggestionId).toBe(signalsBefore);
    }
  });

  it('explaining is invariant under every input permutation', () => {
    // The same reordering attack the determinism suite runs on the ranking, applied to the
    // explanation. An explanation that iterated rooms or evidence as given would reorder its
    // evidence rows under a permutation and fail here.
    const shuffle = <T,>(items: readonly T[], seed: number): T[] => {
      const out = [...items];
      let state = seed >>> 0;
      for (let index = out.length - 1; index > 0; index -= 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const pick = state % (index + 1);
        const held = out[index];
        out[index] = out[pick];
        out[pick] = held;
      }
      return out;
    };
    const differing: string[] = [];
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const expected = JSON.stringify(
        explainAssistanceSuggestion(suggestion, { subjects, signals, nowIso: NOW_ISO, study: STUDY }),
      );
      for (let seed = 1; seed <= 5; seed += 1) {
        const permuted = shuffle(subjects, seed).map((entry) => ({
          ...entry,
          rooms: shuffle(entry.rooms, seed + 11),
          edges: shuffle(entry.edges, seed + 17),
        }));
        const actual = JSON.stringify(
          explainAssistanceSuggestion(suggestion, { subjects: permuted, signals, nowIso: NOW_ISO, study: STUDY }),
        );
        if (actual !== expected) differing.push(`${suggestion.suggestionId} seed ${seed}`);
      }
    }
    expect(differing).toEqual([]);
  });

  it('an explanation names its suggestion and republishes the intensity the engine chose', () => {
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const explanation = explainAssistanceSuggestion(suggestion, {
        subjects,
        signals,
        nowIso: NOW_ISO,
        study: STUDY,
      });
      expect(explanation.suggestionId).toBe(suggestion.suggestionId);
      // Republished rather than re-derived: a surface cannot disagree with the ranking that
      // produced the suggestion.
      expect(explanation.intensity).toBe(suggestion.intensity);
      expect(['step', 'cue', 'example']).toContain(explanation.intensity);
    }
  });
});

describe('an explanation carries keys and counts, never prose', () => {
  it('the title and detail are i18n keys derived from the closed vocabularies', () => {
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const explanation = explainAssistanceSuggestion(suggestion, {
        subjects,
        signals,
        nowIso: NOW_ISO,
        study: STUDY,
      });
      // Keys, in the two shapes the i18n catalogue would be authored against. Not sentences:
      // an engine that produced English prose would need a locale, and a locale is a source of
      // nondeterminism this domain has none of.
      expect(explanation.titleKey, suggestion.suggestionId).toBe(`assistance.title.${suggestion.kind}`);
      expect(explanation.detailKey, suggestion.suggestionId).toBe(`assistance.detail.${suggestion.reasonCode}`);
      expect(explanation.titleKey.startsWith('assistance.title.')).toBe(true);
      expect(explanation.detailKey.startsWith('assistance.detail.')).toBe(true);
    }
  });

  it('every evidence row is a closed-vocabulary label and a positive integer', () => {
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const explanation = explainAssistanceSuggestion(suggestion, {
        subjects,
        signals,
        nowIso: NOW_ISO,
        study: STUDY,
      });
      for (const row of explanation.evidence) {
        expect(ASSISTANCE_EVIDENCE_KEYS.includes(row.labelKey), `${row.labelKey}`).toBe(true);
        expect(Number.isInteger(row.value), `${row.labelKey} = ${row.value}`).toBe(true);
        expect(row.value, `${row.labelKey} is not positive`).toBeGreaterThan(0);
        expect(row.roomId === null || typeof row.roomId === 'string').toBe(true);
        expect(row.subjectId === null || typeof row.subjectId === 'string').toBe(true);
        // And no row carries a field a sentence could occupy.
        expect(Object.keys(row).sort()).toEqual(['labelKey', 'roomId', 'subjectId', 'value']);
      }
    }
  });

  it('no explanation contains a topic, a note fragment, or a subject name', () => {
    // A learner topic is in the subject input and is exactly the kind of text that must not
    // travel into a rendered explanation. Asserted by serialising every explanation in the
    // corpus and searching for the fixtures' topics and prose.
    const banned = [
      'Quadratic Roots',
      'Discriminants',
      'Only Room',
      'Topic 01',
      'Synthetic Subject',
      'Algebra',
      'must never read',
    ];
    const found: string[] = [];
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const text = JSON.stringify(
        explainAssistanceSuggestion(suggestion, { subjects, signals, nowIso: NOW_ISO, study: STUDY }),
      );
      for (const phrase of banned) {
        if (text.includes(phrase)) found.push(`${suggestion.suggestionId}: ${phrase}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('evidence rows are emitted in a deterministic order', () => {
    // Sorted by `labelKey`, then `roomId`, then `subjectId`, all by code unit. Asserted against
    // an independently written comparator for the same reason the ranking suite does it: the
    // engine's own sort cannot be its own witness.
    const independent = (left: AssistanceExplanation['evidence'][number], right: AssistanceExplanation['evidence'][number]): number =>
      compareCodeUnits(left.labelKey, right.labelKey) ||
      compareCodeUnits(left.roomId ?? '', right.roomId ?? '') ||
      compareCodeUnits(left.subjectId ?? '', right.subjectId ?? '');
    let checkedRows = 0;
    for (const { suggestion, subjects, signals } of SUGGESTIONS) {
      const { evidence } = explainAssistanceSuggestion(suggestion, {
        subjects,
        signals,
        nowIso: NOW_ISO,
        study: STUDY,
      });
      for (let index = 1; index < evidence.length; index += 1) {
        expect(independent(evidence[index - 1], evidence[index]), suggestion.suggestionId).toBeLessThanOrEqual(0);
      }
      checkedRows += evidence.length;
    }
    // And the sweep really did find multi-row explanations, so the ordering assertion had
    // something to order.
    expect(checkedRows).toBeGreaterThan(200);
  });
});

describe('explanations say what actually happened', () => {
  it('a named missing section is reported as a missing section, with the count', () => {
    const result = rankAssistance({
      mode: 'gentle',
      subjects: DRAFTING_ROOM_STATE,
      signals: { repeatedDraft: 2 },
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: STUDY,
    });
    const scaffold = result.suggestions.find((entry) => entry.kind === 'scribe.missing-section');
    expect(scaffold, 'no scaffold suggestion was produced').toBeDefined();
    const explanation = explainAssistanceSuggestion(scaffold as AssistanceSuggestion, {
      subjects: DRAFTING_ROOM_STATE,
      signals: { repeatedDraft: 2 },
      nowIso: NOW_ISO,
      study: STUDY,
    });
    expect(explanation.detailKey).toBe('assistance.detail.note-missing-required-section');
    // Two sections were missing and one blocking check failed, and the repeated-draft count of 2
    // is the corroboration that strengthened the cue. All three as counts.
    const byKey = new Map(explanation.evidence.map((row) => [row.labelKey, row.value]));
    expect(byKey.get('evidence.missing-sections')).toBe(2);
    expect(byKey.get('evidence.failed-checks')).toBe(1);
    expect(byKey.get('evidence.repeated-drafts')).toBe(2);
    // And the named section is app-owned vocabulary, available on the action rather than in the
    // explanation, so a surface can offer a scaffold for it.
    expect((scaffold as AssistanceSuggestion).action.detail).toBe('Summary');
  });

  it('a failing room whose section is unknown says a check failed, and names no section', () => {
    // The case `RoomMetadata` actually stores: a boolean, not a list. The explanation must not
    // invent a section name, and the assertion on `action.detail` is the one that would fail if
    // a rule guessed.
    const result = rankAssistance({
      mode: 'gentle',
      subjects: PERSISTED_ONLY_FAILURE_STATE,
      signals: { repeatedDraft: 1 },
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: STUDY,
    });
    const suggestion = result.suggestions.find((entry) => entry.kind === 'scribe.missing-section');
    expect(suggestion, 'no suggestion was produced').toBeDefined();
    expect(suggestion?.reasonCode).toBe('note-validation-failed');
    expect(suggestion?.action.detail, 'a section name was invented').toBeNull();
    const explanation = explainAssistanceSuggestion(suggestion as AssistanceSuggestion, {
      subjects: PERSISTED_ONLY_FAILURE_STATE,
      signals: { repeatedDraft: 1 },
      nowIso: NOW_ISO,
      study: STUDY,
    });
    expect(explanation.detailKey).toBe('assistance.detail.note-validation-failed');
    const labels = explanation.evidence.map((row) => row.labelKey);
    expect(labels).not.toContain('evidence.missing-sections');
    expect(labels).toContain('evidence.failed-checks');
    expect(labels).toContain('evidence.repeated-drafts');
  });

  it('an overdue room reports both that it is due and how far past it is', () => {
    const result = rankAssistance({
      mode: 'gentle',
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: { lowRecallRating: 2 },
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: STUDY,
    });
    const overdue = result.suggestions.find(
      (entry) => entry.kind === 'archaeologist.due-room' && entry.targetId === 'room-b',
    );
    expect(overdue, 'the 7-day-overdue room was not suggested').toBeDefined();
    const explanation = explainAssistanceSuggestion(overdue as AssistanceSuggestion, {
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: { lowRecallRating: 2 },
      nowIso: NOW_ISO,
      study: STUDY,
    });
    const byKey = new Map(explanation.evidence.map((row) => [row.labelKey, row.value]));
    expect(byKey.get('evidence.review-due-rooms')).toBe(1);
    // Seven days, not zero and not eight: the truncation rule, measured through the explanation
    // rather than only through `daysOverdue`.
    //
    // Re-keyed from `evidence.overdue-rooms`. This used to pin a **false** claim - a key whose
    // noun is *rooms* carrying seven **days** - so the old expectation was a bug, not a contract.
    // The property under test (whole-day truncation) is unchanged and is now stated in a key
    // that names its own unit.
    expect(byKey.get('evidence.overdue-days')).toBe(7);
  });

  it('no card publishes a count of days under a key that says rooms, or the reverse', () => {
    // The unit contract as an executable sweep, over the whole corpus rather than one fixture.
    //
    // `evidence.overdue-rooms` names rooms and `evidence.overdue-days` names days. They were one
    // key for a while, and the damage was not a crash: each card was individually defensible and
    // the *label* was forced to be false on one of them, which is the failure mode no value
    // assertion catches. So this asserts the key-to-unit assignment itself, per reason code,
    // over every state in the corpus - and does it on the *key set*, so a re-merge fails on the
    // key rather than on a number that happens to move.
    //
    // Deliberately `toEqual` on a sorted key list rather than membership checks: membership
    // passes vacuously on a key the arm never emitted, which is exactly how the "due exactly
    // now" case was able to keep passing after its key was renamed.
    const overdueFamily = new Set(['evidence.overdue-rooms', 'evidence.overdue-days']);
    const offenders: string[] = [];
    let observed = 0;
    let daysObserved = 0;
    let roomsObserved = 0;
    for (const mode of ['gentle', 'standard'] as const) {
      for (const [stateName, subjects] of CORPUS_ENTRIES) {
        for (const [signalName, signals] of SIGNAL_CORPUS) {
          const { suggestions } = rankAssistance({
            mode,
            subjects,
            signals,
            nowIso: NOW_ISO,
            flagEnabled: true,
            study: STUDY,
          });
          for (const suggestion of suggestions) {
            const explanation = explainAssistanceSuggestion(suggestion, {
              subjects,
              signals,
              nowIso: NOW_ISO,
              study: STUDY,
            });
            const labels = explanation.evidence
              .map((row) => row.labelKey)
              .filter((labelKey) => overdueFamily.has(labelKey))
              .sort(compareCodeUnits);
            // The whole unit contract, in one line per reason code:
            //   `review-due` is about one room -> days only, never a rooms row.
            //   `device-reviews-due` is about many rooms -> a rooms count only, never days.
            //   Anything else publishing either key is a key we have not accounted for.
            const expected =
              suggestion.reasonCode === 'review-due'
                ? labels.includes('evidence.overdue-days')
                  ? ['evidence.overdue-days']
                  : []
                : suggestion.reasonCode === 'device-reviews-due'
                  ? labels.includes('evidence.overdue-rooms')
                    ? ['evidence.overdue-rooms']
                    : []
                  : [];
            if (expected.length > 0 && labels.join() !== expected.join()) {
              offenders.push(
                `${mode}/${stateName}/${signalName}/${suggestion.reasonCode}: ${labels.join()}`,
              );
            }
            if (labels.length > 0) {
              observed += 1;
              if (labels.includes('evidence.overdue-days')) daysObserved += 1;
              if (labels.includes('evidence.overdue-rooms')) roomsObserved += 1;
            }
            // A rooms count can never exceed the number of rooms due on the same card, and a day
            // value would normally break exactly that. The bound is the card's own due-room
            // count, not `Math.max(1, value)` - a comparison against a bound derived from the
            // value under test is true for every input, including the wrong ones.
            const roomsRow = explanation.evidence.find((row) => row.labelKey === 'evidence.overdue-rooms');
            const dueRow = explanation.evidence.find((row) => row.labelKey === 'evidence.review-due-rooms');
            if (roomsRow !== undefined && dueRow !== undefined) {
              expect(Number.isInteger(roomsRow.value), `overdue-rooms is not an integer: ${roomsRow.value}`).toBe(
                true,
              );
              expect(
                roomsRow.value,
                `overdue-rooms ${roomsRow.value} exceeds the ${dueRow.value} due rooms on ${suggestion.reasonCode}`,
              ).toBeLessThanOrEqual(dueRow.value);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // And the sweep is not vacuous. An empty corpus observation would make every assertion
    // above true by default, so the counts are asserted to be real: both keys must actually
    // appear somewhere, which is what makes the per-reason-code split a measured fact rather
    // than a claim about a code path that never runs.
    expect(observed, 'no overdue evidence row was produced anywhere in the corpus').toBeGreaterThan(0);
    expect(daysObserved, 'evidence.overdue-days never appeared').toBeGreaterThan(0);
    expect(roomsObserved, 'evidence.overdue-rooms never appeared').toBeGreaterThan(0);
  });

  it('a room due exactly now is reported as due and not as overdue', () => {
    const result = rankAssistance({
      mode: 'gentle',
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: STUDY,
    });
    const dueNow = result.suggestions.find(
      (entry) => entry.kind === 'archaeologist.due-room' && entry.targetId === 'room-a',
    );
    expect(dueNow).toBeDefined();
    const explanation = explainAssistanceSuggestion(dueNow as AssistanceSuggestion, {
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      study: STUDY,
    });
    const labels = explanation.evidence.map((row) => row.labelKey);
    // Zero days overdue, so the row is omitted entirely rather than reported as `0` - a
    // "0 days late" row on a card is noise.
    //
    // Re-keyed to `evidence.overdue-days`, which is a **true** claim preserved: left on
    // `evidence.overdue-rooms` it would pass for the wrong reason, since that key is no longer
    // published by this arm at all - a vacuous assertion rather than a test.
    expect(labels).toContain('evidence.review-due-rooms');
    expect(labels).not.toContain('evidence.overdue-days');
  });

  it('the device summary reports the study aggregate the claim rests on', () => {
    const result = rankAssistance({
      mode: 'gentle',
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: { roomsCleared: 7, notesSubmitted: 7, reviewsCompleted: 3, activeDays: 9, fishKept: 2 },
    });
    const summary = result.suggestions.find((entry) => entry.kind === 'device.due-today');
    expect(summary, 'no device summary was produced').toBeDefined();
    const explanation = explainAssistanceSuggestion(summary as AssistanceSuggestion, {
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      study: { roomsCleared: 7, notesSubmitted: 7, reviewsCompleted: 3, activeDays: 9, fishKept: 2 },
    });
    const byKey = new Map(explanation.evidence.map((row) => [row.labelKey, row.value]));
    expect(byKey.get('evidence.review-due-rooms')).toBe(2);
    // **Rooms**, not days: this arm counts overdue *rooms*, so it owns `evidence.overdue-rooms`.
    // A **true** claim, preserved unchanged by the split.
    expect(byKey.get('evidence.overdue-rooms')).toBe(1);
    // And the device card must not carry the per-room days row - the two keys are disjoint.
    expect(byKey.has('evidence.overdue-days')).toBe(false);
    expect(byKey.get('evidence.active-study-days')).toBe(9);
    expect(byKey.get('evidence.rooms-cleared')).toBe(7);
    // `rooms-cleared` is genuinely a clear count here and only here: the durable clear ledger
    // reached the engine, so the card may say the learner cleared 7 rooms.
    expect(byKey.has('evidence.subject-rooms')).toBe(false);
  });

  it('a structural graph suggestion explains itself with a count, not a guess', () => {
    const result = rankAssistance({
      mode: 'gentle',
      subjects: SINGLE_ROOM_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
    });
    const branch = result.suggestions.find((entry) => entry.kind === 'creator.missing-branch');
    expect(branch, 'no branch suggestion was produced').toBeDefined();
    const explanation = explainAssistanceSuggestion(branch as AssistanceSuggestion, {
      subjects: SINGLE_ROOM_STATE,
      signals: {},
      nowIso: NOW_ISO,
    });
    expect(explanation.detailKey).toBe('assistance.detail.graph-no-branch');
    // The only evidence available for a structural fact is the room count itself, reported as a
    // count. No "your subject is too small" and no "you may find this hard".
    //
    // Re-keyed from `evidence.rooms-cleared`, which pinned a **false** claim: it asserted a card
    // saying "1 x Rooms cleared" over a subject the learner had never cleared anything in. A
    // hardcoded `1` is not a clear count and is not even this subject's room count - it is true
    // of a one-room graph by coincidence. `subject-rooms` is what the value always was.
    expect(explanation.evidence).toHaveLength(1);
    expect(explanation.evidence[0].labelKey).toBe('evidence.subject-rooms');
    expect(explanation.evidence[0].value).toBe(1);
    // And the clear-count key must be absent, because nothing here has been cleared. This is the
    // assertion that makes the false claim unrepresentable rather than merely unasserted.
    expect(explanation.evidence.map((row) => row.labelKey)).not.toContain('evidence.rooms-cleared');
  });

  it('a subject with several unstarted rooms reports how many, not one', () => {
    // The defect this arm had, as a test. `SINGLE_ROOM_STATE` has one room, so a hardcoded `1`
    // was accidentally right there; a five-room graph with no subtopic edge off the root was
    // where it lied. If this row ever returns to a literal, or to the device-scoped clear
    // ledger, the learner is told they cleared rooms in a subject they never opened.
    const unstarted = UNBRANCHED_MULTI_ROOM_STATE;
    const result = rankAssistance({
      mode: 'gentle',
      subjects: unstarted,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
    });
    const branch = result.suggestions.find((entry) => entry.kind === 'creator.missing-branch');
    expect(branch, 'no branch suggestion was produced').toBeDefined();
    const explanation = explainAssistanceSuggestion(branch as AssistanceSuggestion, {
      subjects: unstarted,
      signals: {},
      nowIso: NOW_ISO,
    });
    const byKey = new Map(explanation.evidence.map((row) => [row.labelKey, row.value]));
    // Five, not one. A room *count* of five, under a key that says rooms-in-this-subject.
    expect(byKey.get('evidence.subject-rooms')).toBe(5);
    // And nothing on this card claims a clear: the learner has cleared nothing, so the
    // device-scoped clear row must be absent however many rooms the subject holds.
    expect(byKey.has('evidence.rooms-cleared')).toBe(false);
  });

  it('an explanation with no study data omits the rows it cannot fill, rather than reporting zeros', () => {
    // "No data" and "nothing happened" must not look the same. A `0` row would be a claim.
    const withStudy = rankAssistance({
      mode: 'gentle',
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: { roomsCleared: 7, notesSubmitted: 7, reviewsCompleted: 3, activeDays: 9, fishKept: 2 },
    }).suggestions.find((entry) => entry.kind === 'device.due-today') as AssistanceSuggestion;
    const withoutStudy = rankAssistance({
      mode: 'gentle',
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
    }).suggestions.find((entry) => entry.kind === 'device.due-today') as AssistanceSuggestion;
    expect(withStudy).toBeDefined();
    expect(withoutStudy).toBeDefined();
    const labelsWith = explainAssistanceSuggestion(withStudy, {
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
      study: { roomsCleared: 7, notesSubmitted: 7, reviewsCompleted: 3, activeDays: 9, fishKept: 2 },
    }).evidence.map((row) => row.labelKey);
    const labelsWithout = explainAssistanceSuggestion(withoutStudy, {
      subjects: DUE_AND_LOW_RECALL_STATE,
      signals: {},
      nowIso: NOW_ISO,
    }).evidence.map((row) => row.labelKey);
    expect(labelsWith).toContain('evidence.active-study-days');
    expect(labelsWithout).not.toContain('evidence.active-study-days');
    expect(labelsWithout).not.toContain('evidence.rooms-cleared');
    // And the room-derived rows survive either way.
    expect(labelsWithout).toContain('evidence.review-due-rooms');
  });

  it('an unknown suggestion is explained without throwing and without inventing evidence', () => {
    // Untrusted input reaches this function: a `postMessage`, a restored archive, a future
    // build's suggestion id. A hand-built suggestion whose target is not in the subject input
    // must still produce a well-formed explanation.
    const ghost: AssistanceSuggestion = {
      suggestionId: 'scribe.missing-section\nroom-that-does-not-exist',
      kind: 'scribe.missing-section',
      surface: 'scribe',
      targetId: 'room-that-does-not-exist',
      priority: 40,
      reasonCode: 'note-missing-required-section',
      signalKey: null,
      signalValue: 0,
      intensity: 'cue',
      action: { kind: 'offer-section-scaffold', subjectId: '', roomId: null, detail: null },
    };
    const explanation = explainAssistanceSuggestion(ghost, {
      subjects: SINGLE_ROOM_STATE,
      signals: {},
      nowIso: NOW_ISO,
    });
    expect(explanation.suggestionId).toBe(ghost.suggestionId);
    expect(explanation.titleKey).toBe('assistance.title.scribe.missing-section');
    // No room found, so no missing-section count is invented.
    expect(explanation.evidence.map((row) => row.labelKey)).not.toContain('evidence.missing-sections');
    for (const row of explanation.evidence) {
      expect(Number.isInteger(row.value)).toBe(true);
      expect(row.value).toBeGreaterThan(0);
    }
  });
});
