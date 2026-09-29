/**
 * A Canvas2D context stub complete enough for PixiJS 8's Canvas2D renderer.
 *
 * ## Why this exists
 *
 * Phase 9's exit criteria are about a real PixiJS application: a real `Application`,
 * a real private `Ticker`, a real canvas in the document, and a real
 * `destroy({ releaseGlobalResources: true })`. None of that needs a GPU, and all of
 * it is worth asserting - but jsdom has no `HTMLCanvasElement.getContext`, and this
 * repository's `vitest.setup.ts` installs a *partial* stub whose `getContext` omits
 * `setTransform`, which is the first method PixiJS's `CanvasRenderTargetAdaptor`
 * calls.
 *
 * So the honest options were: assert the binding only against a hand-written double
 * (which proves nothing about PixiJS), or give the Canvas2D renderer a context that
 * records what it is asked to do. This is the second, and it is what lets
 * `pixi-application.test.ts` run the actual `createPixiApplication` twenty times.
 *
 * ## What it is and is not
 *
 * A `Proxy` that answers every property with either a recorded no-op or a recorded
 * value, so an unknown method on the real API is not a test failure waiting to
 * happen. It records calls, which is what the tests assert on; it draws nothing.
 * Every claim these tests make is about *lifecycle* - which canvas is in the
 * document, which ticker is running, what `destroy` released - and none of them is
 * about a pixel, because a Canvas2D stub in jsdom cannot produce one and a test
 * that pretended otherwise would be the Phase 8 class of defect.
 *
 * ## Hermeticity
 *
 * Installed and removed by the test file that needs it, restoring whatever was
 * there before. It reads no file, spawns no process, resolves no commit, and needs
 * no `dist/`. Nothing in it is derived from the checkout's location.
 */

/** Every 2D context call the stub saw, in order, as `name(argument string)`. */
export interface StubbedContext {
  readonly context: CanvasRenderingContext2D;
  /** Names of the methods that were called, in order, without arguments. */
  readonly calls: string[];
  /** How many times `clearRect` was called - the per-frame clear. */
  readonly clearCount: () => number;
  /** How many times a `fill` or `stroke` was requested. */
  readonly drawCount: () => number;
  readonly canvas: HTMLCanvasElement;
  /** Puts the previous `getContext` back. */
  readonly restore: () => void;
}

/** Methods that are called as functions and recorded, but need no return value. */
const VOID_METHODS: ReadonlySet<string> = new Set([
  'arc',
  'arcTo',
  'beginPath',
  'bezierCurveTo',
  'clearRect',
  'clip',
  'closePath',
  'drawImage',
  'ellipse',
  'fill',
  'fillRect',
  'fillText',
  'lineTo',
  'moveTo',
  'putImageData',
  'quadraticCurveTo',
  'rect',
  'resetTransform',
  'restore',
  'rotate',
  'roundRect',
  'save',
  'scale',
  'setLineDash',
  'setTransform',
  'stroke',
  'strokeRect',
  'strokeText',
  'transform',
  'translate',
]);

/** Methods that must return a usable object rather than nothing. */
const RETURNING_METHODS: Readonly<Record<string, () => unknown>> = {
  measureText: () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
  createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  createLinearGradient: () => ({ addColorStop: () => {} }),
  createRadialGradient: () => ({ addColorStop: () => {} }),
  createPattern: () => ({ setTransform: () => {} }),
  getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  isPointInPath: () => false,
  isPointInStroke: () => false,
};

/**
 * Build a stub 2D context bound to a canvas.
 *
 * `onCall` receives every method name, in order, which is how the tests count frames
 * and clears without reaching into PixiJS internals.
 */
export function installCanvasContextStub(): StubbedContext {
  const calls: string[] = [];
  const canvas = document.createElement('canvas');
  let clears = 0;
  let draws = 0;
  const target: Record<string | symbol, unknown> = {
    canvas,
    // Read back by PixiJS when it inspects the surface, so a real-ish value.
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };

  const context = new Proxy(target, {
    get(receiver, property): unknown {
      if (typeof property === 'symbol') return Reflect.get(receiver, property);
      if (property in receiver) return receiver[property];
      if (RETURNING_METHODS[property] !== undefined) {
        const make = RETURNING_METHODS[property];
        const bound = () => {
          calls.push(property);
          return make();
        };
        receiver[property] = bound;
        return bound;
      }
      if (VOID_METHODS.has(property)) {
        const bound = (...args: unknown[]) => {
          calls.push(property);
          if (property === 'clearRect') clears += 1;
          if (property === 'fill' || property === 'stroke' || property === 'fillRect') draws += 1;
          void args;
        };
        receiver[property] = bound;
        return bound;
      }
      // Anything else is treated as a settable data property, so a renderer writing
      // `ctx.lineWidth = 2` works and reading back an unknown property yields
      // `undefined` rather than a function that would poison an arithmetic chain.
      return undefined;
    },
    set(receiver, property, value): boolean {
      receiver[property as string] = value;
      return true;
    },
    has(): boolean {
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function stubbedGetContext(
    this: HTMLCanvasElement,
    kind: string,
  ) {
    return kind === '2d' ? context : null;
  } as HTMLCanvasElement['getContext'];

  const restore = () => {
    HTMLCanvasElement.prototype.getContext = original;
  };

  return { context, calls, clearCount: () => clears, drawCount: () => draws, canvas, restore };
}

/* -------------------------------------------------------------------------- */
/* A `ResizeObserver` of the shape jsdom does not provide                      */
/* -------------------------------------------------------------------------- */

/**
 * Installs a `ResizeObserver` that records what it observed and can be told to fire.
 *
 * ## Why a test needs one
 *
 * jsdom has no `ResizeObserver`, and PixiJS 8.21.0's `DOMPipe` branches on its
 * presence: with one it uses it and cleans it up; without one it registers
 * `updateTranslation` on `Ticker.shared` and **never sets the flag its own `destroy`
 * checks** (`node_modules/pixi.js/lib/dom/CanvasObserver.mjs`, `_attachObserver`).
 * The result is one unremovable `Ticker.shared` listener per application, each
 * holding a destroyed renderer.
 *
 * Every browser in this repository's support matrix has `ResizeObserver` - it has
 * been baseline-available since Chrome 64, Firefox 69, and Safari 13.1 - so the
 * production runtime shape is the branch with the observer. This helper supplies
 * that shape, and `pixi-application.test.ts` measures the other branch explicitly
 * and records the finding rather than hiding it.
 *
 * It is not a general-purpose implementation: `observe`/`unobserve`/`disconnect`
 * work, the callback is never invoked on its own, and `fire()` is how a test says
 * "the element's box changed". Nothing in these tests depends on automatic firing,
 * which is the one thing a real observer does that this one does not.
 */
export interface StubbedResizeObserver {
  /** Targets currently observed, across every live instance. */
  readonly observed: () => number;
  /** Every target that was ever observed, in order. */
  readonly targets: Element[];
  readonly restore: () => void;
}

export function installResizeObserverStub(): StubbedResizeObserver {
  const targets: Element[] = [];
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  class RecordingResizeObserver {
    private readonly elements = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(element: Element): void {
      this.elements.add(element);
      if (!targets.includes(element)) targets.push(element);
    }

    unobserve(element: Element): void {
      this.elements.delete(element);
    }

    disconnect(): void {
      for (const element of this.elements) {
        const index = targets.indexOf(element);
        if (index >= 0) targets.splice(index, 1);
      }
      this.elements.clear();
    }

    /** The only way a test triggers this observer; nothing calls it otherwise. */
    emit(): void {
      const entries = [...this.elements].map(
        (target) => ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry,
      );
      this.callback(entries, this as unknown as ResizeObserver);
    }
  }

  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RecordingResizeObserver;

  return {
    observed: () => targets.length,
    targets,
    restore: () => {
      if (original === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      else (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    },
  };
}
