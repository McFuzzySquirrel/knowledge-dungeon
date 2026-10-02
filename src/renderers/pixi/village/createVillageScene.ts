/**
 * The PixiJS village world: ground, paths, structures, portals, and the player.
 *
 * ## What this scene is
 *
 * A renderer for the village `VillageScene` has always drawn: the same 36x30
 * grid at 48 pixels a tile, the same path geometry (now shared, in
 * `src/data/villageLayout.ts`), the same deterministic depth table, the same
 * proximity and point-of-interest rules, and the same spawn-restoration behaviour.
 * It draws all of it procedurally - `Graphics` and `Text`, no image files - because
 * the village sprites under `public/assets/sprites/village/` are
 * `legacy-unverified` and are not admitted to a Pixi bundle by the CC0 gate.
 *
 * ## The seam, and what this scene is not allowed to do
 *
 * The scene implements the host's {@link WorldScene} lifecycle and exposes
 * {@link VillageNpcHost} through `capabilities`. It never performs an
 * action itself: every route into an interaction - the keyboard and touch input
 * controller, the DOM control's `triggerInteract`, and the host's own dispatch -
 * converges on `init.onAction`, so activation and state publication stay in the
 * host's one function. That is why the scene holds no reference to its own
 * `activate`: the object returned below binds it once, exactly as the Phase 9 test
 * world does, and nothing in this module calls it.
 *
 * ## NPCs, and what this scene is still not allowed to do
 *
 * Phase 12 gives the scene a real NPC layer: every NPC in `VILLAGE_MAP.npcs` is
 * drawn, wanders its authored path at `NPC_SPEED`, reports `onNpcApproached` /
 * `onNpcLeft` / `onNpcInteract` / `onNpcDialogPosition` on the same transitions the
 * Phaser scene reports, and answers `readNpcSnapshot()` / `invokeAction()`. The
 * marker and its idle bob live in `./VillageNpc.ts`; the movement, the proximity
 * measurement, and the conversation cursor live in `./NpcController.ts`.
 *
 * What this scene still does not do is *decide* anything about NPCs. It measures
 * where they are and reports the measurements; `selectVillageNpcLine` chooses the
 * line, `selectVillageNearbyTargets` chooses the rows, and the study flow owns the
 * quest step. A scene that ordered a nearby list or picked a dialogue line would be a
 * second source of truth that could disagree with the Phaser build on the same world.
 *
 * ## This is the third `pixi.js` importer
 *
 * `tests/phase9/pixi-host-boundary.test.ts` pins the set of modules that import the
 * engine to a named list, and this file deliberately joins the binding and the
 * Phase 9 test world. The two alternatives were rejected: widening the
 * renderer-neutral host to hand a scene its display classes (which would put a
 * scene graph in a renderer-neutral contract), and drawing the village through a
 * neutral shape abstraction (which would be a second renderer to maintain for one
 * world). The boundary test fails until its list is updated; that is the review.
 */
import { Container, Graphics, Text } from 'pixi.js';

import {
  PLAYER_SPEED,
  VILLAGE_DEPTH,
  VILLAGE_MAP,
  VILLAGE_PATH_JUNCTIONS,
  VILLAGE_PATH_SEGMENTS,
  VILLAGE_TILE_SIZE,
  readVillageSpawn,
  resolveStructureDepth,
  writeVillageSpawn,
  type VillageNpc,
  type VillageStructure,
} from '@/data/villageLayout';
import { createCameraRig } from '@/renderers/pixi/camera/CameraRig';
import { createWorldInputController } from '@/renderers/pixi/input/WorldInputController';
import { cozyTextStyle } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { PixiApplication } from '@/renderers/pixi/runtime/createPixiApplication';
import type {
  WorldAction,
  WorldActionSource,
  WorldActionState,
  WorldScene,
  WorldSceneInit,
} from '@/renderers/pixi/runtime/types';
import type { CozyMotionProfile } from '@/theme';
import type { PlayerClassId } from '@/application/contracts/world';
import type { VillageNpcHost } from '@/application/contracts/renderer';
import {
  VILLAGE_NEARBY_RANGES,
  type VillageActionTarget,
  type VillageNearbyCandidate,
  type VillageNpcDialogAnchor,
} from '@/application/contracts/villageNpc';
import type { VillageWorldModel, WorldPointOfInterest } from '@/application/contracts/world';
import { createNpcController, type NpcController, type NpcRandomness } from './NpcController';
import type { VillageSceneCallbacks, VillageSpawnPoint } from './VillageRenderer';

/** The one action this world offers. The host mirrors it in a DOM control. */
export const VILLAGE_INTERACT_ACTION_ID = 'village-interact';

/**
 * The actions, in DOM focus order.
 *
 * `keyboardKey` is `null` on purpose. The village's keyboard surface is the input
 * controller, which owns arrows/WASD for movement and E/Space for interaction; if
 * the host also bound `e`, one keypress would perform the interact twice - once
 * through the host's shortcut map and once through the controller. The DOM control
 * still names the keys in its own visible label, so a keyboard user learns them.
 */
export const VILLAGE_ACTIONS: readonly WorldAction[] = Object.freeze([
  Object.freeze({
    id: VILLAGE_INTERACT_ACTION_ID,
    label: 'Interact (E or Space)',
    hint: 'Interacts with the nearest structure or non-player character.',
    keyboardKey: null,
    pointer: true,
  }),
]);

/** Structure types that can be the "nearby" one, matching the Phaser scene. */
const INTERACTIVE_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  'portal-icon',
  'keeper-tower',
  'guild-hall',
  'training-gate',
  'signpost',
  'waysign',
  'trophy-hall',
  'library',
  'workshop',
  'fountain',
  'fishing-pond',
  'fish-stand',
]);

/**
 * A small fixed terrain palette.
 *
 * These are art inputs, not a second token source: the Cozy semantic tokens do
 * not name moss, bark, or water, and inventing token names for them would put the
 * design system's vocabulary somewhere the design system is not. Everything that
 * *is* a Cozy surface - labels, buildings, portals, the player - reads the theme.
 */
const TERRAIN = {
  ground: 0x2f4f2f,
  path: 0x5a4a3a,
  junction: 0x4a3a2a,
  trunk: 0x6b4f2a,
  foliage: 0x3f7d3a,
  foliageLight: 0x4f9a48,
  water: 0x3b6ea5,
  waterLight: 0x5a8fc0,
  stone: 0x6f6f6f,
  wood: 0x8a6a3a,
} as const;

/** The player's facing, in the four directions the Phaser scene uses. */
type VillageFacing = 'down' | 'left' | 'right' | 'up';

const FACING_ANGLE: Readonly<Record<VillageFacing, number>> = Object.freeze({
  up: 0,
  right: Math.PI / 2,
  down: Math.PI,
  left: -Math.PI / 2,
});

/** Everything the scene needs beyond the host's own init. */
export interface CreateVillageSceneOptions {
  readonly world: VillageWorldModel;
  readonly callbacks: VillageSceneCallbacks;
  readonly spawn?: VillageSpawnPoint;
  /** The storage the spawn override is read from and written to. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /**
   * The NPC roster. Defaults to `VILLAGE_MAP.npcs`, which is what ships.
   *
   * A parameter rather than a hard-coded read so the *shipped* roster and a one-NPC
   * roster go through identical code, and so a test can pin a villager who does not
   * walk and assert an approach/leave transition to the pixel. The default is the
   * only value the village ever presents.
   */
  readonly npcs?: readonly VillageNpc[];
  /**
   * Ambient randomness for the NPC layer: the opening pause and the
   * between-waypoint pause.
   *
   * Injected for the same reason `NpcRandomness` exists in `./NpcController.ts` -
   * a world whose output depends on ambient `Math.random()` cannot be asserted - and
   * defaulted to the Phaser scene's own behaviour, so leaving it absent changes
   * nothing a learner can observe.
   *
   * A wanderer's opening quote is *not* in here: the application layer chooses the
   * line now, because it is the only layer that knows the learner's quest step, and
   * it supplies the randomness along with the choice.
   */
  readonly npcRandomness?: NpcRandomness;
}

/** The scene contract this world exposes. */
export type VillageScene = WorldScene<VillageNpcHost>;

/* -------------------------------------------------------------------------- */
/* Procedural art                                                              */
/* -------------------------------------------------------------------------- */

function drawTree(g: Graphics, width: number, height: number): void {
  const graphics = g;
  const trunkW = Math.max(3, width * 0.16);
  const trunkH = height * 0.36;
  graphics
    .rect(-trunkW / 2, height / 2 - trunkH, trunkW, trunkH)
    .fill({ color: TERRAIN.trunk, alpha: 1 });
  graphics
    .circle(0, height / 2 - trunkH, width * 0.34)
    .fill({ color: TERRAIN.foliage, alpha: 1 });
  graphics
    .circle(-width * 0.16, height / 2 - trunkH - height * 0.12, width * 0.24)
    .fill({ color: TERRAIN.foliageLight, alpha: 1 });
  graphics
    .circle(width * 0.18, height / 2 - trunkH - height * 0.06, width * 0.22)
    .fill({ color: TERRAIN.foliage, alpha: 1 });
}

function drawBush(g: Graphics, width: number, height: number): void {
  const graphics = g;
  graphics.circle(-width * 0.18, height * 0.12, width * 0.3).fill({ color: TERRAIN.foliage, alpha: 1 });
  graphics.circle(width * 0.18, height * 0.12, width * 0.3).fill({ color: TERRAIN.foliage, alpha: 1 });
  graphics.circle(0, -height * 0.08, width * 0.34).fill({ color: TERRAIN.foliageLight, alpha: 1 });
}

function drawTorch(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  const postW = Math.max(2, width * 0.12);
  graphics
    .rect(-postW / 2, -height * 0.1, postW, height * 0.6)
    .fill({ color: TERRAIN.wood, alpha: 1 });
  graphics.circle(0, -height * 0.18, width * 0.22).fill({ color: theme.color.accent, alpha: 0.28 });
  graphics.circle(0, -height * 0.18, width * 0.12).fill({ color: theme.color.accent, alpha: 1 });
}

function drawSignpost(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  const postW = Math.max(2, width * 0.1);
  graphics.rect(-postW / 2, -height * 0.1, postW, height * 0.6).fill({ color: TERRAIN.wood, alpha: 1 });
  graphics
    .roundRect(-width * 0.36, -height * 0.34, width * 0.72, height * 0.2, theme.radius.sm)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: 1.5, color: theme.color.borderStrong, alignment: 0.5 });
  graphics
    .roundRect(-width * 0.3, -height * 0.08, width * 0.6, height * 0.18, theme.radius.sm)
    .fill({ color: theme.color.surfacePanel, alpha: 1 })
    .stroke({ width: 1.5, color: theme.color.borderStrong, alignment: 0.5 });
}

function drawFountain(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  graphics
    .ellipse(0, height * 0.18, width * 0.42, height * 0.22)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: 2, color: theme.color.borderStrong, alignment: 0.5 });
  graphics.ellipse(0, height * 0.18, width * 0.32, height * 0.15).fill({ color: TERRAIN.water, alpha: 1 });
  graphics
    .circle(0, height * 0.04, width * 0.12)
    .fill({ color: theme.color.surfacePanel, alpha: 1 })
    .stroke({ width: 1.5, color: theme.color.borderStrong, alignment: 0.5 });
  graphics.circle(0, -height * 0.12, width * 0.06).fill({ color: TERRAIN.waterLight, alpha: 0.9 });
}

function drawPond(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  graphics
    .ellipse(0, 0, width * 0.44, height * 0.34)
    .fill({ color: TERRAIN.water, alpha: 1 })
    .stroke({ width: 2, color: theme.color.borderStrong, alignment: 0.5 });
  graphics.ellipse(-width * 0.1, -height * 0.06, width * 0.16, height * 0.1).fill({ color: TERRAIN.waterLight, alpha: 0.7 });
}

function drawBench(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  graphics
    .roundRect(-width * 0.44, -height * 0.1, width * 0.88, height * 0.22, theme.radius.sm)
    .fill({ color: TERRAIN.wood, alpha: 1 })
    .stroke({ width: 1.5, color: theme.color.borderStrong, alignment: 0.5 });
  graphics.rect(-width * 0.36, height * 0.12, width * 0.08, height * 0.28).fill({ color: TERRAIN.trunk, alpha: 1 });
  graphics.rect(width * 0.28, height * 0.12, width * 0.08, height * 0.28).fill({ color: TERRAIN.trunk, alpha: 1 });
}

function drawFlower(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  graphics.moveTo(0, height * 0.34).lineTo(0, -height * 0.06).stroke({ width: 2, color: TERRAIN.foliage, alpha: 1 });
  graphics.circle(0, -height * 0.14, width * 0.18).fill({ color: theme.color.accent, alpha: 1 });
  graphics.circle(0, -height * 0.14, width * 0.07).fill({ color: theme.color.surfaceRaised, alpha: 1 });
}

function drawRock(g: Graphics, width: number, height: number): void {
  const graphics = g;
  graphics.ellipse(0, height * 0.08, width * 0.36, height * 0.26).fill({ color: TERRAIN.stone, alpha: 1 });
  graphics.ellipse(-width * 0.08, 0, width * 0.2, height * 0.14).fill({ color: 0x8f8f8f, alpha: 0.7 });
}

function drawGate(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  const postW = Math.max(4, width * 0.12);
  graphics.rect(-width * 0.4, -height * 0.2, postW, height * 0.68).fill({ color: TERRAIN.wood, alpha: 1 });
  graphics.rect(width * 0.4 - postW, -height * 0.2, postW, height * 0.68).fill({ color: TERRAIN.wood, alpha: 1 });
  graphics
    .roundRect(-width * 0.46, -height * 0.34, width * 0.92, height * 0.2, theme.radius.sm)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: 2, color: theme.color.borderStrong, alignment: 0.5 });
}

function drawPortal(g: Graphics, width: number, height: number, theme: CozyWorldTheme): void {
  const graphics = g;
  const radius = Math.min(width, height) * 0.42;
  graphics.circle(0, 0, radius).fill({ color: theme.color.accent, alpha: 0.22 });
  graphics.circle(0, 0, radius * 0.68).stroke({ width: 3, color: theme.color.accent, alpha: 0.9 });
  graphics.circle(0, 0, radius * 0.36).fill({ color: theme.color.accentDeep, alpha: 0.9 });
  graphics.circle(0, 0, radius * 0.14).fill({ color: theme.color.surfaceRaised, alpha: 0.9 });
}

function drawBuilding(
  g: Graphics,
  width: number,
  height: number,
  theme: CozyWorldTheme,
  type: string,
): void {
  const graphics = g;
  const margin = 3;
  const isTower = type === 'keeper-tower';
  const bodyHeight = height * (isTower ? 0.72 : 0.64);
  const bodyTop = height / 2 - bodyHeight;
  const bodyLeft = -width / 2 + margin;
  const bodyWidth = width - margin * 2;

  graphics
    .roundRect(bodyLeft, bodyTop, bodyWidth, bodyHeight, theme.radius.sm)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: 2, color: theme.color.borderStrong, alignment: 0.5 });

  const roofColor = isTower ? theme.color.accentDeep : theme.color.accent;
  graphics
    .poly([bodyLeft - 3, bodyTop, bodyLeft + bodyWidth + 3, bodyTop, 0, bodyTop - height * 0.24])
    .fill({ color: roofColor, alpha: 1 });

  const doorWidth = Math.max(6, width * 0.2);
  const doorHeight = Math.max(8, bodyHeight * 0.42);
  graphics
    .roundRect(-doorWidth / 2, bodyTop + bodyHeight - doorHeight, doorWidth, doorHeight, 2)
    .fill({ color: theme.color.accentDeep, alpha: 1 });

  const windowSize = Math.max(4, width * 0.12);
  graphics
    .rect(bodyLeft + bodyWidth * 0.16, bodyTop + bodyHeight * 0.22, windowSize, windowSize)
    .fill({ color: theme.color.accent, alpha: 0.9 });
  graphics
    .rect(bodyLeft + bodyWidth * 0.66, bodyTop + bodyHeight * 0.22, windowSize, windowSize)
    .fill({ color: theme.color.accent, alpha: 0.9 });
}

function drawStructure(struct: VillageStructure, theme: CozyWorldTheme, tile: number): Graphics {
  const width = struct.width * tile;
  const height = struct.height * tile;
  const graphics = new Graphics();
  // Widened to `string` because the Phaser scene's own foreground set names `lamp`,
  // which the content union does not declare; a future widening draws it as a torch
  // rather than falling through to a building.
  switch (struct.type as string) {
    case 'tree':
      drawTree(graphics, width, height);
      break;
    case 'bush':
      drawBush(graphics, width, height);
      break;
    case 'torch':
    case 'lamp':
      drawTorch(graphics, width, height, theme);
      break;
    case 'signpost':
    case 'waysign':
      drawSignpost(graphics, width, height, theme);
      break;
    case 'fountain':
      drawFountain(graphics, width, height, theme);
      break;
    case 'pond':
    case 'fishing-pond':
      drawPond(graphics, width, height, theme);
      break;
    case 'bench':
      drawBench(graphics, width, height, theme);
      break;
    case 'flower':
      drawFlower(graphics, width, height, theme);
      break;
    case 'rock':
      drawRock(graphics, width, height);
      break;
    case 'gate':
    case 'training-gate':
      drawGate(graphics, width, height, theme);
      break;
    case 'portal-icon':
      drawPortal(graphics, width, height, theme);
      break;
    default:
      drawBuilding(graphics, width, height, theme, struct.type);
      break;
  }
  return graphics;
}

function drawPlayerBody(graphics: Graphics, playerClass: PlayerClassId, theme: CozyWorldTheme): void {
  graphics.clear();
  const body =
    playerClass === 'cartographer'
      ? theme.color.good
      : playerClass === 'archivist'
        ? theme.color.info
        : theme.color.accent;
  graphics
    .circle(0, 0, 9)
    .fill({ color: body, alpha: 1 })
    .stroke({ width: 2, color: theme.color.borderStrong, alignment: 0.5 });
  graphics
    .circle(0, -9, 5)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: 1.5, color: theme.color.borderStrong, alignment: 0.5 });
}

function drawFacingMarker(graphics: Graphics, theme: CozyWorldTheme): void {
  graphics.clear();
  graphics
    .poly([0, -18, -4, -11, 4, -11])
    .fill({ color: theme.color.accent, alpha: 1 })
    .stroke({ width: 1, color: theme.color.borderStrong, alignment: 0.5 });
}

function drawBird(theme: CozyWorldTheme): Graphics {
  const graphics = new Graphics();
  graphics
    .poly([-7, 0, 0, -4, 7, 0, 0, 2])
    .fill({ color: theme.color.textMuted, alpha: 0.85 });
  return graphics;
}

/* -------------------------------------------------------------------------- */
/* The scene                                                                   */
/* -------------------------------------------------------------------------- */

/** One rendered structure and every display object that belongs to it. */
interface RenderedStructure {
  readonly structure: VillageStructure;
  readonly objects: Container[];
}

/** The static bird routes, as fractions of the world, mirroring the Phaser scene. */
const BIRD_ROUTES: readonly { sx: number; sy: number; dx: number }[] = Object.freeze([
  { sx: 0.1, sy: 0.05, dx: 0.4 },
  { sx: 0.5, sy: 0.02, dx: 0.7 },
  { sx: 0.8, sy: 0.1, dx: 0.55 },
  { sx: 0.3, sy: 0.15, dx: 0.15 },
  { sx: 0.65, sy: 0.06, dx: 0.9 },
  { sx: 0.45, sy: 0.12, dx: 0.3 },
]);

/**
 * Build the village scene onto an application's stage.
 *
 * Everything the scene creates is reachable from the labelled root and released
 * by `destroy`, which is the discipline the twenty-cycle memory gate measures: no
 * listener the input controller adds outlives the scene, and no display object is
 * left on a stage that is about to be destroyed.
 */
export function createVillageScene(
  application: PixiApplication,
  init: WorldSceneInit,
  options: CreateVillageSceneOptions,
): VillageScene {
  const theme = init.theme;
  let motion: CozyMotionProfile = theme.motion;

  const tile = VILLAGE_TILE_SIZE;
  const worldWidth = VILLAGE_MAP.width * tile;
  const worldHeight = VILLAGE_MAP.height * tile;

  const storage = resolveStorage(application, options.storage);

  const root = new Container();
  root.label = 'village-world';
  application.stage.addChild(root);

  const world = new Container();
  world.label = 'village-world-layer';
  // Deterministic depth is a sort, not a draw order a scene has to maintain by
  // insertion. `zIndex` is set from the shared table; Pixi sorts on render.
  world.sortableChildren = true;
  root.addChild(world);

  const ground = new Graphics();
  ground.rect(0, 0, worldWidth, worldHeight).fill({ color: TERRAIN.ground, alpha: 1 });
  ground.zIndex = VILLAGE_DEPTH.ground;
  world.addChild(ground);

  const path = drawPaths(tile);
  path.zIndex = VILLAGE_DEPTH.path;
  world.addChild(path);

  const staticRendered: RenderedStructure[] = [];
  const dynamicRendered: RenderedStructure[] = [];
  for (const structure of VILLAGE_MAP.structures) {
    staticRendered.push(renderStructure(structure, world, theme, tile));
  }

  let allStructures: VillageStructure[] = [...VILLAGE_MAP.structures];
  let interactive: VillageStructure[] = allStructures.filter((structure) =>
    INTERACTIVE_STRUCTURE_TYPES.has(structure.type),
  );

  for (const structure of options.world.structures) {
    dynamicRendered.push(renderStructure(structure, world, theme, tile));
  }
  refreshAllStructures(options.world.structures);

  const player = new Container();
  player.label = 'village-player';
  player.zIndex = VILLAGE_DEPTH.player;
  world.addChild(player);

  const playerBody = new Graphics();
  const facingMarker = new Graphics();
  drawPlayerBody(playerBody, options.world.playerClass ?? 'scholar', theme);
  drawFacingMarker(facingMarker, theme);
  player.addChild(playerBody, facingMarker);

  let playerClass: PlayerClassId = options.world.playerClass ?? 'scholar';
  let facing: VillageFacing = 'down';
  let currentStructureId: string | null = null;
  let lastInteractedId: string | null = null;
  let lastPoi: WorldPointOfInterest = { name: '', angle: 0, distance: Number.POSITIVE_INFINITY };

  const spawnGrid = resolveSpawn(options.spawn, storage);
  player.position.set(spawnGrid.gridX * tile + tile / 2, spawnGrid.gridY * tile + tile / 2);

  const birds = BIRD_ROUTES.map((route) => {
    const bird = drawBird(theme);
    bird.zIndex = VILLAGE_DEPTH.bird;
    bird.position.set(worldWidth * route.sx, worldHeight * route.sy);
    world.addChild(bird);
    return { bird, route };
  });
  let birdElapsedMs = 0;

  const camera = createCameraRig({
    worldWidth,
    worldHeight,
    viewportWidth: Math.max(1, application.screen.width),
    viewportHeight: Math.max(1, application.screen.height),
  });
  camera.snapTo(player.x, player.y);
  applyCamera();

  const input = createWorldInputController({ element: application.canvas as HTMLCanvasElement });

  /**
   * Project a world point to CSS viewport pixels, for the dialog anchor.
   *
   * The anchor the contract wants is in the space the DOM dialog is positioned in, so
   * the conversion happens here, at the renderer's own edge, rather than the scene
   * handing Pixi screen space to a panel and asking it to finish the maths. The
   * projection is the same one `applyCamera` applies to the world layer, read from
   * the same camera state, so a dialog cannot disagree with where the villager is
   * drawn except by the two copies of that maths disagreeing - and there is only one
   * copy, because `applyCamera` and this function both read `camera.getState()`.
   */
  function projectToViewport(
    npcId: string,
    x: number,
    y: number,
  ): VillageNpcDialogAnchor {
    const state = camera.getState();
    const canvas = application.canvas as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect?.();
    return {
      npcId,
      clientX:
        (rect?.left ?? 0) +
        x * state.zoom +
        (state.viewportWidth / 2 - state.centerX * state.zoom),
      clientY:
        (rect?.top ?? 0) +
        y * state.zoom +
        (state.viewportHeight / 2 - state.centerY * state.zoom),
    };
  }

  /**
   * The roster this scene is presenting.
   *
   * Held once and passed to the controller, so the status read-out names the same
   * villager the markers drew. Two sources would be two rosters, and a custom roster
   * with a `VILLAGE_MAP` lookup would announce "Exploring the village" while a
   * villager is standing right there.
   */
  const npcRoster = options.npcs ?? VILLAGE_MAP.npcs;

  const npcs: NpcController = createNpcController({
    parent: world,
    npcs: npcRoster,
    tile,
    theme,
    callbacks: options.callbacks,
    readPlayerPosition: () => ({ x: player.x, y: player.y }),
    projectToViewport,
    readStructureCandidates: structureCandidates,
    randomness: options.npcRandomness,
  });

  function resolveStorage(
    app: PixiApplication,
    provided: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
  ): Pick<Storage, 'getItem' | 'setItem'> | null {
    if (provided !== undefined) return provided;
    try {
      return (app.canvas as HTMLCanvasElement).ownerDocument?.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  function resolveSpawn(
    spawn: VillageSpawnPoint | undefined,
    store: Pick<Storage, 'getItem' | 'setItem'> | null,
  ): { gridX: number; gridY: number } {
    if (
      spawn &&
      typeof spawn.gridX === 'number' &&
      typeof spawn.gridY === 'number' &&
      Number.isFinite(spawn.gridX) &&
      Number.isFinite(spawn.gridY)
    ) {
      return { gridX: spawn.gridX, gridY: spawn.gridY };
    }
    const stored = readVillageSpawn(store);
    if (stored !== null) return stored;
    return { gridX: VILLAGE_MAP.playerStart.x, gridY: VILLAGE_MAP.playerStart.y };
  }

  function drawPaths(tileSize: number): Graphics {
    const graphics = new Graphics();
    for (const segment of VILLAGE_PATH_SEGMENTS) {
      graphics.moveTo(
        segment.x1 * tileSize + tileSize / 2,
        segment.y1 * tileSize + tileSize / 2,
      );
      graphics.lineTo(
        segment.x2 * tileSize + tileSize / 2,
        segment.y2 * tileSize + tileSize / 2,
      );
    }
    graphics.stroke({ width: tileSize * 0.5, color: TERRAIN.path, alpha: 0.6, cap: 'round' });
    for (const junction of VILLAGE_PATH_JUNCTIONS) {
      graphics
        .circle(junction.x * tileSize + tileSize / 2, junction.y * tileSize + tileSize / 2, tileSize * 0.28)
        .fill({ color: TERRAIN.junction, alpha: 0.5 });
    }
    return graphics;
  }

  function renderStructure(
    structure: VillageStructure,
    parent: Container,
    worldTheme: CozyWorldTheme,
    tileSize: number,
  ): RenderedStructure {
    const centerX = (structure.gridX + structure.width / 2) * tileSize;
    const centerY = (structure.gridY + structure.height / 2) * tileSize;
    const objects: Container[] = [];

    const artwork = drawStructure(structure, worldTheme, tileSize);
    artwork.position.set(centerX, centerY);
    artwork.zIndex = resolveStructureDepth(structure.type);
    parent.addChild(artwork);
    objects.push(artwork);

    if (structure.type === 'portal-icon') {
      // A flat stone pad under the portal, at its own depth below every building.
      const stone = new Graphics();
      stone
        .ellipse(centerX, centerY + 8, structure.width * tileSize * 0.35, structure.height * tileSize * 0.1)
        .fill({ color: 0x3a3a3a, alpha: 0.4 })
        .stroke({ width: 1, color: 0x5a5a5a, alpha: 0.3 });
      stone.zIndex = VILLAGE_DEPTH.portalStone;
      parent.addChild(stone);
      objects.push(stone);
    }

    if (structure.label) {
      const isPortalStyle = structure.type === 'portal-icon';
      const bannerHeight = isPortalStyle ? 22 : 20;
      const bannerWidth = structure.width * tileSize - 8;
      const bannerX = centerX - (structure.width * tileSize) / 2 + 4;
      const bannerY = structure.gridY * tileSize + 4;

      const banner = new Graphics();
      banner
        .roundRect(bannerX, bannerY, bannerWidth, bannerHeight, 4)
        .fill({ color: 0x0a0a1a, alpha: 0.75 })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.1 });
      banner.zIndex = VILLAGE_DEPTH.portalLabelBanner;
      parent.addChild(banner);
      objects.push(banner);

      const label = new Text({
        text: structure.label,
        style: cozyTextStyle(worldTheme, {
          role: 'body',
          size: isPortalStyle ? 'xs' : 'sm',
          weight: isPortalStyle ? 'bold' : 'regular',
          color: isPortalStyle ? 'accent' : 'textPrimary',
        }),
      });
      label.anchor.set(0.5, 0.5);
      label.position.set(centerX, bannerY + bannerHeight / 2);
      label.zIndex = VILLAGE_DEPTH.portalLabelText;
      parent.addChild(label);
      objects.push(label);
    }

    return { structure, objects };
  }

  function destroyRendered(rendered: RenderedStructure[]): void {
    for (const record of rendered) {
      for (const object of record.objects) {
        object.removeFromParent();
        object.destroy({ children: true });
      }
    }
    rendered.length = 0;
  }

  function refreshAllStructures(dynamic: readonly VillageStructure[]): void {
    allStructures = [...VILLAGE_MAP.structures, ...dynamic];
    interactive = allStructures.filter((structure) =>
      INTERACTIVE_STRUCTURE_TYPES.has(structure.type),
    );
  }

  function applyCamera(): void {
    const state = camera.getState();
    world.scale.set(state.zoom);
    world.position.set(
      state.viewportWidth / 2 - state.centerX * state.zoom,
      state.viewportHeight / 2 - state.centerY * state.zoom,
    );
  }

  function updateFacing(vx: number, vy: number): void {
    let next: VillageFacing = facing;
    if (vy < -0.1) next = 'up';
    else if (vy > 0.1) next = 'down';
    else if (vx < -0.1) next = 'left';
    else if (vx > 0.1) next = 'right';
    if (next === facing) return;
    facing = next;
    facingMarker.rotation = FACING_ANGLE[facing];
  }

  function updateStructureProximity(): void {
    let closestId: string | null = null;
    let closestDistance = VILLAGE_NEARBY_RANGES.structure;
    for (const structure of interactive) {
      const centerX = (structure.gridX + structure.width / 2) * tile;
      const centerY = (structure.gridY + structure.height / 2) * tile;
      const distance = Math.hypot(player.x - centerX, player.y - centerY);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = structure.id;
      }
    }
    if (closestId === currentStructureId) return;
    if (currentStructureId !== null) options.callbacks.onStructureLeft(currentStructureId);
    currentStructureId = closestId;
    if (closestId !== null) options.callbacks.onStructureApproached(closestId);
  }

  function updatePoi(): void {
    let nearestName = '';
    let nearestAngle = 0;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;
    for (const structure of allStructures) {
      if (structure.type !== 'portal-icon' && structure.type !== 'keeper-tower') continue;
      const centerX = (structure.gridX + structure.width / 2) * tile;
      const centerY = (structure.gridY + structure.height / 2) * tile;
      const dx = centerX - player.x;
      const dy = centerY - player.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearestAngle = Math.atan2(dy, dx);
        nearestName =
          structure.type === 'keeper-tower'
            ? 'Keeper'
            : structure.subjectName || structure.label || 'Dungeon';
      }
    }
    lastPoi = nearestName
      ? { name: nearestName, angle: nearestAngle, distance: Math.sqrt(nearestDistanceSq) }
      : { name: '', angle: 0, distance: Number.POSITIVE_INFINITY };
  }

  function animateBirds(deltaMs: number): void {
    const travel = motion.travelPx('small');
    if (travel <= 0) {
      // Reduced motion: the birds stay where they were placed rather than sweeping.
      return;
    }
    birdElapsedMs += deltaMs;
    for (let index = 0; index < birds.length; index += 1) {
      const { bird, route } = birds[index];
      const phase = index * 0.9;
      const sweep = 0.5 + 0.5 * Math.sin(birdElapsedMs / 2600 + phase);
      bird.x = worldWidth * (route.sx + (route.dx - route.sx) * sweep);
      bird.y = worldHeight * route.sy + Math.sin(birdElapsedMs / 1700 + phase) * travel;
    }
  }

  /**
   * Raw proximity measurement for every structure the interact verb can reach.
   *
   * Measurements and not rows: `VILLAGE_NEARBY_RANGES.structure` says how close a
   * building must be, and `selectVillageNearbyTargets` decides which of these become
   * a nearby-action row and in what order. The scene measures, the contract selects -
   * which is what makes the Pixi and Phaser builds produce the same list from the
   * same world.
   *
   * Only the interactive types are measured, because a row for a decorative bush
   * would be a control the world refuses to act on.
   */
  function structureCandidates(): readonly VillageNearbyCandidate[] {
    const candidates: VillageNearbyCandidate[] = [];
    for (const structure of interactive) {
      const centerX = (structure.gridX + structure.width / 2) * tile;
      const centerY = (structure.gridY + structure.height / 2) * tile;
      candidates.push({
        kind: 'structure',
        id: structure.id,
        label: structure.label || structure.type,
        distance: Math.hypot(player.x - centerX, player.y - centerY),
        range: VILLAGE_NEARBY_RANGES.structure,
      });
    }
    return candidates;
  }

  /**
   * Act on one structure, exactly as the Phaser scene does.
   *
   * Split out of the interact verb so a named-target request reaches the *same*
   * function rather than a second copy of the portal-spawn side effect.
   */
  function interactStructure(structureId: string): void {
    const structure = allStructures.find((candidate) => candidate.id === structureId) ?? null;
    if (structure && structure.type === 'portal-icon' && structure.subjectId) {
      // The spawn override is the portal's grid position, exactly as the Phaser
      // scene writes it: returning from the dungeon places the learner back at
      // the portal they left from.
      writeVillageSpawn(storage, structure.gridX, structure.gridY);
    }
    lastInteractedId = structureId;
    options.callbacks.onStructureInteract(structureId);
  }

  /**
   * The one interact verb, with an optional named target.
   *
   * `target` is a named *intent*, not a guarantee - `VillageActionInvocation` says so
   * explicitly - so a request is honoured when the thing it names is genuinely in
   * range, and otherwise falls back to the whole-village verb, which resolves a
   * structure first and an NPC only when no structure is in range. A `null` target is
   * that bare verb, and is what the canvas tap, the `E` key, and the existing
   * "Interact" button all produce.
   *
   * Falling back rather than dropping is the point: a learner who pressed a labelled
   * control and saw nothing happen learns that the control lies.
   */
  function handleInteract(target: VillageActionTarget | null): void {
    if (target !== null) {
      if (target.kind === 'structure' && target.id === currentStructureId) {
        interactStructure(currentStructureId);
        return;
      }
      if (target.kind === 'npc' && target.id === npcs.currentNpcId) {
        npcs.interact();
        return;
      }
      // The named target is not in range. Fall through to the whole-village verb
      // rather than no-op, and let the status read-out say what actually happened.
    }

    const structureId = currentStructureId;
    if (structureId !== null) {
      interactStructure(structureId);
      return;
    }
    npcs.interact();
  }

  /**
   * The named intent a DOM control asked for, consumed by the activation it triggers.
   *
   * `WorldActionDispatcher` is `(actionId, source)` and the Phase 9 rule is that a
   * scene never calls its own `activate`, so there is no signature to widen: the
   * target rides beside the dispatch and is read back by the activation that dispatch
   * performs. `invokeAction` clears it as soon as the dispatch returns, so a host
   * that dispatched later - or not at all - cannot leave an intent behind to be
   * honoured by an unrelated interact that happens to come next. The shipped host
   * dispatches synchronously, which
   * `tests/phase12/village-npc-renderer.test.ts` asserts rather than assumes.
   */
  let pendingTarget: VillageActionTarget | null = null;

  function applyAction(actionId: string, _source: WorldActionSource): boolean {
    if (actionId === VILLAGE_INTERACT_ACTION_ID) {
      const target = pendingTarget;
      pendingTarget = null;
      handleInteract(target);
      return true;
    }
    return false;
  }

  function statusText(): string {
    const nearest =
      currentStructureId === null
        ? null
        : allStructures.find((structure) => structure.id === currentStructureId) ?? null;
    if (nearest) return `Near ${nearest.label || nearest.type}`;
    // The NPC in range is named here, not just drawn, because this string is the
    // `aria-live` line the DOM mirror announces and the only non-visual statement of
    // who the interact key is about to talk to. A named target that falls back is
    // exactly the case that needs a learner to hear what they actually got.
    const npcId = npcs.currentNpcId;
    if (npcId !== null) {
      const npc = npcRoster.find((candidate) => candidate.id === npcId);
      if (npc) return `Near ${npc.label}`;
    }
    if (lastInteractedId !== null) {
      const interacted = allStructures.find((structure) => structure.id === lastInteractedId);
      if (interacted) return `Left ${interacted.label || interacted.type}`;
    }
    return 'Exploring the village';
  }

  function readState(): WorldActionState {
    return Object.freeze({ [VILLAGE_INTERACT_ACTION_ID]: statusText() });
  }

  function update(deltaMs: number): void {
    if (deltaMs > 0) {
      const move = input.getMoveVector();
      let vx = move.x;
      let vy = move.y;
      if (vx !== 0 || vy !== 0) {
        const length = Math.hypot(vx, vy) || 1;
        vx /= length;
        vy /= length;
      }
      const dt = deltaMs / 1000;
      player.x = clamp(player.x + vx * PLAYER_SPEED * dt, 0, worldWidth);
      player.y = clamp(player.y + vy * PLAYER_SPEED * dt, 0, worldHeight);
      updateFacing(vx, vy);
    }

    const zoomDelta = input.consumeZoomDelta();
    if (zoomDelta !== 0) {
      camera.addZoom(zoomDelta);
      input.setZoom(camera.getState().zoom);
    }

    const interact = input.consumeInteract();
    if (interact !== null) {
      // Ask the host. The host performs the action and republishes the state in the
      // same function; calling `applyAction` here would change the world without
      // the DOM mirror hearing about it.
      init.onAction(VILLAGE_INTERACT_ACTION_ID, interact.source);
    }

    camera.follow(player.x, player.y);
    camera.update(deltaMs);
    applyCamera();
    updateStructureProximity();
    // NPC movement and proximity, after the camera has been applied and the player's
    // position has settled for this frame: the anchor is projected from the camera
    // state, so it has to be the one that is about to be rendered.
    npcs.update(deltaMs, motion);
    updatePoi();
    animateBirds(deltaMs);
  }

  function onResize(width: number, height: number): void {
    camera.setViewport(width, height);
    applyCamera();
    // The anchor is a projection through this camera, so a resize invalidates it even
    // though nothing in the world moved. Re-measuring also re-emits nothing: the NPC
    // in range has not changed, so `onNpcApproached` does not fire a second time.
    npcs.sync(motion);
  }

  function setMotionProfile(profile: CozyMotionProfile): void {
    motion = profile;
  }

  function setDynamicStructures(structures: readonly VillageStructure[]): void {
    destroyRendered(dynamicRendered);
    refreshAllStructures(structures);
    for (const structure of structures) {
      dynamicRendered.push(renderStructure(structure, world, theme, tile));
    }
  }

  function setPlayerClass(next: PlayerClassId | null): void {
    playerClass = next ?? 'scholar';
    drawPlayerBody(playerBody, playerClass, theme);
  }

  function readPoi(): WorldPointOfInterest | null {
    // The same sentinel the Phaser scene uses: no candidate, or one beyond the
    // compass's reach, reads as absent rather than as a zero-distance POI.
    if (!lastPoi || lastPoi.distance >= 1e9) return null;
    return { name: lastPoi.name, angle: lastPoi.angle, distance: lastPoi.distance };
  }

  const capabilities: VillageNpcHost = {
    setDynamicStructures: (structures) => setDynamicStructures(structures),
    setPlayerClass: (next) => setPlayerClass(next),
    triggerInteract: () => {
      // The host's dispatch, so the DOM control's interact is the same action as
      // the keyboard's and the canvas tap's, and so the state republishes.
      init.onAction(VILLAGE_INTERACT_ACTION_ID, 'dom');
    },
    readPoi: () => readPoi(),

    /**
     * One coherent read of the NPC surface.
     *
     * Data out of a port, not a handle on the scene, for the reason `readPoi` set:
     * a panel that watched a renderer object would re-create the scene-reference
     * polling Phase 12 removed for the compass. The controller measures and the
     * contract selects, so `nearby` here is `selectVillageNearbyTargets(candidates)`
     * and cannot disagree with it.
     */
    readNpcSnapshot: () => npcs.readSnapshot(),

    /**
     * The one route from a DOM control to the village.
     *
     * Through `init.onAction` and not `applyAction`, because answering an action is
     * also what republishes the state to every `aria-live` mirror - the Phase 9 rule,
     * restated for the village. A button click, a canvas tap, and the `E` key are
     * then literally the same call, and the only thing a DOM control adds is the
     * *named* target, which the activation consumes.
     *
     * An action id this scene does not declare is ignored rather than forced: the
     * scene's own `activate` is the authority on which actions exist, and inventing
     * one here would be a second action table.
     */
    invokeAction: (invocation) => {
      if (invocation.actionId !== VILLAGE_INTERACT_ACTION_ID) return;
      pendingTarget = invocation.target;
      init.onAction(invocation.actionId, invocation.source);
      // The shipped host dispatches synchronously, so this is already `null`. The
      // clear is for a host that defers or declines: an intent left standing would be
      // honoured by whichever unrelated interact happened to arrive next.
      pendingTarget = null;
    },
  };

  // One initial proximity read, so the world is correct before the first frame.
  updateStructureProximity();
  npcs.sync(motion);
  updatePoi();
  facingMarker.rotation = FACING_ANGLE[facing];

  return {
    actions: VILLAGE_ACTIONS,
    activate: applyAction,
    readState,
    update,
    onResize,
    setMotionProfile,
    capabilities,
    destroy(): void {
      input.destroy();
      // NPCs before the world layer: the markers are children of `world`, and
      // releasing them first means `root.destroy` is not the thing that has to find
      // them. The memory gate mounts and unmounts this scene twenty times, so a
      // marker that outlived its scene would show up as retained display objects.
      npcs.destroy();
      destroyRendered(dynamicRendered);
      destroyRendered(staticRendered);
      root.removeChildren();
      root.destroy({ children: true });
    },
  };
}

/** Clamp a number into a closed range. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
