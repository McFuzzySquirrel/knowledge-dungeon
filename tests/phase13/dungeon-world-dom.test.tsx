/**
 * The dungeon DOM mirror, end to end: the real scene's sentences in the real accessible tree.
 *
 * ## Why this file no longer mocks the renderer
 *
 * It did, and that is what let the defect QA found survive: with `createPixiDungeonRenderer`
 * replaced by a double, the component's only subscription was `onReady`, the doubles in
 * this file had no `onState`, and every assertion still passed. The port member that
 * carries "there are no stairs up in this room" was simply absent from both the
 * component and its test.
 *
 * So nothing in the renderer tree is mocked here. `DungeonWorld` builds a real
 * `createPixiDungeonRenderer`, which builds a real `createPixiWorldHost`, which builds a
 * real `createDungeonScene` on a real `pixi.js` `Application`. The only browser facilities
 * stubbed are the two jsdom lacks - the Canvas2D context PixiJS's text metrics read, and a
 * `ResizeObserver` whose absence makes PixiJS 8.21 leak a `Ticker.shared` listener per
 * application (`tests/phase9/support/canvasContextStub.ts`). Neither is the thing under
 * test, and neither can invent a status sentence.
 *
 * ## What that buys
 *
 * Every assertion below is about a value that reached the accessible tree from the scene:
 * the status text is `scene.readState()`, delivered through `PixiDungeonRenderer.onState`.
 * A rename of a sentence, a lost subscription, or a control that stops consulting the
 * published state all turn this file red.
 *
 * Hermeticity: synthetic subject only, no `dist/`, no network, no clock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DungeonWorldHandle } from '../../src/renderers/pixi/dungeon/DungeonWorld';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonMap } from '@/core/layout/dungeonTypes';
import type { DungeonMetadata } from '@/core/validation/persistence';
import type { FloorVisibilityModel } from '@/application/contracts/world';
import {
  DUNGEON_ACTION_UNAVAILABLE_PREFIX,
  DUNGEON_ACTIONS,
  DUNGEON_INTERACT_ACTION_ID,
  describeDungeonActionSentence,
  isDungeonActionUnavailable,
} from '../../src/renderers/pixi/dungeon/createDungeonScene';
import type { DungeonSceneCallbacks } from '../../src/renderers/pixi/dungeon/DungeonRenderer';
import {
  createPixiDungeonRenderer,
  type PixiDungeonRenderer,
} from '../../src/renderers/pixi/dungeon/DungeonRenderer';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

// The component is imported after the stubs are installed in `beforeAll`; a static import
// is fine because PixiJS only touches a canvas when an `Application` is initialised.
import DungeonWorld from '../../src/renderers/pixi/dungeon/DungeonWorld';

const NOW = '2026-01-01T00:00:00.000Z';

let stub: StubbedContext;
let observer: StubbedResizeObserver;
let restoreCanvasContext2D: () => void;

/**
 * Install the `CanvasRenderingContext2D` *constructor*, which jsdom also lacks.
 *
 * PixiJS 8's text measurement reads `CanvasRenderingContext2D.prototype.letterSpacing` to
 * decide whether a feature is supported, and the Phase 9 stub only supplies `getContext` -
 * a method value, not the global class. So a room label that word-wraps (which every
 * `RoomNode` does) makes PixiJS read a global that is `undefined` in this realm, and the
 * read happens asynchronously after the test that created the label has finished. The
 * result is an *unhandled* exception attributed to whichever test was last running.
 *
 * An empty class is the correct value, not a stub of the real thing: PixiJS is asking
 * whether the prototype carries `letterSpacing`, and in this realm it does not, so
 * "unsupported" is the true answer. It has no bearing on production - a browser has the
 * real constructor.
 */
function installCanvasContext2DGlobal(): () => void {
  const scope = globalThis as { CanvasRenderingContext2D?: unknown };
  const previous = scope.CanvasRenderingContext2D;
  scope.CanvasRenderingContext2D = class CanvasRenderingContext2DStub {};
  return () => {
    if (previous === undefined) delete scope.CanvasRenderingContext2D;
    else scope.CanvasRenderingContext2D = previous;
  };
}

beforeAll(() => {
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
  restoreCanvasContext2D = installCanvasContext2DGlobal();
});

afterAll(() => {
  restoreCanvasContext2D();
  observer.restore();
  stub.restore();
});

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

interface WorldFixture {
  readonly map: DungeonMap;
  readonly floor: FloorVisibilityModel;
}

function buildWorld(childCount: number, metadata?: DungeonMetadata): WorldFixture {
  const root = createRootDungeon({
    dungeonId: 'synthetic-subject',
    subjectName: 'Synthetic Subject',
    rootRoomId: 'root',
    rootTopic: 'Root Topic',
    nowIso: NOW,
  });
  if (!root.ok) throw new Error('root dungeon init failed');
  const grown = addLinkedRooms(root.value, {
    fromRoomId: 'root',
    drafts: Array.from({ length: childCount }, (_unused, index) => ({
      roomId: `child-${index}`,
      topic: `Child Topic ${index}`,
    })),
    nowIso: NOW,
  });
  if (!grown.ok) throw new Error('addLinkedRooms failed');
  const graph = metadata ?? grown.value.dungeon;
  const visibility = computeFloorVisibility(deriveGraphHierarchy(graph), graph, 'root');
  return {
    map: generateDungeonMap(graph),
    floor: {
      floorId: visibility.floorId,
      visibleRoomIds: [...visibility.visibleRoomIds],
      portalUpRoomId: visibility.portalUpRoomId,
      portalDownRoomIds: [...visibility.portalDownRoomIds],
    },
  };
}

/** A nested subject, so the root floor genuinely hides a room. */
function buildNestedWorld(): WorldFixture & { metadata: DungeonMetadata } {
  const root = createRootDungeon({
    dungeonId: 'synthetic-subject',
    subjectName: 'Synthetic Subject',
    rootRoomId: 'root',
    rootTopic: 'Root Topic',
    nowIso: NOW,
  });
  if (!root.ok) throw new Error('root dungeon init failed');
  const withChild = addLinkedRooms(root.value, {
    fromRoomId: 'root',
    drafts: [{ roomId: 'child-a', topic: 'Child A' }],
    nowIso: NOW,
  });
  if (!withChild.ok) throw new Error('addLinkedRooms failed');
  const withGrandchild = addLinkedRooms(withChild.value.dungeon, {
    fromRoomId: 'child-a',
    drafts: [{ roomId: 'grandchild-0', topic: 'Grandchild 0' }],
    nowIso: NOW,
  });
  if (!withGrandchild.ok) throw new Error('addLinkedRooms failed');
  const metadata = withGrandchild.value.dungeon;
  return { ...buildWorld(0, metadata), metadata };
}

function dungeonCallbacks(): DungeonSceneCallbacks {
  return {
    onRoomEntered: vi.fn(),
    onInteract: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onNpcOutOfRange: vi.fn(),
    onArtifactCollected: vi.fn(),
    onFloorTransition: vi.fn(),
  };
}

beforeEach(() => {
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

afterEach(async () => {
  // Unmount inside `act` and drain the microtask queue before the stubs are observed
  // again: destroying a PixiJS `Application` can schedule a final text measurement, and
  // leaving that to land in the next test would make this file's failures depend on the
  // order the tests happen to run in.
  await act(async () => {
    cleanup();
  });
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */

interface Mounted {
  readonly handle: DungeonWorldHandle;
  readonly unmount: () => void;
}

/** Mount the surface and wait until the scene has published its first status. */
async function mountWorld(
  world: WorldFixture,
  options: { onNavigateToRoom?: (roomId: string) => void } = {},
): Promise<Mounted> {
  const ref = { current: null as DungeonWorldHandle | null };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <DungeonWorld
        ref={ref}
        world={{ kind: 'dungeon', map: world.map, floor: world.floor, playerClass: null }}
        callbacks={dungeonCallbacks()}
        onNavigateToRoom={options.onNavigateToRoom}
      />,
    );
  });
  await waitFor(() => {
    expect(screen.getByText(/In Root Topic/)).toBeTruthy();
  });
  const handle = ref.current;
  if (handle === null) throw new Error('the surface never published a handle');
  return { handle, unmount: view.unmount };
}

/** The status sentence the DOM shows for one action. */
function statusTextOf(actionId: string): string {
  const element = document.querySelector(`[data-action-status="${actionId}"]`);
  return element?.textContent ?? '';
}

/** The control for one action. */
function controlOf(actionId: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-action-id="${actionId}"]`);
  if (element === null) throw new Error(`no control for ${actionId}`);
  return element;
}

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the status a learner hears is the status the scene publishes', () => {
  it('reaches the accessible tree, and is described by each control', async () => {
    await mountWorld(buildWorld(3));

    // Interact's sentence comes from the real scene's `readState()` and is on the page.
    expect(statusTextOf(DUNGEON_INTERACT_ACTION_ID)).toBe('In Root Topic. Not cleared yet.');

    // Each control points at its hint and at its own status line, and both exist.
    for (const action of DUNGEON_ACTIONS) {
      const control = controlOf(action.id);
      const describedBy = (control.getAttribute('aria-describedby') ?? '').split(/\s+/);
      expect(describedBy.length, action.id).toBe(2);
      for (const id of describedBy) {
        expect(document.getElementById(id), `${action.id} -> ${id}`).not.toBeNull();
      }
      // The hint element carries the action's declared hint.
      const hintText = describedBy
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      expect(hintText, action.id).toContain(action.hint);
    }
  });

  it('reaches the accessible tree as an `aria-live` region, not only as text on the page', async () => {
    await mountWorld(buildWorld(3));
    const liveRegions = [...document.querySelectorAll('[data-action-status]')].filter(
      (element) => element.getAttribute('aria-live') === 'polite',
    );
    // One polite region per declared action.
    expect(liveRegions).toHaveLength(DUNGEON_ACTIONS.length);
  });
});

describe('a refused action is disabled and says why, on the page', () => {
  it('the root room has no stairs up, so Ascend is disabled with its reason beside it', async () => {
    await mountWorld(buildWorld(3));

    const ascend = controlOf('dungeon-ascend');
    // Not focusable-but-inert: the `disabled` attribute is set.
    expect(ascend.disabled).toBe(true);
    expect(ascend.hasAttribute('disabled')).toBe(true);
    // And the reason is on the page, not only in an attribute a disabled control cannot
    // have announced.
    expect(statusTextOf('dungeon-ascend')).toBe('there are no stairs up in this room');
    // The status span is visible: `visuallyHidden` is not applied to it.
    const status = document.querySelector('[data-action-status="dungeon-ascend"]');
    expect(status?.getAttribute('style') ?? '').not.toContain('clip');
  });

  it('clicking a disabled control does nothing at all, and announces nothing falsely', async () => {
    const callbacks = dungeonCallbacks();
    let ref: DungeonWorldHandle | null = null;
    await act(async () => {
      render(
        <DungeonWorld
          ref={(handle) => {
            ref = handle;
          }}
          world={{
            kind: 'dungeon',
            ...buildWorld(3),
            playerClass: null,
          }}
          callbacks={callbacks}
        />,
      );
    });
    await waitFor(() => {
      expect(statusTextOf('dungeon-ascend')).toBe('there are no stairs up in this room');
    });

    // A disabled button does not receive focus, so a keyboard user cannot even land on it.
    const ascend = controlOf('dungeon-ascend');
    ascend.focus();
    expect(document.activeElement).not.toBe(ascend);

    await userEvent.click(ascend, { pointerEventsCheck: 0 });

    expect(callbacks.onFloorTransition).not.toHaveBeenCalled();
    expect(callbacks.onInteract).not.toHaveBeenCalled();
    // The sentence still says the truth afterwards: a refused press did not change it.
    expect(statusTextOf('dungeon-ascend')).toBe('there are no stairs up in this room');
    expect(ref).not.toBeNull();
  });

  it('standing in a portal room enables that portal and disables the other', async () => {
    const mounted = await mountWorld(buildWorld(3));

    expect(controlOf('dungeon-descend').disabled).toBe(true);
    expect(statusTextOf('dungeon-descend')).toBe('there are no stairs down in this room');

    // The **capability** route, deliberately: this is the D2 half, where `GameScreen`
    // pushes `teleportToRoom` and the renderer republishes through `refreshState()`.
    //
    // It is kept because it is a real route a screen uses - but it is no longer the whole
    // story, and it must not be read as one. A capability republishes by construction; a
    // learner **walking** into the room does not, because walking is not a dispatch and
    // not a capability call. That gap was the N1 defect, and it is covered separately in
    // `walking updates the controls, because walking publishes` below, where the player
    // reaches the portal room on held keys and the real ticker.
    await act(async () => {
      mounted.handle.teleportToRoom('child-0');
    });

    await waitFor(() => {
      expect(statusTextOf('dungeon-descend')).toBe('Descend from Child Topic 0');
    });
    expect(controlOf('dungeon-descend').disabled).toBe(false);
    // Ascend is still refused here, and still says so.
    expect(controlOf('dungeon-ascend').disabled).toBe(true);
    expect(statusTextOf('dungeon-ascend')).toBe('there are no stairs up in this room');
  });

  it('a room-state change republishes the cleared sentence to the page', async () => {
    const mounted = await mountWorld(buildWorld(2));
    expect(statusTextOf(DUNGEON_INTERACT_ACTION_ID)).toBe('In Root Topic. Not cleared yet.');

    await act(async () => {
      mounted.handle.setRoomOverlayStates({ root: 'EncounterDefeated' });
    });

    await waitFor(() => {
      expect(statusTextOf(DUNGEON_INTERACT_ACTION_ID)).toBe('In Root Topic. Encounter cleared.');
    });
  });
});

describe('an accepted action reaches the world through the DOM', () => {
  it('Descend, once enabled, emits a floor transition from the real scene', async () => {
    const callbacks = dungeonCallbacks();
    const world = buildWorld(3);
    let ref: DungeonWorldHandle | null = null;
    await act(async () => {
      render(
        <DungeonWorld
          ref={(handle) => {
            ref = handle;
          }}
          world={{ kind: 'dungeon', ...world, playerClass: null }}
          callbacks={callbacks}
        />,
      );
    });
    await waitFor(() => {
      expect(statusTextOf('dungeon-descend')).toBe('there are no stairs down in this room');
    });

    await act(async () => {
      (ref as DungeonWorldHandle | null)?.teleportToRoom('child-0');
    });
    await waitFor(() => {
      expect(controlOf('dungeon-descend').disabled).toBe(false);
    });

    await userEvent.click(controlOf('dungeon-descend'));

    expect(callbacks.onFloorTransition).toHaveBeenCalledWith({
      fromRoomId: 'child-0',
      direction: 'down',
    });
  });

  it('Interact reaches the room verb through the capability port', async () => {
    const callbacks = dungeonCallbacks();
    await act(async () => {
      render(
        <DungeonWorld
          world={{ kind: 'dungeon', ...buildWorld(3), playerClass: null }}
          callbacks={callbacks}
        />,
      );
    });
    await waitFor(() => {
      expect(statusTextOf(DUNGEON_INTERACT_ACTION_ID)).toBe('In Root Topic. Not cleared yet.');
    });

    await userEvent.click(controlOf(DUNGEON_INTERACT_ACTION_ID));

    // The root room has no stairs, so the interact verb reaches the room itself.
    expect(callbacks.onInteract).toHaveBeenCalledWith('root');
    expect(callbacks.onFloorTransition).not.toHaveBeenCalled();
  });

  it('every declared action has exactly one control, and no control lacks a declaration', async () => {
    await mountWorld(buildWorld(2));
    const controlIds = [...document.querySelectorAll('[data-action-id]')].map((element) =>
      element.getAttribute('data-action-id'),
    );
    expect(controlIds.sort()).toEqual(DUNGEON_ACTIONS.map((action) => action.id).sort());
    // D6: this replaces a test that compared `DUNGEON_ACTIONS`' own members to themselves.
    // The mapping is now read from the DOM, so a control rendered for an id the scene does
    // not declare - or an action with no control - fails here.
    expect(controlIds).toHaveLength(new Set(controlIds).size);
    for (const action of DUNGEON_ACTIONS) {
      expect(controlOf(action.id).getAttribute('aria-label')).toBe(action.label);
    }
  });
});

describe('the availability marker is one channel, not two', () => {
  it('is a prefix the DOM strips, and the tests pin both halves', () => {
    expect(DUNGEON_ACTION_UNAVAILABLE_PREFIX).toBe('Unavailable: ');
    expect(isDungeonActionUnavailable(`${DUNGEON_ACTION_UNAVAILABLE_PREFIX}no`)).toBe(true);
    expect(isDungeonActionUnavailable('no')).toBe(false);
    // An unknown id is not a disabled one: the control must stay reachable until the
    // scene says otherwise.
    expect(isDungeonActionUnavailable(undefined)).toBe(false);
    expect(describeDungeonActionSentence(undefined)).toBe('');
    expect(describeDungeonActionSentence(`${DUNGEON_ACTION_UNAVAILABLE_PREFIX}no`)).toBe('no');
    expect(describeDungeonActionSentence('yes')).toBe('yes');
  });

  it('is never applied to an action the scene always accepts', async () => {
    const mounted = await mountWorld(buildWorld(2));
    for (const actionId of [DUNGEON_INTERACT_ACTION_ID, 'dungeon-zoom-in', 'dungeon-zoom-out']) {
      expect(isDungeonActionUnavailable(statusTextOf(actionId)), actionId).toBe(false);
      expect(controlOf(actionId).disabled, actionId).toBe(false);
    }
    // And a refusal, once seen, is visible in the same two places at once - which is the
    // property that a second availability channel could break.
    await act(async () => {
      mounted.handle.teleportToRoom('child-0');
    });
    await waitFor(() => {
      expect(controlOf('dungeon-descend').disabled).toBe(false);
    });
    expect(statusTextOf('dungeon-ascend')).not.toContain(DUNGEON_ACTION_UNAVAILABLE_PREFIX);
  });
});

describe('the accessible surface', () => {
  it('names the region, describes it, and keeps the canvas out of the tab order', async () => {
    await mountWorld(buildWorld(2));

    expect(screen.getByRole('img', { name: 'Dungeon canvas' })).toBeInTheDocument();
    expect(screen.getByText(/Move with the arrow keys or WASD/)).toBeInTheDocument();

    // The canvas element is created by the real Phase 9 host, which sets both attributes
    // before the renderer exists.
    const canvas = document.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.hasAttribute('tabindex')).toBe(false);
  });

  it('announces readiness in a polite live region, in words', async () => {
    await mountWorld(buildWorld(2));
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent).toMatch(/Dungeon (presented|starting)/);
    expect(status.textContent).toMatch(/Reduced motion|Motion enabled/);
    expect(status.textContent).toMatch(/Quality profile: /);
  });

  it('every action control meets the 44 CSS-pixel minimum target', async () => {
    await mountWorld(buildWorld(2));
    const controls = screen.getAllByRole('button');
    expect(controls.length).toBeGreaterThanOrEqual(DUNGEON_ACTIONS.length + 3);
    for (const control of controls) {
      const style = (control as HTMLElement).style;
      // The declared minimum, because jsdom does not resolve it into a used value.
      expect(style.minHeight).toBe('44px');
      expect(style.minWidth).toBe('44px');
    }
  });
});

describe('the room list is the DOM route to a different room', () => {
  it('offers exactly the rooms on the current floor, and nothing hidden', async () => {
    const nested = buildNestedWorld();
    await mountWorld(nested);

    expect(screen.getByRole('button', { name: 'Go to Root Topic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Child A' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Go to Grandchild 0' }),
      'the room list offered a hidden room',
    ).toBeNull();
  });

  it('each room button calls the supplied navigator with that room id', async () => {
    const onNavigateToRoom = vi.fn();
    await mountWorld(buildWorld(3), { onNavigateToRoom });

    await userEvent.click(screen.getByRole('button', { name: 'Go to Child Topic 1' }));

    expect(onNavigateToRoom).toHaveBeenCalledExactlyOnceWith('child-1');
  });

  it('without a navigator the rows are disabled and say why, rather than doing nothing', async () => {
    await mountWorld(buildWorld(2));

    const row = screen.getByRole('button', { name: 'Go to Child Topic 0' });
    expect(row).toBeDisabled();
    expect(screen.getByText(/Room navigation is unavailable in this view/)).toBeInTheDocument();
  });

  it('a floor with no visible rooms says so rather than rendering an empty group', async () => {
    const base = buildWorld(1);
    await mountWorld({
      ...base,
      floor: { floorId: 'empty', visibleRoomIds: [], portalUpRoomId: null, portalDownRoomIds: [] },
    });

    expect(screen.getByText('No rooms are visible on this floor.')).toBeInTheDocument();
  });
});


/* ── The publish channel ─────────────────────────────────────────────────────── */

/**
 * Why these tests sit on the renderer rather than on `DungeonWorldHandle`.
 *
 * `DungeonWorldHandle` deliberately does not expose `onState`: it had no production
 * consumer, and the comment claiming `GameScreen` needed it asserted a use that did not
 * exist. The real consumer is `DungeonWorld`, which subscribes to
 * `PixiDungeonRenderer.onState` and renders the mirror - so every assertion elsewhere in
 * this file, which reads a sentence off the page, is already an assertion about that
 * subscription. What is left to pin here is the port's own contract: subscribe, receive
 * the first state, receive exactly one more per event, and stop after unsubscribe.
 */
describe('the renderer port publishes once per event and stops on unsubscribe', () => {
  /**
   * A real renderer on a real host element.
   *
   * `subscribe` runs **before** the mount, and that order is the point rather than an
   * accident of the helper. The host publishes once at the end of `mount()` so the mirror
   * is never empty, which means a subscriber arriving after the mount has already missed
   * that first value. A screen gets this right by holding the renderer before mounting
   * it; this helper does the same, because a test that subscribed late would be asserting
   * a channel that does not exist.
   */
  async function mountRenderer(
    subscribe?: (renderer: PixiDungeonRenderer) => void,
  ): Promise<{ readonly renderer: PixiDungeonRenderer; readonly dispose: () => void }> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const world = buildWorld(3);
    const renderer = createPixiDungeonRenderer({
      host,
      world: { kind: 'dungeon', map: world.map, floor: world.floor, playerClass: null },
      callbacks: dungeonCallbacks(),
    });
    subscribe?.(renderer);
    await act(async () => {
      renderer.mount();
    });
    await waitFor(() => {
      expect(renderer.isReady()).toBe(true);
    });
    return {
      renderer,
      dispose: () => {
        renderer.unmount();
        host.remove();
      },
    };
  }

  it('delivers the mount-time state, republishes after a capability, and stops after unsubscribe', async () => {
    const seen: string[] = [];
    let stop: (() => void) | undefined;
    const { renderer, dispose } = await mountRenderer((created) => {
      stop = created.onState((state) => {
        seen.push(state[DUNGEON_INTERACT_ACTION_ID] ?? '');
      });
    });

    // Not a leak check: this is the value a mirror renders before anyone has pressed
    // anything. Without it a learner meets an empty status region.
    expect(seen.at(-1), 'the mount-time publish never reached the subscriber').toBe(
      'In Root Topic. Not cleared yet.',
    );
    const afterSubscribe = seen.length;

    await act(async () => {
      renderer.setRoomOverlayStates({ root: 'EncounterDefeated' });
    });
    expect(seen.at(-1), 'the capability republish carried a stale sentence').toBe(
      'In Root Topic. Encounter cleared.',
    );
    expect(seen.length - afterSubscribe, 'one capability delivered its state twice').toBe(1);

    stop?.();
    const beforeUnsubscribe = seen.length;
    await act(async () => {
      renderer.setRoomOverlayStates({ root: 'Created' });
    });
    expect(seen, 'an unsubscribed listener was still called').toHaveLength(beforeUnsubscribe);
    dispose();
  });

  it('publishes exactly once for every kind of event a learner or a screen causes', async () => {
    // The double-publish counter, measured on the real host rather than asserted about.
    // A screen reader hears a live region once per publish, so "one event, two voices" is
    // a defect no screenshot can show. The four routes are two DOM-control dispatches and
    // the two capability calls `GameScreen` makes - the four ways state can change.
    let count = 0;
    const { renderer, dispose } = await mountRenderer((created) => {
      created.onState(() => {
        count += 1;
      });
    });

    const afterSubscribe = count;
    expect(afterSubscribe, 'nothing was published, so the deltas below mean nothing').toBeGreaterThan(
      0,
    );

    await act(async () => {
      renderer.activateFromDom('dungeon-zoom-in');
    });
    const afterZoomIn = count;

    await act(async () => {
      renderer.activateFromDom(DUNGEON_INTERACT_ACTION_ID);
    });
    const afterInteract = count;

    await act(async () => {
      renderer.teleportToRoom('child-0');
    });
    const afterTeleport = count;

    await act(async () => {
      renderer.setRoomOverlayStates({ 'child-0': 'EncounterDefeated' });
    });
    const afterOverlay = count;

    // Reported as a table so a regression names the route that started doubling, instead
    // of a single number that could be any of the four.
    expect({
      publishesAtMount: afterSubscribe,
      activateFromDomZoomIn: afterZoomIn - afterSubscribe,
      activateFromDomInteract: afterInteract - afterZoomIn,
      teleportToRoom: afterTeleport - afterInteract,
      setRoomOverlayStates: afterOverlay - afterTeleport,
    }).toEqual({
      publishesAtMount: afterSubscribe,
      activateFromDomZoomIn: 1,
      activateFromDomInteract: 1,
      teleportToRoom: 1,
      setRoomOverlayStates: 1,
    });

    dispose();
  });

  it('a restart republishes rather than leaving the mirror on the state before it', async () => {
    // `restart` rebuilds the scene, so a subscriber must hear about the new one. A stale
    // mirror after a restart would be the same defect as a stale mirror after walking:
    // visible text that does not describe the world.
    const seen: string[] = [];
    const { renderer, dispose } = await mountRenderer((created) => {
      created.onState((state) => {
        seen.push(state[DUNGEON_INTERACT_ACTION_ID] ?? '');
      });
    });
    await act(async () => {
      renderer.setRoomOverlayStates({ root: 'EncounterDefeated' });
    });
    expect(seen.at(-1)).toBe('In Root Topic. Encounter cleared.');

    await act(async () => {
      renderer.restart();
    });
    await waitFor(() => {
      expect(seen.at(-1), 'the restart never republished').toBe('In Root Topic. Not cleared yet.');
    });
    dispose();
  });
});

describe('walking updates the controls, because walking publishes', () => {
  /**
   * The defect, end to end.
   *
   * Walking changes `currentRoomId` inside the scene's per-frame `update()`, and nothing
   * about that passes through `onAction` or through a capability call - so the host, which
   * publishes after every dispatch, never saw it. Availability is part of the sentence,
   * so the page went on stating something untrue: a *disabled* Descend next to on-page
   * text saying there are no stairs down, in a room that has them. A learner who walked
   * into a room with stairs was told there were none, and the page offered no route to
   * correct it.
   *
   * ## Walking, not `teleportToRoom`
   *
   * The capability path already republished, so it never exhibited the defect and a test
   * using it would have stayed green against the broken scene. `dungeon-scene.test.ts`
   * proves the same chain one level down against a hand-driven `update` loop; here the
   * **real ticker** has to run, because that is what a browser does, and the assertion is
   * read off the rendered page rather than off the scene.
   *
   * ## Why one held key is a complete route
   *
   * `walkEastThrough` in `dungeon-scene.test.ts` derives it: the root is 6x5, spawns at
   * tile (3, 2.5), and its east doorway is on row 2 - the row the player already occupies -
   * with the corridor in column 5, the room's own edge. Walking east, the east wall stops
   * the player at x=137, the centre of column 5, so the wall does the aligning. No nudge,
   * no frame counting, and nothing that depends on how fast the ticker runs.
   */
  function holdKey(key: string): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  function releaseKey(key: string): void {
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  }

  /** Hold east until the mirror reports stairs, or give up. */
  async function walkEastUntilStairsAppear(): Promise<boolean> {
    holdKey('ArrowRight');
    try {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        // One `act` per poll: the mirror's update is a React state set, and the real
        // ticker runs underneath it. `waitFor` is the wrong tool here because the condition
        // is "stops being true eventually", not "becomes true within a timeout".
        await act(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        });
        if (statusTextOf('dungeon-descend').startsWith('Descend from ')) return true;
      }
      return false;
    } finally {
      releaseKey('ArrowRight');
    }
  }

  it('the Descend control un-enables and the page stops claiming there are no stairs', async () => {
    await mountWorld(buildWorld(3));

    // The precondition, at spawn: the root room has no stairs down, and the page says so.
    await waitFor(() => {
      expect(statusTextOf('dungeon-descend')).toBe('there are no stairs down in this room');
    });
    expect(controlOf('dungeon-descend').disabled).toBe(true);

    expect(await walkEastUntilStairsAppear(), 'the player never walked into a portal room').toBe(
      true,
    );

    // The sentence followed the player, it is the one for the room actually entered, and
    // the control un-disabled because the same published value drives `disabled`.
    await waitFor(() => {
      expect(statusTextOf('dungeon-descend')).toBe('Descend from Child Topic 1');
    });
    expect(controlOf('dungeon-descend').disabled).toBe(false);
    expect(statusTextOf('dungeon-interact')).toBe('In Child Topic 1. Not cleared yet.');

    // Ascend is still refused on this floor, and still says so. One publish did not simply
    // un-disable everything: availability is computed per action.
    expect(statusTextOf('dungeon-ascend')).toBe('there are no stairs up in this room');
    expect(controlOf('dungeon-ascend').disabled).toBe(true);
  });

  it('a wheel gesture updates the zoom the page quotes', async () => {
    // The other self-initiated change. A pinch or a wheel notch never passes through
    // `onAction`, so before the fix the number a screen reader heard after a gesture was
    // the number from before it, until some unrelated control was pressed.
    await mountWorld(buildWorld(3));
    const canvas = document.querySelector('canvas');
    expect(canvas, 'the world drew no canvas').not.toBeNull();

    await waitFor(() => {
      expect(statusTextOf('dungeon-zoom-in')).toBe('Zoom in. Now 1.60 times.');
    });

    await act(async () => {
      canvas?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });
    });

    await waitFor(() => {
      expect(statusTextOf('dungeon-zoom-in')).toBe('Zoom in. Now 1.70 times.');
    });
    expect(statusTextOf('dungeon-zoom-out')).toBe('Zoom out. Now 1.70 times.');
  });
});
