import type {
  DungeonEdge,
  DungeonMetadata,
  DungeonRoomSummary,
  EdgeCreatedByPhase,
  RoomState,
} from '@/core/validation/persistence';
import { ROOM_STATES, type EdgeRelationType } from '@/core/validation/persistence';

import {
  type AddCrossLinkInput,
  type AddCrossLinkOutput,
  type AddLinkedRoomsInput,
  type AddLinkedRoomsOutput,
  type CreatorTraversalSnapshot,
  type GraphDomainError,
  type GraphDomainResult,
  type ReparentRoomInput,
  type ReparentRoomOutput,
  type RemoveRoomInput,
  type RemoveRoomOutput,
  type RevalidationPropagationInput,
  type RevalidationPropagationOutput,
  type RootDungeonInitInput,
  SCRIBE_STARTED_PHASES,
} from './types';
import { isReachableViaSubtopics } from './navigation';

const DEFAULT_EDGE_RELATION: EdgeRelationType = 'subtopic';
const DEFAULT_CREATED_BY_PHASE: EdgeCreatedByPhase = 'Creator';

const CLEARED_OR_NOTES_PROGRESS_STATES = new Set<RoomState>([
  'NotesDrafted',
  'EncounterDefeated',
  'ArtifactCollected',
  'NeedsRevalidation',
]);

function cloneDungeon(dungeon: DungeonMetadata): DungeonMetadata {
  return {
    ...dungeon,
    rooms: dungeon.rooms.map((room) => ({ ...room })),
    edges: dungeon.edges.map((edge) => ({ ...edge })),
    progression: {
      ...dungeon.progression,
      badges: [...dungeon.progression.badges],
    },
  };
}

function graphError(
  code: GraphDomainError['code'],
  message: string,
  details?: Record<string, unknown>,
): GraphDomainResult<never> {
  const error: GraphDomainError = { code, message };
  if (details) {
    error.details = details;
  }
  return { ok: false, error };
}

export function normalizeTopicKey(topic: string): string {
  return topic.trim().toLocaleLowerCase();
}

function ensureNonEmptyTopic(topic: string): GraphDomainResult<string> {
  const normalized = topic.trim();
  if (normalized.length === 0) {
    return graphError('EMPTY_TOPIC', 'Topic must be non-empty.', { topic });
  }
  return { ok: true, value: normalized };
}

function hasRoom(dungeon: DungeonMetadata, roomId: string): boolean {
  return dungeon.rooms.some((room) => room.roomId === roomId);
}

function hasEdge(dungeon: DungeonMetadata, fromRoomId: string, toRoomId: string): boolean {
  return dungeon.edges.some(
    (edge) => edge.fromRoomId === fromRoomId && edge.toRoomId === toRoomId,
  );
}

function upsertRoomStatus(
  rooms: DungeonRoomSummary[],
  roomId: string,
  nextStatus: RoomState,
): DungeonRoomSummary[] {
  return rooms.map((room) =>
    room.roomId === roomId ? { ...room, status: nextStatus } : room,
  );
}

function sortedRoomIdsByTopic(rooms: readonly DungeonRoomSummary[]): string[] {
  return [...rooms]
    .sort((left, right) => {
      const topicCompare = left.topic.localeCompare(right.topic);
      if (topicCompare !== 0) return topicCompare;
      return left.roomId.localeCompare(right.roomId);
    })
    .map((room) => room.roomId);
}

export function createRootDungeon(
  input: RootDungeonInitInput,
): GraphDomainResult<DungeonMetadata> {
  const topicResult = ensureNonEmptyTopic(input.rootTopic);
  if (!topicResult.ok) return topicResult;

  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: input.dungeonId,
    subjectName: input.subjectName.trim(),
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    phaseState: 'CreatorActive',
    rootRoomId: input.rootRoomId,
    rooms: [{ roomId: input.rootRoomId, topic: topicResult.value, status: 'Created' }],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    biome: input.biome,
    tagIndex: {},
  };

  return { ok: true, value: dungeon };
}

export function addLinkedRooms(
  dungeon: DungeonMetadata,
  input: AddLinkedRoomsInput,
): GraphDomainResult<AddLinkedRoomsOutput> {
  if (!hasRoom(dungeon, input.fromRoomId)) {
    return graphError('ROOM_NOT_FOUND', 'Source room does not exist.', {
      fromRoomId: input.fromRoomId,
    });
  }

  const draftRoomIdSet = new Set<string>();
  const topicIdentitySet = new Set(dungeon.rooms.map((room) => normalizeTopicKey(room.topic)));

  for (const draft of input.drafts) {
    if (draft.roomId === input.fromRoomId) {
      return graphError('SELF_LOOP_EDGE', 'Linked rooms cannot self-loop to source room.', {
        roomId: draft.roomId,
      });
    }

    if (hasRoom(dungeon, draft.roomId) || draftRoomIdSet.has(draft.roomId)) {
      return graphError('ROOM_ALREADY_EXISTS', 'Room id already exists in subject graph.', {
        roomId: draft.roomId,
      });
    }

    const topicResult = ensureNonEmptyTopic(draft.topic);
    if (!topicResult.ok) return topicResult;

    const topicKey = normalizeTopicKey(topicResult.value);
    if (topicIdentitySet.has(topicKey)) {
      return graphError(
        'TOPIC_ALREADY_EXISTS',
        'Topic already exists in subject graph (case-insensitive, trimmed).',
        { topic: draft.topic },
      );
    }

    if (hasEdge(dungeon, input.fromRoomId, draft.roomId)) {
      return graphError('EDGE_ALREADY_EXISTS', 'Edge already exists.', {
        fromRoomId: input.fromRoomId,
        toRoomId: draft.roomId,
      });
    }

    topicIdentitySet.add(topicKey);
    draftRoomIdSet.add(draft.roomId);
  }

  const next = cloneDungeon(dungeon);

  for (const draft of input.drafts) {
    const topic = draft.topic.trim();
    next.rooms.push({ roomId: draft.roomId, topic, status: 'Created' });
    next.edges.push({
      fromRoomId: input.fromRoomId,
      toRoomId: draft.roomId,
      relationType: draft.relationType ?? DEFAULT_EDGE_RELATION,
      createdAt: input.nowIso,
      createdByPhase: input.createdByPhase ?? DEFAULT_CREATED_BY_PHASE,
    });
  }

  next.updatedAt = input.nowIso;

  const createdRoomIds = input.drafts.map((draft) => draft.roomId);
  return {
    ok: true,
    value: {
      dungeon: next,
      createdRoomIds,
      touchedRoomIds: [input.fromRoomId, ...createdRoomIds],
    },
  };
}

export function addCrossLink(
  dungeon: DungeonMetadata,
  input: AddCrossLinkInput,
): GraphDomainResult<AddCrossLinkOutput> {
  if (!hasRoom(dungeon, input.fromRoomId) || !hasRoom(dungeon, input.toRoomId)) {
    return graphError('ROOM_NOT_FOUND', 'Cross-link endpoints must exist.', {
      fromRoomId: input.fromRoomId,
      toRoomId: input.toRoomId,
    });
  }

  if (input.fromRoomId === input.toRoomId) {
    return graphError('SELF_LOOP_EDGE', 'Cross-link cannot self-loop.', {
      roomId: input.fromRoomId,
    });
  }

  if (hasEdge(dungeon, input.fromRoomId, input.toRoomId)) {
    return graphError('EDGE_ALREADY_EXISTS', 'Cross-link already exists.', {
      fromRoomId: input.fromRoomId,
      toRoomId: input.toRoomId,
    });
  }

  const next = cloneDungeon(dungeon);
  const edge: DungeonEdge = {
    fromRoomId: input.fromRoomId,
    toRoomId: input.toRoomId,
    relationType: input.relationType ?? 'related',
    createdAt: input.nowIso,
    createdByPhase: input.createdByPhase ?? DEFAULT_CREATED_BY_PHASE,
  };

  next.edges.push(edge);
  next.updatedAt = input.nowIso;

  return {
    ok: true,
    value: { dungeon: next, touchedRoomIds: [input.fromRoomId, input.toRoomId] },
  };
}

export function reparentRoom(
  dungeon: DungeonMetadata,
  input: ReparentRoomInput,
): GraphDomainResult<ReparentRoomOutput> {
  if (!hasRoom(dungeon, input.roomId) || !hasRoom(dungeon, input.newParentRoomId)) {
    return graphError('ROOM_NOT_FOUND', 'Reparent endpoints must exist.', {
      roomId: input.roomId,
      newParentRoomId: input.newParentRoomId,
    });
  }

  if (input.roomId === dungeon.rootRoomId) {
    return graphError('INVALID_OPERATION', 'Cannot change the parent of the root room.', {
      roomId: input.roomId,
    });
  }

  if (input.roomId === input.newParentRoomId) {
    return graphError('SELF_LOOP_EDGE', 'A room cannot become its own parent.', {
      roomId: input.roomId,
    });
  }

  if (isReachableViaSubtopics(dungeon, input.roomId, input.newParentRoomId)) {
    return graphError('INVALID_OPERATION', 'Cannot move a room under one of its descendants.', {
      roomId: input.roomId,
      newParentRoomId: input.newParentRoomId,
    });
  }

  const incomingSubtopicEdges = dungeon.edges.filter(
    (edge) => edge.toRoomId === input.roomId && edge.relationType === 'subtopic',
  );
  const previousParentRoomId = incomingSubtopicEdges[0]?.fromRoomId ?? null;
  if (previousParentRoomId === input.newParentRoomId) {
    return {
      ok: true,
      value: {
        dungeon,
        previousParentRoomId,
        touchedRoomIds: [input.roomId, input.newParentRoomId],
      },
    };
  }

  const next = cloneDungeon(dungeon);
  next.edges = next.edges.filter(
    (edge) => !(edge.toRoomId === input.roomId && edge.relationType === 'subtopic'),
  );
  next.edges.push({
    fromRoomId: input.newParentRoomId,
    toRoomId: input.roomId,
    relationType: 'subtopic',
    createdAt: input.nowIso,
    createdByPhase: input.createdByPhase ?? DEFAULT_CREATED_BY_PHASE,
  });
  next.updatedAt = input.nowIso;

  const touchedRoomIds = [
    input.roomId,
    input.newParentRoomId,
    ...incomingSubtopicEdges.map((edge) => edge.fromRoomId),
  ].sort((left, right) => left.localeCompare(right));

  return {
    ok: true,
    value: {
      dungeon: next,
      previousParentRoomId,
      touchedRoomIds: [...new Set(touchedRoomIds)],
    },
  };
}

export function markRoomVisited(
  dungeon: DungeonMetadata,
  roomId: string,
): GraphDomainResult<DungeonMetadata> {
  const room = dungeon.rooms.find((entry) => entry.roomId === roomId);
  if (!room) {
    return graphError('ROOM_NOT_FOUND', 'Room not found for visited mark.', { roomId });
  }

  if (room.status !== 'Created' && room.status !== 'Uncreated') {
    return { ok: true, value: dungeon };
  }

  const next = cloneDungeon(dungeon);
  next.rooms = upsertRoomStatus(next.rooms, roomId, 'Visited');
  return { ok: true, value: next };
}

export function setRoomStatus(
  dungeon: DungeonMetadata,
  roomId: string,
  status: RoomState,
): GraphDomainResult<DungeonMetadata> {
  if (!hasRoom(dungeon, roomId)) {
    return graphError('ROOM_NOT_FOUND', 'Room not found.', { roomId });
  }
  const next = cloneDungeon(dungeon);
  next.rooms = upsertRoomStatus(next.rooms, roomId, status);
  return { ok: true, value: next };
}

/**
 * Remove a room (and any descendants that become unreachable from the root
 * as a result). The root room itself cannot be removed. Returns the updated
 * dungeon, the list of removed room ids, and the neighboring rooms whose
 * outgoing/incoming edges were touched (useful for revalidation
 * propagation in the Scribe+ phases).
 */
export function removeRoom(
  dungeon: DungeonMetadata,
  input: RemoveRoomInput,
): GraphDomainResult<RemoveRoomOutput> {
  if (!hasRoom(dungeon, input.roomId)) {
    return graphError('ROOM_NOT_FOUND', 'Room not found for removal.', {
      roomId: input.roomId,
    });
  }
  if (input.roomId === dungeon.rootRoomId) {
    return graphError('INVALID_OPERATION', 'Cannot remove the root room.', {
      roomId: input.roomId,
    });
  }

  // Build adjacency, then determine which rooms remain reachable from the
  // root once we drop `input.roomId`. Anything not reachable is cascade-
  // removed so we don't leave orphan subtrees behind.
  const adj = new Map<string, Set<string>>();
  for (const room of dungeon.rooms) {
    adj.set(room.roomId, new Set());
  }
  for (const edge of dungeon.edges) {
    if (edge.fromRoomId === input.roomId || edge.toRoomId === input.roomId) continue;
    adj.get(edge.fromRoomId)?.add(edge.toRoomId);
    adj.get(edge.toRoomId)?.add(edge.fromRoomId);
  }

  const reachable = new Set<string>();
  const queue: string[] = [dungeon.rootRoomId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    if (current === input.roomId) continue;
    reachable.add(current);
    const neighbors = adj.get(current);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (!reachable.has(neighbor)) queue.push(neighbor);
    }
  }

  const removedRoomIds = dungeon.rooms
    .map((room) => room.roomId)
    .filter((id) => !reachable.has(id));

  // Track which surviving rooms had edges to anything we removed; the caller
  // can re-validate those if needed.
  const removedSet = new Set(removedRoomIds);
  const touchedRoomIds = new Set<string>();
  for (const edge of dungeon.edges) {
    if (removedSet.has(edge.fromRoomId) && !removedSet.has(edge.toRoomId)) {
      touchedRoomIds.add(edge.toRoomId);
    } else if (removedSet.has(edge.toRoomId) && !removedSet.has(edge.fromRoomId)) {
      touchedRoomIds.add(edge.fromRoomId);
    }
  }

  const next = cloneDungeon(dungeon);
  next.rooms = next.rooms.filter((room) => !removedSet.has(room.roomId));
  next.edges = next.edges.filter(
    (edge) => !removedSet.has(edge.fromRoomId) && !removedSet.has(edge.toRoomId),
  );
  next.updatedAt = input.nowIso;

  return {
    ok: true,
    value: {
      dungeon: next,
      removedRoomIds: [...removedRoomIds].sort((a, b) => a.localeCompare(b)),
      touchedRoomIds: [...touchedRoomIds].sort((a, b) => a.localeCompare(b)),
    },
  };
}

export function deriveTraversalSnapshot(dungeon: DungeonMetadata): CreatorTraversalSnapshot {
  const roomIdsByStatus = {
    Uncreated: [] as string[],
    Created: [] as string[],
    Visited: [] as string[],
    NotesDrafted: [] as string[],
    EncounterDefeated: [] as string[],
    ArtifactCollected: [] as string[],
    NeedsRevalidation: [] as string[],
  };

  for (const room of dungeon.rooms) {
    roomIdsByStatus[room.status].push(room.roomId);
  }

  for (const status of ROOM_STATES) {
    roomIdsByStatus[status].sort((left, right) => left.localeCompare(right));
  }

  const visitedStatusSet = new Set<RoomState>([
    'Visited',
    'NotesDrafted',
    'EncounterDefeated',
    'ArtifactCollected',
    'NeedsRevalidation',
  ]);

  const visitedRoomIds = sortedRoomIdsByTopic(
    dungeon.rooms.filter((room) => visitedStatusSet.has(room.status)),
  );

  const unvisitedRoomIds = sortedRoomIdsByTopic(
    dungeon.rooms.filter((room) => room.status === 'Created' || room.status === 'Uncreated'),
  );

  const outgoingEdgeCount = new Map<string, number>();
  for (const room of dungeon.rooms) {
    outgoingEdgeCount.set(room.roomId, 0);
  }

  for (const edge of dungeon.edges) {
    outgoingEdgeCount.set(edge.fromRoomId, (outgoingEdgeCount.get(edge.fromRoomId) ?? 0) + 1);
  }

  const unresolvedRoomIds = sortedRoomIdsByTopic(
    dungeon.rooms.filter(
      (room) =>
        (room.status === 'Created' || room.status === 'Visited') &&
        (outgoingEdgeCount.get(room.roomId) ?? 0) === 0,
    ),
  );

  const revalidationNeededRoomIds = sortedRoomIdsByTopic(
    dungeon.rooms.filter((room) => room.status === 'NeedsRevalidation'),
  );

  return {
    roomIdsByStatus,
    visitedRoomIds,
    unvisitedRoomIds,
    unresolvedRoomIds,
    revalidationNeededRoomIds,
  };
}

export function hasScribeStarted(phaseState: DungeonMetadata['phaseState']): boolean {
  return SCRIBE_STARTED_PHASES.includes(phaseState);
}

export function propagateRevalidationAfterGraphMutation(
  input: RevalidationPropagationInput,
): GraphDomainResult<RevalidationPropagationOutput> {
  if (!hasScribeStarted(input.dungeon.phaseState)) {
    return {
      ok: true,
      value: {
        dungeon: input.dungeon,
        impactedRoomIds: [],
        revalidatedRoomIds: [],
      },
    };
  }

  const roomIds = new Set(input.dungeon.rooms.map((room) => room.roomId));
  for (const touchedRoomId of input.touchedRoomIds) {
    if (!roomIds.has(touchedRoomId)) {
      return graphError('ROOM_NOT_FOUND', 'Touched room is not present in graph.', {
        touchedRoomId,
      });
    }
  }

  const impactedRoomIds = new Set<string>(input.touchedRoomIds);
  for (const edge of input.dungeon.edges) {
    if (impactedRoomIds.has(edge.fromRoomId) || impactedRoomIds.has(edge.toRoomId)) {
      impactedRoomIds.add(edge.fromRoomId);
      impactedRoomIds.add(edge.toRoomId);
    }
  }

  const next = cloneDungeon(input.dungeon);
  const revalidatedRoomIds: string[] = [];

  next.rooms = next.rooms.map((room) => {
    if (!impactedRoomIds.has(room.roomId)) return room;
    if (!CLEARED_OR_NOTES_PROGRESS_STATES.has(room.status)) return room;
    revalidatedRoomIds.push(room.roomId);
    return { ...room, status: 'NeedsRevalidation' };
  });

  next.updatedAt = input.nowIso;

  return {
    ok: true,
    value: {
      dungeon: next,
      impactedRoomIds: [...impactedRoomIds].sort((left, right) => left.localeCompare(right)),
      revalidatedRoomIds: [...new Set(revalidatedRoomIds)].sort((left, right) =>
        left.localeCompare(right),
      ),
    },
  };
}
