/**
 * The PixiJS world host, as a renderer-neutral lifecycle.
 *
 * ## The shape
 *
 * `createPixiWorldHost` owns five things and delegates everything else:
 *
 * 1. a canvas, appended into the host element the caller supplied;
 * 2. a renderer, created through the injected {@link WorldApplicationFactory};
 * 3. a **private** ticker, so pausing this world cannot pause anything else;
 * 4. three environment subscriptions - reduced motion, visibility, and element
 *    size - each of which is removed on teardown;
 * 5. one dispatch path for every interaction, which the canvas, the DOM mirror, and
 *    the scene's own pointer handlers all call. Activation and state publication
 *    live in that one function, and the scene is given the dispatcher rather than
 *    its own action verb, so a world cannot change without the mirror hearing it.
 *
 * ## Why the scene is handed a dispatcher
 *
 * The first version of this file let the host own the dispatch and let the scene own
 * its own `activate`, on the assumption that a scene author would route canvas input
 * through the host. The test world did not: its bell's `pointertap` handler called its
 * local `activate`, so two real taps on the canvas rang the bell twice while the DOM
 * mirror - the only place a screen-reader user can learn what happened - kept
 * announcing `Bell quiet` and then jumped to `Bell rung 3 times` on the next control
 * click. The visible claim on the screen, that "every canvas action has a control
 * here", was false.
 *
 * So the dependency is inverted. `dispatch` is passed *into* the scene as
 * `WorldSceneInit.onAction`, the scene is given no reference to its own `activate`,
 * and the two lines that perform and publish an action are adjacent in one function.
 * `tests/phase9/pixi-dispatch-ownership.test.ts` pins that no module under
 * `src/renderers/**` calls `activate` except this one, and
 * `tests/phase9/pixi-composition-root.test.tsx` and
 * `tests/phase9/browser/pixi-canvas-pointer.spec.ts` pin the behaviour at both
 * altitudes.
 *
 * It names no renderer type. `createPixiApplication.ts` is the module that binds
 * PixiJS and the only file in this tree that imports `pixi.js`; a scene factory is
 * generic over the application type, so the concrete `Application` reaches the
 * scene without this layer naming it. The ticker's v8 callback shape is handled in
 * the binding, not here, which is why a scene receives a millisecond delta and
 * cannot accidentally read the v7 `ticker.deltaTime` form.
 *
 * ## Why mount is idempotent and unmount is total
 *
 * React runs mount effects twice under StrictMode in development, and a screen can
 * unmount while `app.init()` is still negotiating a GPU context. Both produce the
 * same shape of bug: two canvases, two tickers, and a renderer whose resources
 * outlive the element they were appended to. So a second `mount()` is a no-op, and
 * `unmount()` tears down whatever is present - not whatever was present when the
 * teardown was scheduled - and is safe after a failed `init()`.
 *
 * A mount that fails is the third case, and it is the one that used to leak: a
 * renderer that cannot start throws before the canvas reaches the DOM, but a *scene*
 * that cannot be built throws after the canvas is attached and the renderer is live.
 * Both now release everything before the error reaches the caller, so a screen that
 * reports a failure is showing a failure over a clean document rather than over a
 * GPU context nobody will ever release.
 *
 * ## Readiness
 *
 * `isReady()` flips after the first frame is *presented*, not after the scene is
 * built. A host that reported ready at construction would let a screen paint a HUD
 * over a canvas that has not drawn anything. The flip happens inside the frame
 * callback, so it is one tick after the scene exists and not one tick before it.
 *
 * The DOM mirror deliberately does **not** wait for it. The mirror is the
 * accessible path to every action, and plan section 10.1 requires it unconditionally;
 * a world mounted into a hidden document must therefore still publish its actions
 * even though no frame has been presented.
 *
 * ## Reduced motion
 *
 * The host owns the policy, the caller owns the observation - the split
 * `worldEnvironment.ts` exists for. `setReducedMotion` recomputes the theme through
 * `withCozyWorldMotion` and hands the profile to the scene, so a live media-query
 * change reaches a running world rather than only the next mount.
 */
import { withCozyWorldMotion } from './cozyWorldTheme';
import { measureElement } from './worldEnvironment';
import type {
  CreateWorldHostOptions,
  PixiWorldHost,
  WorldAction,
  WorldActionSource,
  WorldActionState,
  WorldApplication,
  WorldScene,
  WorldSceneInit,
} from './types';

/** Input types with no text caret, so a keystroke in one is not typing. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
  'hidden',
]);

/**
 * The action a key press performs, or `null`.
 *
 * Scans the scene's own list rather than a pre-built map, because the key set is
 * the scene's and the scene does not exist when a host is constructed. A `null` or
 * empty `keyboardKey` never matches, so an action with no key is simply absent from
 * the keyboard surface.
 */
function actionIdForKey(actions: readonly WorldAction[], key: string): string | null {
  const normalized = key.toLowerCase();
  for (const action of actions) {
    if (action.keyboardKey !== null && action.keyboardKey.toLowerCase() === normalized) {
      return action.id;
    }
  }
  return null;
}

/**
 * Whether a keystroke belongs to a control that already handles it.
 *
 * Two cases, and both are real:
 *
 * - The target is inside this host's own DOM mirror. A mirror control is a real
 *   `<button>`, so Enter and Space already produce a `click`; a window-level
 *   handler that also fired would run the action twice for one keypress.
 * - The target is a text-entry control elsewhere in the application - the note
 *   editor, a settings field. Without this, typing "l" into a note would light a
 *   lantern in the world behind the dialog.
 *
 * This duplicates `isEditableElement` from `src/ui/utils/editableElement.ts`, and
 * the duplication is deliberate: the renderer host is meant to outlive the current
 * screens, so it does not take a dependency on the UI tree it will eventually
 * replace. The two answers are pinned to agree by
 * `tests/phase9/pixi-host-boundary.test.ts`, which is cheaper than an inverted
 * dependency and cannot drift silently.
 */
export function isHandledElsewhere(target: EventTarget | null, mirror: HTMLElement | null): boolean {
  if (target !== null && mirror !== null && typeof (target as Node).nodeType === 'number') {
    if (mirror.contains(target as Node)) return true;
  }
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type?.toLowerCase() ?? '');
}

/**
 * Build a world host.
 *
 * The returned host is inert until {@link PixiWorldHost.mount} is called, so a
 * caller can subscribe to readiness and to state before anything renders.
 */
export function createPixiWorldHost<
  TApplication extends WorldApplication,
  TScene extends WorldScene<TCapabilities>,
  TCapabilities = unknown,
>(
  options: CreateWorldHostOptions<TApplication, TScene>,
): PixiWorldHost<TCapabilities> {
  const {
    host,
    createApplication,
    createScene,
    quality,
    environment,
    releaseGlobalResources = true,
  } = options;

  let theme = options.theme;
  let reducedMotion = options.reducedMotion;
  let application: TApplication | null = null;
  let scene: TScene | null = null;
  let ready = false;
  let stopped = false;
  let hidden = environment.hidden();
  let startSequence = 0;
  let readyListeners: (() => void)[] = [];
  let stateListeners: ((state: WorldActionState) => void)[] = [];
  let frameDisposer: (() => void) | null = null;
  let keydownDisposer: (() => void) | null = null;
  let visibilityDisposer: (() => void) | null = null;
  let reducedMotionDisposer: (() => void) | null = null;
  let sizeDisposer: (() => void) | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let mirrorElement: HTMLElement | null = null;
  let surface = { width: 1, height: 1 };

  function notifyReady(): void {
    ready = true;
    const listeners = readyListeners;
    readyListeners = [];
    for (const listener of listeners) listener();
  }

  function publishState(): void {
    if (scene === null) return;
    const state = scene.readState();
    for (const listener of stateListeners) listener(state);
  }

  /**
   * The single entry point for every input path.
   *
   * Activation and publication are the same two lines in the same function, on
   * purpose. The three routes in - the document keydown handler, the canvas pointer
   * handlers (through the {@link WorldSceneInit.onAction} callback the scene is built
   * with), and the DOM mirror control - all land here, so there is no order in which
   * a world can change without its state being republished to the mirror's
   * `aria-live` lines. A scene that called its own `activate` instead is exactly the
   * defect this shape exists to make impossible: it rang the bell and left the mirror
   * announcing `Bell quiet`.
   *
   * The scene's return value is not forwarded to the mirror: an unknown id from a
   * stale control is a no-op, and the mirror republishes its state either way, so
   * a no-op cannot desynchronise what the learner sees from what the world did.
   */
  function dispatch(actionId: string, source: WorldActionSource): void {
    if (scene === null) return;
    scene.activate(actionId, source);
    publishState();
  }

  function onKeydown(event: KeyboardEvent): void {
    // A modified keystroke belongs to the browser or the application, not to a
    // world shortcut: Ctrl-L is "focus the address bar", Meta-M is a browser menu.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isHandledElsewhere(event.target, mirrorElement)) return;
    const current = scene;
    if (current === null) return;
    const actionId = actionIdForKey(current.actions, event.key);
    if (actionId === null) return;
    // Claimed, so one keypress cannot also reach a default the application is
    // relying on. This is a world shortcut, never a control's own activation -
    // that is the mirror control's `click`, which the guard above excludes.
    event.preventDefault();
    dispatch(actionId, 'keyboard');
  }

  function teardown(): void {
    // Subscriptions first, in reverse registration order, so nothing can deliver
    // a callback into a scene or a renderer that is about to be released.
    if (frameDisposer) {
      frameDisposer();
      frameDisposer = null;
    }
    if (keydownDisposer) {
      keydownDisposer();
      keydownDisposer = null;
    }
    if (visibilityDisposer) {
      visibilityDisposer();
      visibilityDisposer = null;
    }
    if (reducedMotionDisposer) {
      reducedMotionDisposer();
      reducedMotionDisposer = null;
    }
    if (sizeDisposer) {
      sizeDisposer();
      sizeDisposer = null;
    }

    const currentScene = scene;
    scene = null;
    if (currentScene !== null) {
      try {
        currentScene.destroy();
      } catch {
        // A scene that throws while destroying must not strand the renderer, the
        // canvas, or the subscriptions above. Teardown continues, and the evidence
        // surfaces in the browser lane's canvas count rather than as a blank world
        // with a console error nobody reads.
      }
    }

    const currentApplication = application;
    application = null;
    if (currentApplication !== null) {
      try {
        currentApplication.destroy({ releaseGlobalResources });
      } catch {
        // Same reasoning: nothing after this point depends on the renderer having
        // survived its own release.
      }
    }

    // `removeView` already detaches the canvas from the DOM on the PixiJS path;
    // this is the belt-and-braces for a driver that does not, and it is what makes
    // "unmount leaves no canvas" true of the host rather than of one binding.
    if (canvas !== null) {
      canvas.remove();
      canvas = null;
    }

    ready = false;
    readyListeners = [];
  }

  async function mount(): Promise<void> {
    if (application !== null) return;
    const sequence = ++startSequence;
    stopped = false;

    const element = document.createElement('canvas');
    // The canvas is a *visual* surface. Every action it offers is also a real
    // focusable DOM control, so exposing it to assistive technology would add an
    // unnamed, unreachable duplicate of each control. It is not focusable either,
    // which is what leaves the keyboard action on the document rather than on a
    // canvas that can never receive focus.
    element.setAttribute('aria-hidden', 'true');
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.height = '100%';

    const spec = {
      canvas: element,
      quality,
      background: theme.color.surfacePage,
      backgroundAlpha: 1,
    };

    let created: TApplication;
    try {
      created = await createApplication(spec);
    } catch (error) {
      // A renderer that cannot start is a state the host has to survive, not one
      // it has to rethrow into an unhandled rejection. The canvas never reached
      // the DOM, so a failed mount leaves the same document a clean unmount does.
      if (sequence === startSequence) teardown();
      throw error;
    }

    // The host may have unmounted, or been asked to mount again, while the GPU
    // context was being negotiated. Anything that arrives after the sequence
    // changed is released immediately rather than adopted.
    if (stopped || sequence !== startSequence) {
      try {
        created.destroy({ releaseGlobalResources });
      } catch {
        // The caller has already observed the unmount; a failure to release a
        // late renderer cannot change that, and must not replace it with a second
        // failure.
      }
      return;
    }

    canvas = element;
    application = created;
    host.appendChild(element);
    hidden = environment.hidden();

    // The surface is measured once here rather than waiting for the observer, so
    // the very first frame is drawn at the right size rather than at the
    // one-pixel surface the application was created with.
    const measured = measureElement(host);
    surface = { width: measured.width, height: measured.height };
    created.resize(surface.width, surface.height);

    // The dispatcher is handed to the scene rather than the other way round, so the
    // scene has no reference to its own `activate` to call directly. Same function on
    // mount and on `restart()` below - a fresh closure per mount would leave a
    // destroyed scene holding a live dispatcher, which is the one way this seam could
    // come apart later.
    const init: WorldSceneInit = { theme, quality, onAction: dispatch };
    let built: TScene;
    try {
      built = createScene(created, init);
    } catch (error) {
      // The same reasoning as a rejected `createApplication`, one step later. A scene
      // that cannot be built - a binding the host was handed a scene for and cannot
      // honour, a world that throws while reading its first surface size - must not
      // leave behind the renderer, the canvas, and the subscriptions above it, because
      // the caller's only route from here is the failure state, not another mount.
      // Teardown releases what is present; the rethrow is what tells the screen.
      if (sequence === startSequence) teardown();
      throw error;
    }
    scene = built;
    built.onResize(surface.width, surface.height);

    frameDisposer = created.onFrame((deltaMs) => {
      const active = scene;
      if (active !== null && deltaMs > 0) active.update(deltaMs);
      if (!ready) notifyReady();
    });

    const win = host.ownerDocument?.defaultView ?? undefined;
    if (win) {
      win.addEventListener('keydown', onKeydown);
      keydownDisposer = () => win.removeEventListener('keydown', onKeydown);
    }

    visibilityDisposer = environment.observeVisibility((nextHidden) => {
      hidden = nextHidden;
      const current = application;
      if (current === null) return;
      if (nextHidden) current.stopTicker();
      else current.startTicker();
    });

    reducedMotionDisposer = environment.observeReducedMotion((next) => {
      setReducedMotion(next);
    });

    sizeDisposer = environment.observeSize(host, (width, height) => {
      const current = application;
      if (current === null) return;
      if (width === surface.width && height === surface.height) return;
      surface = { width, height };
      current.resize(width, height);
      scene?.onResize(width, height);
    });

    // Visibility is applied *after* the subscriptions, so a world mounted into a
    // hidden document never runs a frame it did not need. Nothing is *stopped* in
    // that case: the ticker was created stopped (`autoStart: false`), so stopping it
    // again would be a call to the renderer that changes nothing.
    if (!hidden) created.startTicker();

    // Published unconditionally, and before the first frame on purpose: the mirror
    // is the accessible route to every action and must exist even when no frame
    // has been presented.
    publishState();
  }

  function unmount(): void {
    stopped = true;
    startSequence += 1;
    teardown();
    stateListeners = [];
  }

  function restart(): void {
    const current = application;
    if (current === null) return;
    const previous = scene;
    scene = null;
    previous?.destroy();
    const built = createScene(current, { theme, quality, onAction: dispatch });
    scene = built;
    built.onResize(surface.width, surface.height);
    if (!hidden) current.startTicker();
    publishState();
  }

  function setReducedMotion(next: boolean): void {
    if (reducedMotion === next && theme.motion.reduced === next) return;
    reducedMotion = next;
    theme = withCozyWorldMotion(theme, next);
    // The scene owns the motion policy's *effect*; the host owns the profile. A
    // live change has to reach the running scene, or a learner who turns reduced
    // motion on mid-session keeps watching a world that ignores it.
    scene?.setMotionProfile?.(theme.motion);
  }

  return {
    mount,
    unmount,
    isReady: () => ready,
    restart,
    activateFromDom(actionId: string): void {
      dispatch(actionId, 'dom');
    },
    onReady(listener: () => void): () => void {
      readyListeners.push(listener);
      return () => {
        readyListeners = readyListeners.filter((entry) => entry !== listener);
      };
    },
    onState(listener: (state: WorldActionState) => void): () => void {
      stateListeners.push(listener);
      return () => {
        stateListeners = stateListeners.filter((entry) => entry !== listener);
      };
    },
    setReducedMotion,
    get actions(): readonly WorldAction[] {
      return scene?.actions ?? [];
    },
    get capabilities(): TCapabilities | undefined {
      return scene?.capabilities;
    },
    setMirrorElement(element: HTMLElement | null): void {
      mirrorElement = element;
    },
  };
}
