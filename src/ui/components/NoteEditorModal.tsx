import { useEffect, useMemo, useState, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import {
  NOTE_BADGE_WORD_COUNT,
  evaluateNoteValidation,
  REQUIRED_NOTE_SECTIONS,
} from '@/core/validation/notes';
import { SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression';
import { Markdown } from '@/ui/utils/markdown';

const TEMPLATE = `Summary
(Write at least one paragraph summarising the topic in your own words.)

Key Points
- Point 1
- Point 2
- Point 3

Recall Question
Why does this matter? See also [related topic](#).
`;

export function NoteEditorModal(): JSX.Element | null {
  const isOpen = useSessionStore((s) => s.isNoteEditorOpen);
  const roomId = useSessionStore((s) => s.noteEditorRoomId);
  const close = useSessionStore((s) => s.closeNoteEditor);
  const snapshot = useSubjectStore((s) => s.snapshot);
  const submitNote = useSubjectStore((s) => s.submitNote);
  const awardRoomClear = useProgressionStore((s) => s.awardRoomClear);
  const awardBadge = useProgressionStore((s) => s.awardBadge);

  const room = roomId ? snapshot?.rooms[roomId] : null;
  const [noteText, setNoteText] = useState(TEMPLATE);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!isOpen || !room) return;
    setNoteText(room.noteText || TEMPLATE);
    setConfirm(false);
    setShowPreview(false);
  }, [isOpen, room]);

  const preview = useMemo(() => {
    if (!room) return null;
    return evaluateNoteValidation({
      noteText,
      manualConfirmed: confirm,
      roomTopic: room.topic,
    });
  }, [noteText, confirm, room]);

  if (!isOpen || !room || !snapshot) return null;

  async function handleSubmit() {
    if (!room) return;
    setSubmitting(true);
    try {
      const result = await submitNote(room.roomId, noteText, confirm);
      if (result.finalPass) {
        const totalRooms = snapshot!.dungeon.rooms.length;
        const cleared = Object.values(snapshot!.rooms).filter(
          (r) => r.validationState.finalPass,
        ).length;
        awardRoomClear({
          qualityBonus: result.qualityBonus,
          totalRooms,
          creatorMappedRooms: totalRooms,
          scribeClearedRooms: cleared + 1,
          archaeologistFullReviewPasses: 0,
        });
        if (result.wordCount >= NOTE_BADGE_WORD_COUNT) {
          awardBadge(SCRIBE_CENTURY_120_BADGE_ID);
        }
        close();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Note editor">
      <div className="modal">
        <h2>Encounter: {room.topic}</h2>
        <p>
          Write as much or as little as needed. Include {REQUIRED_NOTE_SECTIONS.join(', ')}{' '}
          sections to defeat this encounter and generate its artifact. Reach{' '}
          {NOTE_BADGE_WORD_COUNT}+ words to earn a special badge.
        </p>
        <p className="room-help-text">
          Rich text: use <code>[label](https://example.com)</code> for clickable links,
          <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, and{' '}
          <code>-</code> for bullets.
        </p>
        <div className="note-editor-toolbar">
          <button
            type="button"
            aria-pressed={!showPreview}
            onClick={() => setShowPreview(false)}
          >
            Edit
          </button>
          <button
            type="button"
            aria-pressed={showPreview}
            onClick={() => setShowPreview(true)}
          >
            Preview
          </button>
        </div>
        {showPreview ? (
          <div
            className="markdown-body note-body note-preview"
            aria-label="Notes preview"
          >
            <Markdown source={noteText} />
          </div>
        ) : (
          <textarea
            rows={14}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
        )}

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          I confirm these notes are my own and complete.
        </label>

        {preview ? (
          <ul className="validation-list" style={{ marginTop: 12 }}>
            {preview.criteria.map((c) => (
              <li key={c.code}>
                <span>{c.message}</span>
                <span
                  className={
                    c.code === 'VAL_WORD_COUNT_BONUS_TARGET'
                      ? c.passed
                        ? 'pass'
                        : ''
                      : c.passed
                        ? 'pass'
                        : 'fail'
                  }
                >
                  {c.code === 'VAL_WORD_COUNT_BONUS_TARGET' ? (c.passed ? '★' : '○') : c.passed ? '✓' : '✗'}
                </span>
              </li>
            ))}
            <li>
              <span>Words</span>
              <span>{preview.wordCount}</span>
            </li>
            <li>
              <span>Quality bonus</span>
              <span>{preview.qualityBonus}/10</span>
            </li>
          </ul>
        ) : null}

        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || !preview?.finalPass}
            onClick={() => void handleSubmit()}
          >
            {submitting ? 'Submitting…' : 'Defeat encounter'}
          </button>
        </div>
      </div>
    </div>
  );
}
