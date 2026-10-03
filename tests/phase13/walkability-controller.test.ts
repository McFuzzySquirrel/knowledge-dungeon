/**
 * The pure dungeon movement controller, exercised headlessly.
 *
 * ## Why this file has no canvas, no PixiJS, and no Phaser
 *
 * The whole point of `src/renderers/pixi/dungeon/WalkabilityController.ts` is that the
 * plan's "pure movement controller" deliverable is a module with no renderer in it. A
 * test file that imported `pixi.js` to check it would prove less than the module's own
 * header claims, so this file imports only the controller and the map generator.
 *
 * The static assertion at the bottom is the part that would otherwise be a comment: it
 * reads the controller's source and fails on a renderer import, so "pure" is enforced by
 * a red run rather than by review.
 *
 * ## What is asserted, and why each case is a rule rather than an example
 *
 * - **Hidden floors are impassable.** The plan's manual check is "verify hidden-floor
 *   corridors cannot be crossed". A corridor with one hidden endpoint contributes
 *   nothing to the mask, so the test walks the whole length of such a corridor and
 *   proves the player never reaches the far end.
 * - **Collision slides rather than sticks.** A single-axis rejection must still let the
 *   other axis through, or the player wedges on every doorway.
 * - **Outside the grid is solid.** An unbounded mask would let a player walk out of the
 *   dungeon entirely, which is the failure a mask exists to prevent.
 * - **A hundred rooms stay traversable.** Plan section 10.2's 60 FPS target is about a
 *   100-room dungeon; "a hundred-room subject is geometrically traversable" below floods
 *   the mask and asserts all 100 room centres are reachable. Frame *time* at 100 rooms is
 *   **not** measured here and is not claimed - that needs a browser lane.
 *
 * Hermeticity: synthetic identifiers only, no `dist/`, no network, no clock.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonCorridor, DungeonMap, DungeonRoom } from '@/core/layout/dungeonTypes';
import type { DungeonMetadata } from '@/core/validation/persistence';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import {
  DUNGEON_PLAYER_COLLIDER_SIZE,
  DUNGEON_PLAYER_SPEED,
  DUNGEON_PLAYER_WALK_INSET,
  DUNGEON_SPATIAL_LOOKUP_ROOM_THRESHOLD,
  buildActiveWalkability,
  buildRoomIndex,
  canPlayerOccupy,
  createWalkabilityController,
  findRoomAtWorld,
  isWalkableAt,
  normalizeFacing,
  resolveRoomCenter,
  resolveRoomDecor,
  resolveRoomGuidePosition,
  stepPlayer,
  type ActiveWalkability,
  type WorldPoint,
} from '../../src/renderers/pixi/dungeon/WalkabilityController';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ROOT = process.cwd();

/**
 * A synthetic subject graph: one root plus `childCount` subtopics, one level deep.
 *
 * Built through the real graph domain rather than a hand-written map, so the layout
 * under test is the layout the application produces - a `DungeonMap` hand-assembled in a
 * test could be one the generator would never emit, and then "traversable" would be a
 * claim about the fixture.
 */
interface BuiltSubject {
  /** The layout the renderer presents. */
  readonly dungeonMap: DungeonMap;
  /** The graph metadata, which `computeFloorVisibility` consumes. */
  readonly metadata: DungeonMetadata;
  readonly roomsById: ReadonlyMap<string, DungeonRoom>;
}

function buildSubject(childCount: number): BuiltSubject {
  const root = createRootDungeon({
    dungeonId: 'synthetic-subject',
    subjectName: 'Synthetic Subject',
    rootRoomId: 'root',
    rootTopic: 'Root Topic',
    nowIso: NOW,
  });
  if (!root.ok) throw new Error('root dungeon init failed');
  const childIds = Array.from({ length: childCount }, (_unused, index) => `child-${index}`);
  const grown = addLinkedRooms(root.value, {
    fromRoomId: 'root',
    drafts: childIds.map((roomId, index) => ({ roomId, topic: `Child Topic ${index}` })),
    nowIso: NOW,
  });
  if (!grown.ok) throw new Error('addLinkedRooms failed');
  const metadata = grown.value.dungeon;
  const dungeonMap = generateDungeonMap(metadata);
  return {
    dungeonMap,
    metadata,
    roomsById: new Map(dungeonMap.rooms.map((room) => [room.roomId, room])),
  };
}

/** The room a room id names, or a thrown error rather than an undefined. */
function roomOf(map: DungeonMap, roomId: string): DungeonRoom {
  const room = map.rooms.find((entry) => entry.roomId === roomId);
  if (room === undefined) throw new Error(`no room ${roomId} in the generated map`);
  return room;
}

/** Every tile centre of a room, in reading order. */
function roomTileCenters(room: DungeonRoom, tileSize: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let dy = 0; dy < room.height; dy += 1) {
    for (let dx = 0; dx < room.width; dx += 1) {
      points.push({ x: (room.gridX + dx + 0.5) * tileSize, y: (room.gridY + dy + 0.5) * tileSize });
    }
  }
  return points;
}

/** How many walkable tiles the mask holds. Used to assert a mask is not empty. */
function walkableTileCount(active: ActiveWalkability): number {
  let total = 0;
  for (const value of active.data) total += value === 1 ? 1 : 0;
  return total;
}

describe('the controller module is pure, which is the claim this file makes about it', () => {
  it('imports no renderer and touches no DOM global', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/renderers/pixi/dungeon/WalkabilityController.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    for (const forbidden of [
      /from\s*['"]pixi\.js/,
      /from\s*['"]phaser['"]/,
      /from\s*['"]@\/game(?:\/|['"])/,
      /\bdocument\./,
      /\bwindow\./,
      /new\s+Date\(/,
      /\bMath\.random\b/,
    ]) {
      expect(forbidden.test(code), `WalkabilityController.ts must not match ${forbidden}`).toBe(false);
    }
  });

  it('keeps the Phaser scene movement constants, so the two renderers cannot drift', () => {
    // These four numbers are the whole of the collision feel. Asserting them against
    // literals could not detect drift in *either* direction, so this reads them out of
    // `src/game/scenes/DungeonScene.ts` and compares: a change to the Phaser scene's speed,
    // collider, inset, or room-index threshold is now a red run here rather than a silent
    // behavioural difference between the two renderers.
    //
    // Line-scanned rather than pattern-matched, because a regular expression written in a
    // template literal eats its own backslashes and a test that silently stops matching
    // reports "not declared" rather than "drifted".
    const phaserLines = readFileSync(
      path.join(REPO_ROOT, 'src/game/scenes/DungeonScene.ts'),
      'utf8',
    ).split('\n');

    /**
     * The number that follows `prefix` on the first matching line.
     *
     * The trailing number is whatever the line ends with, so the caller passes the whole
     * comparison (`'>= 50;'`) rather than a fragment of one. That keeps the parsing a
     * single `Number(...)` and makes a renamed or reworded declaration fail loudly with the
     * line it could not read, instead of quietly matching something else.
     */
    const declaredNumber = (prefix: string): number => {
      const line = phaserLines.find((entry) => entry.trim().startsWith(prefix));
      if (line === undefined) {
        throw new Error(`the Phaser dungeon scene declares nothing starting with "${prefix}"`);
      }
      const value = Number(line.trim().slice(prefix.length).replace(';', '').trim());
      if (!Number.isFinite(value)) {
        throw new Error(`"${prefix}" did not parse as a number: ${line}`);
      }
      return value;
    };

    expect(declaredNumber('const PLAYER_SPEED =')).toBe(DUNGEON_PLAYER_SPEED);
    expect(declaredNumber('const PLAYER_COLLIDER_SIZE =')).toBe(DUNGEON_PLAYER_COLLIDER_SIZE);
    expect(declaredNumber('const PLAYER_WALK_INSET =')).toBe(DUNGEON_PLAYER_WALK_INSET);
    // The threshold is an inline comparison in the Phaser scene rather than a named
    // constant, so it is read from the comparison itself.
    expect(declaredNumber('this.useSpatialLookup = map.rooms.length >=')).toBe(
      DUNGEON_SPATIAL_LOOKUP_ROOM_THRESHOLD,
    );
  });
});

describe('the walkability mask is a function of the visible floor', () => {
  it('an unfiltered mask covers every room the map has', () => {
    const { dungeonMap } = buildSubject(6);
    const all = buildActiveWalkability(dungeonMap, null);
    const rootRoom = roomOf(dungeonMap, 'root');
    for (const point of roomTileCenters(rootRoom, dungeonMap.tileSize)) {
      expect(isWalkableAt(all, dungeonMap.tileSize, point.x, point.y), `${point.x},${point.y}`).toBe(
        true,
      );
    }
    // Every room's own footprint is walkable with no filter, which is the
    // single-floor-subject case that never calls `setFloorVisibility`.
    for (const room of dungeonMap.rooms) {
      const center = resolveRoomCenter(room, dungeonMap.tileSize);
      expect(isWalkableAt(all, dungeonMap.tileSize, center.x, center.y), room.roomId).toBe(true);
    }
    expect(walkableTileCount(all)).toBeGreaterThan(0);
  });

  it('a filtered mask contains no tile of a hidden room', () => {
    const { dungeonMap, roomsById } = buildSubject(6);
    const rootRoom = roomsById.get('root');
    if (rootRoom === undefined) throw new Error('root room missing');
    const filtered = buildActiveWalkability(dungeonMap, new Set(['root']));
    for (const point of roomTileCenters(rootRoom, dungeonMap.tileSize)) {
      expect(isWalkableAt(filtered, dungeonMap.tileSize, point.x, point.y)).toBe(true);
    }
    for (const room of dungeonMap.rooms) {
      if (room.roomId === 'root') continue;
      // Sample the room's middle band; an edge tile can legitimately coincide with a
      // corridor the root floor uses, and this asserts the interior is solid.
      const y = (room.gridY + Math.floor(room.height / 2)) * dungeonMap.tileSize;
      const x = (room.gridX + room.width / 2) * dungeonMap.tileSize;
      expect(isWalkableAt(filtered, dungeonMap.tileSize, x, y), room.roomId).toBe(false);
    }
  });

  it('treats a point outside the grid as solid rather than as open ground', () => {
    const { dungeonMap } = buildSubject(3);
    const mask = buildActiveWalkability(dungeonMap, null);
    expect(isWalkableAt(mask, dungeonMap.tileSize, -10_000, -10_000)).toBe(false);
    expect(isWalkableAt(mask, dungeonMap.tileSize, 10_000, 10_000)).toBe(false);
    // And a non-finite coordinate is refused rather than turned into `NaN` indexing.
    expect(isWalkableAt(mask, dungeonMap.tileSize, Number.NaN, 0)).toBe(false);
  });
});

describe('collision resolves per axis, so the player slides along a wall', () => {
  it('rejects the blocked axis and still applies the free one', () => {
    const { dungeonMap } = buildSubject(3);
    const mask = buildActiveWalkability(dungeonMap, new Set(['root']));
    const rootRoom = roomOf(dungeonMap, 'root');

    // The room's bottom-left tile centre: fully inside, with wall above and below.
    const x = (rootRoom.gridX + 0.5) * dungeonMap.tileSize;
    const y = (rootRoom.gridY + 0.5) * dungeonMap.tileSize;

    // Straight down is inside the room; a whole tile up is wall, because the collider's
    // upper corners land on the row above the room.
    const down = stepPlayer(mask, dungeonMap.tileSize, { x, y }, 0, 4);
    expect(down.y).toBeGreaterThan(y);

    const tileSize = dungeonMap.tileSize;
    const up = stepPlayer(mask, dungeonMap.tileSize, { x, y }, 0, -tileSize);
    expect(up.y).toBe(y);

    // The slide: down-and-left from the west wall must still move down. A single
    // combined test would refuse both axes and the player would wedge at every doorway.
    const slid = stepPlayer(mask, dungeonMap.tileSize, { x, y }, -tileSize, 4);
    expect(slid.x).toBe(x);
    expect(slid.y).toBeGreaterThan(y);
  });

  it('a collider only occupies when all four inset corners are walkable', () => {
    const { dungeonMap } = buildSubject(3);
    const mask = buildActiveWalkability(dungeonMap, new Set(['root']));
    const rootRoom = roomOf(dungeonMap, 'root');
    const center = resolveRoomCenter(rootRoom, dungeonMap.tileSize);
    expect(canPlayerOccupy(mask, dungeonMap.tileSize, center.x, center.y)).toBe(true);

    // Straddling the room's top-left corner: two corners are in the wall.
    const cornerX = rootRoom.gridX * dungeonMap.tileSize;
    const cornerY = rootRoom.gridY * dungeonMap.tileSize;
    expect(canPlayerOccupy(mask, dungeonMap.tileSize, cornerX, cornerY)).toBe(false);

    // The inset is what makes this pass one tile in from the corner, which is the
    // behaviour the Phaser scene's `PLAYER_WALK_INSET` exists for.
    expect(
      canPlayerOccupy(
        mask,
        dungeonMap.tileSize,
        cornerX + DUNGEON_PLAYER_COLLIDER_SIZE / 2 - DUNGEON_PLAYER_WALK_INSET + 0.01,
        cornerY + DUNGEON_PLAYER_COLLIDER_SIZE / 2 - DUNGEON_PLAYER_WALK_INSET + 0.01,
      ),
    ).toBe(true);
  });

  it('a zero-length step is a no-op rather than a collision query', () => {
    const { dungeonMap } = buildSubject(3);
    const mask = buildActiveWalkability(dungeonMap, null);
    const from = { x: 0, y: 0 };
    expect(stepPlayer(mask, dungeonMap.tileSize, from, 0, 0)).toEqual(from);
  });
});

describe('a corridor to a hidden floor cannot be crossed', () => {
  /**
   * Walk a straight line from one end of a corridor to the other in small steps and
   * report how far the player got.
   *
   * Walking rather than sampling matters: the rule is not "no corridor tile is
   * walkable" but "the player cannot get there", and only an integration proves the
   * second.
   */
  function walkRoute(
    waypoints: readonly WorldPoint[],
    controller: ReturnType<typeof createWalkabilityController>,
  ): { reached: boolean; blockedAt: WorldPoint | null } {
    const last = waypoints[waypoints.length - 1];
    if (last === undefined) return { reached: true, blockedAt: null };
    let x = waypoints[0]?.x ?? last.x;
    let y = waypoints[0]?.y ?? last.y;

    for (let index = 1; index < waypoints.length; index += 1) {
      const target = waypoints[index];
      const total = Math.hypot(target.x - x, target.y - y);
      const stepX = ((target.x - x) / total) * 1;
      const stepY = ((target.y - y) / total) * 1;
      // Unit steps, so the loop is bounded by the leg's own length. The arrival test
      // is inside the loop: a fixed step *count* would carry the player past the
      // waypoint and into whatever lies beyond it, which would turn a walking
      // simulation into an aimless one.
      for (let travelled = 0; travelled <= Math.ceil(total); travelled += 1) {
        if (Math.hypot(target.x - x, target.y - y) < 1) break;
        const next = controller.step(x, y, stepX, stepY);
        if (next.x === x && next.y === y) return { reached: false, blockedAt: { x, y } };
        x = next.x;
        y = next.y;
      }
      if (Math.hypot(target.x - x, target.y - y) > 1) return { reached: false, blockedAt: { x, y } };
    }
    return { reached: true, blockedAt: null };
  }

  /**
   * The waypoints that follow one corridor: near room centre, its door, every path tile,
   * the far door, the far room centre.
   *
   * Built from the corridor's own recorded path rather than a chord between the two room
   * centres, because a corridor bends: a straight line would leave the walkable region
   * and would prove nothing about the corridor.
   */
  function corridorRoute(dungeonMap: DungeonMap, corridor: DungeonCorridor): WorldPoint[] {
    const tileSize = dungeonMap.tileSize;
    const tile = (x: number, y: number): WorldPoint => ({ x: (x + 0.5) * tileSize, y: (y + 0.5) * tileSize });
    return [
      resolveRoomCenter(roomOf(dungeonMap, corridor.fromRoomId), tileSize),
      tile(corridor.fromDoor.x, corridor.fromDoor.y),
      ...corridor.pathTiles.map((t) => tile(t.x, t.y)),
      tile(corridor.toDoor.x, corridor.toDoor.y),
      resolveRoomCenter(roomOf(dungeonMap, corridor.toRoomId), tileSize),
    ];
  }

  it('a corridor whose far room is hidden stops the player at the near end', () => {
    const { dungeonMap } = buildSubject(4);
    const corridor = dungeonMap.corridors.find(
      (entry) => entry.fromRoomId === 'root' || entry.toRoomId === 'root',
    );
    if (corridor === undefined) throw new Error('the generated map has no root corridor');
    expect(
      corridor.fromRoomId === 'root' ? corridor.toRoomId : corridor.fromRoomId,
      'the fixture corridor must leave the root room',
    ).not.toBe('root');

    // Only the root is visible, so the far room belongs to another floor.
    const controller = createWalkabilityController({
      map: dungeonMap,
      visibleRoomIds: new Set(['root']),
    });
    const result = walkRoute(corridorRoute(dungeonMap, corridor), controller);

    expect(result.reached, 'the player walked a corridor into a hidden-floor room').toBe(false);
    expect(result.blockedAt, 'the walk reported no blocking point').not.toBeNull();
  });

  it('the same corridor is crossable once the far room becomes visible', () => {
    const { dungeonMap } = buildSubject(4);
    const corridor = dungeonMap.corridors.find(
      (entry) => entry.fromRoomId === 'root' || entry.toRoomId === 'root',
    );
    if (corridor === undefined) throw new Error('the generated map has no root corridor');

    const controller = createWalkabilityController({ map: dungeonMap, visibleRoomIds: null });
    expect(walkRoute(corridorRoute(dungeonMap, corridor), controller).reached).toBe(true);
  });

  it('every root corridor is impassable when the far room is hidden, and passable when it is not', () => {
    // One corridor is an anecdote. This walks all of them, which is the plan's manual
    // check ("verify hidden-floor corridors cannot be crossed") as a loop rather than as a
    // single example - and the "and passable when it is not" half is what stops the test
    // passing for the wrong reason, by a mask that is simply empty.
    const { dungeonMap } = buildSubject(8);
    const rootCorridors = dungeonMap.corridors.filter(
      (entry) => entry.fromRoomId === 'root' || entry.toRoomId === 'root',
    );
    expect(rootCorridors).toHaveLength(8);

    const visibleOnly = createWalkabilityController({
      map: dungeonMap,
      visibleRoomIds: new Set(['root']),
    });
    const unfiltered = createWalkabilityController({ map: dungeonMap, visibleRoomIds: null });

    for (const corridor of rootCorridors) {
      const farRoomId = corridor.fromRoomId === 'root' ? corridor.toRoomId : corridor.fromRoomId;
      expect(walkRoute(corridorRoute(dungeonMap, corridor), visibleOnly).reached, farRoomId).toBe(false);
      expect(walkRoute(corridorRoute(dungeonMap, corridor), unfiltered).reached, farRoomId).toBe(true);
    }
  });

  it('the visible-floor rule agrees with computeFloorVisibility, which owns the semantics', () => {
    // The plan says navigation semantics are *preserved*, not rewritten. This is the
    // join: for a real floor, the mask admits exactly the rooms
    // `computeFloorVisibility` says are visible, and the portal set is the one the
    // renderer is handed.
    const { dungeonMap, metadata } = buildSubject(9);
    const hierarchy = deriveGraphHierarchy(metadata);
    const visibility = computeFloorVisibility(hierarchy, metadata, 'root');

    // The flat-floor model this fixture produces: no up portal on the root floor, and
    // one down portal per top-level subtopic.
    expect(visibility.portalUpRoomId).toBeNull();
    expect(visibility.portalDownRoomIds.size).toBe(9);
    for (const childRoomId of visibility.portalDownRoomIds) {
      expect(visibility.visibleRoomIds.has(childRoomId), childRoomId).toBe(true);
    }

    // The mask is a function of `visibleRoomIds` and nothing else: exactly the rooms the
    // contract call says are visible are walkable, and every other room is solid.
    //
    // This is deliberately stated over `visibleRoomIds` rather than over the hierarchy's
    // floor membership, because `computeFloorVisibility` *includes* the down-portal
    // rooms - they are on this floor and must be walkable to reach the stairs. A test
    // that used floor membership would fail on exactly the rooms the feature exists for.
    const mask = buildActiveWalkability(dungeonMap, visibility.visibleRoomIds);
    expect(visibility.visibleRoomIds.size).toBeGreaterThan(0);
    for (const room of dungeonMap.rooms) {
      const center = resolveRoomCenter(room, dungeonMap.tileSize);
      const walkable = isWalkableAt(mask, dungeonMap.tileSize, center.x, center.y);
      if (visibility.visibleRoomIds.has(room.roomId)) {
        expect(walkable, `a visible room must be walkable: ${room.roomId}`).toBe(true);
      } else {
        expect(walkable, `a hidden room must be solid: ${room.roomId}`).toBe(false);
      }
    }
    // And the flat fixture has no hidden room, or the negative half above is vacuous -
    // which is exactly why the next test builds a *nested* subject.
    expect(visibility.visibleRoomIds.size).toBe(dungeonMap.rooms.length);
  });

  it('a nested subject hides its deeper rooms, and the mask makes them solid', () => {
    // One level deep, every child is both a root-floor room *and* a down portal, so
    // nothing is hidden and the negative half of the previous test has nothing to
    // check. This fixture adds grandchildren: they belong to the child's floor, not the
    // root's, so the root floor genuinely hides rooms - which is the shape a real
    // multi-floor subject has.
    const root = createRootDungeon({
      dungeonId: 'synthetic-subject',
      subjectName: 'Synthetic Subject',
      rootRoomId: 'root',
      rootTopic: 'Root Topic',
      nowIso: NOW,
    });
    if (!root.ok) throw new Error('root dungeon init failed');
    const withChildren = addLinkedRooms(root.value, {
      fromRoomId: 'root',
      drafts: [
        { roomId: 'child-a', topic: 'Child A' },
        { roomId: 'child-b', topic: 'Child B' },
      ],
      nowIso: NOW,
    });
    if (!withChildren.ok) throw new Error('addLinkedRooms (children) failed');
    const withGrandchildren = addLinkedRooms(withChildren.value.dungeon, {
      fromRoomId: 'child-a',
      drafts: [{ roomId: 'grandchild-0', topic: 'Grandchild 0' }],
      nowIso: NOW,
    });
    if (!withGrandchildren.ok) throw new Error('addLinkedRooms (grandchildren) failed');

    const metadata = withGrandchildren.value.dungeon;
    const dungeonMap = generateDungeonMap(metadata);
    const visibility = computeFloorVisibility(deriveGraphHierarchy(metadata), metadata, 'root');

    expect(visibility.visibleRoomIds.has('grandchild-0')).toBe(false);
    expect(visibility.visibleRoomIds.has('child-a')).toBe(true);
    // The root floor's up portal is null and its down portals are its own children.
    expect(visibility.portalUpRoomId).toBeNull();
    expect([...visibility.portalDownRoomIds].sort()).toEqual(['child-a', 'child-b']);

    const mask = buildActiveWalkability(dungeonMap, visibility.visibleRoomIds);
    const hidden = roomOf(dungeonMap, 'grandchild-0');
    const hiddenCentre = resolveRoomCenter(hidden, dungeonMap.tileSize);
    expect(isWalkableAt(mask, dungeonMap.tileSize, hiddenCentre.x, hiddenCentre.y)).toBe(false);
    for (const visibleRoomId of visibility.visibleRoomIds) {
      const room = roomOf(dungeonMap, visibleRoomId);
      const centre = resolveRoomCenter(room, dungeonMap.tileSize);
      expect(isWalkableAt(mask, dungeonMap.tileSize, centre.x, centre.y), visibleRoomId).toBe(true);
    }

    // The child's own floor does see the grandchild, which is what makes the two floors
    // a round trip rather than a dead end.
    const childFloor = computeFloorVisibility(
      deriveGraphHierarchy(metadata),
      metadata,
      'child-a',
    );
    expect(childFloor.portalUpRoomId).toBe('root');
    expect(childFloor.visibleRoomIds.has('grandchild-0')).toBe(true);
  });
});

describe('a hundred-room subject is geometrically traversable', () => {
  /**
   * Flood the walkable mask from the root room centre and report which rooms were reached.
   *
   * A BFS over *tiles* rather than over rooms, because the claim is about the mask: a room
   * is reachable exactly when some walkable tile in it is, and a room-level BFS could hop
   * across a corridor the mask does not actually contain. The frontier is a queue of grid
   * indices, so the cost is bounded by the mask and not by the room count.
   */
  function floodReachedRooms(active: ActiveWalkability, map: DungeonMap): Set<string> {
    const { width, height, offsetX, offsetY, data } = active;
    const seen = new Uint8Array(width * height);
    const queue: number[] = [];
    const reached = new Set<string>();

    const roomContaining = (tx: number, ty: number): string | null => {
      for (const room of map.rooms) {
        if (
          tx >= room.gridX &&
          tx < room.gridX + room.width &&
          ty >= room.gridY &&
          ty < room.gridY + room.height
        ) {
          return room.roomId;
        }
      }
      return null;
    };

    const visit = (gx: number, gy: number): void => {
      if (gx < 0 || gy < 0 || gx >= width || gy >= height) return;
      const index = gy * width + gx;
      if (seen[index] === 1 || data[index] !== 1) return;
      seen[index] = 1;
      queue.push(index);
      const roomId = roomContaining(gx + offsetX, gy + offsetY);
      if (roomId !== null) reached.add(roomId);
    };

    const root = map.rooms.find((room) => room.isRoot) ?? map.rooms[0];
    if (root === undefined) throw new Error('the fixture has no root room');
    // The seed is the centre of the root room, in tile coordinates, exactly where the
    // scene spawns the player.
    visit(
      Math.floor(root.gridX + root.width / 2) - offsetX,
      Math.floor(root.gridY + root.height / 2) - offsetY,
    );

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head] as number;
      const gx = index % width;
      const gy = Math.floor(index / width);
      visit(gx + 1, gy);
      visit(gx - 1, gy);
      visit(gx, gy + 1);
      visit(gx, gy - 1);
    }
    return reached;
  }

  it('reaches all 100 room centres, unfiltered and on the root floor', () => {
    const { dungeonMap: map, metadata } = buildSubject(99);

    // The layout facts the claim rests on, asserted rather than assumed.
    expect(map.rooms).toHaveLength(100);
    expect(map.corridors).toHaveLength(99);
    expect(map.doors).toHaveLength(198);
    const maskCells = map.walkable.width * map.walkable.height;
    expect(maskCells, `mask is ${maskCells} cells`).toBeGreaterThan(100_000);

    // 1. Unfiltered: the whole subject is one walkable region.
    const unfilteredMask = buildActiveWalkability(map, null);
    const startUnfiltered = performance.now();
    const reachedUnfiltered = floodReachedRooms(unfilteredMask, map);
    const elapsedUnfiltered = performance.now() - startUnfiltered;
    expect(reachedUnfiltered.size, 'not every room is reachable with no floor filter').toBe(100);
    // A sanity bound, not a benchmark: a regression in grid size shows up as a number here
    // rather than as an unexplained slow run.
    expect(elapsedUnfiltered, `flood took ${elapsedUnfiltered.toFixed(1)} ms`).toBeLessThan(5_000);

    // 2. Root-floor filtered: the flow's own visibility model, not a hand-written set.
    const visibility = computeFloorVisibility(deriveGraphHierarchy(metadata), metadata, 'root');
    const filteredMask = buildActiveWalkability(map, visibility.visibleRoomIds);
    const startFiltered = performance.now();
    const reachedFiltered = floodReachedRooms(filteredMask, map);
    const elapsedFiltered = performance.now() - startFiltered;
    // In this flat-floor model each top-level subtopic is its own floor, so the root floor
    // is the root room plus all ninety-nine children - every one of which is a down portal
    // and therefore has to be reachable for its stairs to be usable.
    expect(visibility.visibleRoomIds.size).toBe(100);
    expect(reachedFiltered.size, 'not every visible room is reachable on the root floor').toBe(
      100,
    );
    expect(elapsedFiltered, `flood took ${elapsedFiltered.toFixed(1)} ms`).toBeLessThan(5_000);

    // And the two floods agree room for room, which is what makes the filtered claim mean
    // "the same subject, seen one floor at a time" rather than "a smaller subject".
    expect([...reachedFiltered].sort()).toEqual([...reachedUnfiltered].sort());
  });

  it('hiding a room removes it from the reachable set, so the flood reads the mask', () => {
    // The non-vacuity control for the test above. A flood that ignored the mask would
    // report 100 here as well, and the assertion above would pass for the wrong reason.
    const { dungeonMap: map } = buildSubject(99);
    const hidden = map.rooms[map.rooms.length - 1];
    if (hidden === undefined || hidden.roomId === 'root') throw new Error('no hidden room');

    const mask = buildActiveWalkability(map, new Set(['root']));
    const reached = floodReachedRooms(mask, map);
    expect([...reached], 'hiding every room but the root did not reduce the reachable set').toEqual([
      'root',
    ]);
  });
});

describe('the room index answers the same question on both sides of the threshold', () => {
  it('finds a room on a small map and on a large one', () => {
    for (const childCount of [4, 60]) {
      const { dungeonMap } = buildSubject(childCount);
      const index = buildRoomIndex(dungeonMap);
      expect(index.useSpatialLookup, `${childCount} rooms`).toBe(
        dungeonMap.rooms.length >= DUNGEON_SPATIAL_LOOKUP_ROOM_THRESHOLD,
      );
      for (const room of dungeonMap.rooms) {
        const center = resolveRoomCenter(room, dungeonMap.tileSize);
        expect(findRoomAtWorld(index, dungeonMap, center.x, center.y, null)?.roomId, room.roomId).toBe(
          room.roomId,
        );
      }
      // A point far outside the bounds is in no room, through either lookup path.
      expect(
        findRoomAtWorld(index, dungeonMap, -10_000, -10_000, null),
        `${childCount} rooms`,
      ).toBeNull();
    }
  });

  it('respects the floor filter on the large-map path, not only the linear scan', () => {
    const { dungeonMap } = buildSubject(60);
    const index = buildRoomIndex(dungeonMap);
    expect(index.useSpatialLookup).toBe(true);
    const hidden = dungeonMap.rooms.find((room) => room.roomId !== 'root');
    if (hidden === undefined) throw new Error('no hidden room in the fixture');
    const center = resolveRoomCenter(hidden, dungeonMap.tileSize);
    expect(findRoomAtWorld(index, dungeonMap, center.x, center.y, new Set(['root']))).toBeNull();
  });
});

describe('the stateful controller keeps the mask and the room filter in agreement', () => {
  it('rebuilds on a filter change and skips the work when the filter is identical', () => {
    const { dungeonMap } = buildSubject(5);
    const controller = createWalkabilityController({ map: dungeonMap });
    const hidden = roomOf(dungeonMap, dungeonMap.rooms[1].roomId);
    const center = resolveRoomCenter(hidden, dungeonMap.tileSize);

    expect(controller.isWalkableAt(center.x, center.y)).toBe(true);
    const before = controller.readMask();

    controller.setVisibleRooms(new Set(['root']));
    expect(controller.isWalkableAt(center.x, center.y)).toBe(false);
    expect(controller.readMask()).not.toBe(before);
    expect(controller.visibleRoomIds()).toEqual(new Set(['root']));

    // An equal set is not a change: the mask object is retained.
    const after = controller.readMask();
    controller.setVisibleRooms(new Set(['root']));
    expect(controller.readMask()).toBe(after);

    controller.reset();
    expect(controller.visibleRoomIds()).toBeNull();
    expect(controller.isWalkableAt(center.x, center.y)).toBe(true);
  });

  it('the controller answers the same questions as the bare functions', () => {
    const { dungeonMap } = buildSubject(4);
    const controller = createWalkabilityController({ map: dungeonMap });
    const mask = buildActiveWalkability(dungeonMap, null);
    const rootRoom = roomOf(dungeonMap, 'root');
    const center = resolveRoomCenter(rootRoom, dungeonMap.tileSize);

    expect(controller.canPlayerOccupy(center.x, center.y)).toBe(
      canPlayerOccupy(mask, dungeonMap.tileSize, center.x, center.y),
    );
    expect(controller.step(center.x, center.y, 1, 0)).toEqual(
      stepPlayer(mask, dungeonMap.tileSize, center, 1, 0),
    );
    expect(controller.roomAt(center.x, center.y)?.roomId).toBe('root');
    expect(controller.landingPointFor('not-a-room')).toBeNull();
    expect(controller.landingPointFor('root')).toEqual(
      resolveRoomCenter(rootRoom, dungeonMap.tileSize),
    );
  });
});

describe('the deterministic layout seeds agree with the Phaser scene rules', () => {
  it('places the guide at one of four corner anchors, furthest from marker and label', () => {
    const { dungeonMap } = buildSubject(4);
    for (const room of dungeonMap.rooms) {
      for (const floorId of ['root', 'child-0']) {
        const position = resolveRoomGuidePosition(room, floorId, dungeonMap.tileSize);
        // Normalised to the room's own size: the anchors are fractions of it, not tiles.
        const ax = (position.x / dungeonMap.tileSize - room.gridX) / room.width;
        const ay = (position.y / dungeonMap.tileSize - room.gridY) / room.height;
        expect([0.18, 0.82], `${room.roomId} guide x`).toContain(Number(ax.toFixed(2)));
        expect([0.24, 0.52], `${room.roomId} guide y`).toContain(Number(ay.toFixed(2)));
        // Chosen as the anchor furthest from the artifact marker and the topic label.
        expect(Math.min(Math.hypot(ax - 0.5, ay - 0.25), Math.hypot(ax - 0.5, ay - 0.9))).toBeGreaterThan(0.2);
      }
    }
  });

  it('is stable across calls, so a redraw does not move the furniture', () => {
    const { dungeonMap } = buildSubject(4);
    const room = roomOf(dungeonMap, 'child-1');
    expect(resolveRoomGuidePosition(room, 'root', dungeonMap.tileSize)).toEqual(
      resolveRoomGuidePosition(room, 'root', dungeonMap.tileSize),
    );
    expect(resolveRoomDecor(room, 'root', dungeonMap.tileSize)).toEqual(
      resolveRoomDecor(room, 'root', dungeonMap.tileSize),
    );
  });

  it('places at most three decor pieces, and never in the reserved bottom-right', () => {
    const { dungeonMap } = buildSubject(12);
    for (const room of dungeonMap.rooms) {
      const placements = resolveRoomDecor(room, 'root', dungeonMap.tileSize);
      expect(placements.length).toBeLessThanOrEqual(3);
      for (const placement of placements) {
        // Normalised to the room's own size, as the corner fractions are defined.
        const ax = (placement.x / dungeonMap.tileSize - room.gridX) / room.width;
        const ay = (placement.y / dungeonMap.tileSize - room.gridY) / room.height;
        // Only the three authored corners are ever used, so a placement at any other
        // fraction means the seed drifted from the Phaser scene's table.
        expect(
          [
            [0.18, 0.22],
            [0.82, 0.22],
            [0.18, 0.6],
          ].some(([cx, cy]) => Math.abs(ax - cx) < 0.01 && Math.abs(ay - cy) < 0.01),
          `${room.roomId} decor at ${ax.toFixed(3)},${ay.toFixed(3)}`,
        ).toBe(true);
      }
    }
  });

  it('decor differs by floor, so two floors of one subject do not look identical', () => {
    const { dungeonMap } = buildSubject(12);
    const room = roomOf(dungeonMap, 'child-2');
    const onRoot = JSON.stringify(resolveRoomDecor(room, 'root', dungeonMap.tileSize));
    const onChild = JSON.stringify(resolveRoomDecor(room, 'child-2', dungeonMap.tileSize));
    expect(onRoot).not.toBe(onChild);
  });
});

describe('the facing rule prefers vertical over horizontal', () => {
  it('matches the Phaser scene precedence', () => {
    expect(normalizeFacing(0, -1, 'down')).toBe('up');
    expect(normalizeFacing(0, 1, 'up')).toBe('down');
    expect(normalizeFacing(-1, 0, 'down')).toBe('left');
    expect(normalizeFacing(1, 0, 'down')).toBe('right');
    // Up and right at once points up, which is what the Phaser scene's if/else chain does.
    expect(normalizeFacing(1, -1, 'down')).toBe('up');
    expect(normalizeFacing(1, 1, 'up')).toBe('down');
    // Inside the dead zone the previous facing is kept rather than flickering.
    expect(normalizeFacing(0.05, 0, 'left')).toBe('left');
    expect(normalizeFacing(0, 0, 'right')).toBe('right');
  });
});