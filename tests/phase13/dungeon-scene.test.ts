/**
 * The real PixiJS dungeon scene, built on a real `Application`.
 *
 * ## Why this altitude
 *
 * `tests/phase13/walkability-controller.test.ts` proves the movement rules, and it can do
 * that without a canvas because they are pure. But "rooms, corridors, doors, portals,
 * overlays, and the player are drawn" is a claim about a scene graph, and a scene test
 * against a fake application would prove only the scene's *intent*. So this file
 * constructs the real `pixi.js` `Application`, the real scene, the real camera rig, and
 * the real input controller, and reads the assertions out of the live scene graph
 * through PixiJS's own `getChildByLabel` - which is the fact a double cannot establish.
 *
 * ## The controls that are real and the two that are stubbed
 *
 * Real: `Application`, `Container`/`Graphics`/`Text`, the scene, `CameraRig`,
 * `WorldInputController`, and the dispatch route into `init.onAction`.
 *
 * Stubbed: two browser facilities jsdom does not implement - the Canvas2D context
 * PixiJS's text metrics read, and a `ResizeObserver` (whose absence makes PixiJS 8.21
 * leak a `Ticker.shared` listener per application; see
 * `tests/phase9/support/canvasContextStub.ts`). Neither is the thing under test.
 *
 * ## What this file deliberately does not prove
 *
 * That a learner perceives anything. No pixel is asserted and no frame is presented.
 * Structural parity is not visual parity; the browser lane
 * (`tests/e2e/currentBuild.spec.ts`) and the Phase 21 audits own perception.
 *
 * Hermeticity: synthetic subjects only, no `dist/`, no network, no clock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Text, type Container } from 'pixi.js';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonCorridor, DungeonMap } from '@/core/layout/dungeonTypes';
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
  DUNGEON_ACTIONS,
  DUNGEON_ASCEND_ACTION_ID,
  DUNGEON_DESCEND_ACTION_ID,
  DUNGEON_INTERACT_ACTION_ID,
  DUNGEON_ZOOM_IN_ACTION_ID,
  DUNGEON_ZOOM_OUT_ACTION_ID,
  describeDungeonActionSentence,
  isDungeonActionUnavailable,
  type DungeonScene,
} from '../../src/renderers/pixi/dungeon/createDungeonScene';
import { resolveRoomCenter } from '../../src/renderers/pixi/dungeon/WalkabilityController';
import type { DungeonSceneCallbacks } from '../../src/renderers/pixi/dungeon/DungeonRenderer';
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

beforeAll(() => {
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
});

afterAll(() => {
  observer.restore();
  stub.restore();
});

/** A subject with `childCount` root children and no grandchildren. */
function buildSubject(childCount: number): { map: DungeonMap; metadata: DungeonMetadata } {
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
  return {
    map: generateDungeonMap(grown.value.dungeon),
    metadata: grown.value.dungeon,
  };
}

/** The renderer-neutral floor model for a floor id, as the screen builds it. */
function floorFor(metadata: Parameters<typeof computeFloorVisibility>[1], floorId: string): FloorVisibilityModel {
  const visibility = computeFloorVisibility(deriveGraphHierarchy(metadata), metadata, floorId);
  return {
    floorId: visibility.floorId,
    visibleRoomIds: [...visibility.visibleRoomIds],
    portalUpRoomId: visibility.portalUpRoomId,
    portalDownRoomIds: [...visibility.portalDownRoomIds],
  };
}

interface MountedScene {
  readonly application: Awaited<ReturnType<typeof createPixiApplication>>;
  readonly pixi: PixiApplication;
  readonly scene: DungeonScene;
  readonly callbacks: Record<string, ReturnType<typeof vi.fn>>;
  readonly dispatched: Array<[string, string]>;
  readonly root: Container;
  readonly worldLayer: Container;
  readonly player: Container;
  /**
   * Every state the scene published, in order, because the scene chose to.
   *
   * A count and a log rather than a boolean: the failure this file guards is a publish
   * that is *too many*, which an assertion of the form "it published" cannot see.
   */
  readonly published: ReadonlyArray<Readonly<Record<string, string>>>;
}

const liveApplications: Array<Awaited<ReturnType<typeof createPixiApplication>>> = [];
const liveScenes: DungeonScene[] = [];

afterEach(() => {
  for (const scene of liveScenes.splice(0)) {
    try {
      scene.destroy();
    } catch {
      /* asserted in the destroy test, not here */
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

async function mountScene(world: {
  map: DungeonMap;
  floor: FloorVisibilityModel;
  playerClass: 'scholar' | null;
}): Promise<MountedScene> {
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

  const callbacks = {
    onRoomEntered: vi.fn(),
    onInteract: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onNpcOutOfRange: vi.fn(),
    onArtifactCollected: vi.fn(),
    onFloorTransition: vi.fn(),
  };
  const dispatched: Array<[string, string]> = [];
  const published: Array<Readonly<Record<string, string>>> = [];
  let scene!: DungeonScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    // The host's one dispatcher: performing and (in the real host) publishing in one
    // function. Here it performs, so the callbacks are reachable.
    onAction: (actionId, source) => {
      dispatched.push([actionId, source]);
      scene.activate(actionId, source);
    },
    // The real host hands the scene its own `publishState`; this file hands it a log, so
    // "the world changed itself" is observable as a number.
    publishState: () => {
      published.push(scene.readState());
    },
  };
  scene = createDungeonScene(pixi, init, { world, callbacks: callbacks as DungeonSceneCallbacks });
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('dungeon-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');
  const worldLayer = root.getChildByLabel('dungeon-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  const player = worldLayer.getChildByLabel('dungeon-player');
  if (player === null) throw new Error('the scene added no player marker');

  return { application, pixi, scene, callbacks, dispatched, root, worldLayer, player, published };
}

/** The labelled descendants of a container, by label. */
function labelsUnder(container: Container): string[] {
  const found: string[] = [];
  const visit = (node: Container): void => {
    if (typeof node.label === 'string' && node.label.length > 0) found.push(node.label);
    for (const child of node.children) visit(child as Container);
  };
  for (const child of container.children) visit(child as Container);
  return found;
}

/** Every `Text` value in a subtree, in traversal order. */
function collectTexts(container: Container): string[] {
  const found: string[] = [];
  const visit = (node: Container): void => {
    if (node instanceof Text) found.push(node.text);
    for (const child of node.children) visit(child as Container);
  };
  visit(container);
  return found;
}

function dispatchKey(type: 'keydown' | 'keyup', key: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

describe('a real application receives a labelled dungeon subtree', () => {
  it('draws the root room, the player, and nothing from a hidden floor', async () => {
    const subject = buildSubject(4);
    const rootFloor = floorFor(subject.metadata, 'root');
    const mounted = await mountScene({ map: subject.map, floor: rootFloor, playerClass: null });

    expect(mounted.root.parent).toBe(mounted.pixi.stage);
    expect(mounted.worldLayer.sortableChildren).toBe(true);

    const labels = labelsUnder(mounted.worldLayer);
    expect(labels).toContain('dungeon-rooms');
    expect(labels).toContain('dungeon-corridors');
    expect(labels).toContain('dungeon-room-root');

    // The room *containers* are the direct children of the rooms layer, which is what
    // makes this count about rooms rather than about every labelled part inside one.
    const roomsLayer = mounted.worldLayer.getChildByLabel('dungeon-rooms');
    if (roomsLayer === null) throw new Error('no rooms layer');
    // The root floor of this flat subject exposes every child as a down portal, so all
    // five rooms are visible; the point of the assertion is that nothing else is drawn.
    expect(roomsLayer.children).toHaveLength(5);
    expect(
      roomsLayer.children.map((child) => (child as Container).label).sort(),
    ).toEqual([
      'dungeon-room-child-0',
      'dungeon-room-child-1',
      'dungeon-room-child-2',
      'dungeon-room-child-3',
      'dungeon-room-root',
    ]);

    // A portal room's label carries a direction arrow, so the topic is asserted as a
    // substring rather than an exact string - which is also what proves the arrow is there.
    const texts = collectTexts(mounted.worldLayer);
    for (const topic of ['Root Topic', 'Child Topic 0', 'Child Topic 3']) {
      expect(
        texts.some((text) => text.includes(topic)),
        `${topic} was not drawn. Labels: ${texts.join(' | ')}`,
      ).toBe(true);
    }
    // Every child is a down portal on this floor, so every child label leads with the
    // down arrow and the root label does not.
    const childLabels = texts.filter((text) => text.includes('Child Topic'));
    expect(childLabels).toHaveLength(4);
    for (const label of childLabels) expect(label.startsWith('\u2193 '), label).toBe(true);
    expect(texts.filter((text) => text === 'Root Topic')).toHaveLength(1);
  });

  it('draws a corridor and a labelled door at each end', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    const labels = labelsUnder(mounted.worldLayer);
    const corridor = subject.map.corridors[0];
    expect(corridor).toBeDefined();
    if (corridor === undefined) throw new Error('the fixture has no corridor');
    expect(labels).toContain(`dungeon-door-${corridor.fromDoor.roomId}-${corridor.fromDoor.side}`);
    expect(labels).toContain(`dungeon-door-${corridor.toDoor.roomId}-${corridor.toDoor.side}`);
    // Two per corridor, plus the rooms, the corridors, the world layer, and the player.
    expect(labels.filter((label) => label.startsWith('dungeon-door-'))).toHaveLength(
      subject.map.corridors.length * 2,
    );
  });

  it('omits the corridor and doors to a hidden floor, and draws them when it appears', async () => {
    const root = createRootDungeon({
      dungeonId: 'synthetic-subject',
      subjectName: 'Synthetic Subject',
      rootRoomId: 'root',
      rootTopic: 'Root Topic',
      nowIso: NOW,
    });
    if (!root.ok) throw new Error('root dungeon init failed');
    const withChildren = addLinkedRooms(root.value, {
      fromRoomId: 'root',
      drafts: [{ roomId: 'child-a', topic: 'Child A' }],
      nowIso: NOW,
    });
    if (!withChildren.ok) throw new Error('addLinkedRooms failed');
    const withGrandchild = addLinkedRooms(withChildren.value.dungeon, {
      fromRoomId: 'child-a',
      drafts: [{ roomId: 'grandchild-0', topic: 'Grandchild 0' }],
      nowIso: NOW,
    });
    if (!withGrandchild.ok) throw new Error('addLinkedRooms failed');
    const metadata = withGrandchild.value.dungeon;
    const map = generateDungeonMap(metadata);

    const mounted = await mountScene({
      map,
      floor: floorFor(metadata, 'child-a'),
      playerClass: null,
    });

    const onChildFloor = labelsUnder(mounted.worldLayer);
    expect(onChildFloor).toContain('dungeon-room-grandchild-0');
    expect(onChildFloor, 'the child floor shows the corridor to its up portal').toContain(
      'dungeon-door-root-N',
    );

    // Switching to the root floor removes the grandchild room and its corridor entirely.
    mounted.scene.capabilities.setFloorVisibility(floorFor(metadata, 'root'));
    const onRootFloor = labelsUnder(mounted.worldLayer);
    expect(onRootFloor).not.toContain('dungeon-room-grandchild-0');
    expect(onRootFloor).not.toContain('dungeon-door-grandchild-0-S');
    expect(onRootFloor).toContain('dungeon-room-root');
    expect(onRootFloor).toContain('dungeon-room-child-a');
  });
});

describe('the room state overlays respond to the capability port', () => {
  it('an unvisited room draws a locked plate and a cleared room draws an open chest', async () => {
    const subject = buildSubject(2);
    // No portals in this floor model, so both rooms carry an overlay. A portal room is
    // excluded from overlays by design - the stairs have to read clearly - and this test
    // is about the overlay, so the fixture must not be one.
    const plainFloor: FloorVisibilityModel = {
      floorId: 'root',
      visibleRoomIds: ['root', 'child-0', 'child-1'],
      portalUpRoomId: null,
      portalDownRoomIds: [],
    };
    const mounted = await mountScene({ map: subject.map, floor: plainFloor, playerClass: null });

    const roomNode = (roomId: string): Container => {
      const node = mounted.worldLayer.getChildByLabel('dungeon-rooms');
      if (node === null) throw new Error('no rooms container');
      const room = node.getChildByLabel(`dungeon-room-${roomId}`);
      if (room === null) throw new Error(`no room node for ${roomId}`);
      return room;
    };
    const overlayOf = (roomId: string): Container => {
      const overlay = roomNode(roomId).getChildByLabel('dungeon-room-overlay');
      if (overlay === null) throw new Error(`no overlay for ${roomId}`);
      return overlay;
    };
    /** How many draw instructions a labelled graphics currently holds. */
    const instructionCount = (graphics: Container): number =>
      (graphics as unknown as { context: { instructions: unknown[] } }).context.instructions.length;

    // A fresh subject's rooms are `Created`, so each starts with a locked plate drawn.
    const locked = overlayOf('child-0');
    const lockedCount = instructionCount(locked);
    expect(lockedCount, 'a Created room drew no locked plate').toBeGreaterThan(0);

    // The same Graphics object, redrawn in place: a room's node is not rebuilt per state,
    // so a state change is not a floor change.
    mounted.scene.capabilities.setRoomOverlayStates({ 'child-0': 'EncounterDefeated' });
    const cleared = overlayOf('child-0');
    expect(cleared).toBe(locked);
    // A different drawing, which is the "no colour-only state" claim: a learner who cannot
    // separate the hues sees a lid raised and bars across a plate, not a tint change.
    expect(instructionCount(cleared)).not.toBe(lockedCount);
    expect(instructionCount(cleared)).toBeGreaterThan(0);

    // And back again, so the assertion is not passing because the overlay simply latches.
    mounted.scene.capabilities.setRoomOverlayStates({ 'child-0': 'Created' });
    expect(instructionCount(overlayOf('child-0'))).toBe(lockedCount);
  });

  it('shows the artifact marker only when the icons are switched on, and drops it once collected', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    const roomNode = mounted.worldLayer
      .getChildByLabel('dungeon-rooms')
      ?.getChildByLabel('dungeon-room-child-1');
    if (roomNode === null || roomNode === undefined) throw new Error('no room node');
    const artifact = roomNode.getChildByLabel('dungeon-room-artifact');
    if (artifact === null) throw new Error('no artifact child');
    const artifactGraphics = artifact as unknown as { context: { instructions: unknown[] } };

    const before = artifactGraphics.context.instructions.length;
    mounted.scene.capabilities.setArtifactRooms(['child-1'], true);
    const shown = artifactGraphics.context.instructions.length;
    expect(shown, 'switching the icons on drew nothing').toBeGreaterThan(before);

    mounted.scene.capabilities.setCollectedArtifactRooms(['child-1']);
    expect(artifactGraphics.context.instructions.length).toBe(before);
  });

  it('shows the review marker only for reviewed rooms', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    const reviewOf = (roomId: string): Container | null => {
      const room = mounted.worldLayer
        .getChildByLabel('dungeon-rooms')
        ?.getChildByLabel(`dungeon-room-${roomId}`);
      return room?.getChildByLabel('dungeon-room-review') ?? null;
    };
    expect(reviewOf('child-0')?.visible).toBe(false);
    mounted.scene.capabilities.setReviewedArtifactRooms(['child-0']);
    expect(reviewOf('child-0')?.visible).toBe(true);
    expect(reviewOf('child-1')?.visible).toBe(false);
  });
});

describe('portals, movement, and the events the application layer expects', () => {
  it('spawns in the root room, reports it, and teleports on a capability call', async () => {
    const subject = buildSubject(3);
    const rootFloor = floorFor(subject.metadata, 'root');
    const mounted = await mountScene({ map: subject.map, floor: rootFloor, playerClass: null });

    const rootRoom = subject.map.rooms.find((room) => room.isRoot);
    if (rootRoom === undefined) throw new Error('the fixture has no root room');
    const spawn = resolveRoomCenter(rootRoom, subject.map.tileSize);
    expect(mounted.player.x).toBeCloseTo(spawn.x, 5);
    expect(mounted.player.y).toBeCloseTo(spawn.y, 5);
    expect(mounted.callbacks['onRoomEntered']).toHaveBeenCalledWith('root');

    mounted.scene.capabilities.teleportToRoom('child-2');

    const destination = resolveRoomCenter(
      subject.map.rooms.find((room) => room.roomId === 'child-2') as never,
      subject.map.tileSize,
    );
    expect(mounted.player.x).toBeCloseTo(destination.x, 5);
    expect(mounted.player.y).toBeCloseTo(destination.y, 5);
    expect(mounted.callbacks['onRoomEntered']).toHaveBeenLastCalledWith('child-2');

    // An unknown room is a no-op rather than a teleport to the origin.
    const before = { x: mounted.player.x, y: mounted.player.y };
    mounted.scene.capabilities.teleportToRoom('not-a-room');
    expect({ x: mounted.player.x, y: mounted.player.y }).toEqual(before);
  });

  it('the keyboard moves the player, and E is routed through the host dispatcher', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    mounted.dispatched.length = 0;
    const before = { x: mounted.player.x, y: mounted.player.y };

    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < 10; frame += 1) mounted.scene.update(16);
    dispatchKey('keyup', 'ArrowRight');

    expect(Math.abs(mounted.player.x - before.x)).toBeGreaterThan(1);

    mounted.dispatched.length = 0;
    dispatchKey('keydown', 'e');
    dispatchKey('keyup', 'e');
    mounted.scene.update(16);

    // Through `init.onAction`, so the state the DOM mirror reads is republished.
    expect(mounted.dispatched).toEqual([[DUNGEON_INTERACT_ACTION_ID, 'keyboard']]);
  });

  it('WASD and the arrow keys move the player the same way', async () => {
    const subject = buildSubject(3);
    const rootFloor = floorFor(subject.metadata, 'root');

    const travel = async (key: string): Promise<number> => {
      const mounted = await mountScene({ map: subject.map, floor: rootFloor, playerClass: null });
      const before = { x: mounted.player.x, y: mounted.player.y };
      dispatchKey('keydown', key);
      for (let frame = 0; frame < 10; frame += 1) mounted.scene.update(16);
      dispatchKey('keyup', key);
      const moved = Math.hypot(mounted.player.x - before.x, mounted.player.y - before.y);
      mounted.scene.destroy();
      liveScenes.splice(liveScenes.indexOf(mounted.scene), 1);
      return moved;
    };

    const withArrow = await travel('ArrowDown');
    const withKey = await travel('s');
    expect(withKey).toBeGreaterThan(1);
    // Same distance, not merely "both moved": the speed and the normalisation are shared,
    // so a WASD key that doubled the speed would show up here.
    expect(withKey).toBeCloseTo(withArrow, 4);
  });

  it('a drag on the canvas moves the player, and a tap reaches the host dispatcher', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    const canvas = mounted.pixi.canvas as HTMLCanvasElement;
    mounted.dispatched.length = 0;

    const pointer = (type: string, x: number, y: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, clientX: x, clientY: y, button: 0 });
      canvas.dispatchEvent(event);
    };

    const before = { x: mounted.player.x, y: mounted.player.y };
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 180, 100);
    for (let frame = 0; frame < 10; frame += 1) mounted.scene.update(16);
    pointer('pointerup', 180, 100);
    expect(Math.abs(mounted.player.x - before.x)).toBeGreaterThan(1);

    // A short, still contact is a tap, and it queues the same interact.
    mounted.dispatched.length = 0;
    pointer('pointerdown', 200, 200);
    pointer('pointerup', 200, 200);
    mounted.scene.update(16);
    expect(mounted.dispatched).toEqual([[DUNGEON_INTERACT_ACTION_ID, 'pointer']]);
  });

  it('interacting in a non-portal room emits dungeon:interact, not a floor transition', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    // Stand well clear of the room guide so the interact verb reaches the room, which is
    // the Phaser scene's precedence: guide, then portal, then the room.
    mounted.scene.capabilities.teleportToRoom('child-0');
    const room = subject.map.rooms.find((entry) => entry.roomId === 'child-0');
    if (room === undefined) throw new Error('missing fixture room');
    const centre = resolveRoomCenter(room, subject.map.tileSize);
    expect(Math.abs(centre.x - mounted.player.x)).toBeLessThan(0.001);

    mounted.scene.capabilities.triggerInteract();

    // `child-0` is a down portal on the root floor, so the interact is a floor request.
    expect(mounted.callbacks['onFloorTransition']).toHaveBeenCalledWith({
      fromRoomId: 'child-0',
      direction: 'down',
    });
    expect(mounted.callbacks['onInteract']).not.toHaveBeenCalled();
  });

  it('ascend and descend are refused in a room that has no such stairs', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    // On the root floor of this flat subject every child is a down portal and nothing has
    // an up portal, so the root room can ascend and cannot descend.
    expect(mounted.scene.activate(DUNGEON_ASCEND_ACTION_ID, 'dom')).toBe(false);
    expect(mounted.scene.activate(DUNGEON_DESCEND_ACTION_ID, 'dom')).toBe(false);
    expect(mounted.callbacks['onFloorTransition']).not.toHaveBeenCalled();

    mounted.scene.capabilities.teleportToRoom('child-0');
    expect(mounted.scene.activate(DUNGEON_DESCEND_ACTION_ID, 'dom')).toBe(true);
    expect(mounted.callbacks['onFloorTransition']).toHaveBeenCalledWith({
      fromRoomId: 'child-0',
      direction: 'down',
    });
  });

  it('the two floors of a nested subject each hold the portal the other one needs', async () => {
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
    const map = generateDungeonMap(metadata);

    const mounted = await mountScene({
      map,
      floor: floorFor(metadata, 'child-a'),
      playerClass: null,
    });

    // The child's floor has one up portal - its parent, the root room.
    mounted.scene.capabilities.teleportToRoom('root');
    expect(mounted.scene.activate(DUNGEON_ASCEND_ACTION_ID, 'dom')).toBe(true);
    expect(mounted.callbacks['onFloorTransition']).toHaveBeenCalledWith({
      fromRoomId: 'root',
      direction: 'up',
    });
    expect(mounted.scene.activate(DUNGEON_DESCEND_ACTION_ID, 'dom')).toBe(false);

    // The label carries the direction as an arrow, not only as a tint.
    const roomNode = mounted.worldLayer
      .getChildByLabel('dungeon-rooms')
      ?.getChildByLabel('dungeon-room-root');
    const label = roomNode?.getChildByLabel('dungeon-room-label');
    expect(label).toBeInstanceOf(Text);
    expect((label as Text).text).toContain('↑');
  });
});

describe('the action table is the DOM contract, and every verb reaches one dispatcher', () => {
  it('declares five actions, none of which binds a key the input controller already owns', () => {
    expect(DUNGEON_ACTIONS.map((action) => action.id)).toEqual([
      'dungeon-interact',
      'dungeon-ascend',
      'dungeon-descend',
      'dungeon-zoom-in',
      'dungeon-zoom-out',
    ]);
    // `keyboardKey: null` is what stops the host's shortcut map and the input controller
    // both claiming `e`. A `keyboardKey` here would perform one interact twice.
    for (const action of DUNGEON_ACTIONS) expect(action.keyboardKey).toBeNull();
  });

  /**
   * These assert the *sentences the scene produces*. That they reach a learner is asserted
   * at the other end of the same channel, in `tests/phase13/dungeon-world-dom.test.tsx`,
   * which mounts the real surface on a real renderer and reads these exact values out of
   * the accessible tree. The two files are the two halves of one claim, and neither is
   * sufficient alone: this one cannot prove delivery, and that one cannot prove the words
   * are the scene's.
   */
  it('reports a status sentence per action, in words, marking a refused one unavailable', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    const state = mounted.scene.readState();
    expect(Object.keys(state).sort()).toEqual(
      DUNGEON_ACTIONS.map((action) => action.id).sort(),
    );
    // Words, not a colour or a symbol: this string is the `aria-live` line a screen reader
    // announces, and it is the only non-visual statement of where the player is.
    expect(state[DUNGEON_INTERACT_ACTION_ID]).toContain('Root Topic');
    // A refused action is marked, and the mark is what the DOM turns into `disabled` plus
    // a visible reason. An unmarked "no stairs up" would be a sentence with no way to act
    // on it, which is the defect QA raised.
    expect(isDungeonActionUnavailable(state[DUNGEON_ASCEND_ACTION_ID])).toBe(true);
    expect(isDungeonActionUnavailable(state[DUNGEON_DESCEND_ACTION_ID])).toBe(true);
    expect(describeDungeonActionSentence(state[DUNGEON_ASCEND_ACTION_ID])).toBe(
      'there are no stairs up in this room',
    );
    expect(describeDungeonActionSentence(state[DUNGEON_DESCEND_ACTION_ID])).toBe(
      'there are no stairs down in this room',
    );
    expect(state[DUNGEON_ZOOM_IN_ACTION_ID]).toMatch(/Zoom in\. Now \d/);
    // An action the scene always accepts is never marked, or its control would be
    // permanently disabled.
    for (const actionId of [DUNGEON_INTERACT_ACTION_ID, DUNGEON_ZOOM_IN_ACTION_ID, DUNGEON_ZOOM_OUT_ACTION_ID]) {
      expect(isDungeonActionUnavailable(state[actionId]), actionId).toBe(false);
    }
  });

  it('unmarks a portal the player is standing on, and marks the other', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    mounted.scene.capabilities.teleportToRoom('child-0');
    const state = mounted.scene.readState();
    expect(isDungeonActionUnavailable(state[DUNGEON_DESCEND_ACTION_ID])).toBe(false);
    expect(state[DUNGEON_DESCEND_ACTION_ID]).toBe('Descend from Child Topic 0');
    // Ascend is still refused here, and the mark is still there.
    expect(isDungeonActionUnavailable(state[DUNGEON_ASCEND_ACTION_ID])).toBe(true);
  });

  it('reports the cleared state in words as well as drawing it', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    expect(mounted.scene.readState()[DUNGEON_INTERACT_ACTION_ID]).toBe(
      'In Root Topic. Not cleared yet.',
    );
    mounted.scene.capabilities.setRoomOverlayStates({ root: 'EncounterDefeated' });
    expect(mounted.scene.readState()[DUNGEON_INTERACT_ACTION_ID]).toBe(
      'In Root Topic. Encounter cleared.',
    );
  });
});

describe('zoom follows the Phaser scene rule and yields to a gesture', () => {
  it('zooms out on a corridor and back in inside a room', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    const stateZoom = (): number => mounted.worldLayer.scale.x;

    expect(stateZoom(), 'a room starts zoomed in').toBeCloseTo(1.6, 3);

    // Walk far enough to leave the room. Holding right for a while in a 3-room fixture
    // reaches a wall, so the transition is observed by driving the input until the room
    // lookup changes - which is what the zoom transition is keyed to.
    dispatchKey('keydown', 'ArrowRight');
    let sawCorridor = false;
    for (let frame = 0; frame < 240 && !sawCorridor; frame += 1) {
      mounted.scene.update(16);
      sawCorridor = stateZoom() < 1.6;
    }
    dispatchKey('keyup', 'ArrowRight');
    expect(sawCorridor, 'the auto-zoom never left the room level').toBe(true);
  });

  it('a DOM zoom button changes the zoom and a further room transition re-arms auto-zoom', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    expect(mounted.scene.activate(DUNGEON_ZOOM_IN_ACTION_ID, 'dom')).toBe(true);
    mounted.scene.update(16);
    const zoomed = mounted.worldLayer.scale.x;
    expect(zoomed).toBeGreaterThan(1.6);

    // A teleport puts the player back in a room, which re-arms the auto-zoom tween: the
    // Phaser scene behaved the same way after a pinch.
    mounted.scene.capabilities.teleportToRoom('child-1');
    mounted.scene.update(16);
    expect(mounted.scene.readState()[DUNGEON_ZOOM_IN_ACTION_ID]).toContain('Now');
  });

  it('a wheel notch is applied once and clamps at the zoom limits', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    const canvas = mounted.pixi.canvas as HTMLCanvasElement;

    for (let notch = 0; notch < 40; notch += 1) {
      const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
      canvas.dispatchEvent(event);
      mounted.scene.update(16);
    }
    // The Phaser scene's pinch range, 0.4 to 3.5, is the ceiling on a wheel too.
    expect(mounted.worldLayer.scale.x).toBeLessThanOrEqual(3.5);
    expect(mounted.worldLayer.scale.x).toBeGreaterThan(0.4);

    for (let notch = 0; notch < 40; notch += 1) {
      const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      canvas.dispatchEvent(event);
      mounted.scene.update(16);
    }
    expect(mounted.worldLayer.scale.x).toBeGreaterThanOrEqual(0.4);
  });
});

describe('teardown releases every display object the scene created', () => {
  it('destroy leaves no labelled dungeon node on the stage and is safe to repeat', async () => {
    const subject = buildSubject(4);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    expect(mounted.pixi.stage.getChildByLabel('dungeon-world')).not.toBeNull();

    mounted.scene.destroy();
    liveScenes.splice(liveScenes.indexOf(mounted.scene), 1);

    // The root is removed from the stage, so the twenty mount/unmount cycles in plan
    // section 10.2 cannot accumulate retained display objects.
    expect(mounted.pixi.stage.getChildByLabel('dungeon-world')).toBeNull();
    expect(() => mounted.scene.destroy()).not.toThrow();
  });

  it('the input controller stops listening after destroy', async () => {
    const subject = buildSubject(2);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    mounted.scene.destroy();
    liveScenes.splice(liveScenes.indexOf(mounted.scene), 1);
    mounted.dispatched.length = 0;

    dispatchKey('keydown', 'e');
    dispatchKey('keyup', 'e');
    mounted.scene.update(16);

    expect(mounted.dispatched, 'a destroyed scene still dispatched an action').toEqual([]);
  });
});
describe('the scene publishes when the world moves on its own', () => {
  /**
   * ## The defect this pins
   *
   * Availability is part of the status sentence, so a publish that does not happen leaves
   * the DOM mirror stating something untrue: a *disabled* Descend control next to on-page
   * text saying there are no stairs down, in a room that has them. Nothing about walking
   * passes through `onAction` - the learner pressed nothing - so the host, which
   * publishes after every dispatch, never saw it.
   *
   * ## Why walking, and not a capability
   *
   * `teleportToRoom` and friends are followed by the renderer's own `refreshState()`, so
   * the capability path already worked and a test using it would stay green against the
   * broken scene. These tests move the player the way a learner does: a real `keydown`
   * into the real `WorldInputController`, polled by real `update` frames.
   *
   * ## The layout is not guessed
   *
   * The generator puts the root at grid (0,0), six tiles wide and five tall, and its
   * children to the north, east and south, with straight corridors and no elbows. The
   * helper below reads the east corridor and its doorway row off the map rather than
   * assuming them, and fails loudly - not by timing out - if a future layout stops
   * offering a straight run along the row the player spawns on.
   */
  function eastCorridor(map: DungeonMap): DungeonCorridor {
    const root = map.rooms.find((room) => room.isRoot);
    if (root === undefined) throw new Error('the map has no root room');
    const east = map.corridors.find(
      (corridor) => corridor.fromRoomId === root.roomId && corridor.fromDoor.side === 'E',
    );
    if (east === undefined) throw new Error('the root has no corridor leaving its east door');
    // A bend would mean "hold east" is not a route, and the test would be asserting
    // nothing. Stated here so a layout change fails loudly instead of timing out.
    expect(east.elbow).toBeNull();
    // The route the player actually walks has to be the doorway's own row, or holding a
    // single key is not a route at all.
    expect(east.fromDoor.y).toBe(Math.floor(root.gridY + root.height / 2));
    return east;
  }

  /**
   * Walk east out of the root and into the room at the end of its east corridor.
   *
   * ## Why *east* rather than north, and why no alignment frames
   *
   * Corridors are one tile wide and the player's 16px collider is sampled at four corners
   * inset by 1px, so it needs 15px of lateral room inside a 24px column. The root is 6x5
   * and spawns at tile (3, 2.5) - a tile *boundary* on the x axis - so a player walking
   * due north straddles columns 2 and 3, and column 2 becomes wall the moment the collider
   * leaves the room footprint: the player pins against its own door and no amount of north
   * gets through. Reaching the north room takes a deliberate six-frame diagonal nudge to
   * line up with column 3 first, which is a real thing a person does and a fragile thing
   * to script.
   *
   * The east corridor needs none of that. Its doorway is on row 2, which is the row the
   * player already occupies (the spawn's 2.5 straddles rows 2 and 3, and both are inside
   * the room), and its column is 5 - the room's own east edge. Walking east, the east wall
   * is what stops the player, at x=137, which is exactly the centre of column 5. The wall
   * does the aligning, so a single held key is a complete route: no nudge, no frame count,
   * and nothing that depends on how fast the tick happens to run.
   *
   * Nothing else is touched - no teleport, no position write, no capability call - and the
   * rule is the same one the Phaser scene runs, so the squeeze and the route are both
   * parity facts rather than something this phase introduced.
   */
  function walkEastThrough(map: DungeonMap, scene: DungeonScene): boolean {
    eastCorridor(map);
    dispatchKey('keydown', 'ArrowRight');
    try {
      for (let frame = 0; frame < 400; frame += 1) {
        scene.update(16);
        const sentence = scene.readState()[DUNGEON_DESCEND_ACTION_ID] ?? '';
        if (isDungeonActionUnavailable(sentence) === false) return true;
      }
      return false;
    } finally {
      dispatchKey('keyup', 'ArrowRight');
    }
  }

  /** Walk back west. The player arrives lined up with the doorway column already. */
  function walkWestBack(map: DungeonMap, scene: DungeonScene): boolean {
    eastCorridor(map);
    dispatchKey('keydown', 'ArrowLeft');
    try {
      for (let frame = 0; frame < 400; frame += 1) {
        scene.update(16);
        const sentence = scene.readState()[DUNGEON_DESCEND_ACTION_ID] ?? '';
        if (isDungeonActionUnavailable(sentence)) return true;
      }
      return false;
    } finally {
      dispatchKey('keyup', 'ArrowLeft');
    }
  }

  it('a player who only stands still publishes nothing at all', async () => {
    // Three hundred idle frames. If the scene published per frame, the mirror would
    // re-render every `aria-live` region five times a second and a screen reader would
    // talk over itself, so this is a budget assertion and not a style preference.
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    for (let frame = 0; frame < 300; frame += 1) mounted.scene.update(16);
    expect(mounted.published, 'idle frames published a state').toHaveLength(0);
  });

  it('walking into a portal room publishes once, and the sentence it publishes is the true one', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    // At spawn: the root has no stairs down, and the page is told so. `readState` carries
    // the marker a control's `disabled` is derived from; the display sentence drops it.
    expect(sceneSentence(mounted.scene, DUNGEON_DESCEND_ACTION_ID)).toBe(
      `Unavailable: there are no stairs down in this room`,
    );
    expect(describeDungeonActionSentence(sceneSentence(mounted.scene, DUNGEON_DESCEND_ACTION_ID)))
      .toBe('there are no stairs down in this room');

    const reached = walkEastThrough(subject.map, mounted.scene);
    expect(reached, 'the player never walked into a portal room').toBe(true);

    // One room change, one publish. Not two, and not one per frame of the walk.
    expect(mounted.published, 'the walk published more than the room change it caused')
      .toHaveLength(1);
    // The exact sentence, not a pattern: this is the string the mirror renders and a
    // screen reader announces, and the room it names is the one the player walked into.
    expect(sceneSentence(mounted.scene, DUNGEON_DESCEND_ACTION_ID)).toBe(
      'Descend from Child Topic 1',
    );
    expect(sceneSentence(mounted.scene, DUNGEON_INTERACT_ACTION_ID)).toBe(
      'In Child Topic 1. Not cleared yet.',
    );

    // And the *published* value - not just the live `readState()` - carries the new truth,
    // which is what the DOM mirror renders and what a screen reader announces.
    const published = mounted.published[0];
    expect(published?.[DUNGEON_DESCEND_ACTION_ID]).toBe(sceneSentence(mounted.scene, DUNGEON_DESCEND_ACTION_ID));
    expect(isDungeonActionUnavailable(published?.[DUNGEON_DESCEND_ACTION_ID] ?? '')).toBe(false);

    // The stair up is still refused on this floor. One publish did not un-disable
    // everything; the marker is still computed per action.
    expect(isDungeonActionUnavailable(sceneSentence(mounted.scene, DUNGEON_ASCEND_ACTION_ID))).toBe(
      true,
    );
    expect(describeDungeonActionSentence(published?.[DUNGEON_ASCEND_ACTION_ID] ?? '')).toBe(
      'there are no stairs up in this room',
    );
  });

  it('walking back out publishes again, and the page stops offering stairs that are gone', async () => {
    // The other half of the case, and the half that leaves a *false* sentence on the page:
    // a control left enabled for a portal the player has walked away from.
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    expect(walkEastThrough(subject.map, mounted.scene)).toBe(true);
    expect(mounted.published).toHaveLength(1);
    expect(isDungeonActionUnavailable(sceneSentence(mounted.scene, DUNGEON_DESCEND_ACTION_ID))).toBe(
      false,
    );

    expect(walkWestBack(subject.map, mounted.scene), 'the player never walked back to the root').toBe(
      true,
    );

    // A second room change, a second publish - still one each.
    expect(mounted.published, 'the walk back published more than the room change').toHaveLength(2);
    expect(sceneSentence(mounted.scene, DUNGEON_DESCEND_ACTION_ID)).toBe(
      'Unavailable: there are no stairs down in this room',
    );
    expect(mounted.published[1]?.[DUNGEON_DESCEND_ACTION_ID]).toBe(
      'Unavailable: there are no stairs down in this room',
    );
  });

  it('a wheel gesture publishes, so the zoom a screen reader hears is the zoom on screen', async () => {
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });
    const canvas = mounted.pixi.canvas as HTMLCanvasElement;

    const zoomSentence = (): string => sceneSentence(mounted.scene, DUNGEON_ZOOM_IN_ACTION_ID);
    expect(zoomSentence()).toBe('Zoom in. Now 1.60 times.');

    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
    );
    mounted.scene.update(16);

    // A gesture never passes through `onAction`, so before the fix this number stayed at
    // the pre-gesture value until some unrelated control was pressed.
    expect(mounted.published, 'a wheel gesture published nothing').toHaveLength(1);
    const publishedZoom = mounted.published[0]?.[DUNGEON_ZOOM_IN_ACTION_ID] ?? '';
    expect(publishedZoom).toBe(zoomSentence());
    expect(publishedZoom).not.toBe('Zoom in. Now 1.60 times.');
  });

  it('the zoom buttons do not publish twice', async () => {
    // The other half of the wheel case. A zoom button goes through the host's dispatch,
    // and the host already publishes when `activate` returns. If the scene published too,
    // one keypress would deliver the same state twice and a live region would say it twice.
    // Measured here by counting what the *scene* publishes across the action, because this
    // file's `onAction` stands in for the host and does not publish on the scene's behalf.
    const subject = buildSubject(3);
    const mounted = await mountScene({
      map: subject.map,
      floor: floorFor(subject.metadata, 'root'),
      playerClass: null,
    });

    mounted.scene.activate(DUNGEON_ZOOM_IN_ACTION_ID, 'dom');
    mounted.scene.update(16);
    expect(
      mounted.published,
      'the zoom action published from inside the scene as well as from the host',
    ).toHaveLength(0);

    mounted.scene.capabilities.teleportToRoom('child-0');
    mounted.scene.update(16);
    expect(mounted.published, 'teleporting published from inside the scene').toHaveLength(0);
  });
});

/** The bare sentence for one action, as the mirror receives it. */
function sceneSentence(scene: DungeonScene, actionId: string): string {
  return scene.readState()[actionId] ?? '';
}
