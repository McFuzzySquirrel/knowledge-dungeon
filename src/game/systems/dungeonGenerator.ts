/**
 * dungeonGenerator
 * Transforms a Subject's topic graph (DungeonMetadata) into a tile-based
 * dungeon layout: a grid of rooms placed via BFS from the root, connected by
 * straight corridors that mirror the parent/child + cross-link edges from the
 * mindmap. The Phaser scene then renders the resulting DungeonMap.
 */
import type { DungeonEdge, DungeonMetadata } from '@/core/validation/persistence';

export interface DungeonRoom {
  roomId: string;
  topic: string;
  status: string;
  gridX: number;
  gridY: number;
  width: number;
  height: number;
  isRoot: boolean;
}

export interface DungeonCorridor {
  fromRoomId: string;
  toRoomId: string;
  relationType: DungeonEdge['relationType'];
}

export interface DungeonMap {
  seed: string;
  rooms: DungeonRoom[];
  corridors: DungeonCorridor[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  tileSize: number;
  rootRoomId: string;
}

interface PRNG {
  next(): number;
  pick<T>(items: readonly T[]): T;
}

function createPrng(seed: string): PRNG {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return {
    next() {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    },
    pick(items) {
      if (items.length === 0) {
        throw new Error('Cannot pick from an empty list');
      }
      return items[Math.floor(this.next() * items.length)];
    },
  };
}

const DIRECTIONS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
];

const ROOM_WIDTH = 6;
const ROOM_HEIGHT = 5;
const ROOM_SPACING = 4;
const TILE_SIZE = 24;

/**
 * Build the adjacency list (undirected) for the dungeon edges so layout
 * matches the mindmap structure regardless of edge direction.
 */
function buildAdjacency(dungeon: DungeonMetadata): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const room of dungeon.rooms) {
    adj.set(room.roomId, []);
  }
  for (const edge of dungeon.edges) {
    adj.get(edge.fromRoomId)?.push(edge.toRoomId);
    adj.get(edge.toRoomId)?.push(edge.fromRoomId);
  }
  return adj;
}

export function generateDungeonMap(
  dungeon: DungeonMetadata,
  seed: string = dungeon.dungeonId,
): DungeonMap {
  const prng = createPrng(seed);
  const adj = buildAdjacency(dungeon);
  const occupied = new Map<string, string>(); // grid key → roomId
  const positions = new Map<string, { x: number; y: number }>();

  const rootId = dungeon.rootRoomId;
  positions.set(rootId, { x: 0, y: 0 });
  occupied.set('0,0', rootId);

  const queue: string[] = [rootId];
  const visited = new Set<string>([rootId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentPos = positions.get(current);
    if (!currentPos) continue;

    const neighbors = adj.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);

      const direction = findFreeDirection(currentPos, occupied, prng);
      const next = {
        x: currentPos.x + direction.dx,
        y: currentPos.y + direction.dy,
      };
      positions.set(neighbor, next);
      occupied.set(`${next.x},${next.y}`, neighbor);
      queue.push(neighbor);
    }
  }

  // Disconnected rooms (no edges) — sprinkle into free cells.
  for (const summary of dungeon.rooms) {
    if (positions.has(summary.roomId)) continue;
    let radius = 1;
    while (radius < 64) {
      let placed = false;
      for (let dx = -radius; dx <= radius && !placed; dx += 1) {
        for (let dy = -radius; dy <= radius && !placed; dy += 1) {
          const key = `${dx},${dy}`;
          if (!occupied.has(key)) {
            occupied.set(key, summary.roomId);
            positions.set(summary.roomId, { x: dx, y: dy });
            placed = true;
          }
        }
      }
      if (placed) break;
      radius += 1;
    }
  }

  const rooms: DungeonRoom[] = dungeon.rooms.map((summary) => {
    const pos = positions.get(summary.roomId) ?? { x: 0, y: 0 };
    return {
      roomId: summary.roomId,
      topic: summary.topic,
      status: summary.status,
      gridX: pos.x * (ROOM_WIDTH + ROOM_SPACING),
      gridY: pos.y * (ROOM_HEIGHT + ROOM_SPACING),
      width: ROOM_WIDTH,
      height: ROOM_HEIGHT,
      isRoot: summary.roomId === rootId,
    };
  });

  const corridors: DungeonCorridor[] = dungeon.edges.map((edge) => ({
    fromRoomId: edge.fromRoomId,
    toRoomId: edge.toRoomId,
    relationType: edge.relationType,
  }));

  const xs = rooms.map((r) => r.gridX);
  const ys = rooms.map((r) => r.gridY);
  const bounds = {
    minX: (xs.length ? Math.min(...xs) : 0) - 2,
    maxX: (xs.length ? Math.max(...xs) : 0) + ROOM_WIDTH + 2,
    minY: (ys.length ? Math.min(...ys) : 0) - 2,
    maxY: (ys.length ? Math.max(...ys) : 0) + ROOM_HEIGHT + 2,
  };

  return {
    seed,
    rooms,
    corridors,
    bounds,
    tileSize: TILE_SIZE,
    rootRoomId: rootId,
  };
}

function findFreeDirection(
  from: { x: number; y: number },
  occupied: Map<string, string>,
  prng: PRNG,
): { dx: number; dy: number } {
  const shuffled = [...DIRECTIONS];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(prng.next() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }

  for (const direction of shuffled) {
    const candidate = `${from.x + direction.dx},${from.y + direction.dy}`;
    if (!occupied.has(candidate)) {
      return direction;
    }
  }

  // Everything occupied; fall back to a default direction with offset radius.
  for (let radius = 2; radius < 32; radius += 1) {
    for (const direction of shuffled) {
      const candidate = `${from.x + direction.dx * radius},${from.y + direction.dy * radius}`;
      if (!occupied.has(candidate)) {
        return { dx: direction.dx * radius, dy: direction.dy * radius };
      }
    }
  }

  return shuffled[0];
}
