/**
 * Tag Editor - inline tag assignment for rooms during Creator phase.
 *
 * Phase 4f: Tag system for cross-subject topic linking.
 */
import { useState, type JSX, type KeyboardEvent } from 'react';
import { useSubjectStore } from '@/store/subjectStore';

interface Props {
  roomId: string;
}

export function TagEditor({ roomId }: Props): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  const addRoomTag = useSubjectStore((s) => s.addRoomTag);
  const removeRoomTag = useSubjectStore((s) => s.removeRoomTag);

  const [inputValue, setInputValue] = useState('');

  const room = snapshot?.rooms[roomId];
  const tags = room?.tags ?? [];

  const handleAddTag = () => {
    const trimmed = inputValue.trim();
    if (trimmed.length === 0) return;
    void addRoomTag(roomId, trimmed);
    setInputValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === 'Backspace' && inputValue.length === 0 && tags.length > 0) {
      // Remove last tag
      const lastTag = tags[tags.length - 1];
      if (lastTag) void removeRoomTag(roomId, lastTag);
    }
  };

  const handleRemoveTag = (tag: string) => {
    void removeRoomTag(roomId, tag);
  };

  return (
    <div className="tag-editor" role="region" aria-label="Room tags">
      <span className="tag-editor-label">Tags</span>
      <div className="tag-list">
        {tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove tag ${tag}`}
              onClick={() => handleRemoveTag(tag)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          type="text"
          className="tag-input"
          placeholder="Add a tag..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="New tag"
        />
        <button
          type="button"
          className="ghost tag-add-btn"
          onClick={handleAddTag}
          disabled={inputValue.trim().length === 0}
        >
          Add
        </button>
      </div>
      <p className="room-help-text" style={{ marginTop: 4 }}>
        Tags link this room to similar topics across all subjects.
      </p>
    </div>
  );
}

/**
 * Cross-subject tag navigation component - shows rooms across all
 * subjects matching a given tag.
 */
interface TagNavigationProps {
  tag: string;
  onNavigate: (subjectId: string, roomId: string) => void;
}

export function TagNavigation({ tag, onNavigate }: TagNavigationProps): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  if (!snapshot) return <></>;

  const tagIndex = snapshot.dungeon.tagIndex ?? {};
  const roomIds = tagIndex[tag] ?? [];
  const matchingRooms = roomIds
    .map((roomId) => {
      const room = snapshot.rooms[roomId];
      if (!room) return null;
      return {
        roomId: room.roomId,
        topic: room.topic,
        tags: room.tags ?? [],
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (matchingRooms.length <= 1) return <></>;

  return (
    <div className="tag-navigation">
      <span className="tag-navigation-label">
        Also tagged with <strong>{tag}</strong>:
      </span>
      <div className="tag-navigation-rooms">
        {matchingRooms
          .filter((r) => r.roomId !== snapshot?.dungeon.rootRoomId || matchingRooms.length === 1)
          .map((room) => (
            <button
              key={room.roomId}
              type="button"
              className="ghost tag-nav-room-btn"
              onClick={() => onNavigate(snapshot.dungeon.dungeonId, room.roomId)}
            >
              {room.topic}
              {room.tags.length > 1 ? (
                <span className="tag-nav-extra-tags">
                  +{room.tags.length - 1} more
                </span>
              ) : null}
            </button>
          ))}
      </div>
    </div>
  );
}
