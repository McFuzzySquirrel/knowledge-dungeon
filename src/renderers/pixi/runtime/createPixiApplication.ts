/**
 * The PixiJS 8 binding: `new Application()` followed by an asynchronous `init()`.
 *
 * ## The only `pixi.js` import in the renderer tree
 *
 * Plan section 6.1 forbids a renderer-neutral application module from importing a
 * renderer, and Phase 9 keeps the PixiJS host behind a {@link WorldApplication} port.
 * This file is where the two meet, and it is the single place in
 * `src/renderers/pixi/**` that names PixiJS: the lifecycle above it speaks the port,
 * and a scene factory is generic over its own application type, so the concrete
 * `Application` reaches a scene without this layer naming one.
 * `tests/phase9/pixi-host-boundary.test.ts` walks the import graph and fails if a
 * second file appears here.
 *
 * ## The port, the facade, and the scene
 *
 * What this module returns is a **facade**: nine lifecycle members over a real
 * `Application`, and deliberately not the `Application` itself. The host needs a
 * ticker it can pause and a teardown it can reason about, and both of those are
 * things a renderer is bad at exposing - `app.ticker` becomes `null` at destroy, and
 * `app.destroy()` on an application that was never initialised throws.
 *
 * A scene, on the other hand, draws: it needs `stage` and `screen`, neither of which
 * is lifecycle. So the facade carries the real `Application` as
 * {@link WorldApplication.native}, and {@link asPixiApplication} hands it to a scene
 * **after checking that it is one**. The composition root is the only caller. This
 * is the seam that the Phase 9 test world depends on, and the cast it replaced was
 * the reason a world had never once rendered in a browser: see the type guard's own
 * documentation.
 *
 * ## What v8 changed, and what it cost to get wrong
 *
 * - **`new Application()` takes no options.** Passing them to the constructor is
 *   ignored and logs a deprecation warning; the renderer is created inside the async
 *   `init()`. Everything below therefore happens after `await`.
 * - **`app.canvas`, not `app.view`.** The old getter still works and warns.
 * - **The ticker callback receives the `Ticker`, not a delta.** The v7
 *   `(dt) => sprite.rotation += dt` form type-checks and then multiplies a `Ticker`
 *   by a number. {@link PixiApplication.onFrame} is where that becomes the
 *   millisecond delta the scene contract promises, so no scene inherits the mistake.
 * - **A private ticker.** `sharedTicker` is left `false` and a fresh `Ticker` is
 *   created, so `stopTicker()` pauses this world and nothing else.
 *   `Ticker.shared` is process-wide and `Ticker.system` drives the engine's own
 *   background work; pausing either would freeze things the world does not own.
 * - **`autoStart: false`.** The host decides when the loop runs.
 * - **`resizeTo: null`.** Pixi's `ResizePlugin` listens on `globalThis`; the host
 *   owns sizing instead. See `pixiInitOptions.ts` for the full option record.
 *
 * ## Teardown
 *
 * `destroy({ removeView: true, releaseGlobalResources: true }, { children: true })`:
 *
 * - `removeView` detaches the canvas through `ViewSystem`, which also destroys the
 *   screen texture and removes this renderer's entries from the shared texture and
 *   canvas pools. Without it, a twenty-cycle mount loop leaves twenty canvases
 *   attached to nothing.
 * - `releaseGlobalResources` drains the renderer's process-wide pools - batchers,
 *   shader programs, uniform groups. It is the documented remedy for tearing an
 *   application down and creating another in the same tab, which is exactly what a
 *   world the learner navigates away from and back to does. It is an *option*
 *   rather than a fixed behaviour because it would be wrong for a host sharing one
 *   renderer across several live worlds; this host is the only renderer in the
 *   application, so `true` is correct here and the seam exists for Phase 10.
 * - `{ children: true }` on the stage, and deliberately **not** `texture: true` or
 *   `textureSource: true`. Textures belong to the scene that created them: a scene
 *   destroys its own, and Phase 10's `Assets.unload` will own bundle textures. A
 *   host that destroyed every texture in the stage would free a texture another
 *   scene still holds.
 *
 * One trap this phase's own tests found, worth writing down: **`app.destroy()` on an
 * application that was never `init()`ed throws.** `Application.destroy` runs every
 * plugin's destroy hook, and `ResizePlugin`'s hook calls a helper its `init` hook
 * created. So the host never destroys an application it did not finish creating.
 */
import { Application } from 'pixi.js';
import type { Renderer } from 'pixi.js';

import { pixiInitOptions } from './pixiInitOptions';
import type {
  WorldApplication,
  WorldApplicationDestroyOptions,
  WorldApplicationSpec,
} from './types';

/**
 * The concrete PixiJS application a scene factory receives.
 *
 * Named rather than inlined so a scene's parameter reads as a renderer type at the
 * point of use, without the port above it naming one.
 */
export type PixiApplication = Application<Renderer>;

/**
 * Narrow a {@link WorldApplication} to the PixiJS `Application` behind it.
 *
 * ## Why a check rather than a cast
 *
 * A scene draws display objects, so it needs a real `Application`; the port it
 * arrives on is a nine-member lifecycle facade with no `stage` and no `screen`. The
 * two obvious ways across that gap are both wrong:
 *
 * - `application as unknown as PixiApplication` **invents** the object. It type-checks
 *   perfectly and then hands the scene a facade that has no `stage`, so the first
 *   thing the scene does throws `Cannot read properties of undefined`, the host
 *   catches it, and the screen renders a failure notice. Nothing about the cast can
 *   fail, which is the property that made it ship.
 * - Widening the port to name a PixiJS type puts an engine into a renderer-neutral
 *   contract, which plan section 6.1 forbids and which would make every future
 *   binding a second special case.
 *
 * This is the third way, and it is sound: the value behind the facade *is* the
 * `Application` this module created, so `instanceof` is a fact about the value rather
 * than a hope about it. A caller that hands the scene factory something else - a test
 * double, a Phase 10 asset-bundle binding, a second renderer - gets an exception that
 * names the cause at the seam, instead of a scene that throws three frames later.
 *
 * It lives here rather than in the composition root because this is the only module
 * in `src/renderers/pixi/runtime/` allowed to name PixiJS, and a narrowing function
 * that cannot mention the type it narrows to is not a narrowing function.
 */
export function asPixiApplication(application: WorldApplication): PixiApplication {
  const native: unknown = application.native;
  if (native instanceof Application) return native;
  throw new Error(
    'A Pixi world scene was given a world application with no PixiJS Application behind it, so the ' +
      'application and the scene are not bound to the same renderer. The scene factory and the ' +
      'application factory have to come from the same binding.',
  );
}

/** Create a PixiJS application for one world mount. */
export async function createPixiApplication(spec: WorldApplicationSpec): Promise<WorldApplication> {
  // v8: no constructor options. The renderer does not exist until `init` resolves,
  // so `app.canvas`, `app.stage`, and `app.ticker` are all read after the await.
  const app = new Application();
  await app.init({ ...pixiInitOptions(spec) });
  applyFrameRateCap(app, spec.quality.maxFps);

  return {
    /**
     * The engine object itself, for {@link asPixiApplication}.
     *
     * The real `Application`, not a copy and not a proxy: a scene that adds a
     * `Container` to `app.stage` has to be adding it to the graph the renderer
     * actually walks at draw time, and there is exactly one such object per mount.
     */
    native: app,
    get canvas(): HTMLCanvasElement {
      return app.canvas as HTMLCanvasElement;
    },
    get screenWidth(): number {
      return app.screen.width;
    },
    get screenHeight(): number {
      return app.screen.height;
    },
    get tickerRunning(): boolean {
      // `TickerPlugin.destroy` sets `app.ticker = null`, so this getter throws after
      // teardown unless it is guarded. The host reads it to decide whether a frame
      // subscription is still live, and a teardown in the same turn as a visibility
      // change is the ordinary way to get there.
      return app.ticker?.started === true;
    },
    resize(width: number, height: number): void {
      // Guarded because `app.renderer` is null after `destroy`, and a resize that
      // arrives in the same turn as an unmount must not throw inside a
      // `ResizeObserver` callback where nothing can catch it.
      if (!app.renderer) return;
      app.renderer.resize(width, height, app.renderer.resolution);
      app.render();
    },
    startTicker(): void {
      app.start();
    },
    stopTicker(): void {
      app.stop();
    },
    onFrame(listener: (deltaMs: number) => void): () => void {
      // v8 passes the Ticker, not a delta. `deltaMS` is the elapsed interval for
      // the frame being reported, and it is already scaled by `ticker.speed` and
      // capped by `ticker.minFPS` - which is what a scene wants, because a
      // four-second stall must not teleport a sprite across the screen.
      const onTick = (ticker: { deltaMS: number }): void => {
        listener(Number.isFinite(ticker.deltaMS) ? ticker.deltaMS : 0);
      };
      const ticker = app.ticker;
      ticker.add(onTick);
      // Captured, so the unsubscribe still works after `Application.destroy` has
      // replaced `app.ticker` with `null`. A frame subscription the host could not
      // release would fire against a destroyed renderer.
      return () => ticker.remove(onTick);
    },
    destroy({ releaseGlobalResources }: WorldApplicationDestroyOptions): void {
      // The private ticker is destroyed by `TickerPlugin.destroy`, which
      // `Application.destroy` runs first. Nothing here stops it explicitly: a
      // `Ticker` created with `new Ticker()` is not protected, so `destroy` really
      // removes its `requestAnimationFrame` loop.
      app.destroy({ removeView: true, releaseGlobalResources }, { children: true });
    },
  };
}

/**
 * Apply a frame-rate ceiling, or say why it is not being applied.
 *
 * `maxFps` on a ticker *skips frames* rather than capping how long a frame may take.
 * A ceiling of `0` therefore means "no cap" and is written as such, rather than
 * being left to whatever default the ticker had. A non-finite value is ignored
 * rather than clamped: a caller that computed one has a bug, and accepting it
 * silently would hide that behind a plausible frames-per-second number.
 */
function applyFrameRateCap(app: Application, maxFps: number): void {
  if (!Number.isFinite(maxFps)) return;
  app.ticker.maxFPS = maxFps > 0 ? maxFps : 0;
}
