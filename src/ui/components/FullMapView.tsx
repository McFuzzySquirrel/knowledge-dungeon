/**
 * FullMapView
 * A modal overlay that renders the entire dungeon mindmap with mouse / touch
 * pan + wheel zoom. Useful when the gameplay camera is zoomed in close and
 * the user wants to inspect the broader topic graph without leaving the
 * dungeon.
 */
import { useCallback, useRef, useState, type JSX, type PointerEvent, type WheelEvent } from 'react';
import type { DungeonMap } from '@/game/systems/dungeonTypes';

interface FullMapViewProps {
  dungeonMap: DungeonMap;
  focusedRoomId: string | null;
  onClose: () => void;
}

const SCALE = 6;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.0015;

export function FullMapView({
  dungeonMap,
  focusedRoomId,
  onClose,
}: FullMapViewProps): JSX.Element {
  const { bounds, rooms, corridors } = dungeonMap;
  const innerWidth = (bounds.maxX - bounds.minX) * SCALE;
  const innerHeight = (bounds.maxY - bounds.minY) * SCALE;

  const [zoom, setZoom] = useState(1);
  // Start with the map centered in the viewport: shifting by -inner/2 places
  // the SVG's center at the (top:50% left:50%) transform origin.
  const [pan, setPan] = useState({ x: -innerWidth / 2, y: -innerHeight / 2 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  // Find neighbors of the focused room so we can highlight directly
  // connected child topics in the full map too.
  const neighborIds = new Set<string>();
  if (focusedRoomId) {
    for (const c of corridors) {
      if (c.fromRoomId === focusedRoomId) neighborIds.add(c.toRoomId);
      else if (c.toRoomId === focusedRoomId) neighborIds.add(c.fromRoomId);
    }
  }

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    setZoom((z) => {
      const next = z * (1 - e.deltaY * ZOOM_STEP);
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    });
  }, []);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  }, [pan.x, pan.y]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPan({
      x: drag.panX + (e.clientX - drag.startX),
      y: drag.panY + (e.clientY - drag.startY),
    });
  }, []);

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: -innerWidth / 2, y: -innerHeight / 2 });
  }, [innerWidth, innerHeight]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Full map view">
      <div className="full-map">
        <div className="full-map-header">
          <h2>Full Map</h2>
          <div className="full-map-actions">
            <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2))}>
              +
            </button>
            <button type="button" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.2))}>
              −
            </button>
            <button type="button" onClick={resetView}>
              Reset
            </button>
            <button type="button" onClick={onClose} aria-label="Close full map">
              Close
            </button>
          </div>
        </div>
        <div
          className="full-map-viewport"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            className="full-map-canvas"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              width: innerWidth,
              height: innerHeight,
            }}
          >
            <svg width={innerWidth} height={innerHeight} viewBox={`0 0 ${innerWidth} ${innerHeight}`}>
              {corridors.map((c, i) => {
                const from = rooms.find((r) => r.roomId === c.fromRoomId);
                const to = rooms.find((r) => r.roomId === c.toRoomId);
                if (!from || !to) return null;
                const x1 = (from.gridX - bounds.minX + from.width / 2) * SCALE;
                const y1 = (from.gridY - bounds.minY + from.height / 2) * SCALE;
                const x2 = (to.gridX - bounds.minX + to.width / 2) * SCALE;
                const y2 = (to.gridY - bounds.minY + to.height / 2) * SCALE;
                const isConnected =
                  focusedRoomId !== null &&
                  (c.fromRoomId === focusedRoomId || c.toRoomId === focusedRoomId);
                return (
                  <line
                    key={i}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={isConnected ? '#f2c879' : '#3b455e'}
                    strokeWidth={isConnected ? 3 : 2}
                  />
                );
              })}
              {rooms.map((room) => {
                const x = (room.gridX - bounds.minX) * SCALE;
                const y = (room.gridY - bounds.minY) * SCALE;
                const w = room.width * SCALE;
                const h = room.height * SCALE;
                const isFocused = room.roomId === focusedRoomId;
                const isNeighbor = neighborIds.has(room.roomId);
                const fill = isFocused
                  ? '#f2c879'
                  : isNeighbor
                    ? '#f7d99c'
                    : room.isRoot
                      ? '#7fb2ff'
                      : '#1f2433';
                return (
                  <g key={room.roomId}>
                    <rect
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      fill={fill}
                      stroke={isFocused || isNeighbor ? '#f2c879' : '#a8b0c8'}
                      strokeWidth={isFocused ? 2 : isNeighbor ? 1.5 : 1}
                      rx={2}
                    />
                    <text
                      x={x + w / 2}
                      y={y + h / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={10}
                      fill={isFocused || isNeighbor ? '#14171e' : '#f5f7ff'}
                    >
                      {room.topic.length > 18 ? `${room.topic.slice(0, 17)}…` : room.topic}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
        <p className="full-map-hint">
          Drag to pan · scroll to zoom · highlighted rooms are directly connected to the
          currently focused room.
        </p>
      </div>
    </div>
  );
}
