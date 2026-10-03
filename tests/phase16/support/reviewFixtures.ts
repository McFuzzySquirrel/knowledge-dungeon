/**
 * A synthetic subject for the Phase 16 component tests.
 *
 * ## Why this is built with the real graph domain
 *
 * The review commands enforce `canReviewRoom`, which asks `evaluateReviewUnlock` over
 * `dungeon.rooms` and the *reviewable* subset of them. A hand-written snapshot with three
 * rooms and no edges would not exercise the population the unlock counts, and a fixture that
 * happened to have every room reviewable would make the locked branch untestable for the
 * wrong reason - the branch would never be reached rather than being reached and refused.
 *
 * So this builds the dungeon through `createRootDungeon` and `addLinkedRooms`, exactly as the
 * application layer does, and derives every room id from the result.
 *
 * ## Why every room is cleared by default
 *
 * `evaluateReviewUnlock` requires `completionRatio >= requiredCompletionRatio`, and the ratio's
 * denominator is `dungeon.rooms.length`. A fixture where one room is undefeated therefore has
 * `unlocked: false` *for every room in it*, which is what makes `withUndefeatedRoom` the
 * locked-lane fixture rather than a per-room state. That is the domain's rule, not this
 * module's, and `tests/phase16/reviewPasses.test.ts` owns pinning it.
 *
 * ## Hermeticity
 *
 * No clock, no network, no `dist/`, no renderer, and no persistence. `saveSubjectSnapshot` is
 * mocked by the test files that commit, so a completed review in these tests is an in-memory
 * store update plus the reward transaction and nothing else.
 */
import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { makeEmptyRoomMetadata } from '@/core/validation/persistence';
import type { RoomMetadata, RoomState, SubjectSnapshot } from '@/core/validation/persistence';

export const FIXTURE_NOW = '2026-03-01T00:00:00.000Z';

export const FIXTURE_DUNGEON_ID = 'subject-review-fixture';

export interface ReviewFixture {
  readonly snapshot: SubjectSnapshot;
  readonly rootRoomId: string;
  readonly matrixRoomId: string;
  readonly eigenRoomId: string;
}

/**
 * ```
 * Linear Algebra            (root)
 * └── Matrices              (own floor)
 *     └── Eigenvalues
 * ```
 *
 * Three rooms so the pass denominator is 3 rather than 1, which is what makes
 * `roomsTowardNextPass / totalRooms` a fraction that can actually be wrong and therefore worth
 * asserting.
 */
export function buildReviewFixture(): ReviewFixture {
  const rootRoomId = 'room-root';
  const created = createRootDungeon({
    dungeonId: FIXTURE_DUNGEON_ID,
    subjectName: 'Linear Algebra',
    rootRoomId,
    rootTopic: 'Linear Algebra',
    nowIso: FIXTURE_NOW,
  });
  if (!created.ok) throw new Error(`Fixture root refused: ${created.error.message}`);

  const withMatrices = addLinkedRooms(created.value, {
    fromRoomId: rootRoomId,
    drafts: [{ roomId: 'room-matrices', topic: 'Matrices' }],
    nowIso: FIXTURE_NOW,
  });
  if (!withMatrices.ok) {
    throw new Error(`Fixture matrices refused: ${withMatrices.error.message}`);
  }

  const withEigen = addLinkedRooms(withMatrices.value.dungeon, {
    fromRoomId: 'room-matrices',
    drafts: [{ roomId: 'room-eigen', topic: 'Eigenvalues' }],
    nowIso: FIXTURE_NOW,
  });
  if (!withEigen.ok) throw new Error(`Fixture eigen refused: ${withEigen.error.message}`);

  const snapshot: SubjectSnapshot = {
    dungeon: withEigen.value.dungeon,
    rooms: Object.fromEntries(
      [
        makeEmptyRoomMetadata({ roomId: rootRoomId, topic: 'Linear Algebra', nowIso: FIXTURE_NOW }),
        makeEmptyRoomMetadata({ roomId: 'room-matrices', topic: 'Matrices', nowIso: FIXTURE_NOW }),
        makeEmptyRoomMetadata({ roomId: 'room-eigen', topic: 'Eigenvalues', nowIso: FIXTURE_NOW }),
      ].map((room) => [room.roomId, room]),
    ),
  };

  return { snapshot, rootRoomId, matrixRoomId: 'room-matrices', eigenRoomId: 'room-eigen' };
}

/** The artifact markdown the store writes on the clear branch. */
export const ARTIFACT_MARKDOWN = [
  '# Matrices',
  '',
  'A matrix is a rectangular array of numbers that acts on a vector.',
  '',
  '## Key Points',
  '',
  '- Matrices encode linear maps.',
  '- Composition becomes multiplication.',
  '',
  '## Recall Question',
  '',
  'What does multiplying a matrix by a vector produce?',
].join('\n');

/** A note with all three required headings, which is what a cleared room carries. */
export const CLEARED_NOTE_TEXT = [
  '## Summary',
  'A matrix acts on a vector by multiplication.',
  '',
  '## Key Points',
  '- Composition is multiplication.',
  '',
  '## Recall Question',
  'What does a matrix do to a vector?',
].join('\n');

/** One room, cleared, with its artifact. Every room starts this way in the fixture. */
export function withClearedRoom(
  snapshot: SubjectSnapshot,
  roomId: string,
  artifactMarkdown: string = ARTIFACT_MARKDOWN,
): SubjectSnapshot {
  const room = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  return {
    dungeon: {
      ...snapshot.dungeon,
      rooms: snapshot.dungeon.rooms.map((summary) =>
        summary.roomId === roomId ? { ...summary, status: 'ArtifactCollected' } : summary,
      ),
    },
    rooms: {
      ...snapshot.rooms,
      [roomId]: {
        ...room,
        state: 'ArtifactCollected',
        noteText: CLEARED_NOTE_TEXT,
        artifactMarkdown,
        reviewPassCount: room.reviewPassCount,
        sm2NextReviewDate: room.sm2NextReviewDate,
        validationState: {
          ...room.validationState,
          wordCount: 30,
          requiredSectionsPresent: true,
          manualConfirmed: true,
          qualityBonus: 6,
          finalPass: true,
        },
      },
    },
  };
}

/** The whole fixture cleared, which is what makes the review unlock satisfied. */
export function withEveryRoomCleared(snapshot: SubjectSnapshot): SubjectSnapshot {
  return Object.values(snapshot.rooms).reduce(
    (accumulated, room) => withClearedRoom(accumulated, room.roomId),
    snapshot,
  );
}

/** A snapshot in which one room has never been defeated, which locks review for all of them. */
export function withUndefeatedRoom(
  snapshot: SubjectSnapshot,
  roomId: string,
): SubjectSnapshot {
  const room = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  /*
   * `'Uncreated'`, taken from `RoomState`, rather than a plausible-sounding `'Undiscovered'`.
   *
   * The state has to be *one of the seven declared values* or `isReviewableState` rejects it,
   * and a value outside the union is a type error rather than a silently-unreviewable room -
   * which is the failure mode this fixture exists to reach, so it has to be reached on purpose.
   */
  const undefeated: RoomState = 'Uncreated';
  return {
    dungeon: {
      ...snapshot.dungeon,
      rooms: snapshot.dungeon.rooms.map((summary) =>
        summary.roomId === roomId ? { ...summary, status: undefeated } : summary,
      ),
    },
    rooms: {
      ...snapshot.rooms,
      [roomId]: {
        ...room,
        state: undefeated,
        artifactMarkdown: null,
        validationState: { ...room.validationState, finalPass: false },
      },
    },
  };
}

/**
 * A room with the SM-2 fields set, so the due state has something to compare against.
 *
 * `reviewPassCount` is taken as a parameter because the pass number is derived from the sum
 * over the reviewable rooms, and a test that wants "this room already counts toward pass 1"
 * has to set it on every room, not one.
 */
export function withSchedule(
  snapshot: SubjectSnapshot,
  roomId: string,
  schedule: { reviewPassCount: number; sm2NextReviewDate: string | null },
): SubjectSnapshot {
  const room: RoomMetadata | undefined = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  return {
    dungeon: snapshot.dungeon,
    rooms: {
      ...snapshot.rooms,
      [roomId]: {
        ...room,
        reviewPassCount: schedule.reviewPassCount,
        sm2NextReviewDate: schedule.sm2NextReviewDate ?? undefined,
      },
    },
  };
}