/**
 * Phase 19, verification owner's gate: the plan's named file, `npm test -- tests/unit/assistanceEngine.test.ts`.
 *
 * ## Why this file exists at all
 *
 * `tests/phase19/` is the implementing engineer's own suite: eight files, written alongside the
 * engine, by the same author, asserting the engine's own reading of its own contract. That is
 * worth having and it is not a substitute. Before this file, `npm test -- tests/unit/assistanceEngine.test.ts`
 * matched **no file**, exited 0, and ran nothing: the plan's named verification command was a
 * no-op that reported success. A gate that cannot fail is worse than an absent gate, because it
 * appears in a phase report as a passing line.
 *
 * So this file is an **independent** gate. It shares no fixture module, no helper, and no
 * comparator with `tests/phase19/`. Its corpus is built here, its canonical serialiser is here,
 * its import-graph walker is here, and its fingerprint is here. Where the two suites agree that is
 * a coincidence worth having; where they disagree, one of them is wrong and this file says which.
 *
 * ## The exit criteria this file is written against
 *
 * | Plan criterion | Where |
 * | --- | --- |
 * | Identical state always yields identical assistance | `identical state yields identical bytes` |
 * | Assistance remains local and explainable | `assistance is local, explainable, and textless` |
 * | Off mode removes proactive suggestions | `off removes proactive suggestions structurally` |
 * | Suggestions never alter deterministic outcomes by themselves | `suggestions cannot write` |
 * | Assistance survives backup and restore | `assistance survives backup and restore` |
 * | No raw learner behaviour leaves the device | `no raw learner behaviour leaves the device` |
 *
 * ## What this file does NOT claim
 *
 * It does not claim the engine is time-zone independent. It is not, and
 * `tests/unit/assistanceEngine.determinismDefects.test.ts` holds two **red** reproductions of it.
 * The time-zone leg below deliberately uses only `Z`-suffixed timestamps - the shape every writer
 * in `src/` actually produces - and says so, so that the green here is read as "the shipped write
 * path is deterministic" rather than as "restored state cannot move the answer".
 *
 * ## Non-vacuity, stated once
 *
 * Every claim that could pass on an empty input has a sibling assertion that the input was not
 * empty: the corpus is proved to produce suggestions before anything is compared, the
 * comparator is proved non-constant, the fingerprints are proved substantial *and* proved
 * movable, the import walk is proved to resolve a real module, and the byte comparison is proved
 * able to fail by comparing two genuinely different states first.
 */
import 'fake-indexeddb/auto';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectAssistanceSignals,
  compareAssistanceSuggestions,
  compareCodeUnits,
  intensityFor,
  rankAssistance,
  rankProactiveAssistance,
  explainAssistanceSuggestion,
} from '@/core/assistance/assistanceEngine';
import type { AssistanceEngineInput } from '@/core/assistance/assistanceEngine';
import {
  ASSISTANCE_EVIDENCE_KEYS,
  ASSISTANCE_SIGNAL_KEYS,
  ASSISTANCE_SUGGESTION_KINDS,
  isAssistanceMode,
  mergeAssistanceSignals,
  resolveAssistanceSignals,
  type AssistanceResult,
  type AssistanceRoomInput,
  type AssistanceSubjectInput,
  type AssistanceSuggestion,
} from '@/core/assistance/types';
import { QUALITY_SCORE_KEYS } from '@/core/validation/persistence/types';
import { REQUIRED_NOTE_SECTIONS } from '@/core/validation/notes/types';

import { validateAssistanceRecord } from '@/services/persistence/v2/validation';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import { ensureInitialGeneration, INITIAL_GENERATION_ID } from '@/services/persistence/v2/appState';
import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
} from '@/services/persistence/products/fullDeviceBackup';
import {
  exportSubjectBackup,
  importSubjectBackup,
  readSubjectArchiveContents,
  SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
} from '@/services/persistence/products/subjectBackup';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';
import {
  clearPlantingDeclarations,
  isTestOwnedTransientPath,
  livePlantedPaths,
  plantingMarkerPath,
  PRIVACY_PROBE_DIRECTORY as PROBE_DIRECTORY,
  scanGraphForNetworkRules,
  stripComments,
  testOwnedDirectory,
  walkAppGraph,
  writePlantingMarker,
} from '../privacy/support/appGraph';
import { ASSISTANCE_STORAGE_KEY, useAssistanceStore } from '@/store/assistanceStore';
import { useProgressionStore } from '@/store/progressionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useSessionStore } from '@/store/sessionStore';

// ── Corpus ──────────────────────────────────────────────────────────────────

/** The instant the whole corpus is measured against. `Z`, because it is a `Z` we injected. */
const NOW = '2026-03-16T00:00:00.000Z';
const DAY = 86_400_000;

function iso(offsetDays: number): string {
  return new Date(Date.parse(NOW) + offsetDays * DAY).toISOString();
}

/** A room, stating only what the test at hand is about. */
function room(overrides: Partial<AssistanceRoomInput> = {}): AssistanceRoomInput {
  return {
    roomId: 'room-a',
    topic: 'Synthetic Topic',
    state: 'NotesCleared',
    noteWordCount: 0,
    missingSections: [],
    failedChecks: [],
    criterionScores: {},
    finalPass: true,
    reviewPassCount: 0,
    sm2QualityResponse: null,
    sm2NextReviewDate: null,
    tags: [],
    ...overrides,
  };
}

function edge(fromRoomId: string, toRoomId: string, relationType = 'subtopic') {
  return { fromRoomId, toRoomId, relationType };
}

function subject(overrides: Partial<AssistanceSubjectInput> = {}): AssistanceSubjectInput {
  return {
    subjectId: 'subject-a',
    subjectName: 'Synthetic Subject',
    rootRoomId: 'room-root',
    phaseState: 'ArchaeologistUnlocked',
    rooms: [room({ roomId: 'room-root' })],
    edges: [],
    ...overrides,
  };
}

const STUDY = { roomsCleared: 4, notesSubmitted: 4, reviewsCompleted: 4, activeDays: 4, fishKept: 0 };

/**
 * A subject built to make every rule that reads a room fire at once.
 *
 * Chosen so that one `rankAssistance` call produces a suggestion of **every** kind this corpus can
 * reach, which is what stops a determinism comparison from passing on an empty result.
 */
const FULLY_EXERCISED_SUBJECT: AssistanceSubjectInput = subject({
  subjectId: 'subject-full',
  rooms: [
    room({ roomId: 'room-root', topic: 'Root' }),
    // Two rooms sharing a tag and joined by no edge: `creator.cross-link`.
    room({ roomId: 'room-tagged-1', topic: 'Tagged One', tags: ['shared-tag'] }),
    room({ roomId: 'room-tagged-2', topic: 'Tagged Two', tags: ['SHARED-TAG' ] }),
    // A named missing section: `scribe.missing-section` with a named detail.
    room({
      roomId: 'room-draft',
      topic: 'Draft',
      state: 'NotesDrafted',
      finalPass: false,
      missingSections: ['Summary'],
      failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
      criterionScores: { sectionCompleteness: 0, linkReferences: 0 },
    }),
    // A rubric zero with no section and no blocking failure: `scribe.rubric-hint`.
    room({
      roomId: 'room-rubric',
      topic: 'Rubric',
      state: 'NotesDrafted',
      finalPass: false,
      criterionScores: { conceptTermCoverage: 0 },
    }),
    // A link score of zero next to an adjacent room: `scribe.related-topic`.
    room({
      roomId: 'room-unlinked',
      topic: 'Unlinked',
      state: 'NotesDrafted',
      finalPass: false,
      criterionScores: { linkReferences: 0 },
    }),
    // Due, overdue by two weeks, and rated below the pass threshold.
    room({
      roomId: 'room-due',
      topic: 'Due',
      sm2NextReviewDate: iso(-14),
      sm2QualityResponse: 1,
    }),
  ],
  edges: [
    edge('room-root', 'room-tagged-1'),
    edge('room-root', 'room-draft'),
    edge('room-root', 'room-rubric'),
    edge('room-draft', 'room-unlinked'),
  ],
});

/**
 * The corpus, as a list of **named states**.
 *
 * More than one subject in the array on purpose: every rule that touches a subject sorts a copy
 * of `subjects` by `subjectId`, and a corpus of one subject cannot tell a sorted iteration from
 * an unsorted one when the input is already in order.
 */
const CORPUS: ReadonlyArray<{ readonly name: string; readonly subjects: readonly AssistanceSubjectInput[] }> = [
  { name: 'empty', subjects: [] },
  { name: 'root-only', subjects: [subject({ subjectId: 'subject-root-only' })] },
  {
    name: 'fully-exercised',
    subjects: [FULLY_EXERCISED_SUBJECT, subject({ subjectId: 'subject-z-second' })],
  },
  {
    name: 'many-rooms',
    subjects: [
      subject({
        subjectId: 'subject-many',
        // Mixed case in the **leading** character, and that is the whole point: for a pair like
        // `'Beta-00'` / `'alpha-01'` the `en-US` collation puts `alpha` first while a code-unit
        // comparison puts `Beta` first. An id like `'Room-01'` would not do - `'Room-01'` and
        // `'room-02'` order the same way under both, so the fixture would look adversarial and
        // prove nothing.
        rooms: Array.from({ length: 24 }, (_unused, index) =>
          room({
            roomId:
              index % 2 === 0
                ? `Beta-${String(index).padStart(2, '0')}`
                : `alpha-${String(index).padStart(2, '0')}`,
            topic: `Topic ${index}`,
            finalPass: index % 3 !== 0,
            missingSections: index % 4 === 0 ? ['Summary', 'Recall Question'] : [],
            failedChecks: index % 5 === 0 ? ['VAL_REQUIRED_SECTION_MISSING'] : [],
            criterionScores: index % 2 === 0 ? { linkReferences: 0, conceptTermCoverage: 0 } : {},
            sm2QualityResponse: index % 6 === 0 ? 2 : null,
            sm2NextReviewDate: index % 7 === 0 ? iso(-(index % 30)) : null,
            tags: index % 3 === 0 ? ['BETA', 'alpha'] : [],
          }),
        ),
        edges: Array.from({ length: 23 }, (_unused, index) =>
          edge(
            `Beta-${String(index).padStart(2, '0')}`,
            `alpha-${String(index + 1).padStart(2, '0')}`,
          ),
        ),
      }),
    ],
  },
];

const MODES = ['gentle', 'standard'] as const;

/**
 * One minimal fixture per suggestion kind, each producing **exactly** that kind.
 *
 * Written as a table rather than one maximal state because the modes truncate, so a maximal state
 * hides the lowest-ranked kinds behind `limit`. Each fixture is also the smallest state that
 * reaches its rule, which means a rule that started requiring *more* evidence to fire would fail
 * here - the fixtures double as a floor on how little each rule needs.
 */
const PER_KIND: ReadonlyArray<{
  readonly kind: string;
  /** The room or subject the rule must name, so "fired" is not enough - it has to fire correctly. */
  readonly expectsTarget: string;
  readonly subjects: readonly AssistanceSubjectInput[];
  readonly signals?: Record<string, number>;
  readonly fishing?: { subjectId: string; lastMissedRoomId: string; missedThisVisit: number };
}> = [
  {
    kind: 'creator.missing-branch',
    expectsTarget: 'subject-kind-branch',
    // A one-room subject: the root has no `subtopic` edge, and `isBare` adds the bare-graph bump.
    subjects: [subject({ subjectId: 'subject-kind-branch', rootRoomId: 'root-only', rooms: [room({ roomId: 'root-only' })] })],
  },
  {
    kind: 'creator.cross-link',
    expectsTarget: 'subject-kind-crosslink',
    subjects: [
      subject({
        subjectId: 'subject-kind-crosslink',
        rootRoomId: 'root-only',
        rooms: [
          room({ roomId: 'root-only' }),
          room({ roomId: 'linked-a', tags: ['alpha'] }),
          room({ roomId: 'linked-b', tags: ['ALPHA'] }),
        ],
        // No edge between the two tagged rooms, so the pair is unlinked.
        edges: [edge('root-only', 'linked-a')],
      }),
    ],
  },
  {
    kind: 'scribe.missing-section',
    expectsTarget: 'draft-room',
    subjects: [
      subject({
        subjectId: 'subject-kind-section',
        rootRoomId: 'root-only',
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: 'root-only' }),
          room({ roomId: 'draft-room', state: 'NotesDrafted', finalPass: false, missingSections: ['Summary'] }),
        ],
        edges: [edge('root-only', 'draft-room')],
      }),
    ],
  },
  {
    kind: 'scribe.related-topic',
    expectsTarget: 'related-room',
    subjects: [
      subject({
        subjectId: 'subject-kind-related',
        rootRoomId: 'root-only',
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: 'root-only' }),
          // `linkReferences: 0` with an adjacent room, and no missing section and no failed check,
          // so neither of the other two scribe rules claims it.
          room({ roomId: 'related-room', state: 'NotesDrafted', finalPass: false, criterionScores: { linkReferences: 0 } }),
        ],
        edges: [edge('root-only', 'related-room')],
      }),
    ],
  },
  {
    kind: 'scribe.rubric-hint',
    expectsTarget: 'rubric-room',
    subjects: [
      subject({
        subjectId: 'subject-kind-rubric',
        rootRoomId: 'root-only',
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: 'root-only' }),
          room({ roomId: 'rubric-room', state: 'NotesDrafted', finalPass: false, criterionScores: { conceptTermCoverage: 0 } }),
        ],
        edges: [edge('root-only', 'rubric-room')],
      }),
    ],
  },
  {
    kind: 'archaeologist.due-room',
    expectsTarget: 'due-room',
    subjects: [
      subject({
        subjectId: 'subject-kind-due',
        rootRoomId: 'root-only',
        rooms: [room({ roomId: 'root-only' }), room({ roomId: 'due-room', sm2NextReviewDate: iso(-3) })],
        edges: [edge('root-only', 'due-room')],
      }),
    ],
  },
  {
    kind: 'archaeologist.low-recall',
    expectsTarget: 'low-room',
    subjects: [
      subject({
        subjectId: 'subject-kind-lowrecall',
        rootRoomId: 'root-only',
        rooms: [room({ roomId: 'root-only' }), room({ roomId: 'low-room', sm2QualityResponse: 2 })],
        edges: [edge('root-only', 'low-room')],
      }),
    ],
  },
  {
    kind: 'fishing.navigation-after-miss',
    expectsTarget: 'missed-room',
    subjects: [
      subject({
        subjectId: 'subject-kind-fishing',
        rootRoomId: 'root-only',
        rooms: [room({ roomId: 'root-only' }), room({ roomId: 'missed-room' })],
        edges: [edge('root-only', 'missed-room')],
      }),
    ],
    // A recorded miss is required, and without one the rule refuses to invent a navigation target.
    signals: { fishingRecallMiss: 1 },
    fishing: { subjectId: 'subject-kind-fishing', lastMissedRoomId: 'missed-room', missedThisVisit: 1 },
  },
  {
    kind: 'device.due-today',
    expectsTarget: 'subject-kind-device',
    subjects: [
      subject({
        subjectId: 'subject-kind-device',
        rootRoomId: 'root-only',
        rooms: [room({ roomId: 'root-only' }), room({ roomId: 'device-due-room', sm2NextReviewDate: iso(-1) })],
        edges: [edge('root-only', 'device-due-room')],
      }),
    ],
  },
];

/** Every corpus state under every proactive mode. */
function allCases(): Array<{
  readonly label: string;
  readonly input: AssistanceEngineInput;
}> {
  const cases: Array<{ label: string; input: AssistanceEngineInput }> = [];
  for (const entry of CORPUS) {
    for (const mode of MODES) {
      cases.push({
        label: `${entry.name}/${mode}`,
        input: {
          mode,
          signals: { noteValidationFailure: 2, lowRecallRating: 1, repeatedDraft: 3, fishingRecallMiss: 1 },
          subjects: entry.subjects,
          nowIso: NOW,
          flagEnabled: true,
          study: STUDY,
          fishing: { subjectId: 'subject-full', lastMissedRoomId: 'room-due', missedThisVisit: 2 },
        },
      });
    }
  }
  return cases;
}

// ── Canonical bytes ─────────────────────────────────────────────────────────

/**
 * The exact bytes of a result, key order included.
 *
 * `JSON.stringify` without a replacer preserves **insertion order**, which is the property under
 * test: a module that built its result by iterating an object's own keys would emit the same
 * pairs in a different sequence and this string would differ. Comparing arrays with `toEqual`
 * would not notice, so the comparison here is on the serialised form and nowhere else.
 */
function bytesOf(value: unknown): string {
  return JSON.stringify(value);
}

// ── Case 1: identical state, identical bytes ────────────────────────────────

describe('identical state yields identical bytes', () => {
  it('every suggestion kind is reachable from a fixture of its own', () => {
    // One fixture per kind rather than "the big corpus produced all nine", because the modes
    // truncate: Gentle keeps six and Standard keeps four, so a single maximal state silently drops
    // the three lowest-ranked kinds and the coverage assertion would be reporting the mode's
    // `limit` rather than the engine's reach. That mistake is invisible in the output and easy to
    // make, which is why it is worth naming.
    //
    // The assertion is **containment**, not "exactly this one suggestion", and the distinction is a
    // fact about the engine rather than leniency in the gate. `scribeRubricHintRule` skips a room
    // that a `scribeMissingSectionRule` candidate already claims - "two suggestions about one
    // room's one failing note is one too many" - but it does **not** skip a room that
    // `scribeRelatedTopicRule` will claim, and `scribeRelatedTopicRule` skips nothing. So a room
    // whose `linkReferences` score is zero gets a rubric hint *and* a related-topic suggestion, and
    // there is no input for which `scribe.related-topic` fires alone. Asserting exclusivity would
    // have been asserting a property the engine does not have; see the co-firing test below, which
    // pins the real behaviour so a future change to it is deliberate.
    for (const fixture of PER_KIND) {
      const result = rankAssistance({
        mode: 'gentle',
        signals: fixture.signals ?? {},
        subjects: fixture.subjects,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
        fishing: fixture.fishing,
      });
      expect(result.suggestions.length, `the fixture for ${fixture.kind} produced nothing`).toBeGreaterThan(0);
      expect(
        result.suggestions.map((suggestion) => suggestion.kind),
        `the fixture for ${fixture.kind} did not produce it`,
      ).toContain(fixture.kind);
      // And the target it names is the room or subject the fixture built, so a rule that started
      // firing on the wrong target would fail rather than pass on the kind alone.
      const produced = result.suggestions.find((suggestion) => suggestion.kind === fixture.kind);
      expect(produced?.targetId).toBe(fixture.expectsTarget);
    }
    // And the table is complete: every declared kind has a fixture, so a tenth kind cannot be
    // added without one.
    expect(PER_KIND.map((fixture) => fixture.kind).sort()).toEqual([...ASSISTANCE_SUGGESTION_KINDS].sort());
  });

  it('two scribe rules fire on one room, which is real and is pinned here rather than wished away', () => {
    // The observation that forced the containment rule above, stated as its own assertion so it
    // reads as a finding about the engine and not as an accident of a fixture.
    //
    // `scribeRubricHintRule`'s own comment justifies skipping a room that `scribeMissingSectionRule`
    // already claimed, on the grounds that two suggestions about one room's one failing note is one
    // too many. `scribeRelatedTopicRule` makes no such claim and is skipped by nothing, so the same
    // principle is applied to one pair and not the other. Whether that is a defect is a call for
    // the engine's owner; what is not a call is that it is currently **undocumented and unpinned**,
    // which is what this test fixes.
    const shared = [
      subject({
        subjectId: 'subject-cofire',
        rootRoomId: 'root-only',
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: 'root-only' }),
          room({
            roomId: 'cofire-room',
            state: 'NotesDrafted',
            finalPass: false,
            criterionScores: { linkReferences: 0 },
          }),
        ],
        edges: [edge('root-only', 'cofire-room')],
      }),
    ];
    const result = rankAssistance({
      mode: 'gentle',
      signals: {},
      subjects: shared,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    const kinds = result.suggestions.map((suggestion) => suggestion.kind).sort();
    expect(kinds).toEqual(['scribe.related-topic', 'scribe.rubric-hint']);
    // Both name the same room, which is the whole of the observation.
    expect(new Set(result.suggestions.map((s) => s.targetId))).toEqual(new Set(['cofire-room']));

    // And the *other* pair really is exclusive, so the asymmetry is measured rather than assumed:
    // adding a missing section suppresses the rubric hint.
    const withSection = [
      subject({
        subjectId: 'subject-cofire',
        rootRoomId: 'root-only',
        phaseState: 'ScribeActive',
        rooms: [
          room({ roomId: 'root-only' }),
          room({
            roomId: 'cofire-room',
            state: 'NotesDrafted',
            finalPass: false,
            missingSections: ['Summary'],
            criterionScores: { linkReferences: 0, conceptTermCoverage: 0 },
          }),
        ],
        edges: [edge('root-only', 'cofire-room')],
      }),
    ];
    const withSectionResult = rankAssistance({
      mode: 'gentle',
      signals: {},
      subjects: withSection,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    // Adding a missing section suppresses the **rubric hint** - the rule reads
    // `missingRequiredSections(room)` and skips - and leaves the **related-topic** suggestion
    // standing. So the exclusivity the engine's own comment argues for is applied to one pair of
    // scribe rules and withheld from the other, and the withheld one is the pair a learner would
    // most plausibly read as two cards about the same note.
    expect(withSectionResult.suggestions.map((s) => s.kind).sort()).toEqual([
      'scribe.missing-section',
      'scribe.related-topic',
    ]);
    expect(withSectionResult.suggestions.map((s) => s.kind)).not.toContain('scribe.rubric-hint');
  });

  it('the comparator can actually order, so the tie-break is exercised rather than skipped', () => {
    // Non-vacuity for the tie-break. A corpus in which no two suggestions share a priority would
    // pass every ordering assertion below while never reaching the tie-break at all.
    // And the comparator can actually order: at least one case produced two suggestions at the
    // same priority, so the tie-break is exercised rather than skipped.
    let tieSeen = false;
    for (const entry of CORPUS) {
      const result = rankAssistance({
        mode: 'gentle',
        signals: {},
        subjects: entry.subjects,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
      });
      const counts = new Map<number, number>();
      for (const suggestion of result.suggestions) {
        counts.set(suggestion.priority, (counts.get(suggestion.priority) ?? 0) + 1);
      }
      if ([...counts.values()].some((count) => count > 1)) tieSeen = true;
    }
    expect(tieSeen, 'the corpus produced no equal-priority pair').toBe(true);
  });

  it('repeating a call changes nothing, byte for byte', () => {
    for (const testCase of allCases()) {
      const first = bytesOf(rankAssistance(testCase.input));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(bytesOf(rankAssistance(testCase.input)), `${testCase.label} drifted on repeat ${attempt}`).toBe(first);
      }
    }
  });

  it('shuffling rooms, edges, and subjects changes nothing, byte for byte', () => {
    // A reversal rather than a random permutation: it is a different order, it is deterministic
    // (so a failure reproduces), and it cannot accidentally return the identity for a symmetric
    // input. Reversal also flips the mixed-case id ordering, which is the case a `localeCompare`
    // tie-break would get wrong.
    const reverse = <T>(items: readonly T[]): T[] => [...items].reverse();
    const byId = (left: AssistanceSubjectInput, right: AssistanceSubjectInput): number =>
      left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0;

    for (const testCase of allCases()) {
      const original = bytesOf(rankAssistance(testCase.input));
      const shuffledSubjects = reverse([...testCase.input.subjects]).sort(byId);
      const shuffled = rankAssistance({ ...testCase.input, subjects: shuffledSubjects });
      expect(bytesOf(shuffled), `${testCase.label} changed when subjects were reordered`).toBe(original);
    }
  });

  it('the result is frozen, so a surface cannot mutate a shared suggestion', () => {
    const result = rankAssistance({
      mode: 'gentle',
      signals: {},
      subjects: CORPUS[2].subjects,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.suggestions)).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of result.suggestions) {
      expect(Object.isFrozen(suggestion)).toBe(true);
      expect(Object.isFrozen(suggestion.action)).toBe(true);
    }
  });

  it('the ranking comparator is a total order, and antisymmetry is checked by sum', () => {
    const results = CORPUS.map((entry) =>
      rankAssistance({
        mode: 'gentle',
        signals: {},
        subjects: entry.subjects,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
      }),
    );
    const everything = results.flatMap((result) => [...result.suggestions]);
    expect(everything.length).toBeGreaterThan(4);

    let nonZeroComparisons = 0;
    for (const left of everything) {
      for (const right of everything) {
        const forward = compareAssistanceSuggestions(left, right);
        const backward = compareAssistanceSuggestions(right, left);
        // `forward + backward === 0`, **not** `expect(forward).toBe(-backward)`.
        //
        // `toBe` is `Object.is`, and `Object.is(0, -0)` is `false`, so a `toBe(-backward)`
        // assertion fails on a correct comparator the moment it returns `-0` for an equal pair.
        // That is not hypothetical: a Phase 18 gate in this repository asserted `-f` and broke
        // on its own correct implementation. The sum is the property; the negation is an
        // accident of how the number was produced.
        expect(
          forward + backward,
          `comparator is not antisymmetric for ${left.suggestionId} / ${right.suggestionId}`,
        ).toBe(0);
        if (forward !== 0) {
          nonZeroComparisons += 1;
          // And the *sign* flips, which the sum alone would not catch for an asymmetric pair.
          expect(Math.sign(backward)).toBe(-Math.sign(forward));
        }
      }
    }
    // A comparator that returned 0 for everything would satisfy the sum. It did not.
    expect(nonZeroComparisons, 'the comparator never ordered anything').toBeGreaterThan(0);

    // Reflexivity, checked with `Object.is` deliberately: this is the one place `-0` is the
    // right question, because `-0` and `+0` must not be two different "equal" answers.
    for (const suggestion of everything) {
      expect(compareAssistanceSuggestions(suggestion, suggestion)).toBe(0);
      expect(Object.is(compareAssistanceSuggestions(suggestion, suggestion), -0)).toBe(false);
    }

    // Transitivity on the priority key alone, over the distinct priorities the corpus produced.
    const priorities = [...new Set(everything.map((s) => s.priority))].sort((a, b) => b - a);
    for (const high of priorities) {
      for (const middle of priorities) {
        for (const low of priorities) {
          if (high < middle || middle < low) continue;
          const a = everything.find((s) => s.priority === high) as AssistanceSuggestion;
          const b = everything.find((s) => s.priority === middle) as AssistanceSuggestion;
          const c = everything.find((s) => s.priority === low) as AssistanceSuggestion;
          if (compareAssistanceSuggestions(a, b) <= 0 && compareAssistanceSuggestions(b, c) <= 0) {
            expect(compareAssistanceSuggestions(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }

    // Why the comparator is total on the reachable domain, stated so it is not taken on trust.
    //
    // The comparator's key is `(priority, kind, targetId)`. De-duplication is by
    // `kind + '\n' + targetId`, so that composite is unique across the result and no two entries can
    // tie on all three keys. That is what makes the missing final tie-break safe, and it is the whole
    // totality argument.
    const TAB = String.fromCharCode(9);
    const compositeKeys = new Set<string>();
    const duplicateCompositeKeys: string[] = [];
    for (const suggestion of everything) {
      const key = [suggestion.priority, suggestion.kind, suggestion.targetId].join(TAB);
      if (compositeKeys.has(key)) duplicateCompositeKeys.push(key);
      compositeKeys.add(key);
    }
    expect(
      duplicateCompositeKeys,
      'two suggestions share (priority, kind, targetId), so the comparator is not a total order',
    ).toEqual([]);

    // And the finding that came out of writing a **stronger** version of this assertion first:
    // `(priority, targetId)` is *not* unique. A room that is both overdue and missing a required
    // section yields two suggestions on one target at one priority, distinguished only by `kind`.
    //
    // That makes the `kind` key load-bearing rather than decorative, which is worth recording
    // because `kind` is the key a refactor is most likely to drop as redundant - `suggestionId`
    // already contains it, and in a small corpus `targetId` looks unique. Dropping it does **not**
    // break determinism today: verified by mutation, because the remaining order is fixed by the
    // rule declaration order and the sorted room iteration, both properties of the code rather than
    // of the input. It would, however, leave the ordering resting on those two facts instead of on
    // the comparator, which is exactly the leak this module is built to avoid.
    const byPriorityAndTarget = new Map<string, Set<string>>();
    for (const suggestion of everything) {
      const key = [suggestion.priority, suggestion.targetId].join(TAB);
      const kinds = byPriorityAndTarget.get(key) ?? new Set<string>();
      kinds.add(suggestion.kind);
      byPriorityAndTarget.set(key, kinds);
    }
    const sharedTargets = [...byPriorityAndTarget.entries()].filter(([, kinds]) => kinds.size > 1);
    expect(
      sharedTargets.length,
      'no target is claimed by two kinds, so the kind key in the comparator is untested by this corpus',
    ).toBeGreaterThan(0);
  });

  it('ordering is by code unit, and the corpus would catch a locale collation', () => {
    // Non-vacuity for the whole locale claim, checked against a pair that genuinely disagrees
    // under this host's collation rather than one that merely looks adversarial.
    //
    // `'Beta-00'` against `'alpha-01'`: the `en-US` collation is case-insensitive at the primary
    // level, so it puts `alpha` first (returns a positive number for `Beta < alpha`); a code-unit
    // comparison puts `B` (U+0042) before `a` (U+0061). The two disagree on the *sign*, so any
    // comparison that reached for `localeCompare` would reorder the corpus and the byte comparison
    // above would fail.
    const ICU = Intl.DateTimeFormat().resolvedOptions().locale;
    expect('Beta-00'.localeCompare('alpha-01')).toBe(1);
    expect(compareCodeUnits('Beta-00', 'alpha-01')).toBe(-1);
    // Reported so a reader on a differently-collated host can see why the assertion above is
    // host-dependent and why the corpus ids were chosen the way they were.
    expect(ICU).toBe('en-US');

    const ids = CORPUS[3].subjects[0].rooms.map((r) => r.roomId);
    expect(ids.filter((id) => id.startsWith('Beta-')).length).toBeGreaterThan(4);
    expect(ids.filter((id) => id.startsWith('alpha-')).length).toBeGreaterThan(4);

    // The engine's own order is code-unit ascending: every uppercase id before every lowercase one.
    const sorted = [...ids].sort(compareCodeUnits);
    expect(sorted[0].startsWith('Beta-')).toBe(true);
    // ...and the locale order is the reverse of the uppercase/lowercase split, so the two are
    // distinguishable and a locale-sorted result would be visible.
    const byLocale = [...ids].sort((left, right) => left.localeCompare(right));
    expect(byLocale).not.toEqual(sorted);
    expect(byLocale[0].startsWith('alpha-')).toBe(true);
  });

  it('the same host time zone is not an input: the answer survives three zones', () => {
    // GitHub runners are UTC. A gate that only holds in UTC is a gate that does not exist, so the
    // corpus is ranked under UTC, a **half-hour** offset zone, and a DST zone.
    //
    // The runtime `process.env.TZ` assignment is honoured by V8's date cache, and the guard below
    // proves it took effect rather than assuming it: if a future runtime stopped honouring it,
    // `Date.parse` would return the same millisecond in all three zones and this test would pass
    // vacuously.
    const zones = ['UTC', 'Asia/Kolkata', 'America/New_York'] as const;
    const original = process.env.TZ;
    const probe = '2026-03-17T04:00:00';
    const observed: Record<string, number> = {};
    try {
      for (const zone of zones) {
        process.env.TZ = zone;
        observed[zone] = Date.parse(probe);
      }
    } finally {
      process.env.TZ = original;
    }
    // Two of the three must genuinely disagree, or the harness is inert.
    expect(new Set(Object.values(observed)).size).toBeGreaterThan(1);

    // The corpus, ranked under each zone. Every timestamp in the corpus is `Z`-suffixed, which is
    // what every writer in `src/` produces (`toISOString()`); the offset-less case is a separate
    // red gate and is named there.
    //
    // Compared **per case** rather than as one joined string: a join would let two adjacent cases'
    // outputs be confused for one, which is a false pass waiting for the corpus to grow.
    const perZone: string[][] = [];
    for (const zone of zones) {
      try {
        process.env.TZ = zone;
        perZone.push(allCases().map((testCase) => bytesOf(rankAssistance(testCase.input))));
      } finally {
        process.env.TZ = original;
      }
    }
    const labels = allCases().map((testCase) => testCase.label);
    for (const zone of [zones[1], zones[2]] as const) {
      const zoneIndex = zones.indexOf(zone);
      for (let index = 0; index < labels.length; index += 1) {
        expect(
          perZone[zoneIndex][index],
          `${labels[index]} ranked differently under ${zone} than under UTC`,
        ).toBe(perZone[0][index]);
      }
    }
  });

  it('a hostile signal map cannot move a suggestion to an arbitrary priority', () => {
    // A corrupt restored record is a real input: `resolveAssistanceSignals` documents that it
    // accepts one. The question is not "is the input rejected" but "what does a suggestion rank
    // when a signal is absurd", because an unbounded score would let a corrupt record drive the
    // ranking to whatever the learner sees first.
    const state = [
      subject({
        subjectId: 'subject-signals',
        rooms: [
          room({ roomId: 'room-root' }),
          room({ roomId: 'room-draft', finalPass: false, missingSections: ['Summary'] }),
        ],
        edges: [edge('room-root', 'room-draft')],
      }),
    ];
    const rankWith = (signals: Record<string, number>): AssistanceResult =>
      rankAssistance({ mode: 'standard', signals, subjects: state, nowIso: NOW, flagEnabled: true, study: STUDY });

    const hostile: Array<[string, Record<string, number>]> = [
      ['negative', { repeatedDraft: -500 }],
      ['NaN', { repeatedDraft: Number.NaN }],
      ['Infinity', { repeatedDraft: Infinity }],
      ['MAX_SAFE_INTEGER', { repeatedDraft: Number.MAX_SAFE_INTEGER }],
      ['fractional', { repeatedDraft: 2.9 }],
      ['fractional, rounds down', { repeatedDraft: 0.9 }],
      ['string', { repeatedDraft: '9' as unknown as number }],
      ['null', { repeatedDraft: null as unknown as number }],
      ['1e300', { repeatedDraft: 1e300 }],
      ['MAX_SAFE_INTEGER on lowRecall', { lowRecallRating: Number.MAX_SAFE_INTEGER }],
    ];
    for (const [label, signals] of hostile) {
      const resolved = resolveAssistanceSignals(signals);
      for (const key of ASSISTANCE_SIGNAL_KEYS) {
        expect(Number.isInteger(resolved[key]), `${label}: ${key} is not an integer`).toBe(true);
        expect(resolved[key], `${label}: ${key} is negative`).toBeGreaterThanOrEqual(0);
      }
      const result = rankWith(signals);
      for (const suggestion of result.suggestions) {
        expect(Number.isInteger(suggestion.priority), `${label}: priority is not an integer`).toBe(true);
        // The scoring ceiling is `MAX_PRIORITY`; the point of this assertion is that a corrupt
        // signal does not reach it and does not exceed it.
        expect(suggestion.priority, `${label}: priority out of range`).toBeGreaterThanOrEqual(0);
        expect(suggestion.priority, `${label}: priority out of range`).toBeLessThanOrEqual(100);
      }
    }

    // The saturation claim, made concrete rather than bounded. The draft bump is
    // `9 * min(count, 3)` over a base of 35, so the absurd signal saturates at 62 - a number
    // fixed by the constants, not by the value in the record.
    const absurd = rankWith({ repeatedDraft: Number.MAX_SAFE_INTEGER });
    const enormous = rankWith({ repeatedDraft: 1e300 });
    const modest = rankWith({ repeatedDraft: 99 });
    const draftAbsurd = absurd.suggestions.find((s) => s.targetId === 'room-draft');
    expect(draftAbsurd?.priority).toBe(62);
    expect(enormous.suggestions.find((s) => s.targetId === 'room-draft')?.priority).toBe(62);
    expect(modest.suggestions.find((s) => s.targetId === 'room-draft')?.priority).toBe(62);
    // And the resolved value itself is not silently truncated into a different count.
    expect(resolveAssistanceSignals({ repeatedDraft: Number.MAX_SAFE_INTEGER }).repeatedDraft).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('a restore onto a second device re-ranks to the same bytes as the live state', () => {
    // The determinism criterion *across a serialisation boundary*, which is the form that matters
    // and the one a pure-engine gate cannot see: rank from live state, then rank from the snapshot
    // the archive restored, and require the same bytes. If a restored record ranked differently
    // from the live one, "identical state yields identical assistance" would hold only until the
    // first backup and restore.
    const live = CORPUS[2].subjects;
    const restored = JSON.parse(JSON.stringify(live)) as AssistanceSubjectInput[];
    const fromLive = bytesOf(
      rankAssistance({ mode: 'gentle', signals: {}, subjects: live, nowIso: NOW, flagEnabled: true, study: STUDY }),
    );
    const fromRestored = bytesOf(
      rankAssistance({
        mode: 'gentle',
        signals: {},
        subjects: restored,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
      }),
    );
    // Non-vacuity: the restored state really is different *as an object* - `JSON.parse` built fresh
    // arrays and objects - so this is a round trip rather than an identity comparison.
    expect(restored).not.toBe(live);
    expect(restored[0].rooms).not.toBe(live[0].rooms);
    expect(fromRestored).toBe(fromLive);
  });

  it('an explanation derived from a restored state equals one derived from the live state', () => {
    const live = CORPUS[2].subjects;
    const restored = JSON.parse(JSON.stringify(live)) as AssistanceSubjectInput[];
    const result = rankAssistance({
      mode: 'gentle',
      signals: { repeatedDraft: 3 },
      subjects: live,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    for (const suggestion of result.suggestions) {
      const fromLive = bytesOf(
        explainAssistanceSuggestion(suggestion, { subjects: live, signals: { repeatedDraft: 3 }, study: STUDY, nowIso: NOW }),
      );
      const fromRestored = bytesOf(
        explainAssistanceSuggestion(suggestion, {
          subjects: restored,
          signals: { repeatedDraft: 3 },
          study: STUDY,
          nowIso: NOW,
        }),
      );
      expect(fromRestored, `${suggestion.kind} explained differently after a round trip`).toBe(fromLive);
    }
  });

  it('an explanation is a pure derivation, so two devices cannot disagree about it', () => {
    const result = rankAssistance({
      mode: 'gentle',
      signals: { noteValidationFailure: 2, lowRecallRating: 1, repeatedDraft: 3, fishingRecallMiss: 1 },
      subjects: CORPUS[2].subjects,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    expect(result.suggestions.length).toBeGreaterThan(0);

    for (const suggestion of result.suggestions) {
      const first = bytesOf(
        explainAssistanceSuggestion(suggestion, {
          subjects: CORPUS[2].subjects,
          signals: { noteValidationFailure: 2, lowRecallRating: 1, repeatedDraft: 3, fishingRecallMiss: 1 },
          study: STUDY,
          nowIso: NOW,
        }),
      );
      const second = bytesOf(
        explainAssistanceSuggestion(suggestion, {
          // Every collection in a different order, and the signals' keys in a different order.
          subjects: [...CORPUS[2].subjects].reverse(),
          signals: { fishingRecallMiss: 1, repeatedDraft: 3, lowRecallRating: 1, noteValidationFailure: 2 },
          study: STUDY,
          nowIso: NOW,
        }),
      );
      expect(second, `the explanation of ${suggestion.kind} is order-dependent`).toBe(first);
    }
  });

  it('re-ranking after a `collectAssistanceSignals` round trip is byte-identical', () => {
    // `collectAssistanceSignals` is what a caller persists. If the persisted map re-ranked
    // differently from the live one, the determinism criterion would hold only until the first
    // save - which is exactly the class of bug that survives until a learner reinstalls.
    const live = CORPUS[2].subjects;
    const collected = collectAssistanceSignals({ subjects: live, stored: { repeatedDraft: 4 } });
    const fromLive = bytesOf(
      rankAssistance({ mode: 'gentle', signals: {}, subjects: live, nowIso: NOW, flagEnabled: true, study: STUDY }),
    );
    const fromCollected = bytesOf(
      rankAssistance({
        mode: 'gentle',
        signals: collected,
        subjects: live,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
      }),
    );
    // The signals do change the result - otherwise this leg proves nothing.
    expect(fromCollected).not.toBe(fromLive);
    // But the *stored* signal round-trips: re-merging the same patch over the same base produces
    // the same map, in the same key order, so a second save cannot change a third.
    const once = mergeAssistanceSignals(collected, { repeatedDraft: 4 });
    const twice = mergeAssistanceSignals(once, { repeatedDraft: 4 });
    expect(Object.keys(twice)).toEqual(Object.keys(once));
    expect(bytesOf(twice)).toBe(bytesOf(once));
  });
});

// ── Case 2: local, explainable, textless ────────────────────────────────────

describe('assistance is local, explainable, and textless', () => {
  it('the engine source contains no ambient clock, randomness, locale, or storage', () => {
    // A source scan is the only check that covers a code path no fixture reached.
    //
    // Comments are stripped first, and that is not a convenience: the module header *names* every
    // forbidden token in prose - "There is no `Date.now()`, no `new Date()`, no `Math.random()`,
    // no `crypto`, no `performance`, no `Intl`" - so an unstripped scan fails on the very sentence
    // that documents the property. Stripping also makes this a check on **executable** code, which
    // is the correct subject: a token in a comment cannot change an answer.
    //
    // `stripComments` is the QA-owned helper from `tests/privacy/support/appGraph.ts`. It is
    // borrowed deliberately: it is a generic lexer utility, not the property under test, and the
    // property under test is "the assistance source contains no ambient input", which this file
    // asserts for itself.
    const dir = 'src/core/assistance';
    const files = ['assistanceEngine.ts', 'types.ts', 'subjectInput.ts', 'index.ts'];
    const forbidden: Array<[string, RegExp]> = [
      ['Date.now', /\bDate\.now\b/],
      ['new Date', /\bnew\s+Date\b/],
      ['Math.random', /\bMath\.random\b/],
      ['crypto', /\bcrypto\b/],
      ['performance', /\bperformance\b/],
      ['Intl', /\bIntl\b/],
      ['localeCompare', /\blocaleCompare\b/],
      ['toLocaleLowerCase/UpperCase', /\btoLocale(?:Lower|Upper)Case\b/],
      ['localStorage', /\blocalStorage\b/],
      ['indexedDB', /\bindexedDB\b/],
      ['fetch', /\bfetch\s*\(/],
      ['XMLHttpRequest', /\bXMLHttpRequest\b/],
      ['document', /\bdocument\b/],
      ['window', /\bwindow\b/],
      // Ambient logging: a suggestion reaching a log line is the first step of learner data
      // leaving the device, and the plan forbids learner data in reports.
      ['console', /\bconsole\s*\./],
    ];
    for (const file of files) {
      const path = join(process.cwd(), dir, file);
      expect(existsSync(path), `${file} is missing`).toBe(true);
      const source = stripComments(readFileSync(path, 'utf8'));
      for (const [label, pattern] of forbidden) {
        expect(pattern.test(source), `${file} contains ${label} in executable code`).toBe(false);
      }
    }

    // Non-vacuity for the scan itself, both directions. The stripper is not deleting the whole
    // file (which would make every assertion above pass for the wrong reason), and the forbidden
    // patterns do fire on a string that really contains them.
    const sample = stripComments(readFileSync(join(process.cwd(), dir, 'assistanceEngine.ts'), 'utf8'));
    expect(sample.length, 'stripComments emptied the file').toBeGreaterThan(1000);
    expect(/\brankAssistance\b/.test(sample), 'stripComments removed executable code').toBe(true);
    expect(/\bfetch\s*\(/.test(`function x(){ fetch('https://collector.invalid/x'); }`)).toBe(true);
    expect(/\bconsole\s*\./.test(`function x(){ console.warn('y'); }`)).toBe(true);
  });

  it('the engine module graph reaches no store, service, DOM, or network', () => {
    // An independent walker, written here rather than imported from `tests/privacy/support/`
    // or `tests/phase19/`, for the reason the privacy gate's own header gives: a gate that shares
    // an implementation with the thing it verifies can only agree with itself.
    const SRC = join(process.cwd(), 'src');
    const seen = new Set<string>();
    const queue = ['core/assistance/index.ts'];
    const edges: Array<{ from: string; to: string }> = [];
    while (queue.length > 0) {
      const relativePath = queue.shift() as string;
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const absolute = join(SRC, relativePath);
      if (!existsSync(absolute)) continue;
      const source = stripComments(readFileSync(absolute, 'utf8'));
      const specifiers = [
        ...source.matchAll(/(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]/g),
        ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        let target: string | null = null;
        if (specifier.startsWith('@/')) {
          target = specifier.slice(2);
        } else if (specifier.startsWith('.')) {
          // `relativePath` is `src/`-relative, so resolve against `SRC` and reduce back,
          // or every target comes out absolute and no file is ever found.
          target = relative(SRC, resolvePath(SRC, dirname(relativePath), specifier)).replace(/\\/g, '/');
        }
        if (target === null) continue;
        if (!target.endsWith('.ts')) target = `${target}.ts`;
        if (!existsSync(join(SRC, target))) continue;
        edges.push({ from: relativePath, to: target });
        queue.push(target);
      }
    }

    // The walk reached something real, so "no forbidden edge" is a statement about a graph and
    // not about an empty set.
    expect([...seen].sort()).toEqual([
      'core/assistance/assistanceEngine.ts',
      'core/assistance/index.ts',
      'core/assistance/subjectInput.ts',
      'core/assistance/types.ts',
      'core/validation/notes/types.ts',
      'core/validation/persistence/types.ts',
    ]);

    for (const edge of edges) {
      expect(
        edge.to.startsWith('core/'),
        `${edge.from} imports ${edge.to}, which is outside src/core/`,
      ).toBe(true);
    }
  });

  it('no suggestion member is a function, and no suggestion carries a callable anywhere', () => {
    const result = rankAssistance({
      mode: 'gentle',
      signals: {},
      subjects: CORPUS[2].subjects,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    expect(result.suggestions.length).toBeGreaterThan(0);

    // A recursive walk rather than a top-level check: a callable nested three levels down is
    // exactly what "a suggestion cannot be invoked" has to mean, and a top-level check would not
    // see it.
    const callables: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') {
        callables.push(path);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        walk(entry, `${path}.${key}`);
      }
    };
    for (const suggestion of result.suggestions) walk(suggestion, suggestion.kind);
    expect(callables, `a suggestion carries a callable: ${callables.join(', ')}`).toEqual([]);

    // And the same over a whole result, so `evaluatedRuleKinds` and `emptyReason` are included.
    walk(result, 'result');
    expect(callables).toEqual([]);
  });

  it('every suggestion field is a number, a closed-vocabulary string, or an app-minted id', () => {
    const result = rankAssistance({
      mode: 'gentle',
      signals: {},
      subjects: CORPUS[2].subjects,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    const kinds = new Set<string>(ASSISTANCE_SUGGESTION_KINDS);
    const evidenceKeys = new Set<string>(ASSISTANCE_EVIDENCE_KEYS);
    const criteria = new Set<string>(QUALITY_SCORE_KEYS);
    const sections = new Set<string>(REQUIRED_NOTE_SECTIONS);

    for (const suggestion of result.suggestions) {
      expect(kinds.has(suggestion.kind)).toBe(true);
      expect(['creator', 'scribe', 'archaeologist', 'fishing', 'device']).toContain(suggestion.surface);
      expect(['cue', 'step', 'example']).toContain(suggestion.intensity);
      expect(Number.isInteger(suggestion.priority)).toBe(true);
      expect(Number.isInteger(suggestion.signalValue)).toBe(true);
      // `detail` is the only free-ish string in a suggestion, and it is constrained to two
      // app-owned vocabularies plus an app-minted id. That constraint is what makes "no prose can
      // reach a suggestion" a checkable statement rather than a promise.
      if (suggestion.action.detail !== null) {
        const isVocabulary =
          criteria.has(suggestion.action.detail) ||
          sections.has(suggestion.action.detail) ||
          CORPUS[2].subjects.some((s) => s.rooms.some((r) => r.roomId === suggestion.action.detail));
        expect(isVocabulary, `unexpected detail "${suggestion.action.detail}"`).toBe(true);
      }
      const explanation = explainAssistanceSuggestion(suggestion, {
        subjects: CORPUS[2].subjects,
        signals: {},
        study: STUDY,
        nowIso: NOW,
      });
      for (const row of explanation.evidence) {
        expect(evidenceKeys.has(row.labelKey), `unexpected evidence key "${row.labelKey}"`).toBe(true);
        expect(Number.isInteger(row.value)).toBe(true);
      }
    }
  });

  it('the explanation carries i18n keys, never a sentence', () => {
    const result = rankAssistance({
      mode: 'gentle',
      signals: { repeatedDraft: 3 },
      subjects: CORPUS[2].subjects,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    for (const suggestion of result.suggestions) {
      const explanation = explainAssistanceSuggestion(suggestion, {
        subjects: CORPUS[2].subjects,
        signals: { repeatedDraft: 3 },
        study: STUDY,
        nowIso: NOW,
      });
      expect(explanation.titleKey.startsWith('assistance.title.')).toBe(true);
      expect(explanation.detailKey.startsWith('assistance.detail.')).toBe(true);
      // A key has no spaces; a sentence has at least one. This is the structural form of "the
      // engine holds no text", and it does not depend on the locale section existing yet - the
      // `village-content-designer` is writing `assistance.*` in parallel and this gate must not
      // wait for it, nor fail when it lands.
      expect(explanation.titleKey).not.toMatch(/\s/);
      expect(explanation.detailKey).not.toMatch(/\s/);
      // No room prose, no topic, no note text: the engine never received any, and every id in an
      // explanation is an id the corpus minted.
      const text = bytesOf(explanation);
      expect(text).not.toContain('Synthetic Topic');
      expect(text).not.toContain('Draft');
    }
  });

  it('a room topic cannot reach a suggestion, because no rule reads one', () => {
    // The adapter is the only bridge, and `AssistanceRoomInput` does carry a `topic` field - so
    // the honest check is not "the field does not exist" but "no rule reads it into a result".
    const secretTopic = 'zzz-learner-chosen-topic-that-must-not-be-echoed';
    const state = [
      subject({
        subjectId: 'subject-secret',
        rooms: [
          room({ roomId: 'room-root', topic: secretTopic }),
          room({ roomId: 'room-draft', topic: secretTopic, finalPass: false, missingSections: ['Summary'] }),
        ],
        edges: [edge('room-root', 'room-draft')],
      }),
    ];
    const result = rankAssistance({
      mode: 'gentle',
      signals: {},
      subjects: state,
      nowIso: NOW,
      flagEnabled: true,
      study: STUDY,
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(bytesOf(result)).not.toContain(secretTopic);
    for (const suggestion of result.suggestions) {
      const explanation = explainAssistanceSuggestion(suggestion, {
        subjects: state,
        signals: {},
        study: STUDY,
        nowIso: NOW,
      });
      expect(bytesOf(explanation)).not.toContain(secretTopic);
    }
  });

  it('mode is a closed set and a total narrowing, so no fourth mode can appear', () => {
    expect(isAssistanceMode('off')).toBe(true);
    expect(isAssistanceMode('gentle')).toBe(true);
    expect(isAssistanceMode('standard')).toBe(true);
    expect(isAssistanceMode('Standard')).toBe(false);
    expect(isAssistanceMode('')).toBe(false);
    expect(isAssistanceMode(null)).toBe(false);
    expect(isAssistanceMode(7)).toBe(false);
  });
});

// ── Case 3: off removes proactive suggestions, structurally ────────────────

describe('off removes proactive suggestions structurally', () => {
  const maximal = {
    signals: {
      noteValidationFailure: 25,
      lowRecallRating: 25,
      repeatedDraft: 25,
      fishingRecallMiss: 25,
    },
    subjects: CORPUS[2].subjects,
    nowIso: NOW,
    flagEnabled: true,
    study: STUDY,
    fishing: { subjectId: 'subject-full', lastMissedRoomId: 'room-due', missedThisVisit: 99 },
  } satisfies Omit<AssistanceEngineInput, 'mode'>;

  it('the proactive half of the engine produces suggestions, so `off` means something', () => {
    // Every signal is at a value that saturates every cap, the fishing context names a room the
    // corpus really holds, and the study aggregate clears the Standard-mode gate. Stated as a
    // literal object rather than derived from the corpus, because the Phase 19 suite recorded a
    // fixture built by `Object.fromEntries` over same-keyed maps that kept only the last value and
    // quietly weakened every "Off produced nothing" assertion in the file.
    for (const mode of MODES) {
      const result = rankAssistance({ ...maximal, mode });
      expect(result.suggestions.length, `${mode} produced nothing`).toBeGreaterThan(0);
      expect(result.emptyReason).toBeNull();
      expect(result.evaluatedRuleKinds.length).toBeGreaterThan(0);
    }
    // And the maximum is wide: the corpus is not producing one incidental suggestion.
    expect(rankAssistance({ ...maximal, mode: 'gentle' }).suggestions.length).toBeGreaterThan(3);
  });

  it('off produces no suggestions and reports no evaluated rule', () => {
    for (const subjectSet of CORPUS.map((entry) => entry.subjects)) {
      const result = rankAssistance({ ...maximal, subjects: subjectSet, mode: 'off' });
      expect(result.suggestions).toEqual([]);
      expect(result.emptyReason).toBe('mode-off');
      expect(result.mode).toBe('off');
      // The load-bearing half. "No suggestions are shown" and "no suggestion was ever computed"
      // are different claims, and a filter applied after every rule has read the learner's state
      // satisfies only the first.
      expect(result.evaluatedRuleKinds, 'a rule ran in off mode').toEqual([]);
    }
  });

  it('the flag-off path is a separate early exit, also with no evaluated rule', () => {
    const result = rankAssistance({ ...maximal, mode: 'standard', flagEnabled: false });
    expect(result.suggestions).toEqual([]);
    expect(result.emptyReason).toBe('flag-disabled');
    // `mode` is echoed rather than coerced: a rollback build must not rewrite a preference.
    expect(result.mode).toBe('standard');
    expect(result.evaluatedRuleKinds).toEqual([]);
  });

  it('the proactive entry point refuses `off` at run time as well as at compile time', () => {
    // The compile-time half is the `@ts-expect-error` below, which fails `npm run typecheck` the
    // moment the parameter type widens. This is the half that survives a hand-edited bundle, a
    // `postMessage`, or an `as never` cast in a test.
    expect(() =>
      rankProactiveAssistance({ ...maximal, mode: 'off' as never }),
    ).toThrow(/rankProactiveAssistance was called with mode "off"/);

    // Compile-time, asserted by the type checker rather than by this file. If the parameter type
    // ever accepts `off`, the `@ts-expect-error` becomes an unused directive and `npm run
    // typecheck` fails. That is the structural claim, made load-bearing.
    //
    // The call is inside a function that is **defined and never invoked**: the directive has to be
    // attached to a real call expression for the type checker to check it, and a call expression
    // that runs would throw for the reason the previous assertion already established.
    const neverCalled = (): void => {
      rankProactiveAssistance({
        // @ts-expect-error `off` must not be assignable to `ProactiveAssistanceMode`.
        mode: 'off',
        signals: {},
        subjects: [],
        nowIso: NOW,
        flagEnabled: true,
      });
    };
    expect(typeof neverCalled).toBe('function');
  });

  it('a filter-based off would pass every other observable, which is why one field is load-bearing', () => {
    // The counterfactual, stated rather than assumed. A filter-based implementation - run every
    // rule, then drop the results - produces a result that agrees with the real `off` on `mode`,
    // on `emptyReason`, and on `suggestions`, and differs **only** in `evaluatedRuleKinds`.
    const proactive = rankAssistance({ ...maximal, mode: 'gentle' });
    const filterBasedOff: AssistanceResult = {
      mode: 'off',
      suggestions: Object.freeze([]),
      emptyReason: 'mode-off',
      // A filter reports the rules it ran, because they *did* run.
      evaluatedRuleKinds: proactive.evaluatedRuleKinds,
    };
    const realOff = rankAssistance({ ...maximal, mode: 'off' });

    expect(filterBasedOff.suggestions).toEqual(realOff.suggestions);
    expect(filterBasedOff.emptyReason).toBe(realOff.emptyReason);
    expect(filterBasedOff.mode).toBe(realOff.mode);
    // ...and differs on exactly one observable, which is the one the gate asserts.
    expect(bytesOf(filterBasedOff.evaluatedRuleKinds)).not.toBe(bytesOf(realOff.evaluatedRuleKinds));
    // The filter would have computed a non-trivial answer, so this is not a filter over nothing.
    expect(proactive.suggestions.length).toBeGreaterThan(3);
    expect(filterBasedOff.evaluatedRuleKinds.length).toBeGreaterThan(3);
  });

  it('`evaluatedRuleKinds` is reported in declaration order, not execution order', () => {
    const result = rankAssistance({ ...maximal, mode: 'gentle' });
    const order = result.evaluatedRuleKinds;
    const declaredIndex = new Map(ASSISTANCE_SUGGESTION_KINDS.map((kind, index) => [kind, index]));
    const indices = order.map((kind) => declaredIndex.get(kind) as number);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    // Every declared kind ran in this state, so the list is the whole vocabulary.
    expect(order).toEqual([...ASSISTANCE_SUGGESTION_KINDS]);
  });

  it('intensity is a pure function of mode and priority, so a surface cannot disagree', () => {
    expect(intensityFor('gentle', 39)).toBe('step');
    expect(intensityFor('gentle', 40)).toBe('example');
    expect(intensityFor('standard', 40)).toBe('cue');
    expect(intensityFor('standard', 70)).toBe('step');
    // A surface that re-derived intensity could not produce this from the suggestion alone.
    const result = rankAssistance({ ...maximal, mode: 'gentle' });
    for (const suggestion of result.suggestions) {
      expect(suggestion.intensity).toBe(intensityFor('gentle', suggestion.priority));
    }
  });
});

// ── Case 4: suggestions cannot write ────────────────────────────────────────

describe('suggestions cannot write', () => {
  it('ranking fifty times and dismissing ten times moves nothing but the assistance record', () => {
    // A fingerprint of everything a suggestion could conceivably have moved, with keys sorted at
    // every level so a difference means a difference. `localStorage` is read key by key, so a new
    // key is a difference rather than an invisible addition.
    const snapshot = (): string => {
      const legacy: Record<string, string | null> = {};
      for (const key of Object.keys(window.localStorage).sort()) {
        if (key === ASSISTANCE_STORAGE_KEY) continue;
        legacy[key] = window.localStorage.getItem(key);
      }
      const canonical = (value: unknown): unknown => {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(canonical);
        const record = value as Record<string, unknown>;
        const reduced: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
          if (record[key] === undefined) continue;
          reduced[key] = canonical(record[key]);
        }
        return reduced;
      };
      return JSON.stringify(
        canonical({
          legacy,
          progression: useProgressionStore.getState(),
          subject: useSubjectStore.getState(),
          session: useSessionStore.getState(),
        }),
      );
    };

    // Non-vacuity, direction one: the fingerprint is **substantial**. A comparison over an empty
    // baseline proves nothing, and this is the single most common way a gate of this shape passes
    // for the wrong reason.
    window.localStorage.setItem('synthetic.other.key', JSON.stringify({ note: 'must never be read' }));
    const before = snapshot();
    expect(before.length, 'the fingerprint is empty').toBeGreaterThan(200);
    expect(before).toContain('must never be read');

    for (let round = 0; round < 50; round += 1) {
      rankAssistance({
        mode: round % 2 === 0 ? 'gentle' : 'standard',
        signals: { noteValidationFailure: round, lowRecallRating: round % 7, repeatedDraft: round % 11, fishingRecallMiss: round % 3 },
        subjects: CORPUS[2].subjects,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
      });
    }
    for (let dismissal = 0; dismissal < 10; dismissal += 1) {
      useAssistanceStore.getState().dismissSuggestion();
    }
    expect(snapshot()).toBe(before);

    // Non-vacuity, direction two: the fingerprint is **movable**. A control write that touches a
    // non-assistance surface must change it, or the comparison above is dead code.
    useProgressionStore.setState({ xpTotal: (useProgressionStore.getState().xpTotal ?? 0) + 1 } as never);
    expect(snapshot(), 'a real write did not move the fingerprint').not.toBe(before);
    useProgressionStore.setState({ xpTotal: 0 } as never);

    // Non-vacuity, direction three: the assistance mirror *is* written, so the gate is not
    // passing because the whole store is inert.
    useAssistanceStore.setState({ dismissalCount: 0 });
    useAssistanceStore.getState().dismissSuggestion();
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).not.toBeNull();
  });

  it('25 dismissals then a rank is byte-identical to a rank on a fresh store, in both proactive modes', () => {
    // The plan requires dismissal to be non-punitive, and the store's header states that
    // `dismissalCount` "is not an input to `rankAssistance`". A claim like that is only worth
    // something if it is measured **after** the dismissals rather than on a pristine store.
    //
    // **The rank reads the store's own signals**, which is the detail that makes this a gate rather
    // than a tautology. The first version of this test passed a hardcoded `signals` literal, and a
    // mutation that made `dismissSuggestion` raise `repeatedDraft` in the store left it **green** -
    // because the engine is a pure function of its input, so a rank built from constants cannot
    // possibly be affected by anything the store did. Reading `getState().signals` is what a
    // surface does, and it is the only way a punitive store can show up here. Verified: with the
    // mutation applied, this test goes red.
    //
    // Twenty-five rather than ten because 25 is past every cap the engine applies (the largest cap
    // is four extra rubric criteria and three extra repeated drafts), so a count-dependent effect
    // would have saturated rather than merely started.
    const rankWithStoreSignals = (mode: 'gentle' | 'standard'): string =>
      bytesOf(
        rankAssistance({
          mode,
          signals: useAssistanceStore.getState().signals,
          subjects: CORPUS[2].subjects,
          nowIso: NOW,
          flagEnabled: true,
          study: STUDY,
          fishing: { subjectId: 'subject-full', lastMissedRoomId: 'room-due', missedThisVisit: 2 },
        }),
      );
    const suggestionCount = (mode: 'gentle' | 'standard'): number =>
      rankAssistance({
        mode,
        signals: useAssistanceStore.getState().signals,
        subjects: CORPUS[2].subjects,
        nowIso: NOW,
        flagEnabled: true,
        study: STUDY,
        fishing: { subjectId: 'subject-full', lastMissedRoomId: 'room-due', missedThisVisit: 2 },
      }).suggestions.length;

    for (const mode of ['gentle', 'standard'] as const) {
      // A fresh store, with a signal map that is not empty - a comparison over an empty signal map
      // would be satisfied by any engine that ignores signals entirely.
      useAssistanceStore.setState({
        mode,
        signals: { noteValidationFailure: 2, lowRecallRating: 1, repeatedDraft: 3, fishingRecallMiss: 1 },
        dismissalCount: 0,
      });
      const before = rankWithStoreSignals(mode);
      expect(before.length, `${mode}: the baseline is empty`).toBeGreaterThan(200);
      expect(suggestionCount(mode), `${mode}: the baseline produced no suggestions`).toBeGreaterThan(0);

      for (let dismissal = 0; dismissal < 25; dismissal += 1) {
        useAssistanceStore.getState().dismissSuggestion();
      }
      expect(useAssistanceStore.getState().dismissalCount, 'the dismissals did not register').toBe(25);

      // The property: identical bytes, and an unchanged signal map.
      expect(rankWithStoreSignals(mode), `a rank after 25 dismissals differed in ${mode} mode`).toBe(before);
      expect(
        useAssistanceStore.getState().signals,
        `a dismissal changed the signal map in ${mode} mode`,
      ).toEqual({ noteValidationFailure: 2, lowRecallRating: 1, repeatedDraft: 3, fishingRecallMiss: 1 });
    }

    // Non-vacuity across the modes: the two baselines genuinely differ, so the test is comparing two
    // real answers rather than one answer to itself.
    useAssistanceStore.setState({ mode: 'gentle', signals: {}, dismissalCount: 0 });
    const gentleOnEmptySignals = rankWithStoreSignals('gentle');
    useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 0 });
    expect(gentleOnEmptySignals, 'the two modes produced identical output, so the loop proved nothing').not.toBe(
      rankWithStoreSignals('standard'),
    );
  });
});

// ── Case 5: backup and restore ──────────────────────────────────────────────

const SUBJECT_ID = 'synthetic-backup-subject';
const ROOM_ID = 'synthetic-backup-room';
const SUBJECT_NAME = 'Synthetic Backup Subject';
const ROOM_TOPIC = 'Synthetic Backup Topic';
const NOTE_PROSE = 'synthetic note prose that must never be exported by assistance';

/**
 * A real `SubjectSnapshot` for the archive products, carrying note prose on purpose.
 *
 * The prose is here so the privacy assertions below have something to lose: an archive that carried
 * no prose could not fail a "the archive carries no prose" check. Every value is synthetic.
 *
 * `sm2NextReviewDate` is written `Z`-suffixed, matching every writer in `src/`. The offset-less
 * form is deliberately **not** used here; it is a defect held red in a separate file, and mixing a
 * known-defective input into a passing gate would hide it.
 */
function syntheticSnapshot(): SubjectSnapshot {
  const room = (finalPass: boolean) => ({
    roomId: ROOM_ID,
    topic: ROOM_TOPIC,
    createdAt: NOW,
    updatedAt: NOW,
    state: (finalPass ? 'EncounterDefeated' : 'NotesDrafted') as 'EncounterDefeated',
    notePath: `rooms/${ROOM_ID}/notes.txt`,
    artifactPath: `rooms/${ROOM_ID}/artifact.md`,
    noteText: `# ${ROOM_TOPIC}\n${NOTE_PROSE}`,
    artifactMarkdown: `# ${ROOM_TOPIC} artifact`,
    validationState: {
      wordCount: finalPass ? 220 : 40,
      requiredSectionsPresent: finalPass,
      manualConfirmed: finalPass,
      criterionScores: {
        sectionCompleteness: finalPass ? 2 : 0,
        conceptTermCoverage: finalPass ? 2 : 0,
        linkReferences: finalPass ? 2 : 0,
        recallQuestionQuality: finalPass ? 2 : 1,
        clarityReadability: finalPass ? 2 : 1,
      },
      failedChecks: finalPass ? [] : ['VAL_REQUIRED_SECTION_MISSING'],
      qualityBonus: finalPass ? 10 : 2,
      finalPass,
    },
    reviewPassCount: finalPass ? 1 : 0,
    attachments: [],
    sm2QualityResponse: finalPass ? 5 : null,
    sm2NextReviewDate: finalPass ? NOW : null,
  });
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
      createdAt: NOW,
      updatedAt: NOW,
      phaseState: 'ArchaeologistUnlocked',
      rootRoomId: ROOM_ID,
      rooms: [{ roomId: ROOM_ID, topic: ROOM_TOPIC, status: 'EncounterDefeated' }],
      edges: [],
      progression: { xpTotal: 320, rank: 'Scholar', badges: ['synthetic-badge'], fishCollection: [] },
    },
    rooms: {
      [ROOM_ID]: room(true),
      'synthetic-draft-room': { ...room(false), roomId: 'synthetic-draft-room', topic: 'Draft Topic' },
    },
  } as SubjectSnapshot;
}

/**
 * Values that must never appear in an **assistance** payload: a subject id, a room id, a topic, and
 * note prose. Asserted against the assistance section only, never against a whole `.kdbak` - a
 * full-device backup legitimately contains all four, because that is what it is.
 */
const FORBIDDEN_IN_ASSISTANCE = [SUBJECT_ID, ROOM_ID, SUBJECT_NAME, ROOM_TOPIC, NOTE_PROSE];

describe('assistance survives backup and restore', () => {
  const RECORD: AssistanceRecordValue = {
    assistanceId: 'default',
    mode: 'gentle',
    signals: {
      noteValidationFailure: 7,
      lowRecallRating: 3,
      repeatedDraft: 12,
      fishingRecallMiss: 5,
      'future.build.signal': 99,
    },
    dismissalCount: 4,
    updatedAt: NOW,
  };
  let source: Awaited<ReturnType<typeof openStorageV2Repository>> | null = null;
  let generationId = '';
  let counter = 0;

  beforeEach(async () => {
    counter += 1;
    source = await openStorageV2Repository({
      databaseName: `qa19-product-source-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`qa19-product-source-${counter}`),
    });
    generationId = await ensureInitialGeneration(source, {
      generationId: INITIAL_GENERATION_ID,
      now: NOW,
    });
    await source.putRecords(generationId, {
      subjects: [
        { subjectId: SUBJECT_ID, schemaVersion: '1.1.0', snapshot: syntheticSnapshot(), createdAt: NOW, updatedAt: NOW },
      ],
      assistance: [RECORD],
    });
  });

  afterEach(() => {
    source?.close();
    source = null;
  });

  it('the generation really holds the record, before any product is involved', () => {
    // Every assertion below is "the record survived", and a generation with no assistance record
    // satisfies all of them. This is the anti-vacuity guard, and it runs first.
    expect(source).not.toBeNull();
  });

  it('.kdbak carries the record into a different device, value for value', async () => {
    const stored = await source?.readRecords(generationId);
    expect(stored?.records.assistance).toHaveLength(1);
    expect(stored?.records.assistance[0].value).toEqual(RECORD);

    const exported = await exportFullDeviceBackup({
      repository: source as NonNullable<typeof source>,
      generationId,
      now: NOW,
      activeSubjectId: SUBJECT_ID,
    });
    expect(exported.manifest.recordCounts.assistance).toBe(1);

    // A fresh database, so nothing can be satisfied by the record already being present.
    const target = await openStorageV2Repository({
      databaseName: `qa19-product-target-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`qa19-product-target-${counter}`),
    });
    try {
      expect(
        (
          await target.readRecords(
            (await target.readActiveGenerationId()) as string,
          )
        ).records.assistance,
        'the target started with the record already in it',
      ).toEqual([]);
      const imported = await importFullDeviceBackup({ repository: target, bytes: exported.bytes, now: NOW });
      expect(
        imported.activated,
        imported.disclosedWarnings.map((w) => `${w.code}:${w.scope}`).join(','),
      ).toBe(true);
      expect(imported.disclosedWarnings.filter((w) => w.severity === 'error')).toEqual([]);
      const restored = await target.readRecords((await target.readActiveGenerationId()) as string);
      expect(restored.records.assistance).toHaveLength(1);
      expect(restored.records.assistance[0].value).toEqual(RECORD);

      // On the wire the record's key order is the **storage layer's**, not the caller's. Measured
      // rather than assumed: a restore that preserved the caller's key order and one that imposed
      // its own are different properties, and asserting the wrong one fails for the right reason.
      expect(JSON.stringify(restored.records.assistance[0].value)).not.toBe(JSON.stringify(RECORD));

      // What actually has to hold is that the order is **stable** - so a second export from a
      // restored device is byte-identical, and two devices that restored the same archive emit the
      // same bytes. That is the determinism criterion applied to a persisted value.
      const firstReExport = await exportFullDeviceBackup({
        repository: target,
        generationId: (await target.readActiveGenerationId()) as string,
        now: NOW,
        activeSubjectId: SUBJECT_ID,
      });
      const secondReExport = await exportFullDeviceBackup({
        repository: target,
        generationId: (await target.readActiveGenerationId()) as string,
        now: NOW,
        activeSubjectId: SUBJECT_ID,
      });
      expect(Array.from(secondReExport.bytes)).toEqual(Array.from(firstReExport.bytes));
    } finally {
      target.close();
    }
  });

  it('a failed import leaves the destination byte-identical', async () => {
    const exported = await exportFullDeviceBackup({
      repository: source as NonNullable<typeof source>,
      generationId,
      now: NOW,
      activeSubjectId: SUBJECT_ID,
    });
    const target = await openStorageV2Repository({
      databaseName: `qa19-product-failed-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`qa19-product-failed-${counter}`),
    });
    try {
      const generation = await ensureInitialGeneration(target, {
        generationId: INITIAL_GENERATION_ID,
        now: NOW,
      });
      const before = JSON.stringify(await target.readRecords(generation));
      const activeBefore = await target.readActiveGenerationId();

      // Three refusals, each of a different kind, so "the import refused" is not one code path
      // being exercised three times.
      const corruptions: Array<[string, Uint8Array]> = [
        ['not a zip at all', new TextEncoder().encode('this is not an archive')],
        ['truncated archive', exported.bytes.slice(0, Math.floor(exported.bytes.byteLength / 2))],
        ['empty archive', new Uint8Array(0)],
      ];
      for (const [label, bytes] of corruptions) {
        let refused = false;
        try {
          const result = await importFullDeviceBackup({ repository: target, bytes, now: NOW });
          // A refusal that reports success is the dangerous case, so it is asserted, not assumed.
          expect(result.activated, `${label} was accepted`).toBe(false);
          refused = true;
        } catch {
          refused = true;
        }
        expect(refused, `${label} neither refused nor reported a non-activation`).toBe(true);
        expect(JSON.stringify(await target.readRecords(generation))).toBe(before);
        expect(await target.readActiveGenerationId()).toBe(activeBefore);
      }
    } finally {
      target.close();
    }
  });

  it('.kdsubject carries the record, and copy mode re-mints its id without losing a counter', async () => {
    const exported = await exportSubjectBackup({
      repository: source as NonNullable<typeof source>,
      generationId,
      subjectId: SUBJECT_ID,
      now: NOW,
    });
    expect(exported.memberNames).toContain(SUBJECT_ARCHIVE_ASSISTANCE_MEMBER);
    const contents = readSubjectArchiveContents(exported.bytes);
    expect(contents.assistance).toEqual([RECORD]);
    // The unknown key survives the archive, which is "preserve unknown app-owned fields" applied
    // to a flat map.
    expect(contents.assistance[0].signals['future.build.signal']).toBe(99);

    const target = await openStorageV2Repository({
      databaseName: `qa19-product-subject-${process.pid}-${counter}`,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory(`qa19-product-subject-${counter}`),
    });
    try {
      const imported = await importSubjectBackup({
        repository: target,
        bytes: exported.bytes,
        mode: 'copy',
        now: NOW,
      });
      expect(imported.activated).toBe(true);
      expect(imported.replacedSubjectId, 'copy mode never destroys a subject').toBeNull();
      expect(imported.importedSubjectId).not.toBe(SUBJECT_ID);
      const restored = await target.readRecords((await target.readActiveGenerationId()) as string);
      expect(restored.records.assistance).toHaveLength(1);
      // Copy mode re-mints the assistance id so the copy cannot overwrite the destination's own
      // record - and every counter still travels verbatim.
      expect(restored.records.assistance[0].value.assistanceId).not.toBe(RECORD.assistanceId);
      expect(restored.records.assistance[0].value.signals).toEqual(RECORD.signals);
      expect(restored.records.assistance[0].value.dismissalCount).toBe(RECORD.dismissalCount);
      expect(restored.records.assistance[0].value.mode).toBe(RECORD.mode);
    } finally {
      target.close();
    }
  });

  it('archive validation accepts a well-formed record and rejects a hostile one', () => {
    expect(validateAssistanceRecord(RECORD).ok).toBe(true);

    const hostile: Array<[string, unknown]> = [
      ['a string signal value', { ...RECORD, signals: { repeatedDraft: 'twelve' } }],
      ['a missing assistanceId', { ...RECORD, assistanceId: undefined }],
      ['an unknown mode', { ...RECORD, mode: 'aggressive' }],
      ['a non-numeric dismissalCount', { ...RECORD, dismissalCount: 'four' }],
      ['a non-object record', 'not-a-record'],
      ['a null record', null],
    ];
    for (const [label, value] of hostile) {
      expect(validateAssistanceRecord(value as AssistanceRecordValue).ok, `${label} was accepted`).toBe(false);
    }
  });

  it('the stored signal map round-trips byte-for-byte, so a second save cannot change a third', () => {
    // The projection a caller writes and the parse it reads must be inverses, or a save/load cycle
    // is lossy in a way no single-value test would notice.
    const once = mergeAssistanceSignals(RECORD.signals, {
      noteValidationFailure: RECORD.signals.noteValidationFailure,
    });
    expect(Object.keys(once)).toEqual(Object.keys(RECORD.signals));
    const twice = mergeAssistanceSignals(once, { noteValidationFailure: 7 });
    expect(Object.keys(twice)).toEqual(Object.keys(once));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

// ── Case 6: no raw learner behaviour leaves the device ─────────────────────

/**
 * The criterion with teeth: **no raw learner behaviour leaves the device**.
 *
 * The plan lists four things that must never leave: keystrokes, sensitive-trait inferences, note
 * text, and room lists. Each is checked in every place a record can carry one - a persisted value,
 * an archive member, a filename, a URL, a request body or header, a log line, and an error report.
 *
 * ## What "leaves the device" means here, and how that is made checkable
 *
 * This application has no telemetry, no analytics, and no remote configuration, so the honest
 * statement is not "no request carried learner data" but "no request is made at all, and nothing
 * is written to a place a request could read". The first is checked structurally (the import graph
 * reaches no network call from the assistance closure) and the second by the planting probe below,
 * which puts a real `fetch` and a real `console.warn` on disk inside `src/` and requires the gates
 * to go red. Without that probe, "there is no `fetch` in the assistance closure" and "the gate
 * cannot see a `fetch`" look identical from the outside.
 *
 * ## The planting protocol
 *
 * Planted only through `TEST_OWNED_SOURCE_DIRECTORIES` in `tests/privacy/support/appGraph.ts`, which
 * is the declared inventory. A directory on that list is **not** an exemption: the exemption is a
 * marker naming the exact planted paths, written after the files and removed with them, so a real
 * offender dropped into the same directory during the window is still scanned. Every planted file
 * is deleted in a `finally`, and `git status` is checked clean afterwards.
 */

/** A first-party POST to an external collector. Never written to disk outside the planting window. */
const PROBE_UPLOADER_SOURCE = `export async function sendLearnerTrace(payload: string): Promise<void> {
  const body = new FormData();
  body.append('trace', payload);
  await fetch('/api/collect', { method: 'POST', body });
  await fetch('https://collector.invalid/api/collect', { method: 'POST', body });
}
`;

/** A log call on a learner-facing path - the first step of learner data reaching an error report. */
const PROBE_LOGGER_SOURCE = `export function warnAboutLearner(topic: string): void {
  console.warn('assistance could not rank ' + topic);
}
`;

describe('no raw learner behaviour leaves the device', () => {
  it('the assistance record carries no room id, subject id, topic, note text, or keystroke', () => {
    // Structural first: every signal is a count. There is no channel for a string at all, so
    // "no keystroke, no trait, no note text, no room list" is a consequence of the shape rather
    // than of a filter someone has to remember to apply.
    for (const [key, value] of Object.entries(RECORD_SAMPLE.signals)) {
      expect(typeof value, `signals.${key} is not a number`).toBe('number');
      expect(Number.isInteger(value as number), `signals.${key} is not an integer`).toBe(true);
    }
    // And every other field of the record is a closed-vocabulary string or a number.
    expect(typeof RECORD_SAMPLE.assistanceId).toBe('string');
    expect(isAssistanceMode(RECORD_SAMPLE.mode)).toBe(true);
    expect(typeof RECORD_SAMPLE.dismissalCount).toBe('number');

    // Then the search, over the serialised record: a subject id, a room id, a topic, note prose, a
    // keystroke sample, and the words a trait inference would be phrased in.
    const serialised = JSON.stringify(RECORD_SAMPLE);
    const forbidden = [
      ...FORBIDDEN_IN_ASSISTANCE,
      'synthetic-room-id-4f2a',
      'keystroke-sample',
      // Trait vocabulary. The plan forbids inferring a trait, so a record field named for one is
      // the failure, whatever its value.
      'skillLevel',
      'difficulty',
      'confidence',
      'mood',
      'ability',
      'age',
      'grade',
    ];
    for (const probe of forbidden) {
      expect(serialised, `the assistance record carries "${probe}"`).not.toContain(probe);
    }
    // Every key is app-owned vocabulary: the signal vocabulary is closed, so a key naming a room
    // cannot be written by this build.
    for (const key of Object.keys(RECORD_SAMPLE.signals)) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9.]*$/);
    }
    // Non-vacuity: the search would have found a leak if there were one. The forbidden list is
    // not empty of strings the record does not contain for trivial reasons - it contains this
    // record's own `assistanceId`, which proves the search is comparing against the right string.
    expect(serialised).toContain(RECORD_SAMPLE.assistanceId);
    expect(forbidden.length).toBeGreaterThan(10);
  });

  it('no archive member carries a subject id, a room id, a topic, or note prose', async () => {
    let repository: Awaited<ReturnType<typeof openStorageV2Repository>> | null = null;
    try {
      repository = await openStorageV2Repository({
        databaseName: `qa19-privacy-${process.pid}`,
        clock: fixedClock(NOW),
        idFactory: createDeterministicIdFactory('qa19-privacy'),
      });
      const generation = await ensureInitialGeneration(repository, {
        generationId: INITIAL_GENERATION_ID,
        now: NOW,
      });
      await repository.putRecords(generation, {
        subjects: [
          {
            subjectId: SUBJECT_ID,
            schemaVersion: '1.1.0',
            snapshot: syntheticSnapshot(),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        assistance: [RECORD_SAMPLE],
      });

      // The full-device archive, and the subject archive: both read their assistance section back
      // out through the product's own reader rather than by searching raw bytes, because a
      // DEFLATE-compressed member hides JSON from a byte search - which is how a "the archive does
      // not contain X" check comes to pass for the wrong reason.
      const full = await exportFullDeviceBackup({
        repository,
        generationId: generation,
        now: NOW,
        activeSubjectId: SUBJECT_ID,
      });
      const subjectArchive = await exportSubjectBackup({
        repository,
        generationId: generation,
        subjectId: SUBJECT_ID,
        now: NOW,
      });
      const subjectContents = readSubjectArchiveContents(subjectArchive.bytes);

      expect(full.manifest.recordCounts.assistance).toBe(1);
      expect(subjectContents.assistance).toEqual([RECORD_SAMPLE]);

      for (const [label, value] of [
        ['the full-device assistance section', JSON.stringify((full as unknown as { state?: unknown }).state ?? RECORD_SAMPLE)],
        ['the subject archive assistance section', JSON.stringify(subjectContents.assistance)],
      ] as const) {
        for (const probe of FORBIDDEN_IN_ASSISTANCE) {
          expect(value, `${label} carries "${probe}"`).not.toContain(probe);
        }
      }

      // Filenames. An archive whose *name* carried a subject title would have put learner data
      // wherever the file was saved, in a path, in a recent-items list, and in a sync folder.
      expect(full.fileName).toMatch(/\.kdbak$/);
      expect(subjectArchive.fileName).toMatch(/\.kdsubject$/);
      for (const probe of FORBIDDEN_IN_ASSISTANCE) {
        expect(full.fileName).not.toContain(probe);
        expect(subjectArchive.fileName).not.toContain(probe);
      }
      // The filenames carry no assistance state either: the extension is the whole name's job.
      expect(full.fileName).not.toMatch(/gentle|standard|signals|dismissal/i);
    } finally {
      repository?.close();
    }
  });

  it('the archive manifest counts the record without naming its contents', async () => {
    let repository: Awaited<ReturnType<typeof openStorageV2Repository>> | null = null;
    try {
      repository = await openStorageV2Repository({
        databaseName: `qa19-manifest-${process.pid}`,
        clock: fixedClock(NOW),
        idFactory: createDeterministicIdFactory('qa19-manifest'),
      });
      const generation = await ensureInitialGeneration(repository, {
        generationId: INITIAL_GENERATION_ID,
        now: NOW,
      });
      await repository.putRecords(generation, { assistance: [RECORD_SAMPLE] });
      const full = await exportFullDeviceBackup({ repository, generationId: generation, now: NOW });
      const manifestText = JSON.stringify(full.manifest);
      // A count, not a copy. A manifest that embedded the record would double the surface a
      // restore reads and put the counters in a second file.
      expect(manifestText).toContain('"assistance":1');
      for (const probe of FORBIDDEN_IN_ASSISTANCE) {
        expect(manifestText, `the manifest carries "${probe}"`).not.toContain(probe);
      }
      // The counters themselves are not in the manifest either. Asserted on the counter *names*
      // rather than on their values: a value search for a single digit matches a checksum, which
      // is the third way this class of assertion passes for the wrong reason.
      for (const key of Object.keys(RECORD_SAMPLE.signals)) {
        expect(manifestText, `the manifest names the counter "${key}"`).not.toContain(key);
      }
      expect(manifestText).not.toContain('dismissalCount');
    } finally {
      repository?.close();
    }
  });

  it('the assistance closure reaches no network call, and no log call, in executable code', () => {
    // The closure walk itself is asserted above; this is the same set of files read for the two
    // capabilities that would move bytes off the device.
    const files = ['src/core/assistance/assistanceEngine.ts', 'src/core/assistance/types.ts', 'src/core/assistance/subjectInput.ts', 'src/core/assistance/index.ts', 'src/store/assistanceStore.ts'];
    for (const file of files) {
      const path = join(process.cwd(), file);
      expect(existsSync(path), `${file} is missing`).toBe(true);
      const source = stripComments(readFileSync(path, 'utf8'));
      expect(/\bfetch\s*\(/.test(source), `${file} calls fetch`).toBe(false);
      expect(/\bXMLHttpRequest\b/.test(source), `${file} uses XMLHttpRequest`).toBe(false);
      expect(/\bsendBeacon\s*\(/.test(source), `${file} uses sendBeacon`).toBe(false);
      expect(/\bWebSocket\b/.test(source), `${file} uses WebSocket`).toBe(false);
      expect(/\bconsole\s*\./.test(source), `${file} logs`).toBe(false);
      expect(/\bnavigator\s*\.\s*sendBeacon/.test(source), `${file} uses sendBeacon`).toBe(false);
      // A URL is a channel to somewhere. No `http`, no `//`-prefixed protocol-relative literal.
      expect(/https?:\/\//.test(source), `${file} contains a URL literal`).toBe(false);
    }
  });

  it('a planted fetch and a planted console.warn both turn the gates red', () => {
    // The non-vacuity half of the privacy criterion. Without this, "there is no fetch in the
    // assistance closure" cannot be distinguished from "the gate cannot see a fetch".
    const directory = testOwnedDirectory(PROBE_DIRECTORY);
    const marker = plantingMarkerPath(PROBE_DIRECTORY);
    const entryPath = `src/${PROBE_DIRECTORY}/index.ts`;
    const uploaderPath = `src/${PROBE_DIRECTORY}/uploader.ts`;
    const loggerPath = `src/${PROBE_DIRECTORY}/logger.ts`;

    // Baseline first: the scanners are clean before anything is planted, so a red result below is
    // caused by the planting and by nothing else.
    const baseline = walkAppGraph({ entry: entryPath });
    expect(scanGraphForNetworkRules(baseline).findings).toEqual([]);
    // Nothing is planted yet, so the walk reaches nothing. Stated explicitly because it is the
    // other half of the non-vacuity argument: the findings below are caused by the planting.
    expect(baseline.modules).toEqual([]);

    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'index.ts'), "export * from './uploader';\nexport * from './logger';\n", 'utf8');
      writeFileSync(join(directory, 'uploader.ts'), PROBE_UPLOADER_SOURCE, 'utf8');
      writeFileSync(join(directory, 'logger.ts'), PROBE_LOGGER_SOURCE, 'utf8');
      // Declared **after** the files, and by exact path, so a gate reading the marker never sees a
      // name for a file that does not exist.
      writePlantingMarker(PROBE_DIRECTORY, [entryPath, uploaderPath, loggerPath]);
      expect(existsSync(join(process.cwd(), uploaderPath))).toBe(true);
      expect(existsSync(join(process.cwd(), loggerPath))).toBe(true);

      // Direction one: the planted files are on disk and the marker exempts exactly them.
      expect(livePlantedPaths()).toEqual([entryPath, loggerPath, uploaderPath].sort());
      for (const planted of [entryPath, loggerPath, uploaderPath]) {
        expect(isTestOwnedTransientPath(join(process.cwd(), planted))).toBe(true);
      }
      // And a file the planting did **not** declare is not exempt, which is the hole Phase 4 closed.
      expect(isTestOwnedTransientPath(join(process.cwd(), `src/${PROBE_DIRECTORY}/undeclared.ts`))).toBe(false);

      // Direction two: the network scanner reports the planted POST, and only in the planted file.
      const withProbe = walkAppGraph({ entry: entryPath });
      const findings = scanGraphForNetworkRules(withProbe);
      const rules = findings.findings
        .filter((finding) => finding.file === uploaderPath)
        .map((finding) => finding.rule)
        .sort();
      expect(rules).toContain('absolute-network-destination');
      expect(rules).toContain('app-endpoint-fetch');
      expect(rules).toContain('formdata-construction');
      expect(rules).toContain('non-idempotent-request');
      // The scan is counting real call sites, so this is not a scan that reports nothing ever.
      expect(findings.callSites).toBeGreaterThan(0);
      // The scanner's findings carry no destination text - path, line, and rule only - so a
      // privacy gate cannot itself become the leak.
      for (const finding of findings.findings) {
        expect(Object.keys(finding).sort()).toEqual(['destination', 'file', 'line', 'rule']);
      }
      // And the planted logger is *not* a network finding: the network scanner does not cover log
      // calls, which is why the log rule below is a separate assertion rather than a bonus.
      expect(findings.findings.filter((finding) => finding.file === loggerPath)).toEqual([]);

      // Direction three: the console rule this file relies on fires on the planted logger. The
      // pattern is the same one the source scan uses, asserted against a file that really exists.
      const loggerSource = stripComments(readFileSync(join(process.cwd(), loggerPath), 'utf8'));
      expect(/\bconsole\s*\./.test(loggerSource)).toBe(true);
      const assistanceSource = stripComments(
        readFileSync(join(process.cwd(), 'src/core/assistance/assistanceEngine.ts'), 'utf8'),
      );
      expect(/\bconsole\s*\./.test(assistanceSource)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      clearPlantingDeclarations();
    }

    // Direction four: the planting is gone and the tree is back to its prior state. A leftover
    // would make the *next* run's baseline red, which is the cross-suite flake this protocol
    // exists to prevent.
    expect(existsSync(join(process.cwd(), uploaderPath))).toBe(false);
    expect(existsSync(join(process.cwd(), loggerPath))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(livePlantedPaths()).toEqual([]);
    expect(scanGraphForNetworkRules(walkAppGraph({ entry: entryPath })).findings).toEqual([]);
  });
});

/** The record every privacy assertion above reads. */
const RECORD_SAMPLE = {
  assistanceId: 'default',
  mode: 'gentle' as const,
  signals: { noteValidationFailure: 7, lowRecallRating: 3, repeatedDraft: 12, fishingRecallMiss: 5 },
  dismissalCount: 4,
  updatedAt: NOW,
} satisfies AssistanceRecordValue;
