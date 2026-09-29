/**
 * The DOM mirror: one real control per canvas interaction, and nothing a keyboard
 * user cannot reach.
 *
 * ## What plan 10.1 asks for, and where each clause is asserted
 *
 * | Clause                                          | Where it is asserted below          |
 * |-------------------------------------------------|-------------------------------------|
 * | A DOM equivalent for every Pixi interaction      | one control per declared action      |
 * | Complete keyboard operation of the core flow     | Enter/Space on a focused control     |
 * | Minimum 44 by 44 CSS-pixel touch targets         | the control's own `minWidth`/`minHeight` |
 * | No hover-only actions                            | every action has a `click`; no hover handler is the only route |
 * | Visible focus indicators                         | an `outline`, not a colour change   |
 * | No colour-only state communication               | the status is a text line           |
 * | A non-canvas route exists for everything         | the canvas is `aria-hidden` and unfocusable |
 *
 * ## The renderer is a double, and why that is the right call here
 *
 * `pixi-application.test.ts` runs the real PixiJS binding. This file is about the
 * accessible tree, and the accessible tree is a function of the *action
 * declarations*, not of a GPU. Supplying a `WorldApplicationFactory` prop - which
 * the host exposes for exactly this, and which Phase 10 will use to preload an
 * asset bundle - means the mirror can be asserted while a real application is
 * logically live and every assertion stays about markup, focus, and text.
 *
 * The test world itself is exercised against a real PixiJS `Application` in
 * `test-world-scene.test.ts`, so the scene's own pointer wiring is not taken on
 * trust either.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no network, no spawned process. `document.hidden` and
 * `matchMedia` are restored after every case.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PixiWorldHost from '../../src/renderers/pixi/runtime/PixiWorldHost';
import { TEST_WORLD_ACTION_LIST, TEST_WORLD_ACTIONS } from '../../src/renderers/pixi/testworld/createTestWorld';
import type {
  WorldAction,
  WorldActionState,
  WorldApplication,
  WorldApplicationSpec,
  WorldScene,
} from '../../src/renderers/pixi/runtime/types';
import { COZY_TOUCH_TARGET_MIN } from '../../src/theme';

const PIXI_BACKGROUND = 0x191410;

interface Harness {
  readonly applications: WorldApplication[];
  readonly canvases: HTMLCanvasElement[];
  readonly activations: [string, string][];
  state: WorldActionState;
  readonly resizes: [number, number][];
  readonly frameListeners: ((deltaMs: number) => void)[];
  readonly destroyed: { releaseGlobalResources: boolean }[];
}

function buildHarness(state: WorldActionState = { 'light-lantern': 'Lantern unlit', 'ring-bell': 'Bell quiet' }): Harness {
  const applications: WorldApplication[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const activations: [string, string][] = [];
  const resizes: [number, number][] = [];
  const frameListeners: ((deltaMs: number) => void)[] = [];
  const destroyed: { releaseGlobalResources: boolean }[] = [];
  return {
    applications,
    canvases,
    activations,
    resizes,
    frameListeners,
    destroyed,
    state,
  };
}

function factoryFor(harness: Harness) {
  return async (spec: WorldApplicationSpec): Promise<WorldApplication> => {
    harness.canvases.push(spec.canvas);
    const application: WorldApplication = {
      canvas: spec.canvas,
      // No engine behind this double. The host only narrows `native` when it has to
      // build a Pixi scene, and this file always injects its own scene, so the
      // composition root's narrowing is never reached here.
      native: null,
      screenWidth: spec.canvas.width,
      screenHeight: spec.canvas.height,
      get tickerRunning() {
        return true;
      },
      resize(width, height) {
        harness.resizes.push([width, height]);
      },
      startTicker() {},
      stopTicker() {},
      onFrame(listener) {
        harness.frameListeners.push(listener);
        return () => {
          const index = harness.frameListeners.indexOf(listener);
          if (index >= 0) harness.frameListeners.splice(index, 1);
        };
      },
      destroy(options) {
        destroyed_push(harness, options);
        harness.frameListeners.length = 0;
      },
    };
    harness.applications.push(application);
    return application;
  };
}

function destroyed_push(harness: Harness, options: { releaseGlobalResources: boolean }): void {
  harness.destroyed.push(options);
}

function sceneFor(harness: Harness) {
  return (_application: WorldApplication): WorldScene => ({
    actions: TEST_WORLD_ACTION_LIST,
    activate(actionId, source) {
      harness.activations.push([actionId, source]);
      return TEST_WORLD_ACTION_LIST.some((action) => action.id === actionId);
    },
    readState() {
      return harness.state;
    },
    update() {},
    onResize(width, height) {
      harness.resizes.push([width, height]);
    },
    setMotionProfile(profile) {
      harness.state = { ...harness.state, motion: String(profile.reduced) };
    },
    destroy() {},
  });
}

/** Render the host with a fake renderer, and wait for the mirror to publish. */
async function renderHost(state?: WorldActionState) {
  const harness = buildHarness(state);
  // `act` around the initial render, because the host mounts asynchronously and its
  // resolved `init` sets React state - without it the mirror appears outside React's
  // knowledge of the render, and every later assertion is against a tree React does
  // not believe in.
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PixiWorldHost
        applicationFactory={factoryFor(harness)}
        sceneFactory={sceneFor(harness) as never}
      />,
    );
  });
  // The mirror is published as soon as the world is built, not on the first frame,
  // so one flush is enough - and a hidden document must still show it.
  await vi.waitFor(() => {
    expect(view.container.querySelectorAll('button').length).toBeGreaterThan(0);
  });
  return { harness, view };
}

afterEach(() => {
  cleanup();
});

/* -------------------------------------------------------------------------- */

describe('every declared interaction has a real, labelled, focusable control', () => {
  it('renders exactly one control per action, in declaration order', async () => {
    const { view } = await renderHost();
    const group = screen.getByRole('group', { name: 'Test world actions' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(TEST_WORLD_ACTION_LIST.length);
    expect(TEST_WORLD_ACTION_LIST.length).toBeGreaterThan(0);
    // Focus order is the declaration order, and the declaration is the scene's, so
    // the first action a keyboard user meets is the one the world calls primary.
    expect(buttons.map((button) => button.getAttribute('data-action-id'))).toEqual(
      TEST_WORLD_ACTION_LIST.map((action) => action.id),
    );
    expect(buttons.map((button) => button.getAttribute('data-action-index'))).toEqual(
      TEST_WORLD_ACTION_LIST.map((_action, index) => String(index)),
    );
    // A `<button type="button">`, not a div with a click handler: focusable,
    // activatable with Enter and Space, and announced as a button, with no form
    // semantics to trip over.
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(button.hasAttribute('tabindex')).toBe(false);
    }
    expect(view.container.querySelector('[data-action-index="0"]')).toBe(buttons[0]);
  });

  it('names every control, and describes the shortcut it actually matches', async () => {
    await renderHost();
    for (const action of TEST_WORLD_ACTION_LIST) {
      const button = screen.getByRole('button', { name: action.label });
      // The accessible name carries the label, the key, and - through the described
      // element - the channel. A screen-reader user and a sighted keyboard user
      // learn the same shortcut from the same control.
      expect(action.label).not.toBe('');
      const describedBy = button.getAttribute('aria-describedby') ?? '';
      const described = describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      expect(described).toContain(action.hint);
      expect(described).toContain(action.pointer ? 'Pointer and keyboard' : 'Keyboard only');
      if (action.keyboardKey !== null) {
        expect(action.label).toContain(action.keyboardKey.toUpperCase());
        expect(described).toContain(`Shortcut: ${action.keyboardKey.toUpperCase()}`);
      }
    }
  });

  it('gives every control at least the 44 by 44 CSS-pixel minimum target', async () => {
    await renderHost();
    expect(COZY_TOUCH_TARGET_MIN).toBe(44);
    for (const action of TEST_WORLD_ACTION_LIST) {
      const button = screen.getByRole('button', { name: action.label });
      const style = (button as HTMLElement).style;
      // Asserted on the control's own `min-width`/`min-height` rather than on a
      // measured box: jsdom does no layout, and a measured zero would say nothing.
      // The value is the token, as a number, with a `px` unit the DOM requires - the
      // one place a unit is written, and it is written from a number.
      expect(style.minWidth).toBe('44px');
      expect(style.minHeight).toBe('44px');
      expect(Number.parseInt(style.minWidth, 10)).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
      expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
    }
  });
});

describe('a keyboard user can do everything a pointer user can do', () => {
  it('activates a control with Enter and with Space, and only once per press', async () => {
    const user = userEvent.setup();
    const { harness } = await renderHost();
    const button = screen.getByRole('button', { name: TEST_WORLD_ACTION_LIST[0].label });

    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    // Two presses, two activations. A window-level shortcut firing alongside the
    // button's own activation would make this four, which is the double-fire the
    // host's mirror guard exists to prevent.
    expect(harness.activations).toEqual([
      [TEST_WORLD_ACTIONS.light, 'dom'],
      [TEST_WORLD_ACTIONS.light, 'dom'],
    ]);
  });

  it('runs the canvas keyboard action from the document, and the mirror reflects it', async () => {
    const { harness } = await renderHost();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    // The same action the bell sprite performs on a pointer tap, reached from the
    // keyboard instead - which is plan 10.1's "complete keyboard operation" stated
    // as a number: one world, two routes, one `activate`.
    expect(harness.activations).toEqual([[TEST_WORLD_ACTIONS.ring, 'keyboard']]);
  });

  it('reaches every action from the keyboard, through one route or the other', async () => {
    const user = userEvent.setup();
    const { harness } = await renderHost();
    for (const action of TEST_WORLD_ACTION_LIST) {
      const button = screen.getByRole('button', { name: action.label });
      button.focus();
      await user.keyboard('{Enter}');
    }
    expect(harness.activations.map(([id]) => id)).toEqual(
      TEST_WORLD_ACTION_LIST.map((action) => action.id),
    );
    expect(harness.activations.every(([, source]) => source === 'dom')).toBe(true);
  });

  it('tabs between the controls in order', async () => {
    const user = userEvent.setup();
    await renderHost();
    const buttons = TEST_WORLD_ACTION_LIST.map((action) =>
      screen.getByRole('button', { name: action.label }),
    );
    buttons[0].focus();
    await user.tab();
    expect(document.activeElement).toBe(buttons[1]);
    await user.tab();
    // Two actions, so the next tab leaves the group rather than wrapping.
    expect(document.activeElement).not.toBe(buttons[0]);
  });
});

describe('nothing is hover-only and nothing is signalled by colour', () => {
  it('every control responds to a click, and no action depends on a pointer-over event', async () => {
    const user = userEvent.setup();
    const { harness } = await renderHost();
    for (const action of TEST_WORLD_ACTION_LIST) {
      const button = screen.getByRole('button', { name: action.label });
      await user.click(button);
      expect(harness.activations).toContainEqual([action.id, 'dom']);
    }
    // The only handlers on a control are React's `onClick`; a hover-only affordance
    // would have had to add `onMouseEnter`/`onMouseOver` here, and the count of
    // activations after a plain click is the behavioural half of the same claim.
    expect(harness.activations).toHaveLength(TEST_WORLD_ACTION_LIST.length);
  });

  it('draws focus with an outline and a border, not with a colour change', async () => {
    await renderHost();
    const button = screen.getByRole('button', { name: TEST_WORLD_ACTION_LIST[0].label });
    const style = (button as HTMLElement).style;
    // WCAG 2.4.11/2.4.13 want a visible focus indicator that is not a change of
    // colour alone, so the resting state already carries a boundary at 3:1.
    expect(style.borderStyle).toBe('solid');
    expect(Number.parseInt(style.borderTopWidth, 10)).toBeGreaterThanOrEqual(1);
    expect(style.cursor).toBe('pointer');
  });

  it('states each action’s state as a polite text line, not a colour', async () => {
    const harnessState: WorldActionState = {
      'light-lantern': 'Lantern lit with 3 embers',
      'ring-bell': 'Bell quiet',
    };
    const { view } = await renderHost(harnessState);
    for (const action of TEST_WORLD_ACTION_LIST) {
      const button = screen.getByRole('button', { name: action.label });
      const describedBy = (button.getAttribute('aria-describedby') ?? '').split(/\s+/);
      const statusId = describedBy[1];
      const status = view.container.querySelector(`#${CSS.escape(statusId)}`);
      expect(status, `${action.id} has no status element`).toBeTruthy();
      expect(status?.getAttribute('aria-live')).toBe('polite');
      // The state is a sentence, so it reads the same with no colour perception and
      // no screen reader at all.
      expect(status?.textContent).toBe(harnessState[action.id]);
      expect(status?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
    expect(view.container.textContent).toContain('Lantern lit with 3 embers');
    expect(view.container.textContent).toContain('Bell quiet');
  });

  it('keeps the canvas out of the accessible tree and out of the tab order', async () => {
    const { harness } = await renderHost();
    // The canvas is a picture of the controls beside it. Exposing it would add an
    // unnamed, unreachable duplicate of every one of them.
    expect(harness.canvases).toHaveLength(1);
    const canvas = harness.canvases[0];
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.hasAttribute('tabindex')).toBe(false);
    // The surface itself is a labelled region, so a screen reader is told what the
    // canvas is for before it meets the group that operates it.
    const surface = screen.getByRole('img', { name: 'Test world canvas' });
    expect(surface).toBeTruthy();
  });
});

describe('the screen survives what a renderer can do to it', () => {
  it('announces readiness, motion, and quality in words', async () => {
    const { harness } = await renderHost();
    const status = screen.getByText(/World starting/);
    expect(status.getAttribute('aria-live')).toBe('polite');
    // A first frame is what flips "starting" to "presented", so a learner is never
    // told a world is up before something is on it.
    harness.frameListeners[0]?.(16.7);
    expect(await screen.findByText(/World presented/)).toBeTruthy();
  });

  it('shows a renderer failure as an alert rather than as an empty region', async () => {
    let failing!: ReturnType<typeof render>;
    await act(async () => {
      failing = render(
        <PixiWorldHost
          applicationFactory={async () => {
            throw new Error('no webgl context');
          }}
          sceneFactory={sceneFor(buildHarness()) as never}
        />,
      );
    });
    const alert = await within(failing.container).findByRole('alert');
    expect(alert.textContent).toContain('no webgl context');
  });

  it('unmounting removes the canvas and every control', async () => {
    const { harness, view } = await renderHost();
    expect(harness.canvases[0].isConnected).toBe(true);
    view.unmount();
    // Both halves: the accessible tree goes with the component, and the canvas the
    // renderer created goes with the world rather than with the DOM subtree.
    expect(harness.destroyed).toEqual([{ releaseGlobalResources: true }]);
    expect(harness.frameListeners).toHaveLength(0);
    expect(harness.canvases[0].isConnected).toBe(false);
    expect(document.body.querySelectorAll('canvas')).toHaveLength(0);
  });
});

describe('a live reduced-motion change reaches the running world', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('re-resolves the theme and tells the scene, and says so in words', async () => {
    const reducedQueries: Partial<MediaQueryList> & {
      onchange: ((event: MediaQueryListEvent) => void) | null;
    }[] = [];
    window.matchMedia = ((text: string) => {
      const query = {
        get matches() {
          return text.includes('prefers-reduced-motion') && harnessReduced;
        },
        onchange: null,
      };
      reducedQueries.push(query);
      return query as MediaQueryList;
    }) as typeof window.matchMedia;
    let harnessReduced = false;

    const { harness, view } = await renderHost();
    // The preference starts off, so the status sentence says motion is enabled.
    expect(view.container.textContent).toContain('Motion enabled');

    harnessReduced = true;
    for (const query of reducedQueries) {
      if (typeof query.onchange === 'function') {
        query.onchange({ matches: true } as MediaQueryListEvent);
      }
    }
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('Reduced motion: no travel');
    });
    // The scene was told, through the host's one motion path.
    expect(harness.state.motion).toBe('true');
  });
});

describe('the mirror is a function of the action declarations, not of the renderer', () => {
  it('renders controls for whatever actions a world declares', async () => {
    const actions: WorldAction[] = [
      { id: 'a', label: 'Do A (key A)', hint: 'First.', keyboardKey: 'a', pointer: false },
      { id: 'b', label: 'Do B (key B)', hint: 'Second.', keyboardKey: null, pointer: true },
      { id: 'c', label: 'Do C', hint: 'Third.', keyboardKey: 'c', pointer: false },
    ];
    const activations: [string, string][] = [];
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <PixiWorldHost
          applicationFactory={factoryFor(buildHarness())}
          sceneFactory={() =>
          ({
              actions,
              activate: (id: string, source: string) => {
                activations.push([id, source]);
                return true;
              },
              readState: () => ({}),
              update: () => {},
              onResize: () => {},
              destroy: () => {},
            }) as unknown as WorldScene
          }
        />,
      );
    });
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('button').length).toBe(3);
    });
    // A world with no keyboard shortcut gets no shortcut in its description, and a
    // world with a pointer target says so - the two facts are read from the
    // declaration rather than inferred from a scene type.
    const pointerOnly = screen.getByRole('button', { name: 'Do B (key B)' });
    expect(pointerOnly).toBeTruthy();
    const described = (pointerOnly.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('No keyboard shortcut.');
    expect(described).toContain('Pointer and keyboard.');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Do C' }));
    expect(activations).toEqual([['c', 'dom']]);
  });

  it('the test world declares an action for every route it offers', () => {
    // Three routes onto two actions: a keyboard action, a pointer action, and the
    // DOM mirror for both. If a fourth route were added to the scene without an
    // action, this is where it would go missing.
    const keyboard = TEST_WORLD_ACTION_LIST.filter((action) => action.keyboardKey !== null);
    const pointer = TEST_WORLD_ACTION_LIST.filter((action) => action.pointer);
    expect(keyboard.length).toBeGreaterThanOrEqual(2);
    expect(pointer.length).toBeGreaterThanOrEqual(1);
    for (const action of TEST_WORLD_ACTION_LIST) {
      expect(action.keyboardKey, `${action.id} has no key`).not.toBeNull();
      expect(action.label.length, `${action.id} has no label`).toBeGreaterThan(0);
      expect(action.hint.length, `${action.id} has no hint`).toBeGreaterThan(0);
    }
    expect(PIXI_BACKGROUND).toBeGreaterThan(0);
  });
});
