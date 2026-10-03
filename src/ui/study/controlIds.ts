/**
 * Static ids for the study surfaces' controls.
 *
 * A "next action" button has to be able to move focus to the control that performs the
 * step it recommends - "Add child topics" focusing the box a learner is about to type
 * into - and the two live in different components. Sharing the id strings through one
 * module is how that works without a ref chain.
 *
 * Every value here is a static literal. No id, attribute, or selector built from a
 * learner value belongs in this file: ids end up in tests, in issue reports, and in
 * screenshots.
 */
export const STUDY_CONTROL_IDS = Object.freeze({
  /** The topic picker: the list of every topic in the subject. */
  topicList: 'study-topic-list',
  /** The graph view's frame, for a next action that means "look at the graph". */
  graphView: 'study-graph-view',
  /** Bulk child-topic creation. */
  childTopicsInput: 'study-child-topics-input',
  childTopicsAdd: 'study-child-topics-add',
  /** The sentence describing what the child-topic button will do. */
  childTopicsAddDescription: 'study-child-topics-add-description',
  /** Cross-linking. */
  crossLinkSelect: 'study-cross-link-select',
  crossLinkRelation: 'study-cross-link-relation',
  crossLinkApply: 'study-cross-link-apply',
  /** Reparenting. */
  reparentSelect: 'study-reparent-select',
  reparentApply: 'study-reparent-apply',
  /** Tags. */
  tagInput: 'study-tag-input',
  tagAdd: 'study-tag-add',
  tagReplaceInput: 'study-tag-replace-input',
  tagReplaceApply: 'study-tag-replace-apply',
  /** Deletion. */
  deleteTopic: 'study-delete-topic',
  deleteConfirm: 'study-delete-confirm',
});

export type StudyControlId = (typeof STUDY_CONTROL_IDS)[keyof typeof STUDY_CONTROL_IDS];

/**
 * The Scribe encounter workspace's controls.
 *
 * A separate object rather than more entries on {@link STUDY_CONTROL_IDS}, for the
 * same reason the Creator ids are one object: the Scribe workspace's next action
 * has to move focus to a control that lives inside the note composer, and Phase 14's
 * vocabulary is not where Phase 15's controls belong. Neither object knows the
 * other exists, and both are static literals for the reason stated at the top of this
 * file.
 */
export const SCRIBE_CONTROL_IDS = Object.freeze({
  /** The arrival/resumability block, and the frame focus lands on. */
  arrival: 'scribe-arrival',
  /** The section tablist of the note composer. */
  sectionTabs: 'scribe-section-tabs',
  /**
   * The composer's mode-toggle group.
   *
   * A base rather than a control: `NoteComposer` appends `-edit`, `-preview`,
   * `-formatting`, and `-images` to it, so the four toggles stay one stable, enumerable
   * family instead of four unrelated literals scattered through a component. The suffixes
   * are as static as this value is, and `tests/phase15/scribe-accessibility.test.tsx` pins
   * all four so a rename cannot land silently.
   */
  composerMode: 'scribe-composer-mode',
  /** The textarea for the section currently being written. */
  noteEditor: 'scribe-note-editor',
  /** The formatting toolbar's own frame. */
  formattingToolbar: 'scribe-formatting-toolbar',
  /** The image library's own frame. */
  imageLibrary: 'scribe-image-library',
  /** The manual-confirmation checkbox. */
  confirmation: 'scribe-confirmation',
  /** Save a draft or defeat the encounter. */
  submit: 'scribe-submit',
  /** Store a picked image's bytes on this device. */
  attachLocal: 'scribe-attach-local',
  /** Record an externally hosted image. */
  attachExternal: 'scribe-attach-external',
  /** Pick a generated artifact up into the journal. */
  artifactCollect: 'scribe-artifact-collect',
  /** The overlay's own close control. */
  close: 'scribe-encounter-close',
  /** The overlay dialog frame, which receives focus on open. */
  dialog: 'scribe-encounter-dialog',
});

/**
 * Static ids for the three required-section tabs and their one shared panel.
 *
 * Declared rather than interpolated. `REQUIRED_NOTE_SECTIONS` is a static literal
 * today, so a derived id would be static today too - and a derived id is one edit
 * away from carrying a learner value. These three strings cannot.
 */
export const SCRIBE_SECTION_TAB_IDS = Object.freeze({
  Summary: 'scribe-section-tab-summary',
  'Key Points': 'scribe-section-tab-key-points',
  'Recall Question': 'scribe-section-tab-recall-question',
});

export type ScribeSectionId = keyof typeof SCRIBE_SECTION_TAB_IDS;

/**
 * The Archaeologist review workspace's controls.
 *
 * A third object, for the same reason the second one is: the review workspace's next action
 * moves focus to a control that lives inside the recall card, and Phase 14's vocabulary is
 * not where Phase 16's controls belong.
 *
 * **No learner value appears in any of these.** The rating radios are the case that most
 * wanted one - a `name` of `${roomId}-${quality}` would be the obvious way to make them
 * unique - and it is exactly why the group carries `role="radiogroup"` instead: a radio
 * group is keyed by *its own* label and needs no name attribute at all, so a room id never
 * reaches the DOM. See `RecallCard.tsx`.
 */
export const ARCHAEOLOGIST_CONTROL_IDS = Object.freeze({
  /** The arrival/resumability block, and the frame focus lands on. */
  arrival: 'archaeologist-arrival',
  /** The recall-prompt list for the room under review. */
  recallPrompts: 'archaeologist-recall-prompts',
  /** The 0-5 recall-quality radio group. */
  qualityRating: 'archaeologist-quality-rating',
  /** The review-pass progress block. */
  progress: 'archaeologist-progress',
  /** Resume the interrupted review the durable marker holds. */
  sessionResume: 'archaeologist-session-resume',
  /** Discard the interrupted review. Awards nothing. */
  sessionDiscard: 'archaeologist-session-discard',
  /** Explicitly complete this pass for this room, with the chosen rating. */
  passComplete: 'archaeologist-pass-complete',
  /** Park the unfinished review so it survives an exit. */
  sessionSave: 'archaeologist-session-save',
  /** Close the room panel, which finalizes the review through the flow. */
  close: 'archaeologist-review-close',
});

/**
 * Move focus to a control by id, if it is in the document.
 *
 * Returns whether focus moved, so a caller can report "there is nothing to focus" rather
 * than silently doing nothing. Never throws on a missing id: a next action whose target
 * is in a collapsed region is a real state, and it is reported, not crashed on.
 */
export function focusStudyControl(id: StudyControlId | string): boolean {
  const element = document.getElementById(id);
  if (element === null) return false;
  if (typeof element.focus !== 'function') return false;
  element.focus();
  return document.activeElement === element;
}
