import { useMemo, useState, type JSX } from 'react';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import {
  deriveGraphHierarchy,
  getConnectedRoomIds,
  isReachableViaSubtopics,
} from '@/core/graph';
import { useSubjectStore } from '@/store/subjectStore';
import { useSessionStore } from '@/store/sessionStore';
import { parseTopicBatch } from '@/ui/utils/topicParsing';
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

  const hierarchy = useMemo(() => deriveGraphHierarchy(snapshot.dungeon), [snapshot.dungeon]);

  const unlock = useMemo(
    () =>
      evaluateReviewUnlock({
        dungeon: snapshot.dungeon,
        rooms: snapshot.rooms,
      }),
    [snapshot],
  );

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

  const artifactMarkdown = focusedRoom.validationState.finalPass
    ? focusedRoom.artifactMarkdown
    : null;

  const connectedRoomIds = getConnectedRoomIds(snapshot.dungeon, focusedRoom.roomId);
  const connectedRooms = connectedRoomIds
    .map((roomId) => snapshot.rooms[roomId])
    .filter((room): room is RoomMetadata => Boolean(room));
  const relatedTopics = connectedRooms.map((room) => room.topic);

  const selfCheckPrompts = focusedRoom.validationState.finalPass
    ? generateSelfCheckPrompts({
        roomId: focusedRoom.roomId,
        subjectName: snapshot.dungeon.subjectName,
        roomTopic: focusedRoom.topic,
        noteHeadings: artifactMarkdown ? extractMarkdownHeadings(artifactMarkdown) : [],
        relatedTopics,
      })
    : [];

  const breadcrumbRooms = hierarchy.breadcrumbRoomIdsByRoomId[focusedRoom.roomId]
    .map((roomId) => snapshot.rooms[roomId])
    .filter((room): room is RoomMetadata => Boolean(room));
  const currentFloorLabel =
    hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[focusedRoom.roomId]];
  const directChildRoomIds = hierarchy.childRoomIdsByParentId[focusedRoom.roomId] ?? [];
  const portalRooms = directChildRoomIds
    .filter((roomId) => (hierarchy.childRoomIdsByParentId[roomId] ?? []).length > 0)
    .map((roomId) => snapshot.rooms[roomId])
    .filter((room): room is RoomMetadata => Boolean(room));
  const currentParentId = hierarchy.parentByRoomId[focusedRoom.roomId];
  const reparentCandidates = snapshot.dungeon.rooms
    .filter(
      (room) =>
        room.roomId !== focusedRoom.roomId &&
        room.roomId !== currentParentId &&
        !isReachableViaSubtopics(snapshot.dungeon, focusedRoom.roomId, room.roomId),
    )
    .sort((left, right) => left.topic.localeCompare(right.topic));

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

            {connectedRooms.length > 0 ? (
              <div className="room-section">
                <h3>Connected topics</h3>
                <div className="linked-topic-list">
                  {connectedRooms.map((room) => (
                    <button
                      key={room.roomId}
                      type="button"
                      className="ghost"
                      onClick={() => onTravelToRoom(room.roomId)}
                    >
                      Travel to {room.topic}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {portalRooms.length > 0 ? (
              <div className="room-section">
                <h3>Portals to deeper floors</h3>
                <div className="linked-topic-list">
                  {portalRooms.map((room) => (
                    <button
                      key={room.roomId}
                      type="button"
                      className="ghost"
                      onClick={() => onTravelToRoom(room.roomId)}
                    >
                      Enter {room.topic}
                    </button>
                  ))}
                </div>
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
                  <pre style={{ whiteSpace: 'pre-wrap' }}>{focusedRoom.noteText}</pre>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {tab === 'artifact' ? (
          <>
            <h2>Artifact</h2>
            {artifactMarkdown ? (
              <pre style={{ whiteSpace: 'pre-wrap' }}>{artifactMarkdown}</pre>
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
