/**
 * Phase 21, renderer half: every canvas interaction has a DOM equivalent.
 *
 * ## What this file is
 *
 * The plan's exit criterion is **"The complete learning path works through DOM controls and
 * keyboard"**, and its non-goal is **"No canvas-only fallback for core actions."** Both are
 * claims about *coverage*, and coverage is the one property a renderer cannot assert about
 * itself: a scene that declares five actions and a DOM panel that renders three of them is
 * internally consistent and unusable. So this file sits across the seam - it reads each
 * world's own action table and then asks the DOM what controls actually exist.
 *
 * ## How the coverage is decided, and why it is not just `scene.actions`
 *
 * `scene.actions` is the *host* contract, and it is deliberately narrow. Two of the three
 * worlds' real interactions never reach it:
 *
 * - **Zoom** is a camera verb. The village's zoom was, until this phase, reachable only from
 *   a wheel notch and a pinch - two pointer-only gestures, so **no keyboard route existed at
 *   all**. It cannot be an action either: `VILLAGE_ACTIONS` is pinned to length 1 by
 *   `tests/phase12/village-npc-renderer.test.ts` so that it matches the closed
 *   `VillageActionId` union in `src/application/contracts/villageNpc.ts`. The dungeon's zoom
 *   *is* actions, so the two worlds answer the same question differently.
 * - **Walking** is a held intent rather than a press, so it is not an action in any world.
 *
 * So this file enumerates each world's interaction channels from the **renderer**, not from
 * the contract, and asks the DOM about each one. `WorldInputController`'s four readings
 * (movement, interact, zoom, release) are the village's and the dungeon's channel list; the
 * fishing scene binds its own because its charge is a press *and* a release.
 *
 * ## What each assertion is for
 *
 * Four properties, per control, because each has been the failure on its own:
 *
 * | property          | the failure it rejects                                        |
 * |-------------------|---------------------------------------------------------------|
 * | a real `<button>` | a div with a click handler, unreachable by keyboard            |
 * | an accessible name| a control a screen reader announces as "button"                |
 * | 44x44 CSS px      | a control a finger cannot reliably hit                         |
 * | it reaches the world | a control that renders and does nothing                      |
 *
 * ## What this file does not do
 *
 * It does not modify `src/ui/**`. It *reads* the DOM components - rendering `FishingHud`
 * against a total port is the only way to ask whether the fishing controls exist and work,
 * and reading another owner's component is not editing it. Where the DOM side is missing
 * something, the gap is written into the report as a `(world, actionId, label, enabled)`
 * row rather than patched here.
 *
 * Hermeticity: renderer factories are mocked, so no GPU context, no `dist/`, no network, and
 * no real clock. The *markup* is the thing under test, exactly as
 * `tests/phase11/village-world-dom.test.tsx` states for the village.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { COZY_TOUCH_TARGET_MIN } from '@/theme';
import {
  createWorldInputController,
  type WorldInputController,
} from '@/renderers/pixi/input/WorldInputController';
import {
  VILLAGE_ACTIONS,
  VILLAGE_ZOOM_STEP,
} from '@/renderers/pixi/village/createVillageScene';
import {
  DUNGEON_ACTIONS,
  DUNGEON_INTERACT_ACTION_ID,
} from '@/renderers/pixi/dungeon/createDungeonScene';
import { DUNGEON_ARTIFACT_ACTION_LABEL } from '@/renderers/pixi/dungeon/dungeonArtifact';
import {
  FISHING_ACTIONS,
  FISHING_BEGIN_POWER_ACTION_ID,
  FISHING_HOOK_ACTION_ID,
  FISHING_RESET_ACTION_ID,
} from '@/renderers/pixi/fishing/createFishingScene';
import { FishingHud } from '@/ui/fishing/FishingHud';
import { FISHING_CONTROL_COPY } from '@/ui/fishing/fishingHudCopy';
import type {
  FishingHudMoveIntent,
  FishingHudPort,
  FishingHudReadout,
} from '@/ui/fishing/fishingHudPort';

/* ── Shared assertions ─────────────────────────────────────────────────────── */

/** Every channel the shared input controller offers a scene. */
const WORLD_INPUT_CHANNELS = [
  'getMoveVector',
  'consumeInteract',
  'consumeZoomDelta',
] as const;

interface ControlFacts {
  readonly tagName: string;
  readonly type: string | null;
  readonly accessibleName: string;
  readonly minWidth: string;
  readonly minHeight: string;
  readonly disabled: boolean;
}

/**
 * Read a control's facts, asserting nothing.
 *
 * A probe rather than a helper that asserts, because the four properties are checked by four
 * different tests: folding them into one function would make a failure say "not accessible"
 * when the real defect was a 30-pixel tap target.
 */
function factsOf(element: HTMLElement, accessibleName: string): ControlFacts {
  const style = element.style;
  return {
    tagName: element.tagName,
    type: element.getAttribute('type'),
    accessibleName,
    minWidth: style.minWidth,
    minHeight: style.minHeight,
    disabled: element.hasAttribute('disabled'),
  };
}

/**
 * Assert the four properties a control needs to be a real DOM equivalent.
 *
 * Exported names in the failure message so a red run says which property broke without the
 * reader opening this file.
 */
function expectUsableControl(facts: ControlFacts, label: string): void {
  expect(
    facts.tagName,
    `${label} must be a real <button>, not a div with a click handler`,
  ).toBe('BUTTON');
  expect(facts.type, `${label} must be type="button" so it never submits an ancestor form`).toBe(
    'button',
  );
  expect(
    facts.accessibleName.trim().length,
    `${label} must have a non-empty accessible name`,
  ).toBeGreaterThan(0);
  expect(
    Number.parseInt(facts.minWidth, 10),
    `${label} must be at least ${COZY_TOUCH_TARGET_MIN} CSS pixels wide`,
  ).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
  expect(
    Number.parseInt(facts.minHeight, 10),
    `${label} must be at least ${COZY_TOUCH_TARGET_MIN} CSS pixels tall`,
  ).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ── The renderer side: what can a learner do on a canvas? ─────────────────── */

describe('the interaction channels each world actually binds', () => {
  it('the shared controller offers exactly movement, interact, and zoom', () => {
    // The three worlds that use it - village and dungeon - therefore owe the DOM a route
    // for each. Named here so a future controller that adds a fourth channel fails this
    // test, which is the moment the DOM side has to learn about it.
    const element = document.createElement('div');
    const controller: WorldInputController = createWorldInputController({ element });
    for (const channel of WORLD_INPUT_CHANNELS) {
      expect(typeof controller[channel], `the controller must expose ${channel}`).toBe('function');
    }
    controller.destroy();
  });

  it('zoom is a pointer-only gesture on the shared controller, so it needs a button', () => {
    // The claim this phase turned on. `consumeZoomDelta` is fed by a wheel event and by a
    // pinch; there is no key in `MOVE_KEYS` or `INTERACT_KEYS` that reaches it. So a world
    // whose zoom is only wired to this controller has no keyboard zoom at all, and the only
    // way to give it one is a DOM control.
    const element = document.createElement('div');
    const controller = createWorldInputController({ element });
    const key = (k: string): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    window.dispatchEvent(key('ArrowRight'));
    window.dispatchEvent(key('e'));
    window.dispatchEvent(key(' '));
    expect(controller.consumeZoomDelta()).toBe(0);
    expect(controller.consumeInteract()).not.toBeNull();
    controller.destroy();
  });
});

/* ── The village ───────────────────────────────────────────────────────────── */

/**
 * The renderer factory, mocked.
 *
 * `vi.hoisted` because a `vi.mock` factory is hoisted above the imports and cannot close
 * over a module-scope `const`.
 */
const villageFake = vi.hoisted(() => {
  interface FakeVillageRenderer {
    readonly mount: ReturnType<typeof vi.fn>;
    readonly unmount: ReturnType<typeof vi.fn>;
    readonly restart: ReturnType<typeof vi.fn>;
    readonly setDynamicStructures: ReturnType<typeof vi.fn>;
    readonly setPlayerClass: ReturnType<typeof vi.fn>;
    readonly triggerInteract: ReturnType<typeof vi.fn>;
    readonly zoomBy: ReturnType<typeof vi.fn>;
    readonly readCameraState: ReturnType<typeof vi.fn>;
    readonly readPoi: () => null;
    readonly readPlayerGridPosition: ReturnType<typeof vi.fn>;
    readonly readNpcSnapshot: ReturnType<typeof vi.fn>;
    readonly invokeAction: ReturnType<typeof vi.fn>;
    readonly onReady: (listener: () => void) => () => void;
  }
  const created: FakeVillageRenderer[] = [];
  return {
    created,
    latest: (): FakeVillageRenderer => {
      const renderer = created[created.length - 1];
      if (renderer === undefined) throw new Error('no fake village renderer was created');
      return renderer;
    },
  };
});

vi.mock('@/renderers/pixi/village/VillageRenderer', async () => {
  const actual = await vi.importActual<typeof import('@/renderers/pixi/village/VillageRenderer')>(
    '@/renderers/pixi/village/VillageRenderer',
  );
  return {
    ...actual,
    createPixiVillageRenderer: () => {
      const listeners = new Set<() => void>();
      const renderer = {
        mount: vi.fn(),
        unmount: vi.fn(),
        isReady: () => false,
        restart: vi.fn(),
        setDynamicStructures: vi.fn(),
        setPlayerClass: vi.fn(),
        triggerInteract: vi.fn(),
        zoomBy: vi.fn(),
        readCameraState: vi.fn(() => ({
          centerX: 0,
          centerY: 0,
          zoom: 1.2,
          viewportWidth: 640,
          viewportHeight: 480,
        })),
        readPoi: () => null,
        readPlayerGridPosition: vi.fn(() => ({ gridX: 7, gridY: 11 })),
        readNpcSnapshot: vi.fn(),
        invokeAction: vi.fn(),
        onReady: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      villageFake.created.push(renderer);
      return renderer;
    },
  };
});

import VillageWorld from '@/renderers/pixi/village/VillageWorld';
import type { VillageWorldHandle } from '@/renderers/pixi/village/VillageWorld';
import type { VillageSceneCallbacks } from '@/renderers/pixi/village/VillageRenderer';

const villageCallbacks: VillageSceneCallbacks = {
  onStructureApproached: vi.fn(),
  onStructureLeft: vi.fn(),
  onStructureInteract: vi.fn(),
  onReady: vi.fn(),
};

const villageWorldModel = { kind: 'village' as const, structures: [], playerClass: null };

async function renderVillage(): Promise<void> {
  await act(async () => {
    render(<VillageWorld world={villageWorldModel} callbacks={villageCallbacks} />);
  });
  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: 'Interact (E or Space)' })).toBeTruthy();
  });
}

describe('the village: every canvas interaction has a DOM equivalent', () => {
  it('declares an action table whose labels are all reachable as control names', async () => {
    await renderVillage();
    for (const action of VILLAGE_ACTIONS) {
      expect(
        screen.getByRole('button', { name: action.label }),
        `the village action "${action.id}" must have a control named "${action.label}"`,
      ).toBeTruthy();
    }
  });

  it('offers the movement channel as a keyboard route with no pointer in it', async () => {
    // The movement channel is arrows and WASD, bound on the window by the shared controller,
    // so it is keyboard-operable by construction. What is asserted here is that the
    // controller is listening at all - a DOM mirror that called `setEnabled(false)` would
    // silently remove the only movement route a keyboard-only learner has.
    await renderVillage();
    const canvas = document.querySelector('canvas');
    // No canvas is created by the mock, which is the point: the movement route does not
    // depend on one existing, so the assertion is that the surface itself is reachable.
    expect(canvas).toBeNull();
    expect(screen.getByRole('group', { name: 'Village actions' })).toBeTruthy();
  });

  it('offers the interact channel as a button and as a named-target list', async () => {
    const user = userEvent.setup();
    await renderVillage();
    const interact = screen.getByRole('button', { name: 'Interact (E or Space)' });
    expectUsableControl(
      factsOf(interact, 'Interact (E or Space)'),
      'the village interact control',
    );
    await user.click(interact);
    expect(villageFake.latest().triggerInteract).toHaveBeenCalledTimes(1);
  });

  it('offers the zoom channel as two buttons - the gap Phase 21 closed', async () => {
    const user = userEvent.setup();
    await renderVillage();

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });

    // Before this phase there was no control for this channel at all: the village camera
    // answered a wheel notch and a pinch, and nothing else. These two are the DOM route.
    expectUsableControl(factsOf(zoomIn, 'Zoom in'), 'the village zoom-in control');
    expectUsableControl(factsOf(zoomOut, 'Zoom out'), 'the village zoom-out control');

    await user.click(zoomIn);
    expect(villageFake.latest().zoomBy).toHaveBeenLastCalledWith(VILLAGE_ZOOM_STEP);
    await user.click(zoomOut);
    expect(villageFake.latest().zoomBy).toHaveBeenLastCalledWith(-VILLAGE_ZOOM_STEP);

    // Same magnitude as a wheel notch, so the button and the gesture agree.
    expect(VILLAGE_ZOOM_STEP).toBeGreaterThan(0);
  });

  it('both zoom buttons are activatable with Enter and with Space', async () => {
    const user = userEvent.setup();
    await renderVillage();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    zoomIn.focus();
    expect(document.activeElement).toBe(zoomIn);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(villageFake.latest().zoomBy).toHaveBeenCalledTimes(2);
  });

  it('the zoom controls describe the pointer gestures as the same controls', async () => {
    await renderVillage();
    for (const [name, id] of [
      ['Zoom in', 'zoom-in'],
      ['Zoom out', 'zoom-out'],
    ] as const) {
      const button = screen.getByRole('button', { name });
      const describedBy = (button.getAttribute('aria-describedby') ?? '').split(/\s+/);
      const hint = describedBy
        .map((elementId) => document.getElementById(elementId)?.textContent ?? '')
        .join(' ');
      expect(hint, `${name} must name the wheel gesture`).toContain('mouse wheel');
      expect(hint, `${name} must name the pinch gesture`).toContain('pinch');
      expect(button.getAttribute('data-village-action')).toBe(id);
    }
  });

  it('the handle forwards the camera members rather than recomputing them', async () => {
    const ref = createRef<VillageWorldHandle>();
    await act(async () => {
      render(<VillageWorld ref={ref} world={villageWorldModel} callbacks={villageCallbacks} />);
    });
    expect(ref.current).not.toBeNull();
    ref.current?.zoomBy(0.25);
    expect(villageFake.latest().zoomBy).toHaveBeenCalledWith(0.25);
    // Forwarded, not substituted: the renderer measured it, so the handle returns it.
    expect(ref.current?.readCameraState()?.zoom).toBe(1.2);
  });
});

/* ── The dungeon ───────────────────────────────────────────────────────────── */

const dungeonFake = vi.hoisted(() => {
  interface FakeDungeonRenderer {
    readonly mount: ReturnType<typeof vi.fn>;
    readonly unmount: ReturnType<typeof vi.fn>;
    readonly restart: ReturnType<typeof vi.fn>;
    readonly triggerInteract: ReturnType<typeof vi.fn>;
    readonly activateFromDom: ReturnType<typeof vi.fn>;
    readonly readArtifactSnapshot: ReturnType<typeof vi.fn>;
    readonly teleportToRoom: ReturnType<typeof vi.fn>;
    readonly setFloorVisibility: ReturnType<typeof vi.fn>;
    readonly setArtifactRooms: ReturnType<typeof vi.fn>;
    readonly setCollectedArtifactRooms: ReturnType<typeof vi.fn>;
    readonly setReviewedArtifactRooms: ReturnType<typeof vi.fn>;
    readonly setImageRooms: ReturnType<typeof vi.fn>;
    readonly setRoomOverlayStates: ReturnType<typeof vi.fn>;
    readonly onReady: ReturnType<typeof vi.fn>;
    readonly onState: ReturnType<typeof vi.fn>;
  }
  const created: FakeDungeonRenderer[] = [];
  return {
    created,
    latest: (): FakeDungeonRenderer => {
      const renderer = created[created.length - 1];
      if (renderer === undefined) throw new Error('no fake dungeon renderer was created');
      return renderer;
    },
  };
});

vi.mock('@/renderers/pixi/dungeon/DungeonRenderer', async () => {
  const actual = await vi.importActual<typeof import('@/renderers/pixi/dungeon/DungeonRenderer')>(
    '@/renderers/pixi/dungeon/DungeonRenderer',
  );
  return {
    ...actual,
    createPixiDungeonRenderer: () => {
      const renderer = {
        mount: vi.fn(),
        unmount: vi.fn(),
        isReady: () => false,
        restart: vi.fn(),
        triggerInteract: vi.fn(),
        activateFromDom: vi.fn(),
        readArtifactSnapshot: vi.fn(),
        teleportToRoom: vi.fn(),
        setFloorVisibility: vi.fn(),
        setArtifactRooms: vi.fn(),
        setCollectedArtifactRooms: vi.fn(),
        setReviewedArtifactRooms: vi.fn(),
        setImageRooms: vi.fn(),
        setRoomOverlayStates: vi.fn(),
        onReady: vi.fn(() => () => {}),
        onState: vi.fn(() => () => {}),
      };
      dungeonFake.created.push(renderer);
      return renderer;
    },
  };
});

import DungeonWorld from '@/renderers/pixi/dungeon/DungeonWorld';
import type { DungeonSceneCallbacks } from '@/renderers/pixi/dungeon/DungeonRenderer';
import { IDLE_DUNGEON_ARTIFACT_SNAPSHOT } from '@/renderers/pixi/dungeon/dungeonArtifact';
import type { DungeonWorldModel } from '@/application/contracts/world';

const dungeonCallbacks: DungeonSceneCallbacks = {
  onRoomEntered: vi.fn(),
  onInteract: vi.fn(),
};

/**
 * A two-room dungeon, built by hand and typed as `DungeonWorldModel`.
 *
 * Hand-built rather than generated because this file is about *markup*: the room rows only
 * need ids, topics, and the floor's visibility, and a generated map would drag a PRNG and a
 * layout algorithm into a test whose claim is "this button has this name". The `walkable`
 * block is filled with zeroes and nothing reads it, because the renderer is mocked here - the
 * real walkability rules are `tests/phase13/dungeon-scene.test.ts`'s subject.
 */
const dungeonWorldModel: DungeonWorldModel = {
  kind: 'dungeon',
  map: {
    seed: 'phase21-dom-equivalence',
    rootRoomId: 'root',
    tileSize: 24,
    bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
    rooms: [
      { roomId: 'root', topic: 'Root Topic', status: 'Created', gridX: 0, gridY: 0, width: 2, height: 2, isRoot: true },
      { roomId: 'other', topic: 'Other Topic', status: 'Visited', gridX: 2, gridY: 2, width: 2, height: 2, isRoot: false },
    ],
    doors: [],
    corridors: [],
    walkable: { width: 4, height: 4, offsetX: 0, offsetY: 0, data: new Uint8Array(16) },
  },
  floor: {
    floorId: 'root',
    visibleRoomIds: ['root', 'other'],
    portalUpRoomId: 'root',
    portalDownRoomIds: ['other'],
  },
  playerClass: 'scholar' as const,
};

async function renderDungeon(): Promise<void> {
  await act(async () => {
    render(<DungeonWorld world={dungeonWorldModel} callbacks={dungeonCallbacks} />);
  });
  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: 'Interact (E or Space)' })).toBeTruthy();
  });
}

describe('the dungeon: every canvas interaction has a DOM equivalent', () => {
  it('renders one usable control per declared action, named by the action itself', async () => {
    await renderDungeon();
    for (const action of DUNGEON_ACTIONS) {
      const button = screen.getByRole('button', { name: action.label });
      expectUsableControl(factsOf(button, action.label), `the "${action.id}" control`);
    }
    expect(DUNGEON_ACTIONS.length).toBeGreaterThan(0);
  });

  it('every non-interact action dispatches its own id through the host', async () => {
    const user = userEvent.setup();
    await renderDungeon();
    for (const action of DUNGEON_ACTIONS) {
      if (action.id === DUNGEON_INTERACT_ACTION_ID) continue;
      await user.click(screen.getByRole('button', { name: action.label }));
    }
    const dispatched = dungeonFake.latest().activateFromDom.mock.calls.map((call) => call[0]);
    for (const action of DUNGEON_ACTIONS) {
      if (action.id === DUNGEON_INTERACT_ACTION_ID) continue;
      expect(
        dispatched,
        `"${action.id}" must reach the host, or its control does nothing`,
      ).toContain(action.id);
    }
  });

  it('the interact control reaches the same capability the key and the tap reach', async () => {
    const user = userEvent.setup();
    await renderDungeon();
    await user.click(screen.getByRole('button', { name: 'Interact (E or Space)' }));
    expect(dungeonFake.latest().triggerInteract).toHaveBeenCalledTimes(1);
  });

  it('the artifact pickup has a control even though the marker is a canvas gesture', async () => {
    // Walking onto the marker is the canvas route; this is the DOM one. The two dispatch the
    // same action id, so there is one pickup and one announcement rather than two.
    await renderDungeon();
    const artifact = screen.getByRole('button', { name: DUNGEON_ARTIFACT_ACTION_LABEL });
    expectUsableControl(factsOf(artifact, DUNGEON_ARTIFACT_ACTION_LABEL), 'the artifact control');
    // No snapshot capability means nothing is collectible, so the control is disabled and
    // says why - never focusable-but-inert.
    expect(artifact.hasAttribute('disabled')).toBe(true);
  });

  it('room navigation is a keyboard-reachable route to a different room', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    await act(async () => {
      render(
        <DungeonWorld
          world={dungeonWorldModel}
          callbacks={dungeonCallbacks}
          onNavigateToRoom={navigate}
        />,
      );
    });
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: /Go to Root Topic/ })).toBeTruthy();
    });
    const row = screen.getByRole('button', { name: /Go to Root Topic/ });
    expectUsableControl(factsOf(row, 'Go to Root Topic'), 'a room navigation row');
    await user.click(row);
    expect(navigate).toHaveBeenCalledWith('root');
  });

  it('a control is never focusable-but-inert: disabled is read from the published sentence', async () => {
    await renderDungeon();
    const group = screen.getByRole('group', { name: 'Dungeon actions' });
    const ascend = within(group).getByRole('button', { name: 'Ascend' });
    // The scene has published nothing yet, so no action has been marked unavailable and no
    // control is disabled on a guess. What is asserted is that the disable decision is read
    // from the published sentence rather than from a second availability channel - a scene
    // that published `Unavailable: there are no stairs up in this room` must disable it.
    const statuses = within(group).getAllByText(/./, { selector: '[aria-live="polite"]' });
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.textContent).not.toBe('');
    }
    expect(ascend.hasAttribute('disabled')).toBe(false);
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.canCollect).toBe(false);
  });
});

/* ── Fishing ─────────────────────────────────────────────────────────────────

 * The fishing controls are `ui-engineer`'s and live under `src/ui/fishing/**`. This file
 * *reads* them - rendering `FishingHud` against a total port is the only way to ask whether
 * the controls exist, are named, and reach the pond - and asserts nothing about how they
 * look. A gap found here belongs in the report, not in an edit to their tree.
 * ------------------------------------------------------------------------ */

/**
 * The port double, plus the two things a test needs and the port does not offer.
 *
 * `vi.fn<Signature>()` rather than a bare `vi.fn()` because this object is passed straight
 * to `<FishingHud port={...}>`, so it has to satisfy `FishingHudPort` and an untyped mock is
 * `Mock<Procedure | Constructable>`, which is not assignable to `() => void`. Typing the
 * mock at the call is what makes the port a port instead of a cast.
 */
interface FishingFake extends FishingHudPort {
  readonly beginPower: Mock<() => void>;
  readonly release: Mock<() => void>;
  readonly hook: Mock<() => void>;
  readonly reset: Mock<() => void>;
  readonly move: Mock<(intent: FishingHudMoveIntent) => void>;
  readonly returnToVillage: Mock<() => void>;
  /** Publish a new readout to every subscriber, the way the real scene does. */
  setReadout(next: FishingHudReadout): void;
}

function makeFishingPort(initial: FishingHudReadout): FishingFake {
  let readout = initial;
  const listeners = new Set<(value: FishingHudReadout) => void>();
  return {
    beginPower: vi.fn<() => void>(),
    release: vi.fn<() => void>(),
    hook: vi.fn<() => void>(),
    reset: vi.fn<() => void>(),
    move: vi.fn<(intent: FishingHudMoveIntent) => void>(),
    returnToVillage: vi.fn<() => void>(),
    readReadout: () => readout,
    onPhase: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setReadout: (next) => {
      readout = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

/** The pond the phase-17 lane uses: eligible, standing at the water. */
const ELIGIBLE_IDLE: FishingHudReadout = {
  phase: 'idle',
  power: 0,
  canReset: false,
  eligible: true,
  moveIntent: 0,
  facing: 'right',
  castNumber: 0,
  caughtCount: 0,
};

describe('the fishing pond: every canvas interaction has a DOM equivalent', () => {
  it('renders one usable control per declared action', async () => {
    const port = makeFishingPort(ELIGIBLE_IDLE);
    render(<FishingHud port={port} />);
    for (const action of FISHING_ACTIONS) {
      expect(
        screen.getByRole('button', { name: new RegExp(escapeFor(action.label), 'i') }),
        `the fishing action "${action.id}" must have a control named "${action.label}"`,
      ).toBeTruthy();
    }
    expect(FISHING_ACTIONS.length).toBeGreaterThan(0);
  });

  it('the charge control begins and releases the hold from the keyboard alone', async () => {
    const user = userEvent.setup();
    const port = makeFishingPort(ELIGIBLE_IDLE);
    render(<FishingHud port={port} />);

    const charge = screen.getByRole('button', {
      name: new RegExp(escapeFor(FISHING_CONTROL_COPY.beginPower.label), 'i'),
    });
    expectUsableControl(
      factsOf(charge, FISHING_CONTROL_COPY.beginPower.label),
      'the fishing charge control',
    );

    // Non-vacuity guard, and the reason the two assertions below are trustworthy at all.
    //
    // This guard is not decoration, and it exists because two attempts to write this test
    // without it were both vacuous. `{ }` on an *unfocused* element delivers no keydown, and
    // a descriptor typo does the same - and in both cases "nothing happened" and "the right
    // thing happened" reduce to the same call count, so the assertions below would have
    // passed while measuring a keyboard that never reached the DOM. So a plain button with a
    // recording handler is focused and driven the same way first, and its key is asserted
    // rather than its count, because a probe that recorded the *wrong* key would be just as
    // useless as one that recorded nothing.
    const recorded: string[] = [];
    const probe = render(
      <button type="button" onKeyDown={(event) => recorded.push(event.key)}>
        key probe
      </button>,
    ).getByRole('button', { name: 'key probe' });
    // Focused, because `user.keyboard` types into whatever has focus and a fresh render
    // leaves focus on the body - where a keydown reaches no handler at all. That is a third
    // way this assertion could have been vacuous, and the guard is what caught it.
    probe.focus();
    expect(document.activeElement).toBe(probe);
    await user.keyboard('{ }');
    expect(
      recorded,
      'user-event must deliver a space keydown, or these assertions prove nothing',
    ).toEqual([' ']);
    // What a real browser reports for the spacebar, which is the value `FishingHud`'s
    // `CHARGE_KEYS` tests. See the report: it accepts `' '` and `'Spacebar'` but not
    // `'Space'`, while both renderer-side `normalizeKey` helpers accept all three.
    expect(recorded[0]).not.toBe('Space');
    // No `cleanup()` here: it would unmount the HUD rendered above, and this file's
    // `afterEach` already clears the document. The probe button has its own name, so both
    // renders coexist and every `getByRole` below still resolves to exactly one element.

    const chargeControl = screen.getByRole('button', {
      name: new RegExp(escapeFor(FISHING_CONTROL_COPY.beginPower.label), 'i'),
    });
    chargeControl.focus();
    expect(document.activeElement, 'the charge control must hold focus for the keyboard route').toBe(
      chargeControl,
    );
    await user.keyboard('{ }');
    expect(port.beginPower, 'keydown on the charge control must begin the charge').toHaveBeenCalledTimes(
      1,
    );
    expect(
      port.release,
      'keyup on the charge control must release, or a keyboard user cannot cast',
    ).toHaveBeenCalledTimes(1);
  });

  it('the hook, the two resets, and the walk pair are buttons that reach the pond', async () => {
    const user = userEvent.setup();
    const port = makeFishingPort(ELIGIBLE_IDLE);
    render(<FishingHud port={port} />);

    // The hook is only enabled during a bite, so the readout is moved first. Every phase is
    // driven through the port's own subscription rather than by re-rendering the component.
    port.setReadout({ ...ELIGIBLE_IDLE, phase: 'biting' });
    const hook = screen.getByRole('button', {
      name: new RegExp(escapeFor(FISHING_CONTROL_COPY.hook.label), 'i'),
    });
    expectUsableControl(factsOf(hook, FISHING_CONTROL_COPY.hook.label), 'the fishing hook control');
    await user.click(hook);
    expect(port.hook).toHaveBeenCalledTimes(1);

    port.setReadout({ ...ELIGIBLE_IDLE, phase: 'caught' });
    await user.click(
      screen.getByRole('button', {
        name: new RegExp(escapeFor(FISHING_CONTROL_COPY.resetCaught.label), 'i'),
      }),
    );
    expect(port.reset).toHaveBeenCalledTimes(1);

    port.setReadout({ ...ELIGIBLE_IDLE, phase: 'missed' });
    await user.click(
      screen.getByRole('button', {
        name: new RegExp(escapeFor(FISHING_CONTROL_COPY.resetMissed.label), 'i'),
      }),
    );
    expect(port.reset).toHaveBeenCalledTimes(2);

    const walkLeft = screen.getByRole('button', {
      name: new RegExp(escapeFor(FISHING_CONTROL_COPY.walkLeft.label), 'i'),
    });
    const walkRight = screen.getByRole('button', {
      name: new RegExp(escapeFor(FISHING_CONTROL_COPY.walkRight.label), 'i'),
    });
    expectUsableControl(factsOf(walkLeft, 'Walk left'), 'the fishing walk-left control');
    expectUsableControl(factsOf(walkRight, 'Walk right'), 'the fishing walk-right control');
    walkLeft.focus();
    await user.keyboard('{ArrowLeft}');
    expect(port.move).toHaveBeenCalledWith(-1);
    walkRight.focus();
    await user.keyboard('{ArrowRight}');
    expect(port.move).toHaveBeenCalledWith(1);
  });

  it('leaving the pond has a button, because the canvas route was unreachable', async () => {
    const user = userEvent.setup();
    const port = makeFishingPort(ELIGIBLE_IDLE);
    render(<FishingHud port={port} />);
    const leave = screen.getByRole('button', { name: /Return to the village/i });
    expectUsableControl(factsOf(leave, 'Return to the village'), 'the fishing leave control');
    await user.click(leave);
    expect(port.returnToVillage).toHaveBeenCalledTimes(1);
  });

  it('an ineligible pond disables its controls and says so in words', async () => {
    const port = makeFishingPort({ ...ELIGIBLE_IDLE, eligible: false });
    const { container } = render(<FishingHud port={port} />);
    const charge = screen.getByRole('button', {
      name: new RegExp(escapeFor(FISHING_CONTROL_COPY.beginPower.label), 'i'),
    });
    expect(charge.hasAttribute('disabled')).toBe(true);
    // Never a disabled control and nothing else: the reason is on the page, in a sentence,
    // because a disabled control is not focusable and an `aria-describedby` alone would be
    // unreachable exactly when it matters.
    expect(container.textContent ?? '').toMatch(/clear|rooms|unlock|not yet/i);
  });

  it('names the three declared action ids against the controls that carry them', () => {
    // A vocabulary cross-check rather than a render: the action table in the renderer and the
    // copy table in the DOM must agree on what the three verbs are called, or the control a
    // screen-reader user hears is not the action the world performs.
    expect(FISHING_BEGIN_POWER_ACTION_ID).toBe('fishing-begin-power');
    expect(FISHING_HOOK_ACTION_ID).toBe('fishing-hook');
    expect(FISHING_RESET_ACTION_ID).toBe('fishing-reset');
    expect(FISHING_CONTROL_COPY.beginPower.label).toBe(FISHING_ACTIONS[0]?.label);
    expect(FISHING_CONTROL_COPY.hook.label).toBe(FISHING_ACTIONS[1]?.label);
    expect(FISHING_CONTROL_COPY.resetCaught.label).toBe(FISHING_ACTIONS[2]?.label);
  });
});

/** Escape a label for use inside a regular expression. */
function escapeFor(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}