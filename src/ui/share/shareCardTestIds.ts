/**
 * Stable selectors for the share-card surface.
 *
 * ## Why the attributes rather than class names
 *
 * A test that addresses a surface by its class name breaks the moment the stylesheet is renamed,
 * and a test that addresses it by visible copy breaks the moment `village-content-designer`
 * rewrites a caption - which Phase 20 is currently doing. Both are edits that should not require
 * touching a gate, and neither says anything about *which* of several similar surfaces a test meant.
 *
 * So the identifiers are published as `data-*` attributes, declared here once, and consumed by name.
 * A rename is one edit in this file plus one wherever the old name is read.
 *
 * These attributes are also what makes Phase 21's audit possible without re-deriving the surface:
 * every interactive control carries one, so a browser check can enumerate the reachable controls and
 * their labels rather than screenshotting and eyeballing them.
 */

/** Prefix every attribute below starts with. */
export const SHARE_CARD_ID_PREFIX = 'data-kd-share';

export const SHARE_CARD_IDS = Object.freeze({
  /** The dialog container itself. */
  dialog: 'dialog',
  /**
   * The control that opens the dialog.
   *
   * Lives on the *host* surface, so it lives here too rather than in the dialog's own module: a
   * selector that only the dialog knew about could not address the thing that opens it.
   */
  open: 'open',
  /** The canvas the preview is drawn on. Always `aria-hidden`. */
  preview: 'preview',
  /** The text rendering of exactly what the canvas shows. */
  previewText: 'preview-text',
  /** The field-selection list. */
  fieldList: 'field-list',
  /** One field checkbox, carrying the field id as its suffix. */
  fieldOption: 'field-option',
  /** The kind selector, one radio per kind. */
  kindRadio: 'kind-radio',
  /** The local PNG download control. Present on every build, flag or no flag. */
  download: 'download',
  /** The explicit Web Share control. Absent when the flag is off. */
  share: 'share',
  /** The live status line for delivery outcomes. */
  status: 'status',
  /** The count of rows the model produced. */
  rowCount: 'row-count',
  /** The fields the model omitted, published for a11y review. */
  omitted: 'omitted',
} as const);

export const SHARE_CARD_ID_ATTRIBUTE = SHARE_CARD_ID_PREFIX;
export const SHARE_CARD_FIELD_ATTRIBUTE = `${SHARE_CARD_ID_PREFIX}-field`;
export const SHARE_CARD_KIND_ATTRIBUTE = `${SHARE_CARD_ID_PREFIX}-kind`;
export const SHARE_CARD_COUNT_ATTRIBUTE = `${SHARE_CARD_ID_PREFIX}-count`;
export const SHARE_CARD_OUTCOME_ATTRIBUTE = `${SHARE_CARD_ID_PREFIX}-outcome`;
/** The class that hides text visually while leaving it in the accessibility tree. */
export const SHARE_CARD_SR_ONLY_CLASS = 'kd-share-sr-only';

/** A test-id attribute bag for one node. Spread it: `{{ [SHARE_CARD_ID_ATTRIBUTE]: SHARE_CARD_IDS.x }}`. */
export function shareCardId(id: string): Record<string, string> {
  return { [SHARE_CARD_ID_ATTRIBUTE]: id };
}