import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import {
  NOTE_BADGE_WORD_COUNT,
  evaluateNoteValidation,
  REQUIRED_NOTE_SECTIONS,
} from '@/core/validation/notes';
import type { QualityScoreKey } from '@/core/validation/persistence';
import { SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression';
import { ToastStack } from '@/ui/components/ToastStack';
import { Markdown } from '@/ui/utils/markdown';
import {
  composeNoteSections,
  emptyNoteSections,
  extractNoteSections,
} from '@/ui/utils/noteSections';
import { useToasts } from '@/ui/utils/useToasts';

const CRITERION_LABELS: Record<QualityScoreKey, string> = {
  sectionCompleteness: 'Required sections',
  conceptTermCoverage: 'Topic terms covered',
  linkReferences: 'Links & references',
  recallQuestionQuality: 'Recall questions',
  clarityReadability: 'Readability',
};

function getCriterionHint(criterion: QualityScoreKey, score: number): string {
  if (score === 2) return '';
  const hints: Record<QualityScoreKey, string> = {
    sectionCompleteness: 'Include Summary, Key Points, and Recall Question headings.',
    conceptTermCoverage: 'Use key terms from the room topic throughout your note.',
    linkReferences: score === 0 ? 'Add 2+ links or "see also" references.' : 'Add one more link or reference.',
    recallQuestionQuality: 'Write 2+ questions in the Recall Question section.',
    clarityReadability: 'Aim for 8-24 words per sentence and at least 2 paragraphs.',
  };
  return hints[criterion];
}

const TEMPLATE = composeNoteSections(emptyNoteSections());
const DEFAULT_EXPANDED = true;

export function NoteEditorModal(): JSX.Element | null {
  const isOpen = useSessionStore((s) => s.isNoteEditorOpen);
  const roomId = useSessionStore((s) => s.noteEditorRoomId);
  const pendingInsert = useSessionStore((s) => s.noteEditorPendingInsert);
  const clearPendingInsert = useSessionStore((s) => s.clearNoteEditorPendingInsert);
  const phase = useSessionStore((s) => s.phase);
  const close = useSessionStore((s) => s.closeNoteEditor);
  const snapshot = useSubjectStore((s) => s.snapshot);
  const submitNote = useSubjectStore((s) => s.submitNote);
  const addLocalAttachment = useSubjectStore((s) => s.addLocalAttachment);
  const addExternalAttachment = useSubjectStore((s) => s.addExternalAttachment);
  const removeAttachment = useSubjectStore((s) => s.removeAttachment);
  const resolveAttachmentUrl = useSubjectStore((s) => s.resolveAttachmentUrl);
  const awardRoomClear = useProgressionStore((s) => s.awardRoomClear);
  const awardBadge = useProgressionStore((s) => s.awardBadge);

  const room = roomId ? snapshot?.rooms[roomId] : null;
  const [sections, setSections] = useState(() => emptyNoteSections());
  const [activeSection, setActiveSection] = useState<(typeof REQUIRED_NOTE_SECTIONS)[number]>(
    REQUIRED_NOTE_SECTIONS[0],
  );
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [expanded, setExpanded] = useState(DEFAULT_EXPANDED);
  const [showHelp, setShowHelp] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const [showImagesPanel, setShowImagesPanel] = useState(false);
  const [hasEditedNote, setHasEditedNote] = useState(false);
  const [externalImageUrl, setExternalImageUrl] = useState('');
  const [isSavingAttachment, setIsSavingAttachment] = useState(false);
  const [showImageLibrary, setShowImageLibrary] = useState(false);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const { toasts, pushToast } = useToasts();
  const noteText = useMemo(() => composeNoteSections(sections), [sections]);

  useEffect(() => {
    if (!isOpen || !room) return;
    setSections(extractNoteSections(room.noteText || TEMPLATE));
    setActiveSection(REQUIRED_NOTE_SECTIONS[0]);
    setConfirm(room.validationState.manualConfirmed);
    setShowPreview(false);
    setExpanded(DEFAULT_EXPANDED);
    setShowHelp(false);
    setShowChecks(false);
    setShowImagesPanel(false);
    setHasEditedNote(false);
    setExternalImageUrl('');
    setShowImageLibrary(false);
  }, [isOpen, room]);

  useEffect(() => {
    if (!isOpen || !room || !pendingInsert) return;
    setSections((current) => ({
      ...current,
      [activeSection]: `${current[activeSection].trimEnd()}\n${pendingInsert}`.trim(),
    }));
    setHasEditedNote(true);
    clearPendingInsert();
  }, [activeSection, clearPendingInsert, isOpen, pendingInsert, room]);

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
    const emptySections = REQUIRED_NOTE_SECTIONS.filter(
      (section) => sections[section].trim().length === 0,
    );
    if (emptySections.length > 0) {
      hints.push(`Add notes in: ${emptySections.join(', ')}.`);
    }
    if (!preview.manualConfirmed) {
      hints.push('Check the confirmation box before defeating this encounter.');
    }
    return hints;
  }, [preview, sections]);

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

  const insertAttachmentToken = useCallback((token: string) => {
    setSections((current) => ({
      ...current,
      [activeSection]: `${current[activeSection].trimEnd()}\n${token}`.trim(),
    }));
    setHasEditedNote(true);
  }, [activeSection]);

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
      <div className={`modal note-editor-modal${expanded ? ' note-editor-modal--expanded' : ''}`}>
        <h2>Encounter: {room.topic}</h2>
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
          <button type="button" aria-pressed={showHelp} onClick={() => setShowHelp((value) => !value)}>
            Help
          </button>
          <button
            type="button"
            aria-pressed={showImagesPanel}
            onClick={() => setShowImagesPanel((value) => !value)}
          >
            Images
          </button>
          <button
            type="button"
            aria-pressed={showChecks}
            onClick={() => setShowChecks((value) => !value)}
          >
            Checks
          </button>
          <button type="button" aria-pressed={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
        {showHelp ? (
          <div className="note-editor-help">
            <p>
              Write as much or as little as needed. Include {REQUIRED_NOTE_SECTIONS.join(', ')}{' '}
              sections to defeat this encounter and generate its artifact. Reach{' '}
              {NOTE_BADGE_WORD_COUNT}+ words to earn a special badge.
            </p>
            <p className="room-help-text">
              Select a section chip and write that section. The editor keeps required headings for
              you so accidental full-note replacement is less likely.
            </p>
            <p className="room-help-text">
              Rich text: use <code>[label](https://example.com)</code> for clickable links,
              <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, and{' '}
              <code>-</code> for bullets.
            </p>
          </div>
        ) : null}
        <ToastStack toasts={toasts} className="toast-stack--inline" />
        {showImagesPanel ? (
          <div className="note-images-section">
            <span className="note-images-label">Images</span>
            {phase === 'scribe' ? (
              <div className="note-images-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={isSavingAttachment}
                  onClick={() => {
                    setIsSavingAttachment(true);
                    void addLocalAttachment(room.roomId)
                      .then((created) => {
                        if (!created) {
                          pushToast('info', 'No image selected.');
                          return;
                        }
                        pushToast('info', 'Image attached to room.');
                      })
                      .catch((error: unknown) => {
                        const message =
                          error instanceof Error ? error.message : 'Failed to attach local image.';
                        pushToast('error', message);
                      })
                      .finally(() => {
                        setIsSavingAttachment(false);
                      });
                  }}
                >
                  + Local
                </button>
                <input
                  type="url"
                  value={externalImageUrl}
                  onChange={(event) => setExternalImageUrl(event.target.value)}
                  placeholder="https://example.com/image.png"
                  aria-label="External image URL"
                  className="note-images-url-input"
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={isSavingAttachment || externalImageUrl.trim().length === 0}
                  onClick={() => {
                    const nextUrl = externalImageUrl.trim();
                    if (nextUrl.length === 0) return;
                    setIsSavingAttachment(true);
                    void addExternalAttachment(room.roomId, nextUrl)
                      .then((created) => {
                        if (!created) {
                          pushToast('info', 'No external image was added.');
                          return;
                        }
                        setExternalImageUrl('');
                        pushToast('info', 'External image attached to room.');
                      })
                      .catch((error: unknown) => {
                        const message =
                          error instanceof Error ? error.message : 'Failed to attach external image URL.';
                        pushToast('error', message);
                      })
                      .finally(() => {
                        setIsSavingAttachment(false);
                      });
                  }}
                >
                  + URL
                </button>
              </div>
            ) : (
              <span className="room-help-text">Scribe phase only.</span>
            )}
            {room.attachments.length === 0 ? (
              <p className="room-help-text">No room images yet.</p>
            ) : (
              <>
                <button
                  type="button"
                  className="ghost"
                  aria-expanded={showImageLibrary}
                  onClick={() => setShowImageLibrary((current) => !current)}
                >
                  {showImageLibrary
                    ? `Hide image library (${room.attachments.length})`
                    : `Show image library (${room.attachments.length})`}
                </button>
                {showImageLibrary ? (
                  <ul className="attachment-grid attachment-grid--compact">
                    {room.attachments.map((attachment) => {
                      const previewUrl =
                        attachment.sourceType === 'external'
                          ? attachment.externalUrl ?? null
                          : attachmentUrls[attachment.attachmentId] ?? null;
                      const markdownToken =
                        attachment.sourceType === 'local'
                          ? `![${attachment.altText ?? attachment.fileName}](local:${attachment.attachmentId})`
                          : `![${attachment.altText ?? attachment.fileName}](${attachment.externalUrl ?? ''})`;
                      return (
                        <li key={attachment.attachmentId} className="attachment-card attachment-card--compact">
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
                          <div className="attachment-card-actions">
                            {phase === 'scribe' ? (
                              <>
                                <button
                                  type="button"
                                  className="ghost"
                                  aria-label={`Insert ${attachment.fileName} in note`}
                                  onClick={() => insertAttachmentToken(markdownToken)}
                                >
                                  Insert in note
                                </button>
                                <button
                                  type="button"
                                  className="danger"
                                  aria-label={`Remove ${attachment.fileName}`}
                                  onClick={() => {
                                    void removeAttachment(room.roomId, attachment.attachmentId)
                                      .then(() => {
                                        pushToast('info', 'Attachment removed from room.');
                                      })
                                      .catch((error: unknown) => {
                                        const message =
                                          error instanceof Error
                                            ? error.message
                                            : 'Failed to remove attachment.';
                                        pushToast('error', message);
                                      });
                                  }}
                                >
                                  Remove
                                </button>
                              </>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </>
            )}
          </div>
        ) : null}
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
          <>
            <div className="note-section-chips" role="tablist" aria-label="Note sections">
              {REQUIRED_NOTE_SECTIONS.map((section) => (
                <button
                  key={section}
                  type="button"
                  role="tab"
                  aria-selected={activeSection === section}
                  className={activeSection === section ? 'note-section-chip is-active' : 'note-section-chip'}
                  onClick={() => setActiveSection(section)}
                >
                  {section}
                </button>
              ))}
            </div>
            <label className="note-section-label" htmlFor="note-section-editor">
              {activeSection}
            </label>
            <textarea
              id="note-section-editor"
              rows={14}
              value={sections[activeSection]}
              onChange={(e) => {
                const nextValue = e.target.value;
                setSections((current) => ({
                  ...current,
                  [activeSection]: nextValue,
                }));
                setHasEditedNote(true);
              }}
            />
          </>
        )}

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          I confirm these notes are my own and complete.
        </label>

        {preview && showChecks ? (
          <div style={{ marginTop: 12 }}>
            <ul className="validation-list">
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
            </ul>

            {!showNeutralChecklist ? (
              <>
                <hr style={{ opacity: 0.2, margin: '8px 0' }} />
                <ul className="validation-list">
                  {preview.rubric.map((entry) => {
                    const score = entry.score;
                    const hint = getCriterionHint(entry.criterion, score);
                    return (
                      <li key={entry.criterion}>
                        <span>
                          <strong>{CRITERION_LABELS[entry.criterion]}</strong>
                          {hint ? <span style={{ display: 'block', fontSize: 12, opacity: 0.75 }}>{hint}</span> : null}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span className={score === 2 ? 'pass' : score === 1 ? '' : 'fail'}>
                            {score}/2
                          </span>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: score === 2 ? '#4ade80' : score === 1 ? '#facc15' : '#f87171',
                              display: 'inline-block',
                            }}
                          />
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p style={{ fontSize: 12, margin: '4px 0 0', opacity: 0.6 }}>
                  Quality bonus: {preview.qualityBonus}/10 &middot; Each criterion scored 0–2
                </p>
              </>
            ) : null}
          </div>
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
