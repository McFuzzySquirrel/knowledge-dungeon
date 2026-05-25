import { useMemo, useState, type JSX } from 'react';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import { useSubjectStore } from '@/store/subjectStore';
import { useSessionStore } from '@/store/sessionStore';
import {
  evaluateReviewUnlock,
  extractMarkdownHeadings,
  generateSelfCheckPrompts,
} from '@/core/review';
import { generateRoomArtifact } from '@/core/artifacts';

type RoomTab = 'topic' | 'notes' | 'artifact' | 'selfcheck';

interface RoomPanelProps {
  snapshot: SubjectSnapshot;
  focusedRoom: RoomMetadata | null;
  onInteract: () => void;
}

export function RoomPanel({ snapshot, focusedRoom, onInteract }: RoomPanelProps): JSX.Element {
  const [tab, setTab] = useState<RoomTab>('topic');
  const addChildRoom = useSubjectStore((s) => s.addChildRoom);
  const removeRoom = useSubjectStore((s) => s.removeRoom);
  const phase = useSessionStore((s) => s.phase);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const [draftTopic, setDraftTopic] = useState('');

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
    ? generateRoomArtifact({
        subjectName: snapshot.dungeon.subjectName,
        roomId: focusedRoom.roomId,
        roomTopic: focusedRoom.topic,
        noteText: '',
        criterionScores: focusedRoom.validationState.criterionScores,
        qualityBonus: focusedRoom.validationState.qualityBonus,
        generatedAtIso: focusedRoom.updatedAt,
      }).markdown
    : null;

  const relatedTopics = snapshot.dungeon.edges
    .filter((e) => e.fromRoomId === focusedRoom.roomId || e.toRoomId === focusedRoom.roomId)
    .map((e) => {
      const otherId = e.fromRoomId === focusedRoom.roomId ? e.toRoomId : e.fromRoomId;
      return snapshot.rooms[otherId]?.topic ?? otherId;
    });

  const selfCheckPrompts = focusedRoom.validationState.finalPass
    ? generateSelfCheckPrompts({
        roomId: focusedRoom.roomId,
        subjectName: snapshot.dungeon.subjectName,
        roomTopic: focusedRoom.topic,
        noteHeadings: artifactMarkdown ? extractMarkdownHeadings(artifactMarkdown) : [],
        relatedTopics,
      })
    : [];

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
            <p style={{ marginTop: 12 }}>Room id: {focusedRoom.roomId}</p>
            <p>Edges: {relatedTopics.length}</p>
            {phase === 'creator' ? (
              <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
                <h3>Add a child topic</h3>
                <input
                  type="text"
                  placeholder="New topic name"
                  value={draftTopic}
                  onChange={(e) => setDraftTopic(e.target.value)}
                />
                <button
                  type="button"
                  disabled={!draftTopic.trim()}
                  onClick={() => {
                    void addChildRoom(focusedRoom.roomId, draftTopic.trim()).then(() =>
                      setDraftTopic(''),
                    );
                  }}
                >
                  Add child room
                </button>
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
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
                    The root topic cannot be deleted.
                  </p>
                )}
              </div>
            ) : null}
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
