/**
 * The learner-facing copy for the share dialog, in one place.
 *
 * ## Why this is not in the dialog component
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. **A component that inlines its strings cannot be read for what it promises.** The dialog's
 *    claims - that nothing private is shown by default, that the share button is explicit, that a
 *    cancelled share changed nothing - are claims about *words* as much as about behaviour, and
 *    they are all in the strings.
 * 2. **Phase 20 is mid-flight on content.** `village-content-designer` owns
 *    `src/core/share/shareCardContent.ts` and is rewriting it wholesale right now. Card titles,
 *    captions, and field labels come from there and must not be duplicated here. This file adds
 *    only the words the *surface* owns: the dialog's own title, the field-selection instructions,
 *    the privacy explanation, the control labels, and the note under a checkbox that is off by
 *    default.
 *
 * ## No clock and no locale in any of it
 *
 * Every string below is a fixed template with a number interpolated whole. Nothing reads a date and
 * nothing calls `toLocaleString`, because a phrase like "shared on 5/10/2026" is exactly the
 * host-dependent text Phase 19 found rendering one archive two ways.
 */
import type { ShareCardField } from '@/core/share/types';

/** The dialog's own heading, and therefore its accessible name. */
export const SHARE_DIALOG_TITLE = 'Share a progress card';

/** The dialog's described-by paragraph. One sentence on what a card is. */
export const SHARE_DIALOG_DESCRIPTION =
  'A card is a picture of your own progress. Choose what goes on it, check the preview, then save or share it.';

/** The privacy explanation. Shown always, because it is the promise the screen is making. */
export const SHARE_PRIVACY_NOTE =
  'Cards never include note text, room lists, internal identifiers, or assistance history.';

/** The heading of the field-selection group. */
export const SHARE_FIELD_SELECTION_HEADING = 'What goes on the card';

/** Instructions for the field-selection group, and the accessible description of the list. */
export const SHARE_FIELD_SELECTION_HINT =
  'Tick the fields you want to show. The order of the card is fixed, so it looks the same for everyone.';

/** The kind selector's group heading. */
export const SHARE_KIND_SELECTION_HEADING = 'Card type';

/**
 * The note under a field that is available but **off by default**.
 *
 * Three fields are in this position and each has its own reason, so a learner is told which one they
 * are looking at rather than being given one blanket warning. `null` means "this field is a default
 * and needs no note".
 */
export const SHARE_OPTIONAL_FIELD_NOTES: Readonly<Partial<Record<ShareCardField, string>>> = Object.freeze({
  badgeLabels:
    'Off by default: badge names take up most of a small card. Counts of badges are always shown.',
  collectedNoteCount:
    'Off by default: this is a count of your notes, never their text.',
  assistanceSummary:
    'Off by default: this is a count of sessions where a study hint appeared.',
  subjectName:
    'On by default. Turn it off to publish the card without your subject name.',
});

/** The four kinds, as the selector labels them. */
export const SHARE_KIND_LABELS = Object.freeze({
  'subject-summary': 'Subject summary',
  collection: 'Collection',
  fish: 'Fish',
  statistics: 'Study statistics',
});

/** The local download control. Present on every build, whatever `VITE_WEB_SHARE` is. */
export const SHARE_DOWNLOAD_LABEL = 'Download PNG';

/** The explicit Web Share control. Its label names the action, not the mechanism. */
export const SHARE_SHARE_LABEL = 'Share image';

/** The close control's accessible name. */
export const SHARE_CLOSE_LABEL = 'Close share card dialog';

/** Announced while the card is being drawn, so a slow draw is not a silent one. */
export const SHARE_DRAWING_LABEL = 'Drawing the preview…';

/** Shown when a model produced no rows at all. */
export const SHARE_EMPTY_CARD_NOTE =
  'This card has no numbers yet. Start a subject, or pick fewer fields.';

/**
 * Shown when the subject name was **withheld by the privacy filter**.
 *
 * The domain carries a subject name as the learner typed it, and a caller that puts a minted
 * identifier in that field gets their own text back. The renderer and this dialog both refuse such a
 * value rather than publishing a pointer at one of the learner's records - and when they refuse, the
 * learner is told, because a card silently missing its heading reads as a bug rather than as a
 * refusal.
 */
export const SHARE_NAME_WITHHELD_NOTE =
  'Your subject name was left off this card because it looks like an internal identifier. Rename the subject, or share the card without a name.';

/** Shown when every row the card would have drawn was omitted for want of data. */
export const SHARE_OMITTED_NOTE =
  'Some chosen fields had nothing to show and were left off the card.';

/** The footer of the preview, describing what the picture is. */
export const SHARE_PREVIEW_FOOTER = 'Preview of the image you will save or share.';

/** The sentence the preview's accessible description is built from. */
export function sharePreviewDescription(subjectName: string | null, rowCount: number, kindLabel: string): string {
  const name = subjectName === null ? 'no subject name' : `subject name ${subjectName}`;
  const rows = rowCount === 1 ? '1 field' : `${rowCount} fields`;
  return `${SHARE_PREVIEW_FOOTER} A ${kindLabel} card with ${name} and ${rows}.`;
}

/**
 * A row's accessible text, for a screen-reader summary of the whole card.
 *
 * Used by the card's spoken description rather than by the `<dl>`: in the definition list the label
 * and the value are already separate nodes, so joining them with a colon there would make a screen
 * reader read punctuation it does not need.
 */
export function shareRowText(label: string, value: string): string {
  return `${label}: ${value}`;
}