/**
 * The browser half of {@link WorldEnvironment}: the three things a world host
 * observes, and nothing else.
 *
 * ## Why observation and policy are separate
 *
 * Plan section 10.2 asks for the ticker to pause while the document is hidden, and
 * section 10.1 asks for `prefers-reduced-motion` support in Pixi. Both are *policies*
 * and both belong to the host, which applies them in `createWorldHost.ts`. What
 * belongs here is only how the answer is obtained, because that is the part that
 * needs a DOM - and the part that differs between a browser, a worker, and a test.
 *
 * Keeping them apart is what lets the policies be asserted without a browser. A host
 * that read `window.matchMedia` itself could only be exercised in jsdom with a
 * stubbed global, and the stub is exactly the thing under test; with the seam here,
 * the host takes the answers as a plain interface and a test supplies a plain
 * object. The browser implementation is then small enough to read.
 *
 * ## Every global is feature-detected
 *
 * Each of the three observers degrades to a working no-op rather than throwing when
 * its global is missing, and every one of them is *optional* in the sense that the
 * host keeps working without it: no `ResizeObserver` means the size is read once at
 * mount and then on window resize, which is the pre-`ResizeObserver` behaviour and
 * is what jsdom exercises. That is a deliberate choice over a hard failure, because
 * the alternative is a world that will not mount in a test environment at all, and
 * a renderer host that cannot be tested is a renderer host that is not tested.
 *
 * No learner data reaches any of it: the media queries are static strings, the
 * element observed is the host element the caller supplied, and nothing is logged.
 */
import type { WorldEnvironment } from './types';

/** The static media query strings, in one place so a test can assert on them. */
export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * A `matchMedia` that is safe to call.
 *
 * `undefined` rather than a defaulting implementation, because the caller decides
 * what an unobservable preference means: a browser that refuses the query and a
 * test that never installed one are the same situation, and both should be
 * "motion is allowed" - the state a caller that cannot observe the preference is
 * in, and the state that is safe to default to because reduced motion is opt-in.
 */
function matchMediaOf(win: Window | undefined, query: string): MediaQueryList | undefined {
  if (!win || typeof win.matchMedia !== 'function') return undefined;
  try {
    return win.matchMedia(query);
  } catch {
    // Some embedded webviews throw on an unknown query rather than returning
    // `null`. A throw here would take down a world mount over a preference, so it
    // is treated as "not observable".
    return undefined;
  }
}

function currentReducedMotion(win: Window | undefined): boolean {
  return matchMediaOf(win, REDUCED_MOTION_MEDIA_QUERY)?.matches ?? false;
}

/** The document that owns the visibility state, or `undefined` with no DOM. */
function documentOf(win: Window | undefined): Document | undefined {
  const candidate = win?.document;
  return candidate && typeof candidate.addEventListener === 'function' ? candidate : undefined;
}

/**
 * The size of an element in CSS pixels, never zero.
 *
 * `1` rather than `0` for a collapsed element, and the reason is arithmetic rather
 * than politeness: a renderer asked to resize to `0 x 0` computes a zero-sized
 * backing store, and dividing by it later produces `Infinity` in a layout and
 * `NaN` in a normalised coordinate. A world that has not been laid out yet gets a
 * one-pixel surface and a resize the moment the observer fires.
 *
 * ## The padding box, and why the border box is the wrong one
 *
 * `clientWidth`/`clientHeight` first, and the border-box rect only as a fallback for a
 * realm with no layout (jsdom reports `0` for both, and a `display: none` element
 * reports `0` in a browser too).
 *
 * This is not a preference. The element being measured is the surface the canvas is
 * inserted into, and the canvas is sized to whatever this function returns - so
 * measuring the **border** box measures a box the canvas's own size *enlarges*. The
 * surface's 1-pixel top and bottom borders sit outside the box the canvas fills, so
 * each measurement is 2 pixels larger than the last, every measurement guarantees
 * another `ResizeObserver` delivery, and the surface grows without bound. That is a
 * real, measured defect, not a theory: the browser lane recorded a surface that had
 * reached 134 CSS pixels and was still climbing, and a world that never settles is a
 * world whose surface can be resized by an unrelated style change.
 *
 * Measured against the padding box the feedback has gain exactly one: the canvas is
 * sized to fill the content, so the content is already the size that was measured, and
 * the observation stops changing after at most one delivery. The `rect` fallback keeps
 * every layout-less test realm asserting the numbers it asserts today.
 */
export function measureElement(element: HTMLElement): { width: number; height: number } {
  const rect =
    typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : { width: 0, height: 0 };
  const width = Math.max(1, Math.floor(element.clientWidth || rect.width || 0));
  const height = Math.max(1, Math.floor(element.clientHeight || rect.height || 0));
  return { width, height };
}

/**
 * The browser environment.
 *
 * Passing `win` in rather than reading the global keeps the function callable with
 * an explicit realm - a jsdom window, an iframe's window - and makes the "no DOM"
 * case an explicit `undefined` rather than a `typeof window` test at three sites.
 */
export function createBrowserWorldEnvironment(win: Window | undefined): WorldEnvironment {
  const doc = documentOf(win);

  return {
    reducedMotion(): boolean {
      return currentReducedMotion(win);
    },

    hidden(): boolean {
      return doc?.hidden === true;
    },

    observeReducedMotion(listener: (reduced: boolean) => void): () => void {
      const query = matchMediaOf(win, REDUCED_MOTION_MEDIA_QUERY);
      if (!query) return () => {};
      // The `onchange` property is the one subscription both the legacy
      // `addListener` API and the modern `addEventListener` API can serve, and it
      // is the only one jsdom implements for `MediaQueryList` without a stub.
      const previous = query.onchange;
      query.onchange = (event: MediaQueryListEvent) => {
        previous?.call(query, event);
        listener(event.matches);
      };
      return () => {
        if (query.onchange === undefined) return;
        query.onchange = previous ?? null;
      };
    },

    observeVisibility(listener: (hidden: boolean) => void): () => void {
      if (!doc) return () => {};
      const onChange = () => listener(doc.hidden === true);
      doc.addEventListener('visibilitychange', onChange);
      return () => doc.removeEventListener('visibilitychange', onChange);
    },

    observeSize(element: HTMLElement, listener: (width: number, height: number) => void): () => void {
      const emit = () => {
        const { width, height } = measureElement(element);
        listener(width, height);
      };
      // Measured once on subscribe, because a world mounted into an element that
      // already has a size must start at that size rather than at the 800x600
      // default. `ResizeObserver` would have delivered it anyway, but the fallback
      // path would not, and the two paths must not differ.
      emit();

      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => emit());
        observer.observe(element);
        return () => observer.disconnect();
      }
      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('resize', emit);
        return () => win.removeEventListener('resize', emit);
      }
      return () => {};
    },
  };
}

/**
 * The environment a runtime with no DOM gets.
 *
 * Motion is allowed and nothing is ever hidden, because those are the only two
 * answers that need a DOM to know. A host built on this still mounts, still
 * renders, and still tears down - which is what makes the reduced-motion policy
 * assertable in a realm with no `window` at all.
 */
export function createDomlessWorldEnvironment(): WorldEnvironment {
  return {
    reducedMotion: () => false,
    hidden: () => false,
    observeReducedMotion: () => () => {},
    observeVisibility: () => () => {},
    observeSize: (_element, listener) => {
      // A fixed, non-degenerate surface, so a renderer's arithmetic has something
      // to divide by in a realm that cannot lay anything out.
      listener(1, 1);
      return () => {};
    },
  };
}

/**
 * The environment for the current realm.
 *
 * `globalThis.window` is read through a `typeof` guard rather than assumed, so
 * this is callable at module scope in a worker, in Node, and in a test.
 */
export function currentWorldEnvironment(): WorldEnvironment {
  const win =
    typeof globalThis === 'object' &&
    typeof (globalThis as { window?: Window }).window === 'object' &&
    (globalThis as { window?: Window }).window
      ? (globalThis as { window: Window }).window
      : undefined;
  return createBrowserWorldEnvironment(win);
}
