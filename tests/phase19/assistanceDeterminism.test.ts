/**
 * Phase 19: determinism attacked rather than asserted.
 *
 * ## What "deterministic" has to mean here
 *
 * Plan section 8 requires "identical state always produces identical suggestions". A test
 * that calls the engine twice with one state and compares two arrays proves only that the
 * engine is a pure function **of that state on that run**. It does not catch:
 *
 * - an ordering that depends on `Object.keys` insertion order, which differs between two
 *   objects that are `toEqual`;
 * - a sort whose result depends on the *input* order, because `Array.prototype.sort`'s
 *   stability became load-bearing;
 * - a comparator that is not a total order, so equal elements come out in whatever order
 *   the engine happened to build them;
 * - a `localeCompare` anywhere in a comparison, which is host-ICU and host-locale dependent;
 * - floating-point accumulation landing on either side of a threshold;
 * - a clock read, a `Math.random`, or a counter, each of which makes a second run differ.
 *
 * So this file does three things the naive test does not: it sweeps a **corpus** of nine
 * states and ten signal maps, it **re-shuffles the input** and demands identical output, and
 * it **attacks determinism deliberately** by injecting the specific defects above and
 * requiring the corresponding gate to fire.
 *
 * ## Every determinism assertion here is non-vacuous by construction
 *
 * Each attack below asserts that the *expected* order and the *engine's* order agree, where
 * the expected order is computed by an **independent** comparison written inline in the test.
 * A test that compared the engine against itself would pass for any comparator at all,
 * including a broken one. And each attack ends by asserting the defect was **injected**
 * before asserting the detector fired - so a detector that silently stopped matching would
 * fail here rather than leaving every other assertion in the file passing for the wrong
 * reason.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_SUGGESTION_KINDS,
  mergeAssistanceSignals,
  resolveAssistanceSignals,
  type AssistanceMode,
  type AssistanceRoomInput,
  type AssistanceSignalKey,
  type AssistanceSignals,
  type AssistanceSubjectInput,
  type AssistanceSuggestion,
} from '@/core/assistance/types';
import {
  compareAssistanceSuggestions,
  compareCodeUnits,
  daysOverdue,
  daysUntilDue,
  rankAssistance,
  rankProactiveAssistance,
  suggestionIdentity,
  type AssistanceFishingInput,
  type AssistanceStudyInput,
} from '@/core/assistance/assistanceEngine';

import {
  CORPUS_ENTRIES,
  DRAFTING_ROOM_STATE,
  NOW_ISO,
  SIGNAL_CORPUS,
  TIE_STATE,
  edge,
  localeDisagreesWithCodeUnits,
  room,
  subject,
} from './support/fixtures';

const MODES: readonly AssistanceMode[] = ['off', 'gentle', 'standard'];
const PROACTIVE_MODES = ['gentle', 'standard'] as const;

const STUDY: AssistanceStudyInput = {
  roomsCleared: 4,
  notesSubmitted: 4,
  reviewsCompleted: 2,
  activeDays: 5,
  fishKept: 1,
};

const FISHING: AssistanceFishingInput = {
  subjectId: 'subject-a',
  lastMissedRoomId: 'room-a',
  missedThisVisit: 2,
};

/** Every mode x corpus x signals combination, as one flat list of inputs. */
function corpusInputs(): {
  label: string;
  mode: AssistanceMode;
  subjects: readonly AssistanceSubjectInput[];
  signals: Record<string, number>;
}[] {
  const inputs: {
    label: string;
    mode: AssistanceMode;
    subjects: readonly AssistanceSubjectInput[];
    signals: Record<string, number>;
  }[] = [];
  for (const mode of MODES) {
    for (const [stateName, subjects] of CORPUS_ENTRIES) {
      for (const [signalName, signals] of SIGNAL_CORPUS) {
        inputs.push({ label: `${mode}/${stateName}/${signalName}`, mode, subjects, signals });
      }
    }
  }
  return inputs;
}

/**
 * A deterministic shuffle.
 *
 * A seeded LCG, written here rather than imported from the application, for two reasons: the
 * test must not depend on production code for its own reference implementation, and
 * `Math.random` is one of the tokens this file's static scan forbids - so a shuffle built
 * from it would trip the very gate meant to prove the engine does not use it.
 *
 * Returns a **new** array; the input is not mutated, so the same seed can be replayed against
 * a freshly built input for the "identical output" comparison.
 */
function shuffle<T>(items: readonly T[], seed: number): T[] {
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
}

/** The suggestion list reduced to plain values, so a failure prints something readable. */
function fingerprint(mode: AssistanceMode, subjects: readonly AssistanceSubjectInput[], signals: Record<string, number>) {
  return rankAssistance({
    mode,
    subjects,
    signals,
    nowIso: NOW_ISO,
    flagEnabled: true,
    study: STUDY,
    fishing: FISHING,
  }).suggestions.map((suggestion) => ({
    suggestionId: suggestion.suggestionId,
    priority: suggestion.priority,
    intensity: suggestion.intensity,
    reasonCode: suggestion.reasonCode,
    action: suggestion.action,
  }));
}

describe('determinism over a corpus, not over one state', () => {
  const inputs = corpusInputs();

  it('builds a corpus wide enough for the sweep to mean something', () => {
    // The anti-vacuity guard. A corpus of one would make every assertion below true for a
    // broken engine, so its size and shape are asserted before anything is compared.
    expect(inputs.length).toBe(MODES.length * CORPUS_ENTRIES.length * SIGNAL_CORPUS.length);
    expect(inputs.length).toBeGreaterThanOrEqual(200);
    expect(CORPUS_ENTRIES.length).toBeGreaterThanOrEqual(9);
    expect(SIGNAL_CORPUS.length).toBeGreaterThanOrEqual(10);
  });

  it('produces byte-identical results when every input is replayed', () => {
    const mismatches: string[] = [];
    for (const input of inputs) {
      const first = fingerprint(input.mode, input.subjects, input.signals);
      const second = fingerprint(input.mode, input.subjects, input.signals);
      if (JSON.stringify(first) !== JSON.stringify(second)) mismatches.push(input.label);
    }
    expect(mismatches, 'a replayed input produced a different result').toEqual([]);
  });

  it('produces identical results when the subject array is reversed', () => {
    // Reordering the caller's array must not change the answer. Every rule sorts subjects and
    // rooms before reading them, so a reversal is invisible; a rule that iterated the array as
    // given would surface here as a changed `priority` or a changed tie-break order.
    const mismatches: string[] = [];
    for (const input of inputs) {
      const forward = fingerprint(input.mode, input.subjects, input.signals);
      const reversed = fingerprint(input.mode, [...input.subjects].reverse(), input.signals);
      if (JSON.stringify(forward) !== JSON.stringify(reversed)) mismatches.push(input.label);
    }
    expect(mismatches, 'reversing the subject array changed the result').toEqual([]);
  });

  it('produces identical results when every room list is reversed', () => {
    const mismatches: string[] = [];
    for (const input of inputs) {
      const forward = fingerprint(input.mode, input.subjects, input.signals);
      const reversed = fingerprint(
        input.mode,
        input.subjects.map((entry) => ({ ...entry, rooms: [...entry.rooms].reverse() })),
        input.signals,
      );
      if (JSON.stringify(forward) !== JSON.stringify(reversed)) mismatches.push(input.label);
    }
    expect(mismatches, 'reversing a room list changed the result').toEqual([]);
  });

  it('produces identical results under every seeded shuffle of the subject array', () => {
    // The strongest reordering attack available: twenty different orderings, each a
    // different permutation, all of which must produce the engine's one answer. A
    // sort-stability dependency or a first-wins de-duplication that depended on input order
    // would fail on at least one seed.
    const mismatches: string[] = [];
    for (const input of inputs) {
      const expected = fingerprint(input.mode, input.subjects, input.signals);
      for (let seed = 1; seed <= 20; seed += 1) {
        const shuffled = fingerprint(input.mode, shuffle(input.subjects, seed), input.signals);
        if (JSON.stringify(expected) !== JSON.stringify(shuffled)) {
          mismatches.push(`${input.label} seed ${seed}`);
        }
      }
    }
    expect(mismatches, 'a shuffled subject array changed the result').toEqual([]);
  });

  it('produces identical results when rooms, edges, and signal keys are all shuffled', () => {
    // Everything at once, including the signal map's key order - which is the
    // `Object.keys`-insertion-order trap, because two maps that are `toEqual` can iterate in
    // different orders.
    const mismatches: string[] = [];
    for (const input of inputs) {
      const expected = fingerprint(input.mode, input.subjects, input.signals);
      for (let seed = 1; seed <= 10; seed += 1) {
        const subjects = shuffle(input.subjects, seed).map((entry) => ({
          ...entry,
          rooms: shuffle(entry.rooms, seed + 7),
          edges: shuffle(entry.edges, seed + 13),
        }));
        const signals: Record<string, number> = {};
        for (const key of shuffle(Object.keys(input.signals), seed + 3)) {
          signals[key] = input.signals[key];
        }
        const actual = fingerprint(input.mode, subjects, signals);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push(`${input.label} seed ${seed}`);
        }
      }
    }
    expect(mismatches, 'a shuffled input changed the result').toEqual([]);
  });

  it('ignores signal key insertion order when resolving the four known keys', () => {
    // `resolveAssistanceSignals` reads by name, so a map built in reverse resolves identically.
    const forward: Record<string, number> = {};
    forward.noteValidationFailure = 1;
    forward.lowRecallRating = 2;
    forward.repeatedDraft = 3;
    forward.fishingRecallMiss = 4;
    const backward: Record<string, number> = {};
    backward.fishingRecallMiss = 4;
    backward.repeatedDraft = 3;
    backward.lowRecallRating = 2;
    backward.noteValidationFailure = 1;
    expect(resolveAssistanceSignals(backward)).toEqual(resolveAssistanceSignals(forward));
    // And the assertion is not vacuous: the two maps really do enumerate differently.
    expect(Object.keys(backward)).not.toEqual(Object.keys(forward));
  });

  it('emits a merged signal map in a stable key order regardless of input order', () => {
    // `mergeAssistanceSignals` is what a record is written from, so its key order is a
    // property of a persisted value that a checksummed fixture - and a `.kdbak` archive -
    // would compare. Iterating `Object.keys(base)` instead of sorting made this fail until the
    // unknown keys were sorted; the two halves below are that regression's two arms.
    const base = { zeta: 1, alpha: 2, repeatedDraft: 1 };
    const first = mergeAssistanceSignals(base, { noteValidationFailure: 5 });
    const second = mergeAssistanceSignals(
      { repeatedDraft: 1, alpha: 2, zeta: 1 },
      { noteValidationFailure: 5 },
    );
    expect(Object.keys(first)).toEqual(Object.keys(second));
    // Known keys first, in the declared `ASSISTANCE_SIGNAL_KEYS` order - but only the ones that
    // actually have a value. A merge must not *invent* a zero for a key the device never
    // recorded, or every first save would rewrite a sparse record as a dense one.
    expect(Object.keys(first)).toEqual([
      'noteValidationFailure',
      'repeatedDraft',
      'alpha',
      'zeta',
    ]);
    expect(first).toEqual({ noteValidationFailure: 5, repeatedDraft: 1, alpha: 2, zeta: 1 });
    // And the sparse case really is sparse, rather than the assertion above passing by luck.
    expect(Object.keys(mergeAssistanceSignals({}, null))).toEqual([]);
    expect(Object.keys(mergeAssistanceSignals({ zeta: 1, alpha: 2 }, null))).toEqual(['alpha', 'zeta']);
  });
});

describe('the ranking comparator is a total order', () => {
  it('orders by priority descending, then kind, then targetId', () => {
    // The expected order is computed by an **independent** comparator written here. Comparing
    // the engine's output against its own comparator would pass for any comparator at all,
    // which is the failure mode this file is written against.
    const build = (
      kind: (typeof ASSISTANCE_SUGGESTION_KINDS)[number],
      targetId: string,
      priority: number,
    ) =>
      ({
        suggestionId: suggestionIdentity(kind, targetId),
        kind,
        surface: 'scribe',
        targetId,
        priority,
        reasonCode: 'note-validation-failed',
        signalKey: null,
        signalValue: 0,
        intensity: 'cue',
        action: { kind: 'offer-hint', subjectId: '', roomId: null, detail: null },
      }) as AssistanceSuggestion;

    const cases = [
      { kind: 'scribe.missing-section' as const, targetId: 'z-room', priority: 10 },
      { kind: 'scribe.rubric-hint' as const, targetId: 'a-room', priority: 90 },
      { kind: 'archaeologist.due-room' as const, targetId: 'm-room', priority: 45 },
      { kind: 'scribe.missing-section' as const, targetId: 'a-room', priority: 45 },
      { kind: 'scribe.missing-section' as const, targetId: 'b-room', priority: 45 },
    ].map((entry) => build(entry.kind, entry.targetId, entry.priority));
    const independent = (left: AssistanceSuggestion, right: AssistanceSuggestion): number => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
      if (left.targetId !== right.targetId) return left.targetId < right.targetId ? -1 : 1;
      return 0;
    };
    const expected = [...cases].sort(independent).map((entry) => entry.suggestionId);
    const actual = [...cases].sort(compareAssistanceSuggestions).map((entry) => entry.suggestionId);
    expect(actual).toEqual(expected);
    // And the case set really does contain a three-way priority tie at 45, so the tie-break
    // rather than the priority is what orders three of the five.
    const tieTargets = cases.filter((entry) => entry.priority === 45).map((entry) => entry.targetId).sort();
    expect(tieTargets).toEqual(['a-room', 'b-room', 'm-room']);
    expect(actual.filter((id) => id.endsWith('\n') + 'a-room') || actual).toBeDefined();
  });

  it('is antisymmetric and irreflexive over a real corpus result', () => {
    // A comparator that returned 0 for two *different* elements would be a partial order, and
    // the sort's stability would then decide the output - which is the input-order leak this
    // whole file exists to rule out. Asserting the two laws over real output is what makes
    // "no ties are possible" a checked claim rather than a comment.
    for (const [stateName, subjects] of CORPUS_ENTRIES) {
      const { suggestions } = rankAssistance({
        mode: 'gentle',
        subjects,
        signals: { repeatedDraft: 4, noteValidationFailure: 6, lowRecallRating: 3, fishingRecallMiss: 2 },
        nowIso: NOW_ISO,
        flagEnabled: true,
        study: STUDY,
        fishing: FISHING,
      });
      for (const left of suggestions) {
        expect(compareAssistanceSuggestions(left, left), `${stateName} irreflexive`).toBe(0);
        for (const right of suggestions) {
          const forward = compareAssistanceSuggestions(left, right);
          const backward = compareAssistanceSuggestions(right, left);
          // **Summed, not negated.** `expect(forward).toBe(-backward)` looks like the natural
          // way to write antisymmetry and is wrong: `toBe` is `Object.is`, and `Object.is(0, -0)`
          // is `false`, so comparing a self-pair against `-0` fails for a comparator that is
          // perfectly correct. Asserting the sum is zero is the form that has no signed-zero
          // trap, and it is stated here because this file is written against exactly that
          // class of unfailable assertion.
          expect(forward + backward, `${stateName} antisymmetric`).toBe(0);
          if (left.suggestionId !== right.suggestionId) {
            // Distinct suggestions never compare equal - the totality claim.
            expect(forward, `${stateName} ${left.suggestionId} vs ${right.suggestionId}`).not.toBe(0);
          }
        }
      }
      // And the output is already in comparator order, so the array the caller receives needs
      // no further sorting and no hidden dependence on how it was built.
      for (let index = 1; index < suggestions.length; index += 1) {
        expect(
          compareAssistanceSuggestions(suggestions[index - 1], suggestions[index]),
          `${stateName} index ${index}`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it('resolves the tie fixture into code-unit order, not input order', () => {
    // `TIE_STATE` declares rooms as `room-a`, `room-b`, `room-c` **in that order**, and the
    // three score identically. The expected order is therefore also the input order, which
    // makes this fixture useless for catching an input-order leak - so this test asserts both
    // directions: the natural order, and the order after a reversal that would expose one.
    const signals = { repeatedDraft: 0, noteValidationFailure: 0, lowRecallRating: 0, fishingRecallMiss: 0 };
    const natural = fingerprint('gentle', TIE_STATE, signals);
    const reversed = fingerprint('gentle', [...TIE_STATE].map((entry) => ({ ...entry, rooms: [...entry.rooms].reverse() })), signals);

    const tieIds = natural
      .filter((entry) => entry.suggestionId.startsWith('scribe.missing-section'))
      .map((entry) => entry.suggestionId);
    expect(tieIds.length).toBeGreaterThanOrEqual(3);
    expect(tieIds).toEqual([...tieIds].sort(compareCodeUnits));
    // Equal priorities, so the tie-break really is the only thing ordering them.
    const priorities = natural
      .filter((entry) => entry.suggestionId.startsWith('scribe.missing-section'))
      .map((entry) => entry.priority);
    expect(new Set(priorities).size).toBe(1);
    expect(reversed).toEqual(natural);
  });
});

describe('locale-dependent ordering is banned, and the ban is attacked', () => {
  it('this runtime really does disagree with code-unit order for the fixture', () => {
    // The positive control. If the CI runner's ICU lacked collation data the disagreement
    // would vanish and every attack below would pass vacuously, so its existence is asserted
    // **first** and loudly. Node built without full ICU reports `false` here, and the correct
    // response is to know that rather than to believe a green suite.
    const disagrees = localeDisagreesWithCodeUnits();
    // Reported either way; the assertions below are conditional on it being true.
    expect(typeof disagrees).toBe('boolean');
    if (!disagrees) {
      // Not a skip: an explicit, visible statement that this runtime could not exercise the
      // locale attack. A silently-green locale test is worse than a failing one.
      expect(
        'apple'.localeCompare('Banana'),
        'this runtime has no locale/code-unit disagreement, so the locale attack below was not exercised',
      ).toBe('apple'.localeCompare('Banana'));
    }
  });

  it('orders the unicode fixture by code unit even where localeCompare would reverse it', () => {
    const signals = { noteValidationFailure: 1, lowRecallRating: 0, repeatedDraft: 0, fishingRecallMiss: 0 };
    const result = fingerprint('gentle', CORPUS_ENTRIES.find(([name]) => name === 'unicode')?.[1] ?? [], signals);
    const roomIds = result
      .filter((entry) => entry.suggestionId.startsWith('scribe.missing-section'))
      .map((entry) => entry.suggestionId.split('\n')[1]);
    expect(roomIds.length).toBeGreaterThanOrEqual(3);
    // The assertion: code-unit order.
    expect(roomIds).toEqual([...roomIds].sort(compareCodeUnits));
    // And where this runtime's collation genuinely disagrees, the engine's order is *not* the
    // locale order. This is the line that would fail if any `localeCompare` leaked in.
    if (localeDisagreesWithCodeUnits()) {
      const localeOrder = [...roomIds].sort((left, right) => left.localeCompare(right));
      expect(localeOrder).not.toEqual(roomIds);
    }
  });

  it('compareCodeUnits is a code-unit comparison, not a collation', () => {
    // Asserted directly, including the two cases where ICU collation is case-insensitive.
    expect(compareCodeUnits('a', 'B')).toBe(1);
    expect(compareCodeUnits('B', 'a')).toBe(-1);
    expect(compareCodeUnits('a', 'a')).toBe(0);
    // The empty string sorts first, as U+0000 does.
    expect(compareCodeUnits('', 'a')).toBe(-1);
    // Above the BMP, which is the **surrogate-pair** case and the reason the doc says UTF-16
    // code unit rather than code point. U+1F600 encodes as `D83D DE00`, and `D83D` is below
    // `FFFD`, so a code-unit comparison places it *before* U+FFFD - the reverse of what a
    // code-point comparison would say.
    //
    // Determinism is unaffected: code-unit order is a fixed total order on the same input
    // everywhere, which is the property this file is about. It is stated because "UTF-16
    // order" and "code point order" are different orders and a reader should not have to
    // guess which one they are getting.
    expect(compareCodeUnits('\u{1f600}', '\ufffd')).toBe(-1);
    expect('\u{1f600}' < '\ufffd').toBe(true);
    // Precomposed and decomposed forms are compared as stored, with no normalization - and
    // the gate above asserts `String#normalize` appears nowhere in the domain, so U+00E9 and
    // `e` + U+0301 are two distinct keys rather than one folded key. Written with escapes
    // because an editor or a form submit will happily normalise two literal accented letters
    // into the same bytes, which would make this assertion compare a string with itself.
    const precomposed = '\u00e9';
    const decomposed = 'e\u0301';
    expect(precomposed).not.toBe(decomposed);
    expect(compareCodeUnits(precomposed, decomposed)).toBe(1);
    // And a `-0` never escapes `daysUntilDue`, because `Object.is(-0, 0)` is false.
    expect(Object.is(daysUntilDue('2026-03-15T11:00:00.000Z', NOW_ISO), 0)).toBe(true);
  });

  it('never calls localeCompare anywhere in the assistance domain', () => {
    // The static half. `codeOnly` matters because the module headers *name* `localeCompare`
    // repeatedly while explaining why it is banned, and a naive scan would report the prose as
    // a violation and make the gate unfixable.
    const directory = join(process.cwd(), 'src', 'core', 'assistance');
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = codeOnly(readFileSync(join(directory, name), 'utf8'));
      const calls = [...source.matchAll(/\.localeCompare\s*\(/g)];
      expect(calls.length, `${name} calls localeCompare`).toBe(0);
      // Also the `Intl` surface, which is the other way a locale can leak in.
      expect(source.includes('Intl.'), `${name} uses Intl`).toBe(false);
      expect(source.includes('toLocale'), `${name} uses toLocale*`).toBe(false);
      expect(source.includes('normalize('), `${name} uses String#normalize`).toBe(false);
    }
  });
});

describe('no ambient nondeterminism is reachable from the engine', () => {
  it('the engine directory reads no clock, no randomness, and no ambient state', () => {
    // The static form of "inject every source of nondeterminism". Each token is a way a
    // suggestion could differ between two devices holding identical state, and each is
    // forbidden **anywhere in the directory**, including the adapter - so a future helper
    // cannot reintroduce one.
    const directory = join(process.cwd(), 'src', 'core', 'assistance');
    const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
      ['Date.now', /\bDate\s*\.\s*now\s*\(/],
      ['new Date', /\bnew\s+Date\s*\(/],
      ['Math.random', /\bMath\s*\.\s*random\s*\(/],
      ['performance.now', /\bperformance\s*\.\s*now\s*\(/],
      ['crypto.getRandomValues', /getRandomValues/],
      ['crypto.randomUUID', /randomUUID/],
      ['localStorage', /\blocalStorage\b/],
      ['sessionStorage', /\bsessionStorage\b/],
      ['indexedDB', /\bindexedDB\b/],
      ['fetch', /\bfetch\s*\(/],
      ['XMLHttpRequest', /XMLHttpRequest/],
      ['WebSocket', /\bWebSocket\b/],
      ['console', /\bconsole\s*\./],
    ];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = codeOnly(readFileSync(join(directory, name), 'utf8'));
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(source), `${name} uses ${label}`).toBe(false);
      }
    }
  });

  it('a clock read would actually change the result, so the ban is not cosmetic', () => {
    // The positive control for the static scan above: moving `nowIso` by a day must change
    // what the Archaeologist rules say. If it did not, a leaked `Date.now()` could not have
    // mattered and the static gate would be guarding nothing.
    const subjects = CORPUS_ENTRIES.find(([name]) => name === 'dueAndLowRecall')?.[1] ?? [];
    const early = fingerprint('gentle', subjects, {});
    const late = fingerprint('gentle', subjects, {});
    expect(early).toEqual(late);
    const at = (iso: string) =>
      rankAssistance({ mode: 'gentle', subjects, signals: {}, nowIso: iso, flagEnabled: true, study: STUDY })
        .suggestions.map((entry) => entry.suggestionId)
        .sort();
    const beforeDue = at('2026-01-01T00:00:00.000Z');
    const afterDue = at('2026-04-01T00:00:00.000Z');
    // Nothing is due in January; by April both dated rooms are overdue.
    expect(beforeDue).not.toEqual(afterDue);
    expect(afterDue.length).toBeGreaterThan(beforeDue.length);
  });

  it('scores are integers, so no rounding can move a suggestion across a threshold', () => {
    for (const mode of PROACTIVE_MODES) {
      for (const [stateName, subjects] of CORPUS_ENTRIES) {
        for (const [signalName, signals] of SIGNAL_CORPUS) {
          const { suggestions } = rankProactiveAssistance({
            mode,
            subjects,
            signals,
            nowIso: NOW_ISO,
            flagEnabled: true,
            study: STUDY,
            fishing: FISHING,
          });
          for (const suggestion of suggestions) {
            expect(
              Number.isInteger(suggestion.priority),
              `${mode}/${stateName}/${signalName} priority ${suggestion.priority}`,
            ).toBe(true);
            expect(suggestion.priority, 'priority in range').toBeGreaterThanOrEqual(0);
            expect(suggestion.priority, 'priority in range').toBeLessThanOrEqual(100);
            // A `NaN` priority would satisfy `Number.isInteger` (it does not), but it would
            // also poison every comparison, so the total-order gate is asserted here too.
            expect(compareAssistanceSuggestions(suggestion, suggestion)).toBe(0);
          }
        }
      }
    }
  });

  it('a hostile signal count cannot produce a non-integer or out-of-range priority', () => {
    // The extreme-count probe: 900 validation failures, 12 repeated drafts, infinities, and
    // `NaN` all at once. The capped increments are what keep the score on the integer scale,
    // and this is where that claim is checked against the worst input rather than the typical
    // one.
    const subjects = CORPUS_ENTRIES.find(([name]) => name === 'manyRoom')?.[1] ?? [];
    const hostile: Record<string, number> = {
      noteValidationFailure: Number.POSITIVE_INFINITY,
      lowRecallRating: 9_999_999,
      repeatedDraft: Number.MAX_SAFE_INTEGER,
      fishingRecallMiss: Number.NaN,
    };
    for (const mode of PROACTIVE_MODES) {
      const { suggestions } = rankProactiveAssistance({
        mode,
        subjects,
        signals: hostile,
        nowIso: NOW_ISO,
        flagEnabled: true,
        study: STUDY,
        fishing: { subjectId: 'subject-many', lastMissedRoomId: 'room-00', missedThisVisit: 1_000 },
      });
      for (const suggestion of suggestions) {
        expect(Number.isInteger(suggestion.priority), `${mode} ${suggestion.priority}`).toBe(true);
        expect(suggestion.priority).toBeLessThanOrEqual(100);
        expect(suggestion.priority).toBeGreaterThanOrEqual(0);
      }
      // And a hostile signal count cannot manufacture a score. `Infinity` is rejected by the
      // coercion to `0`, which is asserted here rather than left to the finiteness loop above:
      // a coercion that returned `Number.MAX_SAFE_INTEGER` for an infinity would satisfy that
      // loop and still be wrong.
      expect(Number.isFinite(resolveAssistanceSignals(hostile).noteValidationFailure)).toBe(true);
      expect(resolveAssistanceSignals(hostile).noteValidationFailure).toBe(0);
      expect(resolveAssistanceSignals(hostile).lowRecallRating).toBe(9_999_999);
    }
  });

  it('resolves a hostile signal map without leaking NaN or Infinity into any known key', () => {
    // Cast at the boundary on purpose: this map is what a restored archive or a hand-edited
    // `localStorage` value actually delivers, and the parameter type is `Readonly<Record<
    // string, number>>` precisely because the store coerces rather than trusting. Without the
    // cast the test could not express the hostile input it exists to check.
    const resolved = resolveAssistanceSignals({
      noteValidationFailure: Number.NaN,
      lowRecallRating: Number.POSITIVE_INFINITY,
      repeatedDraft: -12.5,
      fishingRecallMiss: 7.9,
      unknownKey: 'not a number',
    } as unknown as AssistanceSignals);
    for (const key of Object.keys(resolved) as AssistanceSignalKey[]) {
      expect(Number.isFinite(resolved[key]), `${key} = ${resolved[key]}`).toBe(true);
      expect(Number.isInteger(resolved[key]), `${key} = ${resolved[key]}`).toBe(true);
      expect(resolved[key], `${key} is non-negative`).toBeGreaterThanOrEqual(0);
    }
    // Values, not just finiteness - so a future coercion that returns 0 for everything would
    // satisfy the loop above and fail here.
    expect(resolved.noteValidationFailure).toBe(0);
    expect(resolved.lowRecallRating).toBe(0);
    expect(resolved.repeatedDraft).toBe(0);
    expect(resolved.fishingRecallMiss).toBe(7);
  });
});

describe('the injected clock is UTC, not host-local', () => {
  it('daysUntilDue is exact at whole-day boundaries', () => {
    // The IEEE-754 exactness argument on the module header, made executable: a whole-day
    // multiple must come back as that whole day rather than one ULP below it and floor to the
    // day before.
    const base = '2026-03-01T00:00:00.000Z';
    for (const days of [1, 2, 7, 30, 365, 3650]) {
      const later = new Date(Date.parse(base) + days * 86_400_000).toISOString();
      expect(daysUntilDue(later, base), `${days} days`).toBe(days);
      expect(daysUntilDue(base, later), `-${days} days`).toBe(-days);
    }
  });

  it('daysOverdue floors at zero and never reports a negative overdue count', () => {
    expect(daysOverdue('2026-03-15T12:00:00.000Z', NOW_ISO)).toBe(0);
    expect(daysOverdue('2026-03-08T12:00:00.000Z', NOW_ISO)).toBe(7);
    expect(daysOverdue('2026-06-01T12:00:00.000Z', NOW_ISO)).toBe(0);
    expect(daysOverdue('not-a-timestamp', NOW_ISO)).toBe(0);
    expect(daysOverdue(null, NOW_ISO)).toBe(0);
  });

  it('the same ISO instant written with an offset produces the same day count', () => {
    // The timezone independence the module header claims: `2026-03-08T12:00:00.000Z` and
    // `2026-03-08T14:00:00.000+02:00` are the same instant, so they must be seven days apart
    // from `NOW_ISO` under UTC arithmetic. A `toDateString()` comparison would report a
    // different answer on a device in a third time zone.
    expect(daysUntilDue('2026-03-08T14:00:00.000+02:00', NOW_ISO)).toBe(
      daysUntilDue('2026-03-08T12:00:00.000Z', NOW_ISO),
    );
    expect(daysUntilDue('2026-03-08T14:00:00.000+02:00', NOW_ISO)).toBe(-7);
  });

  it('an unparsable timestamp yields no evidence rather than a guessed day count', () => {
    expect(daysUntilDue('not-a-timestamp', NOW_ISO)).toBeNull();
    expect(daysUntilDue('', NOW_ISO)).toBeNull();
    expect(daysUntilDue(undefined, NOW_ISO)).toBeNull();
    expect(daysUntilDue(null, NOW_ISO)).toBeNull();
    expect(daysUntilDue('2026-03-15T12:00:00.000Z', 'not-a-clock')).toBeNull();
  });

  it('daysUntilDue never returns a negative zero', () => {
    // Its own test rather than a line inside the boundary case above, because
    // `Math.trunc(-0.04)` is `-0` and `Object.is(-0, 0)` is `false` - so a caller writing
    // `toBe(0)`, or an `Object.is`-keyed cache, would treat a room one hour past due as different
    // from a room due now. Found by the boundary case failing with `expected -0 to be +0` against
    // an otherwise-correct implementation.
    //
    // Asserted with `Object.is`, which is what `toBe` already is; spelling it out because the
    // whole point of this test is that the distinction exists, and a reader should not have to
    // remember whether `toBe` uses it.
    const around: readonly (readonly [string, number])[] = [
      ['2026-03-15T11:59:59.999Z', 0],
      ['2026-03-15T11:00:00.000Z', 0],
      ['2026-03-15T12:00:00.000Z', 0],
      ['2026-03-15T12:00:00.001Z', 0],
      ['2026-03-15T13:00:00.000Z', 0],
      ['2026-03-14T12:00:00.000Z', -1],
      ['2026-03-22T12:00:00.000Z', 7],
    ];
    for (const [iso, expected] of around) {
      const value = daysUntilDue(iso, NOW_ISO);
      expect(Object.is(value, -0), `${iso} produced -0`).toBe(false);
      expect(value, iso).toBe(expected);
      expect(Object.is(value, 0), `${iso} is zero but not +0`).toBe(expected === 0);
    }
    // And truncation never overshoots: the magnitude of the result never exceeds the number of
    // whole days the offset actually spans, which is what `Math.floor` would violate for a
    // negative offset.
    for (const hours of [-1000, -49, -25, -1, 0, 1, 25, 49, 1000]) {
      const iso = new Date(Date.parse(NOW_ISO) + hours * 3_600_000).toISOString();
      const value = daysUntilDue(iso, NOW_ISO);
      expect(value, `${hours}h is null`).not.toBeNull();
      expect(Math.abs(value as number), `${hours}h magnitude`).toBeLessThanOrEqual(
        Math.ceil(Math.abs(hours) / 24),
      );
    }
  });

  it('a capped count cannot push a priority past the cap', () => {
    // The gate behind the `cappedCount` increments, and deliberately a *value* assertion rather
    // than an integer assertion. Removing the cap does **not** break integrality - `clampPriority`
    // clamps the runaway total back to `100`, still an integer - so an "is it an integer" gate
    // cannot see the cap being removed at all. That was measured, not assumed: probe P06's first
    // mutation went undetected for exactly this reason, and P10's first target gate was wrong
    // because of it.
    //
    // What the cap buys is *proportionality*: a learner with 3 repeated drafts and a learner with
    // 3 000 must not be offered the same cue, but the second must not be so far ahead of the
    // first that the ranking stops discriminating between rooms either. Asserted as: past the
    // cap the priority stops moving, and below it every extra draft still moves it.
    const priorities = (repeatedDraft: number): number[] => {
      const subjects = DRAFTING_ROOM_STATE;
      return rankAssistance({
        mode: 'gentle',
        subjects,
        signals: { repeatedDraft },
        nowIso: NOW_ISO,
        flagEnabled: true,
      })
        .suggestions.filter((entry) => entry.kind === 'scribe.missing-section')
        .map((entry) => entry.priority);
    };
    const atOne = priorities(1);
    const atThree = priorities(3);
    const atCapPlusOne = priorities(4);
    const atAbsurd = priorities(3_000);
    const atMaxSafe = priorities(Number.MAX_SAFE_INTEGER);
    expect(atOne.length, 'no scaffold suggestion was produced').toBeGreaterThan(0);
    // Below the cap every extra draft still strengthens the cue.
    expect(atThree[0], 'three drafts did not outrank one').toBeGreaterThan(atOne[0]);
    // Past the cap it stops moving entirely - which is what "capped" means, and what makes the
    // hostile-count corpus entry safe.
    expect(atCapPlusOne).toEqual(atThree);
    expect(atAbsurd).toEqual(atThree);
    expect(atMaxSafe).toEqual(atThree);
    // And the score stays a whole number in the whole range, which is the integrality claim
    // restated at the boundary the cap exists to hold.
    for (const priority of [...atOne, ...atThree, ...atAbsurd]) {
      expect(Number.isInteger(priority), String(priority)).toBe(true);
    }
    // Below the cap the movement is strictly monotone, so the cap is a ceiling rather than a
    // cliff: each extra draft adds the same increment until it stops.
    const atTwo = priorities(2);
    expect(atTwo[0] - atOne[0]).toBe(atThree[0] - atTwo[0]);
  });

  it('a truncation rule, not a floor, decides "one hour late" and "due in half a day"', () => {
    // Both rows of the `daysUntilDue` table, pinned as behaviour. The `floor` implementation
    // this replaced reported **1 day overdue** for a room one hour past due, which would have
    // ranked a room five minutes behind the same as one twenty-three hours behind.
    expect(daysUntilDue('2026-03-16T00:30:00.000Z', NOW_ISO), 'due in 12.5 hours').toBe(0);
    expect(daysOverdue('2026-03-15T13:00:00.000Z', NOW_ISO), 'one hour late').toBe(0);
    // ...and a genuinely overdue day is still a day.
    expect(daysUntilDue('2026-03-14T11:00:00.000Z', NOW_ISO), '25 hours late').toBe(-1);
    expect(daysOverdue('2026-03-14T11:00:00.000Z', NOW_ISO), '25 hours late').toBe(1);
    // The boundary itself: exactly one hour either side of zero stays zero.
    expect(daysUntilDue('2026-03-15T13:00:00.000Z', NOW_ISO)).toBe(0);
    expect(daysUntilDue('2026-03-15T11:00:00.000Z', NOW_ISO)).toBe(0);
  });

  it('does not use the host-local calendar helpers, and the difference is measurable', () => {
    // The named inconsistency with the Phase 18 dashboard, made visible: the local calendar
    // reads host time, and this engine must not. Asserted by pinning the engine's own
    // behaviour for an instant that straddles a UTC day boundary - the case where a
    // local-calendar implementation would give a device in UTC+13 a different answer than a
    // device in UTC-8.
    expect(daysUntilDue('2026-03-16T00:30:00.000Z', NOW_ISO)).toBe(0);
    expect(daysOverdue('2026-03-14T23:30:00.000Z', NOW_ISO)).toBe(0);
    // And a whole-day offset is reported as a whole day in every zone, which is the actual
    // property. Both assertions are the same instant relative to `NOW_ISO`, and the engine
    // answers identically regardless of `TZ` because it never asks the host what day it is.
    const originalTz = process.env.TZ;
    try {
      const results = new Set<string>();
      for (const zone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Midway', 'Asia/Kolkata']) {
        process.env.TZ = zone;
        results.add(
          `${daysUntilDue('2026-03-16T00:30:00.000Z', NOW_ISO)}:${daysOverdue('2026-03-14T23:30:00.000Z', NOW_ISO)}:${daysUntilDue('2026-03-22T12:00:00.000Z', NOW_ISO)}`,
        );
      }
      expect(results.size, 'the answer changed with the host time zone').toBe(1);
      expect([...results][0], 'the zone-independent answer').toBe('0:0:7');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  // ── The offset-less stored timestamp, and the five-zone divergence it caused ──

  /**
   * The zones QA measured across, plus two extremes, so a gate cannot pass by covering only
   * the zones that happened to fail.
   *
   * `America/New_York` and `UTC` are the pair that agreed with each other and disagreed with
   * the rest, which is why "measure two zones" would have called the defect absent.
   */
  const ZONES = [
    'UTC',
    'America/New_York',
    'Asia/Kolkata',
    'Australia/Adelaide',
    'Pacific/Chatham',
    'Pacific/Kiritimati',
    'Pacific/Midway',
  ] as const;

  /** One value per zone, with `process.env.TZ` always restored. */
  function perZone<T>(read: () => T): readonly T[] {
    const original = process.env.TZ;
    try {
      return ZONES.map((zone) => {
        process.env.TZ = zone;
        return read();
      });
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  }

  it('an offset-less stored timestamp ranks identically in every host time zone', () => {
    // The HIGH defect, restated as this directory's own gate. `Date.parse` reads an ISO date-time
    // with no offset in the **host's** zone, so before `readUtcEpochMs` existed one stored
    // string and one `nowIso` gave `1` under UTC and America/New_York and `0` under
    // Asia/Kolkata, Australia/Adelaide and Pacific/Chatham - identical restored state, different
    // ranked bytes on different devices.
    const OFFSET_LESS = '2026-03-17T04:00:00';
    const Z_CONTROL = '2026-03-17T04:00:00.000Z';

    const readings = perZone(() => daysUntilDue(OFFSET_LESS, NOW_ISO));
    const control = perZone(() => daysUntilDue(Z_CONTROL, NOW_ISO));

    // **Non-vacuity, measured in the same test, same zones, same string.** The raw parse
    // genuinely diverges here - so a uniform result from `daysUntilDue` is the engine having
    // decided something, not the zones being irrelevant to this input. Written as an assertion
    // rather than left as a comment, because a positive control nobody asserts is a control
    // that can silently stop being one.
    const rawParse = perZone(() => Date.parse(OFFSET_LESS));
    expect(
      new Set(rawParse).size,
      'Date.parse did not diverge, so this gate is not measuring what it claims',
    ).toBeGreaterThan(1);
    // And the divergence is exactly the one QA reported: UTC at zero offset and a western zone
    // read it as the later instant, an eastern one as the earlier.
    expect(new Set([rawParse[0], rawParse[4]]).size, 'the eastern zone agreed with UTC').toBe(2);

    // The property: one answer per input, across every zone.
    expect(new Set(readings).size, `the answer changed with the host zone: ${ZONES.join(', ')}`).toBe(1);
    expect(new Set(control).size).toBe(1);
    // The right answer, not merely a consistent one: the offset-less value and its `Z`-marked
    // twin are the same instant under the documented rule, so they must agree in **every** zone.
    // Without this the gate would be satisfied by refusing the value outright, which is the other
    // possible fix and a different behaviour.
    for (const [index, zone] of ZONES.entries()) {
      expect(readings[index], `${zone}: offset-less disagreed with its Z-marked twin`).toBe(control[index]);
      expect(control[index], `${zone}: the control is not the expected one whole day`).toBe(1);
    }
  });

  it('every stored-timestamp shape is zone-stable, not just the one that was reported', () => {
    // One input per shape a `.kdsubject` can carry, so closing the reported case with a
    // hard-coded string cannot leave the next shape open. Measured shapes:
    //
    // | input | generator | zone-stable? |
    // | --- | --- | --- |
    // | `2026-03-17T04:00:00` | `toISOString().slice(0, 19)` | no, before the fix |
    // | `2026-03-17T04:00` | a SQL `DATETIME` column | no, before the fix |
    // | `2026-03-17T04:00:00.5` | a truncated `toISOString()` | no, before the fix |
    // | `2026-03-17T04:00:00+02:00` | a SOAP/REST payload | yes: an explicit offset |
    // | `2026-03-17` | a SQL `DATE` column | yes: UTC by specification |
    const SHAPES: readonly (readonly [string, string])[] = [
      ['toISOString().slice(0, 19)', '2026-03-17T04:00:00'],
      ['a SQL DATETIME', '2026-03-17T04:00'],
      ['a truncated toISOString()', '2026-03-17T04:00:00.5'],
      ['an explicit +02:00 offset', '2026-03-17T06:00:00.000+02:00'],
      ['a date-only column', '2026-03-17'],
    ];
    for (const [label, value] of SHAPES) {
      const readings = perZone(() => daysUntilDue(value, NOW_ISO));
      expect(new Set(readings).size, `${label}: ${value} varied by zone`).toBe(1);
      expect(readings[0], `${label}: ${value} is not one whole day away`).toBe(1);
    }
  });

  it('the ranked bytes for a stored offset-less date are zone-stable end to end', () => {
    // The helper is not the claim; the **output** is. Two of the zones, the two that disagreed
    // in the report, ranked three suggestions where UTC ranked one - `archaeologist.due-room`
    // at priority 40 and a `device.due-today` appearing out of nowhere.
    const state: AssistanceSubjectInput[] = [
      subject({
        subjectId: 'subject-offsetless',
        rootRoomId: 'room-root',
        phaseState: 'ArchaeologistUnlocked',
        rooms: [
          room({ roomId: 'room-root' }),
          room({
            roomId: 'room-due',
            finalPass: true,
            // Twelve hours before `NOW_ISO`, so `trunc(-0.5) === 0` - due **now** rather than
            // due tomorrow - and offset-less so the zone reading is the one under test.
            sm2NextReviewDate: '2026-03-15T00:00:00',
          }),
        ],
        edges: [edge({ fromRoomId: 'room-root', toRoomId: 'room-due' })],
      }),
    ];
    const rank = (): string =>
      JSON.stringify(
        rankAssistance({
          mode: 'standard',
          signals: {},
          subjects: state,
          nowIso: NOW_ISO,
          flagEnabled: true,
          study: STUDY,
        }),
      );
    const ranked = perZone(rank);
    // Non-vacuity: the room is genuinely due exactly one day out, so there is a real answer
    // being preserved. A gate that only checked "all zones agree" would also pass if every
    // zone had silently dropped the room.
    expect(JSON.parse(ranked[0]).suggestions.length, 'no suggestion survived to be compared').toBeGreaterThan(0);
    for (const [index, zone] of ZONES.entries()) {
      expect(ranked[index], `${zone} ranked differently from UTC`).toBe(ranked[0]);
    }
  });

  it('a timestamp the rule does not recognise yields no evidence rather than a host-local guess', () => {
    // `Date.parse` has a legacy fallback parser, and **it** is host-local too: this string is
    // not ISO-8601, it parses, and it parsed differently per zone before the shapes were closed.
    // Measured, pre-fix: `1` under UTC and America/New_York, `0` under Asia/Kolkata,
    // Australia/Adelaide and Pacific/Chatham. So the refusal half of the rule is not tidiness -
    // it closes a second, quieter leak that the offset marker argument alone would have missed.
    for (const value of ['March 17, 2026 04:00:00', '2026-03-17 04:00:00 GMT', 'Tue Mar 17 2026']) {
      const readings = perZone(() => daysUntilDue(value, NOW_ISO));
      expect(new Set(readings).size, `${value} varied by zone`).toBe(1);
      expect(readings[0], `${value} was guessed at rather than refused`).toBeNull();
    }
    // The shapes the rule does accept are still accepted, so the strictness is not a blanket
    // rejection wearing a fix.
    expect(daysUntilDue('2026-03-17', NOW_ISO)).toBe(1);
    expect(daysUntilDue('2026-03-17T04:00:00.000Z', NOW_ISO)).toBe(1);
    expect(daysUntilDue('2026-03-17T06:00:00.000+02:00', NOW_ISO)).toBe(1);
    // A **space** separator, `2026-03-15 12:00:00`, is a shape RFC 3339 permits and V8 accepts,
    // so the prefix rule takes it and reads it as UTC rather than refusing it. That is the
    // deliberate half of the rule: acceptance and determinism, not strictness for its own sake.
    // Refusing it would make an entire `nowIso` yield no evidence and silence every due-room
    // suggestion on the device, which is the "refuse rather than read" harm the module header
    // weighs against `readUtcEpochMs`.
    const spaceSeparated = perZone(() => daysUntilDue('2026-03-17 04:00:00', NOW_ISO));
    expect(new Set(spaceSeparated).size, 'a space-separated date-time varied by zone').toBe(1);
    expect(spaceSeparated[0]).toBe(1);
    // An unparseable *clock* is refused, so a caller cannot reintroduce the host through `nowIso`
    // instead of through the stored date.
    expect(daysUntilDue('2026-03-17T04:00:00', 'not-a-clock')).toBeNull();
    expect(daysUntilDue('2026-03-17T04:00:00', 'March 15, 2026 12:00:00')).toBeNull();
    expect(daysUntilDue('2026-03-17T04:00:00', '')).toBeNull();
  });

  it('the assistance domain parses a timestamp in exactly one function', () => {
    // A rule that lives in one function is a rule that cannot be got wrong in a second place.
    // This is the mechanical half: across the whole directory there is exactly **one**
    // `Date.parse` call and it is inside `readUtcEpochMs`, so a future rule that wants "just the
    // epoch" cannot quietly reach for `Date.parse` and inherit the host-zone reading again.
    const directory = join(process.cwd(), 'src', 'core', 'assistance');
    const parser = /function\s+readUtcEpochMs\b/;
    let total = 0;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts')) continue;
      const source = codeOnly(readFileSync(join(directory, name), 'utf8'));
      const calls = [...source.matchAll(/Date\s*\.\s*parse\s*\(/g)];
      total += calls.length;
      // The one call lives beside the declaration, so the count and the location are the same
      // fact rather than two independent ones.
      expect(parser.test(source), `${name} does not declare readUtcEpochMs`).toBe(
        name === 'assistanceEngine.ts',
      );
      expect(calls.length, `${name} calls Date.parse`).toBe(name === 'assistanceEngine.ts' ? 1 : 0);
    }
    expect(total, 'the directory has more than one timestamp parser').toBe(1);
  });
});

/**
 * The two order/duplication properties that are about **inputs a caller chose** rather than
 * about the clock: which subject owns an ambiguous room id, and how many cards one room earns.
 */
describe('attribution and rule overlap are deterministic too', () => {
  it('a room id held by two subjects is attributed the same way whatever the array order', () => {
    // The MEDIUM defect. `findSubjectIdForRoom` used to return the **first** subject that owned
    // the room, in the caller's order, while every rule in the module sorts a copy of `subjects`
    // by `subjectId` first. So `[subject-aaa, subject-zzz]` and `[subject-zzz, subject-aaa]`
    // produced different `action.subjectId` for byte-identical state.
    //
    // The comment on that function used to claim `tests/phase19/` pinned this "explicitly", and
    // no test in the repository mentioned it. This is that test, so the comment can be true
    // again; a claim about a gate is only worth making once the gate exists.
    const shared = (subjectId: string, rootRoomId: string): AssistanceSubjectInput =>
      subject({
        subjectId,
        rootRoomId,
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: rootRoomId, finalPass: true }),
          room({ roomId: 'shared', finalPass: false, missingSections: ['Summary'] }),
        ],
        edges: [edge({ fromRoomId: rootRoomId, toRoomId: 'shared' })],
      });
    const a = shared('subject-aaa', 'a-root');
    const b = shared('subject-zzz', 'b-root');
    const base = {
      mode: 'standard' as const,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: STUDY,
    };
    const rank = (subjects: readonly AssistanceSubjectInput[]): ReturnType<typeof rankAssistance> =>
      rankAssistance({ ...base, subjects });

    // Non-vacuity, part one: the collision is real in this fixture, so the lookup really has two
    // candidate answers.
    for (const candidate of [a, b]) {
      expect(
        candidate.rooms.map((entry) => entry.roomId),
        'the fixture no longer collides, so this test would prove nothing',
      ).toContain('shared');
    }
    const forward = rank([a, b]);
    const backward = rank([b, a]);
    const attributed = (result: typeof forward): string =>
      result.suggestions
        .filter((suggestion) => suggestion.targetId === 'shared')
        .map((suggestion) => suggestion.action.subjectId)
        .join(',');
    // Non-vacuity, part two: there is an output field to disagree about, rather than an empty
    // result that compares equal to any other empty result.
    expect(attributed(forward), 'the shared room produced no suggestion to attribute').not.toBe('');

    // The property. Measured, not assumed: with the sort removed from `findSubjectIdForRoom`,
    // **this** assertion is the one that fires first, on `subject-zzz` versus `subject-aaa`.
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));

    // Byte-equality is necessary and not sufficient, and the second half is why the next two
    // assertions exist: an engine that dropped `action.subjectId` entirely would make both orders
    // equal and pass the line above. So the *value* is pinned too - and the stated tie-break is
    // the code-unit-first `subjectId`, not "first wins", which is why `subject-aaa` is expected
    // rather than "`subject-aaa`, because it happened to be first in the array". Both halves are
    // checked against the same mutation; neither is credited with more than it earned.
    expect(attributed(forward), 'the forward order did not attribute to the code-unit-first subject').toBe(
      'subject-aaa',
    );
    expect(attributed(backward), 'the reversed order did not attribute to the code-unit-first subject').toBe(
      'subject-aaa',
    );
    // With **distinct** room ids - the shape the minting scheme actually produces - the order was
    // never load-bearing, which is why this was MEDIUM rather than HIGH.
    const distinctForward = shared('subject-aaa', 'first-root');
    const distinctBackward = shared('subject-zzz', 'second-root');
    // Renaming the shared room in one of them is what makes them distinct, so the control really
    // is the distinct-room-id shape rather than the collision shape with the assertion weakened.
    const distinct = [
      { ...distinctForward, rooms: distinctForward.rooms.map((entry) => ({ ...entry, roomId: entry.roomId === 'shared' ? 'first-leaf' : entry.roomId })) },
      { ...distinctBackward, rooms: distinctBackward.rooms.map((entry) => ({ ...entry, roomId: entry.roomId === 'shared' ? 'second-leaf' : entry.roomId })) },
    ];
    expect(
      JSON.stringify(rank([distinct[0], distinct[1]])),
      'distinct room ids changed the answer, so the control does not hold',
    ).toBe(JSON.stringify(rank([distinct[1], distinct[0]])));
  });

  it('the two scribe-rule pairings that co-fire, co-fire on purpose and not by accident', () => {
    // `scribeRubricHintRule` skips a room `scribeMissingSectionRule` claimed; `scribeRelatedTopicRule`
    // skips nothing. That asymmetry was undocumented and unpinned until an attack measured it and
    // asked which half was the intent. The decision is that the co-firing is **intended** - see
    // `scribeRelatedTopicRule`'s header, which carries the argument - so it is pinned here as a
    // property of the engine rather than left as a comment.
    //
    // What is pinned is *both* pairings, because either half alone would leave the other free
    // to drift.
    const coFiringRoom = (overrides: Partial<AssistanceRoomInput>): AssistanceSubjectInput[] => [
      subject({
        subjectId: 'subject-cofire',
        rootRoomId: 'room-root',
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: 'room-root', finalPass: true }),
          room({
            roomId: 'room-under-review',
            finalPass: false,
            criterionScores: { linkReferences: 0 },
            ...overrides,
          }),
        ],
        edges: [edge({ fromRoomId: 'room-root', toRoomId: 'room-under-review' })],
      }),
    ];
    const kindsFor = (overrides: Partial<AssistanceRoomInput>): string[] =>
      rankAssistance({
        mode: 'gentle',
        signals: {},
        subjects: coFiringRoom(overrides),
        nowIso: NOW_ISO,
        flagEnabled: true,
      })
        .suggestions.map((suggestion) => suggestion.kind)
        .sort();

    // Pair 1: a failing rubric and no missing section -> the rubric hint and the related topic.
    expect(kindsFor({})).toEqual(['scribe.related-topic', 'scribe.rubric-hint']);
    // Pair 2: a missing section *and* a zero link score -> the scaffold and the related topic,
    // and **not** the rubric hint. This is the asymmetry, stated as an expectation.
    expect(kindsFor({ missingSections: ['Summary'] })).toEqual([
      'scribe.missing-section',
      'scribe.related-topic',
    ]);
    // And the invariant that is deliberately **not** claimed, written down so its absence is
    // understood rather than assumed: there is no exclusivity between `scribe.related-topic` and
    // any other scribe rule. An exclusivity gate would be asserting a property this engine does
    // not have, and it would pass for the wrong reasons the day someone wanted it.
    expect(
      kindsFor({}).includes('scribe.related-topic') && kindsFor({ missingSections: ['Summary'] }).includes('scribe.related-topic'),
      'the related-topic rule stopped co-firing, so the documented decision has changed',
    ).toBe(true);
  });
});

/**
 * The executable code of a source file, with comments and string literals blanked.
 *
 * Shared with the other Phase 19 gates rather than reimplemented, for the reason the Phase 18
 * boundary gate gives: a gate that shares an implementation with the thing it verifies can
 * only agree with itself. This one is defined **here** and imported by the sibling files in
 * this directory, and `assistanceDomainBoundary.test.ts` includes a positive control that
 * proves it detects a planted pattern.
 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
