/**
 * A deterministic layout for the DOM graph.
 *
 * ## Why this is computed rather than dragged on first sight
 *
 * The map's node positions are presentation, and presentation needs a *starting* position
 * that does not depend on when the learner looked at it. This module therefore derives
 * positions from the graph alone - floors stacked in hierarchy order, rooms laid out in
 * topic order inside each floor - and the workspace applies any learner nudges on top as
 * local offsets. Nothing here reads or writes storage, and nothing here is a mutation:
 * it is geometry.
 *
 * ## Determinism is the property worth testing
 *
 * The same snapshot always produces the same rectangle for the same room, so a test can
 * assert a position and a learner's drag is the only thing that can change it. That is
 * what lets `tests/phase14/creator-graph-map.test.tsx` prove the offsets are local: the
 * generated rectangle is still derivable after a drag, and no dispatch happened.
 */
import { deriveGraphHierarchy } from '@/core/graph';
import type { SubjectSnapshot } from '@/core/validation/persistence';

/** Node geometry, in CSS pixels inside the SVG's user space. */
export const GRAPH_NODE_WIDTH = 168;
export const GRAPH_NODE_HEIGHT = 76;
export const GRAPH_COLUMN_GAP = 40;
export const GRAPH_ROW_GAP = 40;
export const GRAPH_FLOOR_GAP = 56;
export const GRAPH_PADDING = 24;
/** Rooms per row inside one floor. Three keeps a floor block readable at 320px wide. */
export const GRAPH_COLUMNS = 3;

export interface GraphNodeBox {
  readonly roomId: string;
  readonly topic: string;
  readonly floorId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphEdgeLine {
  readonly key: string;
  readonly fromRoomId: string;
  readonly toRoomId: string;
  readonly relationType: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** `true` for a cross-link, so the dash pattern is a second channel not the only one. */
  readonly isCrossLink: boolean;
}

export interface GraphLayout {
  readonly nodes: readonly GraphNodeBox[];
  readonly byRoomId: ReadonlyMap<string, GraphNodeBox>;
  readonly edges: readonly GraphEdgeLine[];
  readonly width: number;
  readonly height: number;
}

/**
 * Lay the graph out.
 *
 * `edges` includes every edge whose endpoints are both in the layout, which is all of
 * them: the layout covers every room in the dungeon, so no edge is dropped.
 */
export function layoutSubjectGraph(snapshot: SubjectSnapshot): GraphLayout {
  const { dungeon } = snapshot;
  const hierarchy = deriveGraphHierarchy(dungeon);
  const nodes: GraphNodeBox[] = [];
  const byRoomId = new Map<string, GraphNodeBox>();
  let floorTop = GRAPH_PADDING;
  let widest = GRAPH_NODE_WIDTH;

  for (const floorId of hierarchy.floorIds) {
    const roomIds = hierarchy.roomIdsByFloorId[floorId] ?? [];
    const rows = Math.max(1, Math.ceil(roomIds.length / GRAPH_COLUMNS));
    roomIds.forEach((roomId, index) => {
      const column = index % GRAPH_COLUMNS;
      const row = Math.floor(index / GRAPH_COLUMNS);
      const box: GraphNodeBox = {
        roomId,
        topic: snapshot.rooms[roomId]?.topic ?? roomId,
        floorId,
        x: GRAPH_PADDING + column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
        y: floorTop + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
      };
      nodes.push(box);
      byRoomId.set(roomId, box);
      widest = Math.max(widest, box.x + GRAPH_NODE_WIDTH);
    });
    floorTop += rows * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP) + GRAPH_FLOOR_GAP;
  }

  const centreOf = (roomId: string): { x: number; y: number } => {
    const box = byRoomId.get(roomId);
    return box === undefined
      ? { x: GRAPH_PADDING, y: GRAPH_PADDING }
      : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  const edges: GraphEdgeLine[] = dungeon.edges.flatMap((edge) => {
    const from = byRoomId.get(edge.fromRoomId);
    const to = byRoomId.get(edge.toRoomId);
    if (from === undefined || to === undefined) return [];
    const start = centreOf(edge.fromRoomId);
    const end = centreOf(edge.toRoomId);
    return [
      {
        key: `${edge.fromRoomId}->${edge.toRoomId}:${edge.relationType}:${edge.createdAt}`,
        fromRoomId: edge.fromRoomId,
        toRoomId: edge.toRoomId,
        relationType: edge.relationType,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        isCrossLink: edge.relationType !== 'subtopic',
      },
    ];
  });

  const height = Math.max(
    GRAPH_PADDING * 2 + GRAPH_NODE_HEIGHT,
    floorTop - GRAPH_ROW_GAP,
  );

  return {
    nodes,
    byRoomId,
    edges,
    width: widest + GRAPH_PADDING,
    height,
  };
}
