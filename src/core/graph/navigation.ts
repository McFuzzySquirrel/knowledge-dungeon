import type { DungeonMetadata, DungeonRoomSummary } from '@/core/validation/persistence';

export interface GraphHierarchy {
  parentByRoomId: Record<string, string | null>;
  childRoomIdsByParentId: Record<string, string[]>;
  breadcrumbRoomIdsByRoomId: Record<string, string[]>;
  floorIdByRoomId: Record<string, string>;
  roomIdsByFloorId: Record<string, string[]>;
  floorIds: string[];
  floorLabelByFloorId: Record<string, string>;
}

function sortRoomIdsByTopic(
  roomIds: readonly string[],
  roomById: Map<string, DungeonRoomSummary>,
): string[] {
  return [...roomIds].sort((left, right) => {
    const leftRoom = roomById.get(left);
    const rightRoom = roomById.get(right);
    const topicCompare = (leftRoom?.topic ?? left).localeCompare(rightRoom?.topic ?? right);
    if (topicCompare !== 0) return topicCompare;
    return left.localeCompare(right);
  });
}

export function buildSubtopicChildrenMap(dungeon: DungeonMetadata): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const room of dungeon.rooms) {
    children.set(room.roomId, []);
  }
  for (const edge of dungeon.edges) {
    if (edge.relationType !== 'subtopic') continue;
    children.get(edge.fromRoomId)?.push(edge.toRoomId);
  }
  return children;
}

export function deriveGraphHierarchy(dungeon: DungeonMetadata): GraphHierarchy {
  const roomById = new Map(dungeon.rooms.map((room) => [room.roomId, room] as const));
  const parentByRoomId = Object.fromEntries(
    dungeon.rooms.map((room) => [room.roomId, null as string | null]),
  );

  for (const edge of [...dungeon.edges].sort((left, right) => {
    const createdCompare = left.createdAt.localeCompare(right.createdAt);
    if (createdCompare !== 0) return createdCompare;
    const fromCompare = left.fromRoomId.localeCompare(right.fromRoomId);
    if (fromCompare !== 0) return fromCompare;
    return left.toRoomId.localeCompare(right.toRoomId);
  })) {
    if (edge.relationType !== 'subtopic') continue;
    if (parentByRoomId[edge.toRoomId] === null) {
      parentByRoomId[edge.toRoomId] = edge.fromRoomId;
    }
  }

  const childRoomIdsByParentId = Object.fromEntries(
    dungeon.rooms.map((room) => [room.roomId, [] as string[]]),
  );
  for (const room of dungeon.rooms) {
    const parentRoomId = parentByRoomId[room.roomId];
    if (parentRoomId) {
      childRoomIdsByParentId[parentRoomId]?.push(room.roomId);
    }
  }
  for (const roomId of Object.keys(childRoomIdsByParentId)) {
    childRoomIdsByParentId[roomId] = sortRoomIdsByTopic(childRoomIdsByParentId[roomId], roomById);
  }

  const breadcrumbRoomIdsByRoomId = Object.fromEntries(
    dungeon.rooms.map((room) => [room.roomId, [] as string[]]),
  );
  for (const room of dungeon.rooms) {
    const breadcrumb: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = room.roomId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      breadcrumb.unshift(cursor);
      cursor = parentByRoomId[cursor];
    }
    breadcrumbRoomIdsByRoomId[room.roomId] = breadcrumb;
  }

  const floorIdByRoomId = Object.fromEntries(
    dungeon.rooms.map((room) => [room.roomId, room.roomId]),
  );
  for (const room of dungeon.rooms) {
    const breadcrumb = breadcrumbRoomIdsByRoomId[room.roomId];
    floorIdByRoomId[room.roomId] =
      room.roomId === dungeon.rootRoomId ? dungeon.rootRoomId : breadcrumb[1] ?? room.roomId;
  }

  const roomIdsByFloorId: Record<string, string[]> = {};
  for (const room of dungeon.rooms) {
    const floorId = floorIdByRoomId[room.roomId];
    roomIdsByFloorId[floorId] ??= [];
    roomIdsByFloorId[floorId].push(room.roomId);
  }
  for (const floorId of Object.keys(roomIdsByFloorId)) {
    roomIdsByFloorId[floorId] = sortRoomIdsByTopic(roomIdsByFloorId[floorId], roomById);
  }

  const floorIds = Object.keys(roomIdsByFloorId).sort((left, right) => {
    if (left === dungeon.rootRoomId) return -1;
    if (right === dungeon.rootRoomId) return 1;
    return (roomById.get(left)?.topic ?? left).localeCompare(roomById.get(right)?.topic ?? right);
  });
  const floorLabelByFloorId = Object.fromEntries(
    floorIds.map((floorId) => [floorId, roomById.get(floorId)?.topic ?? floorId]),
  );

  return {
    parentByRoomId,
    childRoomIdsByParentId,
    breadcrumbRoomIdsByRoomId,
    floorIdByRoomId,
    roomIdsByFloorId,
    floorIds,
    floorLabelByFloorId,
  };
}

export function getConnectedRoomIds(dungeon: DungeonMetadata, roomId: string): string[] {
  const connected = new Set<string>();
  for (const edge of dungeon.edges) {
    if (edge.fromRoomId === roomId) connected.add(edge.toRoomId);
    if (edge.toRoomId === roomId) connected.add(edge.fromRoomId);
  }
  return [...connected].sort((left, right) => left.localeCompare(right));
}

export function isReachableViaSubtopics(
  dungeon: DungeonMetadata,
  fromRoomId: string,
  targetRoomId: string,
): boolean {
  if (fromRoomId === targetRoomId) return true;
  const children = buildSubtopicChildrenMap(dungeon);
  const queue = [...(children.get(fromRoomId) ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current === targetRoomId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(children.get(current) ?? []));
  }
  return false;
}
