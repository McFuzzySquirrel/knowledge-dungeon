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
import { ToastStack } from '@/ui/components/ToastStack';
import { Markdown } from '@/ui/utils/markdown';
import { useToasts } from '@/ui/utils/useToasts';

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
  const pendingInsert = useSessionStore((s) => s.noteEditorPendingInsert);
  const clearPendingInsert = useSessionStore((s) => s.clearNoteEditorPendingInsert);
  const close = useSessionStore((s) => s.closeNoteEditor);
  const snapshot = useSubjectStore((s) => s.snapshot);
  const submitNote = useSubjectStore((s) => s.submitNote);
  const resolveAttachmentUrl = useSubjectStore((s) => s.resolveAttachmentUrl);
  const awardRoomClear = useProgressionStore((s) => s.awardRoomClear);
  const awardBadge = useProgressionStore((s) => s.awardBadge);

  const room = roomId ? snapshot?.rooms[roomId] : null;
  const [noteText, setNoteText] = useState(TEMPLATE);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [hasEditedNote, setHasEditedNote] = useState(false);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const { toasts, pushToast } = useToasts();

  useEffect(() => {
    if (!isOpen || !room) return;
    setNoteText(room.noteText || TEMPLATE);
    setConfirm(room.validationState.manualConfirmed);
    setShowPreview(false);
    setHasEditedNote(false);
  }, [isOpen, room]);

  useEffect(() => {
    if (!isOpen || !room || !pendingInsert) return;
    setNoteText((current) => `${current.trimEnd()}\n\n${pendingInsert}\n`);
    clearPendingInsert();
  }, [clearPendingInsert, isOpen, pendingInsert, room]);

  const preview = useMemo(() => {
    if (!room) return null;
    return evaluateNoteValidation({
      noteText,
      manualConfirmed: confirm,
      roomTopic: room.topic,
    });
  }, [noteText, confirm, room]);

  const showNeutralChecklist = !hasEditedNote && (room?.noteText.trim().length ?? 0) === 0;
  const missingRequirementHints = useMemo(() => {
    if (!preview || preview.finalPass) return [];
    const hints: string[] = [];
    if (preview.missingSections.length > 0) {
      hints.push(`Add sections: ${preview.missingSections.join(', ')}.`);
    }
    if (!preview.manualConfirmed) {
      hints.push('Check the confirmation box before defeating this encounter.');
    }
    return hints;
  }, [preview]);

  useEffect(() => {
    if (!isOpen || !room) {
      setAttachmentUrls({});
      return;
    }

    let cancelled = false;
    const localAttachments = room.attachments.filter((attachment) => attachment.sourceType === 'local');
    if (localAttachments.length === 0) {
      setAttachmentUrls({});
      return;
    }

    void Promise.all(
      localAttachments.map(async (attachment) => {
        const resolved = await resolveAttachmentUrl(room.roomId, attachment.attachmentId);
        return [attachment.attachmentId, resolved] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setAttachmentUrls(
        Object.fromEntries(
          results.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        ),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, resolveAttachmentUrl, room]);

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
        return;
      }
      pushToast('info', 'Draft saved. Add required sections/quality checks to submit.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit note.';
      pushToast('error', message);
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
          Replace the template placeholders with your own notes. Keep section headings so the
          encounter validator can detect your structure.
        </p>
        <p className="room-help-text">
          Rich text: use <code>[label](https://example.com)</code> for clickable links,
          <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, and{' '}
          <code>-</code> for bullets.
        </p>
        <p className="room-help-text">
          In Scribe phase, use the room Images section and tap <code>Insert in note</code>
          to place images in your notes.
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
        <ToastStack toasts={toasts} className="toast-stack--inline" />
        {showPreview ? (
          <div
            className="markdown-body note-body note-preview"
            aria-label="Notes preview"
          >
            <Markdown
              source={noteText}
              resolveLocalImage={(attachmentId) => attachmentUrls[attachmentId] ?? null}
            />
          </div>
        ) : (
          <textarea
            rows={14}
            value={noteText}
            onChange={(e) => {
              setNoteText(e.target.value);
              setHasEditedNote(true);
            }}
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
            {(showNeutralChecklist
              ? preview.criteria.map((criterion) => ({
                  ...criterion,
                  passed: true,
                  message:
                    criterion.code === 'VAL_REQUIRED_SECTION_MISSING'
                      ? `Keep headings: ${REQUIRED_NOTE_SECTIONS.join(', ')}.`
                      : criterion.code === 'VAL_MANUAL_CONFIRM_REQUIRED'
                        ? 'Tick confirmation when your draft is ready to submit.'
                        : criterion.message,
                }))
              : preview.criteria
            ).map((c) => (
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
                  {showNeutralChecklist
                    ? '•'
                    : c.code === 'VAL_WORD_COUNT_BONUS_TARGET'
                      ? c.passed
                        ? '★'
                        : '○'
                      : c.passed
                        ? '✓'
                        : '✗'}
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
          {missingRequirementHints.length > 0 ? (
            <div className="note-submit-hints" aria-live="polite">
              {missingRequirementHints.map((hint) => (
                <p key={hint}>{hint}</p>
              ))}
            </div>
          ) : null}
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting
              ? 'Submitting…'
              : preview?.finalPass
                ? 'Defeat encounter'
                : 'Save draft'}
          </button>
        </div>
      </div>
    </div>
  );
}
