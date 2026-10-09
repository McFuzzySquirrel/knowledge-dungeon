/**
 * Phase 21, renderer half: reduced motion means *nothing decorative keeps moving*.
 *
 * ## What the exit criterion says, and why this file is shaped around it
 *
 * The plan's criterion is one sentence: **"Reduced-motion mode has no continuous decorative
 * movement."** Not "shorter movement", not "less movement", and - the part that matters -
 * not "movement small enough to be hard to notice". A loop that keeps running at a
 * thousandth of its speed is still running: it still burns frames, it still holds a ticker
 * alive, and a learner who turns the preference on is asking for a still picture, not for a
 * quieter one.
 *
 * So every assertion in this file is an **observable-pose** assertion rather than a flag
 * assertion. `motion.reduced === true` is trivially true after `resolveMotionProfile(true)`,
 * so a test that reads it proves nothing about whether anything stopped. What this file reads
 * instead is where each decoration *is*, frame after frame: a bird's `x`, a villager's `y`, a
 * rod's `rotation`, a bucket glyph's `scale`, a camera's centre. If a loop is running, one of
 * those numbers moves.
 *
 * ## The Phase 19 filter-based-Off shape this file is written to reject
 *
 * A flag that is set while the loop still runs passes every test a reader can write about the
 * flag and fails the trace. The Phase 21 audit found exactly that shape twice in this tree -
 * the village and dungeon camera follow, and the fishing bucket glyph's pop-in - and each is
 * asserted here in the form that catches it.
 *
 * ## Every "it stopped" assertion has a "it was moving" control beside it
 *
 * A reduced-motion test that only ever asserts stillness passes against a world that never
 * animated anything at all, which is a world that would fail the *opposite* requirement. So
 * each pair below is the same world, the same frames, the same read, with motion allowed - and
 * the control asserts movement. A file whose controls fail is the only kind that means
 * anything here.
 *
 * ## The one thing that keeps moving, pinned on purpose
 *
 * **NPC patrol.** `NpcController.moveNpcs` walks each villager along its authored path
 * whether or not the learner touches anything, and Phase 21 leaves it running under reduced
 * motion. A villager's position is *world state*, not decoration: `readNpcSnapshot` and
 * `selectVillageNearbyTargets` measure against it, so freezing patrol would strand any
 * villager who started out of range permanently - and would remove the nearby-action rows
 * Phase 12 exists to provide. A reduced-motion village nobody can be talked to is not an
 * accessible one.
 *
 * That is a judgement, so it is pinned by a test rather than left to a comment: the
 * "stillness" assertions below mount a **path-less roster**, which removes patrol from the
 * experiment and leaves only the decorations, and a separate test asserts that the shipped
 * roster's patrol still runs. Both facts are therefore enforced rather than assumed.
 *
 * **Not asserted:** the fishing machine's `tick`, which still advances the pond's own clock -
 * the bite window is a real deadline, not decoration.
 *
 * Hermeticity: synthetic worlds, pinned dates, pinned frame deltas, no `dist/`, no network,
 * and no real clock. jsdom lacks exactly two facilities and both are stubbed by the shared
 * Phase 9 support module - the Canvas2D context PixiJS text metrics read, and the
 * `ResizeObserver` whose absence makes PixiJS 8.21 leak a `Ticker.shared` listener per
 * application.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Container } from 'pixi.js';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonMap } from '@/core/layout/dungeonTypes';
import type { DungeonMetadata } from '@/core/validation/persistence';
import type { FloorVisibilityModel, VillageWorldModel } from '@/application/contracts/world';
import { VILLAGE_DEPTH, VILLAGE_MAP, type VillageNpc } from '@/data/villageLayout';
import {
  asPixiApplication,
  createPixiApplication,
  type PixiApplication,
} from '@/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile, type WorldSceneInit } from '@/renderers/pixi/runtime/types';
import { createVillageScene, type VillageScene } from '@/renderers/pixi/village/createVillageScene';
import { createDungeonScene, type DungeonScene } from '@/renderers/pixi/dungeon/createDungeonScene';
import type { DungeonSceneCallbacks } from '@/renderers/pixi/dungeon/DungeonRenderer';
import { createFishingScene, type FishingScene } from '@/renderers/pixi/fishing/createFishingScene';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const FRAME_MS = 100;
/** Long enough for any sine in these worlds to have moved somewhere observable. */
const FRAMES = 30;
const NOW = '2026-01-01T00:00:00.000Z';
const SESSION_DATE = '2026-01-01';
/**
 * The dungeon viewport, and why it is this small.
 *
 * The camera rig clamps its centre to the world bounds, and that clamp is capable of hiding
 * the very thing these tests measure: with a viewport wide enough for the clamped band to
 * swallow the player's position, a snapped camera and an eased one report the *same* centre
 * and the easing assertion becomes unfalsifiable. Two things keep the band clear - a
 * twelve-room subject, whose 1680-by-1512 pixel bounding box is comfortably larger than the
 * view, and a 320-by-240 viewport, whose half-view is 100 pixels at the dungeon's inside-room
 * zoom. The player's reachable rig x of 1320 then sits well inside the range, so the centre
 * the camera reports is the centre it chose rather than the one the clamp imposed.
 */
const DUNGEON_VIEWPORT = { width: 320, height: 240 } as const;
/** Enough rooms that the camera has somewhere to be clamped *to* only at the far edge. */
const DUNGEON_SUBJECT_ROOMS = 12;

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

/* ── Scene-graph reading ───────────────────────────────────────────────────── */

/** One display object's pose: the six numbers a decorative loop can change. */
interface Pose {
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly alpha: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * Every display object under `root`, as a pose, in traversal order.
 *
 * The layer itself is included, because a camera that eases moves `world.position` and
 * `world.scale` and nothing below it - reading only the leaves would have missed it.
 *
 * The path is built from labels and child indices so the same graph always yields the same
 * list, which is what makes two frames *comparable* rather than merely both non-empty. A
 * `label` that is null on a display object is treated as absent rather than dereferenced.
 */
function poses(root: Container): Pose[] {
  const found: Pose[] = [];
  const visit = (node: Container, path: string): void => {
    found.push({
      path,
      x: node.x,
      y: node.y,
      rotation: node.rotation,
      alpha: node.alpha,
      scaleX: node.scale.x,
      scaleY: node.scale.y,
    });
    node.children.forEach((child, index) => {
      if (child instanceof Container) {
        visit(child, `${path}/${child.label ?? index}`);
      }
    });
  };
  visit(root, root.label || 'root');
  return found;
}

/** The paths whose pose differs between two frames, in traversal order. */
function movedPaths(before: readonly Pose[], after: readonly Pose[]): string[] {
  if (before.length !== after.length) {
    throw new Error(`the scene graph changed shape: ${before.length} then ${after.length} nodes`);
  }
  const moved: string[] = [];
  before.forEach((a, index) => {
    const b = after[index];
    if (b === undefined) return;
    if (
      a.x !== b.x ||
      a.y !== b.y ||
      a.rotation !== b.rotation ||
      a.alpha !== b.alpha ||
      a.scaleX !== b.scaleX ||
      a.scaleY !== b.scaleY
    ) {
      moved.push(b.path);
    }
  });
  return moved;
}

/**
 * Advance a scene `FRAMES` times and report which display objects moved at all.
 *
 * Collected across every frame rather than compared at the two ends, and that is not a
 * stylistic choice. The village's idle bob has a 1500 ms half-period and this file steps
 * 100 ms, so thirty frames is exactly two whole cycles: an endpoint comparison reports
 * "nothing moved" for a bob that is moving on every frame in between, and the same accident
 * would hide any other loop whose period divides the length of the run.
 */
function movedDuring(scene: { update(deltaMs: number): void }, root: Container): string[] {
  const moving = new Set<string>();
  let previous = poses(root);
  for (let frame = 0; frame < FRAMES; frame += 1) {
    scene.update(FRAME_MS);
    const current = poses(root);
    for (const path of movedPaths(previous, current)) moving.add(path);
    previous = current;
  }
  return [...moving];
}

/** How many distinct values a readout took across `FRAMES` frames. */
function distinctOver(scene: { update(deltaMs: number): void }, read: () => string[]): number {
  const seen = new Set<string>();
  for (let frame = 0; frame < FRAMES; frame += 1) {
    scene.update(FRAME_MS);
    seen.add(read().join('|'));
  }
  return seen.size;
}

/** Fire a window keydown/keyup pair, as the shared input controller listens for it. */
function dispatchKey(type: 'keydown' | 'keyup', key: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

const liveApplications: Array<Awaited<ReturnType<typeof createPixiApplication>>> = [];
const liveScenes: Array<{ destroy(): void }> = [];

afterEach(() => {
  dispatchKey('keyup', 'ArrowRight');
  for (const scene of liveScenes.splice(0)) {
    try {
      scene.destroy();
    } catch {
      /* teardown is another file's claim */
    }
  }
  for (const application of liveApplications.splice(0)) {
    try {
      application.destroy({ releaseGlobalResources: true });
    } catch {
      /* likewise */
    }
  }
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/* ── The village ───────────────────────────────────────────────────────────── */

/**
 * The shipped roster with every authored path removed.
 *
 * `NpcController.moveNpcs` skips an NPC whose `path` is empty, exactly as the Phaser scene
 * does, so this roster stands still and the *only* thing that can move a villager marker is
 * the decorative idle bob. That is what isolates the experiment: with the shipped roster the
 * stillness assertion below would be measuring patrol rather than decoration.
 */
const STILL_ROSTER: readonly VillageNpc[] = VILLAGE_MAP.npcs.map((npc) => ({
  id: npc.id,
  label: npc.label,
  gridX: npc.gridX,
  gridY: npc.gridY,
  dialogue: npc.dialogue,
  greeting: npc.greeting,
}));

interface MountedVillage {
  readonly scene: VillageScene;
  readonly root: Container;
  readonly worldLayer: Container;
  readonly player: Container;
}

async function mountVillage(
  reducedMotion: boolean,
  npcs: readonly VillageNpc[] = STILL_ROSTER,
): Promise<MountedVillage> {
  const theme = resolveCozyWorldTheme({ theme: null, reducedMotion });
  const quality = resolveWorldQualityProfile('balanced');
  const application = await createPixiApplication({
    canvas: document.createElement('canvas'),
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(640, 480);
  const pixi: PixiApplication = asPixiApplication(application);

  let scene!: VillageScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    onAction: (actionId, source) => {
      scene.activate(actionId, source);
    },
  };
  const world: VillageWorldModel = { kind: 'village', structures: [], playerClass: null };
  scene = createVillageScene(pixi, init, {
    world,
    callbacks: {
      onStructureApproached: vi.fn(),
      onStructureLeft: vi.fn(),
      onStructureInteract: vi.fn(),
      onReady: vi.fn(),
    },
    storage: null,
    npcs,
    // The opening pause comes from ambient randomness, so a test that does not pin it
    // cannot say whether a villager moved on this frame or on a later one.
    npcRandomness: { waitMs: () => 0 },
  });
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('village-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');
  const worldLayer = root.getChildByLabel('village-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  const player = worldLayer.getChildByLabel('village-player');
  if (player === null) throw new Error('the scene added no player marker');
  return { scene, root, worldLayer, player };
}

/** The bird markers: the world layer's children on the bird depth. */
function birdsOf(worldLayer: Container): Container[] {
  return worldLayer.children.filter(
    (child): child is Container => child instanceof Container && child.zIndex === VILLAGE_DEPTH.bird,
  );
}

/** The villager markers, by their `village-npc:<id>` labels. */
function villagersOf(worldLayer: Container): Container[] {
  return worldLayer.children.filter(
    (child): child is Container =>
      child instanceof Container && (child.label ?? '').startsWith('village-npc:'),
  );
}

describe('the village under prefers-reduced-motion', () => {
  it('no display object in the village world moves across thirty frames of standing still', async () => {
    const village = await mountVillage(true);

    expect(
      movedDuring(village.scene, village.root),
      'every pose in the village world layer must be identical at frame 0 and frame 30',
    ).toEqual([]);
  });

  it('with motion allowed, that same scene does move decorations - the control', async () => {
    const village = await mountVillage(false);
    const moved = movedDuring(village.scene, village.root);

    // Named, not merely non-empty. A control that only proved "something moved" would pass
    // on a single surviving bob and would not catch the bird loop being reintroduced.
    expect(moved.some((path) => path.includes('village-npc:'))).toBe(true);
    const birds = birdsOf(village.worldLayer);
    expect(birds.length).toBeGreaterThan(0);
    expect(
      distinctOver(village.scene, () => birds.map((bird) => String(bird.x))),
      'the bird sweep must produce more than one position across the run',
    ).toBeGreaterThan(1);
  });

  it('the birds hold their placed positions, and a still villager holds their ground', async () => {
    const village = await mountVillage(true);
    const birds = birdsOf(village.worldLayer);
    const villagers = villagersOf(village.worldLayer);
    expect(birds.length).toBeGreaterThan(0);
    expect(villagers.length).toBeGreaterThan(0);

    expect(distinctOver(village.scene, () => birds.map((bird) => String(bird.x)))).toBe(1);
    expect(distinctOver(village.scene, () => villagers.map((v) => String(v.y)))).toBe(1);
  });

  it('a villager does walk their authored path under reduced motion, by decision', async () => {
    const village = await mountVillage(true, VILLAGE_MAP.npcs);
    const villagers = villagersOf(village.worldLayer);
    const start = villagers.map((villager) => `${villager.x},${villager.y}`);

    for (let frame = 0; frame < FRAMES * 4; frame += 1) village.scene.update(FRAME_MS);

    // Pinned rather than left to a comment. See the header: patrol is world state, because
    // the nearby-action rows are measured against it. If a future phase decides otherwise,
    // this is the test that goes red and forces the decision to be written down.
    expect(villagers.map((villager) => `${villager.x},${villager.y}`)).not.toEqual(start);
  });

  it('the camera is placed on the player, not eased toward them', async () => {
    const village = await mountVillage(true);
    const startX = village.player.x;
    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < FRAMES; frame += 1) village.scene.update(FRAME_MS);

    const camera = village.scene.readCameraState();
    expect(
      village.player.x - startX,
      'the learner must actually have moved, or the camera assertion is vacuous',
    ).toBeGreaterThan(VILLAGE_MAP.width * 0);
    expect(camera.centerX).toBe(village.player.x);
    // `centerY` is deliberately not asserted equal to `player.y`: the rig clamps its centre
    // to the world bounds, and on this viewport the player's row is inside the clamped band
    // on x and outside it on y. Asserting it would be asserting the clamp, not the easing.
    expect(camera.centerY).not.toBe(Number.NaN);
  });

  it('with motion allowed the camera does ease - the control', async () => {
    const village = await mountVillage(false);
    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < FRAMES; frame += 1) village.scene.update(FRAME_MS);

    // Strictly behind: a lerp that had caught up would not be an easing camera, and the
    // difference between this line and the assertion above is the whole fix.
    expect(village.scene.readCameraState().centerX).toBeLessThan(village.player.x);
  });
});

/* ── The dungeon ───────────────────────────────────────────────────────────── */

/** A subject with `childCount` root children, from the Phase 13 scene fixture. */
function buildSubject(childCount: number): { map: DungeonMap; metadata: DungeonMetadata } {
  const root = createRootDungeon({
    dungeonId: 'phase21-subject',
    subjectName: 'Phase 21 Subject',
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

function floorFor(
  metadata: Parameters<typeof computeFloorVisibility>[1],
  floorId: string,
): FloorVisibilityModel {
  const visibility = computeFloorVisibility(deriveGraphHierarchy(metadata), metadata, floorId);
  return {
    floorId: visibility.floorId,
    visibleRoomIds: [...visibility.visibleRoomIds],
    portalUpRoomId: visibility.portalUpRoomId,
    portalDownRoomIds: [...visibility.portalDownRoomIds],
  };
}

interface MountedDungeon {
  readonly scene: DungeonScene;
  readonly root: Container;
  readonly player: Container;
  readonly originX: number;
  readonly originY: number;
}

async function mountDungeon(reducedMotion: boolean): Promise<MountedDungeon> {
  const subject = buildSubject(DUNGEON_SUBJECT_ROOMS);
  const theme = resolveCozyWorldTheme({ theme: null, reducedMotion });
  const quality = resolveWorldQualityProfile('balanced');
  const application = await createPixiApplication({
    canvas: document.createElement('canvas'),
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(DUNGEON_VIEWPORT.width, DUNGEON_VIEWPORT.height);
  const pixi: PixiApplication = asPixiApplication(application);

  let scene!: DungeonScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    onAction: (actionId, source) => {
      scene.activate(actionId, source);
    },
  };
  const callbacks: DungeonSceneCallbacks = {
    onRoomEntered: vi.fn(),
    onInteract: vi.fn(),
  };
  scene = createDungeonScene(pixi, init, {
    world: { map: subject.map, floor: floorFor(subject.metadata, 'root'), playerClass: 'scholar' },
    callbacks,
  });
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('dungeon-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');
  const worldLayer = root.getChildByLabel('dungeon-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  const player = worldLayer.getChildByLabel('dungeon-player');
  if (player === null) throw new Error('the scene added no player marker');
  return {
    scene,
    root,
    player,
    originX: subject.map.bounds.minX * subject.map.tileSize,
    originY: subject.map.bounds.minY * subject.map.tileSize,
  };
}

describe('the dungeon under prefers-reduced-motion', () => {
  it('no display object in the dungeon world moves across thirty frames of standing still', async () => {
    const dungeon = await mountDungeon(true);

    expect(
      movedDuring(dungeon.scene, dungeon.root),
      'the dungeon has no decorative loop, so a still player must produce a still world',
    ).toEqual([]);
  });

  it('the camera is placed on the player, not eased toward them', async () => {
    const dungeon = await mountDungeon(true);
    const startX = dungeon.player.x;
    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < FRAMES; frame += 1) dungeon.scene.update(FRAME_MS);

    const camera = dungeon.scene.readCameraState();
    // Rig space is map space minus the bounds origin - the same transform
    // `teleportToRoom` uses, not a guess. Comparing `camera.centerX` to `player.x`
    // directly would pass for the wrong reason on any map whose bounds do not start at
    // (0, 0), and this generated one starts at -22.
    expect(dungeon.player.x - startX, 'the learner must actually have moved').toBeGreaterThan(0);
    expect(camera.centerX).toBe(dungeon.player.x - dungeon.originX);
  });

  it('with motion allowed the camera does ease - the control', async () => {
    const dungeon = await mountDungeon(false);
    dispatchKey('keydown', 'ArrowRight');
    for (let frame = 0; frame < FRAMES; frame += 1) dungeon.scene.update(FRAME_MS);

    expect(dungeon.scene.readCameraState().centerX).toBeLessThan(dungeon.player.x - dungeon.originX);
  });
});

/* ── The fishing pond ──────────────────────────────────────────────────────── */

interface MountedPond {
  readonly scene: FishingScene;
  readonly root: Container;
  readonly rod: Container;
  readonly bucketFish: Container;
}

const POND_VIEWPORT = { width: 800, height: 600 } as const;

async function mountPond(reducedMotion: boolean): Promise<MountedPond> {
  const theme = resolveCozyWorldTheme({ theme: null, reducedMotion });
  const quality = resolveWorldQualityProfile('balanced');
  const application = await createPixiApplication({
    canvas: document.createElement('canvas'),
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(POND_VIEWPORT.width, POND_VIEWPORT.height);
  const pixi: PixiApplication = asPixiApplication(application);

  let scene!: FishingScene;
  const init: WorldSceneInit = {
    theme,
    quality,
    onAction: (actionId, source) => {
      scene.activate(actionId, source);
    },
    publishState: () => undefined,
  };
  scene = createFishingScene(pixi, init, {
    world: { playerClass: 'scholar', hasClearedRooms: true },
    callbacks: { onAudioHook: vi.fn(), onReturnToVillage: vi.fn() },
    sessionDate: SESSION_DATE,
    // A fixed cosmetic stream, so a droplet count cannot make two runs differ for a reason
    // that has nothing to do with the renderer.
    cosmeticRng: () => 0.5,
    nowMs: 0,
  });
  liveScenes.push(scene);
  scene.onResize(POND_VIEWPORT.width, POND_VIEWPORT.height);

  const root = pixi.stage.getChildByLabel('fishing-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');
  const rod = root.getChildByLabel('fishing-rod');
  if (rod === null) throw new Error('the scene added no rod layer');
  const bucketFish = root.getChildByLabel('fishing-bucket-fish');
  if (bucketFish === null) throw new Error('the scene added no bucket-fish layer');
  return { scene, root, rod, bucketFish };
}

/**
 * One cast to a catch, on the fixed session date the Phase 17 parity lane uses.
 *
 * Reproduced rather than re-derived: whether a cast catches is a property of the machine's
 * own seeded catalogue roll, and this is the sequence
 * `tests/phase17/fishing-scene-parity.test.ts` already pins as reaching `caught`. Deriving a
 * different program here would make the claim depend on a catalogue weight instead of on the
 * renderer.
 */
function castToCatch(pond: MountedPond): void {
  const until = (phase: string): void => {
    for (let frame = 0; frame < 400; frame += 1) {
      pond.scene.update(FRAME_MS);
      if (pond.scene.capabilities.readReadout().phase === phase) return;
    }
    throw new Error(`the pond never reached ${phase}`);
  };
  pond.scene.capabilities.beginPower();
  pond.scene.capabilities.release();
  until('waiting');
  until('biting');
  pond.scene.capabilities.hook();
  until('caught');
}

function bucketGlyphs(pond: MountedPond): Container[] {
  return pond.bucketFish.children.filter((child): child is Container => child instanceof Container);
}

describe('the fishing pond under prefers-reduced-motion', () => {
  it('the rod does not sway across thirty frames', async () => {
    const pond = await mountPond(true);
    const shaft = pond.rod.getChildByLabel('fishing-rod-shaft');
    if (shaft === null) throw new Error('the rod layer has no shaft');

    const before = shaft.rotation;
    for (let frame = 0; frame < FRAMES; frame += 1) pond.scene.update(FRAME_MS);
    expect(shaft.rotation).toBe(before);
  });

  it('with motion allowed the rod does sway - the control', async () => {
    const pond = await mountPond(false);
    const shaft = pond.rod.getChildByLabel('fishing-rod-shaft');
    if (shaft === null) throw new Error('the rod layer has no shaft');

    const before = shaft.rotation;
    for (let frame = 0; frame < FRAMES; frame += 1) pond.scene.update(FRAME_MS);
    expect(shaft.rotation).not.toBe(before);
  });

  it('no display object in the pond moves across thirty frames of idle', async () => {
    const pond = await mountPond(true);

    expect(
      movedDuring(pond.scene, pond.root),
      'an idle pond under reduced motion must be a still picture',
    ).toEqual([]);
  });

  it('with motion allowed the pond is not a still picture - the control', async () => {
    const pond = await mountPond(false);
    expect(movedDuring(pond.scene, pond.root).length).toBeGreaterThan(0);
  });

  it('a caught fish is placed in the bucket, never grown into it', async () => {
    const pond = await mountPond(true);
    castToCatch(pond);

    const glyphs = bucketGlyphs(pond);
    expect(glyphs, 'the cast must have caught a fish for this to mean anything').toHaveLength(1);

    // Two claims, and they are not the same claim.
    //
    // 1. The glyph is *born* at its resting size, not at zero. This is the gate that decides
    //    the value, and reading it before any frame has run is what makes it observable: a
    //    loop that snapped the value back would look identical after one frame.
    expect(glyphs[0]?.scale.x ?? -1).toBe(0.4);
    // 2. The pop-in loop advances nothing. A run-wide count of distinct values, not an
    //    endpoint comparison, because an endpoint comparison would report "still" for a
    //    loop whose period divides the run - the exact accident that would have hidden the
    //    village's 1500 ms bob above.
    expect(
      distinctOver(pond.scene, () => glyphs.map((glyph) => String(glyph.scale.x))),
      'the pop-in loop must not advance the glyph under reduced motion',
    ).toBe(1);
  });

  it('with motion allowed the caught glyph does grow - the control', async () => {
    const pond = await mountPond(false);
    castToCatch(pond);

    const glyphs = bucketGlyphs(pond);
    expect(glyphs).toHaveLength(1);
    // Born at zero, so the very first frame has to move it for the assertion to mean
    // anything. Read immediately after the catch rather than after a delay.
    expect(glyphs[0]?.scale.x ?? -1).toBeLessThan(0.4);
    const before = glyphs[0]?.scale.x ?? -1;
    for (let frame = 0; frame < FRAMES; frame += 1) pond.scene.update(FRAME_MS);
    expect(glyphs[0]?.scale.x ?? -1).toBeGreaterThan(before);
  });
});

/* ── One way to ask about the preference ───────────────────────────────────── */

/**
 * Every `.ts` file under `root`, recursively, as repo-relative POSIX paths.
 *
 * Hand-rolled rather than `globSync` from `node:fs`: the recursive walk is kept portable rather
 * than tied to a runtime API. The returned set is the same one the previous recursive glob
 * produced, and the separator normalisation keeps the `endsWith(...)` filters below portable.
 */
function typescriptFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(relative(process.cwd(), full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return found;
}

describe('prefers-reduced-motion is read through the one environment seam', () => {
  it('the scenes never read the media query themselves', () => {
    // Only the two seam modules may ask. A scene that called `matchMedia` itself would be a
    // third way to answer one question, and three answers to one question is how a world
    // ends up animating for a learner whose preference the host did honour.
    //
    // Comments are stripped first, because the module headers *name* `matchMedia`
    // repeatedly while explaining why the seam exists - a naive substring scan reports the
    // prose as a call site and fails on documentation.
    const code = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    const offenders = typescriptFilesUnder('src/renderers/pixi')
      .filter(
        (file) =>
          !file.endsWith('runtime/worldEnvironment.ts') && !file.endsWith('runtime/useWorldQuality.ts'),
      )
      .filter((file) => code(readFileSync(file, 'utf8')).includes('matchMedia'));

    expect(offenders).toEqual([]);
  });

  it('both seam modules ask the same question with the same string', () => {
    const query = '(prefers-reduced-motion: reduce)';
    expect(readFileSync('src/renderers/pixi/runtime/worldEnvironment.ts', 'utf8')).toContain(
      `'${query}'`,
    );
    expect(readFileSync('src/renderers/pixi/runtime/useWorldQuality.ts', 'utf8')).toContain(
      `'${query}'`,
    );
  });
});