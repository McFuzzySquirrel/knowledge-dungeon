/**
 * Tag editing for one room.
 *
 * ## Two wirings, one markup
 *
 * Phase 4f declared this component and nothing rendered it: it had no call site until
 * Phase 14, whose deliverables include "working tag and cross-link UI". Rather than write a
 * second tag surface inside the Creator workspace, the component takes its tags and its
 * two actions as props when a caller supplies them, and falls back to the subject store's
 * own tag actions when it does not:
 *
 * - **Controlled** - the Creator workspace passes `tags`, `onAddTag`, and `onRemoveTag`,
 *   which dispatch the `graph/tag-add` and `graph/tag-remove` commands through the
 *   application layer. The workspace's live sentence and pending state then cover tags
 *   exactly as they cover every other verb.
 * - **Store-backed** - the historical behaviour, untouched: read the room from the store,
 *   call `addRoomTag` / `removeRoomTag`. Both store actions still exist because
 *   `VITE_CREATOR_WORKSPACE=false` renders the pre-Phase-14 Creator view.
 *
 * ## Every control explains itself
 *
 * The add button is disabled when the field is empty and says so in visible text, for the
 * reason `src/ui/study/StudyControls.tsx` records: a disabled control is not focusable, so
 * a reason that lives only in `aria-describedby` is unreachable exactly when it matters.
 * Each remove button's accessible name carries the tag it removes.
 */
import { useId, useState, type JSX, type KeyboardEvent } from 'react';
import { useSubjectStore } from '@/store/subjectStore';

import { STUDY_TOUCH_TARGET_STYLE } from '@/ui/study/StudyControls';

export interface TagEditorProps {
  readonly roomId: string;
  /**
   * The tags to render.
   *
   * Omit it to read the room from the subject store, which is the pre-Phase-14 wiring.
   */
  readonly tags?: readonly string[];
  readonly onAddTag?: (tag: string) => void;
  readonly onRemoveTag?: (tag: string) => void;
  /**
   * Whether the tag commands are disabled, with the sentence that says why.
   *
   * A workspace mid-flight passes its pending state here, so the tag controls cannot be
   * double-fired while a previous command is committing.
   */
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export function TagEditor({
  roomId,
  tags: controlledTags,
  onAddTag,
  onRemoveTag,
  disabled = false,
  disabledReason,
}: TagEditorProps): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  const storeAddRoomTag = useSubjectStore((s) => s.addRoomTag);
  const storeRemoveRoomTag = useSubjectStore((s) => s.removeRoomTag);

  const [inputValue, setInputValue] = useState('');

  const tags = controlledTags ?? snapshot?.rooms[roomId]?.tags ?? [];

  const addTag = (tag: string): void => {
    if (disabled) return;
    if (onAddTag !== undefined) onAddTag(tag);
    else void storeAddRoomTag(roomId, tag);
  };

  const deleteTag = (tag: string): void => {
    if (disabled) return;
    if (onRemoveTag !== undefined) onRemoveTag(tag);
    else void storeRemoveRoomTag(roomId, tag);
  };

  const handleAddTag = (): void => {
    const trimmed = inputValue.trim();
    if (trimmed.length === 0) return;
    addTag(trimmed);
    setInputValue('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddTag();
    } else if (event.key === 'Backspace' && inputValue.length === 0 && tags.length > 0) {
      const lastTag = tags[tags.length - 1];
      if (lastTag !== undefined) deleteTag(lastTag);
    }
  };

  const addRefusal = disabled
    ? null
    : inputValue.trim().length === 0
      ? 'Type a tag first, then add it.'
      : null;
  const blockedNote = disabled
    ? disabledReason ?? 'Waiting for the previous change to be applied.'
    : null;
  const addReasonId = useId();

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
              disabled={disabled}
              data-study-touch-target="tag-remove"
              style={STUDY_TOUCH_TARGET_STYLE}
              onClick={() => deleteTag(tag)}
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
          disabled={disabled}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="New tag"
          aria-describedby={addRefusal === null ? undefined : addReasonId}
          data-study-touch-target="tag-input"
          style={STUDY_TOUCH_TARGET_STYLE}
        />
        <button
          type="button"
          className="ghost tag-add-btn"
          onClick={handleAddTag}
          disabled={addRefusal !== null}
          data-study-touch-target="tag-add"
          style={STUDY_TOUCH_TARGET_STYLE}
        >
          Add
        </button>
      </div>
      {addRefusal === null ? null : (
        <p className="room-help-text" id={addReasonId}>
          {addRefusal}
        </p>
      )}
      {blockedNote === null ? null : <p className="room-help-text">{blockedNote}</p>}
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
              data-study-touch-target="tag-nav-room"
              style={STUDY_TOUCH_TARGET_STYLE}
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
