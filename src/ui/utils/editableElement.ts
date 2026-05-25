/**
 * Returns true when the active DOM element is a user-editable form control —
 * a text-like `<input>`, `<textarea>`, `<select>`, or any element marked
 * `contenteditable`. Used in several places to suppress global keyboard
 * shortcuts (Phaser movement / interact keys, the `?` help-toggle) while
 * the user is typing into a panel field.
 */

// Input types that aren't text-like; focusing one of these should NOT
// count as "editable" for the purposes of suppressing keyboard shortcuts.
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
  'hidden',
]);

export function isEditableElement(el: Element | EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type?.toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type ?? '');
  }
  return false;
}

export function isEditableElementFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return isEditableElement(document.activeElement);
}
