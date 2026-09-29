/**
 * The gesture gate: the one place an `AudioContext` is allowed to be created.
 *
 * ## Why this is a separate module
 *
 * "No autoplay" is a phase non-goal, but the defect it prevents is not a sound
 * playing too early - it is a learner opening the app to a room that starts making
 * noise before they have touched anything, on a device where they did not ask for
 * sound at all. The browser's own autoplay policy already blocks *audible* playback
 * before a gesture; what it does not block is the *resource*. A context constructed
 * at import time allocates an audio device backend, starts in `suspended` state, and
 * on several platforms logs a policy warning the moment anything is connected to
 * it. The manager therefore must not construct one until a real gesture, and the
 * mechanism that proves a real gesture happened belongs in one small auditable
 * place rather than being reconstructed at each call site.
 *
 * ## Why the gesture source is injected
 *
 * The whole gate is worth nothing as untestable code. `tests/unit/audioManager.test.ts`
 * asserts that no context exists before a gesture and that one exists after, in a
 * jsdom environment that has no `AudioContext` at all. Injecting the source is what
 * makes those assertions possible without a browser: the production source binds
 * `window` listeners, the tests bind a function they can call.
 *
 * ## Why the listeners are removed after the first gesture
 *
 * The gate is one-shot. A permanent listener would keep a closure - and through it
 * the manager and, once it exists, the audio graph - reachable from the document for
 * the lifetime of the tab, and would re-check the gate on every keystroke for the
 * rest of the session. Removing them is also what makes "armed once, released
 * forever" a testable fact rather than an intention.
 *
 * ## Why these three event types
 *
 * `pointerdown` covers mouse, pen and touch on every current browser; `keydown`
 * covers keyboard and assistive-technology activation; `touchend` is kept explicitly
 * because some older WebKit builds do not deliver `pointerdown` for touch, and an
 * unlock that silently never fires on an iPad is the same class of defect as one
 * that fires too early. No `click` listener is added: a click with no preceding
 * pointer event happens only for programmatic activation, which is not a user
 * gesture.
 */

import type { AudioGestureEventName } from './audioTypes';

/** Something that can tell the manager a user gesture happened. */
export interface AudioGestureSource {
  /**
   * Register a one-shot listener. The returned disposer removes the listener, and
   * the gate calls it as soon as the gate has fired - whether it fired because a
   * gesture arrived or because `dispose` ran.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * The gesture event types this repository listens for.
 *
 * `keydown` rather than `click` because a keypress is the gesture a keyboard-only
 * learner produces first, and a learner who cannot make a click still has to be able
 * to unlock audio.
 */
export const AUDIO_GESTURE_EVENTS: readonly AudioGestureEventName[] = Object.freeze([
  'pointerdown',
  'keydown',
  'touchend',
]);

/**
 * The production gesture source: capture-phase listeners on the given window.
 *
 * Capture phase, because a gesture that a route handler calls `preventDefault` on -
 * a modal closing, a card being dragged - is still a user gesture, and a bubbling
 * listener on `window` would have missed it.
 *
 * Binds nothing if there is no window, which is the Node-side test and SSR case:
 * the gate then never fires, audio stays silent, and that is the correct outcome for
 * an environment that has no user to gesture.
 */
export function createWindowGestureSource(target?: Window | null): AudioGestureSource {
  const scope = target ?? (typeof window === 'undefined' ? null : window);
  return {
    subscribe(listener) {
      if (scope === null) return () => {};
      const handler = (): void => listener();
      for (const name of AUDIO_GESTURE_EVENTS) {
        scope.addEventListener(name, handler, { capture: true, passive: true });
      }
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        for (const name of AUDIO_GESTURE_EVENTS) {
          scope.removeEventListener(name, handler, { capture: true });
        }
      };
    },
  };
}

/** The gesture gate: armed, then fired at most once, then released. */
export interface AudioUnlockGate {
  /** True once a gesture has been observed. */
  readonly unlocked: boolean;
  /** True while listeners are attached. */
  readonly armed: boolean;
  /** Arm the gate. Idempotent: a second call while armed does nothing. */
  arm(): void;
  /** Fire the gate as though a gesture had happened. */
  unlock(): void;
  /** Release listeners. Idempotent, and never throws. */
  dispose(): void;
}

/**
 * Build the gate.
 *
 * The disposed flag is per-gate rather than module-level on purpose: a shared flag
 * would let one disposed gate disarm every other gate in the process, which in
 * tests means a suite that passes in one order and fails in another. Every guard in
 * this file exists because the manager can legitimately reach any of these states
 * more than once - `dispose` during React StrictMode's double mount, `unlock` from
 * both a gesture and an explicit call, `playBgm` on a screen that remounts.
 */
export function createAudioUnlockGate(
  source: AudioGestureSource,
  onGesture: () => void,
): AudioUnlockGate {
  let armed = false;
  let unlocked = false;
  let disposed = false;
  let release: (() => void) | null = null;

  function disarm(): void {
    const current = release;
    release = null;
    armed = false;
    if (current === null) return;
    current();
  }

  function fire(): void {
    if (unlocked || disposed) return;
    unlocked = true;
    // Disarm before `onGesture`: `onGesture` builds the audio graph, and if that
    // threw, a still-armed gate would keep a document listener alive pointing at a
    // half-built manager.
    disarm();
    onGesture();
  }

  return {
    get unlocked(): boolean {
      return unlocked;
    },
    get armed(): boolean {
      return armed;
    },
    arm(): void {
      if (armed || unlocked || disposed) return;
      armed = true;
      release = source.subscribe(fire);
    },
    unlock: fire,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disarm();
    },
  };
}
