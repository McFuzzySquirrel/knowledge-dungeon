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
import type { VillageSpawnPoint } from '../../src/renderers/pixi/village/VillageRenderer';
import {
  PLAYER_SPEED,
  VILLAGE_MAP,
  getDungeonPortalSlots,
  type VillageStructure,
} from '../../src/data/villageLayout';
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
