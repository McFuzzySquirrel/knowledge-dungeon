import { useCallback, useSyncExternalStore } from 'react';

/**
 * A media query as live React state, not a snapshot taken once.
 *
 * ## Why this exists
 *
 * Several surfaces in the shell choose a different *shape* when the layout is
 * narrow: the dungeon HUD becomes a bottom drawer instead of a side column, the
 * tutorial overlay becomes a pill, and the room panel becomes a bottom sheet.
 * Each of those used to read `window.matchMedia(...)` inside a `useState`
 * initializer, which evaluates exactly once per mount. A learner who rotates a
 * tablet or drags a desktop window across the breakpoint then keeps the shape
 * they mounted with, so a 390-pixel page can render the desktop top bar and a
 * 1440-pixel page can render the phone drawer.
 *
 * `useSyncExternalStore` is the mechanism rather than `useState` plus an effect
 * because it is the API React ships for "an external store whose value can be
 * read during render and subscribed to": the first render already sees the
 * correct value (no flash of the wrong shape), and a change re-renders exactly
 * the components that asked.
 *
 * ## The subscription is deliberately wider than the query
 *
 * `MediaQueryList` `change` is the precise signal and is subscribed to. `resize`
 * and `orientationchange` are subscribed to as well because they are the events
 * a rotation fires, and the whole point of this hook is that rotating across a
 * breakpoint switches the shape. The extra listeners cannot cause a spurious
 * render: `getSnapshot` returns a primitive, so React bails out when it has not
 * actually changed.
 *
 * `getServerSnapshot` returns `false`, matching the wide-layout default the
 * previous `try`-guarded reads used when `matchMedia` was unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      window.addEventListener('resize', onStoreChange);
      window.addEventListener('orientationchange', onStoreChange);
      return () => {
        list.removeEventListener('change', onStoreChange);
        window.removeEventListener('resize', onStoreChange);
        window.removeEventListener('orientationchange', onStoreChange);
      };
    },
    [query],
  );

  const getSnapshot = useCallback((): boolean => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false;
    } catch {
      return false;
    }
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** The dungeon shell's narrow-layout query, shared so every caller agrees. */
export const NARROW_SHELL_QUERY = '(max-width: 768px)';
