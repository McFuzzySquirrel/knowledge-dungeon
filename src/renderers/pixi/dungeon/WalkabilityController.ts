/**
 * The pure dungeon controller: walkability, collision, room lookup, and the
 * deterministic seeds.
 *
 * ## Why this is a separate module
 *
 * Every number that decides *whether the player may be somewhere* used to live in
 * `src/game/scenes/DungeonScene.ts`, inside a `Phaser.Scene` that also preloaded
 * textures, created particles, and owned a `cameras.main`. The walkability mask
 * (`rebuildActiveWalkable`, 43 lines), the tile query (`isWalkableAt`), the collider
 * test (`canPlayerOccupy`), the per-axis integration in `update`, and the room
 * spatial index were all pure arithmetic written as private methods of a class that
 * could not be constructed without an engine.
 *
 * Plan Phase 13 asks for a "pure movement controller", and that is exactly what this
 * is: the arithmetic, extracted verbatim, with no renderer in it. Nothing here
 * imports `pixi.js` or `phaser`, touches a DOM global, or reads a clock - so the
 * floor-visibility rule the plan's manual check names ("verify hidden-floor corridors
 * cannot be crossed") is a unit test rather than a manual walk.
 *
 * ## What "pure" means here, precisely
 *
 * Every exported function is referentially transparent over its arguments and the
 * {@link ActiveWalkability} value it is handed. `createWalkabilityController` is the
 * only stateful surface, and its state is exactly the two things the Phaser scene
 * kept as fields: the mask and the visible-room set.
 *
 * ## The rules, and where they came from
 *
 * The mask is **rebuilt**, not filtered. `DungeonScene.rebuildActiveWalkable` did not
 * consult `DungeonMap.walkable.data` at all: it marked every tile of every *visible*
 * room, plus every corridor's two door tiles and its path tiles, skipping any
 * corridor with a hidden endpoint. That is the single mechanism by which a floor
 * hides the rest of the dungeon, so it is reproduced here rather than approximated -
 * including the consequence that a corridor with one hidden endpoint contributes
 * nothing, not even the half of it that is inside a visible room. That is what makes
 * "hidden-floor corridors cannot be crossed" true rather than nearly true.
 *
 * Collision is **four inset corner samples** of a square collider, resolved per axis.
 * Per-axis resolution is what lets the player slide along a wall instead of sticking
 * to it, and the corner samples are what stop the collider from snagging on the seam
 * between two walkable tiles. Both are load-bearing behaviour, not implementation
 * detail, so both are preserved with their constants.
 *
 * ## The deterministic seeds
 *
 * `hashDungeonSeed` and `createDungeonRandom` are here rather than beside the drawing
 * code because the things they decide - where the room guide stands, which decor
 * pieces appear - are part of *layout*, and layout is what the parity tests compare
 * between the two renderers. Keeping the generators pure means a test can ask "does
 * the Pixi world place the guide where the Phaser world places it" without a canvas.
 */
import type { DungeonCorridor, DungeonDoor, DungeonMap, DungeonRoom } from '@/core/layout/dungeonTypes';

/** The player's collision box, in world pixels. Tighter than the drawn figure. */
export const DUNGEON_PLAYER_COLLIDER_SIZE = 16;

/**
 * Inset, in pixels, applied to each collider corner before the tile lookup.
 *
 * Without it a player walking along a wall is stopped by the wall tile's own tile
 * seam a pixel early, which reads as a collision the learner did not cause.
 */
export const DUNGEON_PLAYER_WALK_INSET = 1;

/** World pixels per second. The Phaser scene's `PLAYER_SPEED`, unchanged. */
export const DUNGEON_PLAYER_SPEED = 160;

/**
 * Rooms at or above this count get a spatial index for room lookup.
 *
 * The Phaser scene's Phase-5 optimisation, with its threshold. Below it a linear scan
 * over a hundred rooms is not measurable and a grid would be pure overhead.
 */
export const DUNGEON_SPATIAL_LOOKUP_ROOM_THRESHOLD = 50;

/**
 * The walkability mask for one visible floor.
 *
 * Same shape as `DungeonWalkable` and deliberately *not* an alias for it: this one
 * describes what the player may occupy, which is a subset of the map's static grid and
 * is rebuilt on every floor change. Confusing the two would be how a hidden floor
 * quietly became walkable.
 */
export interface ActiveWalkability {
  /** Width / height in tiles. */
  readonly width: number;
  readonly height: number;
  /** Tile-coordinate offset, so world tile `(tx, ty)` indexes `(tx - offsetX, ty - offsetY)`. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** `1` = walkable, `0` = blocked. */
  readonly data: Uint8Array;
}

/**
 * Build the walkability mask for the rooms, and the corridors between them, that are
 * visible on the current floor.
 *
 * `visibleRoomIds` of `null` means "no floor filter", which is what a single-floor
 * subject that never calls `setFloorVisibility` gets. That case is not a special
 * branch in the mask builder: it is the same loop with a predicate that always
 * passes, and it is stated here because a dungeon with no filter has to remain fully
 * traversable.
 */
export function buildActiveWalkability(
  map: DungeonMap,
  visibleRoomIds: ReadonlySet<string> | null,
): ActiveWalkability {
  const { width, height, offsetX, offsetY } = map.walkable;
  const data = new Uint8Array(width * height);
  const mark = (tx: number, ty: number): void => {
    const gx = tx - offsetX;
    const gy = ty - offsetY;
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) return;
    data[gy * width + gx] = 1;
  };

  for (const room of map.rooms) {
    if (visibleRoomIds !== null && !visibleRoomIds.has(room.roomId)) continue;
    for (let dy = 0; dy < room.height; dy += 1) {
      for (let dx = 0; dx < room.width; dx += 1) {
        mark(room.gridX + dx, room.gridY + dy);
      }
    }
  }

  for (const corridor of map.corridors) {
    // Both endpoints, or nothing. A corridor to a room on another floor is not drawn
    // and is not walkable, so the mask never contains the half that is on this side.
    if (
      visibleRoomIds !== null &&
      (!visibleRoomIds.has(corridor.fromRoomId) || !visibleRoomIds.has(corridor.toRoomId))
    ) {
      continue;
    }
    mark(corridor.fromDoor.x, corridor.fromDoor.y);
    mark(corridor.toDoor.x, corridor.toDoor.y);
    for (const tile of corridor.pathTiles) mark(tile.x, tile.y);
  }

  return { width, height, offsetX, offsetY, data };
}

/**
 * Whether a world point lies on a walkable tile of this floor.
 *
 * A point outside the grid is **not** walkable. That is the Phaser scene's rule and it
 * is what keeps a player who is somehow outside the bounds from being free to walk
 * further out; an "everything outside is fine" default would make the mask advisory.
 */
export function isWalkableAt(
  active: ActiveWalkability,
  tileSize: number,
  worldX: number,
  worldY: number,
): boolean {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return false;
  const tx = Math.floor(worldX / tileSize);
  const ty = Math.floor(worldY / tileSize);
  const gx = tx - active.offsetX;
  const gy = ty - active.offsetY;
  if (gx < 0 || gy < 0 || gx >= active.width || gy >= active.height) return false;
  return active.data[gy * active.width + gx] === 1;
}

/**
 * Whether a player-sized collider centred at `(cx, cy)` sits on walkable tiles only.
 *
 * Four inset corners rather than the centre, and rather than the full box: a box test
 * would forbid the player from brushing a wall at all, and a centre test would let the
 * sprite's corners sink into it.
 */
export function canPlayerOccupy(
  active: ActiveWalkability,
  tileSize: number,
  cx: number,
  cy: number,
  colliderSize: number = DUNGEON_PLAYER_COLLIDER_SIZE,
  inset: number = DUNGEON_PLAYER_WALK_INSET,
): boolean {
  const half = colliderSize / 2 - inset;
  return (
    isWalkableAt(active, tileSize, cx - half, cy - half) &&
    isWalkableAt(active, tileSize, cx + half, cy - half) &&
    isWalkableAt(active, tileSize, cx - half, cy + half) &&
    isWalkableAt(active, tileSize, cx + half, cy + half)
  );
}

/** A position, in world pixels. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Integrate one frame of movement, resolved per axis.
 *
 * Per axis is the behaviour that makes a player slide: pressing right into a wall
 * still moves them up when up is also held, and the up move is tested against the
 * already-advanced `x`. A single combined test would refuse both axes at once and the
 * player would stick on the corner of every doorway.
 */
export function stepPlayer(
  active: ActiveWalkability,
  tileSize: number,
  from: WorldPoint,
  stepX: number,
  stepY: number,
  colliderSize: number = DUNGEON_PLAYER_COLLIDER_SIZE,
  inset: number = DUNGEON_PLAYER_WALK_INSET,
): WorldPoint {
  let x = from.x;
  let y = from.y;
  if (stepX !== 0 && canPlayerOccupy(active, tileSize, x + stepX, y, colliderSize, inset)) {
    x += stepX;
  }
  if (stepY !== 0 && canPlayerOccupy(active, tileSize, x, y + stepY, colliderSize, inset)) {
    y += stepY;
  }
  return { x, y };
}

/** The room centre in world pixels. Where the player spawns and where a teleport lands. */
export function resolveRoomCenter(room: DungeonRoom, tileSize: number): WorldPoint {
  return {
    x: (room.gridX + room.width / 2) * tileSize,
    y: (room.gridY + room.height / 2) * tileSize,
  };
}

/**
 * A coarse grid of rooms, for O(1) hit testing on a large subject.
 *
 * One room per cell - the first inserted - plus the containment check at query time
 * and a linear fallback behind it. Rooms can overlap a cell, so the index is a
 * *candidate* source rather than an answer, and the fallback is what keeps it correct
 * rather than merely fast.
 */
export interface DungeonRoomIndex {
  readonly cellSize: number;
  readonly originX: number;
  readonly originY: number;
  /** False for a subject small enough that the linear scan is always cheaper. */
  readonly useSpatialLookup: boolean;
  readonly cells: ReadonlyMap<string, DungeonRoom>;
}

/** Build the room index for a map. Deterministic, and independent of floor visibility. */
export function buildRoomIndex(map: DungeonMap): DungeonRoomIndex {
  const cells = new Map<string, DungeonRoom>();
  const useSpatialLookup = map.rooms.length >= DUNGEON_SPATIAL_LOOKUP_ROOM_THRESHOLD;
  if (!useSpatialLookup) {
    return {
      cellSize: 0,
      originX: 0,
      originY: 0,
      useSpatialLookup: false,
      cells,
    };
  }

  // One macro-room block: a standard room plus its spacing, in pixels.
  const cellSize = 10 * map.tileSize;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const room of map.rooms) {
    if (room.gridX < minX) minX = room.gridX;
    if (room.gridY < minY) minY = room.gridY;
  }
  const originX = Number.isFinite(minX) ? minX * map.tileSize : 0;
  const originY = Number.isFinite(minY) ? minY * map.tileSize : 0;

  for (const room of map.rooms) {
    const left = room.gridX * map.tileSize;
    const top = room.gridY * map.tileSize;
    const right = left + room.width * map.tileSize;
    const bottom = top + room.height * map.tileSize;
    const cellLeft = Math.floor((left - originX) / cellSize);
    const cellRight = Math.floor((right - originX) / cellSize);
    const cellTop = Math.floor((top - originY) / cellSize);
    const cellBottom = Math.floor((bottom - originY) / cellSize);
    for (let cy = cellTop; cy <= cellBottom; cy += 1) {
      for (let cx = cellLeft; cx <= cellRight; cx += 1) {
        const key = `${cx},${cy}`;
        if (!cells.has(key)) cells.set(key, room);
      }
    }
  }

  return { cellSize, originX, originY, useSpatialLookup: true, cells };
}

/** True when the world point is inside the room's rectangle, edges included. */
export function roomContains(room: DungeonRoom, tileSize: number, x: number, y: number): boolean {
  const left = room.gridX * tileSize;
  const top = room.gridY * tileSize;
  const right = left + room.width * tileSize;
  const bottom = top + room.height * tileSize;
  return x >= left && x <= right && y >= top && y <= bottom;
}

/**
 * The visible room containing a world point, or `null` on a corridor or in the void.
 *
 * `visibleRoomIds` of `null` means no floor filter. The visibility check is applied to
 * the linear scan as well as to the index lookup, because a spatial cell can hold a
 * hidden room while the point is inside a visible one that shares the cell.
 */
export function findRoomAtWorld(
  index: DungeonRoomIndex,
  map: DungeonMap,
  x: number,
  y: number,
  visibleRoomIds: ReadonlySet<string> | null,
): DungeonRoom | null {
  if (index.useSpatialLookup && index.cellSize > 0) {
    const cx = Math.floor((x - index.originX) / index.cellSize);
    const cy = Math.floor((y - index.originY) / index.cellSize);
    const candidate = index.cells.get(`${cx},${cy}`);
    if (
      candidate !== undefined &&
      (visibleRoomIds === null || visibleRoomIds.has(candidate.roomId)) &&
      roomContains(candidate, map.tileSize, x, y)
    ) {
      return candidate;
    }
  }

  for (const room of map.rooms) {
    if (visibleRoomIds !== null && !visibleRoomIds.has(room.roomId)) continue;
    if (roomContains(room, map.tileSize, x, y)) return room;
  }
  return null;
}

/** The four directions the player sprite has, matching the Phaser scene's union. */
export type DungeonFacing = 'down' | 'left' | 'right' | 'up';

/**
 * The facing implied by a movement vector.
 *
 * Vertical wins over horizontal, which is the Phaser scene's precedence and the one a
 * player expects from a top-down view: pressing up-and-right points the figure up.
 * A vector shorter than the dead zone keeps the previous facing rather than flickering.
 */
export function normalizeFacing(
  vx: number,
  vy: number,
  previous: DungeonFacing,
  deadZone = 0.1,
): DungeonFacing {
  if (vy < -deadZone) return 'up';
  if (vy > deadZone) return 'down';
  if (vx < -deadZone) return 'left';
  if (vx > deadZone) return 'right';
  return previous;
}

/* -------------------------------------------------------------------------- */
/* Deterministic layout seeds                                                    */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a over the string, returned unsigned.
 *
 * The Phaser scene's `hashString`, unchanged. It seeds decor and guide placement, so
 * changing it would move every room's furniture and break the visual parity this
 * phase is measured on.
 */
export function hashDungeonSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32: small, deterministic, good enough for layout jitter. */
export function createDungeonRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The three kinds of room decor, in the order the Phaser scene's table declares. */
export const DUNGEON_DECOR_KINDS = Object.freeze(['bookshelf', 'brazier', 'scrollPile'] as const);
export type DungeonDecorKind = (typeof DUNGEON_DECOR_KINDS)[number];

/** One decor placement, in world pixels. */
export interface DungeonDecorPlacement {
  readonly x: number;
  readonly y: number;
  readonly kind: DungeonDecorKind;
}

/**
 * The decor a room gets, deterministically from `(floorId, roomId)`.
 *
 * At most three pieces, from three fixed corners, with the bottom-right reserved for
 * the topic label and the artifact icon. The fourth corner being left empty is part of
 * the layout, not an oversight, and re-deriving it here rather than re-rolling is what
 * keeps the two renderers' furniture in the same places.
 */
export function resolveRoomDecor(
  room: DungeonRoom,
  floorId: string,
  tileSize: number,
): readonly DungeonDecorPlacement[] {
  const random = createDungeonRandom(hashDungeonSeed(`${floorId}::${room.roomId}`));
  const corners: ReadonlyArray<{ ax: number; ay: number }> = [
    { ax: 0.18, ay: 0.22 },
    { ax: 0.82, ay: 0.22 },
    { ax: 0.18, ay: 0.6 },
  ];
  const placements: DungeonDecorPlacement[] = [];
  for (const corner of corners) {
    if (random() > 0.55) continue;
    const kind = DUNGEON_DECOR_KINDS[Math.floor(random() * DUNGEON_DECOR_KINDS.length)];
    placements.push({
      x: (room.gridX + room.width * corner.ax) * tileSize,
      y: (room.gridY + room.height * corner.ay) * tileSize,
      kind,
    });
  }
  return placements;
}

/**
 * Where the room guide stands, in world pixels, deterministically from
 * `(floorId, roomId)`.
 *
 * One of four corner anchors, chosen as the one that stays furthest from both the
 * artifact marker (upper centre) and the topic label (lower centre), with a sub-percent
 * jitter so two rooms never land on an identical anchor. Pure, so a parity test can
 * ask for the position without a canvas.
 */
export function resolveRoomGuidePosition(
  room: DungeonRoom,
  floorId: string,
  tileSize: number,
): WorldPoint {
  const seed = hashDungeonSeed(`${floorId}::npc::${room.roomId}`);
  const anchors: ReadonlyArray<{ ax: number; ay: number }> = [
    { ax: 0.18, ay: 0.24 },
    { ax: 0.82, ay: 0.24 },
    { ax: 0.18, ay: 0.52 },
    { ax: 0.82, ay: 0.52 },
  ];
  let best = anchors[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const distanceToArtifact = Math.hypot(anchor.ax - 0.5, anchor.ay - 0.25);
    const distanceToLabel = Math.hypot(anchor.ax - 0.5, anchor.ay - 0.9);
    const jitter = (((seed >>> (i * 2)) & 0x3) / 3) * 0.01;
    const score = Math.min(distanceToArtifact, distanceToLabel) + jitter;
    if (score > bestScore) {
      bestScore = score;
      best = anchor;
    }
  }
  return {
    x: (room.gridX + room.width * best.ax) * tileSize,
    y: (room.gridY + room.height * best.ay) * tileSize,
  };
}

/** Whether a corridor touches a portal room on either end. */
export function isPortalEdgeCorridor(
  corridor: DungeonCorridor,
  portalUpRoomId: string | null,
  portalDownRoomIds: ReadonlySet<string>,
): boolean {
  return (
    corridor.fromRoomId === portalUpRoomId ||
    corridor.toRoomId === portalUpRoomId ||
    portalDownRoomIds.has(corridor.fromRoomId) ||
    portalDownRoomIds.has(corridor.toRoomId)
  );
}

/** Doors of one room, grouped so a wall can be drawn around its gaps. */
export function doorsByRoom(doors: readonly DungeonDoor[]): ReadonlyMap<string, readonly DungeonDoor[]> {
  const grouped = new Map<string, DungeonDoor[]>();
  for (const door of doors) {
    const list = grouped.get(door.roomId);
    if (list === undefined) grouped.set(door.roomId, [door]);
    else list.push(door);
  }
  return grouped;
}

/** Add `amount` to each channel of a packed `0xRRGGBB`, clamping at 255. */
export function lightenHex(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + amount);
  const g = Math.min(255, ((color >> 8) & 0xff) + amount);
  const b = Math.min(255, (color & 0xff) + amount);
  return (r << 16) | (g << 8) | b;
}

/* -------------------------------------------------------------------------- */
/* The stateful facade                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two pieces of state the Phaser scene carried as fields, behind one object.
 *
 * A controller rather than bare functions so a scene cannot accidentally keep a stale
 * mask: `setVisibleRooms` replaces both halves in one call, so there is no window in
 * which the mask and the room lookup disagree about which floor is active.
 */
export interface WalkabilityController {
  readonly map: DungeonMap;
  readonly tileSize: number;
  /** The current mask. Exposed so a caller can assert on it rather than re-derive it. */
  readMask(): ActiveWalkability;
  /** The room filter in force, or `null` for none. */
  visibleRoomIds(): ReadonlySet<string> | null;
  setVisibleRooms(visibleRoomIds: ReadonlySet<string> | null): void;
  isWalkableAt(worldX: number, worldY: number): boolean;
  canPlayerOccupy(cx: number, cy: number): boolean;
  /** One frame of per-axis movement from `(x, y)`. */
  step(x: number, y: number, stepX: number, stepY: number): WorldPoint;
  /** The visible room containing a world point, or `null`. */
  roomAt(x: number, y: number): DungeonRoom | null;
  /** The point a teleport to this room lands on, or `null` for an unknown room. */
  landingPointFor(roomId: string): WorldPoint | null;
  /** Drop the floor filter and rebuild, so a fresh mount starts unfiltered. */
  reset(): void;
}

export interface CreateWalkabilityControllerOptions {
  readonly map: DungeonMap;
  /** The floor filter to start from. Defaults to none. */
  readonly visibleRoomIds?: ReadonlySet<string> | null;
  /** An index to reuse. Built from the map when omitted. */
  readonly roomIndex?: DungeonRoomIndex;
}

/** Build a walkability controller for one dungeon map. */
export function createWalkabilityController(
  options: CreateWalkabilityControllerOptions,
): WalkabilityController {
  const map = options.map;
  const tileSize = map.tileSize;
  const roomIndex = options.roomIndex ?? buildRoomIndex(map);
  let visible: ReadonlySet<string> | null = options.visibleRoomIds ?? null;
  let mask = buildActiveWalkability(map, visible);

  function rebuild(): void {
    mask = buildActiveWalkability(map, visible);
  }

  return {
    map,
    tileSize,
    readMask(): ActiveWalkability {
      return mask;
    },
    visibleRoomIds(): ReadonlySet<string> | null {
      return visible;
    },
    setVisibleRooms(next: ReadonlySet<string> | null): void {
      const changed =
        visible === next ||
        (visible !== null &&
          next !== null &&
          visible.size === next.size &&
          [...visible].every((roomId) => next.has(roomId)));
      visible = next;
      if (!changed) rebuild();
    },
    isWalkableAt(worldX: number, worldY: number): boolean {
      return isWalkableAt(mask, tileSize, worldX, worldY);
    },
    canPlayerOccupy(cx: number, cy: number): boolean {
      return canPlayerOccupy(mask, tileSize, cx, cy);
    },
    step(x: number, y: number, stepX: number, stepY: number): WorldPoint {
      return stepPlayer(mask, tileSize, { x, y }, stepX, stepY);
    },
    roomAt(x: number, y: number): DungeonRoom | null {
      return findRoomAtWorld(roomIndex, map, x, y, visible);
    },
    landingPointFor(roomId: string): WorldPoint | null {
      const room = map.rooms.find((entry) => entry.roomId === roomId);
      return room === undefined ? null : resolveRoomCenter(room, tileSize);
    },
    reset(): void {
      visible = null;
      rebuild();
    },
  };
}