/**
 * A test gesture source: nothing is bound to a document, and the test fires it.
 *
 * ## Why the manager's gesture source is injected at all
 *
 * Because "no audio plays before a user gesture" is otherwise untestable in jsdom.
 * The production gate binds capture-phase listeners on `window`; a test that wanted
 * to exercise it would have to synthesise a real DOM event and then assert that no
 * `AudioContext` exists, which in an environment with no `AudioContext` would pass
 * whether or not the gate worked. So the tests drive the gate directly, and this
 * helper makes the distinction visible in the test body: `fire()` is the gesture.
 *
 * It also records `disposals`, which is how "the gate removes its listeners" becomes
 * an assertion rather than a comment.
 */
import type { AudioGestureSource } from '@/services/audioManager';

export interface TestGestureSource extends AudioGestureSource {
  /** Deliver a user gesture to whoever is subscribed. */
  fire(): void;
  /** How many times a subscription was created. */
  readonly subscribeCount: number;
  /** How many times a subscription was removed. */
  readonly disposeCount: number;
  /** True while a listener is attached. */
  readonly active: boolean;
}

export function createTestGestureSource(): TestGestureSource {
  let listener: (() => void) | null = null;
  let subscribeCount = 0;
  let disposeCount = 0;

  return {
    subscribe(next) {
      subscribeCount += 1;
      // A second concurrent subscription on one source is a gate bug, not a test
      // scenario, so it replaces - and the count makes it visible.
      listener = next;
      return () => {
        disposeCount += 1;
        if (listener === next) listener = null;
      };
    },
    fire(): void {
      const current = listener;
      if (current === null) return;
      current();
    },
    get subscribeCount(): number {
      return subscribeCount;
    },
    get disposeCount(): number {
      return disposeCount;
    },
    get active(): boolean {
      return listener !== null;
    },
  };
}

/** A graph that was never built: what `createGraph` returns when audio is unsupported. */
export const NULL_GRAPH_FACTORY = () => null;
