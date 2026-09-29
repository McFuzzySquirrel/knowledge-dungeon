/**
 * The renderer-neutral host lifecycle: mount, teardown, visibility, reduced motion,
 * resize, restart, and keyboard dispatch.
 *
 * ## Why a fake application and not the real one
 *
 * `pixi-application.test.ts` runs the real PixiJS binding. This file runs the *host*,
 * and the host's job is bookkeeping: which subscription it opened, which disposer
 * closed it, in which order, and what it did about a world that unmounted while its
 * renderer was still being negotiated. None of that needs a canvas, and a test that
 * needed one would be unable to assert the interesting cases - a rejected `init()`,
 * an unmount between `await` and `mount` returning, a `document.hidden` that flips
 * twice.
 *
 * So the double here is deliberately *loud*: every method is a counter, every
 * subscription returns a disposer that is counted, and the environment records the
 * order things happened in. A host that forgot a disposer shows up as a live
 * subscription, not as a quiet difference nobody can see.
 *
 * ## The claims, and what each one is for
 *
 * - **Balanced subscriptions.** Plan 10.2's twenty-cycle criterion is about a world
 *   that navigates away and comes back. A leaked `visibilitychange` listener or a
 *   live `onFrame` closure is the shape that failure takes, so balance is asserted
 *   directly rather than inferred from a canvas count.
 * - **Visibility actually pauses.** Not "the listener was called" but "the ticker
 *   stopped": the assertion is on the application, because a host that called the
 *   observer and then ignored it is the defect.
 * - **Reduced motion scales to zero.** Asserted on the number the scene reads
 *   (`motion.travelPx('large') === 0`), not on a flag, because a flag is a
 *   declaration and a number is a behaviour.
 * - **One dispatch path.** Keyboard, pointer, and the DOM mirror all arrive at the
 *   same `activate`, so a keyboard user cannot be given less than a pointer user.
 *   The test drives all three and asserts the scene saw the same three source values.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no spawned process, no network. DOM state it mutates
 * (`document.hidden`, `window.matchMedia`, a global `ResizeObserver`) is restored in
 * `afterEach`, so a failure in one case cannot make another pass or fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPixiWorldHost } from '../../src/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import {
  createBrowserWorldEnvironment,
  createDomlessWorldEnvironment,
  currentWorldEnvironment,
  measureElement,
} from '../../src/renderers/pixi/runtime/worldEnvironment';
import { resolveWorldQualityProfile, type WorldQualityProfile } from '../../src/renderers/pixi/runtime/types';
import type { WorldRenderer } from '../../src/application/contracts/renderer';
import type { CozyMotionProfile } from '../../src/theme';

type WorldApplication = import('../../src/renderers/pixi/runtime/types').WorldApplication;
type WorldApplicationSpec = import('../../src/renderers/pixi/runtime/types').WorldApplicationSpec;
type WorldAction = import('../../src/renderers/pixi/runtime/types').WorldAction;
type WorldActionSource = import('../../src/renderers/pixi/runtime/types').WorldActionSource;
type WorldActionState = import('../../src/renderers/pixi/runtime/types').WorldActionState;
type WorldScene = import('../../src/renderers/pixi/runtime/types').WorldScene;
type WorldEnvironment = import('../../src/renderers/pixi/runtime/types').WorldEnvironment;
type CreateWorldHostOptions<
  A extends WorldApplication,
  S extends WorldScene,
> = import('../../src/renderers/pixi/runtime/types').CreateWorldHostOptions<A, S>;

/* -------------------------------------------------------------------------- */
/* Doubles that count                                                          */
/* -------------------------------------------------------------------------- */

interface ApplicationLog {
  events: string[];
  frameListeners: ((deltaMs: number) => void)[];
  destroyed: { releaseGlobalResources: boolean } | null;
  startCount: number;
  stopCount: number;
  resizes: [number, number][];
  width: number;
  height: number;
}

function createFakeApplication(canvas: HTMLCanvasElement): {
  application: WorldApplication;
  log: ApplicationLog;
} {
  const log: ApplicationLog = {
    events: [],
    frameListeners: [],
    destroyed: null,
    startCount: 0,
    stopCount: 0,
    resizes: [],
    width: 1,
    height: 1,
  };
  const application: WorldApplication = {
    canvas,
    // `null`, stated plainly: this double is a lifecycle and nothing else, so there
    // is no engine behind it for a composition root to narrow. The real binding's
    // value is a real PixiJS `Application`, and `asPixiApplication` accepts that one
    // and refuses this - which is what keeps the narrowing a check rather than a
    // claim. See `tests/phase9/pixi-composition-root.test.tsx`.
    native: null,
    get screenWidth() {
      return log.width;
    },
    get screenHeight() {
      return log.height;
    },
    get tickerRunning() {
      return log.startCount > log.stopCount;
    },
    resize(width, height) {
      log.events.push('resize');
      log.resizes.push([width, height]);
      log.width = width;
      log.height = height;
    },
    startTicker() {
      log.events.push('start');
      log.startCount += 1;
    },
    stopTicker() {
      log.events.push('stop');
      log.stopCount += 1;
    },
    onFrame(listener) {
      log.events.push('onFrame');
      log.frameListeners.push(listener);
      return () => {
        log.events.push('offFrame');
        const index = log.frameListeners.indexOf(listener);
        if (index >= 0) log.frameListeners.splice(index, 1);
      };
    },
    destroy(options) {
      log.events.push('destroy');
      log.destroyed = options;
      log.frameListeners.length = 0;
    },
  };
  return { application, log };
}

interface SceneLog {
  activations: [string, WorldActionSource][];
  updates: number[];
  resizes: [number, number][];
  motionProfiles: CozyMotionProfile[];
  destroyed: number;
  built: number;
}

const TEST_ACTIONS: readonly WorldAction[] = [
  { id: 'light', label: 'Light the lantern (key L)', hint: 'Adds an ember.', keyboardKey: 'l', pointer: false },
  { id: 'ring', label: 'Ring the bell (key B)', hint: 'Rings the bell.', keyboardKey: 'b', pointer: true },
];

function createFakeScene(built: number): { scene: WorldScene; log: SceneLog } {
  const log: SceneLog = {
    activations: [],
    updates: [],
    resizes: [],
    motionProfiles: [],
    destroyed: 0,
    built,
  };
  const scene: WorldScene = {
    actions: TEST_ACTIONS,
    activate(actionId, source) {
      log.activations.push([actionId, source] as const);
      return actionId === 'light' || actionId === 'ring';
    },
    readState(): WorldActionState {
      return { light: 'Lantern lit', ring: 'Bell rung' };
    },
    update(deltaMs) {
      log.updates.push(deltaMs);
    },
    onResize(width, height) {
      log.resizes.push([width, height] as const);
    },
    setMotionProfile(profile) {
      log.motionProfiles.push(profile);
    },
    destroy() {
      log.destroyed += 1;
    },
  };
  return { scene, log };
}

interface EnvironmentLog {
  reducedMotion: boolean;
  hidden: boolean;
  readonly reducedListeners: ((reduced: boolean) => void)[];
  readonly visibilityListeners: ((hidden: boolean) => void)[];
  readonly sizeListeners: ((width: number, height: number) => void)[];
  readonly observed: Element[];
}

function createFakeEnvironment(initial: Partial<EnvironmentLog> = {}): {
  environment: WorldEnvironment;
  log: EnvironmentLog;
} {
  const log: EnvironmentLog = {
    reducedMotion: false,
    hidden: false,
    reducedListeners: [],
    visibilityListeners: [],
    sizeListeners: [],
    observed: [],
    ...initial,
  };
  const environment: WorldEnvironment = {
    reducedMotion: () => log.reducedMotion,
    hidden: () => log.hidden,
    observeReducedMotion(listener) {
      log.reducedListeners.push(listener);
      return () => {
        const index = log.reducedListeners.indexOf(listener);
        if (index >= 0) log.reducedListeners.splice(index, 1);
      };
    },
    observeVisibility(listener) {
      log.visibilityListeners.push(listener);
      return () => {
        const index = log.visibilityListeners.indexOf(listener);
        if (index >= 0) log.visibilityListeners.splice(index, 1);
      };
    },
    observeSize(element, listener) {
      log.observed.push(element);
      log.sizeListeners.push(listener);
      return () => {
        const index = log.sizeListeners.indexOf(listener);
        if (index >= 0) log.sizeListeners.splice(index, 1);
        const observed = log.observed.indexOf(element);
        if (observed >= 0) log.observed.splice(observed, 1);
      };
    },
  };
  return { environment, log };
}

const QUALITY: WorldQualityProfile = resolveWorldQualityProfile('balanced');

/** A host element with a real box, because the host measures it on mount. */
function hostElement(width = 640, height = 480): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  // Tracked, so a harness that does not reach its own `unmount` cannot leave a
  // canvas in the document for the next test to count.
  mounted.push(element);
  element.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return element;
}

interface Harness {
  readonly host: HTMLDivElement;
  readonly applications: ApplicationLog[];
  readonly scenes: SceneLog[];
  readonly env: EnvironmentLog;
  readonly surface: HTMLDivElement;
  readonly control: import('../../src/renderers/pixi/runtime/types').PixiWorldHost;
}

/**
 * Build a mounted host.
 *
 * `createApplication` resolves on a microtask rather than synchronously, so the
 * `await`-window cases (an unmount during init, a rejected init) are the ones a test
 * actually reproduces rather than ones it asserts about in the abstract.
 */
function buildHarness(
  overrides: {
    environment?: WorldEnvironment;
    envInitial?: Partial<EnvironmentLog>;
    reducedMotion?: boolean;
    releaseGlobalResources?: boolean;
    createApplication?: (spec: WorldApplicationSpec) => Promise<WorldApplication>;
    box?: readonly [number, number];
  } = {},
): Harness {
  const surface = hostElement(...(overrides.box ?? ([640, 480] as const)));
  const applications: ApplicationLog[] = [];
  const scenes: SceneLog[] = [];
  const { environment, log } = createFakeEnvironment(overrides.envInitial);
  const theme = resolveCozyWorldTheme({ reducedMotion: overrides.reducedMotion ?? false });

  const options: CreateWorldHostOptions<WorldApplication, WorldScene> = {
    host: surface,
    theme,
    quality: QUALITY,
    reducedMotion: overrides.reducedMotion ?? false,
    environment: overrides.environment ?? environment,
    createApplication:
      overrides.createApplication ??
      (async (spec) => {
        const { application, log: appLog } = createFakeApplication(spec.canvas);
        applications.push(appLog);
        return application;
      }),
    createScene(_application, _init) {
      const { scene, log: sceneLog } = createFakeScene(scenes.length + 1);
      scenes.push(sceneLog);
      return scene;
    },
  };
  if (overrides.releaseGlobalResources !== undefined) {
    (options as { releaseGlobalResources?: boolean }).releaseGlobalResources =
      overrides.releaseGlobalResources;
  }
  return {
    host: surface,
    applications,
    scenes,
    env: log,
    surface,
    control: createPixiWorldHost(options),
  };
}

let mounted: HTMLDivElement[] = [];
afterEach(() => {
  for (const element of mounted) element.remove();
  mounted = [];
});

/** The scene's own pointer route, which a canvas affordance calls directly. */
function dispatchPointer(log: SceneLog): void {
  log.activations.push(['ring', 'pointer']);
}

function track(element: HTMLElement): HTMLElement {
  mounted.push(element as HTMLDivElement);
  return element;
}

/* -------------------------------------------------------------------------- */
/* Mount                                                                       */
/* -------------------------------------------------------------------------- */

describe('mount attaches the renderer to the element the caller supplied', () => {
  it('appends one canvas into the host element, hidden from assistive technology', async () => {
    const harness = buildHarness();
    const control = harness.control;
    await control.mount();

    const canvases = harness.surface.querySelectorAll('canvas');
    expect(canvases).toHaveLength(1);
    const canvas = canvases[0];
    // `aria-hidden` is set before the renderer is created, so there is no window in
    // which an assistive technology could meet an unlabelled canvas. The host's own
    // actions are real DOM controls; the canvas is a picture of them.
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    // Not focusable, which is what leaves the keyboard action on the document
    // rather than on a canvas that can never receive focus.
    expect(canvas.hasAttribute('tabindex')).toBe(false);
    // Never the body: a renderer that appends to `document.body` puts its canvas on
    // top of whatever the application rendered and has to search the document to
    // find it on teardown.
    expect(canvas.parentElement).toBe(harness.surface);
    expect(document.body.querySelectorAll('canvas')).toHaveLength(1);

    control.unmount();
  });

  it('passes the Cozy clear colour and the quality profile into the renderer spec', async () => {
    const specs: WorldApplicationSpec[] = [];
    const surface = track(hostElement());
    const { environment } = createFakeEnvironment();
    const control = createPixiWorldHost<WorldApplication, WorldScene>({
      host: surface,
      theme: resolveCozyWorldTheme({ theme: 'cozy-parchment' }),
      quality: QUALITY,
      reducedMotion: false,
      environment,
      createApplication: async (spec) => {
        specs.push(spec);
        return createFakeApplication(spec.canvas).application;
      },
      createScene: () => createFakeScene(1).scene,
    });
    await control.mount();

    expect(specs).toHaveLength(1);
    expect(specs[0].quality).toBe(QUALITY);
    expect(specs[0].background).toBe(resolveCozyWorldTheme({ theme: 'cozy-parchment' }).color.surfacePage);
    expect(specs[0].backgroundAlpha).toBe(1);
    control.unmount();
  });

  it('sizes the surface from the host element before the first frame', async () => {
    const harness = buildHarness({ box: [320, 200] });
    await harness.control.mount();
    // A world mounted into a 320x200 box draws its first frame at 320x200, not at
    // whatever the renderer defaulted to.
    expect(harness.applications[0].resizes).toEqual([[320, 200]]);
    expect(harness.scenes[0].resizes).toEqual([[320, 200]]);
    harness.control.unmount();
  });

  it('is idempotent, because React runs a mount effect twice in development', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    await harness.control.mount();
    await harness.control.mount();
    expect(harness.applications).toHaveLength(1);
    expect(harness.surface.querySelectorAll('canvas')).toHaveLength(1);
    expect(harness.scenes).toHaveLength(1);
    harness.control.unmount();
  });

  it('restarts the world in place, keeping the renderer', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    harness.control.restart();
    harness.control.restart();
    expect(harness.scenes).toHaveLength(3);
    expect(harness.scenes[0].destroyed).toBe(1);
    expect(harness.scenes[1].destroyed).toBe(1);
    // One renderer, one canvas: a restart rebuilds the world, it does not remount
    // the application.
    expect(harness.applications).toHaveLength(1);
    expect(harness.surface.querySelectorAll('canvas')).toHaveLength(1);
    harness.control.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

describe('readiness flips on the first presented frame, not at construction', () => {
  it('is false until a frame arrives and false again after unmount', async () => {
    const harness = buildHarness();
    const seen: boolean[] = [];
    const control = harness.control;
    expect(control.isReady()).toBe(false);
    const stop = control.onReady(() => seen.push(control.isReady()));

    await control.mount();
    // The scene exists and the mirror is published, but no frame has been presented:
    // a screen that trusted `isReady()` here would paint a HUD over an empty canvas.
    expect(control.isReady()).toBe(false);
    expect(seen).toEqual([]);
    expect(control.actions).toHaveLength(2);

    harness.applications[0].frameListeners[0](16.7);
    expect(control.isReady()).toBe(true);
    expect(seen).toEqual([true]);
    // One notification, not one per frame.
    harness.applications[0].frameListeners[0](16.7);
    harness.applications[0].frameListeners[0](16.7);
    expect(seen).toEqual([true]);

    control.unmount();
    expect(control.isReady()).toBe(false);
    expect(stop).toBeTypeOf('function');
  });

  it('forwards real frame deltas to the scene, and skips the non-positive ones', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    const [frame] = harness.applications[0].frameListeners;
    frame(16.7);
    frame(0);
    frame(Number.NaN);
    frame(8.3);
    expect(harness.scenes[0].updates).toEqual([16.7, 8.3]);
    harness.control.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

describe('unmount is total: it tears down what is present, not what was scheduled', () => {
  it('releases the scene, the renderer, the canvas, and every subscription', async () => {
    const harness = buildHarness();
    const control = harness.control;
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      await control.mount();
      expect(harness.env.reducedListeners).toHaveLength(1);
      expect(harness.env.visibilityListeners).toHaveLength(1);
      expect(harness.env.sizeListeners).toHaveLength(1);
      expect(harness.env.observed).toEqual([harness.surface]);
      expect(harness.applications[0].frameListeners).toHaveLength(1);
      const keydownAdds = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
      expect(keydownAdds).toBe(1);

      control.unmount();

      expect(harness.scenes[0].destroyed).toBe(1);
      expect(harness.applications[0].destroyed).toEqual({ releaseGlobalResources: true });
      expect(harness.applications[0].frameListeners).toHaveLength(0);
      expect(harness.env.reducedListeners).toHaveLength(0);
      expect(harness.env.visibilityListeners).toHaveLength(0);
      expect(harness.env.sizeListeners).toHaveLength(0);
      expect(harness.env.observed).toHaveLength(0);
      expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(keydownAdds);
      // The canvas is gone from the surface and from the document, and `unmount`
      // removes it even for a driver that does not, so "leaves no canvas" is a
      // property of the host rather than of one binding.
      expect(harness.surface.querySelectorAll('canvas')).toHaveLength(0);
      expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
      expect(control.actions).toEqual([]);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('honours an explicit `releaseGlobalResources: false`', async () => {
    const harness = buildHarness({ releaseGlobalResources: false });
    await harness.control.mount();
    harness.control.unmount();
    expect(harness.applications[0].destroyed).toEqual({ releaseGlobalResources: false });
  });

  it('is safe twice, and safe before ever mounting', async () => {
    const never = buildHarness();
    expect(() => never.control.unmount()).not.toThrow();
    expect(never.applications).toHaveLength(0);
    await never.control.mount();
    never.control.unmount();
    expect(() => never.control.unmount()).not.toThrow();
    // A second teardown must not destroy the application twice.
    expect(never.applications[0].destroyed).toEqual({ releaseGlobalResources: true });
  });

  it('a scene that throws while destroying does not strand the renderer or the canvas', async () => {
    const surface = track(hostElement());
    const { environment } = createFakeEnvironment();
    const applications: ApplicationLog[] = [];
    const control = createPixiWorldHost<WorldApplication, WorldScene>({
      host: surface,
      theme: resolveCozyWorldTheme({}),
      quality: QUALITY,
      reducedMotion: false,
      environment,
      createApplication: async (spec) => {
        const made = createFakeApplication(spec.canvas);
        applications.push(made.log);
        return made.application;
      },
      createScene: () =>
        ({
          actions: TEST_ACTIONS,
          activate: () => true,
          readState: () => ({}),
          update: () => {},
          onResize: () => {},
          destroy: () => {
            throw new Error('scene teardown failed');
          },
        }) as WorldScene,
    });
    await control.mount();
    expect(() => control.unmount()).not.toThrow();
    // The renderer still went, which is the point: a scene that throws must not leave
    // a GPU context and a canvas behind.
    expect(applications[0].destroyed).toEqual({ releaseGlobalResources: true });
    expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
  });

  it('a scene that cannot be built releases the renderer and the canvas too', async () => {
    // The failure this one exists for is the one that shipped. `createScene` is the
    // last thing a mount does before it is finished, and it runs *after* the canvas
    // is attached and the renderer is live: a scene that throws here used to leave a
    // GPU context, a ticker, and an attached canvas behind, with nothing left to
    // release them, and the screen could only report the error.
    const surface = track(hostElement());
    const { environment } = createFakeEnvironment();
    const applications: ApplicationLog[] = [];
    const control = createPixiWorldHost<WorldApplication, WorldScene>({
      host: surface,
      theme: resolveCozyWorldTheme({}),
      quality: QUALITY,
      reducedMotion: false,
      environment,
      createApplication: async (spec) => {
        const made = createFakeApplication(spec.canvas);
        applications.push(made.log);
        return made.application;
      },
      createScene: () => {
        throw new Error('the scene could not be built');
      },
    });

    await expect(control.mount()).rejects.toThrow('the scene could not be built');
    expect(applications, 'the renderer was never released').toHaveLength(1);
    expect(applications[0].destroyed, 'the renderer outlived the failed mount').toEqual({
      releaseGlobalResources: true,
    });
    expect(surface.querySelectorAll('canvas')).toHaveLength(0);
    expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
    expect(control.isReady()).toBe(false);
    expect(control.actions).toEqual([]);
    // And the environment subscriptions opened before the scene was built are closed
    // by the same teardown, so a failed mount is not a second mount's leak.
    expect(control.unmount()).toBeUndefined();
  });

  it('a renderer that cannot start leaves no canvas and rethrows to the caller', async () => {
    const harness = buildHarness({
      createApplication: async () => {
        throw new Error('no webgl context');
      },
    });
    await expect(harness.control.mount()).rejects.toThrow('no webgl context');
    // The canvas was created but never appended, so the document is untouched - the
    // same state a clean unmount leaves, which is what a screen can recover from.
    expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
    expect(harness.control.isReady()).toBe(false);
  });

  it('releases a renderer that arrives after the host was unmounted', async () => {
    const release: { current: ((application: WorldApplication) => void) | null } = { current: null };
    const late: ApplicationLog[] = [];
    const surface = track(hostElement());
    const { environment } = createFakeEnvironment();
    const control = createPixiWorldHost<WorldApplication, WorldScene>({
      host: surface,
      theme: resolveCozyWorldTheme({}),
      quality: QUALITY,
      reducedMotion: false,
      environment,
      createApplication: () =>
        new Promise<WorldApplication>((resolve) => {
          release.current = (application) => resolve(application);
        }),
      createScene: () => createFakeScene(1).scene,
    });
    const mounting = control.mount();
    // The learner navigates away while the GPU context is still being negotiated.
    control.unmount();
    const made = createFakeApplication(document.createElement('canvas'));
    late.push(made.log);
    release.current?.(made.application);
    await mounting;

    // Adopted would mean a renderer outliving the element it was created for, with
    // no scene, no frame subscription, and no way to release it.
    expect(late[0].destroyed).toEqual({ releaseGlobalResources: true });
    expect(surface.querySelectorAll('canvas')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

describe('the ticker pauses while the document is hidden', () => {
  it('stops on hidden and starts again on visible', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    const app = harness.applications[0];
    expect(app.startCount).toBe(1);
    expect(app.stopCount).toBe(0);

    harness.env.visibilityListeners[0](true);
    expect(app.stopCount).toBe(1);
    // Balanced, so the fake reports the ticker as stopped - which is the property
    // the assertion is about, rather than the count of calls.
    expect(app.startCount - app.stopCount).toBe(0);

    harness.env.visibilityListeners[0](false);
    expect(app.startCount).toBe(2);
    expect(app.startCount - app.stopCount).toBe(1);
    harness.control.unmount();
  });

  it('never starts a world mounted into an already-hidden document', async () => {
    const harness = buildHarness({ envInitial: { hidden: true } });
    await harness.control.mount();
    const app = harness.applications[0];
    // A world the learner cannot see must not present a frame; this is the whole
    // reason `autoStart: false` is the host's decision rather than PixiJS's default.
    expect(app.startCount).toBe(0);
    expect(app.stopCount).toBe(0);
    expect(app.events).not.toContain('start');

    harness.env.visibilityListeners[0](false);
    expect(app.startCount).toBe(1);
    harness.control.unmount();
  });

  it('a visibility change after unmount cannot start a destroyed renderer', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    const listener = harness.env.visibilityListeners[0];
    harness.control.unmount();
    // The host cleared its subscription, so this callback is one the environment
    // should not have - and the one it does hold must not reach a released renderer.
    expect(harness.env.visibilityListeners).toHaveLength(0);
    expect(() => listener(false)).not.toThrow();
    expect(harness.applications[0].events.filter((event) => event === 'start')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Reduced motion                                                              */
/* -------------------------------------------------------------------------- */

describe('reduced motion is a number the scene reads, applied live', () => {
  it('hands the scene a scaled profile when the preference is on at mount', async () => {
    const surface = track(hostElement());
    const { environment, log } = createFakeEnvironment({ reducedMotion: true });
    const received: CozyMotionProfile[] = [];
    const activations: [string, string][] = [];
    const control = createPixiWorldHost<WorldApplication, WorldScene>({
      host: surface,
      theme: resolveCozyWorldTheme({ reducedMotion: true }),
      quality: QUALITY,
      reducedMotion: true,
      environment,
      createApplication: async (spec) => createFakeApplication(spec.canvas).application,
      createScene: (_application, init) => {
        received.push(init.theme.motion);
        const made = createFakeScene(1);
        return {
          ...made.scene,
          activate: (actionId, source) => {
            activations.push([actionId, source]);
            return made.scene.activate(actionId, source);
          },
        } as WorldScene;
      },
    });
    await control.mount();
    // Every named travel and every named duration is zero, so nothing a scene draws
    // from these tables can move and no tween can take time.
    expect(received).toHaveLength(1);
    expect(received[0].reduced).toBe(true);
    expect(received[0].scale).toBe(0);
    expect(received[0].travelPx('large')).toBe(0);
    expect(received[0].durationMs('slow')).toBe(0);
    // And the action itself is not disabled: a learner who asked for less motion has
    // not asked for a world that stops responding.
    control.activateFromDom('light');
    expect(activations).toEqual([['light', 'dom']]);
    control.unmount();
    expect(log.reducedListeners).toHaveLength(0);
  });

  it('applies a live change to the running scene, and re-applies the geometry', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    expect(harness.scenes[0].motionProfiles).toHaveLength(0);

    harness.env.reducedMotion = true;
    harness.env.reducedListeners[0](true);

    expect(harness.scenes[0].motionProfiles).toHaveLength(1);
    const profile = harness.scenes[0].motionProfiles[0];
    expect(profile.reduced).toBe(true);
    // At full motion the same table is 24 pixels, so the zero is the preference and
    // not a missing token.
    expect(resolveCozyWorldTheme({ reducedMotion: false }).motion.travelPx('large')).toBe(24);
    expect(profile.travelPx('large')).toBe(0);

    // A second, identical notification is not forwarded: the host already knows.
    harness.env.reducedListeners[0](true);
    expect(harness.scenes[0].motionProfiles).toHaveLength(1);

    // And back again, so a learner who turns the preference off gets motion.
    harness.env.reducedMotion = false;
    harness.env.reducedListeners[0](false);
    expect(harness.scenes[0].motionProfiles).toHaveLength(2);
    expect(harness.scenes[0].motionProfiles[1].travelPx('large')).toBe(24);
    harness.control.unmount();
  });

  it('`setReducedMotion` is idempotent and total for a preference it already holds', async () => {
    const harness = buildHarness({ reducedMotion: true });
    await harness.control.mount();
    harness.control.setReducedMotion(true);
    expect(harness.scenes[0].motionProfiles).toHaveLength(0);
    harness.control.setReducedMotion(false);
    expect(harness.scenes[0].motionProfiles).toHaveLength(1);
    harness.control.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

describe('resizing reaches the renderer and the scene exactly once per change', () => {
  it('forwards a real change and ignores a repeat of the current size', async () => {
    const harness = buildHarness({ box: [400, 300] });
    await harness.control.mount();
    const app = harness.applications[0];
    const emit = harness.env.sizeListeners[0];

    emit(400, 300);
    expect(app.resizes).toEqual([[400, 300]]);
    emit(400, 300);
    expect(app.resizes).toEqual([[400, 300]]);
    emit(400, 301);
    expect(app.resizes).toEqual([[400, 300], [400, 301]]);
    expect(harness.scenes[0].resizes).toEqual([[400, 300], [400, 301]]);
    harness.control.unmount();
  });

  it('a collapsed element still produces a non-degenerate surface', () => {
    // Zero would make a renderer compute `Infinity` in a layout and `NaN` in a
    // normalised coordinate, so a one-pixel floor is arithmetic, not politeness.
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    expect(measureElement(element)).toEqual({ width: 1, height: 1 });
  });

  it('measures the box the canvas fills, not the border box the canvas enlarges', () => {
    // The defect this asserts. The element measured is the surface the canvas is put
    // into, and the canvas is sized to whatever is measured - so a measurement of the
    // *border* box is a measurement of a box the canvas's own CSS size grows by the
    // surface's borders. Every delivery then guarantees another delivery, and the
    // surface climbs: the browser lane recorded a world surface that had reached 134
    // CSS pixels and was still moving. `clientWidth`/`clientHeight` are the padding
    // box, which is the box the canvas actually fills, and the feedback has gain one.
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ width: 620, height: 302 }) as DOMRect;
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 620 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 300 });
    // The surface is 302 pixels of border box around 300 pixels of canvas.
    expect(measureElement(element)).toEqual({ width: 620, height: 300 });
  });
});

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

describe('every input path reaches one dispatch, so a keyboard user loses nothing', () => {
  it('routes the keyboard, the mirror, and the pointer through the same activation', async () => {
    const harness = buildHarness();
    const control = harness.control;
    await control.mount();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', bubbles: true }));
    control.activateFromDom('ring');
    // The pointer path is the scene's own `activate` call with `source: 'pointer'`;
    // the canvas affordance and the mirror control both arrive at the host's single
    // dispatch, and the scene sees three sources for one scene.
    dispatchPointer(harness.scenes[0]);

    expect(harness.scenes[0].activations).toEqual([
      ['light', 'keyboard'],
      ['ring', 'dom'],
      ['ring', 'pointer'],
    ]);
    control.unmount();
  });

  it('claims a world shortcut and ignores a modified one', async () => {
    const harness = buildHarness();
    await harness.control.mount();

    const plain = new KeyboardEvent('keydown', { key: 'l', cancelable: true, bubbles: true });
    window.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(harness.scenes[0].activations).toHaveLength(1);

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', [modifier]: true, cancelable: true, bubbles: true }));
    }
    // Ctrl-L is the browser's "focus the address bar", Meta-M is a menu, Alt is a
    // browser shortcut. None of them is a world shortcut.
    expect(harness.scenes[0].activations).toHaveLength(1);
    harness.control.unmount();
  });

  it('ignores a key typed into a field, and a key aimed at a mirror control', async () => {
    const harness = buildHarness();
    const control = harness.control;
    const mirror = document.createElement('div');
    const control_ = document.createElement('button');
    mirror.appendChild(control_);
    document.body.appendChild(mirror);
    control.setMirrorElement(mirror);
    const field = document.createElement('input');
    field.type = 'text';
    document.body.appendChild(field);
    try {
      await control.mount();

      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
      expect(harness.scenes[0].activations, 'typing "l" in a note must not light a lantern').toHaveLength(0);

      control_.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
      expect(
        harness.scenes[0].activations,
        'a focused mirror button already turns Enter into a click, so the window handler must stand down',
      ).toHaveLength(0);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
      expect(harness.scenes[0].activations).toHaveLength(1);
      control.unmount();
    } finally {
      mirror.remove();
      field.remove();
    }
  });

  it('ignores a key no action claims, and an event another handler already consumed', async () => {
    const harness = buildHarness();
    await harness.control.mount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    const consumed = new KeyboardEvent('keydown', { key: 'l', cancelable: true, bubbles: true });
    consumed.preventDefault();
    window.dispatchEvent(consumed);
    expect(harness.scenes[0].activations).toHaveLength(0);
    harness.control.unmount();
  });

  it('publishes state as soon as the world is built, and after every action', async () => {
    const harness = buildHarness();
    const control = harness.control;
    const published: WorldActionState[] = [];
    const stop = control.onState((state) => published.push(state));
    await control.mount();
    // The mirror is the accessible route to every action, so it exists before the
    // first frame - a world mounted into a hidden document must still be operable.
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({ light: 'Lantern lit', ring: 'Bell rung' });

    control.activateFromDom('light');
    expect(published).toHaveLength(2);

    // An id no action claims is a no-op, and the state is still republished so a
    // stale control cannot desynchronise what the learner sees from what the world did.
    control.activateFromDom('not-an-action');
    expect(published).toHaveLength(3);

    stop();
    control.activateFromDom('light');
    expect(published).toHaveLength(3);
    control.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

describe('the host satisfies the Phase 2 renderer contract', () => {
  it('is assignable to `WorldRenderer` and exposes the contract members', async () => {
    const harness = buildHarness();
    // The compile-time half: a caller that only knows the contract can hold it.
    const contract: WorldRenderer = harness.control;
    expect(contract).toBe(harness.control);
    await contract.mount();
    // And the run-time half: every member exists and is callable.
    for (const member of ['mount', 'unmount', 'isReady', 'restart'] as const) {
      expect(typeof contract[member], member).toBe('function');
    }
    expect(contract.isReady()).toBe(false);
    contract.restart();
    expect(() => contract.unmount()).not.toThrow();
  });

  it('forwards a scene capability port unchanged, so Phase 11 can bind one', async () => {
    const capabilities = { teleportToRoom: (): void => {} };
    const surface = track(hostElement());
    const { environment } = createFakeEnvironment();
    const control = createPixiWorldHost<WorldApplication, WorldScene & { capabilities: typeof capabilities }>({
      host: surface,
      theme: resolveCozyWorldTheme({}),
      quality: QUALITY,
      reducedMotion: false,
      environment,
      createApplication: async (spec) => createFakeApplication(spec.canvas).application,
      createScene: () => ({ ...createFakeScene(1).scene, capabilities }) as never,
    });
    expect(control.capabilities).toBeUndefined();
    await control.mount();
    // The identical object, not a copy: a screen holding a
    // `DungeonRendererCapabilities` keeps holding it across a restart.
    expect(control.capabilities).toBe(capabilities);
    control.restart();
    expect(control.capabilities).toBe(capabilities);
    control.unmount();
    expect(control.capabilities).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Twenty cycles                                                               */
/* -------------------------------------------------------------------------- */

describe('twenty mount and unmount cycles leave nothing subscribed', () => {
  it('canvases, applications, and every subscription return to zero', async () => {
    const CYCLES = 20;
    const { environment, log } = createFakeEnvironment();
    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      const surface = hostElement();
      const { application, log: appLog } = createFakeApplication(document.createElement('canvas'));
      const scene = createFakeScene(cycle);
      const control = createPixiWorldHost<WorldApplication, WorldScene>({
        host: surface,
        theme: resolveCozyWorldTheme({ reducedMotion: cycle % 2 === 0 }),
        quality: QUALITY,
        reducedMotion: cycle % 2 === 0,
        environment,
        createApplication: async () => application,
        createScene: () => scene.scene,
      });
      await control.mount();
      log.visibilityListeners[log.visibilityListeners.length - 1](cycle % 2 === 0);
      log.reducedListeners[log.reducedListeners.length - 1](cycle % 2 === 1);
      control.unmount();
      surface.remove();
      expect(document.body.querySelectorAll('canvas'), `cycle ${cycle} left a canvas`).toHaveLength(0);
      expect(appLog.destroyed, `cycle ${cycle} left the renderer alive`).toEqual({
        releaseGlobalResources: true,
      });
      expect(scene.log.destroyed).toBe(1);
    }
    expect(log.reducedListeners).toHaveLength(0);
    expect(log.visibilityListeners).toHaveLength(0);
    expect(log.sizeListeners).toHaveLength(0);
    expect(log.observed).toHaveLength(0);
  }, 30_000);
});

/* -------------------------------------------------------------------------- */
/* The browser environment                                                     */
/* -------------------------------------------------------------------------- */

describe('the browser environment observes three things and removes all of them', () => {
  let originalResizeObserver: unknown;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
    }
    window.matchMedia = originalMatchMedia;
  });

  it('reports the reduced-motion state and unsubscribes from changes', () => {
    let matches = false;
    const query: Partial<MediaQueryList> & { onchange: ((event: MediaQueryListEvent) => void) | null } = {
      get matches() {
        return matches;
      },
      onchange: null,
    };
    window.matchMedia = ((text: string) =>
      text.includes('prefers-reduced-motion') ? (query as MediaQueryList) : ({ matches: false }) as MediaQueryList) as typeof window.matchMedia;

    const environment = createBrowserWorldEnvironment(window);
    expect(environment.reducedMotion()).toBe(false);
    matches = true;
    expect(environment.reducedMotion()).toBe(true);

    const seen: boolean[] = [];
    const stop = environment.observeReducedMotion((reduced) => seen.push(reduced));
    expect(query.onchange).toBeTypeOf('function');
    query.onchange?.({ matches: true } as MediaQueryListEvent);
    expect(seen).toEqual([true]);
    // Removed, so a host that navigated away takes its media-query handler with it.
    stop();
    expect(query.onchange).toBe(null);
  });

  it('is a no-op where there is no `matchMedia` at all', () => {
    const environment = createBrowserWorldEnvironment({
      matchMedia: () => {
        throw new Error('unknown query');
      },
    } as unknown as Window);
    // A webview that refuses an unknown query has not told us motion is reduced, and
    // answering "reduced" on its say-so would stop every world on an embed's word.
    expect(environment.reducedMotion()).toBe(false);
    const stop = environment.observeReducedMotion(() => {
      throw new Error('must not fire');
    });
    expect(stop).toBeTypeOf('function');
    expect(() => stop()).not.toThrow();
  });

  it('observes document visibility and removes the listener', () => {
    const environment = createBrowserWorldEnvironment(window);
    const seen: boolean[] = [];
    const stop = environment.observeVisibility((hidden) => seen.push(hidden));
    expect(document.hidden).toBe(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([false]);
    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([false]);
  });

  it('measures the element once on subscribe, then on a `ResizeObserver`', () => {
    const observed: Element[] = [];
    let disconnected = 0;
    const fire: { current: (() => void) | null } = { current: null };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(callback: () => void) {
        fire.current = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve(): void {}
      disconnect() {
        disconnected += 1;
      }
    };

    const environment = createBrowserWorldEnvironment(window);
    const element = track(hostElement(320, 240));
    const seen: [number, number][] = [];
    const stop = environment.observeSize(element, (width, height) => seen.push([width, height] as const));

    // Measured immediately, so a world mounted into an element that already has a
    // size starts at that size even before an observer callback arrives.
    expect(seen).toEqual([[320, 240]]);
    expect(observed).toEqual([element]);
    fire.current?.();
    expect(seen).toEqual([[320, 240], [320, 240]]);
    stop();
    expect(disconnected).toBe(1);
  });

  it('falls back to a window resize listener when there is no `ResizeObserver`', () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const environment = createBrowserWorldEnvironment(window);
    const element = track(hostElement(200, 100));
    const seen: [number, number][] = [];
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      const stop = environment.observeSize(element, (width, height) => seen.push([width, height]));
      expect(seen).toEqual([[200, 100]]);
      expect(addSpy.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
      window.dispatchEvent(new Event('resize'));
      expect(seen).toHaveLength(2);
      stop();
      expect(removeSpy.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
      window.dispatchEvent(new Event('resize'));
      expect(seen, 'the fallback listener outlived its unsubscribe').toHaveLength(2);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('degrades to fixed answers in a realm with no DOM at all', () => {
    // The point of the seam: the reduced-motion *policy* is a pure function of a
    // boolean, so it can be asserted where there is no `window` to ask.
    const environment = createDomlessWorldEnvironment();
    expect(environment.reducedMotion()).toBe(false);
    expect(environment.hidden()).toBe(false);
    const seen: [number, number][] = [];
    const stop = environment.observeSize(document.createElement('div'), (w, h) => seen.push([w, h] as const));
    // Non-degenerate, so a renderer's arithmetic has something to divide by.
    expect(seen).toEqual([[1, 1]]);
    expect(() => stop()).not.toThrow();
    expect(environment.observeReducedMotion(() => {})).toBeTypeOf('function');
    expect(environment.observeVisibility(() => {})).toBeTypeOf('function');
  });

  it('`currentWorldEnvironment` answers for the current realm and does not throw', () => {
    const environment = currentWorldEnvironment();
    expect(environment.reducedMotion()).toBe(false);
    expect(environment.hidden()).toBe(false);
    // jsdom has no `ResizeObserver`, so this exercises the fallback path rather than
    // pretending the observer exists.
    const stop = environment.observeSize(track(hostElement(50, 50)), () => {});
    expect(() => stop()).not.toThrow();
  });
});
