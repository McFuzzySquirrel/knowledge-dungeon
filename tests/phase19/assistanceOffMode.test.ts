/**
 * Phase 19: Off mode removes proactive suggestions **structurally**.
 *
 * ## Why this file exists rather than a line in the determinism suite
 *
 * "Off mode removes proactive suggestions" is the exit criterion most easily satisfied by a
 * lie. A list that is filtered to empty at the end of the pipeline satisfies every observable
 * test - the card shows nothing, the array is empty, a screenshot shows nothing - while every
 * rule has already read the learner's subject graph, counted their repeated drafts, ranked
 * their failing rooms, and produced a full ranked list that was then thrown away.
 *
 * That is not "removal". It is concealment, and it has three bad properties a filter cannot
 * avoid:
 *
 * 1. **The work happened.** The engine spent the learner's CPU walking their graph for output
 *    nobody will see.
 * 2. **The state was read.** If any future rule had a side effect - an analytics call, a
 *    cached derivation, a log line - a filter would not stop it.
 * 3. **The claim is unfalsifiable by the obvious test.** Anyone checking "does the card render
 *    anything in Off" gets the right answer whether the implementation is correct or not.
 *
 * So the structural claim is asserted in the three forms that can distinguish it, and the
 * middle one is the one that matters.
 *
 * ## The three forms
 *
 * - **Type level.** `ProactiveAssistanceMode` is `Exclude<AssistanceMode, 'off'>`, and every
 *   rule's context parameter uses it, so `rankProactiveAssistance({ mode: 'off', ... })` is a
 *   **typecheck error**. The negative half is asserted here with a `@ts-expect-error` probe: if
 *   a future edit ever widened the type back to `AssistanceMode`, the `@ts-expect-error` would
 *   become unused and `tsc` would fail - so the type-level guarantee cannot rot silently.
 * - **Run time.** `rankProactiveAssistance` throws on `off`, for a caller the type system could
 *   not stop.
 * - **Observable.** {@link AssistanceResult.evaluatedRuleKinds} names every rule that
 *   **executed**. In `off` mode it is always empty, and that is what this file sweeps over the
 *   whole corpus.
 */
import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_MODES,
  isAssistanceMode,
  proactiveModeFor,
  type AssistanceSubjectInput,
} from '@/core/assistance/types';
import {
  rankAssistance,
  rankProactiveAssistance,
  type AssistanceFishingInput,
  type AssistanceStudyInput,
} from '@/core/assistance/assistanceEngine';

import { CORPUS_ENTRIES, NOW_ISO, SIGNAL_CORPUS, room, subject } from './support/fixtures';

/** The largest possible input the engine could be handed, so "nothing" means nothing. */
const MAXIMAL_STUDY: AssistanceStudyInput = {
  roomsCleared: 999,
  notesSubmitted: 999,
  reviewsCompleted: 999,
  activeDays: 999,
  fishKept: 999,
};

/**
 * Every signal at its maximum useful value.
 *
 * Written **out** rather than derived from {@link SIGNAL_CORPUS} with
 * `Object.fromEntries(signalCorpus.map(([, signals]) => signals))`. That expression looks
 * reasonable and is wrong: every corpus map carries the same four keys, so `fromEntries` keeps
 * only the **last** one - which is the `stringValues` entry, whose `fishingRecallMiss` is `0`.
 * The result was a "maximal" signal map with no fishing misses, so the fishing rule produced
 * nothing, and every "Off produced no suggestions" assertion in this file was satisfied by a
 * weaker input than it claimed to be.
 *
 * It is stated here rather than quietly fixed because it is the exact shape of fixture bug this
 * phase's own working agreement warns about: a gate that passes for the wrong reason reads
 * identically to a gate that passes for the right one.
 */
const MAXIMAL_SIGNALS: Record<string, number> = {
  noteValidationFailure: 25,
  lowRecallRating: 25,
  repeatedDraft: 25,
  fishingRecallMiss: 25,
};

/**
 * A fishing context naming a room that **exists** in {@link EVERYTHING_STATE}.
 *
 * `subject-everything` / `room-due`, deliberately. The fishing rule refuses a context whose
 * room or subject this device does not hold - plan 5.3's "fishing eligibility, recall
 * selection, and persistence may use different subject contexts" - and that refusal is
 * asserted separately below. Pointing the *maximal* context at a real room is what makes the
 * maximal state maximal.
 */
const MAXIMAL_FISHING: AssistanceFishingInput = {
  subjectId: 'subject-everything',
  lastMissedRoomId: 'room-due',
  missedThisVisit: 99,
};

/** A fishing context naming a subject and room this device does not hold. */
const UNSATISFIABLE_FISHING: AssistanceFishingInput = {
  subjectId: 'subject-that-does-not-exist',
  lastMissedRoomId: 'room-that-does-not-exist',
  missedThisVisit: 99,
};

/**
 * A state designed to make every rule fire, so the Off-mode assertions are not passing
 * because there was nothing to say.
 *
 * It is asserted to actually produce suggestions in a proactive mode at the top of this file -
 * without that, every "Off produced nothing" assertion below would be satisfied by a rule set
 * that never fires.
 */
const EVERYTHING_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    subjectId: 'subject-everything',
    rootRoomId: 'room-root',
    phaseState: 'ScribeActive',
    rooms: [
      room({
        roomId: 'room-root',
        topic: 'Root',
        state: 'NotesDrafted',
        failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
        missingSections: ['Summary'],
        criterionScores: { sectionCompleteness: 0, linkReferences: 0 },
        tags: ['shared'],
      }),
      room({
        roomId: 'room-failing',
        topic: 'Failing',
        state: 'NotesDrafted',
        missingSections: ['Key Points'],
        failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
        criterionScores: { sectionCompleteness: 0 },
        tags: ['shared'],
      }),
      room({
        roomId: 'room-due',
        topic: 'Due',
        state: 'EncounterDefeated',
        finalPass: true,
        sm2NextReviewDate: '2026-03-01T00:00:00.000Z',
        sm2QualityResponse: 1,
      }),
      room({
        roomId: 'room-low',
        topic: 'Low recall',
        state: 'ArtifactCollected',
        finalPass: true,
        sm2NextReviewDate: '2026-03-02T00:00:00.000Z',
        sm2QualityResponse: 0,
      }),
    ],
    edges: [
      { fromRoomId: 'room-root', toRoomId: 'room-failing', relationType: 'subtopic' },
      { fromRoomId: 'room-failing', toRoomId: 'room-due', relationType: 'subtopic' },
      { fromRoomId: 'room-due', toRoomId: 'room-low', relationType: 'subtopic' },
    ],
  }),
];

describe('the proactive engine can actually produce suggestions, so Off means something', () => {
  it('the maximal state produces suggestions in both proactive modes', () => {
    // THE anti-vacuity guard for this entire file. Every assertion below is "Off produced
    // nothing", and without this one, a rule set that never fires would satisfy all of them.
    for (const mode of ['gentle', 'standard'] as const) {
      const result = rankAssistance({
        mode,
        subjects: EVERYTHING_STATE,
        signals: MAXIMAL_SIGNALS,
        nowIso: NOW_ISO,
        flagEnabled: true,
        study: MAXIMAL_STUDY,
        fishing: MAXIMAL_FISHING,
      });
      expect(result.suggestions.length, `${mode} produced nothing to compare against`).toBeGreaterThan(0);
      expect(result.evaluatedRuleKinds.length, `${mode} evaluated no rules`).toBeGreaterThan(0);
      expect(result.emptyReason).toBeNull();
      // At least two distinct kinds survive truncation, so the returned list is not one rule's
      // output wearing nine hats. The *whole* rule set does not appear in the returned list, and
      // that is a separate documented behaviour - the per-mode result limit - asserted in the
      // limit test below rather than papered over here. The full rule set appears in
      // `evaluatedRuleKinds`, which is asserted exhaustively in the next test.
      expect(
        new Set(result.suggestions.map((entry) => entry.kind)).size,
        `${mode} returned one kind only`,
      ).toBeGreaterThanOrEqual(2);
    }
    // And the union across the two proactive modes covers at least four kinds, which is a
    // stronger claim than either list alone and is what a reviewer should read.
    const union = new Set<string>();
    for (const mode of ['gentle', 'standard'] as const) {
      for (const suggestion of rankAssistance({
        mode,
        subjects: EVERYTHING_STATE,
        signals: MAXIMAL_SIGNALS,
        nowIso: NOW_ISO,
        flagEnabled: true,
        study: MAXIMAL_STUDY,
        fishing: MAXIMAL_FISHING,
      }).suggestions) {
        union.add(suggestion.kind);
      }
    }
    expect(union.size, `union covered ${[...union].join(',')}`).toBeGreaterThanOrEqual(4);
    // Every one of the four is a kind whose rule only produced a candidate because real evidence
    // existed, which is the other half of "this state is maximal".
    expect([...union].sort()).toEqual([
      'archaeologist.due-room',
      'archaeologist.low-recall',
      'fishing.navigation-after-miss',
      'scribe.missing-section',
    ]);
  });

  it('a fishing context naming a room this device does not hold produces no suggestion', () => {
    // Plan 5.3's fishing-subject-context defect, at the point where it would bite: the engine
    // would otherwise offer navigation into a graph it has never seen. Asserted positively -
    // the same context with a real room *does* produce a suggestion - so this is a refusal and
    // not a rule that never fires.
    const withRealRoom = rankAssistance({
      mode: 'gentle',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    }).suggestions.some((entry) => entry.kind === 'fishing.navigation-after-miss');
    const withFakeRoom = rankAssistance({
      mode: 'gentle',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: UNSATISFIABLE_FISHING,
    }).suggestions.some((entry) => entry.kind === 'fishing.navigation-after-miss');
    expect(withRealRoom, 'the fishing rule never fired, so the refusal proves nothing').toBe(true);
    expect(withFakeRoom).toBe(false);
  });

  it('a fishing suggestion disappears when the miss count is zero', () => {
    // The rule needs a recorded miss, not merely a context. A fishing session that has missed
    // nothing has nothing to navigate away from.
    const withoutMisses = rankAssistance({
      mode: 'gentle',
      subjects: EVERYTHING_STATE,
      signals: { ...MAXIMAL_SIGNALS, fishingRecallMiss: 0 },
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    }).suggestions.some((entry) => entry.kind === 'fishing.navigation-after-miss');
    expect(withoutMisses).toBe(false);
  });

  it('the mode limit truncates, and Gentle keeps more than Standard', () => {
    // The plan's "more generous timing" for Gentle, as a measured difference rather than a
    // claim. On the maximal state every rule produces a candidate and the returned list is cut
    // to the mode's limit, so the limits are the only reason the two lists differ in length.
    const gentle = rankAssistance({
      mode: 'gentle',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    });
    const standard = rankAssistance({
      mode: 'standard',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    });
    expect(gentle.suggestions.length).toBeGreaterThan(standard.suggestions.length);
    expect(gentle.suggestions.length).toBeLessThanOrEqual(6);
    expect(standard.suggestions.length).toBeLessThanOrEqual(4);
    // Standard's list is a **prefix** of Gentle's: it is the same ranking, cut shorter. If it
    // were not, the two modes would be ranking differently, which would be a much larger and
    // unclaimed difference in the scoring rather than in the presentation.
    expect(standard.suggestions.map((entry) => entry.suggestionId)).toEqual(
      gentle.suggestions.slice(0, standard.suggestions.length).map((entry) => entry.suggestionId),
    );
  });

  it('every rule family fires on the maximal state', () => {
    // A rule that never fires is a rule whose Off-mode removal was never exercised.
    const executed = new Set(
      rankProactiveAssistance({
        mode: 'gentle',
        subjects: EVERYTHING_STATE,
        signals: MAXIMAL_SIGNALS,
        nowIso: NOW_ISO,
        flagEnabled: true,
        study: MAXIMAL_STUDY,
        fishing: MAXIMAL_FISHING,
      }).evaluatedRuleKinds,
    );
    for (const kind of [
      'scribe.missing-section',
      'scribe.rubric-hint',
      'scribe.related-topic',
      'archaeologist.due-room',
      'archaeologist.low-recall',
      'fishing.navigation-after-miss',
      'device.due-today',
      'creator.cross-link',
    ] as const) {
      expect(executed.has(kind), `${kind} never ran`).toBe(true);
    }
  });
});

describe('Off mode removes suggestions structurally', () => {
  it('Off returns an empty list, an empty rule trace, and the right reason - over the corpus', () => {
    // The sweep. Every corpus state x every signal map x the maximal study and fishing
    // context, so "Off produced nothing" is asserted against inputs that *would* have produced
    // something.
    const checked: string[] = [];
    for (const [stateName, subjects] of CORPUS_ENTRIES) {
      for (const [signalName, signals] of SIGNAL_CORPUS) {
        const result = rankAssistance({
          mode: 'off',
          subjects,
          signals,
          nowIso: NOW_ISO,
          flagEnabled: true,
          study: MAXIMAL_STUDY,
          fishing: MAXIMAL_FISHING,
        });
        expect(result.suggestions, `${stateName}/${signalName} produced suggestions`).toEqual([]);
        expect(result.evaluatedRuleKinds, `${stateName}/${signalName} evaluated a rule`).toEqual([]);
        expect(result.emptyReason, `${stateName}/${signalName} reason`).toBe('mode-off');
        expect(result.mode).toBe('off');
        checked.push(`${stateName}/${signalName}`);
      }
    }
    expect(checked.length).toBe(CORPUS_ENTRIES.length * SIGNAL_CORPUS.length);
    expect(checked.length).toBeGreaterThanOrEqual(90);
  });

  it('Off on the maximal state evaluates no rule at all, while Standard evaluates eight', () => {
    // The contrast, in one place, so the structural claim cannot be read as "Off happens to
    // produce the same empty result as a filter would".
    const off = rankAssistance({
      mode: 'off',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    });
    const standard = rankAssistance({
      mode: 'standard',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    });
    expect(off.evaluatedRuleKinds).toEqual([]);
    expect(standard.evaluatedRuleKinds.length).toBeGreaterThanOrEqual(8);
    expect(standard.suggestions.length).toBeGreaterThan(0);
  });

  it('the flag-off lane reports before it even looks at the mode', () => {
    // The Phase 19 rollback, checked as behaviour rather than as an unreachable import: with
    // the flag off, *every* stored mode reports `flag-disabled` and evaluates nothing, and the
    // stored record is untouched because nothing here writes.
    for (const mode of ASSISTANCE_MODES) {
      const result = rankAssistance({
        mode,
        subjects: EVERYTHING_STATE,
        signals: MAXIMAL_SIGNALS,
        nowIso: NOW_ISO,
        flagEnabled: false,
        study: MAXIMAL_STUDY,
        fishing: MAXIMAL_FISHING,
      });
      expect(result.emptyReason, `flag off with mode ${mode}`).toBe('flag-disabled');
      expect(result.suggestions).toEqual([]);
      expect(result.evaluatedRuleKinds).toEqual([]);
      // The mode is still echoed, so a surface can say "your stored mode is Off" while the
      // feature itself is disabled - which is what "leave stored records untouched" means from
      // the learner's side.
      expect(result.mode).toBe(mode);
    }
  });

  it('rankProactiveAssistance throws on off, for a caller the type system could not stop', () => {
    // A `as never` cast, a value out of `localStorage`, a `postMessage`: none of these are
    // type errors at the boundary that produced them, and all of them reach this function.
    expect(() =>
      rankProactiveAssistance({
        mode: 'off' as never,
        subjects: EVERYTHING_STATE,
        signals: MAXIMAL_SIGNALS,
        nowIso: NOW_ISO,
        flagEnabled: true,
      }),
    ).toThrow(/rankProactiveAssistance/);
  });

  it('off cannot be passed to the proactive half without a type error', () => {
    // The type-level half, asserted negatively.
    //
    // `@ts-expect-error` fails `tsc` when the line beneath it **stops** being an error, so this
    // directive cannot rot into a comment: widen `ProactiveAssistanceMode` back to
    // `AssistanceMode` and this file stops compiling. That is the whole mechanism, and it is why
    // the structural claim is not "the rules check the mode" but "the rules cannot be handed
    // one".
    //
    // The directive sits above the **property**, not the declaration, because that is the line
    // `tsc` reports. Putting it above the declaration produced
    // `TS2578: Unused '@ts-expect-error' directive` while the real error was reported on the
    // value below - which is the failure mode of a suppression in the wrong place: it fails
    // loudly and for the wrong reason, which is the good version.
    const impossible: import('@/core/assistance/assistanceEngine').ProactiveAssistanceEngineInput = {
      // @ts-expect-error `ProactiveAssistanceMode` excludes 'off'; this must not compile.
      mode: 'off',
      subjects: [],
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
    };
    // Unreachable at run time; the value exists only so the type error has a line to attach to.
    expect(impossible.mode).toBe('off');
  });

  it('proactiveModeFor is total and maps exactly one mode to null', () => {
    expect(proactiveModeFor('off')).toBeNull();
    expect(proactiveModeFor('gentle')).toBe('gentle');
    expect(proactiveModeFor('standard')).toBe('standard');
    // And it is total over the enumeration - no mode silently produces `undefined`, which a
    // truthiness check at a call site would then read as "no proactive mode".
    for (const mode of ASSISTANCE_MODES) {
      const narrowed = proactiveModeFor(mode);
      if (mode === 'off') expect(narrowed).toBeNull();
      else expect(narrowed).toBe(mode);
    }
    // The enumeration is exactly the three plan modes, in the plan's order.
    expect(ASSISTANCE_MODES).toEqual(['off', 'gentle', 'standard']);
    for (const value of ['OFF', 'Off', 'on', 'strong', '', null, undefined, 1]) {
      expect(isAssistanceMode(value), String(value)).toBe(false);
    }
  });

  it('Off and flag-off are distinguishable, so a surface can explain the silence', () => {
    // Both return an empty list, and a card that cannot tell them apart would tell a learner
    // who has deliberately switched assistance off that the feature is broken.
    const off = rankAssistance({
      mode: 'off',
      subjects: EVERYTHING_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
    });
    const flagOff = rankAssistance({
      mode: 'gentle',
      subjects: EVERYTHING_STATE,
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: false,
    });
    const nothingToSay = rankAssistance({
      mode: 'gentle',
      subjects: [],
      signals: {},
      nowIso: NOW_ISO,
      flagEnabled: true,
    });
    expect(off.emptyReason).toBe('mode-off');
    expect(flagOff.emptyReason).toBe('flag-disabled');
    expect(nothingToSay.emptyReason).toBe('no-suggestions');
    // Three different silences, three different reasons, and all three are the only values the
    // type admits - so a surface cannot invent a fourth.
    const reasons = new Set([off.emptyReason, flagOff.emptyReason, nothingToSay.emptyReason]);
    expect(reasons.size).toBe(3);
  });

  it('a Gentle learner and an Off learner with identical state diverge only in what is offered', () => {
    // The mode difference the plan describes, on one state, so "Off removes suggestions" and
    // "Gentle offers them" are asserted against each other rather than in isolation.
    const off = rankAssistance({
      mode: 'off',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    });
    const gentle = rankAssistance({
      mode: 'gentle',
      subjects: EVERYTHING_STATE,
      signals: MAXIMAL_SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      study: MAXIMAL_STUDY,
      fishing: MAXIMAL_FISHING,
    });
    expect(off.suggestions).toEqual([]);
    expect(gentle.suggestions.length).toBeGreaterThan(0);
    // And no suggestion of the Gentle result is reachable through the Off result, because the
    // Off result *is* empty - which is the structural claim restated as a set relation.
    const offIds = new Set(off.suggestions.map((entry) => entry.suggestionId));
    for (const suggestion of gentle.suggestions) {
      expect(offIds.has(suggestion.suggestionId)).toBe(false);
    }
  });
});
