/**
 * The composition root: the real PixiJS binding, the real test world, together.
 *
 * ## Why this file exists
 *
 * The Phase 9 host had three layers of tests and no test of the seam between them.
 *
 * - `pixi-application.test.ts` runs the real `createPixiApplication` and asserts the
 *   lifecycle: canvas, ticker, resize, teardown, twenty cycles.
 * - `test-world-scene.test.ts` runs the real `createTestWorld` and asserts the scene.
 *   It builds a **raw `pixi.Application`** and hands it straight to the scene, so the
 *   scene is never given the object the host actually hands a scene.
 * - `pixi-dom-mirror.test.tsx` renders the screen with **fakes** for both the
 *   `applicationFactory` and the `sceneFactory`, so the two are never bound.
 *
 * The only code that binds them - the module `PixiWorldHost.tsx` calls its own
 * composition root - had no coverage at all. That is how
 * `createTestWorld(application as unknown as PixiApplication, init)` shipped: it
 * type-checked, compiled, and passed all three of the files above, and in a real
 * browser it handed the scene a lifecycle facade with no `stage` and no `screen`, so
 * the scene threw, the host caught it, and the screen rendered a failure notice. No
 * Pixi world had ever rendered. `as unknown as` is not an accident that a compiler
 * can see; it is an accident only a test that uses the *real* two can see.
 *
 * ## What this file therefore does
 *
 * It renders `<PixiWorldHost />` **with no props at all**: no injected
 * `applicationFactory`, no injected `sceneFactory`, no pinned quality profile, no
 * stubbed scene. The production binding, the production scene, the production host
 * effect, and the production DOM mirror are the only things under test. The renderer
 * is PixiJS's own `autoDetectRenderer`, asked for WebGL and handed the Canvas2D
 * fallback because jsdom has no GPU - the same `preference` the product uses.
 *
 * The scene's display objects are observed from *outside* the binding, through
 * PixiJS's own documented `__PIXI_APP_INIT__` hook, which receives the real
 * `Application`. So the assertion is not "a factory was called": it is "a labelled
 * root with a `Graphics` lantern, a `Graphics` bell, and a `Text` read-out is a child
 * of the real application's stage", which is the fact that was never true before.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no network, no spawned process. The only globals this file
 * installs are the Canvas2D context stub, the `ResizeObserver` stub, and PixiJS's
 * init hooks, and every one of them is restored in `afterAll`.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import PixiWorldHost from '../../src/renderers/pixi/runtime/PixiWorldHost';
import { TEST_WORLD_ACTION_LIST } from '../../src/renderers/pixi/testworld/createTestWorld';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from './support/canvasContextStub';

/** The surface id the screen names, and the mirror's id prefix. One value, not two. */
const SURFACE_ID = 'pixi-test-world';

/** A PixiJS `Application`, as PixiJS's own init hook hands it over. */
interface HookApplication {
  readonly stage: import('pixi.js').Container | null;
  readonly renderer: unknown;
  readonly ticker: unknown;
  readonly canvas: HTMLCanvasElement;
}

let stub: StubbedContext;
let observer: StubbedResizeObserver;
let pixi: typeof import('pixi.js');

/** Every real application the binding created, in mount order. */
let created: HookApplication[] = [];
let previousAppHook: unknown;
let previousRendererHook: unknown;

/** The last application the binding created, which is the one still mounted. */
function liveApplication(): HookApplication {
  const application = created[created.length - 1];
  if (application === undefined) throw new Error('the binding created no PixiJS application');
  return application;
}

/**
 * The scene's own root, read from the real stage.
 *
 * `getChildByLabel` rather than `children[0]`, so a scene that adds something else
 * fails here with a message rather than passing a test against the wrong object.
 */
function sceneRoot(): import('pixi.js').Container {
  const stage = liveApplication().stage;
  if (stage === null) throw new Error('the live application has no stage');
  const root = stage.getChildByLabel('test-world');
  if (root === null) throw new Error('the test world did not add a labelled root to the real stage');
  return root;
}

beforeAll(async () => {
  // Both stubs are the *production runtime shape*: every browser in the support
  // matrix has a Canvas2D context and a `ResizeObserver`. The second is not cosmetic
  // - without it PixiJS 8.21.0's `CanvasObserver` leaks a `Ticker.shared` listener
  // per application, which would put a known leak in this file's own teardown path.
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
  pixi = await import('pixi.js');

  const scope = globalThis as unknown as Record<string, unknown>;
  previousAppHook = scope['__PIXI_APP_INIT__'];
  previousRendererHook = scope['__PIXI_RENDERER_INIT__'];
  scope['__PIXI_APP_INIT__'] = (application: unknown): void => {
    created.push(application as HookApplication);
  };
  scope['__PIXI_RENDERER_INIT__'] = (): void => {
    // Read but not needed: `pixiVersion` is the lane's business, not this file's.
  };
});

afterAll(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (previousAppHook === undefined) Reflect.deleteProperty(scope, '__PIXI_APP_INIT__');
  else scope['__PIXI_APP_INIT__'] = previousAppHook;
  if (previousRendererHook === undefined) Reflect.deleteProperty(scope, '__PIXI_RENDERER_INIT__');
  else scope['__PIXI_RENDERER_INIT__'] = previousRendererHook;
  observer.restore();
  stub.restore();
});

afterEach(() => {
  cleanup();
  created = [];
  document.body.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/** Let jsdom's `requestAnimationFrame` run for a few frames, so a tick is delivered. */
async function pump(frames = 3): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 24);
      });
    });
  }
}

/**
 * Render the screen exactly as the application renders it: no props.
 *
 * Settled means *either* the mirror published or the screen reported a failure,
 * because both are terminal states of a mount and waiting past a failure would turn
 * this into a timeout that says "the world is slow" when the truth is that the world
 * is broken. Which of the two it is, is each test's own first assertion.
 */
async function renderScreen(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<PixiWorldHost />);
  });
  await vi.waitFor(() => {
    const settled =
      view.container.querySelectorAll('button').length > 0 ||
      view.container.querySelector('[role="alert"]') !== null;
    expect(settled, 'the host neither published its mirror nor reported a failure').toBe(true);
  });
  return view;
}

/* -------------------------------------------------------------------------- */

describe('the real binding and the real scene are bound to each other', () => {
  it('mounts a real PixiJS application and puts the test world on its stage', async () => {
    const view = await renderScreen();

    // A mount that failed leaves a sentence on the screen instead of a world. This
    // is the assertion that was unavailable anywhere else, and it is the one that
    // would have caught the `as unknown as` the day it was written.
    const alert = within(view.container).queryByRole('alert');
    expect(
      alert?.textContent ?? null,
      'The world host reported a failure instead of presenting a world.',
    ).toBeNull();

    // A real application, created by the real binding, on a real canvas in the
    // document the host appended it to.
    expect(created).toHaveLength(1);
    const application = liveApplication();
    expect(application.canvas.isConnected).toBe(true);
    expect(application.canvas.getAttribute('aria-hidden')).toBe('true');
    expect(application.canvas.parentElement?.getAttribute('data-pixi-surface')).toBe(SURFACE_ID);

    // And the scene's display objects are in that application's stage - the specific
    // fact that has never been true in a browser: `Graphics`, `Graphics`, `Text`, in
    // creation order, under a labelled root.
    const root = sceneRoot();
    expect(root.children).toHaveLength(3);
    expect(root.children[0]).toBeInstanceOf(pixi.Graphics);
    expect(root.children[1]).toBeInstanceOf(pixi.Graphics);
    expect(root.children[2]).toBeInstanceOf(pixi.Text);
    expect(root.parent).toBe(liveApplication().stage);

    // The bell is the pointer target the scene declares, wired and hit-testable:
    // `eventMode` defaults to `'passive'` in v8, and a sprite left there renders and
    // never responds, which looks exactly like a working one until a learner clicks.
    const bell = root.children[1] as import('pixi.js').Graphics;
    expect(bell.eventMode).toBe('static');
    expect(bell.listenerCount('pointertap')).toBe(1);

    // The surface the host measured is the surface the renderer was resized to, and
    // the scene laid out from it: one resize, before the first frame.
    expect(application.renderer).toBeTruthy();
    expect(application.canvas.width).toBeGreaterThan(1);
  });

  it('presents a frame, and says so in the words a screen reader gets', async () => {
    await renderScreen();
    expect(screen.getByText(/World starting/)).toBeTruthy();
    await pump();
    // "World presented" is flipped by the first *presented* frame, not by the scene
    // being constructed, so a learner is never told a world is up before one is drawn.
    expect(await screen.findByText(/World presented/)).toBeTruthy();
  });

  it('gives every world action a labelled control, from the scene\'s own list', async () => {
    await renderScreen();
    const group = screen.getByRole('group', { name: 'Test world actions' });
    const buttons = within(group).getAllByRole('button');
    // Generated from `createTestWorld`'s declaration rather than from a test double's,
    // so this is the real scene's list reaching the real DOM.
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(
      TEST_WORLD_ACTION_LIST.map((action) => action.label),
    );
  });

  it('a control and the world shortcut reach the same scene, from the real stage', async () => {
    await renderScreen();
    const bell = sceneRoot().children[1] as import('pixi.js').Graphics;
    const before = readStatus('ring-bell');

    await act(async () => {
      screen.getByRole('button', { name: TEST_WORLD_ACTION_LIST[1].label }).click();
    });
    const afterControl = readStatus('ring-bell');
    expect(afterControl).not.toBe(before);
    expect(afterControl).toBe('Bell rung 1 time');

    // And the world's own key, with focus off the mirror, is the same action: the
    // canvas keyboard path and the DOM control are one `activate`.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    });
    expect(readStatus('ring-bell')).toBe('Bell rung 2 times');

    // The same bell node, still on the stage, still interactive: the action changed
    // the world, not the world graph.
    expect(bell.parent).toBe(sceneRoot());
    expect(bell.eventMode).toBe('static');
  });
});

describe('unmounting releases the real application, its stage, and its canvas', () => {
  it('nulls the renderer and the stage, detaches the canvas, and empties the document', async () => {
    await renderScreen();
    const application = liveApplication();
    const canvas = application.canvas;
    expect(canvas.isConnected).toBe(true);

    // `cleanup()` in `afterEach` is the unmount, so it is driven explicitly here to
    // read the state the product leaves behind.
    cleanup();
    expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
    expect(canvas.isConnected).toBe(false);
    // PixiJS's own `destroy` nulled both, which is the release fact the browser lane
    // gates on: `created - released` is the number of live applications.
    expect(application.renderer).toBeNull();
    expect(application.stage).toBeNull();
  });

  it('two mounts release two applications, and retain none', async () => {
    await renderScreen();
    cleanup();
    await renderScreen();
    cleanup();
    expect(created).toHaveLength(2);
    for (const application of created) {
      expect(application.renderer).toBeNull();
      expect(application.stage).toBeNull();
    }
    expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The canvas pointer route, through PixiJS's own event system                  */
/* -------------------------------------------------------------------------- */

/**
 * ## The defect this block exists for
 *
 * The bell's `pointertap` handler called the scene's *own* `activate`. The bell rang,
 * the world changed, and the host - the only thing that calls `publishState()` - never
 * learned it had happened, so the mirror's `aria-live` line kept announcing the state
 * from before the tap. In a real browser, two taps on the bell left the mirror
 * reading `Bell quiet`, and the next DOM-mirror click jumped to `Bell rung 3 times`.
 * The screen's own copy, that "every canvas action has a control here", was false.
 *
 * Nothing above caught it, because nothing above *clicked the canvas*:
 *
 * - `test-world-scene.test.ts` emitted `pointertap` on the scene's emitter, which
 *   calls the listener directly and never enters Pixi's event system;
 * - the first case in this file asserted `bell.listenerCount('pointertap') === 1`,
 *   which is satisfied by a listener that never fires;
 * - the browser lane exercised the keyboard and the DOM control.
 *
 * So this block does what none of them did: a real `pointerdown` and a real
 * `pointerup`, delivered to the real canvas, hit-tested by PixiJS, handled by the real
 * scene, and asserted on the real mirror's text.
 *
 * ## What is stubbed, and why it is not the thing under test
 *
 * Three browser facilities jsdom does not have, none of which is the host, the scene,
 * PixiJS's event system, or the mirror:
 *
 * - **`PointerEvent`.** PixiJS feature-detects it and falls back to `mousedown`/
 *   `mouseup` when it is absent, which is the same mapping code on the other branch.
 *   A `MouseEvent` subclass makes the detection choose the pointer family, so the
 *   events dispatched below are literally `pointerdown` and `pointerup` - the events
 *   a real browser delivers. It is installed *before* `app.init`, because that is
 *   when PixiJS reads it.
 * - **`CanvasRenderingContext2D`.** Read by PixiJS's text metrics for a feature
 *   check. Without it, presenting a frame containing the read-out throws.
 * - **`getBoundingClientRect`.** jsdom performs no layout, so every rect is zero and
 *   PixiJS's `mapPositionToPoint` divides by a zero-width rect. A fixed 640x480 box is
 *   the layout a browser would have; nothing else about the coordinate mapping is
 *   changed, and the 640x480 is also what gives the scene a surface big enough for
 *   its read-out to be visible.
 *
 * The pointer is aimed at the bell's own `x`/`y` read from the live scene graph.
 * That is deliberate division of labour rather than a shortcut: *where* the bell is
 * is `test-world-scene.test.ts`'s claim (44x44 hit area, laid out at 320 CSS pixels),
 * and *what happens when the pointer arrives* is this block's. Aiming at the bell's
 * real position is what makes the failure message honest - it says the tap did not
 * reach the mirror, not that the test guessed a coordinate wrong.
 */
describe('a real pointer press on the canvas reaches the DOM mirror', () => {
  const SURFACE = { width: 640, height: 480 };
  let restorePointerEvent: unknown;
  let restoreContext2d: unknown;
  let restoreRect: unknown;

  beforeAll(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    restorePointerEvent = scope['PointerEvent'];
    scope['PointerEvent'] = class PatchedPointerEvent extends MouseEvent {};
    restoreContext2d = scope['CanvasRenderingContext2D'];
    scope['CanvasRenderingContext2D'] = class {};
    restoreRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function fixedRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: SURFACE.width,
        height: SURFACE.height,
        right: SURFACE.width,
        bottom: SURFACE.height,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  afterAll(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (restorePointerEvent === undefined) Reflect.deleteProperty(scope, 'PointerEvent');
    else scope['PointerEvent'] = restorePointerEvent;
    if (restoreContext2d === undefined) Reflect.deleteProperty(scope, 'CanvasRenderingContext2D');
    else scope['CanvasRenderingContext2D'] = restoreContext2d;
    HTMLElement.prototype.getBoundingClientRect = restoreRect as never;
  });

  /**
   * One real press: a `pointerdown` and a `pointerup` on the canvas, at the same
   * point, through the browser's own event dispatch.
   *
   * Both halves are needed. `pointerdown` alone would pass a hit test and prove
   * nothing about the tap, because `pointertap` is only emitted by `mapPointerUp` for
   * a target that was also pressed - which is the same "press and release on the same
   * thing" rule a real click has.
   */
  async function pressCanvasPointer(canvas: HTMLCanvasElement, x: number, y: number): Promise<void> {
    const base = {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    });
  }

  /**
   * Wait for the world to have presented a frame.
   *
   * A real requirement rather than a ritual: PixiJS hit-tests against each node's
   * world transform, and a scene that has never been rendered has not finished
   * propagating the positions `layout()` set. A press delivered before the first frame
   * arrives at the right coordinates and hits nothing - in jsdom and in a browser
   * alike - so both altitudes wait, which is also all a learner can do: you cannot tap
   * a world you cannot see.
   */
  async function waitForPresentedFrame(): Promise<void> {
    await vi.waitFor(() => {
      expect(screen.getByText(/World presented/), 'the world has not presented a frame yet').toBeTruthy();
    });
  }

  /** The bell's centre in world space, once the scene's transforms are real. */
  async function presentedBellPosition(): Promise<{ x: number; y: number }> {
    await waitForPresentedFrame();
    const bell = sceneRoot().children[1] as import('pixi.js').Graphics;
    return { x: Math.round(bell.x), y: Math.round(bell.y) };
  }

  it('two presses on the bell change the mirror, and the count is one the learner saw', async () => {
    await renderScreen();
    const canvas = liveApplication().canvas;
    const { x, y } = await presentedBellPosition();

    // At rest, the mirror and the canvas say the same thing. This is the state the
    // shipped build sat in forever: right, and never moving.
    expect(readStatus('ring-bell')).toBe('Bell quiet');
    expect(canvasCaption()).toBe('Lantern lit with 0 embers. Bell quiet.');

    await pressCanvasPointer(canvas, x, y);
    expect(readStatus('ring-bell'), 'the first canvas press did not reach the mirror').toBe(
      'Bell rung 1 time',
    );

    await pressCanvasPointer(canvas, x, y);
    expect(readStatus('ring-bell'), 'the second canvas press did not reach the mirror').toBe(
      'Bell rung 2 times',
    );

    // The canvas caption followed, in the mirror's own words.
    expect(canvasCaption()).toBe('Lantern lit with 0 embers. Bell rung 2 times.');

    // And the counter did not jump. The shipped defect was a mirror that read
    // `Bell quiet` through two taps and then `Bell rung 3 times` on the next control
    // click: a number the learner never watched reach one. Two taps, then one control
    // click, is three.
    await act(async () => {
      screen.getByRole('button', { name: TEST_WORLD_ACTION_LIST[1].label }).click();
    });
    expect(readStatus('ring-bell')).toBe('Bell rung 3 times');
  });

  it('the keyboard and the pointer produce the same mirror text, from the same world', async () => {
    await renderScreen();
    const canvas = liveApplication().canvas;
    const { x, y } = await presentedBellPosition();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    });
    const afterKey = readStatus('ring-bell');
    expect(afterKey).toBe('Bell rung 1 time');

    await pressCanvasPointer(canvas, x, y);
    expect(readStatus('ring-bell')).toBe('Bell rung 2 times');

    await act(async () => {
      screen.getByRole('button', { name: TEST_WORLD_ACTION_LIST[1].label }).click();
    });
    expect(readStatus('ring-bell')).toBe('Bell rung 3 times');
  });

  it('a press on empty surface does nothing, so the mirror does not move for nothing', async () => {
    await renderScreen();
    await waitForPresentedFrame();
    const canvas = liveApplication().canvas;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    });
    expect(readStatus('ring-bell')).toBe('Bell rung 1 time');

    // Top-left of the surface: inside the canvas, outside both affordances' 44x44
    // hit areas. A world that republished on every miss would announce noise.
    await pressCanvasPointer(canvas, 1, 1);
    expect(readStatus('ring-bell')).toBe('Bell rung 1 time');
  });

  it('the canvas caption and the mirror never disagree, after any route in any order', async () => {
    await renderScreen();
    const canvas = liveApplication().canvas;
    const { x, y } = await presentedBellPosition();

    const agree = (): void => {
      expect(
        canvasCaption(),
        'the canvas caption and the DOM mirror are describing different worlds',
      ).toBe(`${readStatus('light-lantern')}. ${readStatus('ring-bell')}.`);
    };
    agree();

    await pressCanvasPointer(canvas, x, y);
    agree();

    await act(async () => {
      screen.getByRole('button', { name: TEST_WORLD_ACTION_LIST[0].label }).click();
    });
    agree();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    });
    agree();
  });
});

/**
 * The mirror's own status sentence for one action id.
 *
 * Read from the status element the mirror renders next to the control, not from the
 * button, because the button's own text is the action's label and would be the same
 * string whatever the world did.
 */
function readStatus(actionId: string): string {
  return document.getElementById(`${SURFACE_ID}-${actionId}-status`)?.textContent?.trim() ?? '';
}

/**
 * The sentence the world draws on the canvas itself.
 *
 * Read from the scene's own `Text` object on the live stage. The canvas is
 * `aria-hidden`, so this is not an accessibility surface - it is a second report of
 * the same state, drawn where a sighted learner is looking, and it is the thing that
 * sat at "Lantern unlit" forever while the mirror counted.
 */
function canvasCaption(): string {
  const readOut = sceneRoot().children[2] as import('pixi.js').Text;
  return readOut.text;
}
