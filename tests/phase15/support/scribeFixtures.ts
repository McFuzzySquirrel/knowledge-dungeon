/**
 * A synthetic subject for the Phase 15 component tests, built with the real graph domain.
 *
 * ## Why this is constructed rather than written out
 *
 * Two of the five Phase 15 exit criteria are about what the *store* does with a room, not
 * about what the workspace renders: a valid note must clear and reward exactly once, and an
 * invalid note must save a draft with no progression change. Both of those turn on
 * `deriveRoomClearIdentity`, which digests the room's edge window - so a hand-written
 * dungeon with no edges would not exercise the identity the phase is about at all.
 *
 * So this module builds its subject through `createRootDungeon` and `addLinkedRooms` - the
 * same functions the application layer calls - and derives every room id from the result.
 *
 * ## Hermeticity
 *
 * No clock, no network, no `dist/`, no renderer, and no persistence: `saveSubjectSnapshot`
 * is mocked by the test files that commit, so a note submission in these tests is an
 * in-memory store update plus the reward transaction and nothing else.
 */
import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { makeEmptyRoomMetadata } from '@/core/validation/persistence';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';

export const FIXTURE_NOW = '2026-02-01T00:00:00.000Z';

export const FIXTURE_DUNGEON_ID = 'subject-scribe-fixture';

export interface ScribeFixture {
  readonly snapshot: SubjectSnapshot;
  readonly rootRoomId: string;
  /** A direct child of the root, on its own floor. */
  readonly matrixRoomId: string;
  /** A child of the matrix room. */
  readonly eigenRoomId: string;
  /** The journal note id `collectArtifactNote` builds for the matrix room. */
  readonly matrixNoteId: string;
}

/**
 * ```
 * Linear Algebra            (root)
 * └── Matrices              (own floor)
 *     └── Eigenvalues
 * ```
 *
 * The nested child exists so the shell header's `Floor` and `Path` rows have something to
 * report that is not the root topic, which is what makes the header assertions non-trivial.
 */
export function buildScribeFixture(): ScribeFixture {
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

  return {
    snapshot,
    rootRoomId,
    matrixRoomId: 'room-matrices',
    eigenRoomId: 'room-eigen',
    matrixNoteId: `${FIXTURE_DUNGEON_ID}:room-matrices`,
  };
}

/** A note with all three required headings, which is what a draft always composes to. */
export const COMPLETE_NOTE_TEXT = [
  'Summary',
  'A matrix is a rectangular array of numbers that acts on a vector.',
  '',
  'Key Points',
  '- Matrices encode linear maps.',
  '- Composition becomes multiplication.',
  '- Determinants describe area scaling.',
  '',
  'Recall Question',
  'What does multiplying a matrix by a vector produce?',
  'How does a determinant relate to area?',
].join('\n');

/**
 * A room whose note has been drafted and saved, but which has not been cleared.
 *
 * The state a learner returns to, and therefore the one that makes "make incomplete
 * encounters visibly resumable" a testable claim rather than a slogan.
 */
export function withDraftNote(snapshot: SubjectSnapshot, roomId: string): SubjectSnapshot {
  const room = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  return {
    dungeon: {
      ...snapshot.dungeon,
      rooms: snapshot.dungeon.rooms.map((summary) =>
        summary.roomId === roomId ? { ...summary, status: 'NotesDrafted' } : summary,
      ),
    },
    rooms: {
      ...snapshot.rooms,
      [roomId]: {
        ...room,
        state: 'NotesDrafted',
        noteText: COMPLETE_NOTE_TEXT,
        validationState: {
          ...room.validationState,
          wordCount: 40,
          requiredSectionsPresent: true,
          manualConfirmed: false,
          qualityBonus: 6,
        },
      },
    },
  };
}

/** A room that has been cleared, with the artifact the store would have written. */
export function withClearedRoom(
  snapshot: SubjectSnapshot,
  roomId: string,
  artifactMarkdown: string,
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
        noteText: COMPLETE_NOTE_TEXT,
        artifactMarkdown,
        validationState: {
          ...room.validationState,
          wordCount: 40,
          requiredSectionsPresent: true,
          manualConfirmed: true,
          qualityBonus: 6,
          finalPass: true,
        },
      },
    },
  };
}

/** A room the graph has invalidated, which the view model reports as not resumable as cleared. */
export function withNeedsRevalidation(
  snapshot: SubjectSnapshot,
  roomId: string,
): SubjectSnapshot {
  const room = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  return {
    dungeon: {
      ...snapshot.dungeon,
      rooms: snapshot.dungeon.rooms.map((summary) =>
        summary.roomId === roomId ? { ...summary, status: 'NeedsRevalidation' } : summary,
      ),
    },
    rooms: {
      ...snapshot.rooms,
      [roomId]: { ...room, state: 'NeedsRevalidation' },
    },
  };
}

/** A snapshot with one attachment already on a room, for the image-library assertions. */
export function withAttachment(
  snapshot: SubjectSnapshot,
  roomId: string,
  attachment: RoomMetadata['attachments'][number],
): SubjectSnapshot {
  const room = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  return {
    dungeon: snapshot.dungeon,
    rooms: {
      ...snapshot.rooms,
      [roomId]: { ...room, attachments: [...room.attachments, attachment] },
    },
  };
}

/**
 * A complete, valid 1x1 PNG written byte by byte.
 *
 * Synthetic and self-describing, copied from `tests/privacy/attachmentBytes.test.ts` rather
 * than from anywhere real, so the attachment path carries no third-party bytes.
 */
export const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];