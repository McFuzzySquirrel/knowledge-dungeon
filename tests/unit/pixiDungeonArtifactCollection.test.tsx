/**
 * The Phase 15 artifact event, on the real dungeon: a marker that appears when an artifact
 * exists, a pickup that happens exactly once, and a DOM signal that agrees with both.
 *
 * ## What this file is and is not
 *
 * It is the renderer half of the Phase 15 deliverable "Artifact collection event for Pixi
 * Dungeon", asserted against the real `pixi.js` `Application`, the real scene, and the real
 * `DungeonWorld` mirror - nothing in the renderer tree is mocked. The *domain* half is not
 * here: generation is `encounter/note-submit` writing `artifactMarkdown`, pickup is
 * `StudyFlowController.collectArtifact` behind the `dungeon:artifact-collected` callback, and
 * both belong to `core-logic-engineer`. What this file pins is that the world makes the
 * pickup **reachable and idempotent**, which is the only part of exit criterion 5
 * ("artifact generation and pickup remain separate actions") a renderer can be held to.
 *
 * ## Why the phases are named in the test titles
 *
 * The defect was that `GameScreen` pushed `setArtifactRooms(ids, phase === 'archaeologist')`,
 * so in the Scribe phase - the phase that *generates* the artifact - the marker was never
 * drawn and `checkArtifactCollection` returned at its first line. A renderer cannot fix that
 * on its own, and must not try: `src/renderers/**` may not import the session store or
 * compare a phase. So the tests below describe the two *host configurations* rather than two
 * phases, and assert that the renderer's only input is the flag the host pushes. The
 * host-side change this needs is reported, not made here.
 *
 * Hermeticity: synthetic subject, no `dist/`, no network, no clock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Text, type Container } from 'pixi.js';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonMap } from '@/core/layout/dungeonTypes';
import type { DungeonMetadata } from '@/core/validation/persistence';
import type { FloorVisibilityModel } from '@/application/contracts/world';
import {
  asPixiApplication,
  createPixiApplication,
  type PixiApplication,
} from '../../src/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile, type WorldSceneInit } from '../../src/renderers/pixi/runtime/types';
import {
  createDungeonScene,
  DUNGEON_ARTIFACT_PICKUP_RADIUS,
  type DungeonScene,
} from '../../src/renderers/pixi/dungeon/createDungeonScene';
import {
  DUNGEON_ARTIFACT_ACTION_ID,
  type DungeonArtifactMarkerState,
} from '../../src/renderers/pixi/dungeon/dungeonArtifact';
import type { DungeonSceneCallbacks } from '../../src/renderers/pixi/dungeon/DungeonRenderer';
import DungeonWorld, {
  type DungeonWorldHandle,
} from '../../src/renderers/pixi/dungeon/DungeonWorld';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

const theme = resolveCozyWorldTheme({ theme: null, reducedMotion: false });
const quality = resolveWorldQualityProfile('balanced');
const NOW = '2026-01-01T00:00:00.000Z';

let stub: StubbedContext;
let observer: StubbedResizeObserver;
let restoreCanvasContext2D: () => void;

/**
 * Install the `CanvasRenderingContext2D` *constructor*, which jsdom also lacks.
 *
 * The Phase 9 stub only supplies `getContext`, a method value, not the global class, and
 * PixiJS 8's text measurement reads `CanvasRenderingContext2D.prototype.letterSpacing` - so a
 * word-wrapping room label makes PixiJS read a global that is `undefined` in this realm. An
 * empty class is the correct value: PixiJS is asking whether the prototype carries the
 * property, and in this realm it does not. See
 * `tests/phase13/dungeon-world-dom.test.tsx`, which documents this at the same altitude.
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

interface SubjectFixture {
  readonly map: DungeonMap;
  readonly metadata: DungeonMetadata;
}

function buildSubject(childCount: number): SubjectFixture {
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
  return { map: generateDungeonMap(grown.value.dungeon), metadata: grown.value.dungeon };
}

function floorFor(metadata: DungeonMetadata, floorId: string): FloorVisibilityModel {
  const visibility = computeFloorVisibility(deriveGraphHierarchy(metadata), metadata, floorId);
  return {
    floorId: visibility.floorId,
    visibleRoomIds: [...visibility.visibleRoomIds],
    portalUpRoomId: visibility.portalUpRoomId,
    portalDownRoomIds: [...visibility.portalDownRoomIds],
  };
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

/* ── The real scene ────────────────────────────────────────────────────────── */

interface MountedScene {
  readonly application: Awaited<ReturnType<typeof createPixiApplication>>;
  readonly pixi: PixiApplication;
  readonly scene: DungeonScene;
  readonly callbacks: DungeonSceneCallbacks;
  readonly dispatched: Array<[string, string]>;
  readonly root: Container;
  readonly worldLayer: Container;
}

const liveApplications: Array<Awaited<ReturnType<typeof createPixiApplication>>> = [];
const liveScenes: DungeonScene[] = [];

afterEach(() => {
  for (const scene of liveScenes.splice(0)) {
    try {
      scene.destroy();
    } catch {
      /* asserted elsewhere, not here */
    }
  }
  for (const application of liveApplications.splice(0)) {
    try {
      application.destroy({ releaseGlobalResources: true });
    } catch {
      /* a destroy failure is not this file's claim */
    }
  }
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

async function mountScene(subject: SubjectFixture): Promise<MountedScene> {
  const floor = floorFor(subject.metadata, 'root');
  const canvas = document.createElement('canvas');
  const application = await createPixiApplication({
    canvas,
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(800, 600);
  const pixi = asPixiApplication(application);

  const callbacks = dungeonCallbacks();
  const dispatched: Array<[string, string]> = [];
  let scene!: DungeonScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    // The host's one dispatcher, performing and (in the real host) publishing in one
    // function. Here it performs, so a DOM-dispatched pickup reaches the callbacks the way
    // a real one would.
    onAction: (actionId, source) => {
      dispatched.push([actionId, source]);
      scene.activate(actionId, source);
    },
  };
  scene = createDungeonScene(pixi, init, {
    world: { map: subject.map, floor, playerClass: null },
    callbacks,
  });
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('dungeon-world');
  if (root === null) throw new Error('the scene added no labelled root');
  const worldLayer = root.getChildByLabel('dungeon-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  return { application, pixi, scene, callbacks, dispatched, root, worldLayer };
}

/** The room node for a room id, read from the live scene graph. */
function roomNodeOf(mounted: MountedScene, roomId: string): Container {
  const rooms = mounted.worldLayer.getChildByLabel('dungeon-rooms');
  if (rooms === null) throw new Error('no rooms layer');
  const node = rooms.getChildByLabel(`dungeon-room-${roomId}`);
  if (node === null) throw new Error(`no room node for ${roomId}`);
  return node;
}

/** How many draw instructions a labelled `Graphics` currently holds; zero means "cleared". */
function instructionCount(node: Container, label: string): number {
  const graphics = node.getChildByLabel(label);
  if (graphics === null) throw new Error(`no ${label} child`);
  return (graphics as unknown as { context: { instructions: unknown[] } }).context.instructions.length;
}

/** Whether this room's artifact marker is currently drawn. */
function markerDrawn(mounted: MountedScene, roomId: string): boolean {
  return instructionCount(roomNodeOf(mounted, roomId), 'dungeon-room-artifact') > 0;
}

/** The drawn room label, which is where the artifact state is also named in words. */
function roomLabelOf(mounted: MountedScene, roomId: string): string {
  const label = roomNodeOf(mounted, roomId).getChildByLabel('dungeon-room-label');
  if (!(label instanceof Text)) throw new Error(`no room label for ${roomId}`);
  return label.text;
}

function dispatchKey(type: 'keydown' | 'keyup', key: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

/**
 * Walk the held direction until the pickup fires, or give up.
 *
 * Held keys rather than a teleport, because the pickup's radius is the canvas gesture under
 * test: `teleportToRoom` lands on the room *centre*, and the marker is drawn
 * `MARKER_LIFT` of the room's height above it, so a teleported player is deliberately out of
 * range. Failing to arrive inside 120 frames reports the measured distance rather than a bare
 * false, so a change to the marker geometry is legible rather than mysterious.
 */
function walkUntilCollected(mounted: MountedScene, key = 'ArrowUp'): boolean {
  dispatchKey('keydown', key);
  try {
    for (let frame = 0; frame < 120; frame += 1) {
      mounted.scene.update(16);
      if ((mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        return true;
      }
    }
  } finally {
    dispatchKey('keyup', key);
  }
  return false;
}

/* ── Marker visibility ─────────────────────────────────────────────────────── */

/**
 * The Phase 15 defect, as a test.
 *
 * `pickupPermitted: true` is the *Scribe* host configuration: a note has just cleared the
 * room, `artifactMarkdown` exists, the phase's own gate says pickup may happen, and the
 * marker must therefore be on screen. Under the shipped configuration the marker was
 * suppressed in that phase and `checkArtifactCollection` returned at its first line, so the
 * pickup the exit criterion names was unreachable in the phase that earns it.
 */
describe('a room with a collectible artifact shows a marker', () => {
  it('draws it wherever pickup is permitted, which is the phase the artifact is made in', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);

    expect(markerDrawn(mounted, 'child-1'), 'a fresh room has no marker').toBe(false);

    // An artifact was generated for `child-1` and pickup is permitted.
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);

    expect(markerDrawn(mounted, 'child-1')).toBe(true);
    expect(markerDrawn(mounted, 'child-0'), 'only the room with an artifact').toBe(false);
    // And the marker is not the only carrier: the room's own label says so in words.
    expect(roomLabelOf(mounted, 'child-1')).toContain('artifact ready to collect');
  });

  it('draws nothing while the host withholds permission, and does not call that "collected"', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);

    mounted.scene.capabilities.setArtifactRooms(['child-1'], false);

    expect(markerDrawn(mounted, 'child-1')).toBe(false);
    expect(roomLabelOf(mounted, 'child-1')).not.toContain('artifact');
    // The distinction is the point: "cannot collect here" and "already collected" are
    // different facts, and only one of them is permanent.
    const snapshot = mounted.scene.readArtifactSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.state).toBe('none');
  });

  it('offers the marker in every phase, because the renderer is told and does not know', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);

    // The renderer cannot tell one phase from another, so it cannot refuse one. Whatever
    // the host pushes is what it draws, and `src/renderers/**` has no store to consult -
    // `tests/unit/pixiDungeonArtifactRule.test.ts` walks the import graph to hold that.
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    const drawnWithPermission = instructionCount(
      roomNodeOf(mounted, 'child-1'),
      'dungeon-room-artifact',
    );
    mounted.scene.capabilities.setArtifactRooms(['child-1'], false);
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    expect(
      instructionCount(roomNodeOf(mounted, 'child-1'), 'dungeon-room-artifact'),
    ).toBe(drawnWithPermission);
  });
});

/* ── The read and the drawing cannot disagree ──────────────────────────────── */

describe('the renderer-neutral read agrees with the canvas', () => {
  const configurations: ReadonlyArray<{
    readonly name: string;
    readonly pickupPermitted: boolean;
    readonly collected: readonly string[];
    readonly expected: DungeonArtifactMarkerState;
  }> = [
    { name: 'an artifact waiting', pickupPermitted: true, collected: [], expected: 'collectible' },
    {
      name: 'an artifact collected',
      pickupPermitted: true,
      collected: ['child-1'],
      expected: 'collected',
    },
    {
      name: 'pickup not permitted here',
      pickupPermitted: false,
      collected: [],
      expected: 'none',
    },
    {
      name: 'collected even though pickup is not permitted',
      pickupPermitted: false,
      collected: ['child-1'],
      expected: 'collected',
    },
  ];

  it.each(configurations)(
    'reports $expected for $name, exactly as the canvas drew it',
    async ({ pickupPermitted, collected, expected }) => {
      const subject = buildSubject(2);
      const mounted = await mountScene(subject);
      mounted.scene.capabilities.teleportToRoom('child-1');

      mounted.scene.capabilities.setArtifactRooms(['child-1'], pickupPermitted);
      mounted.scene.capabilities.setCollectedArtifactRooms(collected);

      const snapshot = mounted.scene.readArtifactSnapshot();
      expect(snapshot.roomId).toBe('child-1');
      expect(snapshot.state).toBe(expected);
      // `markerVisible` is `markerDrawn`, and `canCollect` is exactly the state the pickup
      // path will accept. One rule, four readers.
      expect(snapshot.markerVisible).toBe(markerDrawn(mounted, 'child-1'));
      expect(snapshot.canCollect).toBe(expected === 'collectible');
      expect(snapshot.rooms).toEqual([
        expect.objectContaining({ roomId: 'child-1', state: expected }),
      ]);
      // And the room's drawn label carries the same words the read publishes.
      const label = roomLabelOf(mounted, 'child-1');
      if (expected === 'collectible') expect(label).toContain('artifact ready to collect');
      if (expected === 'collected') expect(label).toContain('artifact collected');
      if (expected === 'none') expect(label).not.toContain('artifact');
    },
  );

  it('is a defined value on a corridor, not a missing one', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    // The spawn room is a room, so walk out of it: the read must still answer.
    expect(mounted.scene.readArtifactSnapshot().roomId).toBe('root');
    expect(mounted.scene.readArtifactSnapshot().canCollect).toBe(false);
    expect(mounted.scene.readArtifactSnapshot().sentence).toContain('Root Topic');
  });
});

/* ── The pickup happens once ───────────────────────────────────────────────── */

describe('a pickup is reported exactly once', () => {
  it('fires when the player walks onto the marker, and the marker goes', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);
    mounted.scene.capabilities.teleportToRoom('child-1');
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);

    const collected = mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>;
    expect(
      walkUntilCollected(mounted),
      `the player never reached the marker; the pickup radius is ${DUNGEON_ARTIFACT_PICKUP_RADIUS}px`,
    ).toBe(true);
    expect(collected).toHaveBeenCalledExactlyOnceWith('child-1');
    expect(markerDrawn(mounted, 'child-1')).toBe(false);
    expect(roomLabelOf(mounted, 'child-1')).toContain('artifact collected');

    // Standing on the spot afterwards reports nothing more.
    for (let frame = 0; frame < 5; frame += 1) mounted.scene.update(16);
    expect(collected).toHaveBeenCalledTimes(1);
  });

  it('fires from the DOM action too, and refuses the second press', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);
    mounted.scene.capabilities.teleportToRoom('child-1');
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    const collected = mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>;

    // Through the host's dispatcher, the way `activateFromDom` reaches it, so the
    // publication that follows a pickup is the same one a zoom button press gets.
    mounted.scene.activate(DUNGEON_ARTIFACT_ACTION_ID, 'dom');
    expect(collected).toHaveBeenCalledExactlyOnceWith('child-1');
    expect(markerDrawn(mounted, 'child-1')).toBe(false);

    mounted.scene.activate(DUNGEON_ARTIFACT_ACTION_ID, 'dom');
    expect(collected).toHaveBeenCalledTimes(1);
    expect(mounted.scene.readArtifactSnapshot().canCollect).toBe(false);
  });

  it('refuses the action in a room with nothing to collect, and reports nothing', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);
    mounted.scene.capabilities.teleportToRoom('child-0');
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    const collected = mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>;

    expect(mounted.scene.activate(DUNGEON_ARTIFACT_ACTION_ID, 'dom')).toBe(false);
    expect(collected).not.toHaveBeenCalled();
  });

  it('never generates anything: the only report is the pickup callback', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);
    mounted.scene.capabilities.teleportToRoom('child-1');
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);

    const reached: string[] = [];
    for (const [name, member] of Object.entries(mounted.callbacks)) {
      if (typeof member !== 'function') continue;
      (member as ReturnType<typeof vi.fn>).mockImplementation(() => reached.push(name));
    }
    mounted.scene.activate(DUNGEON_ARTIFACT_ACTION_ID, 'dom');

    // `onArtifactCollected` is the whole of it. Generation is `encounter/note-submit` on the
    // other side of the host, and a renderer that could reach it would have collapsed the
    // two actions exit criterion 5 keeps apart.
    expect(reached).toEqual(['onArtifactCollected']);
  });
});

/* ── A collected artifact is not re-offered ────────────────────────────────── */

describe('a collected artifact never comes back', () => {
  async function collectChildOne(): Promise<MountedScene> {
    const subject = buildSubject(2);
    const mounted = await mountScene(subject);
    mounted.scene.capabilities.teleportToRoom('child-1');
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    mounted.scene.activate(DUNGEON_ARTIFACT_ACTION_ID, 'dom');
    (mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>).mockClear();
    return mounted;
  }

  it('survives a re-render: a host push that drops the room does not resurrect the marker', async () => {
    const mounted = await collectChildOne();
    const collected = mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>;
    expect(markerDrawn(mounted, 'child-1')).toBe(false);

    // The host's collected set arrives from a React effect, so it can lag a pickup. A push
    // that does not yet include the room must not put the marker back: the store records
    // the pickup idempotently under `${dungeonId}:${roomId}`, so a resurrected marker
    // would be a second offer of an action that cannot happen.
    mounted.scene.capabilities.setCollectedArtifactRooms([]);
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);

    expect(markerDrawn(mounted, 'child-1')).toBe(false);
    expect(mounted.scene.readArtifactSnapshot().state).toBe('collected');
    mounted.scene.activate(DUNGEON_ARTIFACT_ACTION_ID, 'dom');
    expect(collected).not.toHaveBeenCalled();
  });

  it('survives a floor change away and back', async () => {
    const subject = buildSubject(2);
    const mounted = await collectChildOne();
    const collected = mounted.callbacks.onArtifactCollected as ReturnType<typeof vi.fn>;
    const rootFloor = floorFor(subject.metadata, 'root');

    // Leave the room, then come back. Both pushes rebuild the corridor layer, and the
    // second rebuilds the room node from scratch - which is the case a collected-in-memory
    // flag would have lost.
    mounted.scene.capabilities.setFloorVisibility({
      ...rootFloor,
      visibleRoomIds: ['root'],
    });
    mounted.scene.capabilities.setFloorVisibility(rootFloor);

    expect(markerDrawn(mounted, 'child-1')).toBe(false);
    expect(roomLabelOf(mounted, 'child-1')).toContain('artifact collected');

    // And walking onto where the marker would have been reports nothing.
    expect(walkUntilCollected(mounted)).toBe(false);
    expect(collected).not.toHaveBeenCalled();
  });
});

/* ── The DOM route ─────────────────────────────────────────────────────────── */

interface MountedMirror {
  readonly handle: DungeonWorldHandle;
  readonly callbacks: DungeonSceneCallbacks;
}

beforeEach(() => {
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/** The artifact group's status sentence, as the accessible tree carries it. */
function artifactStatusText(): string {
  return document.querySelector('[data-dungeon-artifact-status]')?.textContent ?? '';
}

function artifactControl(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>('[data-dungeon-artifact-action]');
  if (element === null) throw new Error('no artifact control');
  return element;
}

/**
 * Mount the real `DungeonWorld` - which builds a real renderer, host, and scene - and wait
 * until it has published. The callback bag is returned so a test can assert against the
 * notifications the world actually raised.
 */
async function mountMirror(subject: SubjectFixture): Promise<MountedMirror> {
  const ref = { current: null as DungeonWorldHandle | null };
  const callbacks = dungeonCallbacks();
  await act(async () => {
    render(
      <DungeonWorld
        ref={ref}
        world={{
          kind: 'dungeon',
          map: subject.map,
          floor: floorFor(subject.metadata, 'root'),
          playerClass: null,
        }}
        callbacks={callbacks}
      />,
    );
  });
  await waitFor(() => {
    expect(screen.getByText(/In Root Topic/)).toBeTruthy();
  });
  const handle = ref.current;
  if (handle === null) throw new Error('the surface never published a handle');
  return { handle, callbacks };
}

describe('the DOM route agrees with the canvas, and is not the callback', () => {
  it('states the same thing the marker shows, and enables the control exactly when it can act', async () => {
    const subject = buildSubject(2);
    const { handle } = await mountMirror(subject);

    // Spawn room: no artifact. The control exists, is disabled, and says why in words -
    // a disabled control is not focusable, so a reason only in `aria-describedby` would be
    // unreachable exactly when it matters.
    expect(artifactControl().disabled).toBe(true);
    await waitFor(() => {
      expect(artifactStatusText()).toBe('No artifact to collect in Root Topic.');
    });

    await act(async () => {
      handle.setArtifactRooms(['child-1'], true);
    });

    // The room that has one is named in the room list, so the marker is not the only carrier
    // of the state a keyboard user navigates by.
    expect(screen.getByRole('button', { name: /Go to Child Topic 1/ }).getAttribute('aria-label')).toBe(
      'Go to Child Topic 1 · artifact ready to collect',
    );
    expect(
      screen.getByRole('button', { name: /Go to Child Topic 0/ }).getAttribute('aria-label'),
    ).toBe('Go to Child Topic 0');

    // Standing in it enables the control, with the sentence a screen reader announces.
    await act(async () => {
      handle.teleportToRoom('child-1');
    });
    await waitFor(() => {
      expect(artifactStatusText()).toBe('Artifact ready to collect in Child Topic 1.');
    });
    expect(artifactControl().disabled).toBe(false);
    expect(handle.readArtifactSnapshot().canCollect).toBe(true);
  });

  it('collects through the DOM control and then refuses it, in words', async () => {
    const subject = buildSubject(2);
    const { handle, callbacks } = await mountMirror(subject);

    await act(async () => {
      handle.setArtifactRooms(['child-1'], true);
      handle.teleportToRoom('child-1');
    });
    await waitFor(() => {
      expect(artifactControl().disabled).toBe(false);
    });

    await userEvent.click(artifactControl(), { pointerEventsCheck: 0 });

    // The pickup is a *notification*, and it is the only report the renderer makes.
    expect(callbacks.onArtifactCollected).toHaveBeenCalledExactlyOnceWith('child-1');
    await waitFor(() => {
      expect(artifactStatusText()).toBe('Artifact collected from Child Topic 1.');
    });
    expect(artifactControl().disabled).toBe(true);
    expect(handle.readArtifactSnapshot().collected).toBe(true);
    // A second press does nothing at all, which is what "not re-offered" means for a
    // learner who presses the control again because the page has not caught up.
    await userEvent.click(artifactControl(), { pointerEventsCheck: 0 });
    expect(callbacks.onArtifactCollected).toHaveBeenCalledTimes(1);
  });

  it('keeps the pickup out of the always-on action group, and every declared action in it', async () => {
    const subject = buildSubject(2);
    await mountMirror(subject);
    // `data-action-id` is the always-on group's declaration of "the scene declares this
    // action", and Phase 13 pins it to exactly the declared ids. The pickup is a conditional
    // control the Scribe workspace owns, so it must not appear there - and its
    // reachability from the DOM anyway is what the two tests above show.
    const declared = [...document.querySelectorAll('[data-action-id]')].map((element) =>
      element.getAttribute('data-action-id'),
    );
    expect(declared).not.toContain(DUNGEON_ARTIFACT_ACTION_ID);
    expect(declared.length).toBeGreaterThanOrEqual(5);
    expect(document.querySelector('[data-dungeon-artifact-action]')).not.toBeNull();
    // Every button, the pickup control included, meets the declared minimum target size.
    for (const control of screen.getAllByRole('button')) {
      expect((control as HTMLElement).style.minHeight, control.getAttribute('aria-label') ?? '').toBe('44px');
      expect((control as HTMLElement).style.minWidth, control.getAttribute('aria-label') ?? '').toBe('44px');
    }
  });
});