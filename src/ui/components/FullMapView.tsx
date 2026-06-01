import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type JSX,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import {
  deriveGraphHierarchy,
  getConnectedRoomIds,
  isReachableViaSubtopics,
} from '@/core/graph';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import type { DungeonMap } from '@/game/systems/dungeonTypes';
import type { GamePhase } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { parseTopicBatch } from '@/ui/utils/topicParsing';

interface FullMapViewProps {
  snapshot: SubjectSnapshot;
  dungeonMap: DungeonMap;
  focusedRoomId: string | null;
  phase: GamePhase;
  teleportModeArmed: boolean;
  teleportRemainingMs: number;
  onTravelToRoom: (roomId: string) => void;
  onTeleportToRoom: (roomId: string) => void;
  onClose: () => void;
}

const SCALE = 10;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.0015;
const CANVAS_PADDING = 220;

interface RoomOffset {
  x: number;
  y: number;
}

type DragState =
  | {
      kind: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      panX: number;
      panY: number;
    }
  | {
      kind: 'room';
      pointerId: number;
      roomId: string;
      startX: number;
      startY: number;
      offsetX: number;
      offsetY: number;
    };

function splitTopicLabel(topic: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = topic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxCharsPerLine || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }

  if (lines.length < maxLines && current.length > 0) {
    lines.push(current);
  }

  const consumedWords = lines.join(' ').trim().split(/\s+/).filter(Boolean).length;
  if (consumedWords < words.length && lines.length > 0) {
    const lastIndex = lines.length - 1;
    const last = lines[lastIndex] ?? '';
    lines[lastIndex] = last.length >= maxCharsPerLine ? `${last.slice(0, maxCharsPerLine - 1)}…` : `${last}…`;
  }

  return lines.slice(0, maxLines);
}

export function FullMapView({
  snapshot,
  dungeonMap,
  focusedRoomId,
  phase,
  teleportModeArmed,
  teleportRemainingMs,
  onTravelToRoom,
  onTeleportToRoom,
  onClose,
}: FullMapViewProps): JSX.Element {
  const addChildRooms = useSubjectStore((s) => s.addChildRooms);
  const reparentRoom = useSubjectStore((s) => s.reparentRoom);
  const lastError = useSubjectStore((s) => s.lastError);
  const { bounds, rooms, corridors } = dungeonMap;
  const maxTopicLength = useMemo(
    () => rooms.reduce((max, room) => Math.max(max, room.topic.length), 0),
    [rooms],
  );
  const layoutSpread = useMemo(
    () => Math.min(2, 1 + Math.max(0, maxTopicLength - 18) / 42),
    [maxTopicLength],
  );
  const innerWidth = (bounds.maxX - bounds.minX) * SCALE * layoutSpread + CANVAS_PADDING * 2;
  const innerHeight = (bounds.maxY - bounds.minY) * SCALE * layoutSpread + CANVAS_PADDING * 2;
  const hierarchy = useMemo(() => deriveGraphHierarchy(snapshot.dungeon), [snapshot.dungeon]);
  const [mode, setMode] = useState<'navigate' | 'edit'>('navigate');
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(focusedRoomId);
  const [floorId, setFloorId] = useState(
    focusedRoomId ? hierarchy.floorIdByRoomId[focusedRoomId] : hierarchy.floorIds[0] ?? '',
  );
  const [teleportRoomId, setTeleportRoomId] = useState(focusedRoomId ?? '');
  const [teleportFilter, setTeleportFilter] = useState('');
  const [draftTopics, setDraftTopics] = useState('');
  const [reparentTargetId, setReparentTargetId] = useState('');

  useEffect(() => {
    setSelectedRoomId(focusedRoomId);
    if (focusedRoomId) {
      setFloorId(hierarchy.floorIdByRoomId[focusedRoomId]);
      setTeleportRoomId(focusedRoomId);
    }
  }, [focusedRoomId, hierarchy.floorIdByRoomId]);

  useEffect(() => {
    const roomIds = hierarchy.roomIdsByFloorId[floorId] ?? [];
    if (roomIds.length === 0) return;
    if (!roomIds.includes(teleportRoomId)) {
      setTeleportRoomId(roomIds[0] ?? '');
    }
  }, [floorId, hierarchy.roomIdsByFloorId, teleportRoomId]);

  const floorTeleportRoomIds = hierarchy.roomIdsByFloorId[floorId] ?? [];
  const filteredTeleportRoomIds = useMemo(() => {
    const query = teleportFilter.trim().toLocaleLowerCase();
    if (query.length === 0) return floorTeleportRoomIds;
    return floorTeleportRoomIds.filter((roomId) =>
      (snapshot.rooms[roomId]?.topic ?? roomId).toLocaleLowerCase().includes(query),
    );
  }, [floorTeleportRoomIds, snapshot.rooms, teleportFilter]);

  useEffect(() => {
    if (filteredTeleportRoomIds.length === 0) return;
    if (!filteredTeleportRoomIds.includes(teleportRoomId)) {
      setTeleportRoomId(filteredTeleportRoomIds[0] ?? '');
    }
  }, [filteredTeleportRoomIds, teleportRoomId]);

  function cycleTeleportSelection(step: number): void {
    if (filteredTeleportRoomIds.length === 0) return;
    const currentIndex = Math.max(0, filteredTeleportRoomIds.indexOf(teleportRoomId));
    const nextIndex = (currentIndex + step + filteredTeleportRoomIds.length) % filteredTeleportRoomIds.length;
    setTeleportRoomId(filteredTeleportRoomIds[nextIndex] ?? filteredTeleportRoomIds[0] ?? '');
  }

  function onTeleportFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cycleTeleportSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      cycleTeleportSelection(-1);
      return;
    }
    if (event.key === 'Enter' && teleportRoomId && teleportRemainingMs <= 0) {
      event.preventDefault();
      onTeleportToRoom(teleportRoomId);
    }
  }

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [floorFilterOn, setFloorFilterOn] = useState(true);
  const [roomOffsets, setRoomOffsets] = useState<Record<string, RoomOffset>>({});
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const applyZoom = useCallback((requestedZoom: number, anchorX: number, anchorY: number) => {
    setZoom((currentZoom) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requestedZoom));
      if (Math.abs(clamped - currentZoom) < 0.0001) return currentZoom;
      const ratio = clamped / currentZoom;
      setPan((currentPan) => ({
        x: anchorX - (anchorX - currentPan.x) * ratio,
        y: anchorY - (anchorY - currentPan.y) * ratio,
      }));
      return clamped;
    });
  }, []);

  const neighborIds = new Set<string>();
  if (focusedRoomId) {
    for (const c of corridors) {
      if (c.fromRoomId === focusedRoomId) neighborIds.add(c.toRoomId);
      else if (c.toRoomId === focusedRoomId) neighborIds.add(c.fromRoomId);
    }
  }

  // When the floor filter is on, only rooms belonging to the currently
  // selected floor are drawn, plus the parent-floor entry room so the user
  // can navigate back. Corridors are filtered to endpoints in this set.
  const floorRoomIdSet = useMemo(
    () => new Set(hierarchy.roomIdsByFloorId[floorId] ?? []),
    [hierarchy.roomIdsByFloorId, floorId],
  );
  const portalRoomId =
    floorId && floorId !== snapshot.dungeon.rootRoomId
      ? hierarchy.parentByRoomId[floorId] ?? null
      : null;
  const visibleRoomIdSet = useMemo(() => {
    if (!floorFilterOn) return new Set(rooms.map((room) => room.roomId));
    const set = new Set(floorRoomIdSet);
    if (portalRoomId) set.add(portalRoomId);
    return set;
  }, [floorFilterOn, floorRoomIdSet, portalRoomId, rooms]);
  const visibleRooms = useMemo(
    () => (floorFilterOn ? rooms.filter((room) => visibleRoomIdSet.has(room.roomId)) : rooms),
    [floorFilterOn, rooms, visibleRoomIdSet],
  );
  const visibleCorridors = useMemo(
    () =>
      floorFilterOn
        ? corridors.filter(
            (c) => visibleRoomIdSet.has(c.fromRoomId) && visibleRoomIdSet.has(c.toRoomId),
          )
        : corridors,
    [floorFilterOn, corridors, visibleRoomIdSet],
  );
  const roomById = useMemo(() => {
    const map = new Map<string, DungeonMap['rooms'][number]>();
    for (const room of rooms) map.set(room.roomId, room);
    return map;
  }, [rooms]);

  const fitMapToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || visibleRooms.length === 0) return;

    let minGridX = Number.POSITIVE_INFINITY;
    let maxGridX = Number.NEGATIVE_INFINITY;
    let minGridY = Number.POSITIVE_INFINITY;
    let maxGridY = Number.NEGATIVE_INFINITY;

    for (const room of visibleRooms) {
      minGridX = Math.min(minGridX, room.gridX);
      maxGridX = Math.max(maxGridX, room.gridX + room.width);
      minGridY = Math.min(minGridY, room.gridY);
      maxGridY = Math.max(maxGridY, room.gridY + room.height);
    }

    if (!Number.isFinite(minGridX)) return;

    const contentMinX = (minGridX - bounds.minX) * SCALE * layoutSpread + CANVAS_PADDING;
    const contentMaxX = (maxGridX - bounds.minX) * SCALE * layoutSpread + CANVAS_PADDING;
    const contentMinY = (minGridY - bounds.minY) * SCALE * layoutSpread + CANVAS_PADDING;
    const contentMaxY = (maxGridY - bounds.minY) * SCALE * layoutSpread + CANVAS_PADDING;

    const contentWidth = Math.max(1, contentMaxX - contentMinX);
    const contentHeight = Math.max(1, contentMaxY - contentMinY);
    const contentCenterX = (contentMinX + contentMaxX) / 2;
    const contentCenterY = (contentMinY + contentMaxY) / 2;

    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const padding = 40;
    const zoomX = Math.max(MIN_ZOOM, (viewportWidth - padding) / contentWidth);
    const zoomY = Math.max(MIN_ZOOM, (viewportHeight - padding) / contentHeight);
    const fittedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomX, zoomY)));

    setZoom(fittedZoom);
    setPan({
      x: viewportWidth / 2 - contentCenterX * fittedZoom,
      y: viewportHeight / 2 - contentCenterY * fittedZoom,
    });
  }, [visibleRooms, bounds.minX, bounds.minY, layoutSpread]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      fitMapToViewport();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [fitMapToViewport, floorId, floorFilterOn, visibleRooms.length]);

  const getRoomLayout = useCallback(
    (room: DungeonMap['rooms'][number]) => {
      const offset = roomOffsets[room.roomId] ?? { x: 0, y: 0 };
      const x = (room.gridX - bounds.minX) * SCALE * layoutSpread + CANVAS_PADDING + offset.x;
      const y = (room.gridY - bounds.minY) * SCALE * layoutSpread + CANVAS_PADDING + offset.y;
      const w = room.width * SCALE;
      const h = room.height * SCALE;
      return {
        x,
        y,
        w,
        h,
        cx: x + w / 2,
        cy: y + h / 2,
      };
    },
    [bounds.minX, bounds.minY, layoutSpread, roomOffsets],
  );

  const selectedRoom = selectedRoomId ? snapshot.rooms[selectedRoomId] ?? null : null;
  const selectedBreadcrumbs = selectedRoom
    ? hierarchy.breadcrumbRoomIdsByRoomId[selectedRoom.roomId]
        .map((roomId) => snapshot.rooms[roomId])
        .filter((room): room is RoomMetadata => Boolean(room))
        .map((room) => room.topic)
    : [];
  const selectedConnections = selectedRoom
    ? getConnectedRoomIds(snapshot.dungeon, selectedRoom.roomId)
        .map((roomId) => snapshot.rooms[roomId])
        .filter((room): room is RoomMetadata => Boolean(room))
    : [];
  const selectedChildren = selectedRoom
    ? (hierarchy.childRoomIdsByParentId[selectedRoom.roomId] ?? [])
        .map((roomId) => snapshot.rooms[roomId])
        .filter((room): room is RoomMetadata => Boolean(room))
    : [];
  const reparentCandidates = selectedRoom
    ? snapshot.dungeon.rooms
        .filter(
          (room) =>
            room.roomId !== selectedRoom.roomId &&
            room.roomId !== hierarchy.parentByRoomId[selectedRoom.roomId] &&
            !isReachableViaSubtopics(snapshot.dungeon, selectedRoom.roomId, room.roomId),
        )
        .sort((left, right) => left.topic.localeCompare(right.topic))
    : [];

  const onWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const anchorX = e.clientX - rect.left;
    const anchorY = e.clientY - rect.top;
    const zoomFactor = Math.exp(-e.deltaY * ZOOM_STEP);
    applyZoom(zoom * zoomFactor, anchorX, anchorY);
  }, [applyZoom, zoom]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if ((e.target as Element).closest('[data-room-id]')) return;
      viewportRef.current?.setPointerCapture?.(e.pointerId);
      dragRef.current = {
        kind: 'pan',
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.kind === 'pan') {
      setPan({
        x: drag.panX + (e.clientX - drag.startX),
        y: drag.panY + (e.clientY - drag.startY),
      });
      return;
    }
    const deltaX = (e.clientX - drag.startX) / zoom;
    const deltaY = (e.clientY - drag.startY) / zoom;
    setRoomOffsets((current) => ({
      ...current,
      [drag.roomId]: {
        x: drag.offsetX + deltaX,
        y: drag.offsetY + deltaY,
      },
    }));
  }, [zoom]);

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      viewportRef.current?.releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }, []);

  const onRoomPointerDown = useCallback(
    (roomId: string, e: PointerEvent<SVGGElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedRoomId(roomId);
      const offset = roomOffsets[roomId] ?? { x: 0, y: 0 };
      viewportRef.current?.setPointerCapture?.(e.pointerId);
      dragRef.current = {
        kind: 'room',
        pointerId: e.pointerId,
        roomId,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
    },
    [roomOffsets],
  );

  const resetView = useCallback(() => {
    fitMapToViewport();
  }, [fitMapToViewport]);

  const teleportSeconds = Math.ceil(teleportRemainingMs / 1000);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Full map view">
      <div className="full-map">
        <div className="full-map-header">
          <div>
            <h2>Full Map</h2>
            <p className="full-map-subtitle">
              Explore or edit your dungeon graph, then teleport across floors.
              Use drag-to-pan, scroll-to-zoom, and drag nodes to refine layout.
            </p>
          </div>
          <div className="full-map-actions">
            <label className="full-map-toggle">
              <input
                type="checkbox"
                checked={floorFilterOn}
                onChange={(e) => setFloorFilterOn(e.target.checked)}
              />
              Show current floor only
            </label>
            {phase === 'creator' ? (
              <>
                <button
                  type="button"
                  aria-pressed={mode === 'navigate'}
                  onClick={() => setMode('navigate')}
                >
                  Navigate
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'edit'}
                  onClick={() => setMode('edit')}
                >
                  Graph edit
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const viewport = viewportRef.current;
                if (!viewport) return;
                applyZoom(zoom * 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
              }}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => {
                const viewport = viewportRef.current;
                if (!viewport) return;
                applyZoom(zoom / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
              }}
            >
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

        <div className="full-map-layout">
          <div
            ref={viewportRef}
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
              <svg
                width={innerWidth}
                height={innerHeight}
                viewBox={`0 0 ${innerWidth} ${innerHeight}`}
                data-graphics="rpg"
              >
                {visibleCorridors.map((c, i) => {
                  const from = roomById.get(c.fromRoomId);
                  const to = roomById.get(c.toRoomId);
                  if (!from || !to) return null;
                  const fromLayout = getRoomLayout(from);
                  const toLayout = getRoomLayout(to);
                  const isConnected =
                    focusedRoomId !== null &&
                    (c.fromRoomId === focusedRoomId || c.toRoomId === focusedRoomId);
                  const isPortalEdge =
                    portalRoomId !== null &&
                    floorFilterOn &&
                    (c.fromRoomId === portalRoomId || c.toRoomId === portalRoomId);
                  const corridorStroke = isConnected
                    ? '#f2c879'
                    : isPortalEdge
                      ? '#7fb2ff'
                      : '#7a5a32';
                  return (
                    <line
                      key={i}
                      x1={fromLayout.cx}
                      y1={fromLayout.cy}
                      x2={toLayout.cx}
                      y2={toLayout.cy}
                      stroke={corridorStroke}
                      strokeWidth={isConnected ? 3 : isPortalEdge ? 2.5 : 3}
                      strokeLinecap="round"
                      strokeDasharray={isPortalEdge ? '6 4' : undefined}
                    />
                  );
                })}
                {visibleRooms.map((room) => {
                  const { x, y, w, h, cx, cy } = getRoomLayout(room);
                  const topicLines = splitTopicLabel(room.topic, 22, 3);
                  const isFocused = room.roomId === focusedRoomId;
                  const isNeighbor = neighborIds.has(room.roomId);
                  const isSelected = room.roomId === selectedRoomId;
                  const isPortal =
                    floorFilterOn && portalRoomId !== null && room.roomId === portalRoomId;
                  const rpgFill = isPortal
                    ? '#3a2a1a'
                    : isFocused
                      ? '#f2c879'
                      : isNeighbor
                        ? '#e8c98a'
                        : room.isRoot
                          ? '#b88a4a'
                          : '#3d2b1a';
                  const fill = rpgFill;
                  const stroke = isSelected
                    ? '#8b5cf6'
                    : isPortal
                      ? '#7fb2ff'
                      : isFocused || isNeighbor
                        ? '#f2c879'
                        : '#6b4a24';
                  const strokeWidth = isSelected
                    ? 3
                    : isPortal
                      ? 2.5
                      : isFocused
                        ? 2
                        : isNeighbor
                          ? 1.5
                          : 1.5;
                  const textFill = isFocused || isNeighbor ? '#2d1f11' : '#f9eed9';
                  const textStroke = isFocused || isNeighbor ? '#f9eed9' : '#2d1f11';
                  return (
                    <g
                      key={room.roomId}
                      onClick={() => setSelectedRoomId(room.roomId)}
                      onPointerDown={(e) => onRoomPointerDown(room.roomId, e)}
                      role="button"
                      tabIndex={0}
                      data-room-id={room.roomId}
                      style={{ cursor: 'grab' }}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                        strokeDasharray={isPortal ? '4 3' : undefined}
                        rx={1}
                      />
                      <text
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={11}
                        fill={textFill}
                        stroke={textStroke}
                        strokeWidth={2.2}
                        paintOrder="stroke"
                      >
                        {isPortal ? <tspan x={cx} dy={-10}>↑</tspan> : null}
                        {topicLines.map((line, index) => {
                          const lineOffset = (index - (topicLines.length - 1) / 2) * 12;
                          const dy = isPortal && index === 0 ? lineOffset + 10 : lineOffset;
                          return (
                            <tspan key={`${room.roomId}-${index}`} x={cx} dy={index === 0 ? dy : 12}>
                              {line}
                            </tspan>
                          );
                        })}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          <aside className="full-map-sidebar">
            <div className="room-section full-map-teleport-section">
              <h3>Teleport</h3>
              <p className="teleport-guidance" role="status" aria-live="polite">
                {teleportModeArmed
                  ? 'Teleport Mode active: 1) choose a room, 2) press Teleport Now or hit Enter.'
                  : 'Press Teleport in the HUD to arm Teleport Mode and auto-open this map.'}
              </p>
              <select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
                {hierarchy.floorIds.map((entryFloorId) => (
                  <option key={entryFloorId} value={entryFloorId}>
                    {hierarchy.floorLabelByFloorId[entryFloorId]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={teleportFilter}
                onChange={(e) => setTeleportFilter(e.target.value)}
                onKeyDown={onTeleportFilterKeyDown}
                placeholder="Filter rooms on this floor"
                aria-label="Filter teleport rooms"
              />
              <div className="teleport-room-list" role="listbox" aria-label="Teleport room list">
                {filteredTeleportRoomIds.length === 0 ? (
                  <p className="room-help-text">No rooms match this filter.</p>
                ) : (
                  filteredTeleportRoomIds.map((roomId) => {
                    const isSelected = roomId === teleportRoomId;
                    return (
                      <button
                        key={roomId}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`teleport-room-item${isSelected ? ' teleport-room-item--selected' : ''}`}
                        onClick={() => setTeleportRoomId(roomId)}
                        onDoubleClick={() => {
                          if (teleportRemainingMs <= 0) {
                            onTeleportToRoom(roomId);
                          }
                        }}
                      >
                        {snapshot.rooms[roomId]?.topic ?? roomId}
                      </button>
                    );
                  })
                )}
              </div>
              <p className="room-help-text">
                Tip: Arrow up/down to change selection, Enter to teleport, or double-click a room.
              </p>
              <button
                type="button"
                disabled={!teleportRoomId || teleportRemainingMs > 0}
                aria-pressed={teleportModeArmed}
                onClick={() => onTeleportToRoom(teleportRoomId)}
              >
                {teleportRemainingMs > 0
                  ? `Ready in ${Math.floor(teleportSeconds / 60)}:${String(teleportSeconds % 60).padStart(2, '0')}`
                  : teleportModeArmed
                    ? 'Teleport Now'
                    : 'Teleport to selection'}
              </button>
            </div>

            <div className="room-section full-map-selected-section">
              <h3>Selected topic</h3>
              {selectedRoom ? (
                <>
                  <p className="room-meta-line">{selectedRoom.topic}</p>
                  <p className="room-help-text">Floor: {hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[selectedRoom.roomId]]}</p>
                  <p className="room-help-text">Breadcrumbs: {selectedBreadcrumbs.join(' → ')}</p>
                  <div className="linked-topic-list">
                    {focusedRoomId && neighborIds.has(selectedRoom.roomId) ? (
                      <button type="button" className="ghost" onClick={() => onTravelToRoom(selectedRoom.roomId)}>
                        Travel from current room
                      </button>
                    ) : null}
                    {selectedConnections.map((room) => (
                      <button
                        key={room.roomId}
                        type="button"
                        className="ghost"
                        onClick={() => setSelectedRoomId(room.roomId)}
                      >
                        Jump to {room.topic}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p>Select a room on the map to inspect or edit it.</p>
              )}
            </div>

            {phase === 'creator' && mode === 'edit' && selectedRoom ? (
              <div className="room-section">
                <h3>Graph edit mode</h3>
                <textarea
                  value={draftTopics}
                  onChange={(e) => setDraftTopics(e.target.value)}
                  rows={4}
                  placeholder={'Bulk child topics\nDefinitions, Examples'}
                />
                <button
                  type="button"
                  disabled={parseTopicBatch(draftTopics).length === 0}
                  onClick={() => {
                    const topics = parseTopicBatch(draftTopics);
                    if (topics.length === 0) return;
                    void addChildRooms(selectedRoom.roomId, topics).then(() => setDraftTopics(''));
                  }}
                >
                  Add child topics
                </button>
                {selectedRoom.roomId !== snapshot.dungeon.rootRoomId ? (
                  <>
                    <select
                      value={reparentTargetId}
                      onChange={(e) => setReparentTargetId(e.target.value)}
                    >
                      <option value="">Choose a new parent</option>
                      {reparentCandidates.map((room) => (
                        <option key={room.roomId} value={room.roomId}>
                          {room.topic}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!reparentTargetId}
                      onClick={() => {
                        void reparentRoom(selectedRoom.roomId, reparentTargetId).then(() =>
                          setReparentTargetId(''),
                        );
                      }}
                    >
                      Change parent
                    </button>
                  </>
                ) : null}
                {selectedChildren.length > 0 ? (
                  <p className="room-help-text">
                    Child topics on this floor: {selectedChildren.map((room) => room.topic).join(', ')}
                  </p>
                ) : null}
                {lastError ? <p className="room-error-text">{lastError}</p> : null}
              </div>
            ) : null}
          </aside>
        </div>

        <p className="full-map-hint">
          Drag empty space to pan · drag a room to reposition it · scroll to zoom · highlighted
          rooms are directly connected to the current room · purple border marks the selected room
          {floorFilterOn ? ' · dashed blue room is the portal back to the parent floor' : ''}.
        </p>
      </div>
    </div>
  );
}
