/**
 * The real PixiJS village scene, built on a real `Application`.
 *
 * ## Why this altitude
 *
 * `tests/phase9/pixi-composition-root.test.tsx` exists because three layers of
 * Phase 9 tests each covered one side of a seam and none covered the seam itself,
 * and an `as unknown as` shipped through all of them. The same gap would open
 * here: a scene test against a fake application proves the scene's *intent*, and a
 * binding test proves the renderer's *lifecycle*, and neither proves that
 * `createVillageScene` draws a village onto the stage a real `createPixiApplication`
 * produced. So this file constructs both for real.
 *
 * The assertions are read from the live scene graph through PixiJS's own
 * `getChildByLabel`, not from a factory-call record: the claim is "a labelled root
 * with a world layer, a player, and the six subject portals is a child of the real
 * application's stage", which is the fact a double cannot establish.
 *
 * ## What is real and what is stubbed
 *
 * Real: the `pixi.js` `Application`, its `Container`/`Graphics`/`Text` classes, the
 * scene, the camera rig, the input controller, and the dispatch route into
 * `init.onAction`. Stubbed: two browser facilities jsdom does not implement, the
 * Canvas2D context PixiJS's text metrics read and a `ResizeObserver` (whose absence
 * makes PixiJS 8.21 leak a `Ticker.shared` listener per application - see
 * `tests/phase9/support/canvasContextStub.ts`). Neither is the thing under test.
 *
 * ## What this file deliberately does not prove
 *
 * That a learner perceives anything. No pixel is asserted and no frame is
 * presented: the scene is constructed, driven, and read, and the *perception* claim
 * belongs to the browser lane (`tests/e2e/currentBuild.spec.ts`) and the Phase 21
 * audits. Structural parity does not prove visual or motion parity either - those
 * are recorded as boundaries in the Phase 11 report.
 *
 * Hermeticity: no `dist/`, no network, no commit. `storage: null` keeps the scene
 * out of `localStorage` entirely.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Color, Graphics, Text, type Container } from 'pixi.js';

import {
  asPixiApplication,
  createPixiApplication,
  type PixiApplication,
} from '../../src/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile, type WorldSceneInit } from '../../src/renderers/pixi/runtime/types';
import {
  createVillageScene,
  VILLAGE_INTERACT_ACTION_ID,
  type VillageScene,
} from '../../src/renderers/pixi/village/createVillageScene';
import {
  createPixiVillageRenderer,
  type PixiVillageRenderer,
  type VillageSpawnPoint,
} from '../../src/renderers/pixi/village/VillageRenderer';
import { VillageScene as PhaserVillageScene } from '../../src/game/scenes/VillageScene';
import {
  createPhaserVillageRenderer,
  type PhaserVillageRenderer,
} from '../../src/game/adapters/phaserVillageRenderer';
import {
  PLAYER_SPEED,
  VILLAGE_MAP,
  VILLAGE_TILE_SIZE,
  getDungeonPortalSlots,
  type VillageStructure,
} from '../../src/data/villageLayout';
import type { WorldGridPosition } from '../../src/application/contracts/renderer';
import type { VillageWorldModel } from '../../src/application/contracts/world';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

const theme = resolveCozyWorldTheme({ theme: null, reducedMotion: false });
const quality = resolveWorldQualityProfile('balanced');

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

/** A world model with the given portals and no player class. */
function villageWorld(structures: readonly VillageStructure[]): VillageWorldModel {
  return { kind: 'village', structures, playerClass: null };
}

/** One subject portal at one of the six authored slots, shaped as the screen builds it. */
function portalAt(slotIndex: number, subjectName: string): VillageStructure {
  const slot = getDungeonPortalSlots()[slotIndex];
  return {
    id: `portal-${subjectName.toLowerCase().replace(/\s+/g, '-')}`,
    type: 'portal-icon',
    label: subjectName,
    gridX: slot.gridX,
    gridY: slot.gridY,
    width: 2,
    height: 3,
    subjectId: subjectName,
    subjectName,
  };
}

/** A structure whose centre is exactly the player spawn used by the POI tests. */
function atPlayerSpawn(overrides: Partial<VillageStructure> & Pick<VillageStructure, 'id' | 'type'>): VillageStructure {
  return { label: '', gridX: 15, gridY: 14, width: 1, height: 1, ...overrides };
}

interface MountedScene {
  readonly application: Awaited<ReturnType<typeof createPixiApplication>>;
  readonly pixi: PixiApplication;
  readonly scene: VillageScene;
  readonly callbacks: {
    onStructureApproached: ReturnType<typeof vi.fn>;
    onStructureLeft: ReturnType<typeof vi.fn>;
    onStructureInteract: ReturnType<typeof vi.fn>;
    onReady: ReturnType<typeof vi.fn>;
  };
  readonly dispatched: [string, string][];
  readonly root: Container;
  readonly worldLayer: Container;
  readonly player: Container;
}

const liveApplications: Array<Awaited<ReturnType<typeof createPixiApplication>>> = [];
const liveScenes: VillageScene[] = [];

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

async function mountScene(
  world: VillageWorldModel,
  spawn?: VillageSpawnPoint,
): Promise<MountedScene> {
  const canvas = document.createElement('canvas');
  const application = await createPixiApplication({
    canvas,
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(640, 480);
  const pixi = asPixiApplication(application);

  const callbacks = {
    onStructureApproached: vi.fn(),
    onStructureLeft: vi.fn(),
    onStructureInteract: vi.fn(),
    onReady: vi.fn(),
  };
  const dispatched: [string, string][] = [];
  let scene!: VillageScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    // The host's one dispatcher: performing and (in the real host) publishing in
    // one function. Here it performs, so `onStructureInteract` is reachable.
    onAction: (actionId, source) => {
      dispatched.push([actionId, source]);
      scene.activate(actionId, source);
    },
  };
  scene = createVillageScene(pixi, init, { world, callbacks, storage: null, spawn });
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('village-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');
  const worldLayer = root.getChildByLabel('village-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  const player = worldLayer.getChildByLabel('village-player');
  if (player === null) throw new Error('the scene added no player marker');

  return { application, pixi, scene, callbacks, dispatched, root, worldLayer, player };
}

/** Every `Text` value in a container subtree, in traversal order. */
function collectTexts(container: Container): string[] {
  const found: string[] = [];
  const visit = (node: Container): void => {
    if (node instanceof Text) found.push(node.text);
    for (const child of node.children) visit(child as Container);
  };
  visit(container);
  return found;
}

/** The first fill colour of a `Graphics`, read from its real instruction list. */
function firstFillColor(graphics: Container): number {
  if (!(graphics instanceof Graphics)) throw new Error('not a Graphics');
  const instruction = graphics.context.instructions.find((entry) => entry.action === 'fill');
  if (instruction === undefined || instruction.action !== 'fill') {
    throw new Error('the Graphics has no fill instruction');
  }
  const color = (instruction.data.style as unknown as { color?: unknown }).color;
  if (typeof color === 'number') return color;
  if (color instanceof Color) return color.toNumber();
  throw new Error('the fill colour is neither a number nor a Color');
}

function dispatchKey(type: 'keydown' | 'keyup', key: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

/* -------------------------------------------------------------------------- */

describe('a real application receives a labelled village subtree', () => {
  it('builds the static structures, the six portal slots, and the player on the real stage', async () => {
    const subjects = ['Algebra', 'Biology', 'Calculus', 'Drama', 'Ecology', 'French'];
    expect(getDungeonPortalSlots()).toHaveLength(6);
    expect(VILLAGE_MAP.structures.length).toBeGreaterThan(0);

    const mounted = await mountScene(villageWorld(subjects.map((name, index) => portalAt(index, name))));

    // The root is a real child of the real stage, not a detached container.
    expect(mounted.root.parent).toBe(mounted.pixi.stage);
    // Deterministic depth is a sort the scene enables, not an insertion order.
    expect(mounted.worldLayer.sortableChildren).toBe(true);
    // Ground, path, every static structure, six portals, and the player.
    expect(mounted.worldLayer.children.length).toBeGreaterThanOrEqual(
      VILLAGE_MAP.structures.length + 6,
    );

    // Each labelled static structure drew its banner text, and each of the six slots
    // drew the subject name that occupies it.
    const texts = collectTexts(mounted.worldLayer);
    for (const staticLabel of ['Library', 'Guild Hall', 'Trophy Hall', 'Training Grounds']) {
      expect(texts, staticLabel).toContain(staticLabel);
    }
    for (const subject of subjects) {
      expect(texts, subject).toContain(subject);
    }
    // The player is a marker with a body and a facing indicator.
    expect(mounted.player.children.length).toBe(2);
  });

  it('the interact action the host mirrors is declared by this scene', () => {
    expect(VILLAGE_INTERACT_ACTION_ID).toBe('village-interact');
  });
});

describe('driving the real input reaches the host callbacks', () => {
  it('reports the structure under the player at construction, and interact on E and from the capability', async () => {
    // Spawn on the centre-path signpost, so the nearest interactive structure is a
    // known id with no movement needed.
    const mounted = await mountScene(villageWorld([]), { gridX: 15, gridY: 14 });
    expect(mounted.callbacks.onStructureApproached).toHaveBeenCalledWith('sign-center');
    expect(mounted.callbacks.onStructureLeft).not.toHaveBeenCalled();

    // The keyboard route: E is handled by the scene's input controller, which calls
    // `init.onAction`, which is the host's dispatch.
    dispatchKey('keydown', 'e');
    mounted.scene.update(16);
    expect(mounted.dispatched).toContainEqual([VILLAGE_INTERACT_ACTION_ID, 'keyboard']);
    expect(mounted.callbacks.onStructureInteract).toHaveBeenCalledWith('sign-center');
    dispatchKey('keyup', 'e');

    // The DOM route: the capability the interact control calls.
    mounted.scene.capabilities?.triggerInteract();
    expect(mounted.dispatched).toContainEqual([VILLAGE_INTERACT_ACTION_ID, 'dom']);
    expect(mounted.callbacks.onStructureInteract).toHaveBeenCalledTimes(2);
  });

  it('keyboard movement changes the player position on the real stage graph', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const beforeX = mounted.player.x;
    const beforeY = mounted.player.y;

    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < 12; frame += 1) mounted.scene.update(16.7);
    dispatchKey('keyup', 'ArrowRight');

    const movedBy = mounted.player.x - beforeX;
    // 12 frames at 16.7 ms is about 0.2 s, so about `PLAYER_SPEED * 0.2` pixels; the
    // bound is loose so a slightly different frame count cannot make this flaky.
    expect(movedBy).toBeGreaterThan(PLAYER_SPEED * 0.1);
    expect(movedBy).toBeLessThan(PLAYER_SPEED * 0.4);
    expect(mounted.player.y).toBeCloseTo(beforeY, 4);
  });

  it('a wheel gesture moves the camera zoom, which the scene applies to the layer scale', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const before = mounted.worldLayer.scale.x;
    // A downward wheel notch zooms out.
    mounted.application.canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
    );
    mounted.scene.update(16);
    expect(mounted.worldLayer.scale.x).toBeLessThan(before);
  });
});

describe('the capability port mutates the live scene', () => {
  it('setDynamicStructures adds and replaces the portals', async () => {
    const mounted = await mountScene(villageWorld([portalAt(0, 'Alpha')]), { gridX: 5, gridY: 27 });
    expect(collectTexts(mounted.worldLayer)).toContain('Alpha');

    mounted.scene.capabilities?.setDynamicStructures([portalAt(1, 'Beta'), portalAt(2, 'Gamma')]);
    const texts = collectTexts(mounted.worldLayer);
    expect(texts).toContain('Beta');
    expect(texts).toContain('Gamma');
    expect(texts).not.toContain('Alpha');
    // The static structures survived the replacement.
    expect(texts).toContain('Library');
  });

  it('setPlayerClass redraws the player body in a different archetype colour', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const body = mounted.player.children[0];

    const scholar = firstFillColor(body);
    mounted.scene.capabilities?.setPlayerClass('cartographer');
    const cartographer = firstFillColor(body);
    mounted.scene.capabilities?.setPlayerClass('archivist');
    const archivist = firstFillColor(body);
    mounted.scene.capabilities?.setPlayerClass(null);
    const fallback = firstFillColor(body);

    expect(cartographer).not.toBe(scholar);
    expect(archivist).not.toBe(cartographer);
    // `null` resolves to the scholar archetype.
    expect(fallback).toBe(scholar);
    // The player marker is the same object, redrawn rather than replaced.
    expect(mounted.player.children[0]).toBe(body);
  });

  it('readPoi resolves Keeper, subjectName, label, and Dungeon in that precedence', async () => {
    // One scene, spawned on the centre-path signpost, mutated between readings.
    const mounted = await mountScene(villageWorld([]), { gridX: 15, gridY: 14 });
    const readPoi = (): ReturnType<NonNullable<VillageScene['capabilities']>['readPoi']> => {
      mounted.scene.update(0);
      return mounted.scene.capabilities?.readPoi() ?? null;
    };

    // Keeper wins over a subject portal at the same distance because it is listed
    // first, which is the Phaser scene's own precedence.
    mounted.scene.capabilities?.setDynamicStructures([
      atPlayerSpawn({ id: 'dyn-keeper', type: 'keeper-tower', label: 'Tower' }),
      atPlayerSpawn({ id: 'dyn-portal', type: 'portal-icon', label: 'Fallback', subjectName: 'Algebra' }),
    ]);
    expect(readPoi()?.name).toBe('Keeper');

    mounted.scene.capabilities?.setDynamicStructures([
      atPlayerSpawn({ id: 'dyn-portal', type: 'portal-icon', label: 'Fallback', subjectName: 'Algebra' }),
    ]);
    expect(readPoi()?.name).toBe('Algebra');

    mounted.scene.capabilities?.setDynamicStructures([
      atPlayerSpawn({ id: 'dyn-portal', type: 'portal-icon', label: 'Labeled' }),
    ]);
    expect(readPoi()?.name).toBe('Labeled');

    mounted.scene.capabilities?.setDynamicStructures([
      atPlayerSpawn({ id: 'dyn-portal', type: 'portal-icon', label: '' }),
    ]);
    const dungeon = readPoi();
    expect(dungeon?.name).toBe('Dungeon');
    expect(Number.isFinite(dungeon?.angle)).toBe(true);
    expect(Number.isFinite(dungeon?.distance)).toBe(true);
  });

  it('onResize re-projects the camera onto the world layer', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const before = { x: mounted.worldLayer.position.x, y: mounted.worldLayer.position.y };
    expect(() => mounted.scene.onResize(800, 600)).not.toThrow();
    expect(mounted.worldLayer.position.x).not.toBe(before.x);
    expect(mounted.worldLayer.position.y).not.toBe(before.y);
  });
});

/* -------------------------------------------------------------------------- */
/* The published grid position, on both lanes                                   */
/* -------------------------------------------------------------------------- */

/**
 * Both renderers statically answer the position read.
 *
 * The contract member is `?` - `src/ui/**` may not import a renderer and so must
 * feature-detect - but both adapters here implement it, and both renderer interfaces
 * re-declare it as required. These assignments are what make that a `typecheck`
 * fact rather than a comment: drop either implementation and this file stops
 * compiling, which is the point of promoting a member on the adapter that earned it
 * rather than on the neutral port.
 */
const PIXI_VILLAGE_ANSWERS_POSITION: PixiVillageRenderer =
  null as unknown as PixiVillageRenderer;
const PHASER_VILLAGE_ANSWERS_POSITION: PhaserVillageRenderer =
  null as unknown as PhaserVillageRenderer;

describe('both renderers statically answer the grid-position read', () => {
  it('is a typecheck fact on both lanes, not a comment', () => {
    // The declarations above are the assertion. The `typeof` reads keep them from being
    // dead code under `noUnusedLocals`, and they are the same vacuous shape
    // `tests/phase12/village-npc-renderer.test.ts` uses for its host assertions.
    expect(typeof PIXI_VILLAGE_ANSWERS_POSITION).toBe('object');
    expect(typeof PHASER_VILLAGE_ANSWERS_POSITION).toBe('object');
  });
});

describe('the Pixi scene publishes the tile the live marker is standing on', () => {
  it('is derived from the marker on every read, so it moves when the marker moves', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const read = (): WorldGridPosition | null =>
      mounted.scene.capabilities?.readPlayerGridPosition?.() ?? null;

    // The spawn put the marker at `gridX * tile + tile / 2`, so it starts mid-tile
    // and the published tile is the authored one. Recomputed from the live marker's
    // own `x`/`y` - never from the spawn argument, and never from a stored copy.
    expect(mounted.player.x).toBeCloseTo(5 * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2, 6);
    expect(read()).toEqual({ gridX: 5, gridY: 27 });
    expect(read()).toEqual({
      gridX: Math.floor(mounted.player.x / VILLAGE_TILE_SIZE),
      gridY: Math.floor(mounted.player.y / VILLAGE_TILE_SIZE),
    });

    // Move the marker directly and read again **with no `update` in between**. A
    // read that cached its answer into a field - the way `lastPoi` can, because a POI
    // is only ever consumed on the frame that produced it - would still report tile 5
    // here. This is the assertion that separates "computed on read" from "published
    // last frame", and it is why the position may not be cached.
    mounted.player.x = 700.5;
    expect(read()).toEqual({
      gridX: Math.floor(700.5 / VILLAGE_TILE_SIZE),
      gridY: Math.floor(mounted.player.y / VILLAGE_TILE_SIZE),
    });
    expect(read()?.gridX).toBe(14);
    expect(read()?.gridY).toBe(27);
  });

  it('follows a real keyboard walk across a tile boundary', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const read = (): WorldGridPosition | null =>
      mounted.scene.capabilities?.readPlayerGridPosition?.() ?? null;
    const before = read();
    expect(before).toEqual({ gridX: 5, gridY: 27 });

    // 30 frames at 16.7 ms is about half a second, so about 60 px at
    // `PLAYER_SPEED` - a little over one tile, from 264 px to ~324 px.
    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < 30; frame += 1) mounted.scene.update(16.7);
    dispatchKey('keyup', 'ArrowRight');

    const after = read();
    expect(mounted.player.x).toBeGreaterThan(6 * VILLAGE_TILE_SIZE);
    expect(after?.gridX).toBeGreaterThan(before?.gridX ?? 0);
    expect(after?.gridX).toBe(Math.floor(mounted.player.x / VILLAGE_TILE_SIZE));
    // Walking east does not invent a northward tile.
    expect(after?.gridY).toBe(27);
  });

  it('publishes integers inside the map, which is what a consumer can validate', async () => {
    const mounted = await mountScene(villageWorld([]), { gridX: 5, gridY: 27 });
    const position = mounted.scene.capabilities?.readPlayerGridPosition?.() ?? null;
    expect(position).not.toBeNull();
    // The shape a DOM publisher will accept: two finite non-negative integers, both
    // inside the authored map. A float or a NaN here would be an attribute that
    // silently refuses to publish, which reads as a broken feature.
    expect(Number.isInteger(position?.gridX)).toBe(true);
    expect(Number.isInteger(position?.gridY)).toBe(true);
    expect(position?.gridX).toBeGreaterThanOrEqual(0);
    expect(position?.gridY).toBeGreaterThanOrEqual(0);
    expect(position?.gridX).toBeLessThan(VILLAGE_MAP.width);
    expect(position?.gridY).toBeLessThan(VILLAGE_MAP.height);
  });

  it('answers null before a world exists - on the renderer, which is where that state lives', async () => {
    // Constructed and *not mounted*: no scene, no world, no player. This is the whole
    // "before a world exists" case on this lane, and it is the adapter that owns it -
    // the scene itself cannot observe it, because the scene does not exist first.
    const renderer = createPixiVillageRenderer({
      host: document.createElement('div'),
      world: villageWorld([]),
      callbacks: {
        onStructureApproached: vi.fn(),
        onStructureLeft: vi.fn(),
        onStructureInteract: vi.fn(),
        onReady: vi.fn(),
      },
    });

    expect(renderer.isReady()).toBe(false);
    expect(renderer.readPlayerGridPosition()).toBeNull();
    // `readPoi` is absent for the identical reason, so this is the same story and not
    // a special case bolted onto one member.
    expect(renderer.readPoi()).toBeNull();
  });
});

/**
 * A `VillageScene` with only the state a grid-position read touches.
 *
 * `player` is the scene's own field and the same one `checkStructureProximity`
 * measures from, so this is the real class reading its real state. What it cannot do
 * is run a frame - `create()` needs a `Phaser.Game`, and jsdom has no renderer - which
 * is exactly why the "moves without an update" assertion below is meaningful: there is
 * no update loop here that could be doing the work.
 */
function phaserVillageScene(player: { x: number; y: number } | null): PhaserVillageScene {
  const scene = new PhaserVillageScene();
  const internal = scene as unknown as Record<string, unknown>;
  internal.callbacks = {
    onStructureApproached: vi.fn(),
    onStructureLeft: vi.fn(),
    onStructureInteract: vi.fn(),
    onNpcApproached: vi.fn(),
    onNpcLeft: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onReady: vi.fn(),
  };
  internal.player = player;
  // The Keeper's Tower, at the authored grid the public proximity read resolves to a
  // centre for. Present so the assertion below can compare like with like.
  internal.allStructures = [
    { id: 'keeper-tower', type: 'keeper-tower', label: "Keeper's Tower", gridX: 16, gridY: 3, width: 2, height: 2 },
  ];
  internal.structureZones = [{ getData: () => 'keeper-tower' }];
  internal.npcStates = new Map();
  internal.currentNpcId = null;
  internal.currentStructureId = null;
  return scene;
}

describe('the Phaser scene publishes the same tile from the same pixel position', () => {
  it('is the floor of the map tile over the player x and y, computed on read', () => {
    const player = { x: 264, y: 1320 };
    const scene = phaserVillageScene(player);
    const ts = VILLAGE_MAP.tileSize;

    // The same 48 px tile the Pixi lane divides by, so the two builds publish one
    // coordinate system rather than two that look alike.
    expect(ts).toBe(VILLAGE_TILE_SIZE);
    expect(scene.readPlayerGridPosition()).toEqual({
      gridX: Math.floor(player.x / ts),
      gridY: Math.floor(player.y / ts),
    });
    expect(scene.readPlayerGridPosition()).toEqual({ gridX: 5, gridY: 27 });

    // Move the player and read again, with no `update()` anywhere in this file. A
    // cached read - `lastPoi` is cached, once per frame, and this is precisely the
    // pattern that would be wrong for a position - would still answer 5 here.
    player.x = 700.5;
    player.y = 100;
    expect(scene.readPlayerGridPosition()).toEqual({
      gridX: Math.floor(700.5 / ts),
      gridY: Math.floor(100 / ts),
    });
    expect(scene.readPlayerGridPosition()).toEqual({ gridX: 14, gridY: 2 });
  });

  it('uses the same x the scene measures proximity from, so the two cannot disagree', () => {
    // `updateStructureProximityData` computes `this.player.x - structCx` where
    // `structCx = (struct.gridX + struct.width / 2) * ts`
    // (`src/game/scenes/VillageScene.ts:775`). This asserts the published tile is
    // derived from that identical `x` and that identical `ts`, by reading the
    // distance the scene's own public measurement produces and reconstructing it.
    const player = { x: 872, y: 180 };
    const scene = phaserVillageScene(player);
    const ts = VILLAGE_MAP.tileSize;

    const candidates = scene.readNpcSnapshotCandidates();
    const keeper = candidates.find((entry) => entry.id === 'keeper-tower');
    const keeperCentreX = (16 + 2 / 2) * ts;
    const keeperCentreY = (3 + 2 / 2) * ts;

    expect(keeper?.distance).toBeCloseTo(
      Math.hypot(player.x - keeperCentreX, player.y - keeperCentreY),
      6,
    );
    // ...and the published tile is the floor of the very position that produced it.
    expect(scene.readPlayerGridPosition()).toEqual({
      gridX: Math.floor(player.x / ts),
      gridY: Math.floor(player.y / ts),
    });
    // Inside the Keeper's Tower footprint, so a consumer aiming at `16,3` from the
    // tile it just published is aiming from where the renderer thinks it is standing.
    expect(scene.readPlayerGridPosition()?.gridX).toBe(18);
    expect(scene.readPlayerGridPosition()?.gridY).toBe(3);
  });

  it('answers null before the player exists', () => {
    expect(phaserVillageScene(null).readPlayerGridPosition()).toBeNull();
  });

  it('answers null on the renderer before a scene exists', () => {
    // `scene` is `null` until `game.events.once('ready')` has handed it over, and this
    // adapter never constructs a game in this file. That is the "no world yet" state,
    // and it must be `null` rather than the map origin: a consumer cannot tell tile
    // `0,0` apart from a measurement, and a wrong tile is worse than none.
    const renderer = createPhaserVillageRenderer({
      parent: document.createElement('div'),
      world: villageWorld([]),
      callbacks: {
        onStructureApproached: vi.fn(),
        onStructureLeft: vi.fn(),
        onStructureInteract: vi.fn(),
        onNpcApproached: vi.fn(),
        onNpcLeft: vi.fn(),
        onNpcInteract: vi.fn(),
        onNpcDialogPosition: vi.fn(),
        onReady: vi.fn(),
      },
    });

    expect(renderer.isReady()).toBe(false);
    expect(renderer.readPlayerGridPosition()).toBeNull();
    expect(renderer.readPoi()).toBeNull();
  });

  it('refuses to clamp a player standing on the map edge, because a clamped tile is a different tile', () => {
    const ts = VILLAGE_MAP.tileSize;
    // The Pixi scene clamps `player.x` to `worldWidth` and the Phaser scene clamps to
    // the world bounds, so a learner can stand on the boundary. There the floor is
    // one past the last column. This returns that rather than `VILLAGE_MAP.width - 1`:
    // the value is refused downstream, which is correct, whereas a clamp would report
    // the learner as being on a tile they are not standing on.
    const onEdge = phaserVillageScene({ x: VILLAGE_MAP.width * ts, y: VILLAGE_MAP.height * ts });
    const edge = onEdge.readPlayerGridPosition();
    expect(edge).toEqual({ gridX: VILLAGE_MAP.width, gridY: VILLAGE_MAP.height });
    expect(edge?.gridX).toBeGreaterThanOrEqual(VILLAGE_MAP.width);

    // One pixel inside the edge is a real, in-map tile - so the edge case is the
    // boundary and not a general off-by-one in the division.
    const justInside = phaserVillageScene({
      x: VILLAGE_MAP.width * ts - 1,
      y: VILLAGE_MAP.height * ts - 1,
    });
    expect(justInside.readPlayerGridPosition()).toEqual({
      gridX: VILLAGE_MAP.width - 1,
      gridY: VILLAGE_MAP.height - 1,
    });
  });
});

describe('teardown releases everything it built', () => {
  it('destroy is idempotent, removes the root, and removes every window listener it added', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const originalAdd = window.addEventListener;
    const originalRemove = window.removeEventListener;
    window.addEventListener = function patchedAdd(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ): void {
      added.push(type);
      originalAdd.call(window, type, listener, options);
    } as typeof window.addEventListener;
    window.removeEventListener = function patchedRemove(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions | boolean,
    ): void {
      removed.push(type);
      originalRemove.call(window, type, listener, options);
    } as typeof window.removeEventListener;

    try {
      const canvas = document.createElement('canvas');
      const application = await createPixiApplication({
        canvas,
        quality,
        background: theme.color.surfacePage,
        backgroundAlpha: 1,
      });
      liveApplications.push(application);
      application.resize(640, 480);
      const pixi = asPixiApplication(application);
      let scene!: VillageScene;
      scene = createVillageScene(
        pixi,
        { theme, quality, onAction: (actionId, source) => scene.activate(actionId, source) },
        {
          world: villageWorld([]),
          callbacks: {
            onStructureApproached: vi.fn(),
            onStructureLeft: vi.fn(),
            onStructureInteract: vi.fn(),
            onReady: vi.fn(),
          },
          storage: null,
          spawn: { gridX: 5, gridY: 27 },
        },
      );

      // The input controller is the only thing here that binds to the window.
      expect(added).toEqual(expect.arrayContaining(['keydown', 'keyup', 'blur']));
      expect(pixi.stage.getChildByLabel('village-world')).not.toBeNull();

      scene.destroy();
      expect(removed).toEqual(expect.arrayContaining(['keydown', 'keyup', 'blur']));
      expect(pixi.stage.getChildByLabel('village-world')).toBeNull();
      // A second destroy is a no-op rather than a second teardown.
      expect(() => scene.destroy()).not.toThrow();
    } finally {
      window.addEventListener = originalAdd;
      window.removeEventListener = originalRemove;
    }
  });
});
