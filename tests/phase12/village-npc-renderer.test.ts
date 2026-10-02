/**
 * The Phase 12 NPC social layer, on both renderers.
 *
 * ## What this file proves, and what it deliberately does not
 *
 * The Pixi half runs against a **real `pixi.js` `Application`**, exactly as
 * `tests/phase11/village-scene.test.ts` does, and drives it with **real** input:
 * `KeyboardEvent`s on the window, the real input controller, the real camera rig, and
 * the real capability port. A scene driven by a fake application would prove the
 * scene's intent; this proves the wiring a learner actually touches.
 *
 * The Phaser half runs the **real `VillageScene` methods** against a scene whose
 * private state is filled in directly. It is a real class, real proximity maths, and
 * real callbacks - what it cannot do is construct a `Phaser.Game`, which jsdom cannot
 * back with a renderer. So the last section is a *wiring* gate over the adapter's
 * source rather than a runtime one, and it says so in its own name.
 *
 * ## Determinism
 *
 * No test in this file depends on `Math.random()` or on wall-clock time. The scene's
 * `npcRandomness` seam injects a constant quote index and a million-millisecond
 * pause, every frame is driven with a fixed delta, and the rosters are supplied
 * rather than inherited. That seam is the reason: an NPC layer whose opening line and
 * wander timing come from ambient randomness cannot be asserted without a seed, and a
 * test that needs a seed is a test that will be flaky.
 *
 * Geometry assertions run against a **reduced-motion** theme, where the idle bob has
 * zero amplitude and a marker's container position *is* its world position. One
 * separate test runs at full motion to assert the bob exists and stays inside its
 * amplitude, so the reduction is a measurement convenience rather than a way of
 * hiding the animation.
 *
 * ## Hermeticity
 *
 * No `dist/`, no network, no commit, `storage: null` so nothing touches
 * `localStorage` on the Pixi path. No learner data: every identifier is an authored
 * NPC or structure id.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Container } from 'pixi.js';

import {
  asPixiApplication,
  createPixiApplication,
  type PixiApplication,
} from '../../src/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile, type WorldSceneInit } from '../../src/renderers/pixi/runtime/types';
import {
  createVillageScene,
  VILLAGE_ACTIONS,
  VILLAGE_INTERACT_ACTION_ID,
  type VillageScene,
} from '../../src/renderers/pixi/village/createVillageScene';
import type { PixiVillageRenderer } from '../../src/renderers/pixi/village/VillageRenderer';
import { VillageScene as PhaserVillageScene } from '../../src/game/scenes/VillageScene';
import type { PhaserVillageRenderer } from '../../src/game/adapters/phaserVillageRenderer';
import {
  NPC_SPEED,
  VILLAGE_MAP,
  VILLAGE_TILE_SIZE,
  type VillageNpc,
  type VillageStructure,
} from '../../src/data/villageLayout';
import type { VillageNpcHost } from '../../src/application/contracts/renderer';
import type { VillageWorldModel } from '../../src/application/contracts/world';
import {
  selectVillageNearbyTargets,
  VILLAGE_ACTION_INTERACT,
  VILLAGE_NEARBY_RANGES,
  type VillageActionInvocation,
} from '../../src/application/contracts/villageNpc';
import type { NpcRandomness } from '../../src/renderers/pixi/village/NpcController';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

/* -------------------------------------------------------------------------- */
/* The action id: one literal, no translation table                            */
/* -------------------------------------------------------------------------- */

/**
 * The DOM control's action id and the scene's own action id are the same string.
 *
 * A compile-time assignment rather than a runtime `toBe`, so the day someone renames
 * one of them `npm run typecheck` fails here instead of a DOM button quietly
 * dispatching an id the scene's action table does not answer to - which is a runtime
 * no-op with no error anywhere.
 */
const PINNED_SCENE_ACTION_ID: typeof VILLAGE_INTERACT_ACTION_ID = VILLAGE_ACTION_INTERACT;

/**
 * Both renderers are `VillageNpcHost`s, statically.
 *
 * This is the assertion that closes the Phaser gap. `readNpcSnapshot` and
 * `invokeAction` are optional on the base `VillageRendererCapabilities`, so an
 * adapter that does not implement them compiles perfectly and a feature-detecting
 * control reads `undefined` at runtime. Extending the narrowed port makes each
 * renderer's declaration fail `npm run typecheck` if either member is removed, and
 * lets a screen depend on `VillageNpcHost` with no detection at all.
 */
const PIXI_VILLAGE_IS_A_NPC_HOST: VillageNpcHost = null as unknown as PixiVillageRenderer;
const PHASER_VILLAGE_IS_A_NPC_HOST: VillageNpcHost = null as unknown as PhaserVillageRenderer;

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const quality = resolveWorldQualityProfile('balanced');

/** Full motion, which is what a learner with no reduced-motion preference sees. */
const fullMotionTheme = resolveCozyWorldTheme({ theme: null, reducedMotion: false });
/** Bob amplitude is exactly zero here, so container position is world position. */
const stillTheme = resolveCozyWorldTheme({ theme: null, reducedMotion: true });

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

/** Randomness that never varies, so a walk is reproducible. */
const FIXED_RANDOMNESS: NpcRandomness = Object.freeze({
  // Long enough that no test frame reaches the next waypoint: a test that wants a
  // pause injects its own, and one that wants travel gets uninterrupted travel.
  waitMs: () => 1_000_000,
});

/** The player spawn every positional test uses, as grid coordinates. */
const SPAWN = { gridX: 5, gridY: 27 } as const;

/**
 * The spawn tile the standing villager is on: three tiles *above* {@link SPAWN}.
 *
 * `ArrowUp` decreases world `y` in this scene, so "above" is the direction a test
 * walks to reach a villager placed three tiles north of the spawn.
 */
const VILLAGER_SPAWN = { gridX: 5, gridY: 24 } as const;
/** A spawn on {@link VILLAGER_SPAWN}'s tile, for "already in range" assertions. */
const ON_VILLAGER = { gridX: 5, gridY: 24 } as const;

/** A world model with the given dynamic portals and no player class. */
function villageWorld(structures: readonly VillageStructure[] = []): VillageWorldModel {
  return { kind: 'village', structures, playerClass: null };
}

/**
 * One NPC record.
 *
 * Default grid is three tiles above the spawn, which is 144 world pixels: further
 * than the shared 32-pixel NPC radius, and close enough that a few dozen frames of a
 * held arrow key cross it. No `path`, so the wander step skips it and it holds still -
 * which is what makes an approach/leave transition assertable to the pixel.
 */
function stationaryNpc(overrides: Partial<VillageNpc> & Pick<VillageNpc, 'id'>): VillageNpc {
  return {
    label: 'Test Villager',
    gridX: VILLAGER_SPAWN.gridX,
    gridY: VILLAGER_SPAWN.gridY,
    greeting: 'Hello there.',
    dialogue: ['First ambient line.', 'Second ambient line.'],
    ...overrides,
  };
}

/** One subject portal centred on the spawn tile, so a structure is always in range. */
function portalOnSpawn(): VillageStructure {
  return {
    id: 'portal-alpha',
    type: 'portal-icon',
    label: 'Alpha',
    gridX: SPAWN.gridX,
    gridY: SPAWN.gridY,
    width: 1,
    height: 1,
    subjectId: 'Alpha',
    subjectName: 'Alpha',
  };
}

interface MountedScene {
  readonly pixi: PixiApplication;
  readonly scene: VillageScene;
  readonly callbacks: {
    onStructureApproached: ReturnType<typeof vi.fn>;
    onStructureLeft: ReturnType<typeof vi.fn>;
    onStructureInteract: ReturnType<typeof vi.fn>;
    onNpcApproached: ReturnType<typeof vi.fn>;
    onNpcLeft: ReturnType<typeof vi.fn>;
    onNpcInteract: ReturnType<typeof vi.fn>;
    onNpcDialogPosition: ReturnType<typeof vi.fn>;
    onReady: ReturnType<typeof vi.fn>;
  };
  /** Every `(actionId, source)` the scene asked the host's dispatch to perform. */
  readonly dispatched: [string, string][];
  readonly capabilities: VillageNpcHost;
  readonly worldLayer: Container;
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

interface MountOptions {
  readonly world?: VillageWorldModel;
  readonly npcs?: readonly VillageNpc[];
  readonly spawn?: { gridX: number; gridY: number };
  /** Freeze the idle bob, so a marker's container position is its world position. */
  readonly still?: boolean;
  /** Record the first dispatch without performing it, as a deferring host would. */
  readonly deferFirstDispatch?: boolean;
}

async function mountScene(options: MountOptions = {}): Promise<MountedScene> {
  const theme = options.still === true ? stillTheme : fullMotionTheme;
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
    onNpcApproached: vi.fn(),
    onNpcLeft: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onReady: vi.fn(),
  };
  const dispatched: [string, string][] = [];
  let deferred = 0;
  let scene!: VillageScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    onAction: (actionId, source) => {
      dispatched.push([actionId, source]);
      if (options.deferFirstDispatch === true && deferred === 0) {
        deferred += 1;
        return;
      }
      scene.activate(actionId, source);
    },
  };
  scene = createVillageScene(pixi, init, {
    world: options.world ?? villageWorld(),
    callbacks,
    storage: null,
    spawn: options.spawn ?? SPAWN,
    npcs: options.npcs,
    npcRandomness: FIXED_RANDOMNESS,
  });
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('village-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');
  const worldLayer = root.getChildByLabel('village-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  // `WorldScene.capabilities` is optional on the port, so a scene is allowed to have
  // none. This one must - and the throw is the assertion that it does, rather than an
  // `!` that would turn a regression into a `TypeError` three assertions later.
  const capabilities = scene.capabilities;
  if (capabilities === undefined) throw new Error('the scene published no capabilities');

  return {
    pixi,
    scene,
    callbacks,
    dispatched,
    capabilities,
    worldLayer,
  };
}

function dispatchKey(type: 'keydown' | 'keyup', key: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

/** Hold a key down for `frames` frames, then release it. */
function hold(scene: VillageScene, key: string, frames: number, deltaMs = 50): void {
  dispatchKey('keydown', key);
  for (let frame = 0; frame < frames; frame += 1) scene.update(deltaMs);
  dispatchKey('keyup', key);
}

/** One named-intent interact from a DOM control, through the capability port. */
function invoke(mounted: MountedScene, invocation: VillageActionInvocation): void {
  mounted.capabilities.invokeAction(invocation);
}

/** A named-NPC interact, which is what a nearby-action row sends. */
function talkTo(mounted: MountedScene, npcId: string): void {
  invoke(mounted, {
    actionId: VILLAGE_ACTION_INTERACT,
    target: { kind: 'npc', id: npcId },
    source: 'dom',
  });
}

/* -------------------------------------------------------------------------- */
/* The scene draws a villager, and every shipped one                            */
/* -------------------------------------------------------------------------- */

describe('the real Pixi scene presents the village roster', () => {
  it('adds one labelled marker per shipped NPC to the real world layer', async () => {
    const mounted = await mountScene({ still: true });

    expect(VILLAGE_MAP.npcs.length).toBeGreaterThan(0);
    for (const npc of VILLAGE_MAP.npcs) {
      const marker = mounted.worldLayer.getChildByLabel(`village-npc:${npc.id}`);
      expect(marker, `no marker for ${npc.id}`).not.toBeNull();
      // On its authored tile, converted by the shared tile size. `still` freezes the
      // idle bob, so the container position *is* the world position here.
      expect(marker?.x).toBe(npc.gridX * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2);
      expect(marker?.y).toBe(npc.gridY * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2);
    }
  });

  it('tears the markers down with the scene, so a remount starts from nothing', async () => {
    const mounted = await mountScene();
    expect(mounted.worldLayer.getChildByLabel('village-npc:keeper')).not.toBeNull();

    mounted.scene.destroy();
    // The layer the markers hung from is gone with the root, and a second destroy is
    // a no-op rather than a second teardown.
    expect(mounted.pixi.stage.getChildByLabel('village-world')).toBeNull();
    expect(() => mounted.scene.destroy()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Proximity                                                                   */
/* -------------------------------------------------------------------------- */

describe('NPC proximity reports the same transitions the Phaser scene does', () => {
  it('approaches on arrival, anchors the dialog, and leaves on walking away', async () => {
    const mounted = await mountScene({ still: true, npcs: [stationaryNpc({ id: 'villager-x' })] });

    mounted.scene.update(0);
    expect(mounted.callbacks.onNpcApproached).not.toHaveBeenCalled();
    expect(mounted.capabilities.readNpcSnapshot().anchor).toBeNull();

    // Walk toward the villager. It is 144 pixels north of the spawn, so ten 50 ms
    // frames of 120 px/s travel 60 pixels and are still outside the 32-pixel radius -
    // which is the assertion a spawn inside the radius would have made vacuous.
    hold(mounted.scene, 'ArrowUp', 10);
    expect(mounted.callbacks.onNpcApproached).not.toHaveBeenCalled();
    expect(
      mounted.capabilities.readNpcSnapshot().nearby.some((row) => row.kind === 'npc'),
    ).toBe(false);

    // Twelve more frames travel 72 pixels, leaving 12 - inside the radius.
    hold(mounted.scene, 'ArrowUp', 12);
    expect(mounted.callbacks.onNpcApproached).toHaveBeenCalledExactlyOnceWith('villager-x');
    // One anchor, published once per approach: the Phaser scene's emit rate.
    expect(mounted.callbacks.onNpcDialogPosition).toHaveBeenCalledTimes(1);
    const anchor = mounted.callbacks.onNpcDialogPosition.mock.calls[0]?.[0];
    expect(anchor?.npcId).toBe('villager-x');
    expect(Number.isFinite(anchor?.clientX)).toBe(true);
    expect(Number.isFinite(anchor?.clientY)).toBe(true);

    // "Walk away and confirm dialogue closes" - the manual Phase 12 check, asserted.
    // The *line* is application state now, so what closes here is the anchor the
    // renderer is responsible for; `onNpcLeft` is the signal the application turns
    // into an emptied bubble. See `village-callbacks-line-selection.test.ts`.
    hold(mounted.scene, 'ArrowUp', 10);
    expect(mounted.callbacks.onNpcLeft).toHaveBeenCalledExactlyOnceWith('villager-x');
    const afterLeaving = mounted.capabilities.readNpcSnapshot();
    expect(afterLeaving.anchor).toBeNull();
    expect(afterLeaving.nearby.some((row) => row.kind === 'npc')).toBe(false);
  });

  it('does not re-announce an NPC that is still in range across many frames', async () => {
    // Spawned on the villager's tile, so the approach happens at construction.
    const mounted = await mountScene({
      still: true,
      npcs: [stationaryNpc({ id: 'villager-x' })],
      spawn: ON_VILLAGER,
    });

    expect(mounted.callbacks.onNpcApproached).toHaveBeenCalledExactlyOnceWith('villager-x');
    for (let frame = 0; frame < 30; frame += 1) mounted.scene.update(16);
    // A proximity check that re-emitted every frame would be an aria-live flood.
    expect(mounted.callbacks.onNpcApproached).toHaveBeenCalledTimes(1);
    expect(mounted.callbacks.onNpcLeft).not.toHaveBeenCalled();
    expect(mounted.callbacks.onNpcDialogPosition).toHaveBeenCalledTimes(1);
  });

  it('measures against the shared radii, not a copy of them', async () => {
    const mounted = await mountScene({
      still: true,
      npcs: [stationaryNpc({ id: 'villager-x' })],
      spawn: ON_VILLAGER,
    });
    const candidate = mounted.capabilities
      .readNpcSnapshot()
      .candidates.find((entry) => entry.kind === 'npc');

    expect(candidate?.range).toBe(VILLAGE_NEARBY_RANGES.npc);
    expect(VILLAGE_NEARBY_RANGES.npc).toBe(32);
    // The player spawned on the villager's tile centre, so the distance is zero.
    expect(candidate?.distance).toBeCloseTo(0, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Wander                                                                      */
/* -------------------------------------------------------------------------- */

describe('wander movement follows the authored path at the shared speed', () => {
  it('moves at NPC_SPEED toward the next waypoint and parks on arrival', async () => {
    const wanderer = stationaryNpc({
      id: 'wanderer-x',
      gridX: 10,
      gridY: 10,
      // Two tiles east, which at NPC_SPEED is a little over four seconds of travel -
      // long enough to measure a speed precisely and to prove it did not teleport.
      path: [{ x: 12, y: 10 }],
    });
    const mounted = await mountScene({ still: true, npcs: [wanderer] });
    const marker = mounted.worldLayer.getChildByLabel('village-npc:wanderer-x');
    if (marker === null) throw new Error('the wanderer drew no marker');

    const startX = marker.x;
    // 60 frames of 16 ms is 0.96 s, so the expected travel is NPC_SPEED * 0.96.
    for (let frame = 0; frame < 60; frame += 1) mounted.scene.update(16);
    const travelled = marker.x - startX;
    const expected = NPC_SPEED * 0.96;

    expect(travelled).toBeGreaterThan(expected * 0.9);
    expect(travelled).toBeLessThan(expected * 1.1);
    // Straight along the authored axis, and nowhere near the destination yet.
    expect(marker.y).toBe(10 * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2);
    expect(marker.x).toBeLessThan(12 * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2);

    // Run long enough to arrive. The pause is injected at a million milliseconds, so
    // the villager walks to within its arrival tolerance of the waypoint and stops.
    for (let frame = 0; frame < 400; frame += 1) mounted.scene.update(16);
    const waypointX = 12 * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2;
    expect(Math.abs(marker.x - waypointX)).toBeLessThanOrEqual(4);
  });

  it('leaves an NPC without a path exactly where it was placed', async () => {
    const mounted = await mountScene({ still: true, npcs: [stationaryNpc({ id: 'villager-x' })] });
    const marker = mounted.worldLayer.getChildByLabel('village-npc:villager-x');
    if (marker === null) throw new Error('the villager drew no marker');
    const start = { x: marker.x, y: marker.y };

    for (let frame = 0; frame < 60; frame += 1) mounted.scene.update(16);
    expect(marker.x).toBeCloseTo(start.x, 6);
    expect(marker.y).toBeCloseTo(start.y, 6);
  });

  it('bobs at full motion and stands still under reduced motion', async () => {
    // Reduced motion is a *decorative* loop being switched off, not a world being
    // switched off: the villagers still walk, they just stop breathing. Both halves of
    // that claim are asserted, because "the animation stopped" is the half that is
    // easy to ship and "the world did not stop" is the half that matters.
    const animated = await mountScene({ npcs: [stationaryNpc({ id: 'villager-x' })] });
    const marker = animated.worldLayer.getChildByLabel('village-npc:villager-x');
    if (marker === null) throw new Error('the villager drew no marker');
    const worldY = 24 * VILLAGE_TILE_SIZE + VILLAGE_TILE_SIZE / 2;

    const samples: number[] = [];
    // 100 frames of 16 ms is 1.6 s, past the 1.5 s bob period, so the samples include
    // a crest and a trough. Sampling less than a full period would only ever see one
    // of them and the bounds below would be unfalsifiable.
    for (let frame = 0; frame < 100; frame += 1) {
      animated.scene.update(16);
      samples.push(marker.y);
    }
    // A three-pixel bob, symmetric about the world position: it moves, and it stays
    // inside its amplitude in both directions.
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(5);
    expect(Math.max(...samples) - worldY).toBeLessThanOrEqual(3 + 1e-6);
    expect(worldY - Math.min(...samples)).toBeLessThanOrEqual(3 + 1e-6);

    const still = await mountScene({ still: true, npcs: [stationaryNpc({ id: 'villager-x' })] });
    const quietMarker = still.worldLayer.getChildByLabel('village-npc:villager-x');
    if (quietMarker === null) throw new Error('the villager drew no marker');
    for (let frame = 0; frame < 60; frame += 1) still.scene.update(16);
    expect(quietMarker.y).toBeCloseTo(worldY, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Dialogue                                                                    */
/* -------------------------------------------------------------------------- */

describe('the renderer reports proximity and does not choose a line', () => {
  /**
   * The behavioural consequence of the contract narrowing, asserted at the altitude
   * where the old behaviour used to live.
   *
   * This controller *did* call `selectVillageNpcLine` - with `questStep: ''`, because a
   * renderer has no quest state - and published the answer as the snapshot's
   * `dialogue`. The Phaser adapter independently did the same. No consumer read the
   * field, and for a scripted NPC the answer was wrong by construction: the Keeper
   * opened on her greeting instead of the tutorial script.
   *
   * So the contract removed `dialogue` and both call sites. What a renderer still owes
   * the application is the *event* - approach, interact, leave - and the anchor. These
   * are the two things it emits, and they are emitted regardless of any quest state.
   */
  it('emits approach, interact and left for an NPC it can see', async () => {
    const wanderer = stationaryNpc({
      id: 'wanderer-x',
      quotes: ['Quote zero.', 'Quote one.', 'Quote two.'],
    });
    const mounted = await mountScene({
      still: true,
      npcs: [wanderer],
      spawn: ON_VILLAGER,
    });

    // Spawned on her tile, so the approach fired during construction.
    expect(mounted.callbacks.onNpcApproached).toHaveBeenCalledExactlyOnceWith('wanderer-x');
    expect(mounted.callbacks.onNpcDialogPosition).toHaveBeenCalledTimes(1);

    // Talking to her is still reported, repeatedly, without the renderer choosing what
    // is said - which is what the application layer's own cursor advances.
    for (let turn = 0; turn < 3; turn += 1) {
      talkTo(mounted, 'wanderer-x');
      expect(mounted.callbacks.onNpcInteract).toHaveBeenCalledTimes(turn + 1);
    }

    hold(mounted.scene, 'ArrowUp', 10);
    expect(mounted.callbacks.onNpcLeft).toHaveBeenCalledExactlyOnceWith('wanderer-x');
  });

  it('publishes no line selection at all, for a scripted NPC either', async () => {
    const keeper = stationaryNpc({
      id: 'keeper',
      label: 'Keeper of Knowledge',
      greeting: 'Welcome, seeker!',
      dialogue: ['Ambient one.', 'Ambient two.'],
      questDialogue: { intro: ['Tutorial line.'], 'meet-keeper': ['You found me!'] },
    });
    const mounted = await mountScene({ still: true, npcs: [keeper], spawn: ON_VILLAGER });

    talkTo(mounted, 'keeper');

    // The snapshot carries measurements and an anchor. There is no `dialogue` key to
    // read even if a consumer wanted one - and the compile-time assertion in
    // `villageNpc.ts` is what makes that a build failure rather than a `undefined`.
    const snapshot = mounted.capabilities.readNpcSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['anchor', 'candidates', 'nearby']);
    expect(snapshot.anchor?.npcId).toBe('keeper');
  });

  it('carries the anchor across the conversation and drops it when the NPC leaves', async () => {
    const mounted = await mountScene({
      still: true,
      npcs: [stationaryNpc({ id: 'villager-x' })],
    });

    // Twenty-two 50 ms frames travel 132 pixels of the 144 that separate the spawn
    // from the villager, so she is in range...
    hold(mounted.scene, 'ArrowUp', 22);
    expect(mounted.capabilities.readNpcSnapshot().anchor).not.toBeNull();

    // ...and ten more walk past her, out of the radius.
    hold(mounted.scene, 'ArrowUp', 10);
    const snapshot = mounted.capabilities.readNpcSnapshot();
    expect(snapshot.anchor).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* readNpcSnapshot                                                             */
/* -------------------------------------------------------------------------- */

describe('readNpcSnapshot is one internally consistent read', () => {
  it('derives nearby from candidates with the contract selector, exactly', async () => {
    const mounted = await mountScene({
      still: true,
      world: villageWorld([portalOnSpawn()]),
      npcs: [stationaryNpc({ id: 'villager-x', gridX: 5, gridY: 28 })],
    });
    // 24 pixels of walking puts the player inside both radii at once.
    hold(mounted.scene, 'ArrowDown', 4);

    const snapshot = mounted.capabilities.readNpcSnapshot();
    // Recomputing the selection by hand must reproduce the host's own rows. This is
    // the "the two fields cannot disagree" claim, checked rather than trusted.
    expect(snapshot.nearby).toEqual(selectVillageNearbyTargets(snapshot.candidates));

    // Every row is traceable to a measurement, with the same rounded distance.
    for (const row of snapshot.nearby) {
      const measured = snapshot.candidates.find(
        (entry) => entry.kind === row.kind && entry.id === row.id,
      );
      expect(measured, `no measurement for ${row.kind}:${row.id}`).toBeDefined();
      expect(row.distance).toBe(Math.round((measured?.distance ?? 0) * 10) / 10);
      expect(row.distance).toBeLessThan(measured?.range ?? 0);
      // The row is a button, not a closure: it names the action the DOM sends.
      expect(row.actionId).toBe(VILLAGE_ACTION_INTERACT);
    }

    // Both kinds are in range here, and the structure row comes first - matching the
    // priority the interact key already has, so the first DOM row is the action a
    // learner would get by pressing the key.
    expect(snapshot.nearby.map((row) => row.kind)).toEqual(['structure', 'npc']);
  });

  it('reports every roster NPC as a measurement, in range or not', async () => {
    const mounted = await mountScene({ still: true });
    const snapshot = mounted.capabilities.readNpcSnapshot();

    const npcIds = snapshot.candidates.filter((entry) => entry.kind === 'npc').map((e) => e.id);
    expect(new Set(npcIds)).toEqual(new Set(VILLAGE_MAP.npcs.map((npc) => npc.id)));
    // Far from all of them, so no NPC row exists even though every measurement does.
    // Raw in, selected out.
    expect(snapshot.nearby.some((row) => row.kind === 'npc')).toBe(false);
  });

  it('reports nothing in range and no dialogue when the player stands alone', async () => {
    const mounted = await mountScene({ still: true, npcs: [] });
    const snapshot = mounted.capabilities.readNpcSnapshot();

    expect(snapshot.nearby).toEqual([]);
    expect(snapshot.anchor).toBeNull();
    // An NPC-less village is still a *value* with a non-empty measurement set, not a
    // special case, so a panel renders nothing rather than branching on `undefined`.
    expect(snapshot.candidates.length).toBeGreaterThan(0);
  });

  it('moves the anchor to the NPC now in range', async () => {
    // One villager one tile *below* the spawn, one two tiles above: walking down then
    // up crosses both radii in turn.
    const mounted = await mountScene({
      still: true,
      npcs: [
        stationaryNpc({ id: 'villager-x', gridX: 5, gridY: 28 }),
        stationaryNpc({ id: 'villager-y', gridX: 5, gridY: 25 }),
      ],
    });

    hold(mounted.scene, 'ArrowDown', 4);
    const first = mounted.capabilities.readNpcSnapshot();
    expect(first.anchor?.npcId).toBe('villager-x');

    // Eighteen 50 ms frames travel 108 pixels: out of the 48-pixel tile below the
    // spawn, and within 32 of the one above it.
    hold(mounted.scene, 'ArrowUp', 18);
    const second = mounted.capabilities.readNpcSnapshot();
    expect(mounted.callbacks.onNpcLeft).toHaveBeenCalledExactlyOnceWith('villager-x');
    expect(mounted.callbacks.onNpcApproached).toHaveBeenLastCalledWith('villager-y');
    // The anchor follows the conversation rather than staying where she said hello.
    expect(second.anchor?.npcId).toBe('villager-y');
  });
});

/* -------------------------------------------------------------------------- */
/* invokeAction: one action, three input paths, one target                     */
/* -------------------------------------------------------------------------- */

describe('invokeAction is the same action as the key and the tap', () => {
  it('routes a DOM intent through the host dispatch, never around it', async () => {
    const mounted = await mountScene({
      still: true,
      npcs: [stationaryNpc({ id: 'villager-x' })],
      spawn: ON_VILLAGER,
    });
    mounted.dispatched.length = 0;

    talkTo(mounted, 'villager-x');

    // One dispatch, with the source reported, and the action performed by the host -
    // so the `aria-live` mirror republishes exactly once, as it does for a key press.
    expect(mounted.dispatched).toEqual([[VILLAGE_INTERACT_ACTION_ID, 'dom']]);
    expect(mounted.callbacks.onNpcInteract).toHaveBeenCalledExactlyOnceWith('villager-x');

    // The keyboard and the touch button are the same id through the same dispatcher,
    // which is what "one action" means.
    dispatchKey('keydown', 'e');
    mounted.scene.update(16);
    dispatchKey('keyup', 'e');
    mounted.capabilities.triggerInteract();
    expect(mounted.dispatched).toEqual([
      [VILLAGE_INTERACT_ACTION_ID, 'dom'],
      [VILLAGE_INTERACT_ACTION_ID, 'keyboard'],
      [VILLAGE_INTERACT_ACTION_ID, 'dom'],
    ]);
    expect(mounted.callbacks.onNpcInteract).toHaveBeenCalledTimes(3);
  });

  it('honours a named NPC even when a structure is what the bare verb would reach', async () => {
    // The Phaser verb resolves a structure first; a *named* intent is honoured when the
    // thing it names is genuinely in range, which is the whole reason a DOM control is
    // allowed to name a target at all.
    const mounted = await mountScene({
      still: true,
      world: villageWorld([portalOnSpawn()]),
      npcs: [stationaryNpc({ id: 'villager-x', gridX: 5, gridY: 28 })],
    });
    hold(mounted.scene, 'ArrowDown', 4);

    // The bare verb, with both in range, takes the structure.
    invoke(mounted, { actionId: VILLAGE_ACTION_INTERACT, target: null, source: 'dom' });
    expect(mounted.callbacks.onStructureInteract).toHaveBeenCalledExactlyOnceWith('portal-alpha');

    // The named intent reaches the villager instead.
    talkTo(mounted, 'villager-x');
    expect(mounted.callbacks.onNpcInteract).toHaveBeenCalledExactlyOnceWith('villager-x');
    expect(mounted.callbacks.onStructureInteract).toHaveBeenCalledTimes(1);
  });

  it('falls back to the nearest interactible when a named target is out of range', async () => {
    const mounted = await mountScene({
      still: true,
      world: villageWorld([portalOnSpawn()]),
      npcs: [
        stationaryNpc({ id: 'villager-x', gridX: 5, gridY: 28 }),
        stationaryNpc({ id: 'villager-y', gridX: 30, gridY: 20 }),
      ],
    });
    hold(mounted.scene, 'ArrowDown', 4);

    // `villager-y` is nowhere near the player. Dropping the request would teach a
    // learner that the control lies; the fallback acts on what *is* in range.
    talkTo(mounted, 'villager-y');
    expect(mounted.callbacks.onNpcInteract).not.toHaveBeenCalled();
    expect(mounted.callbacks.onStructureInteract).toHaveBeenCalledExactlyOnceWith('portal-alpha');
    // And the learner is told what actually happened, not what they asked for.
    expect(mounted.scene.readState()[VILLAGE_INTERACT_ACTION_ID]).toBe('Near Alpha');
  });

  it('falls back to the NPC when there is no structure at all', async () => {
    const mounted = await mountScene({
      still: true,
      npcs: [
        stationaryNpc({ id: 'villager-x', gridX: 5, gridY: 28 }),
        stationaryNpc({ id: 'villager-y', gridX: 30, gridY: 20 }),
      ],
    });
    hold(mounted.scene, 'ArrowDown', 4);

    talkTo(mounted, 'villager-y');
    expect(mounted.callbacks.onNpcInteract).toHaveBeenCalledExactlyOnceWith('villager-x');
  });

  it('does not let a stale intent survive a dispatch that never happened', async () => {
    // A host that defers or declines the dispatch must not leave a named target
    // standing for whichever unrelated interact arrives next.
    const deferred = await mountScene({
      still: true,
      npcs: [
        stationaryNpc({ id: 'villager-x', gridX: 5, gridY: 28 }),
        stationaryNpc({ id: 'villager-y', gridX: 30, gridY: 20 }),
      ],
      deferFirstDispatch: true,
    });
    hold(deferred.scene, 'ArrowDown', 4);

    talkTo(deferred, 'villager-y');
    expect(deferred.callbacks.onNpcInteract).not.toHaveBeenCalled();

    // A later, bare interact is the whole-village verb, not the abandoned intent.
    dispatchKey('keydown', 'e');
    deferred.scene.update(16);
    dispatchKey('keyup', 'e');
    expect(deferred.callbacks.onNpcInteract).toHaveBeenCalledExactlyOnceWith('villager-x');
  });

  it('ignores an action id this scene does not declare', async () => {
    const mounted = await mountScene({
      still: true,
      npcs: [stationaryNpc({ id: 'villager-x' })],
      spawn: ON_VILLAGER,
    });
    mounted.dispatched.length = 0;

    // A stale control from a build that had a second verb must not be forced through
    // an action table this scene owns.
    mounted.capabilities.invokeAction({
      actionId: 'village-inventory' as typeof VILLAGE_ACTION_INTERACT,
      target: null,
      source: 'dom',
    });
    expect(mounted.dispatched).toEqual([]);
    expect(mounted.callbacks.onNpcInteract).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The Phaser scene: the same reads, and the same fallback                       */
/* -------------------------------------------------------------------------- */

/**
 * A `VillageScene` with its private state filled in.
 *
 * The methods under test are pure reads of scene state plus the callback bag, so a
 * scene whose `player`, zones, and NPC sprites are duck-typed exercises the real
 * proximity maths and the real callback ordering. What it cannot do is run a frame:
 * `create()` needs a `Phaser.Game`, and a game needs a renderer jsdom does not have.
 */
function phaserSceneWith(state: {
  player: { x: number; y: number };
  structureIds: readonly string[];
  npcs: readonly { id: string; x: number; y: number }[];
  currentNpcId: string | null;
  currentStructureId: string | null;
}): {
  scene: PhaserVillageScene;
  callbacks: { onStructureInteract: ReturnType<typeof vi.fn>; onNpcInteract: ReturnType<typeof vi.fn> };
} {
  const scene = new PhaserVillageScene();
  const internal = scene as unknown as Record<string, unknown>;

  const callbacks = {
    onStructureInteract: vi.fn(),
    onNpcInteract: vi.fn(),
  };
  internal.callbacks = {
    onStructureApproached: vi.fn(),
    onStructureLeft: vi.fn(),
    onStructureInteract: callbacks.onStructureInteract,
    onNpcInteract: callbacks.onNpcInteract,
    onNpcDialogPosition: vi.fn(),
    onReady: vi.fn(),
  };
  internal.player = state.player;
  internal.currentNpcId = state.currentNpcId;
  internal.currentStructureId = state.currentStructureId;
  internal.allStructures = [
    {
      id: 'keeper-tower',
      type: 'keeper-tower',
      label: "Keeper's Tower",
      gridX: 16,
      gridY: 3,
      width: 2,
      height: 2,
    },
  ];
  internal.structureZones = state.structureIds.map((id) => ({ getData: () => id }));
  internal.npcStates = new Map(
    state.npcs.map((npc) => [npc.id, { sprite: { x: npc.x, y: npc.y } }]),
  );
  internal.cameras = { main: { worldView: { x: 0, y: 0 }, zoom: 1 } };
  internal.game = { canvas: { getBoundingClientRect: () => ({ left: 10, top: 20 }) } };

  return { scene, callbacks };
}

describe('the Phaser scene answers the same contract the Pixi scene does', () => {
  it('measures every zone and every NPC with the shared radii', () => {
    const { scene } = phaserSceneWith({
      player: { x: 100, y: 100 },
      structureIds: ['keeper-tower'],
      npcs: [
        { id: 'keeper', x: 120, y: 100 },
        { id: 'villager-1', x: 100, y: 900 },
      ],
      currentNpcId: 'keeper',
      currentStructureId: null,
    });

    const candidates = scene.readNpcSnapshotCandidates();
    const structure = candidates.find((entry) => entry.kind === 'structure');
    const nearNpc = candidates.find((entry) => entry.id === 'keeper');
    const farNpc = candidates.find((entry) => entry.id === 'villager-1');

    expect(structure?.range).toBe(VILLAGE_NEARBY_RANGES.structure);
    expect(nearNpc?.range).toBe(VILLAGE_NEARBY_RANGES.npc);
    // The label comes from the roster, not from the sprite's file name.
    expect(nearNpc?.label).toBe('Keeper of Knowledge');
    expect(nearNpc?.distance).toBeCloseTo(20, 6);
    // Out of range and still reported: raw in, selected out.
    expect(farNpc?.distance).toBeCloseTo(800, 6);

    // The same selector the Pixi snapshot goes through produces the same list.
    expect(selectVillageNearbyTargets(candidates).map((row) => row.id)).toEqual(['keeper']);
  });

  it('projects the dialog anchor through the camera the emit path uses', () => {
    const { scene } = phaserSceneWith({
      player: { x: 0, y: 0 },
      structureIds: [],
      npcs: [{ id: 'keeper', x: 300, y: 200 }],
      currentNpcId: 'keeper',
      currentStructureId: null,
    });

    // Canvas rect (10, 20) plus the camera-projected sprite position.
    expect(scene.readNpcDialogAnchor()).toEqual({ npcId: 'keeper', clientX: 310, clientY: 220 });
  });

  it('has no anchor when nobody is in range', () => {
    const { scene } = phaserSceneWith({
      player: { x: 0, y: 0 },
      structureIds: [],
      npcs: [{ id: 'keeper', x: 300, y: 200 }],
      currentNpcId: null,
      currentStructureId: null,
    });
    expect(scene.readNpcDialogAnchor()).toBeNull();
  });

  it('honours a named target and falls back when it cannot', () => {
    const { scene, callbacks } = phaserSceneWith({
      player: { x: 0, y: 0 },
      structureIds: ['keeper-tower'],
      npcs: [{ id: 'keeper', x: 10, y: 0 }],
      currentNpcId: 'keeper',
      currentStructureId: 'keeper-tower',
    });

    // Both in range: the named NPC wins, where the bare verb would take the structure.
    scene.triggerInteractWithTarget({ kind: 'npc', id: 'keeper' });
    expect(callbacks.onNpcInteract).toHaveBeenCalledExactlyOnceWith('keeper');
    expect(callbacks.onStructureInteract).not.toHaveBeenCalled();

    // A target nobody is near: the bare verb, not a silent drop.
    scene.triggerInteractWithTarget({ kind: 'npc', id: 'villager-9' });
    expect(callbacks.onStructureInteract).toHaveBeenCalledExactlyOnceWith('keeper-tower');

    // And a null target is that bare verb, which is what the touch button sends.
    scene.triggerInteractWithTarget(null);
    expect(callbacks.onStructureInteract).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/* One owner of line selection                                                 */
/* -------------------------------------------------------------------------- */

describe('neither renderer chooses a line', () => {
  /**
   * The single-owner gate, stated over the two renderer sources.
   *
   * This is the check that could not have existed before the narrowing, and it is the
   * one that matters. Until now the same question - which line does this NPC say next -
   * had three owners: the contract's pure function, called twice by renderers that had
   * no quest step to answer it with, and an inline `open`/`advance` pair in the
   * application layer. Every behavioural test in this file passed while all three
   * disagreed, because each was tested against itself.
   *
   * So this is a source scan, and deliberately so. A renderer that selected a line
   * *correctly* would be indistinguishable from outside, and one that selected it
   * incorrectly only shows up as a diff between what two lanes show - which is the
   * kind of parity that is easy to assert and easy to assert wrongly. Naming the
   * forbidden import is checkable, cheap, and impossible to satisfy by accident.
   *
   * The Pixi controller and the Phaser adapter are checked together on purpose: they
   * are the two copies that had drifted, so a gate that only watched one of them would
   * have been satisfied by the other still drifting.
   */
  const rendererSources = [
    join(process.cwd(), 'src', 'renderers', 'pixi', 'village', 'NpcController.ts'),
    join(process.cwd(), 'src', 'game', 'adapters', 'phaserVillageRenderer.ts'),
  ].map((file) => ({ file, source: readFileSync(file, 'utf8') }));

  it('names neither file as a place that can fail', () => {
    // Non-vacuity: both files were read, and both really did contain the call before
    // the narrowing. Without this, an empty or renamed file would pass the scan below.
    expect(rendererSources.length).toBe(2);
    for (const { file, source } of rendererSources) {
      expect(source.length, file).toBeGreaterThan(0);
    }
  });

  it.each(rendererSources)(
    '$file does not call the line selector at all',
    ({ source }) => {
      // Comments and docs are allowed to *name* the selector - this file's own header
      // explains why the call is gone, and a test that forbade the word would forbid
      // the explanation too. So the scan runs over code with comments stripped.
      const code = stripJsComments(source);
      expect(code).not.toContain('selectVillageNpcLine');
      // The quest-step stand-in that made an empty selection look intentional.
      expect(code).not.toContain('RENDERER_QUEST_STEP');
      expect(code).not.toMatch(/questStep/);
    },
  );

  it('the application layer is the one caller', () => {
    const appSource = readFileSync(
      join(process.cwd(), 'src', 'ui', 'village', 'villageSceneCallbacks.ts'),
      'utf8',
    );
    const code = stripJsComments(appSource);
    // One owner, and it passes the *real* step rather than an empty stand-in.
    expect(code).toContain('selectVillageNpcLine({');
    expect(code).toContain('questStep: useSessionStore.getState().questStep');
  });
});

/**
 * Strip `//` and block comments, leaving string contents intact.
 *
 * Deliberately small: this file's needs are "a name may appear in a doc comment but not
 * in code", and a full parse would be a larger dependency than the rule it serves. A
 * `//` inside a string literal could in principle hide a call from it, which is a
 * limitation of the scan rather than a property of the code.
 */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* -------------------------------------------------------------------------- */
/* The adapter wiring                                                          */
/* -------------------------------------------------------------------------- */

describe('the Phaser adapter closes the optional-port gap', () => {
  const adapterSource = readFileSync(
    join(process.cwd(), 'src', 'game', 'adapters', 'phaserVillageRenderer.ts'),
    'utf8',
  );

  it('implements both members in the object it returns', () => {
    // The regression this section exists to catch: `readNpcSnapshot` and
    // `invokeAction` are optional on the base port, so a build that drops them is
    // green. On the *default* build that means a DOM nearby-action row
    // feature-detects to `undefined` and does nothing, with no error anywhere.
    expect(adapterSource).toMatch(/readNpcSnapshot\(\)\s*:\s*VillageNpcSnapshot/);
    expect(adapterSource).toMatch(/invokeAction\(invocation\s*:\s*VillageActionInvocation\)/);
  });

  it('sources both from the Phaser scene state the section above tested', () => {
    // A wiring gate, not a runtime one: jsdom cannot back a `Phaser.Game`, so the
    // adapter's own composition is asserted by delegation. Each of the three scene
    // methods it names is exercised behaviourally above.
    expect(adapterSource).toContain('scene?.readNpcSnapshotCandidates()');
    expect(adapterSource).toContain('scene?.readNpcDialogAnchor()');
    expect(adapterSource).toContain('scene?.triggerInteractWithTarget(invocation.target)');
    expect(adapterSource).toContain('createVillageNpcSnapshot({');
  });

  it('does not choose a line, so there is one owner of the rule', () => {
    // The gate that replaces the "the selections are the contract's" assertion this
    // used to make. That assertion was true and still let a second implementation
    // through: this adapter called `selectVillageNpcLine` with `questStep: ''`, so it
    // was the contract's function answering a question it could not answer, and the
    // answer was published on the snapshot and read by nobody.
    //
    // So the rule is now inverted. A renderer that mentions the line selector at all
    // is a second owner of the policy, and the source scan is the only place that
    // catches it - the behavioural tests above cannot, because a renderer that
    // selected a line correctly would look identical from outside.
    expect(adapterSource).not.toContain('selectVillageNpcLine');
    // Including the quest-step stand-in that made the empty selection legal.
    expect(adapterSource).not.toContain('RENDERER_QUEST_STEP');
    expect(adapterSource).not.toMatch(/questStep/);
  });

  it('forwards the scene callbacks without wrapping them', () => {
    // The wrapper existed only to maintain the observed conversation cursor. With the
    // snapshot no longer carrying a line, there is nothing to observe, and the bag is
    // passed straight through - so the screen receives the identical payloads from
    // this adapter and from Pixi, with no adapter-side ordering to get wrong.
    expect(adapterSource).toContain('const observedCallbacks: VillageSceneEvents = { ...callbacks };');
    expect(adapterSource).not.toMatch(/onNpcApproached:\s*\(npcId\)\s*=>/);
    expect(adapterSource).not.toMatch(/onNpcInteract:\s*\(npcId\)\s*=>/);
  });

  it('declares the narrowed port, so a removed member fails typecheck', () => {
    expect(adapterSource).toMatch(
      /interface PhaserVillageRenderer extends WorldRenderer, VillageNpcHost/,
    );
    // Referenced so a reader can see the assertions above are about something.
    expect(typeof PHASER_VILLAGE_IS_A_NPC_HOST).toBe('object');
    expect(typeof PIXI_VILLAGE_IS_A_NPC_HOST).toBe('object');
    expect(PINNED_SCENE_ACTION_ID).toBe('village-interact');
  });

  it('declares the interact action the contract names, in the scene action table', () => {
    expect(VILLAGE_ACTIONS.map((action) => action.id)).toContain(VILLAGE_ACTION_INTERACT);
    // The DOM mirror renders exactly this table, so an action that is not in it has
    // no control, and an id that is not pinned is a control that does nothing.
    expect(VILLAGE_ACTIONS).toHaveLength(1);
  });
});
