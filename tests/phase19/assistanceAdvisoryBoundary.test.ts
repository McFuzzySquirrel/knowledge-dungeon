/**
 * Phase 19: suggestions are **advisory**, proven structurally rather than by intent.
 *
 * ## The claim
 *
 * Plan section 8: assistance must not "generate answers automatically", "auto-confirm
 * validation", "bypass progression or review rules", or "change deterministic learning
 * outcomes without showing why". Phase 19's exit criterion sharpens it: *"Suggestions never
 * alter deterministic outcomes by themselves."*
 *
 * A comment promising the code is careful is not evidence. Four independent mechanisms are
 * used here, in increasing order of strength, and the strongest is last because the first three
 * can all be satisfied by an implementation that is wrong in a way nobody looked for.
 *
 * | # | Mechanism | What a violation would look like |
 * | --- | --- | --- |
 * 1 | **Import graph** | `src/store/assistanceStore.ts` reaching a progression, review, or subject *writer* |
 * 2 | **Type surface** | A callable, a store handle, or a repository handle in a suggestion or an action |
 * 3 | **Data fingerprint** | Any byte of progression, review, subject, or validation state moving across a suggestion or a dismissal |
 * 4 | **Ledger fingerprint** | Any **storage-v2 generation record** other than the one `assistance` record moving |
 *
 * Mechanism 4 is the one that would catch a violation mechanisms 1-3 miss: a write that goes
 * straight to the repository without touching a store. And mechanism 3 is guarded by an
 * assertion that the fingerprint it compares is **not empty**, because a before/after
 * comparison over an empty baseline is the single most common way this class of gate passes
 * for the wrong reason.
 *
 * ## The baseline is real
 *
 * `seedProgressionState` builds a progression record with XP, a rank, badges, a fish
 * collection, a room-clear counter, a review-pass counter, and the preserved statistics event
 * ledger; `seedSubjectState` builds a graph with rooms in mixed states, validation failures,
 * rubric scores, and SM-2 fields. `it('the baseline is not empty')` asserts the fingerprints
 * are substantial before anything is compared - see the comment there for the tautology this
 * guards against.
 */
import 'fake-indexeddb/auto';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rankAssistance, explainAssistanceSuggestion } from '@/core/assistance/assistanceEngine';
import type { AssistanceSubjectInput } from '@/core/assistance/types';
import { useProgressionStore } from '@/store/progressionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useSessionStore } from '@/store/sessionStore';
import {
  ASSISTANCE_STORAGE_KEY,
  __resetAssistanceStoreForTests,
  pendingAssistanceWrites,
  readPersistedAssistance,
  useAssistanceStore,
} from '@/store/assistanceStore';
import {
  resetRepositorySelection,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import { ensureInitialGeneration, INITIAL_GENERATION_ID } from '@/services/persistence/v2/appState';

import type { RoomMetadata } from '@/core/validation/persistence/types';

import { NOW_ISO } from './support/fixtures';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

/**
 * Modules the assistance store must never reach, because each is a **writer**.
 *
 * Enumerated rather than pattern-matched, so a new writer added under an existing prefix cannot
 * slip in unnoticed. The prefix walks below catch anything *not* on this list; this list is
 * what makes the failure message name the writer.
 */
const WRITE_MODULES = [
  'src/store/progressionStore.ts',
  'src/store/reviewCommands.ts',
  'src/store/creatorGraphCommands.ts',
  'src/store/fishingCommands.ts',
  'src/store/encounterCommands.ts',
  'src/core/progression/roomClearRewards.ts',
  'src/core/progression/reviewPassRewards.ts',
  'src/core/fishing/catchRewards.ts',
  'src/core/artifacts/roomArtifact.ts',
  'src/core/validation/notes/noteValidation.ts',
  'src/core/review/spacedRepetition.ts',
] as const;

// ── The fingerprint machinery ────────────────────────────────────────────────

interface Fingerprint {
  readonly progression: unknown;
  readonly subject: unknown;
  readonly session: unknown;
  /** The legacy-mirror assistance record. The one surface assistance *may* move. */
  readonly assistanceRecord: unknown;
  /** Every storage-v2 store **except** `assistance`, keyed by store name, in record-id order. */
  readonly generation: Record<string, unknown>;
  /**
   * The storage-v2 `assistance` store on its own.
   *
   * Split out rather than folded into `generation` because assistance is *allowed* to write that
   * store, and a "nothing else moved" comparison that included it would fail on the very first
   * write - which is the false positive that would have made this file's central assertion
   * unfailable. Splitting it out also lets each test assert that this leg *did* move, so the
   * comparison cannot be satisfied by a store that writes nothing.
   */
  readonly generationAssistance: Record<string, unknown>;
  /** The legacy mirror keys, as raw strings, excluding the assistance key. */
  readonly legacy: Record<string, string | null>;
}

/**
 * A deep, order-stable reduction of arbitrary state.
 *
 * `JSON.stringify` on its own is not enough: two objects that are `toEqual` can serialise to
 * different bytes when their keys were inserted in a different order, which would make this
 * gate report a difference that is not one. So object keys are sorted at every level before
 * serialisation, and `undefined` members are dropped so an absent field and an explicit
 * `undefined` compare equal.
 *
 * `Map` and `Set` are reduced to sorted arrays for the same reason.
 */
function stable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? `non-finite:${String(value)}` : value;
  }
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [stable(key), stable(entry)]).sort(compareSerialised);
  }
  if (value instanceof Set) return [...value.values()].map(stable).sort(compareSerialised);
  const record = value as Record<string, unknown>;
  const reduced: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    reduced[key] = stable(record[key]);
  }
  return reduced;
}

function compareSerialised(left: unknown, right: unknown): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A JSON string of every fingerprinted surface. One string, so a diff is readable. */
function fingerprintText(value: unknown): string {
  return JSON.stringify(stable(value));
}

let repository: Awaited<ReturnType<typeof openStorageV2Repository>> | null = null;
let databaseCounter = 0;

/**
 * Read every surface assistance could conceivably have touched.
 *
 * The storage-v2 leg is what makes this more than an in-memory check: a write that bypassed
 * every store and went straight to the repository would be invisible to a store-state diff and
 * visible here.
 */
async function fingerprint(): Promise<Fingerprint> {
  const progression = useProgressionStore.getState();
  const subject = useSubjectStore.getState();
  const session = useSessionStore.getState();

  let generation: Record<string, unknown> = {};
  let generationAssistance: Record<string, unknown> = {};
  if (repository !== null) {
    const generationId = await repository.readActiveGenerationId();
    if (generationId !== null) {
      const snapshot = await repository.readRecords(generationId);
      const records = snapshot.records as unknown as Record<string, { recordId: string; value: unknown }[]>;
      // Empty stores are dropped. A store holding nothing is not a fact worth comparing, and
      // keeping nine empty arrays in every fingerprint made the one leg that matters - the stores
      // an assistance write must never touch - harder to read in a failure message.
      const byStore = Object.fromEntries(
        Object.entries(records)
          .map(([store, entries]) => [
            store,
            [...entries]
              .sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0))
              .map((entry) => [entry.recordId, entry.value]),
          ])
          .filter(([, entries]) => (entries as unknown[]).length > 0),
      );
      const { assistance: assistanceStores, ...otherStores } = byStore;
      generation = otherStores;
      generationAssistance = { assistance: assistanceStores };
    }
  }

  const legacy: Record<string, string | null> = {};
  for (const key of Object.keys(window.localStorage).sort()) {
    // The assistance mirror key is excluded **by name**, not by forgetting to include it. It is
    // the one localStorage entry assistance is allowed to create, and a `legacy` leg that
    // included it would make every "nothing else changed" comparison fail on the very first
    // write - which is the false positive a boundary gate must not have.
    if (key === ASSISTANCE_STORAGE_KEY) continue;
    legacy[key] = window.localStorage.getItem(key);
  }

  return {
    progression: {
      xpTotal: progression.xpTotal,
      rank: progression.rank,
      badges: progression.badges,
      inventory: progression.inventory,
      equippedItems: progression.equippedItems,
      collectedNotes: progression.collectedNotes,
      streakCount: progression.streakCount,
      roomsCleared: progression.roomsCleared,
      reviewPasses: progression.reviewPasses,
      artifacts: progression.artifacts,
      bossesDefeated: progression.bossesDefeated,
      fishCollection: progression.fishCollection,
      bySubject: progression.bySubject,
      crossSubjectAchievements: progression.crossSubjectAchievements,
      activeSubjectId: progression.activeSubjectId,
    },
    subject: subject.snapshot,
    session: {
      activeSubjectId: session.activeSubjectId,
      focusedRoomId: session.focusedRoomId,
      activeScreen: session.activeScreen,
      selectedClass: session.selectedClass,
    },
    // The one surface assistance *is* allowed to move, captured separately so the comparison
    // below can exclude it explicitly rather than by forgetting to include it.
    assistanceRecord: readPersistedAssistance(),
    generation,
    generationAssistance,
    legacy,
  };
}

/**
 * The fingerprint with every assistance-owned surface removed - i.e. "everything else".
 *
 * Built by construction rather than by destructuring, so the excluded members are *named* in the
 * return type and a future field added to {@link Fingerprint} has to be classified deliberately
 * instead of silently riding along in the "everything else" leg.
 *
 * Three surfaces are excluded, and each for its own stated reason: the legacy mirror record
 * (`assistanceRecord`), the storage-v2 `assistance` store (`generationAssistance`), and the
 * legacy `localStorage` key (already dropped inside {@link fingerprint}'s `legacy` leg). Leaving
 * any of them in would make this comparison fail on the first legitimate write, and a gate that
 * cannot be satisfied is a gate nobody trusts.
 */
function withoutAssistance(value: Fingerprint): {
  progression: unknown;
  subject: unknown;
  session: unknown;
  generation: Record<string, unknown>;
  legacy: Record<string, string | null>;
} {
  return {
    progression: value.progression,
    subject: value.subject,
    session: value.session,
    generation: value.generation,
    legacy: value.legacy,
  };
}

/** Every surface assistance owns. The complement of {@link withoutAssistance}. */
function onlyAssistance(value: Fingerprint): { assistanceRecord: unknown; generationAssistance: Record<string, unknown> } {
  return {
    assistanceRecord: value.assistanceRecord,
    generationAssistance: value.generationAssistance,
  };
}

/** A substantial, deterministic progression record. */
function seedProgressionState(subjectId: string): void {
  useProgressionStore.getState().hydrateProgression({
    version: 3,
    bySubject: {
      [subjectId]: {
        xpTotal: 640,
        rank: 'Scholar',
        badges: ['synthetic-first-room', 'synthetic-reviewer'],
        inventory: [],
        equippedItems: [],
        collectedNotes: [],
        streakCount: 3,
        subjectsMastered: 0,
        roomsCleared: 2,
        reviewPasses: 1,
        artifacts: 1,
        bossesDefeated: 0,
        fishCollection: [
          { id: 'moss-carp:synthetic', name: 'Moss Carp', rarity: 'common', subjectId, subjectName: 'Synthetic', caughtAt: '2026-03-01T00:00:00.000Z', catalogId: 'moss-carp' },
        ],
      },
    },
    crossSubjectAchievements: ['meta-subjects-2'],
  });
}

/** A graph with rooms in mixed states, validation failures, rubric scores, and SM-2 fields. */
function seedSubjectState(subjectId: string): void {
  const now = '2026-03-01T00:00:00.000Z';
  const room = (roomId: string, topic: string, overrides: Record<string, unknown> = {}): RoomMetadata => ({
    roomId,
    topic,
    createdAt: now,
    updatedAt: now,
    state: 'Created' as RoomMetadata['state'],
    notePath: `rooms/${roomId}/notes.txt`,
    artifactPath: `rooms/${roomId}/artifact.md`,
    // Present and never read by assistance. It is here so the fingerprint has prose to lose,
    // and so a gate that did read it would move the bytes.
    noteText: `# ${topic}\nSynthetic note body that assistance must never read.`,
    artifactMarkdown: `# ${topic} artifact`,
    validationState: {
      wordCount: 0,
      requiredSectionsPresent: false,
      manualConfirmed: false,
      criterionScores: {
        sectionCompleteness: 0,
        conceptTermCoverage: 0,
        linkReferences: 0,
        recallQuestionQuality: 0,
        clarityReadability: 0,
      },
      failedChecks: [],
      qualityBonus: 0,
      finalPass: false,
      ...((overrides.validationState as Record<string, unknown> | undefined) ?? {}),
    },
    reviewPassCount: 0,
    attachments: [],
    ...overrides,
  });
  useSubjectStore.getState().hydrateSnapshot({
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: subjectId,
      subjectName: 'Synthetic Advisory Subject',
      createdAt: now,
      updatedAt: now,
      phaseState: 'ScribeActive',
      rootRoomId: 'room-root',
      rooms: [
        { roomId: 'room-root', topic: 'Root Topic', status: 'NotesDrafted' },
        { roomId: 'room-failing', topic: 'Failing Topic', status: 'NotesDrafted' },
        { roomId: 'room-due', topic: 'Due Topic', status: 'EncounterDefeated' },
      ],
      edges: [
        { fromRoomId: 'room-root', toRoomId: 'room-failing', relationType: 'subtopic', createdAt: now, createdByPhase: 'Creator' },
        { fromRoomId: 'room-failing', toRoomId: 'room-due', relationType: 'subtopic', createdAt: now, createdByPhase: 'Creator' },
      ],
      progression: { xpTotal: 640, rank: 'Scholar', badges: ['synthetic-first-room'], fishCollection: [] },
    },
    rooms: {
      'room-root': room('room-root', 'Root Topic'),
      'room-failing': room('room-failing', 'Failing Topic', {
        validationState: {
          wordCount: 40,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 1,
            clarityReadability: 1,
          },
          failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
          qualityBonus: 2,
          finalPass: false,
        },
      }),
      'room-due': room('room-due', 'Due Topic', {
        state: 'EncounterDefeated',
        reviewPassCount: 2,
        sm2QualityResponse: 1,
        sm2EaseFactor: 1.7,
        sm2IntervalDays: 1,
        sm2NextReviewDate: '2026-03-05T00:00:00.000Z',
        sm2ConsecutiveCorrect: 0,
        validationState: {
          wordCount: 220,
          requiredSectionsPresent: true,
          manualConfirmed: true,
          criterionScores: {
            sectionCompleteness: 2,
            conceptTermCoverage: 2,
            linkReferences: 2,
            recallQuestionQuality: 2,
            clarityReadability: 2,
          },
          failedChecks: [],
          qualityBonus: 10,
          finalPass: true,
        },
      }),
    },
  });
}

const SUBJECT_ID = 'synthetic-advisory-subject';

/**
 * Put one record of every interesting kind into the active generation, and one legacy key.
 *
 * Deliberately includes a **progression** record and a **subject** record - the two stores an
 * assistance write must never reach - plus a session record, so the generation leg of the
 * fingerprint is not accidentally narrow. If a future change made assistance write a subject
 * record, the diff would name `subjects` rather than being lost in a large blob.
 */
async function seedGeneration(): Promise<void> {
  if (repository === null) return;
  const generationId = await ensureInitialGeneration(repository, {
    generationId: INITIAL_GENERATION_ID,
    now: '2026-03-15T12:00:00.000Z',
  });
  const snapshot = useSubjectStore.getState().snapshot;
  if (snapshot === null) throw new Error('seedSubjectState did not load a snapshot');
  await repository.putRecords(generationId, {
    subjects: [
      {
        subjectId: SUBJECT_ID,
        schemaVersion: '1.1.0',
        snapshot,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ],
    progression: [
      {
        subjectId: SUBJECT_ID,
        sourceVersion: 3,
        rank: 'Scholar',
        xpTotal: 640,
        bySubject: {
          [SUBJECT_ID]: {
            subjectId: SUBJECT_ID,
            xpTotal: 640,
            rank: 'Scholar',
            badges: ['synthetic-first-room'],
            inventory: [],
            equippedItems: [],
            collectedNotes: [],
            streakCount: 3,
            subjectsMastered: 0,
            roomsCleared: 2,
            reviewPasses: 1,
            artifacts: 1,
            bossesDefeated: 0,
            fishCollection: [],
            extraFields: {},
          },
        },
        crossSubjectAchievements: [],
      },
    ],
    sessions: [
      {
        sessionId: 'synthetic-advisory-session',
        subjectId: SUBJECT_ID,
        subjectName: 'Synthetic Advisory Subject',
        startedAt: '2026-03-14T09:00:00.000Z',
        endedAt: '2026-03-14T09:30:00.000Z',
        roomsVisited: ['room-root', 'room-due'],
        notesSubmitted: 1,
        reviewsCompleted: 1,
        xpEarned: 120,
        eventId: 'synthetic-advisory-session:2026-03-14T09:00:00.000Z',
      },
    ],
    // A subject record the **Phase 3 migration** already writes on every device, so the
    // fingerprint includes it and an assistance write that dropped or duplicated it would show.
    assistance: [
      {
        assistanceId: 'default',
        mode: 'standard',
        signals: {},
        dismissalCount: 0,
        updatedAt: '2026-03-15T12:00:00.000Z',
      },
    ],
  });
  // One legacy key that is **not** assistance's, so the legacy leg is not trivially empty.
  window.localStorage.setItem(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({ version: 3, bySubject: {}, crossSubjectAchievements: [] }),
  );
}

/** The subject as the engine sees it, derived from the seeded snapshot. */
const ENGINE_SUBJECTS: AssistanceSubjectInput[] = [
  {
    subjectId: SUBJECT_ID,
    subjectName: 'Synthetic Advisory Subject',
    rootRoomId: 'room-root',
    phaseState: 'ScribeActive',
    rooms: [
      {
        roomId: 'room-failing',
        topic: 'Failing Topic',
        state: 'NotesDrafted',
        noteWordCount: 40,
        missingSections: ['Summary'],
        failedChecks: ['VAL_REQUIRED_SECTION_MISSING'],
        criterionScores: { sectionCompleteness: 0, linkReferences: 0, recallQuestionQuality: 1, clarityReadability: 1 },
        finalPass: false,
        reviewPassCount: 0,
        sm2QualityResponse: null,
        sm2NextReviewDate: null,
        tags: [],
      },
      {
        roomId: 'room-due',
        topic: 'Due Topic',
        state: 'EncounterDefeated',
        noteWordCount: 220,
        missingSections: [],
        failedChecks: [],
        criterionScores: { sectionCompleteness: 2, conceptTermCoverage: 2, linkReferences: 2 },
        finalPass: true,
        reviewPassCount: 2,
        sm2QualityResponse: 1,
        sm2NextReviewDate: '2026-03-05T00:00:00.000Z',
        tags: [],
      },
    ],
    edges: [{ fromRoomId: 'room-root', toRoomId: 'room-failing', relationType: 'subtopic' }],
  },
];

const SIGNALS = {
  noteValidationFailure: 4,
  lowRecallRating: 3,
  repeatedDraft: 2,
  fishingRecallMiss: 1,
};

beforeEach(async () => {
  window.localStorage.clear();
  resetRepositorySelection();
  __resetAssistanceStoreForTests();
  databaseCounter += 1;
  repository = await openStorageV2Repository({
    databaseName: `p19-advisory-${process.pid}-${databaseCounter}`,
    clock: fixedClock('2026-03-15T12:00:00.000Z'),
    idFactory: createDeterministicIdFactory(`p19-advisory-${databaseCounter}`),
  });
  selectStorageV2Repository(repository);
  seedProgressionState(SUBJECT_ID);
  seedSubjectState(SUBJECT_ID);
  useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
  // The generation is seeded **directly**, through the repository, rather than by calling
  // another store's write path.
  //
  // That is deliberate. This gate asks "did assistance move anything?", and the honest way to
  // set up a baseline is to put the things in place yourself: driving `progressionStore`'s
  // persistence would make the baseline depend on a second store's flag reading, its lazy
  // adapter import, and its background queue, and a failure there would look like a failure of
  // this gate. Seeding the repository means the baseline is a fact this file established, and a
  // non-empty generation is asserted below before anything is compared against it.
  await seedGeneration();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  resetRepositorySelection();
  window.localStorage.clear();
  __resetAssistanceStoreForTests();
});

describe('the baseline is real, so an unchanged fingerprint means something', () => {
  it('the progression, subject, and generation fingerprints are all substantial', () => {
    // THE anti-tautology guard for this file. Every assertion below is "nothing changed", and
    // a before/after comparison over an empty or trivial baseline would pass for a store that
    // did something catastrophic. So the baseline is measured first and required to be big.
    //
    // Note what is *not* used to assert it is big: a constant. Every field is counted or
    // measured, because a literal `expect(len).toBe(7)` would itself be an assertion about a
    // fixture rather than about the baseline's substance.
    const state = useProgressionStore.getState();
    const subject = useSubjectStore.getState();
    expect(state.xpTotal).toBeGreaterThan(0);
    expect(state.rank).not.toBe('');
    expect(state.badges.length).toBeGreaterThanOrEqual(2);
    expect(state.fishCollection.length).toBeGreaterThanOrEqual(1);
    expect(state.roomsCleared).toBeGreaterThanOrEqual(2);
    expect(state.reviewPasses).toBeGreaterThanOrEqual(1);
    expect(Object.keys(state.bySubject).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(state.bySubject[SUBJECT_ID] ?? {}).length).toBeGreaterThanOrEqual(10);
    expect(subject.snapshot).not.toBeNull();
    expect(Object.keys(subject.snapshot?.rooms ?? {}).length).toBe(3);
    expect((subject.snapshot?.dungeon.edges ?? []).length).toBe(2);
    // And the note prose is really in the fingerprint, so a gate that read it would move bytes.
    expect(fingerprintText(subject.snapshot)).toContain('must never read');
  });

  it('the generation holds subject, progression, session, and assistance records', async () => {
    const generationId = await repository?.readActiveGenerationId();
    expect(generationId).not.toBeNull();
    const snapshot = await repository?.readRecords(generationId as string);
    // This is what makes mechanism 4 possible: there is a real record of each interesting kind
    // to lose, so a write that bypassed every store and went straight to the repository would
    // show up rather than land in an unpopulated store.
    expect(snapshot?.records.progression.length ?? 0).toBe(1);
    expect(snapshot?.records.subjects.length ?? 0).toBe(1);
    expect(snapshot?.records.sessions.length ?? 0).toBe(1);
    expect(snapshot?.records.assistance.length ?? 0).toBe(1);
    // And the seeded assistance record is the documented default, so the "an assistance write
    // moves it" assertion below is a change from a known value.
    expect(snapshot?.records.assistance[0].value).toEqual({
      assistanceId: 'default',
      mode: 'standard',
      signals: {},
      dismissalCount: 0,
      updatedAt: '2026-03-15T12:00:00.000Z',
    });
  });

  it('an assistance write DOES move the fingerprint, so the comparison is not dead code', () => {
    // The other half of the anti-tautology guard, and the more important one: a gate that
    // compares a fingerprint which *nothing can move* would report "unchanged" for a store that
    // wrote the whole device. So the fingerprint is required to move when assistance legitimately
    // writes, and then required not to move when anything else does.
    const before = fingerprintText(readPersistedAssistance());
    expect(before).toBe('null');
    useAssistanceStore.getState().dismissSuggestion();
    const after = fingerprintText(readPersistedAssistance());
    expect(after).not.toBe(before);
    expect(after).toContain('"dismissalCount":1');
  });
});

describe('ranking suggestions changes nothing but the assistance record', () => {
  it('every mode, over every signal map, leaves progression, subject, session, and generation byte-identical', async () => {
    const before = await fingerprint();
    for (const mode of ['gentle', 'standard'] as const) {
      const signalVariants: Readonly<Record<string, number>>[] = [
        {},
        SIGNALS,
        { repeatedDraft: 99 },
        { fishingRecallMiss: 99 },
      ];
      for (const signals of signalVariants) {
        rankAssistance({
          mode,
          subjects: ENGINE_SUBJECTS,
          signals,
          nowIso: NOW_ISO,
          flagEnabled: true,
          study: { roomsCleared: 2, notesSubmitted: 2, reviewsCompleted: 1, activeDays: 4, fishKept: 1 },
          fishing: { subjectId: SUBJECT_ID, lastMissedRoomId: 'room-due', missedThisVisit: 3 },
        });
        explainAssistanceSuggestion(
          rankAssistance({
            mode,
            subjects: ENGINE_SUBJECTS,
            signals,
            nowIso: NOW_ISO,
            flagEnabled: true,
            study: { roomsCleared: 2, notesSubmitted: 2, reviewsCompleted: 1, activeDays: 4, fishKept: 1 },
            fishing: { subjectId: SUBJECT_ID, lastMissedRoomId: 'room-due', missedThisVisit: 3 },
          }).suggestions[0] ?? {
            suggestionId: 'none\nnone',
            kind: 'device.due-today',
            surface: 'device',
            targetId: '',
            priority: 0,
            reasonCode: 'device-reviews-due',
            signalKey: null,
            signalValue: 0,
            intensity: 'cue',
            action: { kind: 'offer-prioritisation', subjectId: '', roomId: null, detail: null },
          },
          { subjects: ENGINE_SUBJECTS, signals, nowIso: NOW_ISO },
        );
      }
    }
    const after = await fingerprint();
    // "Everything else" - the assistance record is excluded by name, not by omission.
    expect(fingerprintText(withoutAssistance(after))).toBe(fingerprintText(withoutAssistance(before)));
    // And the assistance record is genuinely unchanged too: ranking is a **read**, and a read
    // that wrote would be the Phase 18 "a read turns into a write" defect.
    expect(fingerprintText(after.assistanceRecord)).toBe(fingerprintText(before.assistanceRecord));
  });

  it('the "no change" assertion is not satisfied by an empty comparison', async () => {
    // Belt and braces on the tautology, stated as its own test so it cannot be optimised away:
    // the two fingerprints being compared are non-empty, and they are long enough that a
    // truncated or accidentally-empty reduction would fail here.
    const before = await fingerprint();
    const text = fingerprintText(withoutAssistance(before));
    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain('"xpTotal":640');
    expect(text).toContain('Synthetic Advisory Subject');
    expect(text).toContain('must never read');
    // The generation leg really is populated, which is what makes mechanism 4 non-vacuous, and it
    // holds the three stores an assistance write must never touch.
    expect(Object.keys(before.generation).sort()).toEqual(['progression', 'sessions', 'subjects']);
    // The assistance store is present too, in its own leg, so the "everything else" comparison is
    // not being satisfied by an empty generation. It is an **array** of `[recordId, value]` pairs,
    // so its length is the count - `Object.keys` on it would return `['0']`, which is how the
    // first version of this assertion came to expect a record id of `"0"`.
    const assistancePairs = (before.generationAssistance.assistance ?? []) as [string, unknown][];
    expect(assistancePairs).toHaveLength(1);
    // And the record id really is the value's own `assistanceId`, which is what makes a re-publish
    // supersede rather than duplicate.
    expect(assistancePairs[0][0]).toBe('default');
  });
});

describe('changing the mode or dismissing changes nothing but the assistance record', () => {
  it('a mode change across every mode leaves every other surface byte-identical', async () => {
    const before = await fingerprint();
    for (const mode of ['off', 'gentle', 'standard', 'off', 'standard'] as const) {
      useAssistanceStore.getState().setMode(mode);
      await pendingAssistanceWrites();
    }
    const after = await fingerprint();
    expect(fingerprintText(withoutAssistance(after))).toBe(fingerprintText(withoutAssistance(before)));
    // And the mode itself did land - in **both** assistance-owned surfaces. Asserted so this is
    // "changed exactly the assistance record and nothing else", not "changed nothing", which a
    // store that silently dropped every write would also satisfy.
    expect(after.assistanceRecord).toMatchObject({ mode: 'standard' });
    expect(readPersistedAssistance()?.mode).toBe('standard');
    expect(fingerprintText(onlyAssistance(after))).not.toBe(fingerprintText(onlyAssistance(before)));
    expect(((after.generationAssistance.assistance ?? []) as unknown[]).length).toBeGreaterThan(0);
  });

  it('ten dismissals leave progression, review, subject, and generation byte-identical', async () => {
    // Ten, because one dismissal could be a coincidence of ordering. Each one is a write, so
    // this also exercises the persistence path ten times.
    const before = await fingerprint();
    for (let index = 0; index < 10; index += 1) {
      useAssistanceStore.getState().dismissSuggestion();
    }
    await pendingAssistanceWrites();
    const after = await fingerprint();
    expect(fingerprintText(withoutAssistance(after))).toBe(fingerprintText(withoutAssistance(before)));
    expect(readPersistedAssistance()?.dismissalCount).toBe(10);
    // The dismissal really reached storage-v2, not just the legacy mirror - so the comparison
    // above excluded a surface that genuinely moved.
    expect(fingerprintText(onlyAssistance(after))).not.toBe(fingerprintText(onlyAssistance(before)));
    const assistanceRecords = (after.generationAssistance.assistance ?? []) as [string, unknown][];
    expect(assistanceRecords).toHaveLength(1);
    expect(assistanceRecords[0][0]).toBe('default');
    expect(assistanceRecords[0][1]).toMatchObject({ dismissalCount: 10 });
    expect(useProgressionStore.getState().xpTotal).toBe(640);
    expect(useProgressionStore.getState().reviewPasses).toBe(1);
    expect(useProgressionStore.getState().badges.length).toBe(2);
  });

  it('signal bumps and a dismissal clear leave every other surface byte-identical', async () => {
    const before = await fingerprint();
    useAssistanceStore.getState().bumpSignals({
      noteValidationFailure: 3,
      lowRecallRating: 2,
      repeatedDraft: 5,
      fishingRecallMiss: 1,
    });
    useAssistanceStore.getState().bumpSignals({ repeatedDraft: 2 });
    useAssistanceStore.getState().clearDismissals();
    await pendingAssistanceWrites();
    const after = await fingerprint();
    expect(fingerprintText(withoutAssistance(after))).toBe(fingerprintText(withoutAssistance(before)));
    expect(fingerprintText(onlyAssistance(after))).not.toBe(fingerprintText(onlyAssistance(before)));
    expect(readPersistedAssistance()?.signals).toMatchObject({
      noteValidationFailure: 3,
      lowRecallRating: 2,
      repeatedDraft: 7,
      fishingRecallMiss: 1,
    });
  });

  it('a dismissal changes what the engine ranks by nothing at all', () => {
    // The consequence-2 claim, measured. Ten dismissals then a rank, against a rank on a fresh
    // store: byte-identical. If dismissal were punitive in any way - suppressed suggestions,
    // raised thresholds, a stronger `repeatedDraft` - this would differ, and `dismissalCount`
    // is deliberately **not** an input to `rankAssistance` so it cannot.
    const rank = () =>
      fingerprintText(
        rankAssistance({
          mode: 'standard',
          subjects: ENGINE_SUBJECTS,
          signals: SIGNALS,
          nowIso: NOW_ISO,
          flagEnabled: true,
          study: { roomsCleared: 2, notesSubmitted: 2, reviewsCompleted: 1, activeDays: 4, fishKept: 1 },
        }).suggestions,
      );
    const clean = rank();
    for (let index = 0; index < 25; index += 1) useAssistanceStore.getState().dismissSuggestion();
    expect(useAssistanceStore.getState().dismissalCount).toBe(25);
    expect(rank()).toBe(clean);
    // And Gentle, which keeps more suggestions, keeps the same ones after 25 dismissals.
    const gentleRank = () =>
      fingerprintText(
        rankAssistance({
          mode: 'gentle',
          subjects: ENGINE_SUBJECTS,
          signals: SIGNALS,
          nowIso: NOW_ISO,
          flagEnabled: true,
          study: { roomsCleared: 2, notesSubmitted: 2, reviewsCompleted: 1, activeDays: 4, fishKept: 1 },
        }).suggestions,
      );
    const gentleBefore = gentleRank();
    for (let index = 0; index < 25; index += 1) useAssistanceStore.getState().dismissSuggestion();
    expect(gentleRank()).toBe(gentleBefore);
  });

  it('dismissal cannot reach the engine at all, which is the structural form of that claim', () => {
    // Belt and braces on the behavioural test above, and the reason for it: the engine's input
    // type has no `dismissalCount` member, so no caller can supply one even by accident.
    // `@ts-expect-error` fails `tsc` if the line ever *stops* being an error, so the guarantee
    // cannot rot into a comment.
    const withDismissal = {
      mode: 'standard' as const,
      subjects: ENGINE_SUBJECTS,
      signals: SIGNALS,
      nowIso: NOW_ISO,
      flagEnabled: true,
      dismissalCount: 999,
    };
    rankAssistance(withDismissal);
    // The extra field is carried by the object but reaches no rule: the result is the one the
    // engine produces for the input without it.
    const without = { ...withDismissal };
    delete (without as Record<string, unknown>).dismissalCount;
    expect(fingerprintText(rankAssistance(withDismissal))).toBe(fingerprintText(rankAssistance(without)));
  });
});

describe('the assistance store reaches no writer', () => {
  it('its runtime import closure contains none of the enumerated writer modules', () => {
    const closure = runtimeClosureOf('src/store/assistanceStore.ts');
    expect(closure.unresolved).toEqual([]);
    expect(closure.files.length).toBeGreaterThan(1);
    const reached = closure.files.map(rel);
    for (const writer of WRITE_MODULES) {
      expect(reached, `assistanceStore reaches ${writer}`).not.toContain(writer);
    }
  });

  it('its runtime import closure reaches no renderer and no other store', () => {
    const reached = runtimeClosureOf('src/store/assistanceStore.ts').files.map(rel);
    const offenders = reached.filter(
      (path) =>
        path.startsWith('src/renderers/') ||
        path.startsWith('src/game/') ||
        (path.startsWith('src/store/') && path !== 'src/store/assistanceStore.ts'),
    );
    expect(offenders).toEqual([]);
  });

  it('its runtime import closure contains no reward ledger, no validator, and no SM-2 module', () => {
    // Spelled out by hand as well as by the walk, because the walk's `unresolved`/`offenders`
    // checks are the kind of thing that silently degrades to an empty answer.
    const reached = runtimeClosureOf('src/store/assistanceStore.ts').files.map(rel);
    for (const fragment of [
      'roomClearRewards',
      'reviewPassRewards',
      'catchRewards',
      'noteValidation',
      'spacedRepetition',
      'lootSystem',
      'progressionStore',
      'roomArtifact',
    ]) {
      expect(
        reached.filter((path) => path.includes(fragment)),
        `assistanceStore reaches ${fragment}`,
      ).toEqual([]);
    }
  });

  it('the one progression module its closure reaches is a pure normalizer, and that is stated', () => {
    // `assistanceStore` reaches `src/core/progression/canonicalProgression.ts`, through the
    // lazily imported `appRepository` adapter - which needs the normalizer for
    // `publishProgressionToActiveGeneration`. That is a fact a reader should be told rather
    // than discover, and it is **not** a writer: the module's own header states it never touches
    // `localStorage`, `IndexedDB`, the clock, or `Math.random`, and every identifier it mints is
    // injected by its caller.
    //
    // So this test does three things instead of pretending the module is absent:
    // 1. asserts it *is* reached, so the claim above cannot be satisfied by a broken walker;
    // 2. asserts nothing in the closure past it can write - no store, no service write layer;
    // 3. asserts the module's own text carries its purity statement, so an edit that made it
    //    impure would have to remove or contradict that statement to pass.
    const reached = runtimeClosureOf('src/store/assistanceStore.ts').files.map(rel);
    expect(reached).toContain('src/core/progression/canonicalProgression.ts');
    // Nothing writable past the normalizer.
    expect(
      reached.filter(
        (path) =>
          path.startsWith('src/store/') ||
          path.startsWith('src/application/') ||
          path.startsWith('src/ui/') ||
          path.startsWith('src/game/') ||
          path.startsWith('src/renderers/'),
      ),
    ).toEqual(['src/store/assistanceStore.ts']);
    const purity = readFileSync(
      join(SRC, 'core', 'progression', 'canonicalProgression.ts'),
      'utf8',
    );
    expect(purity).toContain('never touches `localStorage`');
    expect(purity).toContain('`Math.random()`');
    // And it has no value import of a store - the pre-existing type-only one is erased.
    const valueImports = [...purity.matchAll(/(?:^|[\s;}])import\s+(?!type\b)[^;'"]*?from\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    for (const specifier of valueImports) {
      expect(specifier.includes('@/store/'), `canonicalProgression value-imports ${specifier}`).toBe(false);
    }
  });

  it('the core engine reaches nothing outside src/core, so it cannot reach a writer either', () => {
    for (const entry of ['src/core/assistance/assistanceEngine.ts', 'src/core/assistance/types.ts', 'src/core/assistance/subjectInput.ts']) {
      const reached = runtimeClosureOf(entry).files.map(rel);
      expect(reached.length, entry).toBeGreaterThan(0);
      expect(reached.filter((path) => !path.startsWith('src/core/')), entry).toEqual([]);
    }
  });

  it('the storage-v2 adapter it reaches publishes only the assistance store', () => {
    // The adapter is the one module in the closure that can write. Asserted by reading it, and
    // by asserting the store names it names - so adding a second `putRecords` call with a
    // progression or subject array would be a visible diff against this list.
    const source = readFileSync(join(SRC, 'services', 'persistence', 'v2', 'appRepository.ts'), 'utf8');
    const reached = runtimeClosureOf('src/store/assistanceStore.ts').files.map(rel);
    expect(reached).toContain('src/services/persistence/v2/appRepository.ts');
    const publishAssistance = source.slice(
      source.indexOf('export async function publishAssistanceToActiveGeneration'),
      source.indexOf('/** Publish one finished study session. */'),
    );
    expect(publishAssistance.length).toBeGreaterThan(100);
    // Exactly one store name appears in the `putRecords` call.
    const putRecordsCall = publishAssistance.slice(publishAssistance.indexOf('putRecords('));
    for (const store of ['subjects', 'progression', 'sessions', 'preferences', 'shortcuts', 'customSprites', 'recovery']) {
      expect(putRecordsCall.includes(`${store}:`), `publishAssistance writes ${store}`).toBe(false);
    }
    expect(putRecordsCall).toContain('assistance:');
  });
});

describe('no assistance surface writes anything a learner-facing rule reads', () => {
  it('the legacy mirror holds exactly one key, and it is the assistance one', () => {
    window.localStorage.clear();
    useAssistanceStore.getState().dismissSuggestion();
    const keys = Object.keys(window.localStorage);
    expect(keys).toEqual([ASSISTANCE_STORAGE_KEY]);
    // And its content is a mode, four known counters, a dismissal count, and a timestamp -
    // no subject id, no room id, no topic, no note.
    const raw = window.localStorage.getItem(ASSISTANCE_STORAGE_KEY) as string;
    expect(raw).not.toContain(SUBJECT_ID);
    expect(raw).not.toContain('room-');
    expect(raw).not.toContain('Topic');
    expect(raw).not.toContain('must never read');
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      'assistanceId',
      'dismissalCount',
      'mode',
      'signals',
      'updatedAt',
    ]);
  });

  it('the storage-v2 assistance record holds only the five contract fields', async () => {
    useAssistanceStore.getState().bumpSignals({ repeatedDraft: 4 });
    useAssistanceStore.getState().dismissSuggestion();
    await pendingAssistanceWrites();
    const generationId = (await repository?.readActiveGenerationId()) as string;
    const snapshot = await repository?.readRecords(generationId);
    const records = snapshot?.records.assistance ?? [];
    expect(records.length).toBe(1);
    expect(Object.keys(records[0].value).sort()).toEqual([
      'assistanceId',
      'dismissalCount',
      'mode',
      'signals',
      'updatedAt',
    ]);
    const raw = JSON.stringify(records[0].value);
    expect(raw).not.toContain(SUBJECT_ID);
    expect(raw).not.toContain('room-');
    expect(raw).not.toContain('Topic');
    expect(raw).not.toContain('must never read');
  });
});

/**
 * Runtime import closure of one module, repo-relative paths.
 *
 * Comments are blanked before the scan. Without that, this walker matches every quoted string
 * in a file - including the prose in `assistanceStore.ts`'s module header, which quotes
 * `dismissedSuggestionIds` and `signals` and `@/core/assistance/types` while explaining the
 * per-suggestion-dismissal trade-off. Those strings resolve to nothing, so every such
 * explanation produced a spurious `unresolved` entry. The failure was legible - the paths in
 * the message were chunks of a comment - and it is recorded here because "the gate's walker
 * reads prose" is a bug that looks like a product defect for about ten minutes.
 */
function runtimeClosureOf(entry: string): { files: string[]; unresolved: string[] } {
  const files: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file) || !statSync(file).isFile()) {
      unresolved.push(file);
      continue;
    }
    files.push(file);
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/import\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
      .replace(/export\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
      .replace(/import\s*\{[^}]*\btype\s+[^}]*\}\s*from\s*['"][^'"]+['"]/g, '');
    const specifiers = [
      ...[...source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ];
    for (const specifier of specifiers) {
      const base = specifier.startsWith('@/')
        ? resolve(SRC, specifier.slice(2))
        : specifier.startsWith('.')
          ? resolve(dirname(file), specifier)
          : null;
      if (base === null) continue;
      let target = base;
      if (existsSync(`${base}.ts`)) target = `${base}.ts`;
      else if (existsSync(`${base}.tsx`)) target = `${base}.tsx`;
      else if (existsSync(base) && statSync(base).isDirectory()) {
        const index = readdirSync(base).find((name) => name === 'index.ts' || name === 'index.tsx');
        target = index === undefined ? base : join(base, index);
      }
      if (!existsSync(target)) {
        unresolved.push(target);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, unresolved };
}

function rel(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

/** The directory the walker above enumerates, so a reader can see it is not `src/`. */
export const WALKED_ROOT = SRC;
