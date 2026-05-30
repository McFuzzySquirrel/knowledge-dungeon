import { useEffect, useMemo, useState, type JSX, type KeyboardEvent } from 'react';
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

interface RoomPanelProps {
  snapshot: SubjectSnapshot;
  focusedRoom: RoomMetadata | null;
  onInteract: () => void;
  onTravelToRoom: (roomId: string) => void;
}

export function RoomPanel({
  snapshot,
  focusedRoom,
  onInteract,
  onTravelToRoom,
}: RoomPanelProps): JSX.Element {
  const [tab, setTab] = useState<RoomTab>('topic');
  const addChildRooms = useSubjectStore((s) => s.addChildRooms);
  const reparentRoom = useSubjectStore((s) => s.reparentRoom);
  const removeRoom = useSubjectStore((s) => s.removeRoom);
  const lastError = useSubjectStore((s) => s.lastError);
  const phase = useSessionStore((s) => s.phase);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const [draftTopics, setDraftTopics] = useState('');
  const [reparentTargetId, setReparentTargetId] = useState('');
  const [sameFloorFilter, setSameFloorFilter] = useState('');
  const [selectedSameFloorRoomId, setSelectedSameFloorRoomId] = useState<string | null>(null);
  const [travelFilter, setTravelFilter] = useState('');
  const [selectedTravelRoomId, setSelectedTravelRoomId] = useState<string | null>(null);
  const [portalFilter, setPortalFilter] = useState('');
  const [selectedPortalRoomId, setSelectedPortalRoomId] = useState<string | null>(null);

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

  const artifactMarkdown = focusedRoom?.validationState.finalPass
    ? focusedRoom.artifactMarkdown
    : null;

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
      <aside className="room-panel">
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
    <aside className="room-panel" aria-label="Room information">
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
        >
          Artifact
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'selfcheck'}
          onClick={() => setTab('selfcheck')}
          disabled={!focusedRoom.validationState.finalPass}
        >
          Self-check
        </button>
      </div>

      <div className="room-tab-body">
        {tab === 'topic' ? (
          <>
            <h2>{focusedRoom.topic}</h2>
            <span className="room-status-chip">{focusedRoom.state}</span>
            <p className="room-meta-line">Room id: {focusedRoom.roomId}</p>
            <p className="room-meta-line">Floor: {currentFloorLabel}</p>
            <p className="room-meta-line">
              Breadcrumbs:{' '}
              {breadcrumbRooms.map((room) => room.topic).join(' → ')}
            </p>
            <p className="room-meta-line">Edges: {relatedTopics.length}</p>

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

            <div style={{ marginTop: 16 }}>
              <button type="button" className="touch-rail interact" onClick={onInteract}>
                {phase === 'archaeologist' ? 'Mark reviewed' : 'Open encounter'}
              </button>
            </div>
            <p style={{ marginTop: 16, color: 'var(--text-muted)' }}>
              Review unlock: {unlock.clearedRooms}/{unlock.totalRooms} rooms cleared
              {unlock.unlocked ? ' (Archaeologist phase available)' : ''}.
            </p>
          </>
        ) : null}

        {tab === 'notes' ? (
          <>
            <h2>Notes</h2>
            {focusedRoom.validationState.wordCount === 0 ? (
              <p>No notes drafted yet. Press <kbd>E</kbd> in the dungeon to open the editor.</p>
            ) : (
              <>
                <p>Words: {focusedRoom.validationState.wordCount}</p>
                <p>
                  Required sections present:{' '}
                  {focusedRoom.validationState.requiredSectionsPresent ? 'yes' : 'no'}
                </p>
                <p>Quality bonus: {focusedRoom.validationState.qualityBonus}/10</p>
                {focusedRoom.noteText ? (
                  <Markdown source={focusedRoom.noteText} className="markdown-body note-body" />
                ) : null}
              </>
            )}
          </>
        ) : null}

        {tab === 'artifact' ? (
          <>
            <h2>Artifact</h2>
            {artifactMarkdown ? (
              <Markdown source={artifactMarkdown} className="markdown-body artifact-body" />
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
