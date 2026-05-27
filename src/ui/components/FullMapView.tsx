import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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

const SCALE = 6;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.0015;

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
  const innerWidth = (bounds.maxX - bounds.minX) * SCALE;
  const innerHeight = (bounds.maxY - bounds.minY) * SCALE;
  const hierarchy = useMemo(() => deriveGraphHierarchy(snapshot.dungeon), [snapshot.dungeon]);
  const [mode, setMode] = useState<'navigate' | 'edit'>('navigate');
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(focusedRoomId);
  const [floorId, setFloorId] = useState(
    focusedRoomId ? hierarchy.floorIdByRoomId[focusedRoomId] : hierarchy.floorIds[0] ?? '',
  );
  const [teleportRoomId, setTeleportRoomId] = useState(focusedRoomId ?? '');
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

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: -innerWidth / 2, y: -innerHeight / 2 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const neighborIds = new Set<string>();
  if (focusedRoomId) {
    for (const c of corridors) {
      if (c.fromRoomId === focusedRoomId) neighborIds.add(c.toRoomId);
      else if (c.toRoomId === focusedRoomId) neighborIds.add(c.fromRoomId);
    }
  }

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
    setZoom((z) => {
      const next = z * (1 - e.deltaY * ZOOM_STEP);
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    });
  }, []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = {
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

  const teleportSeconds = Math.ceil(teleportRemainingMs / 1000);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Full map view">
      <div className="full-map">
        <div className="full-map-header">
          <div>
            <h2>Full Map</h2>
            <p className="full-map-subtitle">
              Mindmap-first editing drives the dungeon layout. Use this view to inspect, edit, and
              teleport between floors.
            </p>
          </div>
          <div className="full-map-actions">
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

        <div className="full-map-layout">
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
                  const isSelected = room.roomId === selectedRoomId;
                  const fill = isFocused
                    ? '#f2c879'
                    : isNeighbor
                      ? '#f7d99c'
                      : room.isRoot
                        ? '#7fb2ff'
                        : '#1f2433';
                  return (
                    <g
                      key={room.roomId}
                      onClick={() => setSelectedRoomId(room.roomId)}
                      role="button"
                      tabIndex={0}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill={fill}
                        stroke={isSelected ? '#8b5cf6' : isFocused || isNeighbor ? '#f2c879' : '#a8b0c8'}
                        strokeWidth={isSelected ? 3 : isFocused ? 2 : isNeighbor ? 1.5 : 1}
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

          <aside className="full-map-sidebar">
            <div className="room-section">
              <h3>Teleport</h3>
              <select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
                {hierarchy.floorIds.map((entryFloorId) => (
                  <option key={entryFloorId} value={entryFloorId}>
                    {hierarchy.floorLabelByFloorId[entryFloorId]}
                  </option>
                ))}
              </select>
              <select value={teleportRoomId} onChange={(e) => setTeleportRoomId(e.target.value)}>
                {(hierarchy.roomIdsByFloorId[floorId] ?? []).map((roomId) => (
                  <option key={roomId} value={roomId}>
                    {snapshot.rooms[roomId]?.topic ?? roomId}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!teleportRoomId || teleportRemainingMs > 0}
                aria-pressed={teleportModeArmed}
                onClick={() => onTeleportToRoom(teleportRoomId)}
              >
                {teleportRemainingMs > 0
                  ? `Ready in ${Math.floor(teleportSeconds / 60)}:${String(teleportSeconds % 60).padStart(2, '0')}`
                  : teleportModeArmed
                    ? 'Teleport now'
                    : 'Teleport to selection'}
              </button>
            </div>

            <div className="room-section">
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
          Drag to pan · scroll to zoom · highlighted rooms are directly connected to the current
          room · purple border marks the selected room.
        </p>
      </div>
    </div>
  );
}
