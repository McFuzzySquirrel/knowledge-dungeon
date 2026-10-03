/**
 * The dungeon corridor layer: the paths between rooms and the doors at their ends.
 *
 * ## Why a module rather than a function in the scene
 *
 * The Phaser scene kept its corridor drawing inside `drawCorridors`, which did four
 * jobs at once: stroke each axis-aligned segment so a corridor still reads before its
 * tiles load, tile the path, place a door sprite at each endpoint, and skip every
 * corridor with a hidden endpoint. Two of those are drawing and two are *visibility*,
 * and only one of them is the renderer's business. Splitting the layer out lets the
 * visibility rule be asserted against a labelled container in a test, and lets the
 * scene re-apply it on a floor change without rebuilding the room nodes around it.
 *
 * ## What is deliberately not here
 *
 * Walkability. A corridor is walkable because both its endpoints are visible, and that
 * decision belongs to `WalkabilityController`, which computes it from the map rather
 * than from anything drawn. If this module also decided it, a drawing change could
 * silently move a wall, so it holds no mask and answers no collision query.
 *
 * ## The doors
 *
 * A door sits on the room's perimeter at the tile the corridor names, and is drawn
 * rotated a quarter turn on the east and west walls so its hinge axis follows the wall
 * it punches through. Each one is its own labelled child, so a test can ask "is the
 * door between these two rooms drawn" by label rather than by counting geometry.
 *
 * The art is procedural (`Graphics` only). The dungeon sprite set under
 * `public/assets/` is `legacy-unverified`, so the CC0 gate admits none of it to a Pixi
 * bundle, exactly as for the village.
 */
import { Container, Graphics } from 'pixi.js';

import type { DungeonDoor, DungeonMap, DoorSide } from '@/core/layout/dungeonTypes';
import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { isPortalEdgeCorridor, lightenHex } from './WalkabilityController';

/** Stroke weight of a corridor path, in world pixels. */
const CORRIDOR_STROKE = 5;

/** A door's drawn size, in world pixels, before the quarter-turn rotation. */
const DOOR_SIZE = 22;

/** Everything the layer needs, all of it known before the first draw. */
export interface CorridorLayerOptions {
  readonly map: DungeonMap;
  /** Element the corridors are drawn into. Usually the camera layer's world child. */
  readonly parent: Container;
  readonly theme: CozyWorldTheme;
  /** The floor's corridor colour, before any portal lightening. */
  readonly corridorColor: number;
}

/**
 * A corridor layer that can be re-applied to a new floor.
 *
 * `apply` is a full redraw rather than a diff. A floor change is rare and a redraw
 * makes "nothing from the previous floor is still on screen" a property of the code
 * rather than of a bookkeeping exercise; per-frame work happens in the scene, not here.
 */
export interface CorridorLayer {
  readonly container: Container;
  /**
   * Redraw every corridor whose *both* endpoints are visible.
   *
   * A one-sided corridor is skipped whole, which is the drawing half of the rule the
   * walkability mask enforces as the movement half. The portal rooms are passed in
   * separately because a corridor *to* a portal is drawn lighter than one between two
   * ordinary rooms, which is how a learner finds the stairs before walking to them.
   */
  apply(
    visibleRoomIds: ReadonlySet<string> | null,
    portalUpRoomId: string | null,
    portalDownRoomIds: ReadonlySet<string>,
  ): void;
  destroy(): void;
}

/** The label a corridor's door for `door` is drawn under, for tests and debugging. */
export function corridorDoorLabel(door: DungeonDoor): string {
  return `dungeon-door-${door.roomId}-${door.side}`;
}

/** Build a corridor layer and draw the current floor into it. */
export function createCorridorLayer(options: CorridorLayerOptions): CorridorLayer {
  const { map, parent, theme } = options;
  const tileSize = map.tileSize;

  const container = new Container();
  container.label = 'dungeon-corridors';
  parent.addChild(container);

  function drawPath(
    graphics: Graphics,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    color: number,
    alpha: number,
  ): void {
    graphics.moveTo(fromX, fromY).lineTo(toX, toY);
    graphics.stroke({ width: CORRIDOR_STROKE, color, alpha, cap: 'round' });
  }

  function drawDoor(door: DungeonDoor, isPortalEdge: boolean): Graphics {
    const graphics = new Graphics();
    graphics.label = corridorDoorLabel(door);
    graphics.position.set((door.x + 0.5) * tileSize, (door.y + 0.5) * tileSize);
    const width = DOOR_SIZE * 0.5;
    const height = DOOR_SIZE * 0.8;
    const frame = theme.color.borderStrong;
    graphics.roundRect(-width / 2, -height / 2, width, height, theme.radius.sm);
    graphics.fill({ color: theme.color.surfacePanel, alpha: isPortalEdge ? 0.8 : 1 });
    graphics.stroke({
      width: theme.border.state,
      color: isPortalEdge ? theme.color.accent : frame,
      alpha: isPortalEdge ? 0.9 : 1,
    });
    // A centre seam, so an upright door and a rotated one are distinguishable
    // without relying on the orientation alone.
    graphics
      .moveTo(0, -height / 2)
      .lineTo(0, height / 2)
      .stroke({ width: theme.border.hairline, color: frame, alpha: 0.8 });
    if (door.side === 'E' || door.side === 'W') graphics.rotation = Math.PI / 2;
    return graphics;
  }

  function apply(
    visibleRoomIds: ReadonlySet<string> | null,
    portalUpRoomId: string | null,
    portalDownRoomIds: ReadonlySet<string>,
  ): void {
    container.removeChildren().forEach((child) => child.destroy());
    if (visibleRoomIds !== null && visibleRoomIds.size === 0) return;

    const baseColor = options.corridorColor;
    const portalColor = lightenHex(baseColor, 40);

    for (const corridor of map.corridors) {
      if (
        visibleRoomIds !== null &&
        (!visibleRoomIds.has(corridor.fromRoomId) || !visibleRoomIds.has(corridor.toRoomId))
      ) {
        continue;
      }
      const isPortalEdge = isPortalEdgeCorridor(corridor, portalUpRoomId, portalDownRoomIds);
      const strokeColor = isPortalEdge ? portalColor : baseColor;
      const alpha = isPortalEdge ? 0.55 : 0.75;

      const path = new Graphics();
      for (const segment of corridor.segments) {
        drawPath(
          path,
          (segment.x1 + 0.5) * tileSize,
          (segment.y1 + 0.5) * tileSize,
          (segment.x2 + 0.5) * tileSize,
          (segment.y2 + 0.5) * tileSize,
          strokeColor,
          alpha,
        );
      }
      if (corridor.elbow !== null) {
        const cx = (corridor.elbow.x + 0.5) * tileSize;
        const cy = (corridor.elbow.y + 0.5) * tileSize;
        const radius = tileSize * 0.45;
        path.circle(cx, cy, radius);
        path.fill({ color: strokeColor, alpha });
      }
      container.addChild(path);

      container.addChild(drawDoor(corridor.fromDoor, isPortalEdge));
      container.addChild(drawDoor(corridor.toDoor, isPortalEdge));
    }
  }

  return {
    container,
    apply,
    destroy(): void {
      container.removeChildren().forEach((child) => child.destroy());
      container.destroy();
    },
  };
}

/**
 * The wall segments of one room, with a gap wherever a door punches through.
 *
 * Exported because it is pure geometry over pure data - the room, its doors, and a
 * tile size - and therefore the one part of the wall drawing a test can check without
 * a canvas. Returned in draw order: north, south, west, east.
 */
export function roomWallSegments(
  room: { gridX: number; gridY: number; width: number; height: number },
  roomDoors: readonly DungeonDoor[],
  tileSize: number,
): ReadonlyArray<{ x1: number; y1: number; x2: number; y2: number }> {
  const left = room.gridX * tileSize;
  const top = room.gridY * tileSize;
  const right = (room.gridX + room.width) * tileSize;
  const bottom = (room.gridY + room.height) * tileSize;
  const bySide: Record<DoorSide, number[]> = { N: [], S: [], W: [], E: [] };
  for (const door of roomDoors) bySide[door.side].push(door.side === 'N' || door.side === 'S' ? door.x - room.gridX : door.y - room.gridY);

  const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const horizontal = (y: number, side: DoorSide): void => {
    const gaps = [...bySide[side]].sort((a, b) => a - b);
    let start = 0;
    for (const gap of gaps) {
      if (gap > start) {
        segments.push({ x1: left + start * tileSize, y1: y, x2: left + gap * tileSize, y2: y });
      }
      start = gap + 1;
    }
    if (start < room.width) {
      segments.push({ x1: left + start * tileSize, y1: y, x2: right, y2: y });
    }
  };
  const vertical = (x: number, side: DoorSide): void => {
    const gaps = [...bySide[side]].sort((a, b) => a - b);
    let start = 0;
    for (const gap of gaps) {
      if (gap > start) {
        segments.push({ x1: x, y1: top + start * tileSize, x2: x, y2: top + gap * tileSize });
      }
      start = gap + 1;
    }
    if (start < room.height) {
      segments.push({ x1: x, y1: top + start * tileSize, x2: x, y2: bottom });
    }
  };

  horizontal(top, 'N');
  horizontal(bottom, 'S');
  vertical(left, 'W');
  vertical(right, 'E');
  return segments;
}