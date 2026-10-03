/**
 * A synthetic subject for the Phase 14 component tests, built with the real graph domain.
 *
 * ## Why the fixture is constructed rather than written out
 *
 * Every verb the workspace offers is defined by what the graph domain will accept, and
 * several of them are refused for conditions a hand-written fixture would have to get
 * right by hand: a reparent under a descendant, a cross-link that already exists, a
 * duplicate topic. So this module builds its subject through `createRootDungeon` and
 * `addLinkedRooms` - the same functions the application layer calls - and derives the
 * room ids the tests need from the result rather than inventing them.
 *
 * ## Hermeticity
 *
 * No clock, no network, no `dist/`, no renderer, and no persistence: `saveSubjectSnapshot`
 * is mocked by the test files that commit, so a mutation in these tests is an in-memory
 * store update and nothing else.
 */
import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { makeEmptyRoomMetadata } from '@/core/validation/persistence';
import type { DungeonMetadata, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';

export const FIXTURE_NOW = '2026-01-01T00:00:00.000Z';

export interface CreatorFixture {
  readonly snapshot: SubjectSnapshot;
  readonly rootRoomId: string;
  /** A direct child of the root. */
  readonly matrixRoomId: string;
  /** A second direct child of the root. */
  readonly vectorRoomId: string;
  /** A child of the matrix room: a descendant, so reparenting it under itself is refused. */
  readonly eigenRoomId: string;
  /** A room that is not connected to the root room's tree at all. */
  readonly detachedRoomId: string;
}

function roomMetadata(roomId: string, topic: string): RoomMetadata {
  return makeEmptyRoomMetadata({ roomId, topic, nowIso: FIXTURE_NOW });
}

function snapshotOf(dungeon: DungeonMetadata, rooms: RoomMetadata[]): SubjectSnapshot {
  return { dungeon, rooms: Object.fromEntries(rooms.map((room) => [room.roomId, room])) };
}

/**
 * Four rooms:
 *
 * ```
 * Linear Algebra            (root)
 * ├── Matrices
 * │   └── Eigenvalues
 * └── Vectors
 * Determinants               (separate root-level child, added last)
 * ```
 *
 * `Determinants` is a sibling of `Matrices` and `Vectors`, so the root room has three
 * children: enough for the `rooms.length >= 3` Scribe transition to be available, and
 * enough for a reparent and a cross-link to have legal targets.
 */
export function buildCreatorFixture(): CreatorFixture {
  const rootRoomId = 'room-root';
  const created = createRootDungeon({
    dungeonId: 'subject-fixture',
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
  if (!withMatrices.ok) throw new Error(`Fixture matrices refused: ${withMatrices.error.message}`);

  const withEigen = addLinkedRooms(withMatrices.value.dungeon, {
    fromRoomId: 'room-matrices',
    drafts: [{ roomId: 'room-eigen', topic: 'Eigenvalues' }],
    nowIso: FIXTURE_NOW,
  });
  if (!withEigen.ok) throw new Error(`Fixture eigen refused: ${withEigen.error.message}`);

  const withVectors = addLinkedRooms(withEigen.value.dungeon, {
    fromRoomId: rootRoomId,
    drafts: [
      { roomId: 'room-vectors', topic: 'Vectors' },
      { roomId: 'room-determinants', topic: 'Determinants' },
    ],
    nowIso: FIXTURE_NOW,
  });
  if (!withVectors.ok) throw new Error(`Fixture vectors refused: ${withVectors.error.message}`);

  const rooms = [
    roomMetadata(rootRoomId, 'Linear Algebra'),
    roomMetadata('room-matrices', 'Matrices'),
    roomMetadata('room-eigen', 'Eigenvalues'),
    roomMetadata('room-vectors', 'Vectors'),
    roomMetadata('room-determinants', 'Determinants'),
  ];

  return {
    snapshot: snapshotOf(withVectors.value.dungeon, rooms),
    rootRoomId,
    matrixRoomId: 'room-matrices',
    vectorRoomId: 'room-vectors',
    eigenRoomId: 'room-eigen',
    detachedRoomId: 'room-determinants',
  };
}

/** A snapshot with the room's tags replaced, for the tag verbs. */
export function withTags(snapshot: SubjectSnapshot, roomId: string, tags: string[]): SubjectSnapshot {
  const room = snapshot.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
  return {
    dungeon: {
      ...snapshot.dungeon,
      tagIndex: tags.reduce<Record<string, string[]>>((index, tag) => {
        index[tag] = [...(index[tag] ?? []), roomId];
        return index;
      }, {}),
    },
    rooms: { ...snapshot.rooms, [roomId]: { ...room, tags } },
  };
}

/** The parent room id of `roomId` in a snapshot, or `null` at the root. */
export function parentOf(snapshot: SubjectSnapshot, roomId: string): string | null {
  const edge = snapshot.dungeon.edges.find(
    (entry) => entry.toRoomId === roomId && entry.relationType === 'subtopic',
  );
  return edge?.fromRoomId ?? null;
}

/** The ids of every `subtopic` parent edge's target, i.e. the room's children. */
export function childrenOf(snapshot: SubjectSnapshot, roomId: string): string[] {
  return snapshot.dungeon.edges
    .filter((entry) => entry.fromRoomId === roomId && entry.relationType === 'subtopic')
    .map((entry) => entry.toRoomId);
}

/** How many non-`subtopic` edges touch a room. */
export function crossLinkCountOf(snapshot: SubjectSnapshot, roomId: string): number {
  return snapshot.dungeon.edges.filter(
    (entry) => entry.relationType !== 'subtopic' && (entry.fromRoomId === roomId || entry.toRoomId === roomId),
  ).length;
}
