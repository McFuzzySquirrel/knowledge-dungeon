/**
 * The village input controller, driven with synthetic events.
 *
 * `src/renderers/pixi/input/WorldInputController.ts` imports no renderer and binds
 * to a DOM element and a window directly, so every gesture the village supports -
 * arrows, WASD, a one-finger drag, a tap, a long press, a two-finger pinch, and a
 * wheel - is exercised here without a canvas, a GPU, or a browser. The clock is
 * injected, so a press duration is stated in data rather than in elapsed time.
 *
 * What this file deliberately does not prove: that a mounted PixiJS scene *acts* on
 * the readings. `village-scene.test.ts` drives the scene through this controller and
 * asserts the player moved and the interact reached the host; the two files are
 * separate, checkable claims ("the controller reads the gesture" and "the scene
 * consumes the reading").
 *
 * Hermeticity: no `dist/`, no network, no commit. The only DOM is a detached
 * `<div>` in jsdom, and every listener is released by `destroy`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorldInputController } from '../../src/renderers/pixi/input/WorldInputController';
import { DRAG_THRESHOLD, TAP_MAX_MS, WHEEL_ZOOM_STEP, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from '../../src/data/villageLayout';

/** The element and the mutable clock every case shares. */
function harness(): {
  readonly element: HTMLDivElement;
  readonly now: () => number;
  setNow: (value: number) => void;
} {
  const element = document.createElement('div');
  document.body.appendChild(element);
  let clock = 0;
  return {
    element,
    now: () => clock,
    setNow: (value: number) => {
      clock = value;
    },
  };
}

function keyDown(key: string, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function keyUp(key: string, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
}

interface PointerOptions {
  readonly id?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
}

/**
 * A pointer event with an id.
 *
 * jsdom has no `PointerEvent`, so a `MouseEvent` carries the coordinates and the
 * `pointerId` is defined on it directly. The controller reads these fields
 * structurally, which is what makes this a faithful delivery rather than a stub.
 */
function pointer(type: string, options: PointerOptions = {}): MouseEvent {
  const { id = 1, x = 0, y = 0, button = 0 } = options;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  });
  Object.defineProperty(event, 'pointerId', { value: id, configurable: true });
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('keyboard movement', () => {
  it('arrows and WASD produce the same unit vector', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      const pairs: ReadonlyArray<[string, string, { x: number; y: number }]> = [
        ['ArrowLeft', 'a', { x: -1, y: 0 }],
        ['ArrowRight', 'd', { x: 1, y: 0 }],
        ['ArrowUp', 'w', { x: 0, y: -1 }],
        ['ArrowDown', 's', { x: 0, y: 1 }],
      ];
      for (const [arrow, letter, expected] of pairs) {
        keyDown(arrow);
        expect(controller.getMoveVector(), arrow).toEqual(expected);
        keyUp(arrow);
        expect(controller.getMoveVector(), `${arrow} released`).toEqual({ x: 0, y: 0 });
        keyDown(letter);
        expect(controller.getMoveVector(), letter).toEqual(expected);
        keyUp(letter);
      }
    } finally {
      controller.destroy();
    }
  });

  it('one direction is one unit however many keys name it', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      keyDown('ArrowUp');
      keyDown('w');
      expect(controller.getMoveVector()).toEqual({ x: 0, y: -1 });
      keyUp('ArrowUp');
      expect(controller.getMoveVector()).toEqual({ x: 0, y: -1 });
    } finally {
      controller.destroy();
    }
  });

  it('a keystroke in a text control is left to the text control', () => {
    const { element, now } = harness();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const controller = createWorldInputController({ element, now });
    try {
      keyDown('w', input);
      expect(controller.getMoveVector(), 'typing w must not walk the player').toEqual({ x: 0, y: 0 });
      keyDown('e', input);
      expect(controller.consumeInteract()).toBeNull();
    } finally {
      controller.destroy();
    }
  });

  it('interact is E or Space, and Space is claimed so the page does not scroll', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      keyDown('e');
      expect(controller.consumeInteract()).toEqual({ source: 'keyboard' });
      expect(controller.consumeInteract()).toBeNull();
      const space = keyDown(' ');
      expect(space.defaultPrevented).toBe(true);
      expect(controller.consumeInteract()).toEqual({ source: 'keyboard' });
    } finally {
      controller.destroy();
    }
  });

  it('releases every held key on blur, so a lost keyup cannot walk forever', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      keyDown('d');
      expect(controller.getMoveVector()).toEqual({ x: 1, y: 0 });
      window.dispatchEvent(new Event('blur'));
      expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      controller.destroy();
    }
  });
});

/**
 * Phase 23: a focused control that natively consumes a movement key keeps it.
 *
 * The defect this pins: with a focused `input[type=range]` (the Settings volume
 * slider) over a mounted Pixi world, the old guard asked only "is the learner
 * typing?" - and a range is not text entry - so the world claimed ArrowRight,
 * called `preventDefault`, and walked the player while the slider never moved.
 * The durable rule is "does this focused element natively consume the movement
 * key?", and these cases state it at both ends: a range owns its arrows, a plain
 * button does not, and the same key proves the controller is live in the second
 * case.
 */
describe('a focused control that owns its keys keeps them', () => {
  it('a focused range slider takes ArrowRight and the player does not walk', () => {
    const { element, now } = harness();
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '50';
    document.body.appendChild(slider);

    const controller = createWorldInputController({ element, now });

    // jsdom does not implement a range's arrow default action, so the platform is
    // modelled here. The `defaultPrevented` guard is not a convenience: it is the
    // exact coupling under test. The browser steps the slider only because the
    // controller did *not* claim the key; if the controller calls
    // `preventDefault` (the pre-Phase-23 behaviour) the guard skips the step and
    // both assertions below go red. That makes this a non-vacuity test, not a
    // restatement of "the slider is a slider".
    const platformArrow = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === 'ArrowRight') slider.stepUp();
      else if (event.key === 'ArrowLeft') slider.stepDown();
    };
    // Registered *after* the controller, so it runs after the controller's window
    // listener in the same bubble phase and sees whatever the controller claimed.
    window.addEventListener('keydown', platformArrow);
    try {
      slider.focus();
      expect(document.activeElement, 'the slider must hold focus').toBe(slider);

      const right = keyDown('ArrowRight', slider);
      expect(right.defaultPrevented, 'the world must not claim a focused range key').toBe(false);
      expect(slider.value, 'the slider must take the key, not the player').toBe('51');
      expect(controller.getMoveVector(), 'the player must not walk').toEqual({ x: 0, y: 0 });

      // Non-vacuity: the same key still moves when it lands somewhere that does
      // not consume it, so the zero above is the range owning the key rather than
      // a controller that stopped listening.
      keyDown('ArrowRight', document.body);
      expect(controller.getMoveVector(), 'the controller is still live').toEqual({ x: 1, y: 0 });
    } finally {
      window.removeEventListener('keydown', platformArrow);
      controller.destroy();
    }
  });

  it('Home, End, PageUp and PageDown on a range are never claimed by the world', () => {
    const { element, now } = harness();
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '50';
    document.body.appendChild(slider);
    const controller = createWorldInputController({ element, now });
    try {
      slider.focus();
      for (const key of ['Home', 'End', 'PageUp', 'PageDown']) {
        const event = keyDown(key, slider);
        expect(event.defaultPrevented, `${key} belongs to the range`).toBe(false);
        expect(controller.getMoveVector(), `${key} must not move the player`).toEqual({ x: 0, y: 0 });
      }
    } finally {
      controller.destroy();
    }
  });

  it('movement still works while a non-consuming control has focus', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    const button = document.createElement('button');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(button, checkbox);
    try {
      // The Phase 21 contract: a button and a checkbox own Space and Enter, not
      // the arrows, so a learner may hold a direction while one has focus.
      for (const target of [button, checkbox, document.body] as const) {
        keyDown('ArrowRight', target);
        expect(controller.getMoveVector(), target.tagName).toEqual({ x: 1, y: 0 });
        keyUp('ArrowRight', target);
      }
    } finally {
      controller.destroy();
    }
  });

  it('a control that owns the arrows yields every movement key, including WASD', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    const slider = document.createElement('input');
    slider.type = 'range';
    const roleSlider = document.createElement('div');
    roleSlider.setAttribute('role', 'slider');
    roleSlider.tabIndex = 0;
    document.body.append(slider, roleSlider);
    try {
      // The rule is about element shape, not key-by-key bookkeeping: once a
      // control owns the arrows the world does not race it for the letters
      // either, because the learner is driving the control.
      for (const target of [slider, roleSlider] as const) {
        for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'd', 'w', 'a', 's']) {
          keyDown(key, target);
          expect(controller.getMoveVector(), `${target.tagName}/${key}`).toEqual({ x: 0, y: 0 });
          keyUp(key, target);
        }
      }
      // And the guard is not "anything focused": a plain div keeps no key.
      roleSlider.removeAttribute('role');
      roleSlider.tabIndex = 0;
      keyDown('ArrowRight', roleSlider);
      expect(controller.getMoveVector()).toEqual({ x: 1, y: 0 });
    } finally {
      controller.destroy();
    }
  });
});

describe('pointer and touch gestures', () => {
  it('a drag past the threshold produces a normalised movement vector', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      element.dispatchEvent(pointer('pointerdown', { x: 100, y: 100 }));
      // Below the threshold: no movement yet, and no interact either.
      element.dispatchEvent(pointer('pointermove', { x: 100, y: 100 + DRAG_THRESHOLD - 1 }));
      expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
      element.dispatchEvent(pointer('pointermove', { x: 100, y: 100 + DRAG_THRESHOLD + 1 }));
      const moved = controller.getMoveVector();
      expect(moved.y).toBeGreaterThan(0);
      expect(Math.hypot(moved.x, moved.y)).toBeCloseTo(1, 6);
    } finally {
      controller.destroy();
    }
  });

  it('a short, still press captures an interact', () => {
    const { element, now, setNow } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      setNow(1000);
      element.dispatchEvent(pointer('pointerdown', { x: 200, y: 200 }));
      setNow(1000 + TAP_MAX_MS - 1);
      element.dispatchEvent(pointer('pointerup', { x: 203, y: 204 }));
      expect(controller.consumeInteract()).toEqual({ source: 'pointer' });
      expect(controller.consumeInteract()).toBeNull();
    } finally {
      controller.destroy();
    }
  });

  it('a long press is not a tap', () => {
    const { element, now, setNow } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      setNow(0);
      element.dispatchEvent(pointer('pointerdown', { x: 200, y: 200 }));
      setNow(TAP_MAX_MS + 1);
      element.dispatchEvent(pointer('pointerup', { x: 200, y: 200 }));
      expect(controller.consumeInteract()).toBeNull();
    } finally {
      controller.destroy();
    }
  });

  it('a drag is not a tap, even if it is short', () => {
    const { element, now, setNow } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      setNow(0);
      element.dispatchEvent(pointer('pointerdown', { x: 0, y: 0 }));
      element.dispatchEvent(pointer('pointermove', { x: 200, y: 0 }));
      setNow(50);
      element.dispatchEvent(pointer('pointerup', { x: 200, y: 0 }));
      expect(controller.consumeInteract()).toBeNull();
    } finally {
      controller.destroy();
    }
  });

  it('a cancelled pointer queues nothing, because the browser took the gesture away', () => {
    const { element, now, setNow } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      setNow(0);
      element.dispatchEvent(pointer('pointerdown', { x: 10, y: 10 }));
      setNow(20);
      element.dispatchEvent(pointer('pointercancel', { x: 10, y: 10 }));
      expect(controller.consumeInteract()).toBeNull();
      expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      controller.destroy();
    }
  });
});

describe('zoom gestures', () => {
  it('a wheel notch zooms out for a downward scroll and in for an upward one', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      expect(WHEEL_ZOOM_STEP).toBe(0.1);
      const down = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      element.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      expect(controller.consumeZoomDelta()).toBeCloseTo(-WHEEL_ZOOM_STEP, 9);
      expect(controller.consumeZoomDelta()).toBe(0);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      expect(controller.consumeZoomDelta()).toBeCloseTo(WHEEL_ZOOM_STEP, 9);
    } finally {
      controller.destroy();
    }
  });

  it('a two-finger spread produces a positive zoom delta, relative to the reported zoom', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      element.dispatchEvent(pointer('pointerdown', { id: 1, x: 100, y: 100 }));
      element.dispatchEvent(pointer('pointerdown', { id: 2, x: 200, y: 100 }));
      // Distance grows from 100 to 140, so the zoom is multiplied by 1.4.
      element.dispatchEvent(pointer('pointermove', { id: 1, x: 80, y: 100 }));
      element.dispatchEvent(pointer('pointermove', { id: 2, x: 220, y: 100 }));
      expect(controller.consumeZoomDelta()).toBeCloseTo(ZOOM_DEFAULT * 0.4, 6);
      // A drag is not also captured while the pinch is live.
      expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      controller.destroy();
    }
  });

  it('a pinch past the ceiling saturates rather than running away', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      element.dispatchEvent(pointer('pointerdown', { id: 1, x: 100, y: 100 }));
      element.dispatchEvent(pointer('pointerdown', { id: 2, x: 200, y: 100 }));
      // Distance grows from 100 to 200, which at the default zoom is exactly the
      // ceiling; a far larger spread must not exceed it.
      element.dispatchEvent(pointer('pointermove', { id: 1, x: 0, y: 100 }));
      element.dispatchEvent(pointer('pointermove', { id: 2, x: 100000, y: 100 }));
      expect(controller.getZoom()).toBe(ZOOM_MAX);
      expect(controller.consumeZoomDelta()).toBeCloseTo(ZOOM_MAX - ZOOM_DEFAULT, 6);
    } finally {
      controller.destroy();
    }
  });

  it('setZoom clamps, and two pointers at one point start no pinch', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      element.dispatchEvent(pointer('pointerdown', { id: 1, x: 50, y: 50 }));
      element.dispatchEvent(pointer('pointerdown', { id: 2, x: 50, y: 50 }));
      expect(controller.consumeZoomDelta(), 'a zero start distance is not a pinch').toBe(0);
      controller.setZoom(ZOOM_MAX * 10);
      expect(controller.getZoom()).toBe(ZOOM_MAX);
      controller.setZoom(0);
      expect(controller.getZoom()).toBe(ZOOM_MIN);
    } finally {
      controller.destroy();
    }
  });
});

describe('enabling, disabling, and teardown', () => {
  it('setEnabled(false) releases every held key and suppresses new input', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    try {
      keyDown('d');
      expect(controller.getMoveVector()).toEqual({ x: 1, y: 0 });
      controller.setEnabled(false);
      expect(controller.isEnabled()).toBe(false);
      expect(controller.getMoveVector(), 'a held key is released on disable').toEqual({ x: 0, y: 0 });
      // New input is ignored while disabled.
      keyDown('a');
      expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
      element.dispatchEvent(pointer('pointerdown', { x: 0, y: 0 }));
      element.dispatchEvent(pointer('pointermove', { x: 100, y: 0 }));
      expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
      keyDown('e');
      expect(controller.consumeInteract()).toBeNull();
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      expect(controller.consumeZoomDelta()).toBe(0);
      // Re-enabling restores input.
      controller.setEnabled(true);
      keyDown('d');
      expect(controller.getMoveVector()).toEqual({ x: 1, y: 0 });
    } finally {
      controller.destroy();
    }
  });

  it('destroy removes every listener it added, and is safe twice', () => {
    const { element, now } = harness();
    const controller = createWorldInputController({ element, now });
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const elementRemove = vi.spyOn(element, 'removeEventListener');
    controller.destroy();
    for (const type of ['keydown', 'keyup', 'blur']) {
      expect(windowRemove, type).toHaveBeenCalledWith(type, expect.any(Function));
    }
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
      expect(elementRemove, type).toHaveBeenCalledWith(type, expect.any(Function));
    }
    // Second call is a no-op, not a second teardown.
    expect(() => controller.destroy()).not.toThrow();
    // And the listeners really are gone: a keypress after destroy moves nothing.
    keyDown('d');
    expect(controller.getMoveVector()).toEqual({ x: 0, y: 0 });
  });
});
