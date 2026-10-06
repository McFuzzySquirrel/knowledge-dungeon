/**
 * The PixiJS dungeon world: rooms, corridors, doors, portals, overlays, and the player.
 *
 * ## What this scene is
 *
 * A renderer for exactly what `src/game/scenes/DungeonScene.ts` has always drawn. Same
 * `DungeonMap`, same tile grid, same per-floor visibility rule, same portals, same room
 * states, same interact semantics, same player speed, and the same two camera zoom
 * levels. The parts that were *not* presentation - the walkability mask, the collider
 * test, the per-axis integration, the room index - were extracted verbatim into
 * `./WalkabilityController.ts` before anything was written here, so this file draws and
 * nothing here decides where the player may stand.
 *
 * It draws all of it procedurally, in the same style as the village: `Graphics` and
 * `Text`, no image files, because the dungeon sprite set under `public/assets/` is
 * `legacy-unverified` and the CC0 gate admits none of it to a Pixi bundle.
 *
 * ## The seam, and what this scene must not do
 *
 * The scene implements the host's `WorldScene` lifecycle and exposes
 * `DungeonRendererCapabilities` through `capabilities`. It never performs an action
 * itself: every route into an interaction - the keyboard and touch input controller,
 * the DOM interact button, the ascend and descend buttons, and the host's own dispatch -
 * converges on `init.onAction`, so activation and state publication stay in the host's
 * one function. That is why the object returned below binds `activate` once and nothing
 * in this module calls it.
 *
 * `DungeonRendererCapabilities.triggerInteract` routes through the same dispatcher, and
 * for the same reason: the DOM button's interact has to be the same action as the key's
 * so the state is republished once for both.
 *
 * ## Camera
 *
 * `CameraRig` is the shared rig from Phase 11, which stores the centre of the view in
 * world coordinates. The dungeon map's bounds do not start at tile `(0, 0)`, so the rig
 * is given the *bounding box* as its world and the world layer is offset by the bounds
 * origin. Every game measurement - walkability, room lookup, collision - stays in
 * absolute map pixels; only the transform into rig space happens in `applyCamera`, and
 * `projectToViewport` is the inverse of that same transform, so a dialog anchor cannot
 * disagree with where the figure was drawn.
 *
 * Auto-zoom is the Phaser scene's rule verbatim: zoomed in inside a room, zoomed out on
 * a corridor, with the same two levels and the same 320 ms transition. A user gesture - a
 * wheel notch, a pinch, the DOM buttons - adopts the current zoom as its own target and
 * stops the tween, exactly as the Phaser scene killed its tweens on a pinch; the next
 * room-to-corridor transition re-arms it, which is also what Phaser did.
 *
 * ## Reduced motion
 *
 * The zoom transition is the only animation here that moves the world, so it is the only
 * one the motion profile scales. Player movement is direct control rather than
 * decoration, and scaling it to zero would remove the only way to move without a pointer.
 *
 * ## Artifacts
 *
 * One decision, in `./dungeonArtifact.ts`, and everything here asks for it rather than
 * recomputing it: whether a room's artifact marker is drawn, whether walking onto it
 * performs a pickup, and what a DOM surface reads. The three inputs are the ones the host
 * pushes - an artifact exists, it has been collected, and pickup is permitted here - and
 * this file has no phase of its own, because `src/renderers/**` cannot reach the session
 * store and a phase comparison here would be the first place the two renderers could drift
 * over the study flow's vocabulary.
 *
 * A pickup is a *notification*. It reports through `onArtifactCollected` and does nothing
 * else: generation is `encounter/note-submit` on the other side of the host, so plan exit
 * criterion 5 holds structurally rather than by convention.
 */
import { Container, Graphics } from 'pixi.js';

import { getBiomePalette, resolveFloorBiome, type FloorBiomeId } from '@/core/biomes';
import type { DungeonMap, DungeonRoom } from '@/core/layout/dungeonTypes';
import type { DungeonRendererCapabilities } from '@/application/contracts/renderer';
import type { FloorVisibilityModel, PlayerClassId } from '@/application/contracts/world';
import { createCameraRig, type CameraRig, type CameraState } from '@/renderers/pixi/camera/CameraRig';
import { createWorldInputController } from '@/renderers/pixi/input/WorldInputController';
import type { PixiApplication } from '@/renderers/pixi/runtime/createPixiApplication';
import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type {
  WorldAction,
  WorldActionSource,
  WorldActionState,
  WorldScene,
  WorldSceneInit,
} from '@/renderers/pixi/runtime/types';
import type { CozyMotionProfile } from '@/theme';
import {
  DUNGEON_ARTIFACT_ACTION_ID,
  createDungeonArtifactSnapshot,
  describeDungeonArtifactMarkerSuffix,
  resolveDungeonArtifactMarker,
  type DungeonArtifactMarkerState,
  type DungeonArtifactRoomView,
  type DungeonArtifactSnapshot,
} from './dungeonArtifact';
import { createCorridorLayer, type CorridorLayer } from './CorridorLayer';
import type { DungeonSceneCallbacks } from './DungeonRenderer';
import { createRoomNode, type RoomNode, type RoomNodeState } from './RoomNode';
import {
  DUNGEON_PLAYER_SPEED,
  createWalkabilityController,
  doorsByRoom,
  hashDungeonSeed,
  normalizeFacing,
  resolveRoomCenter,
  type DungeonFacing,
  type WalkabilityController,
} from './WalkabilityController';

/* ── Actions ───────────────────────────────────────────────────────────────── */

/** Interact with whatever is in the room the player is standing in. */
export const DUNGEON_INTERACT_ACTION_ID = 'dungeon-interact';
/** Take the up-portal in this room, if it has one. */
export const DUNGEON_ASCEND_ACTION_ID = 'dungeon-ascend';
/** Take the down-portal in this room, if it has one. */
export const DUNGEON_DESCEND_ACTION_ID = 'dungeon-descend';
/** Zoom the camera in one step. */
export const DUNGEON_ZOOM_IN_ACTION_ID = 'dungeon-zoom-in';
/** Zoom the camera out one step. */
export const DUNGEON_ZOOM_OUT_ACTION_ID = 'dungeon-zoom-out';

/**
 * The marker that prefixes a status sentence for an action that cannot currently act.
 *
 * ## Why the availability lives in the sentence rather than beside it
 *
 * `WorldActionState` is `Readonly<Record<string, string>>` - a renderer-neutral contract
 * this phase may not reshape. A DOM mirror that needs to know whether Ascend is available
 * therefore has exactly one published channel, and the temptation is to add a second read
 * next to it. That is the divergence risk: two reads computed from the same scene state,
 * disagreeing silently on exactly the frames where a learner is trying to use the control.
 *
 * So availability is *part of the sentence*. One value, one source, and the thing a screen
 * reader announces is also the thing the `disabled` attribute is derived from - which means
 * the control and its explanation cannot say different things.
 *
 * The prefix is a sentence in its own right, not a sentinel: a learner hears "Unavailable:
 * no stairs up in this room", which is the explanation plan 10.1 asks for, in words.
 */
export const DUNGEON_ACTION_UNAVAILABLE_PREFIX = 'Unavailable: ';

/**
 * Whether a published status sentence says the action cannot currently act.
 *
 * Exported, pure, and total over `undefined` so a caller that has not received a state for
 * an id yet gets `false` - an unknown action is not a disabled one, and the control must
 * stay reachable until the scene says otherwise.
 */
export function isDungeonActionUnavailable(sentence: string | undefined): boolean {
  return typeof sentence === 'string' && sentence.startsWith(DUNGEON_ACTION_UNAVAILABLE_PREFIX);
}

/** The sentence with the availability marker removed, for display. */
export function describeDungeonActionSentence(sentence: string | undefined): string {
  if (typeof sentence !== 'string') return '';
  return isDungeonActionUnavailable(sentence)
    ? sentence.slice(DUNGEON_ACTION_UNAVAILABLE_PREFIX.length)
    : sentence;
}

/**
 * Build a status sentence, marking it unavailable when the action cannot act.
 *
 * One function so the marker cannot be applied inconsistently: every unavailable sentence
 * in this scene goes through here, and a test asserts that a refused action produces a
 * marked one rather than a plain "No stairs up" a DOM could not act on.
 */
function actionSentence(available: boolean, sentence: string): string {
  return available ? sentence : `${DUNGEON_ACTION_UNAVAILABLE_PREFIX}${sentence}`;
}

/**
 * The actions, in DOM focus order.
 *
 * `keyboardKey` is `null` on every one of them, deliberately. The dungeon's keyboard
 * surface is the input controller, which already owns arrows/WASD for movement and
 * E/Space for interaction; binding `e` here as well would perform the interact twice
 * for one keypress. The DOM controls still name the keys in their own labels, so a
 * keyboard user learns them from the controls rather than by guessing.
 *
 * Ascend and descend are actions rather than capabilities because they are *world*
 * moves, not renderer verbs: they emit `dungeon:floor-transition` and the application
 * layer decides which floor becomes active. Zoom is an action because a wheel notch, a
 * pinch, and the DOM buttons are three routes into the same one line.
 */
export const DUNGEON_ACTIONS: readonly WorldAction[] = Object.freeze([
  Object.freeze({
    id: DUNGEON_INTERACT_ACTION_ID,
    label: 'Interact (E or Space)',
    hint: 'Opens the room encounter, talks to the room guide, or collects the artifact here.',
    keyboardKey: null,
    pointer: true,
  }),
  Object.freeze({
    id: DUNGEON_ASCEND_ACTION_ID,
    label: 'Ascend',
    hint: 'Takes the stairs up, when the current room has an up portal.',
    keyboardKey: null,
    pointer: false,
  }),
  Object.freeze({
    id: DUNGEON_DESCEND_ACTION_ID,
    label: 'Descend',
    hint: 'Takes the stairs down, when the current room has a down portal.',
    keyboardKey: null,
    pointer: false,
  }),
  Object.freeze({
    id: DUNGEON_ZOOM_IN_ACTION_ID,
    label: 'Zoom in',
    hint: 'Zooms the dungeon view in one step.',
    keyboardKey: null,
    pointer: false,
  }),
  Object.freeze({
    id: DUNGEON_ZOOM_OUT_ACTION_ID,
    label: 'Zoom out',
    hint: 'Zooms the dungeon view out one step.',
    keyboardKey: null,
    pointer: false,
  }),
]);

/* ── Constants ─────────────────────────────────────────────────────────────── */

/** Camera zoom while the player stands inside a room. */
export const DUNGEON_ZOOM_INSIDE_ROOM = 1.6;
/** Camera zoom while the player is on a corridor. */
export const DUNGEON_ZOOM_ON_PATH = 0.85;
/** Milliseconds the auto-zoom transition takes. */
export const DUNGEON_ZOOM_TWEEN_MS = 320;
/** Smallest zoom a pinch or a button may reach. */
export const DUNGEON_ZOOM_MIN = 0.4;
/** Largest zoom a pinch or a button may reach. */
export const DUNGEON_ZOOM_MAX = 3.5;
/** One zoom step, for the DOM buttons. */
export const DUNGEON_ZOOM_STEP = 0.25;

/** World pixels within which the player can talk to the room guide. */
export const DUNGEON_NPC_INTERACT_RADIUS = 28;
/** World pixels beyond which an open guide dialog closes. */
export const DUNGEON_NPC_DIALOG_CLEAR_RADIUS = 44;
/** World pixels within which the player collects an artifact marker. */
export const DUNGEON_ARTIFACT_PICKUP_RADIUS = 22;
/** How far above the room centre an artifact marker or a stair marker sits. */
const MARKER_LIFT = 0.25;

/**
 * Draw order.
 *
 * Corridors under rooms so a room's floor never hides the path that reaches it, and the
 * player over both. Declared as data and applied through `sortableChildren` rather than
 * left to insertion order, because a floor change rebuilds the corridor layer and
 * insertion order would then put the paths on top.
 */
const DUNGEON_DEPTH = Object.freeze({ corridors: 0, rooms: 1, player: 20 });

/** The player's drawn size, in world pixels. */
const PLAYER_SIZE = 26;

/** The label the guide marker is drawn under, in every room. */
const GUIDE_LABEL = 'dungeon-room-guide';

/** Which way each facing points, in radians. */
const FACING_ANGLE: Readonly<Record<DungeonFacing, number>> = Object.freeze({
  up: 0,
  right: Math.PI / 2,
  down: Math.PI,
  left: -Math.PI / 2,
});

/* ── Types ─────────────────────────────────────────────────────────────────── */

/** The world slice the scene needs. Structural, so the host can pass `DungeonWorldModel`. */
export interface DungeonSceneWorld {
  readonly map: DungeonMap;
  readonly floor: FloorVisibilityModel;
  readonly playerClass: PlayerClassId | null;
}

/** Everything the scene needs beyond the host's own init. */
export interface CreateDungeonSceneOptions {
  readonly world: DungeonSceneWorld;
  readonly callbacks: DungeonSceneCallbacks;
}

/** The scene the host drives. */
export interface DungeonScene extends WorldScene<DungeonRendererCapabilities> {
  readonly capabilities: DungeonRendererCapabilities;
  /**
   * Read the dungeon's artifact surface, for a DOM surface that renders it.
   *
   * Deliberately a *read* beside the capability port rather than a member of it: Phase 15
   * could not widen `DungeonRendererCapabilities` (a shared contract both adapters answer
   * to), and inventing a store import to work around that would have put a second source
   * of artifact truth inside the renderer. The read is the same idea as the village's
   * `readNpcSnapshot` - data out of a port, never a handle into the scene - and it is what
   * lets a DOM control offer a pickup without having to be the callback's recipient.
   */
  readArtifactSnapshot(): DungeonArtifactSnapshot;
  /**
   * The camera as one frozen value: centre, zoom, and viewport.
   *
   * Added in Phase 21 for two reasons, both of which are questions a DOM surface or a gate
   * cannot answer by looking at the picture. A zoom status sentence wants the factor, and
   * the reduced-motion gate wants to see whether the follow easing is still running - which
   * is the one claim in this world a boolean cannot establish, because a camera that eases
   * at a thousandth of its speed still eases.
   */
  readCameraState(): CameraState;
}

/* ── The scene ─────────────────────────────────────────────────────────────── */

/**
 * Build the dungeon scene onto an application's stage.
 *
 * Everything created here is released in `destroy()`. That discipline is not tidiness:
 * the twenty mount/unmount cycles in plan section 10.2 are exactly where a display
 * object that outlived its scene shows up.
 */
export function createDungeonScene(
  application: PixiApplication,
  init: WorldSceneInit,
  options: CreateDungeonSceneOptions,
): DungeonScene {
  const theme: CozyWorldTheme = init.theme;
  let motion: CozyMotionProfile = theme.motion;
  const map = options.world.map;
  const tileSize = map.tileSize;
  const callbacks = options.callbacks;

  // The dungeon map's bounds are not the world origin, so every rig coordinate is a map
  // coordinate minus this. See the header.
  const originX = map.bounds.minX * tileSize;
  const originY = map.bounds.minY * tileSize;
  const worldWidth = Math.max(1, (map.bounds.maxX - map.bounds.minX) * tileSize);
  const worldHeight = Math.max(1, (map.bounds.maxY - map.bounds.minY) * tileSize);

  const root = new Container();
  root.label = 'dungeon-world';
  application.stage.addChild(root);

  const world = new Container();
  world.label = 'dungeon-world-layer';
  world.sortableChildren = true;
  root.addChild(world);

  // ── Floor state ──────────────────────────────────────────────────────────
  let currentFloorId: string | null = options.world.floor.floorId;
  let visibleRoomIds: ReadonlySet<string> | null = new Set(options.world.floor.visibleRoomIds);
  let portalUpRoomId: string | null = options.world.floor.portalUpRoomId;
  let portalDownRoomIds: ReadonlySet<string> = new Set(options.world.floor.portalDownRoomIds);
  let floorBiomeOverride: FloorBiomeId | undefined = options.world.floor.biomeId;
  let floorSeed = hashDungeonSeed(options.world.floor.floorId);
  let biomeWallTint = 0x3a3228;
  let biomeCorridorColor = 0xb8a87a;

  // ── Per-room state the application layer pushes in ────────────────────────
  const artifactRoomIds = new Set<string>();
  const collectedArtifactRoomIds = new Set<string>();
  const reviewedArtifactRoomIds = new Set<string>();
  const imageRoomIds = new Set<string>();
  const roomOverlayStates = new Map<string, string>();
  /**
   * The host's pickup-permitted gate, pushed in as the `visible` argument of
   * `setArtifactRooms`.
   *
   * Named for what the argument *means* rather than for how it was called, because the
   * distinction is the whole of Phase 15: this is "may an artifact be picked up in the
   * phase the session is in", not "should the icons be drawn". A renderer that treated it
   * as the latter would draw a marker the pickup path then refused, which is the
   * unreachable-marker defect; a renderer that treated it as a phase of its own would have
   * to import the session store to decide, which is forbidden. So it is the host's answer,
   * honoured verbatim, in every phase.
   */
  let artifactPickupPermitted = false;
  /**
   * Rooms whose pickup *this renderer* has already reported.
   *
   * Never cleared, and unioned with the host's set, because a marker that came back after
   * the world had already reported the pickup would be a second offer of an action the
   * store records idempotently under `${dungeonId}:${roomId}` - and the store's own
   * `collectArtifactNote` returns `false` for the repeat, so the learner would see a
   * marker, walk onto it, press the control, and nothing happen. That hole is reachable:
   * the host's set arrives from a React effect, so a capability push that lands between
   * the walk and the journal write publishes a set that does not yet include the room,
   * and a floor change rebuilds every room node from these sets. The renderer's own record
   * is monotone in the same direction as the store's, so it can only ever be a subset the
   * host will agree with - it cannot invent a collection that did not happen.
   */
  const reportedArtifactRoomIds = new Set<string>();

  // ── Walkability and room lookup ───────────────────────────────────────────
  const walkability: WalkabilityController = createWalkabilityController({
    map,
    visibleRoomIds,
  });

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = createCameraRig({
    worldWidth,
    worldHeight,
    viewportWidth: Math.max(1, application.screen.width),
    viewportHeight: Math.max(1, application.screen.height),
    zoom: DUNGEON_ZOOM_INSIDE_ROOM,
    zoomMin: DUNGEON_ZOOM_MIN,
    zoomMax: DUNGEON_ZOOM_MAX,
  });

  let zoomTarget = DUNGEON_ZOOM_INSIDE_ROOM;
  let zoomElapsedMs = 0;
  let zoomFrom = DUNGEON_ZOOM_INSIDE_ROOM;

  function applyCamera(): void {
    const state = camera.getState();
    world.scale.set(state.zoom);
    world.position.set(
      state.viewportWidth / 2 - state.centerX * state.zoom - originX,
      state.viewportHeight / 2 - state.centerY * state.zoom - originY,
    );
  }

  /** The inverse of {@link applyCamera}: world pixels to client pixels on the canvas. */
  function projectToViewport(
    worldX: number,
    worldY: number,
  ): { clientX: number; clientY: number } {
    const state = camera.getState();
    const canvas = application.canvas as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect?.();
    return {
      clientX:
        (rect?.left ?? 0) +
        (worldX - originX) * state.zoom +
        (state.viewportWidth / 2 - state.centerX * state.zoom),
      clientY:
        (rect?.top ?? 0) +
        (worldY - originY) * state.zoom +
        (state.viewportHeight / 2 - state.centerY * state.zoom),
    };
  }

  const rigX = (worldX: number): number => worldX - originX;
  const rigY = (worldY: number): number => worldY - originY;

  // ── Corridors ─────────────────────────────────────────────────────────────
  // Created by the first `applyFloorVisibility`, which is also what draws them, so a
  // mount never builds a corridor layer it immediately throws away.
  let corridors: CorridorLayer | null = null;

  // ── Rooms ─────────────────────────────────────────────────────────────────
  const rooms = new Container();
  rooms.label = 'dungeon-rooms';
  rooms.zIndex = DUNGEON_DEPTH.rooms;
  world.addChild(rooms);

  const roomNodes = new Map<string, RoomNode>();
  const doorsPerRoom = doorsByRoom(map.doors);
  const roomById = new Map<string, DungeonRoom>(map.rooms.map((room) => [room.roomId, room]));

  // ── Player ────────────────────────────────────────────────────────────────
  const player = new Container();
  player.label = 'dungeon-player';
  player.zIndex = DUNGEON_DEPTH.player;
  world.addChild(player);

  const playerBody = new Graphics();
  const facingMarker = new Graphics();
  player.addChild(playerBody, facingMarker);

  const playerClass: PlayerClassId = options.world.playerClass ?? 'scholar';
  let facing: DungeonFacing = 'down';
  let currentRoomId: string | null = null;
  let insideRoom = false;
  let activeNpcRoomId: string | null = null;
  const spawnRoom = map.rooms.find((room) => room.isRoot) ?? map.rooms[0] ?? null;
  if (spawnRoom !== null) {
    const start = resolveRoomCenter(spawnRoom, tileSize);
    player.position.set(start.x, start.y);
  }

  function drawPlayerBody(archetype: PlayerClassId): void {
    playerBody.clear();
    const half = PLAYER_SIZE / 2;
    // One silhouette with a per-archetype crest, so the distinction is not colour-only.
    playerBody
      .roundRect(-half * 0.5, -half * 0.2, half, half * 1.2, theme.radius.pill)
      .fill({ color: theme.color.surfaceRaised, alpha: 1 })
      .stroke({ width: theme.border.state, color: theme.color.borderStrong, alpha: 1 });
    playerBody
      .circle(0, -half * 0.4, half * 0.5)
      .fill({ color: theme.color.accentSoft, alpha: 1 })
      .stroke({ width: theme.border.hairline, color: theme.color.borderStrong, alpha: 1 });
    if (archetype === 'cartographer') {
      playerBody
        .moveTo(-half * 0.6, -half * 0.5)
        .lineTo(half * 0.6, -half * 0.5)
        .stroke({ width: theme.border.hairline, color: theme.color.accent, alpha: 1 });
    } else if (archetype === 'archivist') {
      playerBody
        .rect(-half * 0.35, -half * 0.75, half * 0.7, half * 0.4)
        .fill({ color: theme.color.accent, alpha: 0.9 });
    } else {
      playerBody
        .poly([0, -half * 0.85, half * 0.3, -half * 0.55, -half * 0.3, -half * 0.55])
        .fill({ color: theme.color.accent, alpha: 0.9 });
    }
  }

  function drawFacingMarker(): void {
    facingMarker.clear();
    facingMarker.poly([0, 7, -5, 0, 5, 0]).fill({ color: theme.color.accent, alpha: 0.95 });
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const input = createWorldInputController({
    element: application.canvas as HTMLCanvasElement,
    zoomMin: DUNGEON_ZOOM_MIN,
    zoomMax: DUNGEON_ZOOM_MAX,
    initialZoom: DUNGEON_ZOOM_INSIDE_ROOM,
  });

  /* ── Room state ─────────────────────────────────────────────────────────── */

  function portalDirectionFor(roomId: string | null): 'up' | 'down' | null {
    if (roomId === null) return null;
    if (roomId === portalUpRoomId) return 'up';
    if (portalDownRoomIds.has(roomId)) return 'down';
    return null;
  }

  /** The effective state of a room: the application's, falling back to the map's. */
  function overlayStateOf(room: DungeonRoom): string {
    return roomOverlayStates.get(room.roomId) ?? room.status;
  }

  /**
   * Whether a room's artifact has already gone into the journal.
   *
   * The union of what the host reported and what this renderer reported, so a host push
   * that has not caught up yet cannot resurrect a marker. See
   * {@link reportedArtifactRoomIds} for why that is safe in the direction it is monotone.
   */
  function isArtifactCollected(roomId: string): boolean {
    return collectedArtifactRoomIds.has(roomId) || reportedArtifactRoomIds.has(roomId);
  }

  /**
   * The one artifact decision, for every caller.
   *
   * The drawn marker, the per-frame pickup test, and the DOM read all come through here,
   * so "the marker is showing" and "a pickup can happen" are the same statement. Before
   * this, `RoomNode.apply` computed `artifactVisible && !artifactCollected` while
   * `checkArtifactCollection` re-derived the same expression from the same three sets, and
   * a divergence between them would have been a marker that could not be picked up.
   */
  function artifactMarkerOf(roomId: string): DungeonArtifactMarkerState {
    return resolveDungeonArtifactMarker({
      pickupPermitted: artifactPickupPermitted,
      hasArtifact: artifactRoomIds.has(roomId),
      collected: isArtifactCollected(roomId),
    });
  }

  function roomNodeState(room: DungeonRoom): RoomNodeState {
    const roomId = room.roomId;
    return {
      overlayState: overlayStateOf(room),
      portal: portalDirectionFor(roomId),
      focused: roomId === currentRoomId,
      artifactMarker: artifactMarkerOf(roomId),
      reviewed: reviewedArtifactRoomIds.has(roomId),
      // A picture-frame hint is contextual: only while standing in that exact room.
      imageAttachment: imageRoomIds.has(roomId) && insideRoom && currentRoomId === roomId,
      floorId: currentFloorId ?? 'all',
    };
  }

  function applyRoomStates(): void {
    for (const room of map.rooms) {
      roomNodes.get(room.roomId)?.apply(roomNodeState(room));
    }
  }

  function refreshRooms(): void {
    for (const [roomId, node] of [...roomNodes]) {
      if (visibleRoomIds !== null && !visibleRoomIds.has(roomId)) {
        rooms.removeChild(node.container);
        node.destroy();
        roomNodes.delete(roomId);
      }
    }
    for (const room of map.rooms) {
      if (visibleRoomIds !== null && !visibleRoomIds.has(room.roomId)) continue;
      if (roomNodes.has(room.roomId)) continue;
      roomNodes.set(
        room.roomId,
        createRoomNode({
          room,
          tileSize,
          theme,
          parent: rooms,
          wallTint: biomeWallTint,
          doors: doorsPerRoom.get(room.roomId) ?? [],
        }),
      );
    }
    applyRoomStates();
  }

  /* ── Floor ──────────────────────────────────────────────────────────────── */

  function applyFloorVisibility(visibility: FloorVisibilityModel): void {
    currentFloorId = visibility.floorId;
    visibleRoomIds = new Set(visibility.visibleRoomIds);
    portalUpRoomId = visibility.portalUpRoomId;
    portalDownRoomIds = new Set(visibility.portalDownRoomIds);
    if (visibility.biomeId !== undefined) floorBiomeOverride = visibility.biomeId;
    floorSeed = hashDungeonSeed(visibility.floorId);
    const palette = getBiomePalette(resolveFloorBiome(floorSeed, floorBiomeOverride));
    biomeWallTint = palette.wallTint;
    biomeCorridorColor = palette.corridorColor;

    walkability.setVisibleRooms(visibleRoomIds);
    // Rebuilt rather than diffed: a floor change is rare, and "nothing from the previous
    // floor is still on screen" should be a property of the code rather than of a
    // bookkeeping exercise.
    corridors?.destroy();
    corridors = createCorridorLayer({
      map,
      parent: world,
      theme,
      corridorColor: biomeCorridorColor,
    });
    corridors.container.zIndex = DUNGEON_DEPTH.corridors;
    corridors.apply(visibleRoomIds, portalUpRoomId, portalDownRoomIds);
    refreshRooms();
    applyCamera();
  }

  /* ── Room entry ─────────────────────────────────────────────────────────── */

  function enterRoom(roomId: string): void {
    currentRoomId = roomId;
    applyRoomStates();
    if (activeNpcRoomId !== null && activeNpcRoomId !== roomId) {
      const stale = activeNpcRoomId;
      activeNpcRoomId = null;
      callbacks.onNpcOutOfRange?.(stale);
    }
    callbacks.onRoomEntered(roomId);
  }

  /* ── Interaction ────────────────────────────────────────────────────────── */

  /**
   * The room guide's drawn position, read from the node rather than re-derived.
   *
   * The dialog anchor has to be on the figure the learner can see, and the node is the
   * only thing that knows where it put it. Reading it back means there is one placement
   * rule and the anchor cannot drift from it.
   */
  function guidePositionOf(roomId: string): { x: number; y: number } | null {
    const node = roomNodes.get(roomId);
    if (node === undefined) return null;
    const guide = node.container.getChildByLabel(GUIDE_LABEL) as Container | null;
    if (guide === null) return null;
    return { x: guide.x, y: guide.y };
  }

  function tryInteractGuide(): boolean {
    if (currentRoomId === null) return false;
    const guide = guidePositionOf(currentRoomId);
    if (guide === null) return false;
    const distanceSq = (player.x - guide.x) ** 2 + (player.y - guide.y) ** 2;
    if (distanceSq > DUNGEON_NPC_INTERACT_RADIUS ** 2) return false;
    activeNpcRoomId = currentRoomId;
    callbacks.onNpcInteract?.({ roomId: currentRoomId, ...projectToViewport(guide.x, guide.y) });
    return true;
  }

  function checkGuideRange(): void {
    if (activeNpcRoomId === null) return;
    const roomId = activeNpcRoomId;
    const guide = currentRoomId === roomId ? guidePositionOf(roomId) : null;
    if (guide === null) {
      activeNpcRoomId = null;
      callbacks.onNpcOutOfRange?.(roomId);
      return;
    }
    const distanceSq = (player.x - guide.x) ** 2 + (player.y - guide.y) ** 2;
    if (distanceSq > DUNGEON_NPC_DIALOG_CLEAR_RADIUS ** 2) {
      activeNpcRoomId = null;
      callbacks.onNpcOutOfRange?.(roomId);
      return;
    }
    callbacks.onNpcDialogPosition?.({ roomId, ...projectToViewport(guide.x, guide.y) });
  }

  /**
   * Where a room's artifact marker is drawn, read from the node's own geometry rule.
   *
   * Derived here rather than asked of the node because the pickup test needs it on a frame
   * where nothing has been redrawn, and because `MARKER_LIFT` is the one number both the
   * node and this test must agree on: if they drifted, the learner would walk onto where
   * the marker appears to be and nothing would happen.
   */
  function artifactMarkerPosition(room: DungeonRoom): { x: number; y: number } {
    const center = resolveRoomCenter(room, tileSize);
    return { x: center.x, y: center.y - room.height * tileSize * MARKER_LIFT };
  }

  function isWithinArtifactPickupRange(roomId: string): boolean {
    const room = roomById.get(roomId);
    if (room === undefined) return false;
    const marker = artifactMarkerPosition(room);
    const dx = player.x - marker.x;
    const dy = player.y - marker.y;
    return dx * dx + dy * dy <= DUNGEON_ARTIFACT_PICKUP_RADIUS ** 2;
  }

  /**
   * Report a pickup for a room, and mark it collected.
   *
   * The *only* place either happens. Both routes - the marker the learner walks onto and
   * the control a DOM surface dispatches - come through here, so neither can perform a
   * pickup the other would refuse, and neither can report one twice.
   *
   * Nothing here generates an artifact, writes a note, or touches the room's status:
   * `onArtifactCollected` is a notification about a pickup, and the pickup itself is
   * `StudyFlowController.collectArtifact` on the other side of the callback. Plan exit
   * criterion 5 - generation and pickup remain separate actions - is structural here:
   * there is no code path from a marker to `artifactMarkdown`.
   */
  function reportArtifactCollected(roomId: string): void {
    reportedArtifactRoomIds.add(roomId);
    applyRoomStates();
    callbacks.onArtifactCollected?.(roomId);
  }

  function checkArtifactCollection(): void {
    const roomId = currentRoomId;
    if (roomId === null) return;
    // The same decision the marker was drawn from, so the marker is never a thing the
    // pickup refuses.
    if (artifactMarkerOf(roomId) !== 'collectible') return;
    if (!isWithinArtifactPickupRange(roomId)) return;
    reportArtifactCollected(roomId);
  }

  /**
   * The pickup as a *named* action, for a DOM control and for the host's dispatch.
   *
   * The room the player is standing in, gated by the same rule the marker is drawn from,
   * and deliberately **not** gated by the marker radius: the radius is a canvas gesture
   * ("step onto the spot"), while a DOM control names the room, exactly as the
   * room-navigation buttons name a room and teleport rather than walk. Gating it on the
   * radius would make the accessible route strictly harder than the canvas route, which is
   * the failure plan 10.1 forbids in the other direction.
   */
  function performArtifactCollect(): boolean {
    const roomId = currentRoomId;
    if (roomId === null) return false;
    if (artifactMarkerOf(roomId) !== 'collectible') return false;
    reportArtifactCollected(roomId);
    return true;
  }

  /**
   * The one interact verb, shared by the key, the tap, and the DOM button.
   *
   * The order is the Phaser scene's and it is load-bearing: the guide first, because a
   * learner who walks up to the guide and presses E meant to talk to them; then the
   * portal, because standing on the stairs is an unambiguous request; and only then the
   * room itself.
   */
  function performInteract(): void {
    if (currentRoomId === null) return;
    if (tryInteractGuide()) return;
    const direction = portalDirectionFor(currentRoomId);
    if (direction !== null) {
      callbacks.onFloorTransition?.({ fromRoomId: currentRoomId, direction });
      return;
    }
    callbacks.onInteract(currentRoomId);
  }

  /* ── Zoom ───────────────────────────────────────────────────────────────── */

  function setZoomTarget(next: number): void {
    if (zoomTarget === next) return;
    zoomFrom = camera.zoom;
    zoomTarget = next;
    zoomElapsedMs = 0;
  }

  /**
   * A user gesture becomes the zoom, and becomes the tween's target.
   *
   * The Phaser scene killed its tween and then wrote the *new* zoom into
   * `currentZoomTarget`, which is what stopped the auto-zoom guard re-firing for the same
   * level. The same two steps against this rig, in this order: applying the gesture first
   * and adopting the result second is what leaves `zoomTarget === camera.zoom`, so the
   * tween has nothing left to do. The next room-to-corridor transition sets a new target
   * and auto-zoom resumes, which is also what Phaser did.
   */
  function adoptZoomAsTarget(apply: (rig: CameraRig) => void): void {
    apply(camera);
    zoomTarget = camera.zoom;
    input.setZoom(camera.zoom);
  }

  function advanceZoom(deltaMs: number): void {
    if (Math.abs(camera.zoom - zoomTarget) < 0.001) return;
    const duration = motion.reduceAll ? 0 : DUNGEON_ZOOM_TWEEN_MS;
    if (duration <= 0) {
      camera.setZoom(zoomTarget);
      input.setZoom(camera.zoom);
      return;
    }
    zoomElapsedMs += deltaMs;
    const t = Math.min(1, zoomElapsedMs / duration);
    // Sine ease in-out, the Phaser scene's `Sine.easeInOut`.
    const eased = -(Math.cos(Math.PI * t) - 1) / 2;
    camera.setZoom(zoomFrom + (zoomTarget - zoomFrom) * eased);
    input.setZoom(camera.zoom);
  }

  /* ── Status ─────────────────────────────────────────────────────────────── */

  function statusFor(actionId: string): string {
    const room = currentRoomId === null ? undefined : roomById.get(currentRoomId);
    const topic = room?.topic ?? null;
    switch (actionId) {
      case DUNGEON_ASCEND_ACTION_ID:
        // Availability and the sentence are one decision, made once, so the `disabled`
        // attribute a DOM control renders and the words it announces cannot disagree.
        return actionSentence(
          currentRoomId !== null && currentRoomId === portalUpRoomId,
          currentRoomId !== null && currentRoomId === portalUpRoomId
            ? `Ascend from ${topic ?? 'this room'}`
            : 'there are no stairs up in this room',
        );
      case DUNGEON_DESCEND_ACTION_ID:
        return actionSentence(
          currentRoomId !== null && portalDownRoomIds.has(currentRoomId),
          currentRoomId !== null && portalDownRoomIds.has(currentRoomId)
            ? `Descend from ${topic ?? 'this room'}`
            : 'there are no stairs down in this room',
        );
      case DUNGEON_ZOOM_IN_ACTION_ID:
        return `Zoom in. Now ${camera.zoom.toFixed(2)} times.`;
      case DUNGEON_ZOOM_OUT_ACTION_ID:
        return `Zoom out. Now ${camera.zoom.toFixed(2)} times.`;
      default: {
        if (room === undefined) return 'Walking the corridors';
        const cleared =
          roomOverlayStates.get(room.roomId) === 'EncounterDefeated' ||
          roomOverlayStates.get(room.roomId) === 'ArtifactCollected' ||
          (roomOverlayStates.size === 0 &&
            (room.status === 'EncounterDefeated' || room.status === 'ArtifactCollected'));
        return cleared ? `In ${room.topic}. Encounter cleared.` : `In ${room.topic}. Not cleared yet.`;
      }
    }
  }

  function readState(): WorldActionState {
    const state: Record<string, string> = {};
    for (const action of DUNGEON_ACTIONS) state[action.id] = statusFor(action.id);
    return Object.freeze(state);
  }

  /**
   * The dungeon's artifact surface, as one value a DOM surface can render.
   *
   * The answer to "may this room's artifact be picked up", read from exactly the same rule
   * the canvas drew from, which is what makes a DOM control and a marker unable to
   * disagree. `rooms` carries every room on the visible floor that has something to say,
   * so a room list can suffix a label rather than leaving the marker as the only carrier.
   */
  function readArtifactSnapshot(): DungeonArtifactSnapshot {
    const roomId = currentRoomId;
    const room = roomId === null ? undefined : roomById.get(roomId);
    const rooms: DungeonArtifactRoomView[] = [];
    for (const candidate of map.rooms) {
      if (visibleRoomIds !== null && !visibleRoomIds.has(candidate.roomId)) continue;
      // "Has something to say" is about the room, not about the marker: a room whose
      // artifact exists but cannot be picked up in this phase is still a room with an
      // artifact, and a surface that could only see collectible rooms would draw it the
      // same as a room that never had one.
      if (!artifactRoomIds.has(candidate.roomId) && !isArtifactCollected(candidate.roomId)) continue;
      const state = artifactMarkerOf(candidate.roomId);
      rooms.push({
        roomId: candidate.roomId,
        topic: candidate.topic,
        state,
        label: `${candidate.topic}${describeDungeonArtifactMarkerSuffix(state)}`,
      });
    }
    return createDungeonArtifactSnapshot({
      roomId,
      topic: room?.topic ?? '',
      pickupPermitted: artifactPickupPermitted,
      hasArtifact: roomId !== null && artifactRoomIds.has(roomId),
      collected: roomId !== null && isArtifactCollected(roomId),
      withinPickupRange: roomId !== null && isWithinArtifactPickupRange(roomId),
      rooms,
    });
  }

  /**
   * Tell the DOM mirror that the world moved on its own.
   *
   * ## The two call sites, and why there are exactly two
   *
   * Availability is part of the status sentence, so a publish that does not happen leaves
   * the mirror *stating something untrue*: a disabled Descend with on-page text saying
   * there are no stairs down, in a room that has them. The host publishes after every
   * action, so the only publishes this scene owes are the changes it made itself.
   *
   * Those are exactly two, and neither is on a path the host already covers:
   *
   * 1. `update()`, when `walkability.roomAt()` names a room the player was not in. This is
   *    the walking case, and it is the one that used to be silently absent.
   * 2. `update()`, when a wheel notch or a pinch changed the zoom. A gesture does not
   *    pass through `onAction`, so nothing else announces the new zoom factor.
   *
   * ## What this deliberately does not do
   *
   * - It is not called every frame. Sixty publishes a second would re-render every
   *   `aria-live` region in the mirror sixty times a second.
   * - It is not called from `enterRoom`. `enterRoom` also runs from `teleportToRoom`, which
   *   the renderer already follows with its own `refreshState()`, so publishing there would
   *   deliver the same state twice for one teleport.
   * - It is not called from the zoom *actions*. Those reach `activate` through the host's
   *   dispatch, and the host publishes after `activate` returns. Publishing inside
   *   `adoptZoomAsTarget` would therefore double-publish on every zoom button press, which
   *   is why the call sits at the wheel branch in `update()` instead.
   */
  function publishToDomMirror(): void {
    init.publishState?.();
  }


  /* ── Activation ─────────────────────────────────────────────────────────── */

  function activate(actionId: string, _source: WorldActionSource): boolean {
    switch (actionId) {
      case DUNGEON_INTERACT_ACTION_ID:
        performInteract();
        return true;
      case DUNGEON_ASCEND_ACTION_ID:
        if (currentRoomId === null || currentRoomId !== portalUpRoomId) return false;
        callbacks.onFloorTransition?.({ fromRoomId: currentRoomId, direction: 'up' });
        return true;
      case DUNGEON_DESCEND_ACTION_ID:
        if (currentRoomId === null || !portalDownRoomIds.has(currentRoomId)) return false;
        callbacks.onFloorTransition?.({ fromRoomId: currentRoomId, direction: 'down' });
        return true;
      case DUNGEON_ZOOM_IN_ACTION_ID:
        adoptZoomAsTarget((rig) => rig.addZoom(DUNGEON_ZOOM_STEP));
        return true;
      case DUNGEON_ZOOM_OUT_ACTION_ID:
        adoptZoomAsTarget((rig) => rig.addZoom(-DUNGEON_ZOOM_STEP));
        return true;
      case DUNGEON_ARTIFACT_ACTION_ID:
        // Reached only through `init.onAction`, like every other verb: the host performs
        // it and republishes in one function, so a pickup from a DOM control announces
        // itself exactly once, the same way a zoom button press does.
        return performArtifactCollect();
      default:
        return false;
    }
  }

  /* ── Frame ──────────────────────────────────────────────────────────────── */

  function update(deltaMs: number): void {
    if (deltaMs > 0) {
      const move = input.getMoveVector();
      let vx = move.x;
      let vy = move.y;
      if (vx !== 0 || vy !== 0) {
        const length = Math.hypot(vx, vy) || 1;
        vx = (vx / length) * DUNGEON_PLAYER_SPEED;
        vy = (vy / length) * DUNGEON_PLAYER_SPEED;
      }
      const next = walkability.step(player.x, player.y, (vx * deltaMs) / 1000, (vy * deltaMs) / 1000);
      player.position.set(next.x, next.y);
      const nextFacing = normalizeFacing(vx, vy, facing);
      if (nextFacing !== facing) {
        facing = nextFacing;
        facingMarker.rotation = FACING_ANGLE[facing];
      }
    }

    const zoomDelta = input.consumeZoomDelta();
    if (zoomDelta !== 0) {
      adoptZoomAsTarget((rig) => rig.addZoom(zoomDelta));
      // A gesture never passes through `onAction`, so nothing else republishes the zoom
      // factor in the two status sentences that quote it. The zoom *buttons* do not need
      // this: they go through the host's dispatch, which publishes on its own.
      publishToDomMirror();
    }

    const interact = input.consumeInteract();
    if (interact !== null) {
      // Ask the host. The host performs the action and republishes the state in the
      // same function; calling `activate` here would change the dungeon without the
      // DOM mirror hearing about it.
      init.onAction(DUNGEON_INTERACT_ACTION_ID, interact.source);
    }

    const room = walkability.roomAt(player.x, player.y);
    if (room !== null && room.roomId !== currentRoomId) {
      enterRoom(room.roomId);
      // Walking into a room changes which stairs are available, and availability is part
      // of the published sentence. Without this the mirror keeps announcing the room the
      // player left - and, because the same sentence drives `disabled`, offers a portal
      // control for a room they are no longer in and refuses one for the room they are in.
      publishToDomMirror();
    }

    // Auto-zoom: in inside a room, out on a corridor.
    const wasInsideRoom = insideRoom;
    insideRoom = room !== null;
    if (insideRoom !== wasInsideRoom) {
      setZoomTarget(insideRoom ? DUNGEON_ZOOM_INSIDE_ROOM : DUNGEON_ZOOM_ON_PATH);
      applyRoomStates();
    }

    advanceZoom(deltaMs);
    checkArtifactCollection();
    checkGuideRange();

    // Camera follow. The zoom tween above is already reduced-motion aware; this is the other
    // easing in this world, and Phase 21 found it running. A camera that closes 8% of the
    // remaining distance every frame keeps sliding the whole dungeon across the screen for
    // as long as the learner holds a direction key, and no travel token expresses that -
    // `motion.scale` multiplies one object's offset, and this is a viewport-sized
    // translation.
    //
    // `snapTo`, not `follow` plus a lerp of `1`. Both settle on the same frame, but `snapTo`
    // also writes the follow target, so the next `follow` starts from where the camera
    // actually is rather than easing toward a point the player left frames ago.
    if (motion.scale > 0) {
      camera.follow(rigX(player.x), rigY(player.y));
      camera.update(deltaMs);
    } else {
      camera.snapTo(rigX(player.x), rigY(player.y));
    }
    applyCamera();
  }

  /** The camera as one frozen value, for a DOM status sentence and for the motion gate. */
  function readCameraState(): CameraState {
    return Object.freeze({ ...camera.getState() });
  }

  function onResize(width: number, height: number): void {
    camera.setViewport(width, height);
    applyCamera();
    // The dialog anchor is a projection through this camera, so a resize invalidates it
    // even though nothing in the dungeon moved. Re-measuring emits nothing new: the guide
    // in range has not changed, so `onNpcOutOfRange` does not fire a second time.
    checkGuideRange();
  }

  function setMotionProfile(profile: CozyMotionProfile): void {
    motion = profile;
  }

  function teleportToRoom(roomId: string): void {
    const landing = walkability.landingPointFor(roomId);
    if (landing === null) return;
    player.position.set(landing.x, landing.y);
    insideRoom = true;
    setZoomTarget(DUNGEON_ZOOM_INSIDE_ROOM);
    enterRoom(roomId);
    camera.snapTo(rigX(landing.x), rigY(landing.y));
    applyCamera();
  }

  function triggerInteract(): void {
    init.onAction(DUNGEON_INTERACT_ACTION_ID, 'dom');
  }

  const capabilities: DungeonRendererCapabilities = {
    setFloorVisibility(visibility): void {
      applyFloorVisibility(visibility);
    },
    teleportToRoom,
    setArtifactRooms(roomIds, pickupPermitted): void {
      artifactRoomIds.clear();
      for (const roomId of roomIds) artifactRoomIds.add(roomId);
      artifactPickupPermitted = pickupPermitted;
      applyRoomStates();
    },
    setCollectedArtifactRooms(roomIds): void {
      collectedArtifactRoomIds.clear();
      for (const roomId of roomIds) collectedArtifactRoomIds.add(roomId);
      applyRoomStates();
    },
    setReviewedArtifactRooms(roomIds): void {
      reviewedArtifactRoomIds.clear();
      for (const roomId of roomIds) reviewedArtifactRoomIds.add(roomId);
      applyRoomStates();
    },
    setImageRooms(roomIds): void {
      imageRoomIds.clear();
      for (const roomId of roomIds) imageRoomIds.add(roomId);
      applyRoomStates();
    },
    setRoomOverlayStates(states): void {
      roomOverlayStates.clear();
      for (const [roomId, state] of Object.entries(states)) roomOverlayStates.set(roomId, state);
      applyRoomStates();
    },
    triggerInteract,
  };

  // ── Initial build ─────────────────────────────────────────────────────────
  drawPlayerBody(playerClass);
  drawFacingMarker();
  facingMarker.rotation = FACING_ANGLE[facing];
  applyFloorVisibility(options.world.floor);
  if (spawnRoom !== null) {
    insideRoom = true;
    enterRoom(spawnRoom.roomId);
    camera.snapTo(rigX(player.x), rigY(player.y));
  }
  applyCamera();

  return {
    actions: DUNGEON_ACTIONS,
    activate,
    readState,
    readArtifactSnapshot,
    readCameraState,
    update,
    onResize,
    setMotionProfile,
    capabilities,
    destroy(): void {
      input.destroy();
      for (const node of roomNodes.values()) node.destroy();
      roomNodes.clear();
      corridors?.destroy();
      corridors = null;
      root.removeChildren();
      root.destroy({ children: true });
    },
  };
}