import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import {
  deriveGraphHierarchy,
  getConnectedRoomIds,
  isReachableViaSubtopics,
} from '@/core/graph';
import { useSubjectStore } from '@/store/subjectStore';
import { useSessionStore } from '@/store/sessionStore';
import { parseTopicBatch } from '@/ui/utils/topicParsing';
import { Markdown } from '@/ui/utils/markdown';
import {
  evaluateReviewUnlock,
  extractMarkdownHeadings,
  generateSelfCheckPrompts,
} from '@/core/review';

type RoomTab = 'topic' | 'notes' | 'artifact' | 'selfcheck';

interface PanelPosition {
  x: number;
  y: number;
}

const PANEL_MARGIN = 12;
const PANEL_MIN_TOP = 72;
const DEFAULT_PANEL_WIDTH = 360;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getInitialPanelPosition(): PanelPosition {
  if (typeof window === 'undefined') {
    return { x: PANEL_MARGIN, y: 80 };
  }
  const rightAnchoredX = window.innerWidth - DEFAULT_PANEL_WIDTH - PANEL_MARGIN;
  return {
    x: Math.max(PANEL_MARGIN, rightAnchoredX),
    y: 80,
  };
}

interface RoomPanelProps {
  snapshot: SubjectSnapshot;
  focusedRoom: RoomMetadata | null;
  onInteract: () => void;
  onTravelToRoom: (roomId: string) => void;
  reviewPassesCompleted: number;
  reviewRoomsTowardNextPass: number;
  reviewNextPassTarget: number;
  reviewTotalRooms: number;
}

export function RoomPanel({
  snapshot,
  focusedRoom,
  onInteract,
  onTravelToRoom,
  reviewPassesCompleted,
  reviewRoomsTowardNextPass,
  reviewNextPassTarget,
  reviewTotalRooms,
}: RoomPanelProps): JSX.Element {
  const reviewProgressPercent =
    reviewTotalRooms > 0
      ? Math.min(100, Math.round((reviewRoomsTowardNextPass / reviewTotalRooms) * 100))
      : 0;
  const [tab, setTab] = useState<RoomTab>('topic');
  const addChildRooms = useSubjectStore((s) => s.addChildRooms);
  const resolveAttachmentUrl = useSubjectStore((s) => s.resolveAttachmentUrl);
  const reparentRoom = useSubjectStore((s) => s.reparentRoom);
  const removeRoom = useSubjectStore((s) => s.removeRoom);
  const lastError = useSubjectStore((s) => s.lastError);
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const [draftTopics, setDraftTopics] = useState('');
  const [reparentTargetId, setReparentTargetId] = useState('');
  const [sameFloorFilter, setSameFloorFilter] = useState('');
  const [selectedSameFloorRoomId, setSelectedSameFloorRoomId] = useState<string | null>(null);
  const [travelFilter, setTravelFilter] = useState('');
  const [selectedTravelRoomId, setSelectedTravelRoomId] = useState<string | null>(null);
  const [portalFilter, setPortalFilter] = useState('');
  const [selectedPortalRoomId, setSelectedPortalRoomId] = useState<string | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [panelPosition, setPanelPosition] = useState<PanelPosition>(getInitialPanelPosition);
  const [dragState, setDragState] = useState<
    { pointerId: number; offsetX: number; offsetY: number } | null
  >(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const clampPanelPosition = useCallback((position: PanelPosition): PanelPosition => {
    if (typeof window === 'undefined') return position;
    const panelWidth = panelRef.current?.offsetWidth ?? DEFAULT_PANEL_WIDTH;
    const panelHeight = panelRef.current?.offsetHeight ?? 520;
    const maxX = Math.max(PANEL_MARGIN, window.innerWidth - panelWidth - PANEL_MARGIN);
    const maxY = Math.max(PANEL_MIN_TOP, window.innerHeight - panelHeight - PANEL_MARGIN);
    return {
      x: clamp(position.x, PANEL_MARGIN, maxX),
      y: clamp(position.y, PANEL_MIN_TOP, maxY),
    };
  }, []);

  useEffect(() => {
    setPanelPosition((current) => clampPanelPosition(current));
  }, [clampPanelPosition, panelExpanded]);

  useEffect(() => {
    const onResize = () => {
      setPanelPosition((current) => clampPanelPosition(current));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [clampPanelPosition]);

  useEffect(() => {
    if (!dragState) return;

    const onPointerMove = (event: globalThis.PointerEvent) => {
      setPanelPosition(
        clampPanelPosition({
          x: event.clientX - dragState.offsetX,
          y: event.clientY - dragState.offsetY,
        }),
      );
    };

    const stopDragging = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) return;
      setDragState(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };
  }, [clampPanelPosition, dragState]);

  function onDragHandlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const panelRect = panelRef.current?.getBoundingClientRect();
    if (!panelRect) return;
    event.preventDefault();
    setDragState({
      pointerId: event.pointerId,
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
    });
  }

  const panelStyle: CSSProperties = {
    left: `${panelPosition.x}px`,
    top: `${panelPosition.y}px`,
  };

  const hierarchy = useMemo(() => deriveGraphHierarchy(snapshot.dungeon), [snapshot.dungeon]);

  const unlock = useMemo(
    () =>
      evaluateReviewUnlock({
        dungeon: snapshot.dungeon,
        rooms: snapshot.rooms,
      }),
    [snapshot],
  );
  const focusedRoomId = focusedRoom?.roomId ?? null;

  useEffect(() => {
    if (!focusedRoom) {
      setAttachmentUrls({});
      return;
    }

    let cancelled = false;
    const localAttachments = focusedRoom.attachments.filter((attachment) => attachment.sourceType === 'local');
    if (localAttachments.length === 0) {
      setAttachmentUrls({});
      return;
    }

    void Promise.all(
      localAttachments.map(async (attachment) => {
        const resolved = await resolveAttachmentUrl(focusedRoom.roomId, attachment.attachmentId);
        return [attachment.attachmentId, resolved] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      const next = Object.fromEntries(
        results.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
      );
      setAttachmentUrls(next);
    });

    return () => {
      cancelled = true;
    };
  }, [focusedRoom, resolveAttachmentUrl]);

  const resolveLocalImage = (attachmentId: string): string | null => {
    return attachmentUrls[attachmentId] ?? null;
  };

  const artifactMarkdown = focusedRoom?.validationState.finalPass
    ? focusedRoom.artifactMarkdown
    : null;
  const hasNoteText = Boolean(focusedRoom?.noteText.trim().length);
  const noteWordCount = focusedRoom?.validationState.wordCount ?? 0;
  const artifactTabsLocked = !focusedRoom?.validationState.finalPass;

  const connectedRoomIds = focusedRoomId
    ? getConnectedRoomIds(snapshot.dungeon, focusedRoomId)
    : [];
  const connectedRooms = connectedRoomIds
    .map((roomId) => snapshot.rooms[roomId])
    .filter((room): room is RoomMetadata => Boolean(room));
  const relatedTopics = connectedRooms.map((room) => room.topic);
  const focusedFloorId = focusedRoomId
    ? hierarchy.floorIdByRoomId[focusedRoomId]
    : snapshot.dungeon.rootRoomId;
  const sameFloorConnections = connectedRooms.filter(
    (room) => hierarchy.floorIdByRoomId[room.roomId] === focusedFloorId,
  );
  const otherFloorConnections = connectedRooms.filter(
    (room) => hierarchy.floorIdByRoomId[room.roomId] !== focusedFloorId,
  );
  const parentRoomId = focusedRoomId ? hierarchy.parentByRoomId[focusedRoomId] : null;
  const parentRoom = parentRoomId ? snapshot.rooms[parentRoomId] ?? null : null;
  const parentFloorId = parentRoom ? hierarchy.floorIdByRoomId[parentRoom.roomId] : null;
  const parentFloorRoom =
    parentFloorId && parentFloorId !== focusedFloorId
      ? snapshot.rooms[parentFloorId] ?? null
      : null;

  const filteredSameFloorRooms = useMemo(() => {
    const query = sameFloorFilter.trim().toLocaleLowerCase();
    if (query.length === 0) return sameFloorConnections;
    return sameFloorConnections.filter((room) => room.topic.toLocaleLowerCase().includes(query));
  }, [sameFloorConnections, sameFloorFilter]);

  useEffect(() => {
    if (filteredSameFloorRooms.length === 0) {
      setSelectedSameFloorRoomId(null);
      return;
    }
    if (
      !selectedSameFloorRoomId ||
      !filteredSameFloorRooms.some((room) => room.roomId === selectedSameFloorRoomId)
    ) {
      setSelectedSameFloorRoomId(filteredSameFloorRooms[0]?.roomId ?? null);
    }
  }, [filteredSameFloorRooms, selectedSameFloorRoomId]);

  function cycleSameFloorSelection(step: number): void {
    if (filteredSameFloorRooms.length === 0) return;
    const ids = filteredSameFloorRooms.map((room) => room.roomId);
    const currentIndex = Math.max(0, ids.indexOf(selectedSameFloorRoomId ?? ids[0] ?? ''));
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    setSelectedSameFloorRoomId(ids[nextIndex] ?? ids[0] ?? null);
  }

  function onSameFloorFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cycleSameFloorSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      cycleSameFloorSelection(-1);
      return;
    }
    if (event.key === 'Enter' && selectedSameFloorRoomId) {
      event.preventDefault();
      onTravelToRoom(selectedSameFloorRoomId);
    }
  }

  const travelRoomCandidates = useMemo(() => {
    const list: RoomMetadata[] = [];
    if (parentFloorRoom) {
      list.push(parentFloorRoom);
    }
    for (const room of otherFloorConnections) {
      if (room.roomId === parentFloorRoom?.roomId) continue;
      list.push(room);
    }
    return list;
  }, [otherFloorConnections, parentFloorRoom]);

  const filteredTravelRooms = useMemo(() => {
    const query = travelFilter.trim().toLocaleLowerCase();
    if (query.length === 0) return travelRoomCandidates;
    return travelRoomCandidates.filter((room) => {
      const floorLabel = hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[room.roomId]];
      return `${room.topic} ${floorLabel}`.toLocaleLowerCase().includes(query);
    });
  }, [travelFilter, travelRoomCandidates, hierarchy.floorIdByRoomId, hierarchy.floorLabelByFloorId]);

  useEffect(() => {
    if (filteredTravelRooms.length === 0) {
      setSelectedTravelRoomId(null);
      return;
    }
    if (!selectedTravelRoomId || !filteredTravelRooms.some((room) => room.roomId === selectedTravelRoomId)) {
      setSelectedTravelRoomId(filteredTravelRooms[0]?.roomId ?? null);
    }
  }, [filteredTravelRooms, selectedTravelRoomId]);

  function cycleTravelSelection(step: number): void {
    if (filteredTravelRooms.length === 0) return;
    const ids = filteredTravelRooms.map((room) => room.roomId);
    const currentIndex = Math.max(0, ids.indexOf(selectedTravelRoomId ?? ids[0] ?? ''));
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    setSelectedTravelRoomId(ids[nextIndex] ?? ids[0] ?? null);
  }

  function onTravelFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cycleTravelSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      cycleTravelSelection(-1);
      return;
    }
    if (event.key === 'Enter' && selectedTravelRoomId) {
      event.preventDefault();
      onTravelToRoom(selectedTravelRoomId);
    }
  }

  const selfCheckPrompts = focusedRoom?.validationState.finalPass
    ? generateSelfCheckPrompts({
        roomId: focusedRoom.roomId,
        subjectName: snapshot.dungeon.subjectName,
        roomTopic: focusedRoom.topic,
        noteHeadings: artifactMarkdown ? extractMarkdownHeadings(artifactMarkdown) : [],
        relatedTopics,
      })
    : [];

  const breadcrumbRooms = focusedRoomId
    ? hierarchy.breadcrumbRoomIdsByRoomId[focusedRoomId]
        .map((roomId) => snapshot.rooms[roomId])
        .filter((room): room is RoomMetadata => Boolean(room))
    : [];
  const currentFloorLabel =
    focusedRoomId
      ? hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[focusedRoomId]]
      : snapshot.dungeon.subjectName;
  const directChildRoomIds = focusedRoomId
    ? hierarchy.childRoomIdsByParentId[focusedRoomId] ?? []
    : [];
  const portalRooms = directChildRoomIds
    .filter((roomId) => (hierarchy.childRoomIdsByParentId[roomId] ?? []).length > 0)
    .map((roomId) => snapshot.rooms[roomId])
    .filter((room): room is RoomMetadata => Boolean(room));

  const filteredPortalRooms = useMemo(() => {
    const query = portalFilter.trim().toLocaleLowerCase();
    if (query.length === 0) return portalRooms;
    return portalRooms.filter((room) => room.topic.toLocaleLowerCase().includes(query));
  }, [portalFilter, portalRooms]);

  useEffect(() => {
    if (filteredPortalRooms.length === 0) {
      setSelectedPortalRoomId(null);
      return;
    }
    if (
      !selectedPortalRoomId ||
      !filteredPortalRooms.some((room) => room.roomId === selectedPortalRoomId)
    ) {
      setSelectedPortalRoomId(filteredPortalRooms[0]?.roomId ?? null);
    }
  }, [filteredPortalRooms, selectedPortalRoomId]);

  function cyclePortalSelection(step: number): void {
    if (filteredPortalRooms.length === 0) return;
    const ids = filteredPortalRooms.map((room) => room.roomId);
    const currentIndex = Math.max(0, ids.indexOf(selectedPortalRoomId ?? ids[0] ?? ''));
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    setSelectedPortalRoomId(ids[nextIndex] ?? ids[0] ?? null);
  }

  function onPortalFilterKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cyclePortalSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      cyclePortalSelection(-1);
      return;
    }
    if (event.key === 'Enter' && selectedPortalRoomId) {
      event.preventDefault();
      onTravelToRoom(selectedPortalRoomId);
    }
  }
  const currentParentId = focusedRoomId ? hierarchy.parentByRoomId[focusedRoomId] : null;
  const reparentCandidates = focusedRoomId
    ? snapshot.dungeon.rooms
        .filter(
          (room) =>
            room.roomId !== focusedRoomId &&
            room.roomId !== currentParentId &&
            !isReachableViaSubtopics(snapshot.dungeon, focusedRoomId, room.roomId),
        )
        .sort((left, right) => left.topic.localeCompare(right.topic))
    : [];

  if (!focusedRoom) {
    return (
      <aside
        ref={panelRef}
        className={`room-panel${dragState ? ' room-panel--dragging' : ''}`}
        style={panelStyle}
      >
        <div
          className="room-panel-drag-handle"
          data-testid="room-panel-drag-handle"
          onPointerDown={onDragHandlePointerDown}
        >
          Drag panel
        </div>
        <div className="room-tabs">
          <button type="button" aria-selected>
            No room
          </button>
        </div>
        <div className="room-tab-body">
          <p>Walk into a room to inspect it. Use WASD or the arrow keys.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={panelRef}
      className={`room-panel${panelExpanded ? ' room-panel--expanded' : ''}${dragState ? ' room-panel--dragging' : ''}`}
      style={panelStyle}
      aria-label="Room information"
    >
      <div
        className="room-panel-drag-handle"
        data-testid="room-panel-drag-handle"
        onPointerDown={onDragHandlePointerDown}
      >
        Drag panel
      </div>
      <div className="room-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'topic'}
          onClick={() => setTab('topic')}
        >
          Topic
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notes'}
          onClick={() => setTab('notes')}
        >
          Notes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'artifact'}
          onClick={() => setTab('artifact')}
          disabled={!focusedRoom.validationState.finalPass}
          title={!focusedRoom.validationState.finalPass ? 'Unlock by defeating this room encounter.' : undefined}
        >
          Artifact
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'selfcheck'}
          onClick={() => setTab('selfcheck')}
          disabled={!focusedRoom.validationState.finalPass}
          title={!focusedRoom.validationState.finalPass ? 'Unlock by defeating this room encounter.' : undefined}
        >
          Self-check
        </button>
        <button
          type="button"
          className="room-panel-toggle"
          aria-pressed={panelExpanded}
          aria-label={panelExpanded ? 'Collapse room panel' : 'Expand room panel'}
          onClick={() => setPanelExpanded((value) => !value)}
        >
          {panelExpanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {artifactTabsLocked ? (
        <p className="room-tab-lock-hint">
          Artifact and Self-check unlock after you defeat this room encounter.
        </p>
      ) : null}

      <div className="room-tab-body">
        {tab === 'topic' ? (
          <>
            <div className="room-progress-card" aria-label="Archaeologist unlock progress">
              <strong>
                Archaeologist unlock: {unlock.clearedRooms}/{unlock.totalRooms} rooms cleared
              </strong>
              <p className="room-help-text">
                {unlock.unlocked
                  ? 'Review phase is available.'
                  : 'Clear every room encounter to unlock full review mode.'}
              </p>
            </div>
            <div className="room-progress-card" aria-label="Archaeologist review pass progress">
              <strong>
                Review passes: {reviewPassesCompleted} complete
              </strong>
              <p className="room-help-text">
                {reviewRoomsTowardNextPass}/{reviewTotalRooms} rooms toward pass {reviewNextPassTarget}.
              </p>
              <div
                className="review-progress-bar"
                role="progressbar"
                aria-label="Room review progress toward next pass"
                aria-valuemin={0}
                aria-valuemax={reviewTotalRooms}
                aria-valuenow={Math.min(reviewRoomsTowardNextPass, reviewTotalRooms)}
              >
                <span
                  className="review-progress-bar-fill"
                  style={{ width: `${reviewProgressPercent}%` }}
                />
              </div>
            </div>
            <div className="room-section" style={{ marginBottom: 12 }}>
              <button type="button" className="room-primary-action" onClick={onInteract}>
                {phase === 'archaeologist' ? 'Mark reviewed' : 'Open encounter'}
              </button>
              <p className="room-help-text">
                Primary action for this room. Use <kbd>E</kbd> in the dungeon to trigger the same action.
              </p>
            </div>
            <h2>{focusedRoom.topic}</h2>
            <span className="room-status-chip">{focusedRoom.state}</span>
            <p className="room-meta-line">Floor: {currentFloorLabel}</p>
            <p className="room-meta-line">
              Breadcrumbs:{' '}
              {breadcrumbRooms.map((room) => room.topic).join(' → ')}
            </p>
            <p className="room-meta-line">Edges: {relatedTopics.length}</p>

            {phase === 'creator' && snapshot.dungeon.rooms.length >= 3 ? (
              <div className="room-section room-phase-nudge" aria-live="polite">
                <p className="room-help-text">
                  Your map has enough rooms to start Scribe encounters.
                </p>
                <button type="button" onClick={() => setPhase('scribe')}>
                  Switch to Scribe
                </button>
              </div>
            ) : null}

            {sameFloorConnections.length > 0 ? (
              <div className="room-section">
                <h3>Connected topics on this floor</h3>
                <input
                  type="text"
                  value={sameFloorFilter}
                  onChange={(e) => setSameFloorFilter(e.target.value)}
                  onKeyDown={onSameFloorFilterKeyDown}
                  placeholder="Filter connected topics"
                  aria-label="Filter connected topics on this floor"
                />
                <div className="room-travel-list" role="listbox" aria-label="Connected topics list">
                  {filteredSameFloorRooms.length === 0 ? (
                    <p className="room-help-text">No connected topics match this filter.</p>
                  ) : (
                    filteredSameFloorRooms.map((room) => {
                      const isSelected = room.roomId === selectedSameFloorRoomId;
                      return (
                        <button
                          key={room.roomId}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`ghost room-travel-item${isSelected ? ' room-travel-item--selected' : ''}`}
                          onClick={() => {
                            setSelectedSameFloorRoomId(room.roomId);
                            onTravelToRoom(room.roomId);
                          }}
                        >
                          Travel to {room.topic}
                        </button>
                      );
                    })
                  )}
                </div>
                <p className="room-help-text">Tip: Arrow up/down to select, Enter to travel.</p>
              </div>
            ) : null}

            {parentFloorRoom || otherFloorConnections.length > 0 ? (
              <div className="room-section">
                <h3>Travel to related floors</h3>
                <input
                  type="text"
                  value={travelFilter}
                  onChange={(e) => setTravelFilter(e.target.value)}
                  onKeyDown={onTravelFilterKeyDown}
                  placeholder="Filter related floors"
                  aria-label="Filter related floor travel"
                />
                <div className="room-travel-list" role="listbox" aria-label="Related floor travel list">
                  {filteredTravelRooms.length === 0 ? (
                    <p className="room-help-text">No related floors match this filter.</p>
                  ) : (
                    filteredTravelRooms.map((room) => {
                      const isParent = room.roomId === parentFloorRoom?.roomId;
                      const isSelected = room.roomId === selectedTravelRoomId;
                      const floorLabel =
                        hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[room.roomId]];
                      return (
                        <button
                          key={room.roomId}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`ghost room-travel-item${isSelected ? ' room-travel-item--selected' : ''}`}
                          onClick={() => {
                            setSelectedTravelRoomId(room.roomId);
                            onTravelToRoom(room.roomId);
                          }}
                          title={`On ${floorLabel}`}
                        >
                          {isParent ? '← Back to ' : 'Travel to '}
                          {room.topic} <small>({floorLabel})</small>
                        </button>
                      );
                    })
                  )}
                </div>
                <p className="room-help-text">Tip: Arrow up/down to select, Enter to travel.</p>
              </div>
            ) : null}

            {portalRooms.length > 0 ? (
              <div className="room-section">
                <h3>Portals to deeper floors</h3>
                <input
                  type="text"
                  value={portalFilter}
                  onChange={(e) => setPortalFilter(e.target.value)}
                  onKeyDown={onPortalFilterKeyDown}
                  placeholder="Filter portal rooms"
                  aria-label="Filter portal rooms"
                />
                <div className="room-travel-list" role="listbox" aria-label="Portal rooms list">
                  {filteredPortalRooms.length === 0 ? (
                    <p className="room-help-text">No portal rooms match this filter.</p>
                  ) : (
                    filteredPortalRooms.map((room) => {
                      const isSelected = room.roomId === selectedPortalRoomId;
                      return (
                        <button
                          key={room.roomId}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`ghost room-travel-item${isSelected ? ' room-travel-item--selected' : ''}`}
                          onClick={() => {
                            setSelectedPortalRoomId(room.roomId);
                            onTravelToRoom(room.roomId);
                          }}
                        >
                          Enter {room.topic}
                        </button>
                      );
                    })
                  )}
                </div>
                <p className="room-help-text">Tip: Arrow up/down to select, Enter to travel.</p>
              </div>
            ) : null}

            {phase === 'creator' ? (
              <div className="room-section">
                <h3>Add child topics</h3>
                <textarea
                  value={draftTopics}
                  onChange={(e) => setDraftTopics(e.target.value)}
                  rows={4}
                  placeholder={'One topic per line or comma-separated\nMatrices\nLinear Transformations'}
                />
                <p className="room-help-text">
                  Add several child topics at once with commas or new lines.
                </p>
                <button
                  type="button"
                  disabled={parseTopicBatch(draftTopics).length === 0}
                  onClick={() => {
                    const topics = parseTopicBatch(draftTopics);
                    if (topics.length === 0) return;
                    void addChildRooms(focusedRoom.roomId, topics).then(() => setDraftTopics(''));
                  }}
                >
                  Add child rooms
                </button>
              </div>
            ) : null}

            {phase === 'creator' && focusedRoom.roomId !== snapshot.dungeon.rootRoomId ? (
              <div className="room-section">
                <h3>Change parent</h3>
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
                    void reparentRoom(focusedRoom.roomId, reparentTargetId).then(() =>
                      setReparentTargetId(''),
                    );
                  }}
                >
                  Move under new parent
                </button>
              </div>
            ) : null}

            {phase === 'creator' ? (
              <div className="room-section">
                {focusedRoom.roomId !== snapshot.dungeon.rootRoomId ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const ok = window.confirm(
                        `Delete "${focusedRoom.topic}"? Any child topics that become disconnected will also be removed.`,
                      );
                      if (!ok) return;
                      const id = focusedRoom.roomId;
                      void removeRoom(id).then(() => {
                        setFocusedRoomId(null);
                      });
                    }}
                  >
                    Delete topic
                  </button>
                ) : (
                  <p className="room-help-text">The root topic cannot be deleted.</p>
                )}
              </div>
            ) : null}

            {lastError ? <p className="room-error-text">{lastError}</p> : null}

          </>
        ) : null}

        {tab === 'notes' ? (
          <>
            <h2>Notes</h2>
            {!hasNoteText && noteWordCount === 0 ? (
              <p>No notes drafted yet. Press <kbd>E</kbd> in the dungeon to open the editor.</p>
            ) : (
              <>
                <p>Words: {noteWordCount > 0 ? noteWordCount : focusedRoom.noteText.trim().split(/\s+/).filter(Boolean).length}</p>
                <p>
                  Required sections present:{' '}
                  {focusedRoom.validationState.requiredSectionsPresent ? 'yes' : 'no'}
                </p>
                <p>Quality bonus: {focusedRoom.validationState.qualityBonus}/10</p>
                {focusedRoom.noteText ? (
                  <Markdown
                    source={focusedRoom.noteText}
                    className="markdown-body note-body"
                    resolveLocalImage={resolveLocalImage}
                  />
                ) : null}
                <div className="room-section" style={{ marginTop: 16 }}>
                  <h3>Images</h3>
                  {phase === 'scribe' ? (
                    <p className="room-help-text">
                      Open the note editor (<kbd>E</kbd>) to add images and insert them into notes.
                    </p>
                  ) : null}
                  {focusedRoom.attachments.length === 0 ? (
                    <p className="room-help-text">No room images yet.</p>
                  ) : (
                    <ul className="attachment-grid">
                      {focusedRoom.attachments.map((attachment) => {
                        const previewUrl =
                          attachment.sourceType === 'external'
                            ? attachment.externalUrl ?? null
                            : resolveLocalImage(attachment.attachmentId);
                        return (
                          <li key={attachment.attachmentId} className="attachment-card">
                            {previewUrl ? (
                              <img
                                src={previewUrl}
                                alt={attachment.altText ?? attachment.fileName}
                                className="attachment-image"
                              />
                            ) : (
                              <div className="attachment-image attachment-image--missing">
                                Missing image source
                              </div>
                            )}
                            <div className="attachment-meta">
                              <strong>{attachment.fileName}</strong>
                              <p className="room-help-text">{attachment.sourceType}</p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </>
        ) : null}

        {tab === 'artifact' ? (
          <>
            <h2>Artifact</h2>
            {artifactMarkdown ? (
              <Markdown
                source={artifactMarkdown}
                className="markdown-body artifact-body"
                resolveLocalImage={resolveLocalImage}
              />
            ) : (
              <p>Defeat this encounter to generate an artifact.</p>
            )}
          </>
        ) : null}

        {tab === 'selfcheck' ? (
          <>
            <h2>Self-check prompts</h2>
            {selfCheckPrompts.length === 0 ? (
              <p>Defeat this encounter to unlock self-check prompts.</p>
            ) : (
              <ol>
                {selfCheckPrompts.map((p) => (
                  <li key={p.promptId}>{p.text}</li>
                ))}
              </ol>
            )}
            <p style={{ marginTop: 12, color: 'var(--text-muted)' }}>
              Reviewed {focusedRoom.reviewPassCount} time(s).
            </p>
          </>
        ) : null}
      </div>
    </aside>
  );
}
