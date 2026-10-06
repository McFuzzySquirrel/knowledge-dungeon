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
 *
 * ## Why one scope, and not one document listener per surface
 *
 * Because `document` is shared, two open surfaces mean two capture-phase
 * listeners for the same key, and **which one runs is decided by registration
 * order rather than by anything a learner did**. That is not a hypothetical:
 * on a touch viewport the village HUD drawer and the Settings dialog are both
 * open at once, the drawer registered first, and one Escape press ran the
 * drawer's handler - unmounting the entire HUD column, Settings launcher and all
 * - before the dialog's own handler ran. The dialog then restored focus to a
 * launcher that had just been disconnected, so focus stayed on the drawer's
 * toggle. Two aria-modal scopes were both claiming the keyboard and the
 * *first* one won.
 *
 * So only the **topmost** scope acts - see {@link openScopes}. One Escape press
 * dismisses exactly one surface, the one the learner is looking at, and the
 * surfaces beneath it keep their own Escape until they are on top. The rule is
 * decided here, from the stack, so `VillageHud` does not have to know that
 * `SettingsModal` exists and no caller has to register itself with anything.
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

/**
 * The focus scopes that are open right now, oldest first, so the last entry is the topmost.
 *
 * A stack, and the alternative rules were considered first:
 *
 * - **Registration order** is what this code did before, and it is the defect: the surface that
 *   happened to mount first wins, which is the surface furthest from the learner.
 * - **DOM depth** is not a proxy for stacking order either. It is decided by how many wrapper
 *   elements a styling decision happens to add: the Settings dialog is deeper than the HUD drawer
 *   here only because its backdrop is an extra `<div>`. Remove that div, portal the dialog to
 *   `<body>` at depth one, or nest the drawer one level deeper, and the answer flips while the
 *   visual stack is unchanged.
 *
 * Open order is the rule every platform already uses for stacked UI - a back stack, a modal
 * presentation, an undo stack - and it is the only one of the three that is a property of what the
 * learner did rather than of how the markup is shaped. It is read from the module scope rather than
 * from the DOM, so it is independent of which element happens to hold focus, and it needs no
 * cooperation from any other surface: `useModalFocus` is its own complete answer to "am I on top?".
 *
 * A scope that is open but not dismissable still counts as topmost. Escape therefore does nothing
 * at all while it is up, rather than dismissing the surface *behind* it - falling through would
 * tear down a layer the learner never pressed Escape on, which is the defect in miniature.
 */
const openScopes: symbol[] = [];

/** Whether `token` names the surface currently on top of the stack. */
function isTopmost(token: symbol): boolean {
  return openScopes[openScopes.length - 1] === token;
}

/**
 * Take `token` off the stack.
 *
 * By identity rather than by position, because React's development double-invoke mounts and
 * unmounts an effect once before mounting it for real: a positional removal would pop whichever
 * entry happened to be there. An already-removed entry is not an error - a StrictMode remount has
 * legitimately run the cleanup twice.
 */
function closeScope(token: symbol): void {
  const at = openScopes.lastIndexOf(token);
  if (at !== -1) openScopes.splice(at, 1);
}

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

    // Claim the top of the stack before the listener goes on, so this scope is the one that answers
    // the first key. A scope that opens after another one is above it by construction, whatever the
    // DOM looks like and whichever element currently holds focus.
    const token = Symbol('useModalFocus scope');
    openScopes.push(token);

    const handleKeyDown = (event: KeyboardEvent): void => {
      /*
       * The topmost surface is the only one that acts, and this one line governs **both** keys.
       *
       * Tab is not a separate concern that happens to be fine: Tab containment is the same
       * competition Escape is, and it loses the same way. A scope beneath a dialog sees Tab pressed
       * while focus is inside the dialog, finds `document.activeElement` outside itself, concludes
       * focus had escaped, and pulls it back to its own first control - yanking a keyboard learner's
       * focus out of the dialog they are reading, on a key they pressed to move *within* it. Two
       * `aria-modal` scopes trapping Tab at once is the same defect class, and one guard is the fix
       * for both.
       */
      if (!isTopmost(token)) return;

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
      // Off the stack before focus moves: a closed surface must stop answering keys in the same
      // commit it disappears in, and the surface that becomes topmost has to be findable the moment
      // this one unmounts.
      closeScope(token);
      // Only restore to something still in the document: a control that unmounted
      // with the surface cannot be focused, and a detached node would throw.
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, [active]);

  return ref;
}
