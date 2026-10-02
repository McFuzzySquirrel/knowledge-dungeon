/**
 * Which Cozy panel shape the village surfaces take, and why.
 *
 * ## The rule
 *
 * Plan Phase 12 asks for "Cozy side panels on wide screens and bottom sheets on
 * touch devices". Those are two different questions and the phase names both, so
 * this module answers both rather than picking one:
 *
 * - **Touch** - a coarse or hoverless pointer. A sheet is thumb-reachable: its
 *   actions sit at the bottom of the viewport, where a hand already is, instead
 *   of in a column the hand has to travel across the screen to reach.
 * - **Narrow** - a viewport that cannot hold a side panel *and* the world *and*
 *   the 240-pixel HUD. 900 CSS pixels is the point where a 320-pixel panel, the
 *   240-pixel HUD, and a playable strip of world stop coexisting. This arm also
 *   covers the two gates that make it non-negotiable: 200% browser zoom and the
 *   320-CSS-pixel viewport both narrow the *layout* viewport without any coarse
 *   pointer being involved, and a side panel at either is a horizontal scrollbar.
 *
 * `navigator.maxTouchPoints` is read alongside `(pointer: coarse)` because that
 * is what Playwright's touch emulation sets, and `hover: none` is read because
 * it is the one query a convertible laptop answers "yes" to while the pointer
 * itself is still fine. Three queries, OR-ed, each covering a case the others
 * miss.
 *
 * ## Why a hook and not a media query in CSS
 *
 * Because the two shapes are not only a paint difference. A sheet is a dialog -
 * it takes focus, contains Tab, closes on Escape, and needs a labelled dismiss
 * control - while a side panel is a labelled `region` that must not steal focus
 * from a learner who is walking around with the arrow keys. That is a semantic
 * branch, so it belongs in the component tree where React can express it, and the
 * stylesheet only consumes the resulting `data-village-surface` value.
 *
 * ## No SSR guard beyond `try`
 *
 * `matchMedia` is absent in some non-browser test environments, and the existing
 * village screen already wrapped its own `matchMedia` read in `try`. A guard that
 * returned a *different* default on failure would make the panel shape depend on
 * whether the environment implements an API, so failure resolves to `side` -
 * the same answer a wide desktop gives.
 */
import { useEffect, useState } from 'react';

import type { VillageSurfaceMode } from './villageTypes';

/** Below this layout width a side panel would starve the world. */
export const VILLAGE_SHEET_WIDTH_QUERY = '(max-width: 900px)';

/** The pointer is a finger, or nothing at all. */
export const VILLAGE_TOUCH_POINTER_QUERY = '(pointer: coarse)';

/** No hover-capable pointer, which is how a touch laptop answers. */
export const VILLAGE_NO_HOVER_QUERY = '(hover: none)';

function matches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  } catch {
    return false;
  }
}

function reportsTouch(): boolean {
  try {
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * The surface mode right now, read once.
 *
 * Exported so a caller that already knows it is rendering once (a test, a
 * server-rendered snapshot) can ask the same question the hook asks rather than
 * re-deriving the three queries.
 */
export function readVillageSurfaceMode(): VillageSurfaceMode {
  if (matches(VILLAGE_TOUCH_POINTER_QUERY)) return 'sheet';
  if (matches(VILLAGE_NO_HOVER_QUERY)) return 'sheet';
  if (reportsTouch()) return 'sheet';
  if (matches(VILLAGE_SHEET_WIDTH_QUERY)) return 'sheet';
  return 'side';
}

/**
 * The surface mode, kept current across a resize, a pointer change, or a rotation.
 *
 * One subscription per query rather than one per `mode` change, so a viewport
 * crossing a boundary does not tear down and reinstall the other queries' listeners.
 */
export function useVillageSurfaceMode(): VillageSurfaceMode {
  const [mode, setMode] = useState<VillageSurfaceMode>(readVillageSurfaceMode);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const queries = [
      VILLAGE_TOUCH_POINTER_QUERY,
      VILLAGE_NO_HOVER_QUERY,
      VILLAGE_SHEET_WIDTH_QUERY,
    ];
    const sync = (): void => {
      const next = readVillageSurfaceMode();
      setMode((current) => (current === next ? current : next));
    };
    const lists = queries.map((query) => window.matchMedia(query));
    for (const list of lists) list.addEventListener('change', sync);
    // A touch device can gain or lose a pointer without any of the three queries
    // changing (a stylus paired after load, a detachable keyboard), and the
    // orientation change that carries a tablet from 834 to 1112 pixels is a
    // `resize` rather than a media-query transition on all three queries.
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    sync();
    return () => {
      for (const list of lists) list.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);

  return mode;
}
