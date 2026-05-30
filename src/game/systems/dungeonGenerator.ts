/**
 * dungeonGenerator
 * Transforms a Subject's topic graph (DungeonMetadata) into a tile-based
 * dungeon layout: a grid of rooms placed via BFS from the root, connected by
 * axis-aligned (straight or L-shaped) corridors that mirror the parent/child
 * + cross-link edges from the mindmap. The Phaser scene then renders the
 * resulting DungeonMap.
 *
 * Each corridor records the doorway tile and side on both endpoints, plus
 * the ordered list of corridor tiles and the axis-aligned segments between
 * them, so the renderer can draw straight + corner pathway sprites and the
 * scene can use a single walkability grid for player movement.
 */
import type { DungeonEdge, DungeonMetadata } from '@/core/validation/persistence';

export type DoorSide = 'N' | 'S' | 'E' | 'W';

export interface DungeonDoor {
  roomId: string;
  side: DoorSide;
  /** Tile coordinates of the doorway, on the room's perimeter (room-local). */
  x: number;
  y: number;
}

export interface DungeonCorridorSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  orientation: 'h' | 'v';
}

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
  fromDoor: DungeonDoor;
  toDoor: DungeonDoor;
  /**
   * Ordered list of tile coordinates between the two doorways (exclusive of
   * the door tiles themselves, which live on the room's perimeter and are
   * already part of the room footprint). Empty when the rooms are directly
   * adjacent (touching walls).
   */
  pathTiles: Array<{ x: number; y: number }>;
  /** Axis-aligned line segments (in tile coordinates) describing the path. */
  segments: DungeonCorridorSegment[];
  /** Elbow tile coordinate when the corridor bends, otherwise null. */
  elbow: { x: number; y: number } | null;
}

export interface DungeonWalkable {
  /** Width / height in tiles. */
  width: number;
  height: number;
  /**
   * Tile-coordinate offset so a world tile (tx, ty) maps to grid index
   * (tx - offsetX, ty - offsetY).
   */
  offsetX: number;
  offsetY: number;
  /** 1 = walkable, 0 = blocked. */
  data: Uint8Array;
}

export interface DungeonMap {
  seed: string;
  rooms: DungeonRoom[];
  corridors: DungeonCorridor[];
  doors: DungeonDoor[];
  walkable: DungeonWalkable;
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

/**
 * Orthogonal directions only — diagonals were removed when corridors became
 * axis-aligned. Every BFS-placed neighbour is therefore exactly one macro
 * cell away in N/S/E/W, so each tree edge becomes a single straight corridor.
 */
const DIRECTIONS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
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
  const occupied = new Map<string, string>(); // macro grid key → roomId
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

  const roomById = new Map(rooms.map((room) => [room.roomId, room] as const));

  const corridors: DungeonCorridor[] = [];
  const doors: DungeonDoor[] = [];
  for (const edge of dungeon.edges) {
    const from = roomById.get(edge.fromRoomId);
    const to = roomById.get(edge.toRoomId);
    if (!from || !to) continue;
    const carved = carveCorridor(from, to, prng);
    corridors.push({
      fromRoomId: edge.fromRoomId,
      toRoomId: edge.toRoomId,
      relationType: edge.relationType,
      ...carved,
    });
    doors.push(carved.fromDoor, carved.toDoor);
  }

  const xs = rooms.map((r) => r.gridX);
  const ys = rooms.map((r) => r.gridY);
  // Pad bounds enough that corridor tiles (1-tile-wide between rooms) plus
  // a 2-tile visual margin are always inside the world bounds.
  const minRoomX = xs.length ? Math.min(...xs) : 0;
  const maxRoomX = xs.length ? Math.max(...xs) : 0;
  const minRoomY = ys.length ? Math.min(...ys) : 0;
  const maxRoomY = ys.length ? Math.max(...ys) : 0;
  const bounds = {
    minX: minRoomX - 2,
    maxX: maxRoomX + ROOM_WIDTH + 2,
    minY: minRoomY - 2,
    maxY: maxRoomY + ROOM_HEIGHT + 2,
  };

  const walkable = buildWalkable(rooms, corridors, bounds);

  return {
    seed,
    rooms,
    corridors,
    doors,
    walkable,
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

  // Everything occupied; fall back to an axis-aligned default with offset radius.
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

/**
 * Carve an axis-aligned corridor between two rooms. The corridor is straight
 * when the rooms share a row or column, otherwise it makes a single L-bend.
 * Doors are placed on the perimeter walls facing the other room.
 */
function carveCorridor(
  from: DungeonRoom,
  to: DungeonRoom,
  prng: PRNG,
): {
  fromDoor: DungeonDoor;
  toDoor: DungeonDoor;
  pathTiles: Array<{ x: number; y: number }>;
  segments: DungeonCorridorSegment[];
  elbow: { x: number; y: number } | null;
} {
  const fromCenter = roomCenterTile(from);
  const toCenter = roomCenterTile(to);
  const dxCenter = toCenter.x - fromCenter.x;
  const dyCenter = toCenter.y - fromCenter.y;
  const absDx = Math.abs(dxCenter);
  const absDy = Math.abs(dyCenter);

  let fromSide: DoorSide;
  let toSide: DoorSide;
  if (absDx >= absDy) {
    fromSide = dxCenter >= 0 ? 'E' : 'W';
    toSide = dxCenter >= 0 ? 'W' : 'E';
  } else {
    fromSide = dyCenter >= 0 ? 'S' : 'N';
    toSide = dyCenter >= 0 ? 'N' : 'S';
  }

  const fromDoor = doorOnSide(from, fromSide);
  const toDoor = doorOnSide(to, toSide);

  // Walk from the cell just outside each door toward the other.
  const fromOut = stepOut(fromDoor.x, fromDoor.y, fromSide);
  const toOut = stepOut(toDoor.x, toDoor.y, toSide);

  const horizontalFirst =
    fromSide === 'E' || fromSide === 'W'
      ? true
      : fromSide === 'N' || fromSide === 'S'
        ? false
        : prng.next() < 0.5;

  const pathTiles: Array<{ x: number; y: number }> = [];
  const segments: DungeonCorridorSegment[] = [];
  let elbow: { x: number; y: number } | null = null;

  if (fromOut.x === toOut.x && fromOut.y === toOut.y) {
    pathTiles.push({ x: fromOut.x, y: fromOut.y });
    segments.push({
      x1: fromOut.x,
      y1: fromOut.y,
      x2: fromOut.x,
      y2: fromOut.y,
      orientation: 'h',
    });
  } else if (fromOut.x === toOut.x) {
    appendVerticalRun(pathTiles, fromOut.x, fromOut.y, toOut.y);
    segments.push({
      x1: fromOut.x,
      y1: Math.min(fromOut.y, toOut.y),
      x2: fromOut.x,
      y2: Math.max(fromOut.y, toOut.y),
      orientation: 'v',
    });
  } else if (fromOut.y === toOut.y) {
    appendHorizontalRun(pathTiles, fromOut.y, fromOut.x, toOut.x);
    segments.push({
      x1: Math.min(fromOut.x, toOut.x),
      y1: fromOut.y,
      x2: Math.max(fromOut.x, toOut.x),
      y2: fromOut.y,
      orientation: 'h',
    });
  } else if (horizontalFirst) {
    // horizontal run at y=fromOut.y, then vertical run at x=toOut.x
    appendHorizontalRun(pathTiles, fromOut.y, fromOut.x, toOut.x);
    appendVerticalRun(pathTiles, toOut.x, fromOut.y, toOut.y);
    elbow = { x: toOut.x, y: fromOut.y };
    segments.push({
      x1: Math.min(fromOut.x, toOut.x),
      y1: fromOut.y,
      x2: Math.max(fromOut.x, toOut.x),
      y2: fromOut.y,
      orientation: 'h',
    });
    segments.push({
      x1: toOut.x,
      y1: Math.min(fromOut.y, toOut.y),
      x2: toOut.x,
      y2: Math.max(fromOut.y, toOut.y),
      orientation: 'v',
    });
  } else {
    // vertical run at x=fromOut.x, then horizontal run at y=toOut.y
    appendVerticalRun(pathTiles, fromOut.x, fromOut.y, toOut.y);
    appendHorizontalRun(pathTiles, toOut.y, fromOut.x, toOut.x);
    elbow = { x: fromOut.x, y: toOut.y };
    segments.push({
      x1: fromOut.x,
      y1: Math.min(fromOut.y, toOut.y),
      x2: fromOut.x,
      y2: Math.max(fromOut.y, toOut.y),
      orientation: 'v',
    });
    segments.push({
      x1: Math.min(fromOut.x, toOut.x),
      y1: toOut.y,
      x2: Math.max(fromOut.x, toOut.x),
      y2: toOut.y,
      orientation: 'h',
    });
  }

  return { fromDoor, toDoor, pathTiles, segments, elbow };
}

function roomCenterTile(room: DungeonRoom): { x: number; y: number } {
  return {
    x: room.gridX + Math.floor(room.width / 2),
    y: room.gridY + Math.floor(room.height / 2),
  };
}

function doorOnSide(room: DungeonRoom, side: DoorSide): DungeonDoor {
  const midX = room.gridX + Math.floor(room.width / 2);
  const midY = room.gridY + Math.floor(room.height / 2);
  switch (side) {
    case 'N':
      return { roomId: room.roomId, side, x: midX, y: room.gridY };
    case 'S':
      return {
        roomId: room.roomId,
        side,
        x: midX,
        y: room.gridY + room.height - 1,
      };
    case 'W':
      return { roomId: room.roomId, side, x: room.gridX, y: midY };
    case 'E':
      return {
        roomId: room.roomId,
        side,
        x: room.gridX + room.width - 1,
        y: midY,
      };
  }
}

function stepOut(x: number, y: number, side: DoorSide): { x: number; y: number } {
  switch (side) {
    case 'N':
      return { x, y: y - 1 };
    case 'S':
      return { x, y: y + 1 };
    case 'W':
      return { x: x - 1, y };
    case 'E':
      return { x: x + 1, y };
  }
}

function appendHorizontalRun(
  out: Array<{ x: number; y: number }>,
  y: number,
  xa: number,
  xb: number,
): void {
  const step = xa <= xb ? 1 : -1;
  for (let x = xa; step > 0 ? x <= xb : x >= xb; x += step) {
    out.push({ x, y });
  }
}

function appendVerticalRun(
  out: Array<{ x: number; y: number }>,
  x: number,
  ya: number,
  yb: number,
): void {
  const step = ya <= yb ? 1 : -1;
  for (let y = ya; step > 0 ? y <= yb : y >= yb; y += step) {
    out.push({ x, y });
  }
}

function buildWalkable(
  rooms: readonly DungeonRoom[],
  corridors: readonly DungeonCorridor[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): DungeonWalkable {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const data = new Uint8Array(width * height);
  const offsetX = bounds.minX;
  const offsetY = bounds.minY;

  const mark = (tx: number, ty: number): void => {
    const gx = tx - offsetX;
    const gy = ty - offsetY;
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) return;
    data[gy * width + gx] = 1;
  };

  for (const room of rooms) {
    for (let dy = 0; dy < room.height; dy += 1) {
      for (let dx = 0; dx < room.width; dx += 1) {
        mark(room.gridX + dx, room.gridY + dy);
      }
    }
  }

  for (const corridor of corridors) {
    mark(corridor.fromDoor.x, corridor.fromDoor.y);
    mark(corridor.toDoor.x, corridor.toDoor.y);
    for (const tile of corridor.pathTiles) {
      mark(tile.x, tile.y);
    }
  }

  return { width, height, offsetX, offsetY, data };
}
