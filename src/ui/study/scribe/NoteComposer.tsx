/**
 * The Scribe workspace's writing surface.
 *
 * ## What is ported rather than described
 *
 * Every capability the pre-Phase-15 note editor had for *writing* is here, on the same
 * utilities, because a redesign that drops a capability is a regression the learner
 * notices:
 *
 * | Capability | Where it comes from |
 * | --- | --- |
 * | Section tablist over the three required sections | `extractNoteSections` / `composeNoteSections` from `@/ui/utils/noteSections`, and `REQUIRED_NOTE_SECTIONS` |
 * | Markdown syntax highlighting behind the textarea | `tokenizeForHighlighting` + `renderHighlightHtml`, with the textarea's scroll synced to the overlay |
 * | The formatting toolbar | `insertFormatting`, the same cursor-and-selection rewrite |
 * | Markdown preview, including device-local images | `Markdown` with `resolveLocalImage` |
 * | Manual confirmation | the same checkbox, still never ticked for the learner |
 * | Image attach, preview, insert-in-note, remove | `encounter/attachment-add`, `-add-external`, `-remove`, and the device-local store |
 *
 * ## The rule this file exists to keep
 *
 * **No dispatch leaves an effect.** Every command below runs from an `onClick` or an
 * `onChange`. The two effects in this file set presentation state only: one mirrors the
 * textarea's scroll onto the highlight overlay's DOM node, the other drains a one-shot
 * pending insert that the session store is holding for this encounter. Neither submits
 * a note, attaches an image, or collects an artifact.
 *
 * ## Privacy
 *
 * There is no `fetch`, no `XMLHttpRequest`, no `FormData`, no beacon, and no request of
 * any kind in this file. A picked image goes to `encounter/attachment-add`, which is the
 * device-local write; an external link is *recorded*, never resolved. Object URLs come
 * from the device-local attachment store and are revoked when the workspace re-resolves
 * them or unmounts, so opening the image library repeatedly does not accumulate blobs.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';

import type { RoomAttachment, RoomMetadata } from '@/core/validation/persistence';
import { REQUIRED_NOTE_SECTIONS, type RequiredNoteSection } from '@/core/validation/notes';
import { Markdown } from '@/ui/utils/markdown';
import { renderHighlightHtml, tokenizeForHighlighting } from '@/ui/utils/markdownHighlight';
import type { NoteSections } from '@/ui/utils/noteSections';

import {
  StudyActionButton,
  StudyTextInput,
  STUDY_TOUCH_TARGET_ATTRIBUTE,
  STUDY_TOUCH_TARGET_STYLE,
} from '../StudyControls';
import { SCRIBE_CONTROL_IDS, SCRIBE_SECTION_TAB_IDS } from '../controlIds';
import { SCRIBE_COMMAND_SCOPES, type ScribeEncounterActions } from './useScribeEncounterActions';

/** The image types the picker offers, matching the pre-Phase-15 picker. */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';

/**
 * The formatting toolbar, as data.
 *
 * `key` is a static slug used only as a React key. `before`/`after` are the literal
 * markdown the tool wraps a selection in, which is what `insertFormatting` has always
 * written.
 */
const FORMATTING_TOOLS: readonly {
  readonly key: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly placeholder: string;
}[] = [
  { key: 'bold', label: 'Bold', before: '**', after: '**', placeholder: 'bold text' },
  { key: 'italic', label: 'Italic', before: '*', after: '*', placeholder: 'italic text' },
  { key: 'code', label: 'Code', before: '`', after: '`', placeholder: 'code' },
  { key: 'link', label: 'Link', before: '[', after: '](https://)', placeholder: 'link text' },
  { key: 'image', label: 'Image', before: '![', after: '](https://)', placeholder: 'alt text' },
  { key: 'bullet', label: 'Bullet list', before: '- ', after: '', placeholder: '' },
  { key: 'heading-2', label: 'Heading', before: '## ', after: '', placeholder: '' },
  { key: 'heading-3', label: 'Subheading', before: '### ', after: '', placeholder: '' },
  { key: 'quote', label: 'Quote', before: '> ', after: '', placeholder: '' },
  { key: 'divider', label: 'Divider', before: '\n---\n', after: '', placeholder: '' },
];

/**
 * The markdown token for one attachment.
 *
 * A device-local attachment becomes a `local:` reference, which `Markdown` resolves
 * through `resolveLocalImage` - so a preview never turns a local file into a URL.
 */
function markdownTokenFor(attachment: RoomAttachment): string {
  const label = attachment.altText ?? attachment.fileName;
  return attachment.sourceType === 'local'
    ? `![${label}](local:${attachment.attachmentId})`
    : `![${label}](${attachment.externalUrl ?? ''})`;
}

export interface NoteComposerProps {
  /** The room being written, or `null` when the encounter has no room. */
  readonly room: RoomMetadata | null;
  /** The three section bodies, owned by the workspace so it can build the view model. */
  readonly sections: NoteSections;
  readonly activeSection: RequiredNoteSection;
  /** The learner's own confirmation. Never set for them. */
  readonly manualConfirmed: boolean;
  /** The whole note as composed from {@link sections}. */
  readonly noteText: string;
  /** Whether submitting now would defeat the encounter. Drives the submit label only. */
  readonly canClear: boolean;
  readonly onSectionChange: (section: RequiredNoteSection, value: string) => void;
  readonly onActiveSectionChange: (section: RequiredNoteSection) => void;
  readonly onManualConfirmedChange: (confirmed: boolean) => void;
  /** Mark the draft as edited, which turns the neutral checklist into real failures. */
  readonly onEdited: () => void;
  readonly resolveLocalImage: (attachmentId: string) => string | null;
  readonly actions: ScribeEncounterActions;
}

export function NoteComposer({
  room,
  sections,
  activeSection,
  manualConfirmed,
  noteText,
  canClear,
  onSectionChange,
  onActiveSectionChange,
  onManualConfirmedChange,
  onEdited,
  resolveLocalImage,
  actions,
}: NoteComposerProps): ReactNode {
  const [showPreview, setShowPreview] = useState(false);
  const [showFormatting, setShowFormatting] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [showUrlField, setShowUrlField] = useState(false);
  const [externalUrl, setExternalUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightOverlayRef = useRef<HTMLDivElement | null>(null);

  const highlightTokens = useMemo(
    () => tokenizeForHighlighting(sections[activeSection]),
    [sections, activeSection],
  );
  const highlightHtml = useMemo(
    () => renderHighlightHtml(sections[activeSection], highlightTokens),
    [sections, activeSection, highlightTokens],
  );

  /*
   * Mirror the textarea's scroll onto the highlight overlay behind it.
   *
   * Presentation only: it writes a CSS property on a DOM node this component owns, and
   * dispatches nothing. It is a layout fact, not a store write.
   */
  const syncScroll = useCallback((): void => {
    if (textareaRef.current && highlightOverlayRef.current) {
      highlightOverlayRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightOverlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  /*
   * The pending-insert (signpost) path is NOT handled here.
   *
   * It used to be, and it silently dropped every insertion: React runs a child's
   * effects before its parent's, so this effect appended the text on mount and
   * `ScribeEncounter`'s own seed effect then overwrote `sections` from
   * `room.noteText` - discarding the insertion while still draining its one-shot
   * token. `ScribeEncounter` now owns both effects, in seed-then-insert order. See
   * the comment on that effect there for the full reasoning.
   */

  /** Rewrite the section around the textarea's selection. Called from a click only. */
  const insertFormatting = useCallback(
    (before: string, after: string, placeholder: string): void => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = sections[activeSection];
      const selected = text.slice(start, end) || placeholder;
      const next = text.slice(0, start) + before + selected + after + text.slice(end);
      onSectionChange(activeSection, next);
      onEdited();
      const cursor = start + before.length + selected.length + after.length;
      // Restore the caret after React has written the new value back to the textarea.
      setTimeout(() => {
        if (textareaRef.current === null) return;
        textareaRef.current.selectionStart = cursor;
        textareaRef.current.selectionEnd = cursor;
        textareaRef.current.focus();
      }, 0);
    },
    [activeSection, onEdited, onSectionChange, sections],
  );

  const onPickFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      if (room === null || file === undefined) return;
      void actions.addLocalImage(room.roomId, file);
      // Clearing the input lets the same file be picked twice in a row.
      event.target.value = '';
    },
    [actions, room],
  );

  const onRecordExternalUrl = useCallback((): void => {
    if (room === null) return;
    const url = externalUrl.trim();
    if (url.length === 0) return;
    void actions.addExternalImage(room.roomId, url).then((result) => {
      if (result.status !== 'applied') return;
      setExternalUrl('');
      setShowUrlField(false);
    });
  }, [actions, externalUrl, room]);

  const attachments = room?.attachments ?? [];
  const attaching =
    actions.isPending(SCRIBE_COMMAND_SCOPES.attachmentAdd) ||
    actions.isPending(SCRIBE_COMMAND_SCOPES.attachmentAddExternal);
  const submitting = actions.isPending(SCRIBE_COMMAND_SCOPES.noteSubmit);
  const noRoom = room === null;

  const insertAttachmentToken = useCallback(
    (attachment: RoomAttachment): void => {
      onSectionChange(
        activeSection,
        `${sections[activeSection].trimEnd()}\n${markdownTokenFor(attachment)}`.trim(),
      );
      onEdited();
    },
    [activeSection, onEdited, onSectionChange, sections],
  );

  const toggleButton = (
    id: string,
    touchTarget: string,
    label: string,
    pressed: boolean,
    toggle: () => void,
  ): ReactNode => (
    <button
      type="button"
      id={id}
      className="scribe-toggle"
      aria-pressed={pressed}
      {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: touchTarget }}
      style={STUDY_TOUCH_TARGET_STYLE}
      onClick={toggle}
    >
      {label}
    </button>
  );

  return (
    <div className="scribe-composer">
      <div className="scribe-composer__modes" role="group" aria-label="Note composer modes">
        {toggleButton(
          `${SCRIBE_CONTROL_IDS.composerMode}-edit`,
          'composer-edit',
          'Edit',
          !showPreview,
          () => setShowPreview(false),
        )}
        {toggleButton(
          `${SCRIBE_CONTROL_IDS.composerMode}-preview`,
          'composer-preview',
          'Preview',
          showPreview,
          () => setShowPreview(true),
        )}
        {toggleButton(
          `${SCRIBE_CONTROL_IDS.composerMode}-formatting`,
          'composer-formatting',
          'Formatting',
          showFormatting,
          () => setShowFormatting((value) => !value),
        )}
        {toggleButton(
          `${SCRIBE_CONTROL_IDS.composerMode}-images`,
          'composer-images',
          `Images (${attachments.length})`,
          showImages,
          () => setShowImages((value) => !value),
        )}
      </div>

      {showFormatting ? (
        <div
          className="scribe-composer__formatting"
          id={SCRIBE_CONTROL_IDS.formattingToolbar}
          role="group"
          aria-label="Markdown formatting"
        >
          {FORMATTING_TOOLS.map((tool) => (
            <button
              key={tool.key}
              type="button"
              className="scribe-inline-btn"
              {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: `format-${tool.key}` }}
              style={STUDY_TOUCH_TARGET_STYLE}
              onClick={() => insertFormatting(tool.before, tool.after, tool.placeholder)}
            >
              {tool.label}
            </button>
          ))}
          <p className="scribe-hint">
            Each button wraps what you have selected, or drops in a placeholder you can
            replace. <code>[label](https://example.com)</code> makes a link,{' '}
            <code>**bold**</code> makes bold, and <code>-</code> starts a bullet.
          </p>
        </div>
      ) : null}

      {showImages ? (
        <div className="scribe-composer__images" role="group" aria-label="Room images">
          <p className="scribe-hint">
            An image you pick is saved on this device and stays available offline. Nothing is
            uploaded. An image link is stored as a link and is never downloaded.
          </p>
          <input
            ref={fileInputRef}
            id={SCRIBE_CONTROL_IDS.attachLocal}
            type="file"
            accept={IMAGE_ACCEPT}
            hidden
            onChange={onPickFile}
          />
          <div className="scribe-composer__image-actions">
            <StudyActionButton
              label="Add an image from this device"
              touchTarget="attach-local"
              pending={attaching}
              pendingLabel="Saving the image…"
              refusal={noRoom ? 'No room is open for writing.' : null}
              onClick={() => fileInputRef.current?.click()}
            />
            {showUrlField ? null : (
              <StudyActionButton
                label="Add an image link"
                touchTarget="attach-external-toggle"
                onClick={() => setShowUrlField(true)}
              />
            )}
          </div>
          {showUrlField ? (
            <div className="scribe-composer__url">
              <StudyTextInput
                id={SCRIBE_CONTROL_IDS.attachExternal}
                label="Image link"
                hint="A link to an image you already host somewhere. It is recorded, not fetched."
                value={externalUrl}
                onChange={setExternalUrl}
                placeholder="https://example.com/image.png"
                touchTarget="attach-external-url"
                onSubmit={onRecordExternalUrl}
              />
              <StudyActionButton
                label="Record this image link"
                touchTarget="attach-external-record"
                pending={attaching}
                pendingLabel="Recording the link…"
                refusal={
                  externalUrl.trim().length === 0 ? 'Type an image link before recording it.' : null
                }
                onClick={onRecordExternalUrl}
              />
            </div>
          ) : null}

          {attachments.length === 0 ? (
            <p className="scribe-hint">No room images yet.</p>
          ) : (
            <ul className="scribe-image-list" id={SCRIBE_CONTROL_IDS.imageLibrary}>
              {attachments.map((attachment) => {
                const previewUrl =
                  attachment.sourceType === 'external'
                    ? attachment.externalUrl ?? null
                    : resolveLocalImage(attachment.attachmentId);
                const removePending = actions.isPending(SCRIBE_COMMAND_SCOPES.attachmentRemove);
                return (
                  <li key={attachment.attachmentId} className="scribe-image-card">
                    {previewUrl === null ? (
                      <div className="scribe-image-card__missing">No preview available</div>
                    ) : (
                      <img
                        src={previewUrl}
                        alt={attachment.altText ?? attachment.fileName}
                        className="scribe-image-card__image"
                      />
                    )}
                    <div className="scribe-image-card__meta">
                      <strong>{attachment.fileName}</strong>
                      <span className="scribe-image-card__kind">
                        {attachment.sourceType === 'local'
                          ? 'Saved on this device'
                          : 'A link, kept as a link'}
                      </span>
                    </div>
                    <div className="scribe-image-card__actions">
                      {/*
                        No `aria-label` here on purpose. The button's accessible name is its
                        visible text, which is where the file name belongs: the name has to
                        reach a screen-reader user so they know *which* image they are
                        removing, and it reaches them as content rather than as an aria string.
                        The pre-Phase-15 modal put the same value in an `aria-label`, which
                        hid the visible label from assistive technology entirely.
                      */}
                      <button
                        type="button"
                        className="scribe-inline-btn"
                        {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'attachment-insert' }}
                        style={STUDY_TOUCH_TARGET_STYLE}
                        onClick={() => insertAttachmentToken(attachment)}
                      >
                        {`Insert ${attachment.fileName} in the note`}
                      </button>
                      <button
                        type="button"
                        className="scribe-inline-btn scribe-inline-btn--danger"
                        {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'attachment-remove' }}
                        style={STUDY_TOUCH_TARGET_STYLE}
                        disabled={removePending}
                        onClick={() => {
                          if (room === null) return;
                          void actions.removeAttachment(room.roomId, attachment.attachmentId);
                        }}
                      >
                        {`Remove ${attachment.fileName}`}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {showPreview ? (
        <div className="markdown-body scribe-composer__preview" aria-label="Note preview">
          <Markdown source={noteText} resolveLocalImage={resolveLocalImage} />
        </div>
      ) : (
        <>
          <div
            className="note-section-chips"
            id={SCRIBE_CONTROL_IDS.sectionTabs}
            role="tablist"
            aria-label="Note sections"
          >
            {REQUIRED_NOTE_SECTIONS.map((section) => (
              <button
                key={section}
                id={SCRIBE_SECTION_TAB_IDS[section]}
                type="button"
                role="tab"
                aria-selected={activeSection === section}
                aria-controls={SCRIBE_CONTROL_IDS.noteEditor}
                className={
                  activeSection === section
                    ? 'note-section-chip is-active'
                    : 'note-section-chip'
                }
                {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'section-tab' }}
                style={STUDY_TOUCH_TARGET_STYLE}
                onClick={() => onActiveSectionChange(section)}
              >
                {section}
              </button>
            ))}
          </div>
          <label className="scribe-composer__label" htmlFor={SCRIBE_CONTROL_IDS.noteEditor}>
            {activeSection}
          </label>
          <div className="md-editor-wrapper">
            <div
              ref={highlightOverlayRef}
              className="md-highlight-overlay"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightHtml }}
            />
            <textarea
              ref={textareaRef}
              id={SCRIBE_CONTROL_IDS.noteEditor}
              rows={12}
              aria-labelledby={SCRIBE_SECTION_TAB_IDS[activeSection]}
              value={sections[activeSection]}
              onChange={(event) => {
                onSectionChange(activeSection, event.target.value);
                onEdited();
              }}
              onScroll={syncScroll}
            />
          </div>
        </>
      )}

      {/*
        The confirmation. The checkbox is the target a keyboard uses; the 44-pixel
        target is the label, because a 44-pixel checkbox would be a control whose
        appearance lies about what the application is. `onChange` is the only place
        this value ever changes - nothing in this file, in the workspace, or in the
        command layer ever ticks it for the learner.
      */}
      <div className="scribe-confirm">
        <label
          className="scribe-confirm__row"
          {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'note-confirm' }}
          style={STUDY_TOUCH_TARGET_STYLE}
        >
          <input
            id={SCRIBE_CONTROL_IDS.confirmation}
            type="checkbox"
            checked={manualConfirmed}
            style={{ inlineSize: '24px', blockSize: '24px' }}
            onChange={(event) => onManualConfirmedChange(event.target.checked)}
          />
          <span>I confirm these notes are my own and complete.</span>
        </label>
        <p className="scribe-hint">
          {manualConfirmed
            ? 'Confirmed. Submitting now defeats the encounter.'
            : 'A draft can be saved at any time. Ticking this box is what lets it defeat the encounter.'}
        </p>
      </div>

      <div className="scribe-composer__submit">
        <p className="scribe-hint">
          {canClear
            ? 'Every required section is present and the note is confirmed, so this defeats the encounter.'
            : 'This saves a draft. Nothing is awarded until you confirm the note yourself.'}
        </p>
        <StudyActionButton
          id={SCRIBE_CONTROL_IDS.submit}
          label={canClear ? 'Defeat encounter' : 'Save draft'}
          tone={canClear ? 'primary' : 'default'}
          touchTarget="note-submit"
          pending={submitting}
          pendingLabel="Saving…"
          refusal={noRoom ? 'No room is open for writing.' : null}
          onClick={() => {
            if (room === null) return;
            void actions.submitNote({
              roomId: room.roomId,
              noteText,
              manualConfirmed,
            });
          }}
        />
      </div>
    </div>
  );
}