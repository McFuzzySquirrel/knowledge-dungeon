/**
 * Keyboard, pointer, touch, and wheel input, as a plain DOM controller.
 *
 * ## Why a controller rather than PixiJS events
 *
 * The PixiJS event system is good at "which display object did the pointer hit".
 * A village does not need that: its pointer gestures are **whole-surface** - a
 * drag anywhere moves, a tap anywhere interacts, two fingers anywhere zoom - and
 * its keyboard is global. Routing those through a scene graph would mean making
 * the canvas hit-testable for gestures that do not care where they began, and it
 * would tie input policy to a renderer. So the gestures are bound to the canvas
 * element directly, in a module that imports no renderer and can be driven by
 * synthetic events in a test.
 *
 * ## One controller, one set of channels
 *
 * Every input path converges on four readings, and nothing else:
 *
 * | Reading              | Keyboard                          | Pointer/touch       |
 * |----------------------|-----------------------------------|---------------------|
 * | `getMoveVector()`    | arrows, WASD                      | one-finger drag     |
 * | `consumeInteract()`  | `E`, Space                        | tap (short, still)  |
 * | `consumeZoomDelta()` | -                                 | wheel, pinch        |
 * | `setEnabled(false)`  | releases every held key and gesture                    |
 *
 * The scene polls these once per frame. That is deliberate: a discrete event
 * cannot be lost between two `update`s, and a scene never has to remember which
 * callbacks it registered.
 *
 * ## The tap, precisely
 *
 * A press that travels less than {@link DRAG_THRESHOLD} and lasts less than
 * {@link TAP_MAX_MS} is a tap and queues an interact; anything else is a drag and
 * becomes movement. A `pointercancel` never queues anything, because a gesture
 * the browser took away is not one the learner finished.
 *
 * ## What is deliberately not here
 *
 * No camera, no zoom value that survives a frame, and no world state. `setZoom`
 * exists only so a pinch can be expressed as an additive delta against the zoom
 * the scene last reported; the scene remains the owner of zoom.
 */
import {
  DRAG_THRESHOLD,
  TAP_MAX_MS,
  WHEEL_ZOOM_STEP,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
} from '@/data/villageLayout';

/** Which channel an interact arrived on. Reported, never branched on. */
export type WorldInputSource = 'keyboard' | 'pointer';

/** A queued interact and the channel it came from. */
export interface WorldInputInteract {
  readonly source: WorldInputSource;
}

/** A two-component movement vector. Not normalised: the scene does that. */
export interface WorldMoveVector {
  readonly x: number;
  readonly y: number;
}

export interface WorldInputOptions {
  /** The element pointer, touch, and wheel gestures are bound to. */
  readonly element: HTMLElement;
  /** The window keyboard is bound to. Defaults to the element's own window. */
  readonly window?: Window;
  readonly tapMaxMs?: number;
  readonly dragThreshold?: number;
  /** One wheel notch, in zoom units. */
  readonly zoomStep?: number;
  readonly zoomMin?: number;
  readonly zoomMax?: number;
  /** The zoom the controller assumes before the scene reports one. */
  readonly initialZoom?: number;
  /**
   * A clock, in milliseconds. Defaults to `performance.now`. Injected so a test
   * can state a press duration in data rather than in real elapsed time.
   */
  readonly now?: () => number;
  /**
   * Whether a keyboard event belongs to a text control and must be ignored.
   *
   * Defaults to a local tag-based check. The renderer host has its own copy of
   * this rule; the two are allowed to differ because only the host's is pinned by
   * a gate, and this one exists for the same reason - typing `w` into a note must
   * not walk the player.
   */
  readonly shouldIgnoreKeyboard?: (target: EventTarget | null) => boolean;
}

export interface WorldInputController {
  /** Turn input on or off. Disabling releases every held key and gesture. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** The merged movement vector from held keys and an in-progress drag. */
  getMoveVector(): WorldMoveVector;
  /** Take the queued interact, if any, clearing it. */
  consumeInteract(): WorldInputInteract | null;
  /** Take the accumulated zoom delta since the last call, clearing it. */
  consumeZoomDelta(): number;
  /** Tell the controller the zoom the scene actually applied, so a pinch is relative to it. */
  setZoom(zoom: number): void;
  getZoom(): number;
  /** Remove every listener and clear every gesture. Safe to call twice. */
  destroy(): void;
}

/** Normalise an `event.key` to the lowercase spelling the tables use. */
function normalizeKey(key: string): string {
  if (key === ' ' || key === 'Spacebar' || key === 'Space') return ' ';
  return key.toLowerCase();
}

const MOVE_KEYS: ReadonlySet<string> = new Set([
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'a',
  'd',
  'w',
  's',
]);

const INTERACT_KEYS: ReadonlySet<string> = new Set(['e', ' ']);

/** A tag name a keystroke should not be taken from: the learner is typing. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type?.toLowerCase() ?? '';
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'].includes(
    type,
  );
}

/**
 * A target whose own activation already produces a click.
 *
 * Used for the interact keys only: Space on a focused button fires the button's
 * click, and a controller that also queued an interact would perform the action
 * twice for one keypress. Movement keys ignore this - a learner may hold a
 * direction while a control has focus - and guard only against text entry.
 */
function isInteractiveControl(target: EventTarget | null): boolean {
  if (target === null || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(element.tagName);
}

function pointerIdOf(event: Event): number {
  const id = (event as { pointerId?: unknown }).pointerId;
  return typeof id === 'number' && Number.isFinite(id) ? id : 0;
}

function clientPointOf(event: Event): { x: number; y: number } {
  const mouse = event as { clientX?: unknown; clientY?: number };
  const x = typeof mouse.clientX === 'number' && Number.isFinite(mouse.clientX) ? mouse.clientX : 0;
  const y = typeof mouse.clientY === 'number' && Number.isFinite(mouse.clientY) ? mouse.clientY : 0;
  return { x, y };
}

/**
 * Build an input controller.
 *
 * The returned controller is inert only in the sense that nothing is held; it
 * begins listening immediately and `destroy` is what removes the listeners.
 */
export function createWorldInputController(options: WorldInputOptions): WorldInputController {
  const { element } = options;
  const win =
    options.window ??
    (element.ownerDocument?.defaultView as Window | undefined) ??
    (typeof window === 'undefined' ? undefined : window);
  const tapMaxMs = options.tapMaxMs ?? TAP_MAX_MS;
  const dragThreshold = options.dragThreshold ?? DRAG_THRESHOLD;
  const zoomStep = options.zoomStep ?? WHEEL_ZOOM_STEP;
  const zoomMin = options.zoomMin ?? ZOOM_MIN;
  const zoomMax = options.zoomMax ?? ZOOM_MAX;
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const ignoreKeyboard = options.shouldIgnoreKeyboard ?? isTextEntry;

  let enabled = true;
  let zoom = clampLocal(options.initialZoom ?? ZOOM_DEFAULT);

  const pressed = new Set<string>();
  const pointers = new Map<number, { x: number; y: number }>();

  let dragActive = false;
  let dragId = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartTime = 0;
  let touchX = 0;
  let touchY = 0;

  let pinchActive = false;
  let pinchStartDistance = 0;
  let pinchStartZoom = zoom;

  let pendingDelta = 0;
  let pendingInteract: WorldInputInteract | null = null;

  function clampLocal(value: number): number {
    if (!Number.isFinite(value)) return ZOOM_DEFAULT;
    if (value < zoomMin) return zoomMin;
    if (value > zoomMax) return zoomMax;
    return value;
  }

  function releaseGestures(): void {
    pressed.clear();
    pointers.clear();
    dragActive = false;
    pinchActive = false;
    touchX = 0;
    touchY = 0;
    pendingDelta = 0;
    pendingInteract = null;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!enabled) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = normalizeKey(event.key);

    if (INTERACT_KEYS.has(key)) {
      if (isInteractiveControl(event.target)) return;
      pendingInteract = { source: 'keyboard' };
      if (key === ' ' && typeof event.preventDefault === 'function') event.preventDefault();
      return;
    }

    if (!MOVE_KEYS.has(key)) return;
    if (ignoreKeyboard(event.target)) return;
    pressed.add(key);
    if (key.startsWith('arrow') && typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onKeyUp(event: KeyboardEvent): void {
    pressed.delete(normalizeKey(event.key));
  }

  function onBlur(): void {
    // A window that lost focus never delivers the matching keyup, so a held key
    // would otherwise walk the player until the next keypress.
    pressed.clear();
  }

  function beginPinch(): void {
    const points = [...pointers.values()];
    if (points.length < 2) return;
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    if (distance < 1) return;
    pinchActive = true;
    pinchStartDistance = distance;
    pinchStartZoom = zoom;
    dragActive = false;
    touchX = 0;
    touchY = 0;
  }

  function onPointerDown(event: Event): void {
    if (!enabled) return;
    const button = (event as { button?: unknown }).button;
    if (typeof button === 'number' && button > 0) return;
    const id = pointerIdOf(event);
    const point = clientPointOf(event);
    pointers.set(id, point);

    if (pointers.size >= 2) {
      beginPinch();
      return;
    }
    if (dragActive) return;
    dragActive = true;
    dragId = id;
    dragStartX = point.x;
    dragStartY = point.y;
    dragStartTime = now();
    touchX = 0;
    touchY = 0;
  }

  function onPointerMove(event: Event): void {
    if (!enabled) return;
    const id = pointerIdOf(event);
    if (!pointers.has(id)) return;
    const point = clientPointOf(event);
    pointers.set(id, point);

    if (pinchActive && pointers.size >= 2) {
      const points = [...pointers.values()];
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (pinchStartDistance > 0) {
        const desired = clampLocal(pinchStartZoom * (distance / pinchStartDistance));
        pendingDelta += desired - zoom;
        zoom = desired;
      }
      return;
    }

    if (!dragActive || id !== dragId) return;
    const dx = point.x - dragStartX;
    const dy = point.y - dragStartY;
    const distance = Math.hypot(dx, dy);
    if (distance > dragThreshold) {
      touchX = dx / distance;
      touchY = dy / distance;
    } else {
      touchX = 0;
      touchY = 0;
    }
  }

  function onPointerUp(event: Event, cancelled: boolean): void {
    const id = pointerIdOf(event);
    const wasDrag = dragActive && id === dragId;
    pointers.delete(id);

    if (pinchActive && pointers.size < 2) {
      pinchActive = false;
      touchX = 0;
      touchY = 0;
    }
    if (!wasDrag) return;

    if (enabled && !cancelled) {
      const point = clientPointOf(event);
      const dx = point.x - dragStartX;
      const dy = point.y - dragStartY;
      const distance = Math.hypot(dx, dy);
      const elapsed = now() - dragStartTime;
      if (distance < dragThreshold && elapsed < tapMaxMs) {
        pendingInteract = { source: 'pointer' };
      }
    }

    dragActive = false;
    touchX = 0;
    touchY = 0;
  }

  function onWheel(event: WheelEvent): void {
    if (!enabled) return;
    const deltaY = typeof event.deltaY === 'number' && Number.isFinite(event.deltaY) ? event.deltaY : 0;
    if (deltaY === 0) return;
    // A wheel scrolled down zooms out, matching the Phaser village.
    const step = deltaY > 0 ? -zoomStep : zoomStep;
    pendingDelta += step;
    zoom = clampLocal(zoom + step);
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onPointerUpCapture(event: Event): void {
    onPointerUp(event, false);
  }

  function onPointerCancelCapture(event: Event): void {
    onPointerUp(event, true);
  }

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUpCapture);
  element.addEventListener('pointercancel', onPointerCancelCapture);
  // `passive: false` because a zoom gesture that scrolls the page behind the
  // canvas is not a zoom gesture.
  element.addEventListener('wheel', onWheel as EventListener, { passive: false });

  if (win) {
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('blur', onBlur);
  }

  let destroyed = false;

  return {
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      if (!next) releaseGestures();
    },
    isEnabled(): boolean {
      return enabled;
    },
    getMoveVector(): WorldMoveVector {
      let x = 0;
      let y = 0;
      // One direction is one unit however many keys name it, so holding `W` and
      // `ArrowUp` together does not move at twice the speed.
      if (pressed.has('arrowleft') || pressed.has('a')) x -= 1;
      if (pressed.has('arrowright') || pressed.has('d')) x += 1;
      if (pressed.has('arrowup') || pressed.has('w')) y -= 1;
      if (pressed.has('arrowdown') || pressed.has('s')) y += 1;
      return { x: x + touchX, y: y + touchY };
    },
    consumeInteract(): WorldInputInteract | null {
      const queued = pendingInteract;
      pendingInteract = null;
      return queued;
    },
    consumeZoomDelta(): number {
      const delta = pendingDelta;
      pendingDelta = 0;
      return delta;
    },
    setZoom(next: number): void {
      zoom = clampLocal(next);
    },
    getZoom(): number {
      return zoom;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUpCapture);
      element.removeEventListener('pointercancel', onPointerCancelCapture);
      element.removeEventListener('wheel', onWheel as EventListener);
      if (win) {
        win.removeEventListener('keydown', onKeyDown);
        win.removeEventListener('keyup', onKeyUp);
        win.removeEventListener('blur', onBlur);
      }
      releaseGestures();
    },
  };
}
