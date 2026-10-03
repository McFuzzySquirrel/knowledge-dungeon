/**
 * Fixture builders for the Phase 14 Creator graph-command tests.
 *
 * Two jobs, both of which exist so the tests can compare the two lanes honestly:
 *
 * 1. **Build a subject snapshot with hand-picked room statuses.** Revalidation
 *    only fires for rooms in `CLEARED_OR_NOTES_PROGRESS_STATES`, and only once
 *    `ScribeActive` has been reached, so a test that wants to observe
 *    propagation has to be able to say "this room is `ArtifactCollected`" and
 *    "the dungeon is in `ScribeActive`" without going through the domain.
 *
 * 2. **Normalize a snapshot for cross-lane comparison.** The two lanes mint
 *    room ids and stamp timestamps differently - the store uses its private
 *    `generateId` plus `new Date()`, the application layer takes both from
 *    injected ports - so a raw `toEqual` would fail on noise and prove
 *    nothing. `normalizeSnapshotForParity` erases exactly those two things
 *    (generated room ids, wall-clock timestamps) and nothing else, which is
 *    what makes a remaining difference a real defect.
 */
import {
  makeEmptyRoomMetadata,
  type DungeonEdge,
  type DungeonMetadata,
  type PhaseState,
  type RoomMetadata,
  type RoomState,
  type SubjectSnapshot,
} from '@/core/validation/persistence';

/** A fixed clock. Nothing in these tests may read the real one. */
export const FIXED_NOW = '2026-10-03T09:00:00.000Z';

export const SUBJECT_ID = 'subject-creator-parity';

/** A room summary in the dungeon plus the metadata entry beside it. */
export interface FixtureRoomSpec {
  roomId: string;
  topic: string;
  status: RoomState;
  /** Overrides merged over `makeEmptyRoomMetadata`, for rich-metadata cases. */
  metadata?: Partial<RoomMetadata>;
}

export interface FixtureEdgeSpec {
  fromRoomId: string;
  toRoomId: string;
  relationType?: DungeonEdge['relationType'];
}

export interface FixtureOptions {
  phaseState?: PhaseState;
  rooms: readonly FixtureRoomSpec[];
  edges?: readonly FixtureEdgeSpec[];
  rootRoomId?: string;
}

/**
 * A subject snapshot with every field the persistence schema declares.
 *
 * `tagIndex` starts empty because the tag domain rebuilds it from room
 * metadata on every tag write; seeding it here would only add a field the tests
 * never assert on.
 */
export function makeSubjectSnapshot(options: FixtureOptions): SubjectSnapshot {
  const rootRoomId = options.rootRoomId ?? options.rooms[0]?.roomId;
  if (rootRoomId === undefined) {
    throw new Error('makeSubjectSnapshot needs at least one room');
  }

  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: 'Linear Algebra',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    phaseState: options.phaseState ?? 'ScribeActive',
    rootRoomId,
    rooms: options.rooms.map((room) => ({
      roomId: room.roomId,
      topic: room.topic,
      status: room.status,
    })),
    edges: (options.edges ?? []).map((edge) => ({
      fromRoomId: edge.fromRoomId,
      toRoomId: edge.toRoomId,
      relationType: edge.relationType ?? 'subtopic',
      createdAt: FIXED_NOW,
      createdByPhase: 'Creator',
    })),
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    tagIndex: {},
  };

  const rooms: Record<string, RoomMetadata> = {};
  for (const room of options.rooms) {
    rooms[room.roomId] = {
      ...makeEmptyRoomMetadata({ roomId: room.roomId, topic: room.topic, nowIso: FIXED_NOW }),
      ...room.metadata,
    };
  }

  return { dungeon, rooms };
}

/**
 * The three-room shape most Phase 14 tests need: a root, a cleared room with a
 * cleared child, and a `Visited` room that carries tags.
 *
 * `ArtifactCollected` is in the domain's `CLEARED_OR_NOTES_PROGRESS_STATES`,
 * so any room in that state that propagation reaches flips to
 * `NeedsRevalidation` - which is what makes "did propagation run?" observable.
 */
export function makeRevalidationFixture(overrides: Partial<FixtureOptions> = {}): SubjectSnapshot {
  return makeSubjectSnapshot({
    phaseState: 'ScribeActive',
    rooms: [
      { roomId: 'room-root', topic: 'Vector Spaces', status: 'Created' },
      { roomId: 'room-alpha', topic: 'Subspaces', status: 'ArtifactCollected' },
      { roomId: 'room-beta', topic: 'Bases', status: 'ArtifactCollected' },
      {
        roomId: 'room-gamma',
        topic: 'Linear Maps',
        status: 'Visited',
        metadata: { tags: ['seed-tag'] },
      },
    ],
    edges: [
      { fromRoomId: 'room-root', toRoomId: 'room-alpha' },
      { fromRoomId: 'room-alpha', toRoomId: 'room-beta' },
      { fromRoomId: 'room-root', toRoomId: 'room-gamma' },
    ],
    ...overrides,
  });
}

/** `{ roomId: status }` for every room in a dungeon, in dungeon order. */
export function statusesByRoomId(dungeon: DungeonMetadata): Record<string, RoomState> {
  return Object.fromEntries(dungeon.rooms.map((room) => [room.roomId, room.status]));
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Sentinel both lanes collapse onto, so only *relative* timestamps survive. */
export const TIMESTAMP_PLACEHOLDER = '<timestamp>';

/**
 * Rewrite a snapshot so two lanes that differ only in generated ids and
 * wall-clock timestamps compare equal - and so that any *other* difference
 * still shows up.
 *
 * Generated room ids are aliased in dungeon order, which both lanes produce in
 * draft order, so `__new-room-0__` means "the first room this mutation
 * created" on either side. Aliasing is a substring replacement rather than a
 * whole-string one, because a minted id also appears inside derived strings
 * such as `rooms/<roomId>/notes.txt`, and those have to line up too.
 */
export function normalizeSnapshotForParity(
  snapshot: SubjectSnapshot,
  baseRoomIds: Iterable<string>,
): SubjectSnapshot {
  const base = new Set(baseRoomIds);
  const aliases = new Map<string, string>();
  let next = 0;
  for (const room of snapshot.dungeon.rooms) {
    if (!base.has(room.roomId) && !aliases.has(room.roomId)) {
      aliases.set(room.roomId, `__new-room-${next}__`);
      next += 1;
    }
  }

  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = ISO_TIMESTAMP.test(value) ? TIMESTAMP_PLACEHOLDER : value;
      for (const [id, alias] of aliases) {
        out = out.split(id).join(alias);
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
          const alias = aliases.get(key);
          return [alias ?? key, rewrite(entry)];
        }),
      );
    }
    return value;
  };

  return rewrite(snapshot) as SubjectSnapshot;
}

/** Deep clone through `structuredClone`, so fixtures cannot alias across lanes. */
export function cloneSnapshot(snapshot: SubjectSnapshot): SubjectSnapshot {
  return structuredClone(snapshot);
}