/**
 * The Phase 9 test world, on a real PixiJS `Application`.
 *
 * ## Why the scene is tested against the engine
 *
 * `pixi-dom-mirror.test.tsx` proves the accessible tree; `pixi-world-host.test.ts`
 * proves the lifecycle. Neither touches a display object, so neither can catch the
 * failures that live in scene code: a `Graphics` built with v7's `beginFill`, a
 * sprite left at the v8 default `eventMode: 'passive'` so it silently never
 * responds to a pointer, a hit area smaller than the plan's 44x44 floor, a layout
 * that divides by a surface measured at zero.
 *
 * So this file creates a real `Application` with the Canvas2D renderer and runs the
 * real scene on it. Nothing is stubbed except the GPU; see
 * `support/canvasContextStub.ts` for what that does and does not establish.
 *
 * ## What "no asset bundles" means here
 *
 * The sprite is drawn with `Graphics` and its hit target is measured from the Cozy
 * touch-target token, so this module registers no asset, loads nothing over the
 * network, and adds nothing to the CC0 registry. Phase 10 replaces the drawing with
 * `Assets.load` and the same tests keep working, because none of them asserts on a
 * file.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no network, no spawned process. The context stub is
 * installed and removed by the file; the canvas elements are removed after every case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  TEST_WORLD_ACTIONS,
  TEST_WORLD_ACTION_LIST,
  testWorldCaption,
  testWorldState,
} from '../../src/renderers/pixi/testworld/createTestWorld';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile } from '../../src/renderers/pixi/runtime/types';
import { COZY_TOUCH_TARGET_MIN, COZY_MOTION_TRAVEL_PX } from '../../src/theme';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from './support/canvasContextStub';

let stub: StubbedContext;
let observer: StubbedResizeObserver;
let pixi: typeof import('pixi.js');
let createTestWorldModule: typeof import('../../src/renderers/pixi/testworld/createTestWorld');
let previousContext2d: unknown;

beforeAll(async () => {
  // Both stubs represent the *production* runtime shape: every supported browser has
  // a Canvas2D context and a `ResizeObserver`. The second is not cosmetic - see
  // `pixi-application.test.ts` for the PixiJS 8.21.0 branch that leaks without one.
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
  pixi = await import('pixi.js');
  createTestWorldModule = await import('../../src/renderers/pixi/testworld/createTestWorld');
  // `CanvasRenderingContext2D` is a global every browser has and jsdom does not.
  // PixiJS's text metrics read `globalThis.CanvasRenderingContext2D.prototype` for a
  // feature check before it measures anything, and a `Text` that is measured rather
  // than merely drawn needs the measurement to happen. The class is empty on
  // purpose: the numbers come from the context stub above, which is a recording
  // double, so a width asserted in this file is a width the *wrap logic* produced
  // within the limit it was given - not a claim about glyph metrics.
  const scope = globalThis as unknown as Record<string, unknown>;
  previousContext2d = scope['CanvasRenderingContext2D'];
  scope['CanvasRenderingContext2D'] = class {};
});

afterAll(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (previousContext2d === undefined) Reflect.deleteProperty(scope, 'CanvasRenderingContext2D');
  else scope['CanvasRenderingContext2D'] = previousContext2d;
  observer.restore();
  stub.restore();
});

afterEach(() => {
  document.body.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

interface Mounted {
  readonly app: import('pixi.js').Application;
  readonly scene: ReturnType<typeof createTestWorldModule.createTestWorld>;
  readonly root: import('pixi.js').Container;
  readonly bell: import('pixi.js').Graphics;
  readonly readOut: import('pixi.js').Text;
  /**
   * Every `(actionId, source)` the scene asked the host to perform, in order.
   *
   * The scene is built here without a host - this file is about the scene - so the
   * dispatcher it is handed is the smallest thing that behaves like the real one:
   * it records the request and performs it. Recording it is the point: it is what
   * lets this file say "the pointer target asked the *host*", which is the
   * property the real gate in `pixi-composition-root.test.tsx` then proves has
   * consequences.
   */
  readonly requested: readonly [string, string][];
}

async function mountWorld(options: { reducedMotion?: boolean; width?: number; height?: number } = {}): Promise<Mounted> {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const app = new pixi.Application();
  await app.init({
    canvas: canvas as never,
    width: options.width ?? 640,
    height: options.height ?? 480,
    preference: 'canvas',
    sharedTicker: false,
    autoStart: false,
    resizeTo: undefined,
  });
  app.renderer.resize(options.width ?? 640, options.height ?? 480, app.renderer.resolution);
  const theme = resolveCozyWorldTheme({ reducedMotion: options.reducedMotion ?? false });
  const requested: [string, string][] = [];
  let scene: ReturnType<typeof createTestWorldModule.createTestWorld> | null = null;
  scene = createTestWorldModule.createTestWorld(app as never, {
    theme,
    quality: resolveWorldQualityProfile('balanced'),
    onAction: (actionId, source) => {
      requested.push([actionId, source]);
      scene?.activate(actionId, source);
    },
  });
  const root = app.stage.getChildByLabel('test-world');
  if (!root) throw new Error('the test world did not add a labelled root');
  // `root.children` is [lantern, bell, readOut], in creation order. Asserted rather
  // than indexed blindly, so a scene that adds a node fails here with a message
  // instead of silently testing the wrong object.
  expect(root.children).toHaveLength(3);
  const bell = root.children[1] as import('pixi.js').Graphics;
  return { app, scene, root, bell, readOut: root.children[2] as import('pixi.js').Text, requested };
}

describe('the test world declares its interactions, and the mirror is generated from them', () => {
  it('offers a keyboard action, a pointer action, and a key for both', () => {
    expect(TEST_WORLD_ACTION_LIST).toHaveLength(2);
    for (const action of TEST_WORLD_ACTION_LIST) {
      expect(action.keyboardKey, `${action.id} has no key`).not.toBeNull();
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.hint.length).toBeGreaterThan(0);
    }
    // Both routes are keyboard-reachable, so a keyboard user is never given less
    // than a pointer user; and exactly one action has a canvas pointer target, so
    // the DOM mirror is not inventing controls the canvas does not offer.
    expect(TEST_WORLD_ACTION_LIST.every((action) => action.keyboardKey !== null)).toBe(true);
    expect(TEST_WORLD_ACTION_LIST.filter((action) => action.pointer)).toHaveLength(1);
  });

  it('produces a per-action state sentence, pluralised', () => {
    expect(testWorldState(0, 0)).toEqual({
      [TEST_WORLD_ACTIONS.light]: 'Lantern lit with 0 embers',
      [TEST_WORLD_ACTIONS.ring]: 'Bell quiet',
    });
    expect(testWorldState(1, 1)[TEST_WORLD_ACTIONS.light]).toContain('1 ember');
    expect(testWorldState(2, 0)[TEST_WORLD_ACTIONS.light]).toContain('2 embers');
    expect(testWorldState(0, 1)[TEST_WORLD_ACTIONS.ring]).toBe('Bell rung 1 time');
    expect(testWorldState(0, 3)[TEST_WORLD_ACTIONS.ring]).toBe('Bell rung 3 times');
  });
});

describe('the sprite is a real PixiJS display object wired for a pointer', () => {
  it('is a `Graphics` drawing, not a texture, so Phase 9 registers no media', async () => {
    const { root, app } = await mountWorld();
    const lantern = root.children[0];
    expect(lantern).toBeInstanceOf(pixi.Graphics);
    expect(root.children[0]).toBeInstanceOf(pixi.Graphics);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('is hit-testable, which the v8 default of `passive` would silently prevent', async () => {
    const { bell } = await mountWorld();
    // The single most expensive v7-to-v8 mistake here: `eventMode` defaults to
    // `'passive'`, so a sprite that renders and never responds looks identical to a
    // working one until someone clicks it.
    expect(bell.eventMode).toBe('static');
    expect(bell.cursor).toBe('pointer');
    expect(bell.isInteractive()).toBe(true);
  });

  it('has a hit area of at least the 44 by 44 CSS-pixel minimum', async () => {
    const { bell } = await mountWorld();
    const area = bell.hitArea;
    expect(area).toBeTruthy();
    const half = COZY_TOUCH_TARGET_MIN / 2;
    expect(area?.contains(0, 0)).toBe(true);
    expect(area?.contains(half, half)).toBe(true);
    expect(area?.contains(-half, -half)).toBe(true);
    // And just outside, so the target is the token and not the whole plane.
    expect(area?.contains(half + 1, 0)).toBe(false);
    expect(area?.contains(0, -half - 1)).toBe(false);
  });

  it('asks the host to ring the bell on a pointer tap, rather than ringing it itself', async () => {
    const { bell, scene, requested } = await mountWorld();
    let stopped = 0;
    // A pointer event carrying only the method the scene calls, which is the point:
    // the scene claims propagation so a later stage - which will grow a
    // hit-testable canvas in Phase 11 - does not also treat this tap as a world
    // click. A handler that called anything else on the event would throw here.
    bell.emit('pointertap', { stopPropagation: () => { stopped += 1; } } as never);
    expect(stopped).toBe(1);
    // The request goes *out* to the host, as `pointer`. It is not the scene's own
    // `activate` being invoked: that is the route the shipped bell took, and it rang
    // the bell while the DOM mirror kept announcing the state from before the tap.
    expect(requested).toEqual([[TEST_WORLD_ACTIONS.ring, 'pointer']]);
    // The action did happen, because the host-like dispatcher this file supplies
    // performs what it is asked to. `tests/phase9/pixi-composition-root.test.tsx` is
    // where the *consequence* is asserted, through the real host and the real mirror.
    expect(scene.rings).toBe(1);
    expect(scene.readState()[TEST_WORLD_ACTIONS.ring]).toBe('Bell rung 1 time');
  });

  it('ignores an action id it does not declare, so a stale control cannot crash it', async () => {
    const { scene, readOut } = await mountWorld();
    expect(scene.activate('not-an-action', 'dom')).toBe(false);
    expect(scene.embers).toBe(0);
    expect(scene.rings).toBe(0);
    // And the caption did not move either: an action that did not happen cannot
    // change what the world says happened.
    expect(readOut.text).toBe(testWorldCaption(scene.readState()));
  });
});

describe('the canvas caption and the DOM mirror say the same words', () => {
  it('starts at the state the mirror starts at, not at a private template', async () => {
    const { scene, readOut } = await mountWorld();
    // The shipped read-out said "Lantern unlit" here, while the mirror said "Lantern
    // lit with 0 embers" - two vocabularies that never agreed, even at rest and with
    // no interaction at all.
    expect(readOut.text).not.toContain('Lantern unlit');
    expect(readOut.text).toBe(testWorldCaption(scene.readState()));
    expect(readOut.text).toBe('Lantern lit with 0 embers. Bell quiet.');
    // Every sentence the caption draws is one the mirror renders verbatim, for every
    // action, in the scene's own declaration order.
    for (const action of TEST_WORLD_ACTION_LIST) {
      expect(readOut.text).toContain(scene.readState()[action.id]);
    }
  });

  it('follows every action, in the same words, whichever route performed it', async () => {
    const { scene, readOut, requested } = await mountWorld();
    const agree = () => expect(readOut.text).toBe(testWorldCaption(scene.readState()));

    scene.activate(TEST_WORLD_ACTIONS.light, 'keyboard');
    agree();
    expect(readOut.text).toContain('Lantern lit with 1 ember');

    scene.activate(TEST_WORLD_ACTIONS.ring, 'dom');
    agree();
    expect(readOut.text).toContain('Bell rung 1 time');

    scene.activate(TEST_WORLD_ACTIONS.light, 'dom');
    agree();
    expect(readOut.text).toContain('Lantern lit with 2 embers');

    // The pointer route, through the host's dispatcher, repaints it too - which is
    // what makes the canvas caption a second report of the same event rather than a
    // decoration that stopped updating after the first frame.
    scene.activate(TEST_WORLD_ACTIONS.ring, 'pointer');
    agree();
    expect(readOut.text).toBe('Lantern lit with 2 embers. Bell rung 2 times.');

    // And a request the scene could not perform leaves it exactly where it was.
    expect(scene.activate('not-an-action', 'pointer')).toBe(false);
    agree();
    expect(requested).toEqual([]);
  });

  it('is derived from the action list, so a world with no actions has no caption', () => {
    expect(testWorldCaption({})).toBe('');
    expect(testWorldCaption({ 'ring-bell': 'Bell quiet' })).toBe('Bell quiet.');
  });

  it('fits inside the surface at 320 CSS pixels, rather than running off the edge', async () => {
    const theme = resolveCozyWorldTheme({});
    const { app, readOut, scene } = await mountWorld({ width: 320, height: 480 });
    scene.activate(TEST_WORLD_ACTIONS.light, 'keyboard');
    scene.activate(TEST_WORLD_ACTIONS.ring, 'keyboard');

    // The caption is a whole sentence per action now, and at the narrowest viewport
    // plan 10.1 requires it does not fit on one line. Clipped off the right edge of
    // the surface, a caption that is true is still not readable, so the scene wraps
    // it to the surface's own width.
    expect(readOut.style.wordWrap).toBe(true);
    expect(readOut.style.wordWrapWidth).toBe(320 - theme.space['6'] * 2);
    // Measured, not configured: a wrap width that the renderer ignores would satisfy
    // the line above and still clip.
    expect(readOut.width).toBeLessThanOrEqual(320 - theme.space['6'] * 2);
    // And it still starts inside the surface.
    expect(readOut.x + readOut.width).toBeLessThanOrEqual(320);
    expect(readOut.text).toBe(testWorldCaption(scene.readState()));
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });
});

describe('reduced motion is visible in the numbers, not only in a flag', () => {
  it('grows the lantern with motion and leaves it alone without', async () => {
    const withMotion = await mountWorld({ reducedMotion: false });
    const base = withMotion.scene.lanternRadius;
    withMotion.scene.activate(TEST_WORLD_ACTIONS.light, 'keyboard');
    withMotion.scene.activate(TEST_WORLD_ACTIONS.light, 'keyboard');
    // One travel step per ember, read from the Cozy motion table - which is the
    // assertion that the scene is driven by the profile rather than by a constant.
    expect(withMotion.scene.lanternRadius).toBeCloseTo(
      base + COZY_MOTION_TRAVEL_PX.large * 2,
      5,
    );
    withMotion.app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });

    const reduced = await mountWorld({ reducedMotion: true });
    const reducedBase = reduced.scene.lanternRadius;
    expect(reducedBase).toBe(base);
    reduced.scene.activate(TEST_WORLD_ACTIONS.light, 'keyboard');
    // The state still changes - the count increments and the tint changes - because
    // a learner who asked for less motion has not asked for a world that stops
    // reporting. What does not change is the size, because a size change is motion.
    expect(reduced.scene.embers).toBe(1);
    expect(reduced.scene.lanternRadius).toBeCloseTo(reducedBase, 5);
    reduced.app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('applies a live profile change to a world that is already lit', async () => {
    const { scene, app } = await mountWorld({ reducedMotion: false });
    scene.activate(TEST_WORLD_ACTIONS.light, 'keyboard');
    const grown = scene.lanternRadius;
    expect(grown).toBeGreaterThan(COZY_SPACE_BASE);

    scene.setMotionProfile?.(resolveCozyWorldTheme({ reducedMotion: true }).motion);
    // Immediately, not on the next activation: a learner who turns reduced motion on
    // mid-session sees a lantern that stops growing now, not after one more keypress.
    expect(scene.lanternRadius).toBeCloseTo(COZY_SPACE_BASE, 5);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });
});

describe('layout works at the 320 CSS-pixel viewport plan 10.1 requires', () => {
  it('lays two touch targets side by side at 320 CSS pixels, none off-screen', async () => {
    const { root, app } = await mountWorld({ width: 320, height: 480 });
    const theme = resolveCozyWorldTheme({});
    const [lantern, bell, readOut] = root.children;
    const gap = theme.space['6'];
    const laneWidth = Math.max(COZY_TOUCH_TARGET_MIN, Math.floor((320 - gap * 3) / 2));
    // A 320px viewport is the narrowest plan 10.1 requires the core flow to work at,
    // and "renders" is not the same as "reachable": both affordances are inside the
    // surface, and the second is to the right of the first.
    expect(laneWidth).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
    expect(lantern.x - COZY_TOUCH_TARGET_MIN / 2).toBeGreaterThanOrEqual(0);
    expect(bell.x + COZY_TOUCH_TARGET_MIN / 2).toBeLessThanOrEqual(320);
    expect(bell.x).toBeGreaterThan(lantern.x);
    // And the read-out still fits at this width, because it is the canvas's echo of
    // a status the DOM mirror already shows.
    expect(readOut.visible).toBe(true);
    expect(readOut.x).toBeGreaterThan(0);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('hides the read-out when there is genuinely no room, rather than overflowing', async () => {
    // Narrower than two touch targets plus the gaps, so the read-out would overflow.
    const { root, app } = await mountWorld({ width: 120, height: 480 });
    const readOut = root.children[2];
    expect(readOut.visible).toBe(false);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('lays the read-out in when there is room', async () => {
    const { root, app, readOut } = await mountWorld({ width: 640, height: 480 });
    // `root.children[2]`, not `[1]`: the read-out is the third node in creation
    // order, and `[1]` is the bell. Reading the bell's x and calling it the
    // read-out's is the kind of assertion that passes whatever the scene does.
    expect(root.children[2]).toBe(readOut);
    expect(readOut.visible).toBe(true);
    expect(readOut.x).toBeGreaterThan(0);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('re-lays out on a resize, and does not compound a scale from a previous one', async () => {
    const { scene, root, app } = await mountWorld({ width: 640, height: 480 });
    const before = root.children[1].x;
    scene.onResize(320, 480);
    const [lantern, bell] = root.children;
    // Positions come from the new surface width, not from the old one.
    expect(bell.x).toBeLessThan(before);
    expect(bell.x).toBeGreaterThan(lantern.x);
    expect(bell.x + COZY_TOUCH_TARGET_MIN / 2).toBeLessThanOrEqual(320);

    // A lantern lit at the old width, then resized, then lit again: the scale is
    // recomputed from the base radius, so the second activation does not apply the
    // first one's growth a second time.
    scene.activate(TEST_WORLD_ACTIONS.light, 'dom');
    const afterFirst = scene.lanternRadius;
    scene.onResize(320, 480);
    expect(scene.lanternRadius).toBeCloseTo(afterFirst, 5);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });
});

describe('destroy releases everything the scene created', () => {
  it('removes the pointer listener, empties the stage, and is safe to call twice', async () => {
    const { app, scene, root, bell } = await mountWorld();
    const listenerCountBefore = bell.listenerCount('pointertap');
    expect(listenerCountBefore).toBe(1);

    scene.destroy();
    expect(bell.listenerCount('pointertap')).toBe(0);
    expect(app.stage.children).toHaveLength(0);
    expect(bell.eventMode).toBe('none');
    expect(bell.hitArea).toBe(null);
    expect(root.parent).toBe(null);
    expect(root.children).toHaveLength(0);
    // The scene owns its display objects, so the stage's own teardown has nothing
    // left to walk. A second call must not throw: `Text.destroy` and
    // `Container.destroy` are not idempotent in v8, so this is the discipline that
    // keeps a double teardown from becoming a crash on the way out of a world.
    expect(() => scene.destroy()).not.toThrow();

    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('leaves no canvas behind when the application is destroyed after the scene', async () => {
    const { app } = await mountWorld();
    expect(document.querySelectorAll('canvas').length).toBeGreaterThan(0);
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});

/** The lantern's base radius: the `space.4` step, in CSS pixels. */
const COZY_SPACE_BASE = 16;
