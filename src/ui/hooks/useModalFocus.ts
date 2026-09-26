/**
 * Focus containment for one modal surface.
 *
 * A modal dialog that leaks focus is not a dialog: a keyboard user who tabs past
 * the last control lands in the page behind it and cannot tell they have left.
 * Plan section 10.1 therefore requires three behaviours for every dialog, and
 * this hook is the single implementation of all three:
 *
 * 1. **Initial focus.** The surface container itself receives focus when it
 *    opens, which is the ARIA authoring-practice choice for a dialog whose first
 *    content is a heading and a description. Focusing the *first button* instead
 *    would put a destructive or expensive action under the learner's next Enter.
 * 2. **Containment.** Tab and Shift+Tab cycle within the surface, and a Tab
 *    pressed while focus has somehow left is pulled back to the first control
 *    rather than being allowed to continue into the page behind.
 * 3. **Restoration.** The element that had focus when the surface opened is
 *    focused again when it closes, so closing a dialog does not dump a keyboard
 *    user at the top of the document.
 *
 * Escape is handled here too, and only when the caller supplies `onEscape`. A
 * dialog that must not be dismissed mid-operation - one whose promise has not
 * settled - passes `null` and is genuinely not dismissible, rather than looking
 * dismissible and ignoring the key.
 *
 * The listener is registered on `document` in the capture phase so a control
 * inside the surface cannot swallow the Tab that would have contained it. The
 * focusable set is computed from selectors only: it is not filtered by rendered
 * size, because a size check would make the trap depend on layout having
 * happened and would silently disable itself in a non-rendering environment.
 */

import { useEffect, useRef, type RefObject } from 'react';

/** Everything a keyboard can reach that is not the container itself. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalFocusOptions {
  /** Whether the surface is open. Focus moves in on `false → true`. */
  readonly active: boolean;
  /**
   * Escape handler, or `null` while the surface must not be dismissed.
   *
   * Held in a ref rather than a dependency so that changing the handler does not
   * re-run the effect - which would restore focus to the opener and then move it
   * straight back, a visible flicker on every state change.
   */
  readonly onEscape: (() => void) | null;
}

/** The focusable descendants of `node`, in document order. */
function focusableWithin(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Contain focus in the element the returned ref is attached to.
 *
 * @returns a ref to put on the dialog element, which must also carry
 *   `tabIndex={-1}` to be focusable.
 */
export function useModalFocus<T extends HTMLElement>({ active, onEscape }: ModalFocusOptions): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const escapeRef = useRef<(() => void) | null>(null);

  // Declared before the focus effect so it is populated on the same commit the
  // listener is installed in.
  useEffect(() => {
    escapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (node === null) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const dismiss = escapeRef.current;
        if (dismiss === null) return;
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableWithin(node);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        node.focus();
        return;
      }

      const current = document.activeElement;
      const outside = current === null || !node.contains(current);
      if (event.shiftKey && (outside || current === first)) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (outside || current === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      // Only restore to something still in the document: a control that unmounted
      // with the surface cannot be focused, and a detached node would throw.
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [active]);

  return ref;
}
