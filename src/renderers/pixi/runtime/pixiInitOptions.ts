/**
 * The `app.init` options a world host asks for, assembled without naming PixiJS.
 *
 * ## Why the options live apart from the call
 *
 * Every field below is a load-bearing decision about the renderer's behaviour, and
 * a decision that can only be checked by running a GPU is a decision nobody checks.
 * Building the record in a PixiJS-free module means the *shape* is assertable in a
 * plain unit test, and `createPixiApplication.ts` stays a thin binding whose only
 * job is `new Application()` and `await app.init(...)`.
 *
 * The field names are PixiJS's. `tests/phase9/pixi-application.test.ts` passes this
 * record to a real `Application.init` in jsdom, which is what ties the names to the
 * library rather than to this file's comment.
 */
import type { WorldApplicationSpec, WorldQualityProfile } from './types';

/**
 * A subset of PixiJS `ApplicationOptions`, declared here structurally.
 *
 * Declared rather than imported so this module has no runtime dependency on the
 * renderer. `preference` is spelled as PixiJS's own union, and every value is the
 * one the plan section 10.2 or the v8 migration requires.
 */
export interface PixiInitOptions {
  /** The canvas to render into. Supplied by the host, never created here. */
  readonly canvas: HTMLCanvasElement;
  /**
   * Initial size in CSS pixels.
   *
   * `1` rather than a conventional 800x600: the host resizes to its own element
   * before the first frame, so any larger number is a frame's worth of wasted
   * allocation and, on a HiDPI display, of wasted fill.
   */
  readonly width: number;
  readonly height: number;
  /** Clear colour, as a number. */
  readonly background: number;
  readonly backgroundAlpha: number;
  /**
   * Backing-store pixels per CSS pixel, and `autoDensity` to keep the element
   * itself in CSS pixels.
   *
   * Both are needed together: `resolution` alone makes a HiDPI canvas twice the
   * layout size of its container, and `autoDensity` alone leaves a soft image.
   */
  readonly resolution: number;
  readonly autoDensity: boolean;
  readonly antialias: boolean;
  /** A single preference, so PixiJS's own `webgl -> webgpu -> canvas` chain applies. */
  readonly preference: WorldQualityProfile['preference'];
  /** A private ticker. `true` here would make every world share one loop. */
  readonly sharedTicker: false;
  /**
   * The host owns the loop.
   *
   * `autoStart: false` because the host knows whether the document is hidden, and
   * a world mounted into a hidden tab must not present a frame.
   */
  readonly autoStart: false;
  /**
   * No `ResizePlugin`.
   *
   * Left `undefined` so PixiJS's own `options.resizeTo || null` resolves to no
   * target. Passing an element or a window here would make PixiJS add a
   * `globalThis` resize listener the host did not create and would have to reason
   * about; the host observes its own element with a `ResizeObserver` instead, so one
   * component owns every listener its lifecycle causes.
   */
  readonly resizeTo: undefined;
  /** Clear before each frame, which is what a scene with no full-screen sprite needs. */
  readonly clearBeforeRender: boolean;
  /** Never print a version banner in a learner's console. */
  readonly hello: boolean;
}

/**
 * Build the init options for one mount.
 *
 * Frozen, so a test double and the real binding cannot see different options from
 * the same call and a mutation cannot reach the next mount.
 */
export function pixiInitOptions(spec: WorldApplicationSpec): PixiInitOptions {
  const { canvas, quality } = spec;
  return Object.freeze({
    canvas,
    width: 1,
    height: 1,
    background: spec.background,
    backgroundAlpha: spec.backgroundAlpha,
    resolution: quality.resolution,
    autoDensity: true,
    antialias: quality.antialias,
    preference: quality.preference,
    sharedTicker: false,
    autoStart: false,
    resizeTo: undefined,
    clearBeforeRender: true,
    hello: false,
  });
}
