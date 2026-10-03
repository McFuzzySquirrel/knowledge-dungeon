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
