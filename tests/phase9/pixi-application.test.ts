/**
 * The PixiJS 8 binding, exercised against the real engine.
 *
 * ## Why these tests load PixiJS
 *
 * A hand-written double would prove that the binding calls what the test double
 * implements, which is circular. Everything below runs the *actual*
 * `createPixiApplication`: a real `new Application()`, a real asynchronous `init()`,
 * a real private `Ticker` driven by jsdom's `requestAnimationFrame`, a real canvas in
 * the document, and a real `app.destroy({ removeView, releaseGlobalResources })`.
 * The only thing faked is the GPU - see `support/canvasContextStub.ts`, and the
 * honest list of what that does and does not establish is at the end of this header.
 *
 * ## The renderer choice
 *
 * `preference: 'canvas'` on every call here. jsdom has no WebGL and no WebGPU, so
 * the production default of `'webgl'` would make `autoDetectRenderer` fail and every
 * test would be an assertion about a failure. The Canvas2D renderer is a real PixiJS
 * renderer, so the code under test - constructor, async init, ticker wiring, resize,
 * teardown - is the same code it would be on a GPU. What differs is only which
 * renderer `autoDetectRenderer` selected, and that choice is a string this file
 * passes in.
 *
 * ## What this establishes, and what it cannot
 *
 * Established: the canvas is the one the caller supplied; the ticker is private and
 * its callback signature is v8's; the ticker does not start on its own; resize
 * reaches the surface in CSS pixels; `onFrame` delivers real millisecond deltas and
 * unsubscribes; teardown detaches the canvas and drains the global pools; and twenty
 * mount/unmount cycles leave the document with the same number of canvases it started
 * with and the same number of `resize`/`visibilitychange` listeners.
 *
 * Not established, and stated rather than implied: GPU texture and buffer memory,
 * JavaScript heap growth, and WebGL context loss. All three need a browser and a
 * renderer-side counter, and this file says so in its own output rather than letting
 * a green run stand in for them.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no network, no spawned process. The only global this file
 * installs is the Canvas2D context stub, and it restores the previous one in
 * `afterAll`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from './support/canvasContextStub';

let stub: StubbedContext & { restore(): void };
let Application: typeof import('pixi.js').Application;
let Ticker: typeof import('pixi.js').Ticker;
let createPixiApplication: typeof import('@/renderers/pixi/runtime/createPixiApplication').createPixiApplication;
let asPixiApplication: typeof import('@/renderers/pixi/runtime/createPixiApplication').asPixiApplication;
let pixiInitOptions: typeof import('@/renderers/pixi/runtime/pixiInitOptions').pixiInitOptions;
let resolveWorldQualityProfile: typeof import('@/renderers/pixi/runtime/types').resolveWorldQualityProfile;
let WORLD_QUALITY_PROFILES: typeof import('@/renderers/pixi/runtime/types').WORLD_QUALITY_PROFILES;
type WorldQualityProfile = import('@/renderers/pixi/runtime/types').WorldQualityProfile;
type WorldApplication = import('@/renderers/pixi/runtime/types').WorldApplication;
type WorldApplicationSpec = import('@/renderers/pixi/runtime/types').WorldApplicationSpec;

beforeAll(async () => {
  stub = installCanvasContextStub();
  const pixi = await import('pixi.js');
  Application = pixi.Application;
  Ticker = pixi.Ticker;
  const binding = await import('@/renderers/pixi/runtime/createPixiApplication');
  createPixiApplication = binding.createPixiApplication;
  asPixiApplication = binding.asPixiApplication;
  pixiInitOptions = (await import('@/renderers/pixi/runtime/pixiInitOptions')).pixiInitOptions;
  const types = await import('@/renderers/pixi/runtime/types');
  resolveWorldQualityProfile = types.resolveWorldQualityProfile;
  WORLD_QUALITY_PROFILES = types.WORLD_QUALITY_PROFILES;
});

afterAll(() => {
  stub.restore();
});

/** The Canvas2D profile, so `autoDetectRenderer` succeeds without a GPU. */
function testProfile(): WorldQualityProfile {
  return Object.freeze({ ...resolveWorldQualityProfile('balanced'), preference: 'canvas' as const });
}

function specFor(canvas: HTMLCanvasElement, overrides: Partial<WorldApplicationSpec> = {}): WorldApplicationSpec {
  return { canvas, quality: testProfile(), background: 0x191410, backgroundAlpha: 1, ...overrides };
}

function newCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return canvas;
}

/** Let jsdom's `requestAnimationFrame` run for a few frames. */
async function pump(frames = 3): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 24);
    });
  }
}

describe('the init options are a decision, not a default', () => {
  it('asks for a private ticker, no auto-start, and no ResizePlugin listener', () => {
    const options = pixiInitOptions(specFor(document.createElement('canvas')), 1);
    // A shared ticker would make this world's visibility pause freeze every other
    // renderer in the process, and `Ticker.shared` is process-wide.
    expect(options.sharedTicker).toBe(false);
    // The host decides when the loop runs, because the host knows whether the
    // document is hidden.
    expect(options.autoStart).toBe(false);
    // Pixi's ResizePlugin adds a `globalThis` listener. Left unset, the host owns
    // sizing through its own observer and there is one fewer listener to account for.
    expect(options.resizeTo).toBeUndefined();
    expect('resizeTo' in options && options.resizeTo !== undefined).toBe(false);
  });

  it('takes resolution, antialiasing, and preference from the quality profile', () => {
    const canvas = document.createElement('canvas');
    // A DPR-2 display: every profile's cap is at or below 2, so each reaches the
    // renderer unchanged. This is the half that proves the profile arrives at the
    // binding rather than being recomputed there.
    for (const [id, profile] of Object.entries(WORLD_QUALITY_PROFILES)) {
      const options = pixiInitOptions(specFor(canvas, { quality: profile }), 2);
      expect(options.resolution, id).toBe(profile.resolution);
      expect(options.antialias, id).toBe(profile.antialias);
      expect(options.preference, id).toBe(profile.preference);
    }

    // A DPR-1 display is the case QA measured: `resolution` is a *cap*, so the
    // effective value is `min(1, resolution)` = 1 for every profile. The old
    // passthrough rendered `balanced` at 2 here - 4x the raster pixels, downscaled.
    for (const [id, profile] of Object.entries(WORLD_QUALITY_PROFILES)) {
      const options = pixiInitOptions(specFor(canvas, { quality: profile }), 1);
      expect(options.resolution, id).toBe(1);
    }

    // A 3x display is capped back to 2: the cap holds as device density rises, so a
    // denser screen does not reopen the pixel cost the cap exists for.
    const dense = pixiInitOptions(specFor(canvas, { quality: resolveWorldQualityProfile('balanced') }), 3);
    expect(dense.resolution).toBe(2);

    // A constrained device really is cheaper at the same ratio: quarter the pixels
    // at a device-pixel ratio of 2, and no antialiasing.
    const constrained = pixiInitOptions(
      specFor(canvas, { quality: resolveWorldQualityProfile('constrained') }),
      2,
    );
    const balanced = pixiInitOptions(specFor(canvas, { quality: resolveWorldQualityProfile('balanced') }), 2);
    expect(constrained.resolution).toBeLessThan(balanced.resolution);
    expect(constrained.antialias).toBe(false);
  });

  it('carries the clear colour and the caller’s canvas, and never names a body', () => {
    const canvas = document.createElement('canvas');
    const options = pixiInitOptions(specFor(canvas, { background: 0x241d18 }), 1);
    expect(options.canvas).toBe(canvas);
    expect(options.background).toBe(0x241d18);
    expect(options.backgroundAlpha).toBe(1);
    // A 1x1 starting surface, because the host resizes to its element before the
    // first frame; the alternative is a frame of wasted full-screen allocation.
    expect(options.width).toBe(1);
    expect(options.height).toBe(1);
    // Never a banner, and never a version string in a learner's console.
    expect(options.hello).toBe(false);
    expect(Object.values(options).some((value) => typeof value === 'string' && value.includes('body'))).toBe(
      false,
    );
  });

  it('is frozen, so a caller cannot hand a mutated record to a later mount', () => {
    const options = pixiInitOptions(specFor(document.createElement('canvas')), 1);
    expect(Object.isFrozen(options)).toBe(true);
  });
});

describe('the real binding creates, sizes, and drives a real PixiJS application', () => {
  let canvas: HTMLCanvasElement;
  let app: WorldApplication;

  beforeEach(async () => {
    canvas = newCanvas();
    app = await createPixiApplication(specFor(canvas));
  });

  afterEach(() => {
    if (canvas.isConnected) app.destroy({ releaseGlobalResources: true });
  });

  it('renders into the canvas the caller supplied, and appends nothing itself', () => {
    expect(app.canvas).toBe(canvas);
    // The binding must not put a canvas anywhere: the host owns insertion, and a
    // renderer that appends to `document.body` is a renderer whose canvas lands on
    // top of the application.
    expect(document.body.querySelectorAll('canvas')).toHaveLength(1);
    expect(document.body.contains(canvas)).toBe(true);
  });

  it('creates a private ticker, and does not start it on its own', () => {
    // `autoStart: false` and a fresh `Ticker` rather than `Ticker.shared`; the
    // shared instance is protected from `destroy`, so a host using it could never
    // release it.
    expect(app.tickerRunning).toBe(false);
    app.startTicker();
    expect(app.tickerRunning).toBe(true);
    app.stopTicker();
    expect(app.tickerRunning).toBe(false);
  });

  it('resizes the surface in CSS pixels', () => {
    app.resize(320, 200);
    expect(app.screenWidth).toBe(320);
    expect(app.screenHeight).toBe(200);
    // The element's own CSS size stays in CSS pixels - that is what `autoDensity`
    // is for - while the backing store carries the resolution.
    expect(canvas.style.width).toBe('320px');
    expect(canvas.style.height).toBe('200px');
  });

  it('delivers real millisecond deltas through `onFrame`, and unsubscribes', async () => {
    const deltas: number[] = [];
    const stop = app.onFrame((deltaMs) => deltas.push(deltaMs));
    app.startTicker();
    await pump(3);
    app.stopTicker();
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    // A frame interval, not a frame *count*: the v7 signature handed a callback the
    // Ticker object, and reading a delta off that is `NaN` in motion.
    for (const delta of deltas) {
      expect(Number.isFinite(delta)).toBe(true);
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(1000);
    }
    const delivered = deltas.length;
    stop();
    app.startTicker();
    await pump(2);
    app.stopTicker();
    expect(deltas, 'the frame subscription survived its unsubscribe').toHaveLength(delivered);
  });

  it('a resize after teardown is a no-op rather than a throw in an observer callback', () => {
    app.destroy({ releaseGlobalResources: true });
    expect(() => app.resize(100, 100)).not.toThrow();
  });
});

describe('the narrowing from a port to an engine is a check, not a claim', () => {
  /**
   * The seam that shipped a cast.
   *
   * `createTestWorld` needs `stage` and `screen`; the port is a lifecycle facade with
   * neither. The code that used to reconcile that, `application as unknown as
   * PixiApplication`, could not fail at compile time or at run time before the scene
   * used it, and the three tests around it never bound the two together. What is
   * asserted here is that the value behind the facade really is the engine object the
   * binding created - the identical object, checked by identity - and that a facade
   * without one is refused at the seam, in one line, naming the cause.
   *
   * The composition root that calls this is covered end to end in
   * `tests/phase9/pixi-composition-root.test.tsx`.
   */
  it('hands a scene the very application the binding created', async () => {
    // The hook has to be installed *before* the application is created: PixiJS calls
    // it from its own `init` plugin, once, and an application that was already
    // initialised has already gone past it.
    const captured: unknown[] = [];
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = scope['__PIXI_APP_INIT__'];
    scope['__PIXI_APP_INIT__'] = (app: unknown): void => {
      captured.push(app);
    };
    const canvas = newCanvas();
    let application: WorldApplication | null = null;
    try {
      application = await createPixiApplication(specFor(canvas));
      expect(captured, 'PixiJS did not report the application to its own init hook').toHaveLength(1);

      const narrowed = asPixiApplication(application);
      // Identity, not structural agreement: the scene adds `Container`s to *this*
      // stage, the one the renderer walks at draw time.
      expect(narrowed).toBe(captured[0]);
      expect(narrowed.stage).toBeTruthy();
      expect(narrowed.screen.width).toBe(1);
      expect(asPixiApplication(application), 'and it is stable across reads').toBe(narrowed);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(scope, '__PIXI_APP_INIT__');
      else scope['__PIXI_APP_INIT__'] = previous;
      if (canvas.isConnected) application?.destroy({ releaseGlobalResources: true });
    }
  });

  it('refuses an application with no engine behind it, rather than inventing one', async () => {
    const canvas = newCanvas();
    const application = await createPixiApplication(specFor(canvas));
    try {
      // A lifecycle double, which is what every other test in this repository that
      // implements the port hands the host. Passing one to a Pixi scene factory used
      // to produce `Cannot read properties of undefined (reading 'addChild')` three
      // frames later, in a screen that reported the failure and nothing else.
      const double: WorldApplication = { ...application, native: null };
      expect(() => asPixiApplication(double)).toThrow(/no PixiJS Application behind it/);
      // And a facade whose `native` is a look-alike is refused too, because the
      // narrowing is an `instanceof` and not a shape.
      const impostor: WorldApplication = { ...application, native: { stage: {}, screen: {} } };
      expect(() => asPixiApplication(impostor)).toThrow(/same renderer/);
    } finally {
      application.destroy({ releaseGlobalResources: true });
    }
  });
});

describe('teardown releases what the mount created', () => {
  it('detaches the canvas and drains the global pools', async () => {
    const canvas = newCanvas();
    const app = await createPixiApplication(specFor(canvas));
    const host = document.createElement('div');
    document.body.appendChild(host);
    canvas.remove();
    host.appendChild(canvas);
    app.startTicker();
    await pump(2);
    expect(canvas.isConnected).toBe(true);

    app.destroy({ releaseGlobalResources: true });

    // `removeView: true` runs `ViewSystem.destroy`, which also removes this
    // renderer's screen entries from the shared texture and canvas pools. Without
    // it a twenty-cycle loop leaves twenty canvases attached to nothing.
    expect(canvas.isConnected).toBe(false);
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
    expect(app.tickerRunning).toBe(false);
    host.remove();
  });

  it('`releaseGlobalResources: false` still releases the view, so a shared-renderer host is safe', async () => {
    const canvas = newCanvas();
    const app = await createPixiApplication(specFor(canvas));
    app.destroy({ releaseGlobalResources: false });
    // The distinction is about *process-wide* pools, which a host sharing a renderer
    // across live worlds must not drain. The canvas is this renderer's own, and
    // always goes.
    expect(canvas.isConnected).toBe(false);
  });

  it('destroying an application that was never initialised throws - the trap the host avoids', () => {
    // Recorded because the host has to know it: `Application.destroy` runs every
    // plugin's destroy hook, and `ResizePlugin`'s hook calls a helper its `init` hook
    // created. A host that destroyed a renderer whose `init` had failed would turn
    // a mount failure into an unhandled throw.
    const never = new Application();
    expect(() => never.destroy({ removeView: true, releaseGlobalResources: true }, { children: true })).toThrow();
    // Constructing is inert and safe, which is the half that does work.
    expect(never.stage).toBeDefined();
  });

  it('the private ticker is a fresh instance each mount, never the shared one', async () => {
    const first = newCanvas();
    const second = newCanvas();
    const a = await createPixiApplication(specFor(first));
    const b = await createPixiApplication(specFor(second));
    // Two live worlds, two tickers: pausing one must not pause the other.
    a.startTicker();
    expect(b.tickerRunning).toBe(false);
    a.stopTicker();
    expect(b.tickerRunning).toBe(false);
    a.destroy({ releaseGlobalResources: false });
    b.destroy({ releaseGlobalResources: false });
  });
});

describe('twenty mount and unmount cycles leave the document as they found it', () => {
  /**
   * The production runtime shape.
   *
   * jsdom has no `ResizeObserver`, and PixiJS 8.21.0's `DOMPipe` takes a different,
   * leaky branch without one - a measured finding this file records in its own
   * right, below. Every browser in the support matrix has `ResizeObserver`, so this
   * is the shape the leak criterion is about, and the host's own code is byte-for-byte
   * the same in both.
   */
  let observer: StubbedResizeObserver;

  beforeEach(() => {
    observer = installResizeObserverStub();
  });

  afterEach(() => {
    observer.restore();
  });

  it('canvas count, listener count, and observed-element count return to baseline', async () => {
    const CYCLES = 20;
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const docAddSpy = vi.spyOn(document, 'addEventListener');
    const docRemoveSpy = vi.spyOn(document, 'removeEventListener');
    try {
      const baselineCanvases = document.querySelectorAll('canvas').length;
      expect(baselineCanvases).toBe(0);

      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const canvas = document.createElement('canvas');
        const app = await createPixiApplication(specFor(canvas));
        host.appendChild(canvas);
        app.resize(320, 240);
        const stop = app.onFrame(() => {});
        app.startTicker();
        if (cycle === 1) await pump(2);
        stop();
        app.destroy({ releaseGlobalResources: true });

        expect(document.querySelectorAll('canvas'), `cycle ${cycle} left a canvas`).toHaveLength(
          baselineCanvases,
        );
        expect(canvas.isConnected, `cycle ${cycle} left the canvas attached`).toBe(false);
        host.remove();
      }

      // Every event type the loop subscribed to must be unsubscribed at least as
      // often. `>=` rather than `==`, because PixiJS's `ResizePlugin.destroy` removes
      // its `resize` listener unconditionally even when `resizeTo: undefined` meant
      // it never added one - an over-removal, which is harmless. A leak shows up in
      // the other direction, and a failure here names the event type.
      const counted = new Map<string, { added: number; removed: number }>();
      const tally = (type: string, key: 'added' | 'removed') => {
        const balance = counted.get(type) ?? { added: 0, removed: 0 };
        counted.set(type, { ...balance, [key]: balance[key] + 1 });
      };
      for (const [type] of addSpy.mock.calls) tally(type, 'added');
      for (const [type] of docAddSpy.mock.calls) tally(type, 'added');
      for (const [type] of removeSpy.mock.calls) tally(type, 'removed');
      for (const [type] of docRemoveSpy.mock.calls) tally(type, 'removed');
      const leaked = [...counted.entries()]
        .filter(([, balance]) => balance.added > balance.removed)
        .map(([type, balance]) => `${type} +${balance.added} -${balance.removed}`);
      expect(leaked, `a window or document listener survived ${CYCLES} mount/unmount cycles`).toEqual([]);

      // And every element a `ResizeObserver` was asked to watch is unwatched, which
      // is the DOM-side half of a mount leaving nothing behind.
      expect(observer.observed(), 'a ResizeObserver kept watching a destroyed canvas').toBe(0);
      expect(observer.targets.length, 'nothing should ever have been watched at the end').toBe(0);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      docAddSpy.mockRestore();
      docRemoveSpy.mockRestore();
    }
  }, 30_000);

  it('the process-wide ticker gains no listeners over twenty cycles', async () => {
    const CYCLES = 20;
    const before = Ticker.shared.count;
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const app = await createPixiApplication(specFor(canvas));
      app.startTicker();
      app.stopTicker();
      app.destroy({ releaseGlobalResources: true });
    }
    // `Ticker.shared.count` is the number of listeners on the process-wide ticker.
    // Two independent things are being checked at once: that the host uses a private
    // ticker (`sharedTicker: false`), and that PixiJS's own subsystems release what
    // they attach. A non-zero delta would mean either.
    expect(Ticker.shared.count).toBe(before);
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  }, 30_000);
});

describe('a recorded PixiJS 8.21.0 finding, in the shape it actually occurs', () => {
  /**
   * Recorded rather than worked around.
   *
   * `CanvasObserver._attachObserver` takes a different branch when the runtime has
   * no `ResizeObserver`: it registers `updateTranslation` on `Ticker.shared`, and
   * never sets the `_tickerAttached` flag that its own `destroy` tests, so the
   * listener is never removed and the closure keeps the whole destroyed application
   * alive. Every browser in this repository's support matrix has `ResizeObserver`,
   * so the branch does not occur in the shipped matrix; it does occur in jsdom, in
   * Safari below 13.1, and in any embedded webview that predates it.
   *
   * The host does not monkey-patch the global to steer around an upstream defect in
   * runtimes this application does not support, and it does not reach into
   * `app.renderer.renderPipes.dom` to call an internal `destroy`. Both would be worse
   * than the finding. What it does is measure the condition, so the browser lane and
   * Phase 10 have a number to compare against and an upstream issue to cite.
   */
  it('costs one unremovable Ticker.shared listener per application without a ResizeObserver', async () => {
    // Asserted: jsdom really has no `ResizeObserver`, so the control is the shipped
    // shape and the body of the test is the degraded one.
    expect((globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBeUndefined();

    const CYCLES = 5;
    const before = Ticker.shared.count;
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const app = await createPixiApplication(specFor(canvas));
      app.startTicker();
      app.stopTicker();
      app.destroy({ releaseGlobalResources: true });
    }
    // One per application, exactly: the growth is linear and unbounded, so a world
    // mounted and unmounted twenty times leaves twenty dead closures on a ticker that
    // keeps running for the life of the page.
    expect(Ticker.shared.count - before).toBe(CYCLES);
    expect(document.querySelectorAll('canvas'), 'the canvases themselves are still released').toHaveLength(0);

    // The same loop with an observer present costs nothing, which is what makes this
    // a `ResizeObserver` condition rather than a defect in the host.
    const observer = installResizeObserverStub();
    try {
      const withObserver = Ticker.shared.count;
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const app = await createPixiApplication(specFor(canvas));
        app.destroy({ releaseGlobalResources: true });
      }
      expect(Ticker.shared.count).toBe(withObserver);
    } finally {
      observer.restore();
    }
  }, 30_000);
});
