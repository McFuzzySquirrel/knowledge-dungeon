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
 *
 * ## Why the asset runtime is here too
 *
 * Phase 10 added a second binding to this module, and the reason it did not get its
 * own file is the first paragraph of this header read as a rule:
 * `tests/phase9/pixi-host-boundary.test.ts` walks `src/renderers/**` and fails unless
 * the set of modules importing `pixi.js` is exactly the two it names - this one and
 * the Phase 9 scene. A separate `pixiAssetRuntime.ts` would have made that three and
 * turned a deliberate decision into a red test, which is exactly what that gate is
 * for: a new engine importer is a review, not a diff. The Phase 10 review happened;
 * this is the result.
 *
 * The alternative - letting `AssetLoader.ts` import the engine - was rejected on the
 * merits rather than on the test. The loader is policy: reference counts, in-flight
 * idempotence, the required/optional split, deferred release, and a bounded
 * diagnostic. None of that needs a GPU, a DOM, or a network, and putting the engine
 * behind {@link PixiAssetRuntime} is what lets `tests/phase10/asset-loader.test.ts`
 * exercise all of it against a plain object. The engine is here; the policy is not.
 *
 * The two release methods are the loader's contract, so they are worth naming here:
 * Pixi's texture parsers implement `unload` as `texture.destroy(true)`, so
 * `Assets.unloadBundle` and `Assets.unload` genuinely free GPU memory rather than
 * dropping a cache entry. The loader relies on that and does **not** call
 * `destroyTexture` on anything this runtime loaded - a second `destroy(true)` on an
 * already-destroyed texture is a use-after-free, not belt and braces.
 */
import { Application, Assets, CanvasSource, Texture } from 'pixi.js';
import type { Renderer } from 'pixi.js';

import { pixiInitOptions } from './pixiInitOptions';
import type {
  PixiAssetRuntime,
  ResolvedFallbackRecipe,
} from '../assets/AssetLoader';
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

/* -------------------------------------------------------------------------- */
/* The PixiJS asset runtime                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A 2D context and the canvas it came from, or `null` in a realm without one.
 *
 * The `null` branch is the interesting one. A procedural fallback that cannot be
 * drawn must not become a thrown `TypeError` inside a world mount, which is the same
 * failure shape the loader's whole no-reject policy exists to avoid - so the recipe
 * degrades to a flat fill when there is no 2D context, and to a one-pixel white
 * texture when there is no canvas either. Both are visibly wrong; neither is a crash
 * on a route.
 *
 * ## Why the canvas is returned rather than assigned onto the context
 *
 * The first version of this assigned `context.canvas = canvas` and read the canvas
 * back off the context in {@link createFallbackTexture}. **That throws in every
 * browser in the support matrix.** `CanvasRenderingContext2D.prototype.canvas` is
 * an accessor with only a getter, so the assignment is a `TypeError`, and this
 * module is an ES module, so it is strict mode and the throw is not swallowed:
 *
 *     TypeError: Cannot set property canvas of #<CanvasRenderingContext2D>
 *                which has only a getter
 *
 * The Phase 10 browser lane found it by calling the shipped runtime in real
 * Chromium, where it made `createFallbackTexture` — the very thing that exists so
 * a missing asset cannot break a route — throw on every call. jsdom missed it
 * because `vitest.setup.ts` replaces `getContext` with a plain object literal, and
 * a plain object has a writable `canvas` data property.
 *
 * There was never a reason to write the property: the platform already puts the
 * canvas on the context, and the code that needs the canvas created it one line
 * earlier. So the canvas is returned alongside the context and read from there.
 * `tests/phase10/browser-shape-parity.test.ts` is the regression gate, and it
 * defines `canvas` with the platform's getter-only descriptor so the shape that
 * matters is the one under test.
 */
function fallbackSurface(
  width: number,
  height: number,
): { readonly canvas: HTMLCanvasElement; readonly context: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (context === null) return null;
  return { canvas, context };
}

/** `roundRect` is not in every jsdom and not in every browser the matrix names. */
function roundRectPath(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(0, 0, width, height, r);
    return;
  }
  context.moveTo(r, 0);
  context.lineTo(width - r, 0);
  context.quadraticCurveTo(width, 0, width, r);
  context.lineTo(width, height - r);
  context.quadraticCurveTo(width, height, width - r, height);
  context.lineTo(r, height);
  context.quadraticCurveTo(0, height, 0, height - r);
  context.lineTo(0, r);
  context.quadraticCurveTo(0, 0, r, 0);
  context.closePath();
}

function numberToCss(value: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, Math.round(value)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
}

/** Whether a 2D context can express a path at all, as opposed to only boxes. */
function canDrawPath(context: CanvasRenderingContext2D): boolean {
  return (
    typeof context.beginPath === 'function' &&
    typeof context.moveTo === 'function' &&
    typeof context.lineTo === 'function' &&
    typeof context.quadraticCurveTo === 'function'
  );
}

/** Whether a 2D context can express an ellipse, by either spelling. */
function canDrawEllipse(context: CanvasRenderingContext2D): boolean {
  return (
    canDrawPath(context) &&
    (typeof context.ellipse === 'function' || typeof context.arc === 'function')
  );
}

/**
 * Draw one recipe onto a canvas.
 *
 * Exported so the *shape* of a procedural fallback is testable without PixiJS: the
 * assertions are about the geometry and the colours, and `tests/phase10/pixi-asset-runtime.test.ts`
 * uses it to check that a missing optional entry produces a real, Cozy-coloured draw
 * rather than an empty texture.
 *
 * ## Why every branch is guarded rather than assumed
 *
 * The first version of this function called `moveTo`/`lineTo`/`quadraticCurveTo` and
 * `ellipse` directly, and threw a `TypeError` on any 2D context that lacked one. That
 * is not a hypothetical: this repository's own jsdom setup installs a stub context
 * that has `fillRect` and no `quadraticCurveTo`, and the first run of the Phase 10
 * tests turned a "missing optional art does not break a route" guarantee into a
 * thrown error on every fallback in a test realm. A procedural fallback is the thing
 * that is *supposed* to be impossible to fail on, so a shape the context cannot
 * express degrades to the box the context can always express.
 */
export function drawAssetFallback(
  context: CanvasRenderingContext2D,
  recipe: ResolvedFallbackRecipe,
): void {
  const { widthPx: width, heightPx: height } = recipe;
  const fill = numberToCss(recipe.fill);
  const stroke = numberToCss(recipe.stroke);
  const border = Math.max(1, Math.round(recipe.radiusPx / 2));

  if (typeof context.clearRect === 'function') context.clearRect(0, 0, width, height);
  context.fillStyle = fill;
  context.strokeStyle = stroke;
  context.lineWidth = border;

  // A disc and a rounded panel both need a path. A rule and a tile are boxes, which
  // every context in the support matrix can draw, so they are the floor rather than
  // the exception.
  if (recipe.kind === 'disc' && canDrawEllipse(context)) {
    context.beginPath();
    if (typeof context.ellipse === 'function') {
      context.ellipse(
        width / 2,
        height / 2,
        Math.max(0, width / 2 - border),
        Math.max(0, height / 2 - border),
        0,
        0,
        Math.PI * 2,
      );
    } else {
      context.arc(width / 2, height / 2, Math.max(0, width / 2 - border), 0, Math.PI * 2);
    }
    context.fill();
    context.stroke();
    return;
  }

  if (recipe.kind === 'rounded-panel' && canDrawPath(context)) {
    roundRectPath(context, width, height, recipe.radiusPx);
    context.fill();
    context.stroke();
    return;
  }

  if (recipe.kind === 'rule' || !canDrawPath(context)) {
    // A rule is a bar, not an outlined box: a stroke round an 8px-tall rect is mostly
    // stroke, and the point of the shape is the fill.
    context.fillRect(0, 0, width, height);
    return;
  }

  context.fillRect(0, 0, width, height);
  if (typeof context.strokeRect === 'function') {
    context.strokeRect(border / 2, border / 2, width - border, height - border);
  }
}

/**
 * The PixiJS implementation of the loader's runtime port.
 *
 * Three things this deliberately is not:
 *
 * - **Not eager.** `Assets.init()` is awaited here, inside the first `registerBundle`
 *   or `loadAsset`, rather than at module scope and rather than by the application.
 *   Nothing about an asset bundle is fetched until a route asks for one, which is
 *   what plan section 10.2's "no eager world asset load" asks for.
 * - **Not a texture owner for loaded media.** `unloadBundle` and `unloadAsset` hand
 *   destruction to Pixi, which does it, and `destroyTexture` is reserved for the
 *   canvases this module drew.
 * - **Not a sprite registry.** The loader is what decides whether a texture is still
 *   held, and a texture it is not holding is one it destroys.
 */
export function createPixiAssetRuntime(): PixiAssetRuntime<Texture> {
  let initialized: Promise<void> | null = null;

  function ensureInitialized(): Promise<void> {
    // `Assets.init` warns and returns on a second call, so it is memoised rather
    // than called per load. A bundle registered before init would be wiped by
    // `init`'s own resolver setup.
    initialized ??= Assets.init().then(() => undefined);
    return initialized;
  }

  return {
    registerBundle(bundleId, members): void {
      void ensureInitialized();
      Assets.addBundle(bundleId, { ...members });
    },
    async loadBundle(bundleId): Promise<Readonly<Record<string, Texture>>> {
      await ensureInitialized();
      return (await Assets.loadBundle(bundleId)) as Readonly<Record<string, Texture>>;
    },
    async loadAsset(url: string): Promise<Texture> {
      await ensureInitialized();
      return await Assets.load<Texture>(url);
    },
    async unloadBundle(bundleId: string): Promise<void> {
      await ensureInitialized();
      await Assets.unloadBundle(bundleId);
    },
    async unloadAsset(url: string): Promise<void> {
      await ensureInitialized();
      await Assets.unload(url);
    },
    createFallbackTexture(recipe: ResolvedFallbackRecipe): Texture {
      const surface = fallbackSurface(recipe.widthPx, recipe.heightPx);
      if (surface === null) return Texture.WHITE;
      drawAssetFallback(surface.context, recipe);
      return new Texture({ source: new CanvasSource({ resource: surface.canvas }) });
    },
    destroyTexture(texture: Texture): void {
      // `destroy(true)` frees the `CanvasSource` underneath, which is the only thing
      // holding the drawn pixels. `destroyed` is checked because a texture that a
      // scene already destroyed is still this loader's to release on paper, and a
      // second `destroy(true)` would throw.
      if (texture.destroyed) return;
      texture.destroy(true);
    },
  };
}
