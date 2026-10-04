/**
 * The synthetic subject Phase 17's recall-route test seeds, and why it has to exist at all.
 *
 * ## The branch this reaches, and the one it is not
 *
 * `useVillageFishing.onKeep` resolves the recall question against the **session's own subject**
 * and only when that subject has a cleared room:
 *
 * ```
 * if (snapshot !== null && snapshot.dungeon.dungeonId === session.subjectId) {
 *   question = pullRecallQuestion({ clearedRooms: getClearedRooms(snapshot.rooms), ... });
 * }
 * ```
 *
 * A subject the application mints for itself has none, so the fresh tutorial subject reaches
 * only the **third** outcome — "kept with no question" — which is exactly what the
 * keep-without-recall test covers. Nothing else in the lane can reach the question branch, and a
 * skipped test would leave "the recall question offers a route back to the room it came from"
 * without any browser evidence at all.
 *
 * ## Why the *active* subject, asserted rather than hoped for
 *
 * The session's `subjectId` is minted from `useSubjectStore`'s snapshot when the pond is
 * entered, and `onKeep` compares that snapshot's `dungeon.dungeonId` against the session's — so
 * a snapshot that is merely *present* is not enough; the one the store holds has to be the one
 * the pond was entered from. `Welcome`'s "Continue to Village" loads the subject named by
 * `:activeSubjectId` during bootstrap, so the seed points that key at the fixture and the test
 * then **asserts** it still names the fixture. See {@link readSeededSubjectState} and
 * {@link assertSeededRecallPremise}.
 *
 * There is a second, unrelated coupling the same seed has to satisfy, and it is why
 * {@link assertSeededRecallPremise} also asserts the subject index. `studyFlow.enterFishing`
 * derives the pond's `hasClearedRooms` from **whichever subject occupies the portal slot nearest
 * the pond**, so seeding several subjects fills every portal slot and can hand the pond a
 * different, room-less subject — which disables the charge control and makes the test fail for a
 * reason that has nothing to do with recall. One subject, asserted to be the only one, removes
 * the ambiguity rather than relying on the order the seed happened to write.
 *
 * ## Synthetic by construction
 *
 * Every identifier here is a literal this file wrote. There is no learner data, no request body,
 * no credential, and no URL — the seed is three `localStorage` writes whose only contents are
 * two invented ids and an invented display name. The timestamps are a fixed literal for the same
 * reason: a record that changes every run cannot be compared against a recorded one.
 *
 * ## Why this is a module and not a block inside the spec
 *
 * Three reasons, in order of how much they cost if they are ignored. The spec files carry a
 * privacy gate that forbids a learner-shaped field from appearing in them at all, and this
 * fixture legitimately names `dungeonId` and `subjectName`; the pure half has to be exercised by
 * `npm test` rather than only by a browser run; and the storage-key literals need one home that
 * can be asserted against the product's own `STORAGE_KEYS` table.
 */

import type { Page } from '@playwright/test';

/** The schema version the application's own `CURRENT_SCHEMA_VERSION` is. */
const FIXTURE_SCHEMA_VERSION = '1.1.0';

/** A fixed instant, so two runs seed byte-identical records. */
const FIXTURE_TIMESTAMP = '2024-01-01T00:00:00.000Z';

/** The subject id. Invented here and nowhere else. */
export const RECALL_FIXTURE_SUBJECT_ID = 'phase17-recall-fixture-subject';

/** The one cleared room the recall question is drawn from. */
export const RECALL_FIXTURE_ROOM_ID = 'phase17-recall-fixture-room';

/** The invented display name the prompt sentence will mention. */
export const RECALL_FIXTURE_SUBJECT_NAME = 'Phase 17 Recall Fixture';

/** The invented room topic the prompt sentence will mention. */
export const RECALL_FIXTURE_ROOM_TOPIC = 'Recall Fixture Room Topic';

/**
 * One note heading, so the fixture has recall material of more than one kind.
 *
 * `generateSelfCheckPrompts` produces a topic prompt unconditionally, so this is not needed to
 * reach the branch; it is here so the seeded room is a plausible cleared room rather than a
 * minimal one, and so a future change that requires note material fails loudly instead of
 * quietly falling back to the topic prompt.
 */
export const RECALL_FIXTURE_NOTE_TEXT = '# Recall Fixture Heading\n\nA synthetic line.';

/**
 * The storage keys, spelled out.
 *
 * They are `STORAGE_KEYS` from `src/services/persistence/subjectPersistence.ts`, restated as
 * literals for the same reason the walk's movement numbers are: this module is loaded by a
 * Playwright worker that does not resolve the `@/` alias. `tests/e2e/fishing-lane.test.ts`
 * asserts all three against that table, so a renamed key fails `npm test` rather than leaving a
 * seed that silently writes nothing.
 */
export const RECALL_FIXTURE_SUBJECT_INDEX_KEY = 'knowledge-dungeon:v1:subjects';
export const RECALL_FIXTURE_ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';
export const RECALL_FIXTURE_SUBJECT_KEY = `knowledge-dungeon:v1:subject:${RECALL_FIXTURE_SUBJECT_ID}`;

/** One `localStorage` write. */
export interface StorageSeedEntry {
  readonly key: string;
  readonly value: string;
}

/** A cleared room, in the shape `getClearedRooms` reads. */
function clearedRoom(): Record<string, unknown> {
  return {
    roomId: RECALL_FIXTURE_ROOM_ID,
    topic: RECALL_FIXTURE_ROOM_TOPIC,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    // `getClearedRooms` admits a room only when its state is reviewable **and** validation
    // passed, so both halves are set: `ArtifactCollected` is one of the three reviewable states.
    state: 'ArtifactCollected',
    notePath: '',
    artifactPath: '',
    noteText: RECALL_FIXTURE_NOTE_TEXT,
    artifactMarkdown: null,
    validationState: {
      wordCount: 0,
      requiredSectionsPresent: true,
      manualConfirmed: true,
      criterionScores: {
        sectionCompleteness: 1,
        conceptTermCoverage: 1,
        linkReferences: 1,
        recallQuestionQuality: 1,
        clarityReadability: 1,
      },
      failedChecks: [],
      qualityBonus: 0,
      finalPass: true,
    },
    reviewPassCount: 1,
    attachments: [],
    tags: [],
    sm2QualityResponse: 4,
    sm2EaseFactor: 2.5,
    sm2IntervalDays: 1,
    sm2NextReviewDate: FIXTURE_TIMESTAMP,
    sm2ConsecutiveCorrect: 1,
  };
}

/**
 * The synthetic subject, as a plain object.
 *
 * Shaped to `SubjectSnapshot` rather than typed as one, so this module has no import from
 * `src/` — the same constraint that forced the storage keys to be literals. The gate in
 * `tests/e2e/fishing-lane.test.ts` asserts the two facts the branch depends on: the room's
 * `state` is one of `getClearedRooms`'s reviewable states and its `validationState.finalPass` is
 * `true`.
 */
export function recallFixtureSnapshot(): Record<string, unknown> {
  return {
    dungeon: {
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      dungeonId: RECALL_FIXTURE_SUBJECT_ID,
      subjectName: RECALL_FIXTURE_SUBJECT_NAME,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      phaseState: 'ArchaeologistActive',
      rootRoomId: RECALL_FIXTURE_ROOM_ID,
      rooms: [{ roomId: RECALL_FIXTURE_ROOM_ID, topic: RECALL_FIXTURE_ROOM_TOPIC, status: 'ArtifactCollected' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
      tagIndex: {},
    },
    rooms: { [RECALL_FIXTURE_ROOM_ID]: clearedRoom() },
  };
}

/**
 * The three writes that stand the fixture up, in the order the application reads them.
 *
 * Index first, then the subject it names, then the pointer at it: `readAppStateFromLegacy` needs
 * the index before it will load a subject at all, so a seed that wrote the pointer first would
 * look like a device with an active id and nothing behind it.
 */
export function recallFixtureStorageSeed(): readonly StorageSeedEntry[] {
  return [
    { key: RECALL_FIXTURE_SUBJECT_INDEX_KEY, value: JSON.stringify([RECALL_FIXTURE_SUBJECT_ID]) },
    { key: RECALL_FIXTURE_SUBJECT_KEY, value: JSON.stringify(recallFixtureSnapshot()) },
    { key: RECALL_FIXTURE_ACTIVE_SUBJECT_KEY, value: RECALL_FIXTURE_SUBJECT_ID },
  ];
}

/**
 * Seed the fixture into every document the page will load, before the first navigation.
 *
 * `addInitScript` rather than a `page.evaluate` after `goto`, because the application's bootstrap
 * reads the active subject once during startup: a seed written after the first load would be read
 * by nothing, and the lane would quietly measure the tutorial subject again.
 */
export async function installRecallFixture(page: Page): Promise<void> {
  await page.addInitScript((seed: readonly StorageSeedEntry[]) => {
    for (const entry of seed) {
      window.localStorage.setItem(entry.key, entry.value);
    }
  }, recallFixtureStorageSeed());
}

/** What the fixture can be observed to have established. */
export interface SeededSubjectState {
  readonly activeSubjectId: string | null;
  readonly subjectIds: readonly string[];
}

/**
 * Read back the two storage facts the recall branch depends on, from the live page.
 *
 * Reading `localStorage` rather than an internal store is deliberate. The store is the
 * application's, not the lane's, and there is no DOM attribute for it; the storage keys are what
 * the branch's two preconditions are written in terms of, so asserting on them asserts the
 * fixture's premise rather than a restatement of it. Nothing here can carry learner data: both
 * values are whatever the seed wrote or whatever is absent.
 */
export async function readSeededSubjectState(page: Page): Promise<SeededSubjectState> {
  return page.evaluate(
    ({ indexKey, activeKey }) => {
      const readIndex = (): readonly string[] => {
        const raw = window.localStorage.getItem(indexKey);
        if (raw === null) return [];
        try {
          const parsed: unknown = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
        } catch {
          return [];
        }
      };
      return {
        activeSubjectId: window.localStorage.getItem(activeKey),
        subjectIds: readIndex(),
      };
    },
    { indexKey: RECALL_FIXTURE_SUBJECT_INDEX_KEY, activeKey: RECALL_FIXTURE_ACTIVE_SUBJECT_KEY },
  );
}

/**
 * Assert, in the spec, the two preconditions the recall branch needs — and fail with the
 * measurement rather than a paraphrase of it.
 *
 * Deliberately two assertions and not one: "the active subject is the fixture" and "the fixture
 * is the only subject" are different facts, they are read from different keys, and either can
 * break on its own. The second is what stops `enterFishing`'s portal-slot derivation from handing
 * the pond a room-less subject, which would disable the charge control and make a later assertion
 * fail for a reason that has nothing to do with recall.
 */
export function recallFixturePremiseFailures(state: SeededSubjectState): readonly string[] {
  const problems: string[] = [];
  if (state.activeSubjectId !== RECALL_FIXTURE_SUBJECT_ID) {
    problems.push(
      `the active-subject pointer is ${JSON.stringify(state.activeSubjectId)} rather than the seeded ` +
        `${RECALL_FIXTURE_SUBJECT_ID}. onKeep compares the store's snapshot id against the fishing ` +
        "session's subject id, so a snapshot that is merely present is not enough: the pond has to " +
        'have been entered from the seeded subject.',
    );
  }
  if (state.subjectIds.length !== 1 || state.subjectIds[0] !== RECALL_FIXTURE_SUBJECT_ID) {
    problems.push(
      `the subject index holds ${JSON.stringify(state.subjectIds)} rather than exactly the seeded id. ` +
        'enterFishing derives the pond\'s hasClearedRooms from whichever subject occupies the portal ' +
        'slot nearest the pond, so a second subject can fill that slot with a room-less one and ' +
        'disable the charge control.',
    );
  }
  return problems;
}