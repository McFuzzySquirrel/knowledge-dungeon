/**
 * Phase 19 fixtures for the assistance engine.
 *
 * Every value here is synthetic. No learner content, no real subject, no real room topic
 * beyond app-owned vocabulary, and nothing that could be mistaken for a stored record.
 *
 * The corpus exists because **a determinism test that runs one state proves nothing**. A
 * single state can be accidentally deterministic - one room, one edge, no ties in the ranking
 * - while the same engine diverges on the eleventh room. So this module builds a *corpus*:
 * a set of states chosen to hit the places where order can leak in.
 *
 * | Fixture | What it is for |
 * | --- | --- |
 * | `EMPTY_STATE` | Nothing to say. The case a filter-based "off" would also pass. |
 * | `SINGLE_ROOM_STATE` | A one-room graph. Exercises the `creator.missing-branch` bonus. |
 * | `UNBRANCHED_MULTI_ROOM_STATE` | Five rooms and **no** `subtopic` edge off the root. The case where a hardcoded evidence literal lies - a room *count* of 5 reported as `1 x Rooms cleared`. |
 * | `DRAFTING_ROOM_STATE` | The Scribe rules, with a *named* missing section. |
 * | `PERSISTED_ONLY_FAILURE_STATE` | A failing room whose section is **not** named - the case that distinguishes a rule that guesses from one that admits it does not know. |
 * | `DUE_AND_LOW_RECALL_STATE` | The Archaeologist rules, including a room overdue by exactly a week. |
 * | `MANY_ROOM_STATE` | 40 rooms, mixed states, tie-heavy priorities. The order-leak case. |
 * | `UNICODE_ROOM_STATE` | Topics and tags chosen so a locale-sensitive collation and a code-unit collation disagree. |
 * | `TIE_STATE` | Two rooms whose derived priorities are **identical**, so only the tie-break can order them. |
 * | `CORRUPT_ROOM_STATE` | Rooms with `NaN`, negative, fractional, and missing fields. |
 *
 * `LOCALE_DISAGREEMENT_PAIRS` is the sharpest of these: two strings whose `localeCompare`
 * order is the **reverse** of their code-unit order under the `en-US` collation a GitHub
 * runner uses, so any code that leaks a locale into its comparison produces a visibly wrong
 * order rather than a subtly wrong one.
 */
import type {
  AssistanceEdgeInput,
  AssistanceRoomInput,
  AssistanceSubjectInput,
} from '@/core/assistance/types';

/** A room's six numeric/enum facts, defaulted so a fixture states only what it is testing. */
export function room(overrides: Partial<AssistanceRoomInput> = {}): AssistanceRoomInput {
  return {
    roomId: 'room-a',
    topic: 'Algebra',
    state: 'Created',
    noteWordCount: 0,
    missingSections: [],
    failedChecks: [],
    criterionScores: {},
    finalPass: false,
    reviewPassCount: 0,
    sm2QualityResponse: null,
    sm2NextReviewDate: null,
    tags: [],
    ...overrides,
  };
}

/** One edge. */
export function edge(overrides: Partial<AssistanceEdgeInput> = {}): AssistanceEdgeInput {
  return { fromRoomId: 'room-a', toRoomId: 'room-b', relationType: 'subtopic', ...overrides };
}

/** One subject. */
export function subject(overrides: Partial<AssistanceSubjectInput> = {}): AssistanceSubjectInput {
  return {
    subjectId: 'subject-a',
    subjectName: 'Synthetic Subject',
    rootRoomId: 'room-a',
    phaseState: 'CreatorActive',
    rooms: [room()],
    edges: [],
    ...overrides,
  };
}

/** A timestamp the whole corpus is measured against. Fixed, so nothing reads a clock. */
export const NOW_ISO = '2026-03-15T12:00:00.000Z';

/** Nothing to say. */
export const EMPTY_STATE: readonly AssistanceSubjectInput[] = [];

/** A one-room graph, which is `creator.missing-branch`'s clearest case. */
export const SINGLE_ROOM_STATE: readonly AssistanceSubjectInput[] = [
  subject({ rooms: [room({ roomId: 'room-a', topic: 'Only Room' })] }),
];

/**
 * Five rooms, every one of them **created and never studied**, and no `subtopic` edge off the
 * root.
 *
 * This exists to make one specific false claim unrepresentable. `SINGLE_ROOM_STATE` has a single
 * room, so a hardcoded `1` in the `graph-no-branch` explanation arm agreed with the truth by
 * coincidence and no test over that fixture could catch it. Here the room count is five, so any
 * literal - or any row that borrows the device-scoped `rooms-cleared` key - is visibly wrong, and
 * a learner holding this subject has cleared nothing at all.
 *
 * The rooms are chained by `related` edges rather than `subtopic` precisely so the graph is
 * connected: a `missing-branch` finding must not be satisfiable by an unconnected graph, and the
 * rule keys on the relation type alone.
 */
export const UNBRANCHED_MULTI_ROOM_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    subjectId: 'subject-unbranched',
    rooms: [
      room({ roomId: 'room-a', topic: 'Roots' }),
      room({ roomId: 'room-b', topic: 'Discriminants' }),
      room({ roomId: 'room-c', topic: 'Factoring' }),
      room({ roomId: 'room-d', topic: 'Completing The Square' }),
      room({ roomId: 'room-e', topic: 'Graphs Of Parabolas' }),
    ],
    edges: [
      edge({ fromRoomId: 'room-a', toRoomId: 'room-b', relationType: 'related' }),
      edge({ fromRoomId: 'room-b', toRoomId: 'room-c', relationType: 'related' }),
      edge({ fromRoomId: 'room-c', toRoomId: 'room-d', relationType: 'related' }),
      edge({ fromRoomId: 'room-d', toRoomId: 'room-e', relationType: 'related' }),
    ],
  }),
];

/** A drafting room with a named missing section - the Scribe scaffold case. */
export const DRAFTING_ROOM_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    phaseState: 'ScribeActive',
    rooms: [
      room({ roomId: 'room-a', topic: 'Quadratic Roots', state: 'NotesDrafted', noteWordCount: 90 }),
      room({
        roomId: 'room-b',
        topic: 'Discriminants',
        state: 'NotesDrafted',
        noteWordCount: 40,
        missingSections: ['Summary', 'Recall Question'],
        failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
        criterionScores: { sectionCompleteness: 0, linkReferences: 0 },
      }),
    ],
    edges: [edge({ fromRoomId: 'room-a', toRoomId: 'room-b' })],
  }),
];

/**
 * A failing room whose missing section is **not** named.
 *
 * `RoomMetadata.validationState` records `requiredSectionsPresent` as a boolean and does not
 * store which section is missing, so this is what every *persisted* pass actually sees. The
 * rule must report `note-validation-failed` and offer no section name; a rule that inferred
 * "Summary" from the boolean would be inventing a fact the device does not have.
 */
export const PERSISTED_ONLY_FAILURE_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    phaseState: 'ScribeActive',
    rooms: [
      room({
        roomId: 'room-a',
        state: 'NotesDrafted',
        failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
        criterionScores: { sectionCompleteness: 0 },
      }),
    ],
  }),
];

/** A due room, an overdue room, and a low-recall room. */
export const DUE_AND_LOW_RECALL_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    phaseState: 'ArchaeologistUnlocked',
    rooms: [
      room({
        roomId: 'room-a',
        state: 'EncounterDefeated',
        finalPass: true,
        sm2NextReviewDate: '2026-03-15T12:00:00.000Z',
      }),
      room({
        roomId: 'room-b',
        state: 'ArtifactCollected',
        finalPass: true,
        sm2NextReviewDate: '2026-03-08T12:00:00.000Z',
      }),
      room({
        roomId: 'room-c',
        state: 'ArtifactCollected',
        finalPass: true,
        sm2QualityResponse: 1,
        sm2NextReviewDate: '2026-04-01T12:00:00.000Z',
      }),
      room({
        roomId: 'room-d',
        state: 'ArtifactCollected',
        finalPass: true,
        sm2QualityResponse: 2,
        sm2NextReviewDate: '2026-04-01T12:00:00.000Z',
      }),
    ],
    edges: [
      edge({ fromRoomId: 'room-a', toRoomId: 'room-b' }),
      edge({ fromRoomId: 'room-b', toRoomId: 'room-c' }),
      edge({ fromRoomId: 'room-c', toRoomId: 'room-d' }),
    ],
  }),
];

/**
 * Forty rooms in mixed states.
 *
 * Built by `String.prototype.padStart` rather than hard-coded, so the ids are `room-00`
 * through `room-39` and the code-unit order matches the numeric order - which matters,
 * because an id like `room-1`, `room-10`, `room-2` sorts differently from its numeric order
 * and would make a fixture's "expected first room" ambiguous.
 *
 * Every fifth room fails validation; every third room shares the tag `algebra`; every seventh
 * is due. Those moduli are coprime, so the three conditions overlap in a scattered pattern
 * rather than lining up, which is what makes the resulting priorities tie.
 */
export const MANY_ROOM_STATE: readonly AssistanceSubjectInput[] = (() => {
  const rooms: AssistanceRoomInput[] = [];
  const edges: AssistanceEdgeInput[] = [];
  for (let index = 0; index < 40; index += 1) {
    const roomId = `room-${String(index).padStart(2, '0')}`;
    const failing = index % 5 === 0;
    rooms.push(
      room({
        roomId,
        topic: `Topic ${String(index).padStart(2, '0')}`,
        state: failing ? 'NotesDrafted' : 'EncounterDefeated',
        finalPass: !failing,
        noteWordCount: failing ? 30 + index : 200 + index,
        failedChecks: failing ? ['VAL_REQUIRED_SECTION_MISSING'] : [],
        criterionScores: failing ? { sectionCompleteness: 0 } : { sectionCompleteness: 2 },
        tags: index % 3 === 0 ? ['algebra'] : [],
        sm2NextReviewDate:
          index % 7 === 0 ? '2026-03-10T12:00:00.000Z' : '2026-06-01T12:00:00.000Z',
        sm2QualityResponse: index % 7 === 0 ? 2 : 5,
        reviewPassCount: index % 4,
      }),
    );
    if (index > 0) {
      const parentId = `room-${String(index - 1).padStart(2, '0')}`;
      edges.push(edge({ fromRoomId: parentId, toRoomId: roomId, relationType: 'subtopic' }));
    }
  }
  return [subject({ subjectId: 'subject-many', rooms, edges })];
})();

/**
 * Strings whose locale-sensitive order is the **reverse** of their code-unit order.
 *
 * Under the `en-US` collation, case is ignored at the primary level, so `'apple'` sorts before
 * `'Banana'`. Under a code-unit comparison, `'B'` (U+0042) sorts before `'a'` (U+0061), so
 * the order flips. This fixture's room ids are `'apple'` and `'Banana'`; any ranking that
 * leaked `localeCompare` would put `'apple'` first where a locale-independent one puts
 * `'Banana'` first.
 *
 * **`LOCALE_DISAGREEMENT_PAIRS` is the assertion, and a test reads it at run time** rather
 * than trusting the comment - because if the CI runner's ICU were built without collation
 * data, `'apple'.localeCompare('Banana')` would be `+1` and the fixture would prove nothing.
 * The test skips - loudly - when the disagreement does not exist, rather than passing
 * vacuously.
 */
export const LOCALE_DISAGREEMENT_ROOM_IDS = ['apple', 'Banana', 'aPPle', 'ápple'] as const;

/**
 * True when this runtime's collation actually disagrees with code-unit order for the fixture.
 *
 * Compares `'apple'.localeCompare('Banana')` against the code-unit sign of the same pair. A
 * test reads this at run time rather than trusting the comment above: if the CI runner's ICU
 * were built without collation data the disagreement would vanish and every attack built on it
 * would pass vacuously, so the tests assert its existence loudly and report when it is absent.
 */
export function localeDisagreesWithCodeUnits(): boolean {
  const [left, right] = LOCALE_DISAGREEMENT_ROOM_IDS;
  const codeUnitSign = left < right ? -1 : left > right ? 1 : 0;
  return left.localeCompare(right) !== codeUnitSign;
}

/**
 * Two rooms built to produce the **same** priority.
 *
 * Both fail the same two criteria with the same rubric shape and the same repeated-draft
 * boost, so `scribe.missing-section` assigns them equal scores. Nothing but the ranking
 * tie-break can order them, which is what makes this fixture the test for whether the
 * comparator is total rather than whether the scores are right.
 *
 * The ids are `'room-b'` and `'room-a'`, i.e. **the reverse of code-unit order**, so a
 * comparator that fell through to "whatever order they arrived in" - the array order, or a
 * sort's stability - would return them in the opposite order from a correct one.
 */
export const TIE_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    subjectId: 'subject-tie',
    rooms: [
      room({ roomId: 'room-a', state: 'NotesDrafted', failedChecks: ['VAL_MANUAL_CONFIRM_REQUIRED'] }),
      room({ roomId: 'room-b', state: 'NotesDrafted', failedChecks: ['VAL_MANUAL_CONFIRM_REQUIRED'] }),
      room({ roomId: 'room-c', state: 'NotesDrafted', failedChecks: ['VAL_MANUAL_CONFIRM_REQUIRED'] }),
    ],
  }),
];

/** Rooms whose every numeric field is hostile. */
export const CORRUPT_ROOM_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    subjectId: 'subject-corrupt',
    rootRoomId: 'room-a',
    rooms: [
      room({
        roomId: 'room-a',
        // A room that "passed" with a NaN word count and a fractional score.
        finalPass: true,
        noteWordCount: Number.NaN,
        criterionScores: { sectionCompleteness: Number.NaN, linkReferences: 1.7 },
        sm2QualityResponse: Number.NaN,
        sm2NextReviewDate: 'not-a-timestamp',
      }),
      room({
        roomId: 'room-b',
        state: 'NotesDrafted',
        failedChecks: ['VAL_MANUAL_CONFIRM_REQUIRED'],
        noteWordCount: -50,
        criterionScores: { sectionCompleteness: -3 },
        sm2QualityResponse: -1,
        sm2NextReviewDate: '',
      }),
      room({
        roomId: 'room-c',
        state: 'NotesDrafted',
        failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
        // A room whose only problem is a fractional zero-adjacent score.
        criterionScores: { clarityReadability: 0.4 },
      }),
    ],
    edges: [edge({ fromRoomId: 'room-a', toRoomId: 'room-b' }), edge({ fromRoomId: 'room-b', toRoomId: 'room-c' })],
  }),
];

/** Rooms and tags chosen so locale and code-unit collation disagree. */
export const UNICODE_ROOM_STATE: readonly AssistanceSubjectInput[] = [
  subject({
    subjectId: 'subject-unicode',
    rootRoomId: 'apple',
    rooms: LOCALE_DISAGREEMENT_ROOM_IDS.map((roomId, index) =>
      room({
        roomId,
        topic: `Topic ${roomId}`,
        state: 'NotesDrafted',
        failedChecks: ['VAL_MANUAL_CONFIRM_REQUIRED'],
        tags: index % 2 === 0 ? ['shared'] : [],
      }),
    ),
    edges: [
      edge({ fromRoomId: 'apple', toRoomId: 'Banana' }),
      edge({ fromRoomId: 'Banana', toRoomId: 'aPPle' }),
      edge({ fromRoomId: 'aPPle', toRoomId: 'ápple' }),
    ],
  }),
];

/**
 * The whole corpus, in a fixed order.
 *
 * A fixed order because the determinism tests iterate it and compare against a recorded
 * expectation: a corpus whose *order* varied between runs would make a diff meaningless.
 */
export const CORPUS: Readonly<Record<string, readonly AssistanceSubjectInput[]>> = Object.freeze({
  empty: EMPTY_STATE,
  singleRoom: SINGLE_ROOM_STATE,
  draftingRoom: DRAFTING_ROOM_STATE,
  persistedOnlyFailure: PERSISTED_ONLY_FAILURE_STATE,
  dueAndLowRecall: DUE_AND_LOW_RECALL_STATE,
  manyRoom: MANY_ROOM_STATE,
  unicode: UNICODE_ROOM_STATE,
  tie: TIE_STATE,
  corrupt: CORRUPT_ROOM_STATE,
});

/** Every corpus entry as one list, so a test can sweep all of them in a single loop. */
export const CORPUS_ENTRIES: readonly (readonly [string, readonly AssistanceSubjectInput[]])[] =
  Object.freeze(Object.entries(CORPUS) as [string, readonly AssistanceSubjectInput[]][]);

/** Signal maps a test sweeps with, including the hostile ones. */
export const SIGNAL_CORPUS: readonly (readonly [string, Record<string, number>])[] = Object.freeze([
  ['empty', {}],
  ['zeroes', { noteValidationFailure: 0, lowRecallRating: 0, repeatedDraft: 0, fishingRecallMiss: 0 }],
  ['typical', { noteValidationFailure: 3, lowRecallRating: 2, repeatedDraft: 1, fishingRecallMiss: 0 }],
  ['heavy', { noteValidationFailure: 900, lowRecallRating: 400, repeatedDraft: 12, fishingRecallMiss: 7 }],
  ['unknownKey', { noteValidationFailure: 1, 'future.build.signal': 5 }],
  ['negative', { noteValidationFailure: -4, lowRecallRating: -1, repeatedDraft: -9, fishingRecallMiss: 0 }],
  ['fractional', { noteValidationFailure: 2.7, lowRecallRating: 1.2, repeatedDraft: 0.5, fishingRecallMiss: 3.9 }],
  ['nan', { noteValidationFailure: Number.NaN, lowRecallRating: Number.NaN, repeatedDraft: Number.NaN, fishingRecallMiss: Number.NaN }],
  ['infinite', { noteValidationFailure: Number.POSITIVE_INFINITY, lowRecallRating: Number.NEGATIVE_INFINITY, repeatedDraft: 1, fishingRecallMiss: 1 }],
  ['stringValues', { noteValidationFailure: '5' as unknown as number, lowRecallRating: null as unknown as number, repeatedDraft: 2, fishingRecallMiss: 0 }],
]);
