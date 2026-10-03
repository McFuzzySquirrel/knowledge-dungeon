/**
 * The DOM graph view: SVG, DOM, and React state, and nothing else.
 *
 * ## What this surface is for
 *
 * Phase 13's dungeon is presentation. Phase 14's exit criterion is that a learner can
 * "create, link, reparent, tag, move, and delete rooms using keyboard or touch", and
 * "move" is the one verb that has no durable meaning: there is no command for it, and
 * there must not be one. So this view separates the two things the pre-Phase-14 map
 * conflated:
 *
 * - **Structure** - which rooms exist and how they are joined. Read from the snapshot.
 * - **Position** - where a box is drawn. Local React state, in `nodeOffsets`, and gone on
 *   unmount.
 *
 * The offsets are never dispatched, never written to the store, never put in a URL or in
 * an attribute. `tests/phase14/creator-graph-map.test.tsx` asserts that after a keyboard
 * nudge *and* a pointer drag, the store's snapshot is byte-identical and no commit
 * happened.
 *
 * ## Every route to every verb, without a pointer
 *
 * - **Selection** - every node is a focusable `role="button"`; the topic list above it
 *   repeats the same selection as ordinary buttons, which is the route that scales to a
 *   hundred rooms.
 * - **Move** - Arrow keys nudge the focused node, and four on-screen buttons nudge the
 *   selected node for a learner who cannot or does not want to use the keyboard. Both
 *   write the same local offsets.
 * - **Reset** - one button returns every node to its generated position.
 *
 * ## Keyboard notes
 *
 * Arrow keys move a node rather than moving focus, so this surface is a *composite*: the
 * only way to change focus is Tab, which visits every node, plus Escape and the sibling
 * controls. That is a deliberate trade: a roving-tabindex list where arrows navigate
 * would have had to borrow another key for the move verb, and "move" is the verb this
 * view exists to serve. The hint under the graph says so in words, and the four nudge
 * buttons make the same operation available without either keyboard or dragging.
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { SubjectSnapshot } from '@/core/validation/persistence';

import { StudyActionButton } from '../StudyControls';
import { layoutSubjectGraph, type GraphNodeBox } from './graphLayout';

export interface NodeOffset {
  readonly x: number;
  readonly y: number;
}

/** One arrow-key nudge, in user-space pixels. */
export const GRAPH_NUDGE_PX = 12;
/** A `Shift` + arrow nudge: four steps, for coarse movement without a pointer. */
export const GRAPH_NUDGE_LARGE_PX = 48;

export interface GraphMapProps {
  readonly snapshot: SubjectSnapshot;
  /** The room the workspace is working on. */
  readonly selectedRoomId: string;
  readonly onSelectRoom: (roomId: string) => void;
  /** Presentational counts for the summary line. */
  readonly summary: {
    readonly roomCount: number;
    readonly childEdgeCount: number;
    readonly crossLinkCount: number;
    readonly floorCount: number;
  };
}

interface DragState {
  readonly pointerId: number;
  readonly roomId: string;
  readonly startX: number;
  readonly startY: number;
  readonly originX: number;
  readonly originY: number;
}

function isArrow(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
}

export function GraphMap({
  snapshot,
  selectedRoomId,
  onSelectRoom,
  summary,
}: GraphMapProps): ReactNode {
  const layout = useMemo(() => layoutSubjectGraph(snapshot), [snapshot]);
  const [nodeOffsets, setNodeOffsets] = useState<Readonly<Record<string, NodeOffset>>>({});
  const dragRef = useRef<DragState | null>(null);
  const movedRoomCount = Object.keys(nodeOffsets).length;

  const positionOf = useCallback(
    (box: GraphNodeBox): NodeOffset => nodeOffsets[box.roomId] ?? { x: 0, y: 0 },
    [nodeOffsets],
  );

  /**
   * Move a node by a delta, in local state only.
   *
   * The single writer for offsets: keyboard nudges, the nudge buttons, and a pointer drag
   * all come through here, so there is one place where "this is presentation" can be read.
   */
  const nudge = useCallback((roomId: string, dx: number, dy: number): void => {
    setNodeOffsets((current) => {
      const existing = current[roomId] ?? { x: 0, y: 0 };
      return { ...current, [roomId]: { x: existing.x + dx, y: existing.y + dy } };
    });
  }, []);

  const resetPositions = useCallback((): void => {
    setNodeOffsets({});
  }, []);

  const onNodeKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>, roomId: string): void => {
      if (isArrow(event.key)) {
        const step = event.shiftKey ? GRAPH_NUDGE_LARGE_PX : GRAPH_NUDGE_PX;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        // The page must not scroll while a learner is nudging a node.
        event.preventDefault();
        nudge(roomId, dx, dy);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelectRoom(roomId);
      }
    },
    [nudge, onSelectRoom],
  );

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent<SVGGElement>, roomId: string): void => {
      if (event.button !== 0) return;
      const offset = nodeOffsets[roomId] ?? { x: 0, y: 0 };
      dragRef.current = {
        pointerId: event.pointerId,
        roomId,
        startX: event.clientX,
        startY: event.clientY,
        originX: offset.x,
        originY: offset.y,
      };
      onSelectRoom(roomId);
    },
    [nodeOffsets, onSelectRoom],
  );

  const onSurfacePointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (dx === 0 && dy === 0) return;
    setNodeOffsets((current) => ({
      ...current,
      [drag.roomId]: { x: drag.originX + dx, y: drag.originY + dy },
    }));
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    // The drag ended. The offset it wrote is already in state; nothing is committed,
    // because a moved box is not a change to the subject.
    dragRef.current = null;
  }, []);

  const selectedBox = layout.byRoomId.get(selectedRoomId);

  return (
    <figure className="study-graph" data-study-graph="subject">
      <figcaption className="study-graph__summary">
        <span>{summary.roomCount} topics</span>
        <span>{summary.childEdgeCount} subtopic links</span>
        <span>{summary.crossLinkCount} cross-links</span>
        <span>{summary.floorCount} floors</span>
      </figcaption>

      <div className="study-graph__frame">
        <svg
          className="study-graph__surface"
          role="group"
          aria-label="Subject graph. Each topic is a button; arrow keys move the focused topic box."
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMinYMin meet"
          onPointerMove={onSurfacePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {layout.edges.map((edge) => (
            <line
              key={edge.key}
              className={`study-graph__edge${edge.isCrossLink ? ' study-graph__edge--crosslink' : ''}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
            >
              <title>{`${edge.relationType} link`}</title>
            </line>
          ))}
          {layout.nodes.map((box) => {
            const offset = positionOf(box);
            const isSelected = box.roomId === selectedRoomId;
            const room = snapshot.rooms[box.roomId];
            const needsRevalidation = room?.state === 'NeedsRevalidation';
            const stateWords = [
              isSelected ? 'current topic' : null,
              box.roomId === snapshot.dungeon.rootRoomId ? 'root topic' : null,
              needsRevalidation ? 'needs revalidation' : null,
              room?.tags != null && room.tags.length > 0
                ? `${room.tags.length} tag${room.tags.length === 1 ? '' : 's'}`
                : null,
            ]
              .filter((word): word is string => word !== null)
              .join(', ');

            return (
              <g
                key={box.roomId}
                className={`study-graph__node${isSelected ? ' study-graph__node--selected' : ''}${needsRevalidation === true ? ' study-graph__node--needs-revalidation' : ''}`}
                transform={`translate(${offset.x} ${offset.y})`}
                role="button"
                tabIndex={0}
                aria-current={isSelected ? 'true' : undefined}
                aria-label={`${box.topic}${stateWords === '' ? '' : `, ${stateWords}`}`}
                data-study-graph-node="topic"
                onKeyDown={(event) => onNodeKeyDown(event, box.roomId)}
                onPointerDown={(event) => onNodePointerDown(event, box.roomId)}
              >
                <title>{box.topic}</title>
                <rect
                  className="study-graph__node-surface"
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  rx={10}
                />
                <text
                  className="study-graph__node-label"
                  x={box.x + box.width / 2}
                  y={box.y + 30}
                  textAnchor="middle"
                >
                  {box.topic}
                </text>
                {/*
                  The node's own state, in words on the node. A dashed border and a
                  different fill would be colour and shape only, and a screen reader reads
                  neither.
                */}
                <text
                  className="study-graph__node-note"
                  x={box.x + box.width / 2}
                  y={box.y + 52}
                  textAnchor="middle"
                >
                  {isSelected ? 'Current topic' : needsRevalidation === true ? 'Needs revalidation' : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div
        className="study-graph__controls"
        role="group"
        aria-label="Move the selected topic box"
      >
        <StudyActionButton
          label="Move box left"
          touchTarget="graph-move-left"
          onClick={() => nudge(selectedRoomId, -GRAPH_NUDGE_PX, 0)}
          refusal={
            selectedBox === undefined ? 'Select a topic on the graph first.' : null
          }
          description="Moves the selected box on screen only."
        />
        <StudyActionButton
          label="Move box right"
          touchTarget="graph-move-right"
          onClick={() => nudge(selectedRoomId, GRAPH_NUDGE_PX, 0)}
          refusal={
            selectedBox === undefined ? 'Select a topic on the graph first.' : null
          }
          description="Moves the selected box on screen only."
        />
        <StudyActionButton
          label="Move box up"
          touchTarget="graph-move-up"
          onClick={() => nudge(selectedRoomId, 0, -GRAPH_NUDGE_PX)}
          refusal={
            selectedBox === undefined ? 'Select a topic on the graph first.' : null
          }
          description="Moves the selected box on screen only."
        />
        <StudyActionButton
          label="Move box down"
          touchTarget="graph-move-down"
          onClick={() => nudge(selectedRoomId, 0, GRAPH_NUDGE_PX)}
          refusal={
            selectedBox === undefined ? 'Select a topic on the graph first.' : null
          }
          description="Moves the selected box on screen only."
        />
        <StudyActionButton
          label="Reset box positions"
          touchTarget="graph-reset-positions"
          onClick={resetPositions}
          description="Puts every moved box back where the map draws it."
        />
      </div>

      {selectedBox === undefined ? null : (
        <p className="study-graph__hint">
          {movedRoomCount === 0
            ? 'Topic boxes can be moved on screen only: positions are not saved and do not change the subject.'
            : `${movedRoomCount} topic box${movedRoomCount === 1 ? ' has' : 'es have'} been moved on screen. Positions are not saved and are not part of the subject.`}
        </p>
      )}
      <p className="study-graph__hint">
        Keyboard: Tab reaches every topic box, the arrow keys move the focused box, Shift and an
        arrow key move it further, Enter selects it.
      </p>
    </figure>
  );
}
