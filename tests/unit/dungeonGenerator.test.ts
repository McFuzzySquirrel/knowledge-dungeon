import { describe, expect, it } from 'vitest';
import { generateDungeonMap } from '@/game/systems/dungeonGenerator';
import type {
  DungeonCorridor,
  DungeonDoor,
  DungeonMap,
  DungeonRoom,
} from '@/game/systems/dungeonGenerator';
import { addLinkedRooms, createRootDungeon } from '@/core/graph';

const NOW = '2026-01-01T00:00:00.000Z';

function buildDungeon(childIds: readonly string[]) {
  const root = createRootDungeon({
    dungeonId: 's1',
    subjectName: 'Sub',
    rootRoomId: 'root',
    rootTopic: 'Root',
    nowIso: NOW,
  });
  if (!root.ok) throw new Error('init failed');
  const withChildren = addLinkedRooms(root.value, {
    fromRoomId: 'root',
    drafts: childIds.map((id, i) => ({ roomId: id, topic: `Child ${i + 1}` })),
    nowIso: NOW,
  });
  if (!withChildren.ok) throw new Error('add failed');
  return withChildren.value.dungeon;
}

function isOnPerimeter(door: DungeonDoor, room: DungeonRoom): boolean {
  const onNorth = door.y === room.gridY;
  const onSouth = door.y === room.gridY + room.height - 1;
  const onWest = door.x === room.gridX;
  const onEast = door.x === room.gridX + room.width - 1;
  const xInRange = door.x >= room.gridX && door.x < room.gridX + room.width;
  const yInRange = door.y >= room.gridY && door.y < room.gridY + room.height;
  return (
    (onNorth && xInRange) ||
    (onSouth && xInRange) ||
    (onWest && yInRange) ||
    (onEast && yInRange)
  );
}

function isWalkable(map: DungeonMap, x: number, y: number): boolean {
  const gx = x - map.walkable.offsetX;
  const gy = y - map.walkable.offsetY;
  if (
    gx < 0 ||
    gy < 0 ||
    gx >= map.walkable.width ||
    gy >= map.walkable.height
  ) {
    return false;
  }
  return map.walkable.data[gy * map.walkable.width + gx] === 1;
}

function pathIsContiguous(corridor: DungeonCorridor): boolean {
  // The path traced by the corridor (door → out-tiles → door) should be a
  // sequence of 4-connected tiles with no diagonal jumps.
  const tiles = [
    { x: corridor.fromDoor.x, y: corridor.fromDoor.y },
    ...corridor.pathTiles,
    { x: corridor.toDoor.x, y: corridor.toDoor.y },
  ];
  for (let i = 1; i < tiles.length; i += 1) {
    const dx = Math.abs(tiles[i].x - tiles[i - 1].x);
    const dy = Math.abs(tiles[i].y - tiles[i - 1].y);
    if (!((dx === 1 && dy === 0) || (dx === 0 && dy === 1) || (dx === 0 && dy === 0))) {
      return false;
    }
  }
  return true;
}

describe('generateDungeonMap', () => {
  it('places the root room at the origin and adds children at adjacent cells', () => {
    const dungeon = buildDungeon(['c1', 'c2']);
    const map = generateDungeonMap(dungeon);
    expect(map.rooms).toHaveLength(3);
    const rootRoom = map.rooms.find((r) => r.isRoot);
    expect(rootRoom).toBeTruthy();
    expect(rootRoom?.gridX).toBe(0);
    expect(rootRoom?.gridY).toBe(0);
    expect(map.corridors).toHaveLength(2);
  });

  it('is deterministic given the same seed', () => {
    const dungeon = buildDungeon(['c1', 'c2', 'c3']);
    const a = generateDungeonMap(dungeon, 'fixed-seed');
    const b = generateDungeonMap(dungeon, 'fixed-seed');
    expect(a.rooms.map((r) => `${r.roomId}:${r.gridX},${r.gridY}`)).toEqual(
      b.rooms.map((r) => `${r.roomId}:${r.gridX},${r.gridY}`),
    );
  });

  it('places child rooms only at orthogonally adjacent macro cells', () => {
    const dungeon = buildDungeon(['c1', 'c2', 'c3', 'c4']);
    const map = generateDungeonMap(dungeon);
    const root = map.rooms.find((r) => r.isRoot)!;
    const strideX = root.width + 4; // ROOM_SPACING = 4
    const strideY = root.height + 4;
    for (const child of map.rooms.filter((r) => !r.isRoot)) {
      const dx = (child.gridX - root.gridX) / strideX;
      const dy = (child.gridY - root.gridY) / strideY;
      // Each child placed by BFS should land on exactly one orthogonal step.
      expect(Number.isInteger(dx)).toBe(true);
      expect(Number.isInteger(dy)).toBe(true);
      // Tree edges from the root never use diagonals — exactly one axis differs.
      const isOrthogonal =
        (Math.abs(dx) === 1 && dy === 0) || (Math.abs(dy) === 1 && dx === 0);
      expect(isOrthogonal).toBe(true);
    }
  });

  it('gives each corridor doors on the perimeter of its two rooms', () => {
    const dungeon = buildDungeon(['c1', 'c2', 'c3']);
    const map = generateDungeonMap(dungeon);
    const roomById = new Map(map.rooms.map((r) => [r.roomId, r]));
    expect(map.corridors.length).toBeGreaterThan(0);
    for (const corridor of map.corridors) {
      const fromRoom = roomById.get(corridor.fromRoomId)!;
      const toRoom = roomById.get(corridor.toRoomId)!;
      expect(corridor.fromDoor.roomId).toBe(corridor.fromRoomId);
      expect(corridor.toDoor.roomId).toBe(corridor.toRoomId);
      expect(isOnPerimeter(corridor.fromDoor, fromRoom)).toBe(true);
      expect(isOnPerimeter(corridor.toDoor, toRoom)).toBe(true);
    }
    // The aggregate doors list should match (2 per corridor).
    expect(map.doors).toHaveLength(map.corridors.length * 2);
  });

  it('produces axis-aligned corridor paths whose tiles are all walkable', () => {
    const dungeon = buildDungeon(['c1', 'c2', 'c3']);
    const map = generateDungeonMap(dungeon);
    for (const corridor of map.corridors) {
      expect(pathIsContiguous(corridor)).toBe(true);
      for (const seg of corridor.segments) {
        // Segments must be axis-aligned (no diagonal segments allowed).
        expect(seg.orientation === 'h' || seg.orientation === 'v').toBe(true);
        if (seg.orientation === 'h') expect(seg.y1).toBe(seg.y2);
        else expect(seg.x1).toBe(seg.x2);
      }
      expect(isWalkable(map, corridor.fromDoor.x, corridor.fromDoor.y)).toBe(true);
      expect(isWalkable(map, corridor.toDoor.x, corridor.toDoor.y)).toBe(true);
      for (const tile of corridor.pathTiles) {
        expect(isWalkable(map, tile.x, tile.y)).toBe(true);
      }
    }
  });

  it('marks every room tile walkable in the dungeon walkability grid', () => {
    const dungeon = buildDungeon(['c1', 'c2']);
    const map = generateDungeonMap(dungeon);
    for (const room of map.rooms) {
      for (let dy = 0; dy < room.height; dy += 1) {
        for (let dx = 0; dx < room.width; dx += 1) {
          expect(isWalkable(map, room.gridX + dx, room.gridY + dy)).toBe(true);
        }
      }
    }
  });
});
