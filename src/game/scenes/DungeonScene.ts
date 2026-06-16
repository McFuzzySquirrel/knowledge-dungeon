/**
 * Phaser dungeon-crawler scene.
 * Renders rooms and corridors derived from the topic graph, supports
 * WASD/arrow movement, room collision, an interact trigger for the Scribe
 * encounter, and emits visited-room / interact events via Phaser's emitter.
 */
import Phaser from 'phaser';
import type {
  DungeonDoor,
  DungeonMap,
  DungeonRoom,
} from '@/game/systems/dungeonTypes';
import type { PlayerClassId } from '@/game/systems/playerClasses';
import {
  ensureBiomeFloorTexture,
  resolveFloorBiome,
  type FloorBiomeId,
} from '@/game/systems/proceduralTextures';
import { isEditableElementFocused } from '@/ui/utils/editableElement';

export interface DungeonSceneEvents {
  onRoomEntered: (roomId: string) => void;
  onInteract: (roomId: string) => void;
  onNpcInteract?: (payload: NpcDialogAnchor) => void;
  onNpcDialogPosition?: (payload: NpcDialogAnchor) => void;
  onNpcOutOfRange?: (roomId: string) => void;
  onArtifactCollected?: (roomId: string) => void;
  /**
   * Fired when the player presses E inside a portal room (up or down).
   * The React layer is responsible for choosing the destination floor,
   * calling {@link DungeonScene.setFloorVisibility}, then
   * {@link DungeonScene.teleportToRoom}.
   */
  onFloorTransition?: (info: {
    fromRoomId: string;
    direction: 'up' | 'down';
  }) => void;
}

export interface NpcDialogAnchor {
  roomId: string;
  clientX: number;
  clientY: number;
}

export interface FloorVisibilityInput {
  floorId: string;
  visibleRoomIds: ReadonlySet<string> | readonly string[];
  portalUpRoomId: string | null;
  portalDownRoomIds: ReadonlySet<string> | readonly string[];
  biomeId?: FloorBiomeId;
}

const PLAYER_SPEED = 160;

// Camera zoom levels. Higher = zoomed in. We zoom in when the player is
// standing inside a room so the room feels focused, and zoom out while
// traveling along a corridor between rooms so more of the map is visible.
const ZOOM_INSIDE_ROOM = 1.6;
const ZOOM_ON_PATH = 0.85;
const ZOOM_TWEEN_MS = 320;

/**
 * Per-class sprite asset path. Sprites live under `public/assets/sprites/`
 * (copied from the repo-dungeon project) and are served at a path relative
 * to the Vite base URL, which is `./` in Electron and `/` in the web build.
 * Fall back to `player.svg` when no class is selected.
 */
const BASE = import.meta.env.BASE_URL;
const PLAYER_SPRITE_BY_CLASS: Record<PlayerClassId, string> = {
  scholar: `${BASE}assets/sprites/player-hero.svg`,
  cartographer: `${BASE}assets/sprites/player-explorer.svg`,
  archivist: `${BASE}assets/sprites/player-archivist.svg`,
};
const PLAYER_SPRITE_FALLBACK = `${BASE}assets/sprites/player.svg`;
const SIGNPOST_SPRITE = `${BASE}assets/sprites/signpost.svg`;
const NPC_GUIDE_SPRITE = `${BASE}assets/sprites/npc-scribe.svg`;
const ARTIFACT_LOOT_SPRITE = `${BASE}assets/sprites/objects/artifact-loot.svg`;
const DOOR_SPRITE = `${BASE}assets/sprites/objects/door.svg`;
const STAIRS_UP_SPRITE = `${BASE}assets/sprites/objects/stairs-up.svg`;
const STAIRS_DOWN_SPRITE = `${BASE}assets/sprites/objects/stairs-down.svg`;
const PICTURE_FRAME_SPRITE = `${BASE}assets/sprites/objects/picture-frame.svg`;
const CHEST_OPEN_SPRITE = `${BASE}assets/sprites/objects/chest-open.svg`;
const CHEST_CLOSED_SPRITE = `${BASE}assets/sprites/objects/chest-closed.svg`;
const DOOR_LOCKED_SPRITE = `${BASE}assets/sprites/objects/door-locked.svg`;
const ICON_BOOK_SPRITE = `${BASE}assets/sprites/icon-book.svg`;
const ICON_GEAR_SPRITE = `${BASE}assets/sprites/icon-gear.svg`;
const ICON_QUESTION_SPRITE = `${BASE}assets/sprites/icon-question.svg`;

const DECOR_SPRITES = {
  bookshelf: `${BASE}assets/sprites/objects/bookshelf.svg`,
  brazier: `${BASE}assets/sprites/objects/brazier.svg`,
  scrollPile: `${BASE}assets/sprites/objects/scroll-pile.svg`,
} as const;
type DecorKey = keyof typeof DECOR_SPRITES;
const DECOR_TEXTURE_KEYS: Record<DecorKey, string> = {
  bookshelf: 'kd-decor-bookshelf',
  brazier: 'kd-decor-brazier',
  scrollPile: 'kd-decor-scroll-pile',
};
const DECOR_KEYS: readonly DecorKey[] = ['bookshelf', 'brazier', 'scrollPile'];
const DECOR_SPRITE_SIZE = 24;

const PLAYER_TEXTURE_KEY = 'kd-player';
const SIGNPOST_TEXTURE_KEY = 'kd-signpost';
const NPC_GUIDE_TEXTURE_KEY = 'kd-npc-guide';
const ARTIFACT_LOOT_TEXTURE_KEY = 'kd-artifact-loot';
const DOOR_TEXTURE_KEY = 'kd-door';
const DOOR_LOCKED_TEXTURE_KEY = 'kd-door-locked';
const CHEST_OPEN_TEXTURE_KEY = 'kd-chest-open';
const CHEST_CLOSED_TEXTURE_KEY = 'kd-chest-closed';
const ICON_BOOK_TEXTURE_KEY = 'kd-icon-book';
const ICON_GEAR_TEXTURE_KEY = 'kd-icon-gear';
const ICON_QUESTION_TEXTURE_KEY = 'kd-icon-question';
const STAIRS_UP_TEXTURE_KEY = 'kd-stairs-up';
const STAIRS_DOWN_TEXTURE_KEY = 'kd-stairs-down';
const PICTURE_FRAME_TEXTURE_KEY = 'kd-picture-frame';
const PLAYER_SPRITE_SIZE = 32;
const SIGNPOST_SPRITE_SIZE = 28;
const NPC_GUIDE_SPRITE_SIZE = 28;
const NPC_INTERACT_RADIUS = 28;
const NPC_DIALOG_CLEAR_RADIUS = 44;
const ARTIFACT_LOOT_SPRITE_SIZE = 26;
const PORTAL_SPRITE_SIZE = 28;
const PATHWAY_TILE_SIZE = 32;
const DOOR_SPRITE_SIZE = 22;
const DOOR_LOCKED_SPRITE_SIZE = 22;
const CHEST_SPRITE_SIZE = 24;
const ROOM_ICON_SIZE = 16;
const PICTURE_FRAME_SPRITE_SIZE = 20;
// Fraction of a room's half-width/height used to position the picture frame
// icon in the lower-right quadrant, clear of the topic label and decor.
const PICTURE_FRAME_OFFSET_X = 0.3;
const PICTURE_FRAME_OFFSET_Y = 0.28;
// Square collider, tighter than the rendered sprite so movement feels right.
const PLAYER_COLLIDER_SIZE = 16;
// Inset (in pixels) used when sampling the player's collider against the
// walkability grid - keeps the player from snagging on tile seams.
const PLAYER_WALK_INSET = 1;

export class DungeonScene extends Phaser.Scene {
  private dungeonMap: DungeonMap | null = null;
  private callbacks: DungeonSceneEvents | null = null;
  private player: Phaser.GameObjects.Image | null = null;
  private playerBody: Phaser.Physics.Arcade.Body | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private wasdKeys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private interactKey: Phaser.Input.Keyboard.Key | null = null;
  private currentRoomId: string | null = null;
  private insideRoom = false;
  private currentZoomTarget: number = ZOOM_INSIDE_ROOM;
  private roomLabels = new Map<string, Phaser.GameObjects.Text>();
  private roomGraphics: Phaser.GameObjects.Graphics | null = null;
  private corridorGraphics: Phaser.GameObjects.Graphics | null = null;
  private playerClass: PlayerClassId | null = null;
  private artifactIcons = new Map<string, Phaser.GameObjects.Container>();
  private artifactReviewMarkers = new Map<string, Phaser.GameObjects.Text>();
  private artifactRoomIds = new Set<string>();
  private collectedArtifactRoomIds = new Set<string>();
  private reviewedArtifactRoomIds = new Set<string>();
  private showArtifactIcons = false;
  private imageRoomIds = new Set<string>();
  private imageFrameIcons = new Map<string, Phaser.GameObjects.Image>();
  private currentFloorId: string | null = null;
  private visibleRoomIds: Set<string> | null = null;
  private portalUpRoomId: string | null = null;
  private portalDownRoomIds = new Set<string>();
  private portalIcons = new Map<string, Phaser.GameObjects.Image>();
  private portalHintText: Phaser.GameObjects.Text | null = null;
  private floorTileSprites: Phaser.GameObjects.TileSprite[] = [];
  private corridorTileSprites: Phaser.GameObjects.TileSprite[] = [];
  private ambientParticles: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private doorSprites: Phaser.GameObjects.Image[] = [];
  /**
   * Walkability mask for the currently-visible floor. Players can only move
   * onto tiles where this is 1; everything else is treated as a solid wall.
   * Rebuilt whenever floor visibility changes.
   */
  private activeWalkable: Uint8Array | null = null;
  private activeWalkableWidth = 0;
  private activeWalkableHeight = 0;
  private activeWalkableOffsetX = 0;
  private activeWalkableOffsetY = 0;
  private decorIcons: Phaser.GameObjects.Image[] = [];
  private roomOverlayIcons: Phaser.GameObjects.Image[] = [];
  private roomOverlayStates = new Map<string, string>();
  private roomNpcs = new Map<string, Phaser.GameObjects.Image>();
  private activeNpcRoomId: string | null = null;
  /** Per-room floor id, captured when visibility is applied - used to seed
   * decor placement and tileset selection so the layout is stable across
   * redraws on the same floor. */
  private floorSeed = 0;
  private floorBiomeOverride: FloorBiomeId | null = null;

  // ── Touch / pointer input state ──────────────────────────────────────────
  /** True while a single-finger drag/tap gesture is in progress. */
  private touchPointerActive = false;
  private touchPointerStartX = 0;
  private touchPointerStartY = 0;
  private touchPointerStartTime = 0;
  /**
   * Normalised direction vector derived from the active single-finger drag.
   * Written by {@link handlePointerMove} and read in {@link update} to
   * contribute to the player velocity alongside keyboard input.
   */
  private touchMoveVx = 0;
  private touchMoveVy = 0;
  /** True while a two-finger pinch gesture is driving the camera zoom. */
  private pinchActive = false;
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;

  constructor() {
    super({ key: 'DungeonScene' });
  }

  init(data: {
    dungeonMap: DungeonMap;
    callbacks: DungeonSceneEvents;
    playerClass?: PlayerClassId | null;
    initialFloor?: FloorVisibilityInput;
  }): void {
    this.dungeonMap = data.dungeonMap;
    this.callbacks = data.callbacks;
    this.playerClass = data.playerClass ?? null;
    if (data.initialFloor) {
      this.applyFloorVisibility(data.initialFloor);
    }
  }

  preload(): void {
    const playerSprite = this.playerClass
      ? PLAYER_SPRITE_BY_CLASS[this.playerClass]
      : PLAYER_SPRITE_FALLBACK;
    // Phaser auto-detects SVG when the URL ends in `.svg`. Use `svg` loader
    // explicitly so the rasterised size matches our target render dimensions.
    this.load.svg(PLAYER_TEXTURE_KEY, playerSprite, {
      width: PLAYER_SPRITE_SIZE,
      height: PLAYER_SPRITE_SIZE,
    });
    this.load.svg(SIGNPOST_TEXTURE_KEY, SIGNPOST_SPRITE, {
      width: SIGNPOST_SPRITE_SIZE,
      height: SIGNPOST_SPRITE_SIZE,
    });
    this.load.svg(NPC_GUIDE_TEXTURE_KEY, NPC_GUIDE_SPRITE, {
      width: NPC_GUIDE_SPRITE_SIZE,
      height: NPC_GUIDE_SPRITE_SIZE,
    });
    this.load.svg(DOOR_TEXTURE_KEY, DOOR_SPRITE, {
      width: DOOR_SPRITE_SIZE,
      height: DOOR_SPRITE_SIZE,
    });
    this.load.svg(ARTIFACT_LOOT_TEXTURE_KEY, ARTIFACT_LOOT_SPRITE, {
      width: ARTIFACT_LOOT_SPRITE_SIZE,
      height: ARTIFACT_LOOT_SPRITE_SIZE,
    });
    this.load.svg(STAIRS_UP_TEXTURE_KEY, STAIRS_UP_SPRITE, {
      width: PORTAL_SPRITE_SIZE,
      height: PORTAL_SPRITE_SIZE,
    });
    this.load.svg(STAIRS_DOWN_TEXTURE_KEY, STAIRS_DOWN_SPRITE, {
      width: PORTAL_SPRITE_SIZE,
      height: PORTAL_SPRITE_SIZE,
    });
    this.load.svg(PICTURE_FRAME_TEXTURE_KEY, PICTURE_FRAME_SPRITE, {
      width: PICTURE_FRAME_SPRITE_SIZE,
      height: PICTURE_FRAME_SPRITE_SIZE,
    });
    this.load.svg(DOOR_LOCKED_TEXTURE_KEY, DOOR_LOCKED_SPRITE, {
      width: DOOR_LOCKED_SPRITE_SIZE,
      height: DOOR_LOCKED_SPRITE_SIZE,
    });
    this.load.svg(CHEST_OPEN_TEXTURE_KEY, CHEST_OPEN_SPRITE, {
      width: CHEST_SPRITE_SIZE,
      height: CHEST_SPRITE_SIZE,
    });
    this.load.svg(CHEST_CLOSED_TEXTURE_KEY, CHEST_CLOSED_SPRITE, {
      width: CHEST_SPRITE_SIZE,
      height: CHEST_SPRITE_SIZE,
    });
    this.load.svg(ICON_BOOK_TEXTURE_KEY, ICON_BOOK_SPRITE, {
      width: ROOM_ICON_SIZE,
      height: ROOM_ICON_SIZE,
    });
    this.load.svg(ICON_GEAR_TEXTURE_KEY, ICON_GEAR_SPRITE, {
      width: ROOM_ICON_SIZE,
      height: ROOM_ICON_SIZE,
    });
    this.load.svg(ICON_QUESTION_TEXTURE_KEY, ICON_QUESTION_SPRITE, {
      width: ROOM_ICON_SIZE,
      height: ROOM_ICON_SIZE,
    });
    for (const key of DECOR_KEYS) {
      this.load.svg(DECOR_TEXTURE_KEYS[key], DECOR_SPRITES[key], {
        width: DECOR_SPRITE_SIZE,
        height: DECOR_SPRITE_SIZE,
      });
    }
  }

  create(): void {
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;

    this.cameras.main.setBackgroundColor(0x0f1930);

    // Ensure the walkability mask is built even when no floor visibility has
    // been applied (eg. single-floor dungeons that never call setFloorVisibility).
    if (!this.activeWalkable) {
      this.rebuildActiveWalkable();
    }

    this.corridorGraphics = this.add.graphics();
    this.roomGraphics = this.add.graphics();

    this.renderFloorTiles();
    this.drawCorridors(map);
    this.drawRooms(map);
    this.refreshDecor();
    this.refreshRoomOverlays();

    const root = map.rooms.find((r) => r.isRoot) ?? map.rooms[0];
    if (!root) return;
    const start = this.roomCenter(root, map.tileSize);

    // Mark the root room with a signpost so the spawn location is obvious.
    this.add
      .image(start.x, start.y - root.height * map.tileSize * 0.3, SIGNPOST_TEXTURE_KEY)
      .setDepth(4);

    this.refreshRoomNpcs();

    this.player = this.add.image(start.x, start.y, PLAYER_TEXTURE_KEY).setDepth(10);
    this.physics.add.existing(this.player);
    this.playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    // Keep the collider tighter than the rendered sprite for nicer movement.
    this.playerBody.setSize(PLAYER_COLLIDER_SIZE, PLAYER_COLLIDER_SIZE);
    this.playerBody.setOffset(
      (this.player.width - PLAYER_COLLIDER_SIZE) / 2,
      (this.player.height - PLAYER_COLLIDER_SIZE) / 2,
    );
    this.playerBody.setCollideWorldBounds(false);

    // Subtle idle breathing animation
    this.tweens.add({
      targets: this.player,
      scale: { from: 1, to: 1.008 },
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    if (this.input.keyboard) {
      // `enableCapture = false` so Phaser does not call preventDefault on these
      // keys at the window level. Otherwise typing W/A/S/D/E or arrow keys in
      // a focused <input>/<textarea> would be swallowed by the game.
      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D', false) as Record<
        string,
        Phaser.Input.Keyboard.Key
      >;
      this.interactKey = this.input.keyboard.addKey(
        Phaser.Input.Keyboard.KeyCodes.E,
        false,
      );
      // Belt and suspenders: explicitly clear any pre-registered captures for
      // movement / interact keys so focused form fields receive them too.
      this.input.keyboard.removeCapture([
        Phaser.Input.Keyboard.KeyCodes.W,
        Phaser.Input.Keyboard.KeyCodes.A,
        Phaser.Input.Keyboard.KeyCodes.S,
        Phaser.Input.Keyboard.KeyCodes.D,
        Phaser.Input.Keyboard.KeyCodes.E,
        Phaser.Input.Keyboard.KeyCodes.UP,
        Phaser.Input.Keyboard.KeyCodes.DOWN,
        Phaser.Input.Keyboard.KeyCodes.LEFT,
        Phaser.Input.Keyboard.KeyCodes.RIGHT,
        // `createCursorKeys()` auto-captures SPACE and SHIFT at the window
        // level, which prevents them from reaching focused <input>/<textarea>
        // elements. Explicitly release them so users can type spaces (and
        // hold shift) while editing notes.
        Phaser.Input.Keyboard.KeyCodes.SPACE,
        Phaser.Input.Keyboard.KeyCodes.SHIFT,
      ]);
    }

    // ── Touch / pointer controls ───────────────────────────────────────────
    // Enable a second pointer slot so Phaser can track two simultaneous touch
    // points; needed for pinch-to-zoom detection.
    this.input.addPointer(1);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { this.handlePointerDown(p); });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { this.handlePointerMove(p); });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => { this.handlePointerUp(p); });
    this.input.on('pointercancel', (p: Phaser.Input.Pointer) => { this.handlePointerUp(p); });

    // Configure world & camera bounds based on the dungeon layout.
    const left = map.bounds.minX * map.tileSize;
    const top = map.bounds.minY * map.tileSize;
    const width = (map.bounds.maxX - map.bounds.minX) * map.tileSize;
    const height = (map.bounds.maxY - map.bounds.minY) * map.tileSize;
    this.physics.world.setBounds(left, top, width, height);
    this.cameras.main.setBounds(left, top, width, height);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);
    this.cameras.main.setZoom(ZOOM_INSIDE_ROOM);
    this.insideRoom = true;
    this.currentZoomTarget = ZOOM_INSIDE_ROOM;

    this.enterRoom(root.roomId);
    this.refreshArtifactIcons();
    this.refreshImageFrameIcons();
    this.refreshPortalIcons();
    this.createAmbientParticles();
  }

  update(_time: number, delta: number): void {
    if (!this.playerBody || !this.dungeonMap) return;
    const map = this.dungeonMap;

    const dt = delta / 1000;
    let vx = 0;
    let vy = 0;

    // Suspend movement & interact handling when the user is typing into a text
    // input, textarea, select, or contenteditable element. Without this guard
    // movement keys ("wasd", arrow keys) and the "e" interact key would
    // double-fire as both gameplay input and text input.
    const typingInTextField = isEditableElementFocused();

    const left =
      !typingInTextField && (this.cursors?.left?.isDown || this.wasdKeys.A?.isDown);
    const right =
      !typingInTextField && (this.cursors?.right?.isDown || this.wasdKeys.D?.isDown);
    const up = !typingInTextField && (this.cursors?.up?.isDown || this.wasdKeys.W?.isDown);
    const down =
      !typingInTextField && (this.cursors?.down?.isDown || this.wasdKeys.S?.isDown);

    if (left) vx -= 1;
    if (right) vx += 1;
    if (up) vy -= 1;
    if (down) vy += 1;

    // Merge touch/pointer drag direction into the movement vector.
    // touchMoveVx/Vy is a normalised direction set by handlePointerMove.
    if (!typingInTextField) {
      vx += this.touchMoveVx;
      vy += this.touchMoveVy;
    }

    if (vx !== 0 || vy !== 0) {
      const length = Math.hypot(vx, vy) || 1;
      vx = (vx / length) * PLAYER_SPEED;
      vy = (vy / length) * PLAYER_SPEED;
    }

    // Custom movement: instead of letting arcade physics integrate velocity
    // freely, we sample the walkability grid per-axis so the player slides
    // along walls and can never leave rooms / corridors. The body is kept in
    // sync so portal/teleport collision queries continue to work.
    this.playerBody.setVelocity(0, 0);
    const player = this.player;
    if (player) {
      const stepX = vx * dt;
      const stepY = vy * dt;
      if (stepX !== 0 && this.canPlayerOccupy(player.x + stepX, player.y)) {
        player.x += stepX;
      }
      if (stepY !== 0 && this.canPlayerOccupy(player.x, player.y + stepY)) {
        player.y += stepY;
      }
      this.playerBody.reset(player.x, player.y);
    }

    if (!player) return;
    const room = this.findRoomAtWorld(player.x, player.y, map);
    if (room && room.roomId !== this.currentRoomId) {
      this.enterRoom(room.roomId);
    }
    // Auto-zoom: zoom in when inside any room, zoom out when on a corridor.
    const shouldBeInsideRoom = room !== null;
    if (shouldBeInsideRoom !== this.insideRoom) {
      this.insideRoom = shouldBeInsideRoom;
      this.setZoomTarget(shouldBeInsideRoom ? ZOOM_INSIDE_ROOM : ZOOM_ON_PATH);
      this.refreshImageFrameIcons();
    }

    this.checkArtifactCollection();
    this.checkNpcDialogRange();

    if (
      !typingInTextField &&
      this.interactKey &&
      Phaser.Input.Keyboard.JustDown(this.interactKey)
    ) {
      if (this.currentRoomId) {
        if (this.tryInteractNpcInCurrentRoom()) {
          return;
        }
        if (this.currentRoomId === this.portalUpRoomId) {
          this.callbacks?.onFloorTransition?.({
            fromRoomId: this.currentRoomId,
            direction: 'up',
          });
        } else if (this.portalDownRoomIds.has(this.currentRoomId)) {
          this.callbacks?.onFloorTransition?.({
            fromRoomId: this.currentRoomId,
            direction: 'down',
          });
        } else {
          this.callbacks?.onInteract(this.currentRoomId);
        }
      }
    }
  }

  /** Programmatic interact, used by on-screen touch button. */
  triggerInteract(): void {
    if (!this.currentRoomId) return;
    if (this.tryInteractNpcInCurrentRoom()) {
      return;
    }
    if (this.currentRoomId === this.portalUpRoomId) {
      this.callbacks?.onFloorTransition?.({
        fromRoomId: this.currentRoomId,
        direction: 'up',
      });
    } else if (this.portalDownRoomIds.has(this.currentRoomId)) {
      this.callbacks?.onFloorTransition?.({
        fromRoomId: this.currentRoomId,
        direction: 'down',
      });
    } else {
      this.callbacks?.onInteract(this.currentRoomId);
    }
  }

  teleportToRoom(roomId: string): void {
    if (!this.player || !this.playerBody || !this.dungeonMap) return;
    const room = this.dungeonMap.rooms.find((entry) => entry.roomId === roomId);
    if (!room) return;
    const destination = this.roomCenter(room, this.dungeonMap.tileSize);
    this.playerBody.stop();
    this.player.setPosition(destination.x, destination.y);
    this.insideRoom = true;
    this.setZoomTarget(ZOOM_INSIDE_ROOM);
    this.enterRoom(room.roomId);
  }

  /**
   * Show or hide a collectible loot icon in each room that has produced an
   * artifact. Called by the React layer whenever the active phase or the
   * subject snapshot changes; safe to call before/after `create()` has run.
   */
  setArtifactRooms(roomIds: readonly string[], visible: boolean): void {
    this.artifactRoomIds = new Set(roomIds);
    this.showArtifactIcons = visible;
    this.refreshArtifactIcons();
    this.refreshArtifactReviewMarkers();
  }

  setCollectedArtifactRooms(roomIds: readonly string[]): void {
    this.collectedArtifactRoomIds = new Set(roomIds);
    this.refreshArtifactIcons();
    this.refreshArtifactReviewMarkers();
  }

  setReviewedArtifactRooms(roomIds: readonly string[]): void {
    this.reviewedArtifactRoomIds = new Set(roomIds);
    this.refreshArtifactReviewMarkers();
  }

  /**
   * Tell the scene which rooms have image attachments. A small picture-frame
   * icon will be shown in the lower-right corner of the active room as a
   * contextual visual hint in both Scribe and Archaeologist phases.
   */
  setImageRooms(roomIds: readonly string[]): void {
    this.imageRoomIds = new Set(roomIds);
    this.refreshImageFrameIcons();
  }

  /**
   * Update room overlay sprites (chests, locked doors) based on current
   * room validation state, so cleared/unvisited visuals stay in sync.
   */
  setRoomOverlayStates(states: Record<string, string>): void {
    this.roomOverlayStates = new Map(Object.entries(states));
    this.refreshRoomOverlays();
  }

  private refreshImageFrameIcons(): void {
    if (!this.dungeonMap || !this.textures.exists(PICTURE_FRAME_TEXTURE_KEY)) return;
    const map = this.dungeonMap;
    // Remove icons for rooms no longer in the image set or hidden by the floor filter.
    for (const [roomId, icon] of this.imageFrameIcons) {
      const stillVisible = this.imageRoomIds.has(roomId) && this.isImageIconVisible(roomId);
      if (!stillVisible) {
        icon.destroy();
        this.imageFrameIcons.delete(roomId);
      }
    }
    for (const room of map.rooms) {
      if (!this.imageRoomIds.has(room.roomId)) continue;
      if (!this.isImageIconVisible(room.roomId)) continue;
      if (this.imageFrameIcons.has(room.roomId)) continue;
      const center = this.roomCenter(room, map.tileSize);
      // Place the icon in the lower-right area of the room, mirroring the
      // review dot in the upper-right. Depth 7 keeps it above decor/floors.
      const frameX = center.x + room.width * map.tileSize * PICTURE_FRAME_OFFSET_X;
      const frameY = center.y + room.height * map.tileSize * PICTURE_FRAME_OFFSET_Y;
      const icon = this.add
        .image(frameX, frameY, PICTURE_FRAME_TEXTURE_KEY)
        .setDepth(7)
        .setAlpha(0.88);
      this.imageFrameIcons.set(room.roomId, icon);
    }
  }

  private isImageIconVisible(roomId: string): boolean {
    // Frame hints are contextual: only show while the player is actively inside
    // that exact room, not while traveling corridors or viewing other rooms.
    return (
      (!this.visibleRoomIds || this.visibleRoomIds.has(roomId)) &&
      this.insideRoom &&
      this.currentRoomId === roomId
    );
  }

  private checkArtifactCollection(): void {
    if (!this.showArtifactIcons || !this.player || !this.currentRoomId) return;
    if (!this.artifactRoomIds.has(this.currentRoomId)) return;
    if (this.collectedArtifactRoomIds.has(this.currentRoomId)) return;
    const icon = this.artifactIcons.get(this.currentRoomId);
    if (!icon) return;

    const dx = this.player.x - icon.x;
    const dy = this.player.y - icon.y;
    const pickupRadius = 22;
    if (dx * dx + dy * dy > pickupRadius * pickupRadius) return;

    this.collectedArtifactRoomIds.add(this.currentRoomId);
    icon.destroy();
    this.artifactIcons.delete(this.currentRoomId);
    this.cameras.main.shake(200, 0.005);
    this.callbacks?.onArtifactCollected?.(this.currentRoomId);
  }

  private refreshArtifactIcons(): void {
    if (!this.dungeonMap || !this.textures.exists(ARTIFACT_LOOT_TEXTURE_KEY)) {
      // Defer to after `create()`/preload finishes. `create()` will call
      // refreshArtifactIcons again once textures are loaded.
      return;
    }
    const map = this.dungeonMap;
    // Drop any icons that no longer belong (room removed, hidden by floor
    // filter, or icon turned off).
    for (const [roomId, icon] of this.artifactIcons) {
      const stillVisible =
        this.showArtifactIcons &&
        this.artifactRoomIds.has(roomId) &&
        (!this.visibleRoomIds || this.visibleRoomIds.has(roomId));
      if (!stillVisible) {
        icon.destroy();
        this.artifactIcons.delete(roomId);
      }
    }
    if (!this.showArtifactIcons) return;
    for (const room of map.rooms) {
      if (!this.artifactRoomIds.has(room.roomId)) continue;
      if (this.collectedArtifactRoomIds.has(room.roomId)) continue;
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      if (this.artifactIcons.has(room.roomId)) continue;
      const center = this.roomCenter(room, map.tileSize);
      // Place the loot icon in the upper portion of the room so it doesn't
      // overlap the topic label rendered at the bottom edge.
      const cx = center.x;
      const cy = center.y - room.height * map.tileSize * 0.25;
      const container = this.add.container(cx, cy).setDepth(6);
      // Two stacked additive-blended halos give artifact loot a readable
      // cool glow even against dark floor textures.
      const glowOuter = this.add.circle(0, 0, 22, 0x7be3ff, 0.2);
      glowOuter.setBlendMode(Phaser.BlendModes.ADD);
      const glowInner = this.add.circle(0, 0, 14, 0xb48cff, 0.3);
      glowInner.setBlendMode(Phaser.BlendModes.ADD);
      const icon = this.add.image(0, 0, ARTIFACT_LOOT_TEXTURE_KEY);
      container.add([glowOuter, glowInner, icon]);
      this.tweens.add({
        targets: [glowOuter, glowInner],
        alpha: { from: 0.18, to: 0.55 },
        duration: 950,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.tweens.add({
        targets: icon,
        scale: { from: 0.94, to: 1.06 },
        duration: 1100,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.artifactIcons.set(room.roomId, container);
    }
  }

  private refreshArtifactReviewMarkers(): void {
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;
    for (const [roomId, marker] of this.artifactReviewMarkers) {
      const stillReviewed = this.reviewedArtifactRoomIds.has(roomId);
      const stillVisible = !this.visibleRoomIds || this.visibleRoomIds.has(roomId);
      if (!stillReviewed || !stillVisible) {
        marker.destroy();
        this.artifactReviewMarkers.delete(roomId);
      }
    }
    for (const room of map.rooms) {
      if (!this.reviewedArtifactRoomIds.has(room.roomId)) continue;
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      if (this.artifactReviewMarkers.has(room.roomId)) continue;
      const center = this.roomCenter(room, map.tileSize);
      const marker = this.add
        .text(center.x + room.width * map.tileSize * 0.31, center.y - room.height * map.tileSize * 0.34, '●', {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '10px',
          color: '#9af7e5',
          backgroundColor: 'rgba(16, 23, 37, 0.45)',
          padding: { left: 3, right: 3, top: 0, bottom: 0 },
        })
        .setOrigin(1, 0)
        .setDepth(7)
        .setAlpha(0.9);
      this.artifactReviewMarkers.set(room.roomId, marker);
    }
  }

  private refreshRoomNpcs(): void {
    if (!this.dungeonMap || !this.textures.exists(NPC_GUIDE_TEXTURE_KEY)) return;

    const visibleRoomIds = new Set<string>();
    if (this.currentRoomId && (!this.visibleRoomIds || this.visibleRoomIds.has(this.currentRoomId))) {
      visibleRoomIds.add(this.currentRoomId);
    }

    for (const [roomId, npc] of this.roomNpcs) {
      if (!visibleRoomIds.has(roomId)) {
        npc.destroy();
        this.roomNpcs.delete(roomId);
      }
    }

    for (const room of this.dungeonMap.rooms) {
      if (room.roomId !== this.currentRoomId) continue;
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      if (this.roomNpcs.has(room.roomId)) continue;
      const { x: npcX, y: npcY } = this.resolveNpcPosition(room, this.dungeonMap);
      const npc = this.add.image(npcX, npcY, NPC_GUIDE_TEXTURE_KEY).setDepth(5);
      this.tweens.add({
        targets: npc,
        y: { from: npcY, to: npcY - 3 },
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.roomNpcs.set(room.roomId, npc);
    }

    if (this.activeNpcRoomId && !this.roomNpcs.has(this.activeNpcRoomId)) {
      const activeRoomId = this.activeNpcRoomId;
      this.activeNpcRoomId = null;
      this.callbacks?.onNpcOutOfRange?.(activeRoomId);
    }
  }

  private resolveNpcPosition(room: DungeonRoom, map: DungeonMap): { x: number; y: number } {
    const roomSeed = hashString(`${this.currentFloorId ?? 'all'}::npc::${room.roomId}`);
    const anchors: ReadonlyArray<{ ax: number; ay: number }> = [
      { ax: 0.18, ay: 0.24 },
      { ax: 0.82, ay: 0.24 },
      { ax: 0.18, ay: 0.52 },
      { ax: 0.82, ay: 0.52 },
    ];
    // Artifact / portal icons live around (0.5, 0.25), room labels around
    // (0.5, 0.9). Pick the anchor that stays furthest from both.
    const artifact = { ax: 0.5, ay: 0.25 };
    const label = { ax: 0.5, ay: 0.9 };
    let best = anchors[0];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < anchors.length; i += 1) {
      const anchor = anchors[i];
      const dArtifact = Math.hypot(anchor.ax - artifact.ax, anchor.ay - artifact.ay);
      const dLabel = Math.hypot(anchor.ax - label.ax, anchor.ay - label.ay);
      const jitter = (((roomSeed >>> (i * 2)) & 0x3) / 3) * 0.01;
      const score = Math.min(dArtifact, dLabel) + jitter;
      if (score > bestScore) {
        bestScore = score;
        best = anchor;
      }
    }

    return {
      x: (room.gridX + room.width * best.ax) * map.tileSize,
      y: (room.gridY + room.height * best.ay) * map.tileSize,
    };
  }

  private tryInteractNpcInCurrentRoom(): boolean {
    if (!this.player || !this.currentRoomId) return false;
    const npc = this.roomNpcs.get(this.currentRoomId);
    if (!npc) return false;

    const dx = this.player.x - npc.x;
    const dy = this.player.y - npc.y;
    if (dx * dx + dy * dy > NPC_INTERACT_RADIUS * NPC_INTERACT_RADIUS) {
      return false;
    }

    this.activeNpcRoomId = this.currentRoomId;
    const anchor = this.resolveNpcDialogAnchor(this.currentRoomId);
    if (anchor) {
      this.callbacks?.onNpcInteract?.(anchor);
    }
    return true;
  }

  private checkNpcDialogRange(): void {
    if (!this.player || !this.activeNpcRoomId) return;
    if (this.currentRoomId !== this.activeNpcRoomId) {
      const roomId = this.activeNpcRoomId;
      this.activeNpcRoomId = null;
      this.callbacks?.onNpcOutOfRange?.(roomId);
      return;
    }

    const npc = this.roomNpcs.get(this.activeNpcRoomId);
    if (!npc) {
      const roomId = this.activeNpcRoomId;
      this.activeNpcRoomId = null;
      this.callbacks?.onNpcOutOfRange?.(roomId);
      return;
    }

    const dx = this.player.x - npc.x;
    const dy = this.player.y - npc.y;
    if (dx * dx + dy * dy > NPC_DIALOG_CLEAR_RADIUS * NPC_DIALOG_CLEAR_RADIUS) {
      const roomId = this.activeNpcRoomId;
      this.activeNpcRoomId = null;
      this.callbacks?.onNpcOutOfRange?.(roomId);
      return;
    }

    const anchor = this.resolveNpcDialogAnchor(this.activeNpcRoomId);
    if (anchor) {
      this.callbacks?.onNpcDialogPosition?.(anchor);
    }
  }

  private resolveNpcDialogAnchor(roomId: string): NpcDialogAnchor | null {
    const npc = this.roomNpcs.get(roomId);
    if (!npc) return null;

    const camera = this.cameras.main;
    const screenX = (npc.x - camera.worldView.x) * camera.zoom;
    const screenY = (npc.y - camera.worldView.y) * camera.zoom;
    const canvasRect = this.game.canvas?.getBoundingClientRect();

    return {
      roomId,
      clientX: (canvasRect?.left ?? 0) + screenX,
      clientY: (canvasRect?.top ?? 0) + screenY,
    };
  }

  /**
   * Re-render the per-room portal sprites (stairs up / stairs down) to
   * match the current floor visibility. Called whenever the floor changes.
   */
  private refreshPortalIcons(): void {
    if (
      !this.dungeonMap ||
      !this.textures.exists(STAIRS_UP_TEXTURE_KEY) ||
      !this.textures.exists(STAIRS_DOWN_TEXTURE_KEY)
    ) {
      return;
    }
    const map = this.dungeonMap;
    for (const icon of this.portalIcons.values()) icon.destroy();
    this.portalIcons.clear();
    const placePortal = (roomId: string, textureKey: string) => {
      const room = map.rooms.find((r) => r.roomId === roomId);
      if (!room) return;
      const center = this.roomCenter(room, map.tileSize);
      const icon = this.add
        .image(center.x, center.y - room.height * map.tileSize * 0.25, textureKey)
        .setDepth(6);
      this.portalIcons.set(roomId, icon);
    };
    if (this.portalUpRoomId) placePortal(this.portalUpRoomId, STAIRS_UP_TEXTURE_KEY);
    for (const id of this.portalDownRoomIds) placePortal(id, STAIRS_DOWN_TEXTURE_KEY);
  }

  /**
   * Create a subtle ambient particle effect - small floating dust motes that
   * drift through the dungeon, adding life to the environment.
   */
  private createAmbientParticles(): void {
    if (!this.dungeonMap || this.ambientParticles) return;
    const map = this.dungeonMap;
    const w = (map.bounds.maxX - map.bounds.minX) * map.tileSize;
    const h = (map.bounds.maxY - map.bounds.minY) * map.tileSize;
    const cx = (map.bounds.minX + map.bounds.maxX) / 2 * map.tileSize;
    const cy = (map.bounds.minY + map.bounds.maxY) / 2 * map.tileSize;

    const dotTexture = this.textures.exists('particle-dot')
      ? 'particle-dot'
      : this.createParticleDotTexture();

    this.ambientParticles = this.add.particles(cx, cy, dotTexture, {
      x: { min: -w / 2, max: w / 2 },
      y: { min: -h / 2, max: h / 2 },
      speed: { min: 2, max: 6 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.3, end: 0 },
      lifespan: { min: 4000, max: 8000 },
      frequency: 800,
      blendMode: Phaser.BlendModes.ADD,
    });
    this.ambientParticles.setDepth(0.2);
  }

  private createParticleDotTexture(): string {
    const g = this.make.graphics({ x: 0, y: 0 });
    g.fillStyle(0x7be3ff, 1);
    g.fillCircle(3, 3, 3);
    g.generateTexture('particle-dot', 6, 6);
    g.destroy();
    return 'particle-dot';
  }

  /**
   * Update the in-canvas hint that nudges the player to press E when
   * standing inside a portal room. We anchor it to the camera so it stays
   * legible regardless of zoom.
   */
  private refreshPortalHint(): void {
    const isOnPortal =
      this.currentRoomId !== null &&
      (this.currentRoomId === this.portalUpRoomId ||
        this.portalDownRoomIds.has(this.currentRoomId));
    if (!isOnPortal) {
      if (this.portalHintText) {
        this.portalHintText.destroy();
        this.portalHintText = null;
      }
      return;
    }
    const message =
      this.currentRoomId === this.portalUpRoomId
        ? 'Tap or press E to ascend'
        : 'Tap or press E to descend';
    if (!this.portalHintText) {
      this.portalHintText = this.add
        .text(0, 0, message, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '14px',
          color: '#cfe1ff',
          backgroundColor: '#1f2a3acc',
          padding: { left: 8, right: 8, top: 4, bottom: 4 },
        })
        .setScrollFactor(0)
        .setDepth(20);
    } else {
      this.portalHintText.setText(message);
    }
    const cam = this.cameras.main;
    this.portalHintText.setPosition(cam.width / 2, cam.height - 48);
    this.portalHintText.setOrigin(0.5, 0.5);
  }

  /**
   * Switch the visible floor. Safe to call before `create()` - the scene
   * caches the request and applies it once textures/graphics objects exist.
   */
  setFloorVisibility(input: FloorVisibilityInput): void {
    this.applyFloorVisibility(input);
    if (this.dungeonMap && this.roomGraphics && this.corridorGraphics) {
      this.renderFloorTiles();
      this.drawCorridors(this.dungeonMap);
      this.drawRooms(this.dungeonMap);
      this.refreshPortalIcons();
      this.refreshDecor();
      this.refreshRoomOverlays();
      this.refreshRoomNpcs();
      this.refreshArtifactIcons();
      this.refreshImageFrameIcons();
      this.refreshPortalHint();
    }
    // Recreate ambient particles for the new floor area
    if (this.ambientParticles) {
      this.ambientParticles.destroy();
      this.ambientParticles = null;
    }
    this.createAmbientParticles();
  }

  private applyFloorVisibility(input: FloorVisibilityInput): void {
    this.currentFloorId = input.floorId;
    this.visibleRoomIds = new Set(input.visibleRoomIds);
    this.portalUpRoomId = input.portalUpRoomId;
    this.portalDownRoomIds = new Set(input.portalDownRoomIds);
    this.floorBiomeOverride = input.biomeId ?? null;
    this.floorSeed = hashString(input.floorId);
    this.rebuildActiveWalkable();
  }

  /**
   * Build a walkability mask restricted to the rooms (and corridors between
   * them) on the currently-visible floor. The renderer uses {@link DungeonMap}'s
   * static walkable grid for shape; this method just masks out tiles that
   * belong to a hidden floor so the player can never walk between floors.
   */
  private rebuildActiveWalkable(): void {
    if (!this.dungeonMap) {
      this.activeWalkable = null;
      return;
    }
    const map = this.dungeonMap;
    const visible = this.visibleRoomIds;
    const w = map.walkable.width;
    const h = map.walkable.height;
    const data = new Uint8Array(w * h);
    const mark = (tx: number, ty: number): void => {
      const gx = tx - map.walkable.offsetX;
      const gy = ty - map.walkable.offsetY;
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) return;
      data[gy * w + gx] = 1;
    };
    for (const room of map.rooms) {
      if (visible && !visible.has(room.roomId)) continue;
      for (let dy = 0; dy < room.height; dy += 1) {
        for (let dx = 0; dx < room.width; dx += 1) {
          mark(room.gridX + dx, room.gridY + dy);
        }
      }
    }
    for (const corridor of map.corridors) {
      if (
        visible &&
        (!visible.has(corridor.fromRoomId) || !visible.has(corridor.toRoomId))
      ) {
        continue;
      }
      mark(corridor.fromDoor.x, corridor.fromDoor.y);
      mark(corridor.toDoor.x, corridor.toDoor.y);
      for (const tile of corridor.pathTiles) {
        mark(tile.x, tile.y);
      }
    }
    this.activeWalkable = data;
    this.activeWalkableWidth = w;
    this.activeWalkableHeight = h;
    this.activeWalkableOffsetX = map.walkable.offsetX;
    this.activeWalkableOffsetY = map.walkable.offsetY;
  }

  /** True iff the world-space point lies on a walkable tile of the active floor. */
  private isWalkableAt(worldX: number, worldY: number): boolean {
    if (!this.dungeonMap || !this.activeWalkable) return true;
    const tileSize = this.dungeonMap.tileSize;
    const tx = Math.floor(worldX / tileSize);
    const ty = Math.floor(worldY / tileSize);
    const gx = tx - this.activeWalkableOffsetX;
    const gy = ty - this.activeWalkableOffsetY;
    if (
      gx < 0 ||
      gy < 0 ||
      gx >= this.activeWalkableWidth ||
      gy >= this.activeWalkableHeight
    ) {
      return false;
    }
    return this.activeWalkable[gy * this.activeWalkableWidth + gx] === 1;
  }

  /**
   * Check whether a player-sized collider centred at (cx, cy) overlaps only
   * walkable tiles. We sample four inset corners of the collider so the test
   * matches what a player would intuitively expect (no edge-snagging).
   */
  private canPlayerOccupy(cx: number, cy: number): boolean {
    const half = PLAYER_COLLIDER_SIZE / 2 - PLAYER_WALK_INSET;
    return (
      this.isWalkableAt(cx - half, cy - half) &&
      this.isWalkableAt(cx + half, cy - half) &&
      this.isWalkableAt(cx - half, cy + half) &&
      this.isWalkableAt(cx + half, cy + half)
    );
  }

  /** Render tiled floor textures inside each visible room. */
  private renderFloorTiles(): void {
    for (const tile of this.floorTileSprites) tile.destroy();
    this.floorTileSprites = [];
    if (!this.dungeonMap) return;
    const biome = resolveFloorBiome(this.floorSeed, this.floorBiomeOverride ?? undefined);
    const textureKey = ensureBiomeFloorTexture(this, biome);
    const map = this.dungeonMap;
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      const x = room.gridX * map.tileSize;
      const y = room.gridY * map.tileSize;
      const w = room.width * map.tileSize;
      const h = room.height * map.tileSize;
      // Inset slightly so the room outline border still reads clearly.
      const inset = 3;
      const tile = this.add
        .tileSprite(
          x + inset,
          y + inset,
          w - inset * 2,
          h - inset * 2,
          textureKey,
        )
        .setOrigin(0, 0)
        .setAlpha(0.7)
        .setDepth(0);
      this.floorTileSprites.push(tile);
    }
  }

  /**
   * Sprinkle 0–3 decor icons (bookshelf / brazier / scroll pile) into each
   * visible room. Placement is deterministic per (floorId, roomId) so the
   * layout is stable across redraws.
   */
  private refreshDecor(): void {
    for (const icon of this.decorIcons) icon.destroy();
    this.decorIcons = [];
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      // Don't clutter portal rooms - the stairs sprite should read clearly.
      if (
        room.roomId === this.portalUpRoomId ||
        this.portalDownRoomIds.has(room.roomId)
      ) {
        continue;
      }
      const roomSeed = hashString(`${this.currentFloorId ?? ''}::${room.roomId}`);
      const prng = mulberry32(roomSeed);
      // 2 decor pieces per room, picked from the four corners (top-left,
      // top-right, bottom-left only - bottom-right reserved for the topic
      // label / artifact loot icon).
      const corners: ReadonlyArray<{ ax: number; ay: number }> = [
        { ax: 0.18, ay: 0.22 },
        { ax: 0.82, ay: 0.22 },
        { ax: 0.18, ay: 0.6 },
      ];
      // For each corner independently decide whether to place an item.
      for (const corner of corners) {
        if (prng() > 0.55) continue;
        const decorKey = DECOR_KEYS[Math.floor(prng() * DECOR_KEYS.length)];
        const textureKey = DECOR_TEXTURE_KEYS[decorKey];
        if (!this.textures.exists(textureKey)) continue;
        const px = (room.gridX + room.width * corner.ax) * map.tileSize;
        const py = (room.gridY + room.height * corner.ay) * map.tileSize;
        const icon = this.add.image(px, py, textureKey).setDepth(2);
        this.decorIcons.push(icon);
      }
    }
  }

  private refreshRoomOverlays(): void {
    for (const icon of this.roomOverlayIcons) icon.destroy();
    this.roomOverlayIcons = [];
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      const cx = (room.gridX + room.width / 2) * map.tileSize;
      const cy = (room.gridY + room.height / 2) * map.tileSize;
      const isPortalEdge =
        room.roomId === this.portalUpRoomId || this.portalDownRoomIds.has(room.roomId);
      if (isPortalEdge) continue;
      // Use dynamic room state from React (via setRoomOverlayStates), fall back to map status.
      const roomState = this.roomOverlayStates.get(room.roomId) ?? room.status;
      const isCleared = roomState === 'EncounterDefeated' || roomState === 'ArtifactCollected';
      const isUnvisited = roomState === 'Created';
      if (isCleared) {
        if (!this.textures.exists(CHEST_OPEN_TEXTURE_KEY)) continue;
        const icon = this.add
          .image(cx, cy - 4, CHEST_OPEN_TEXTURE_KEY)
          .setDepth(2.1);
        this.roomOverlayIcons.push(icon);
      } else if (isUnvisited) {
        if (!this.textures.exists(DOOR_LOCKED_TEXTURE_KEY)) continue;
        const doorX = (room.gridX + room.width) * map.tileSize - 6;
        const doorY = (room.gridY + room.height / 2) * map.tileSize;
        const icon = this.add
          .image(doorX, doorY, DOOR_LOCKED_TEXTURE_KEY)
          .setDepth(2.1);
        this.roomOverlayIcons.push(icon);
      }
    }
  }

  private drawRooms(map: DungeonMap): void {
    if (!this.roomGraphics) return;
    const g = this.roomGraphics;
    g.clear();
    // Tear down any text labels we drew previously so a redraw doesn't leak
    // game objects when the floor is switched.
    for (const label of this.roomLabels.values()) label.destroy();
    this.roomLabels.clear();
    // Index doors per room so the wall stroke can skip the door tiles.
    const doorsByRoom = new Map<string, DungeonDoor[]>();
    for (const door of map.doors) {
      const list = doorsByRoom.get(door.roomId);
      if (list) list.push(door);
      else doorsByRoom.set(door.roomId, [door]);
    }
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      const x = room.gridX * map.tileSize;
      const y = room.gridY * map.tileSize;
      const w = room.width * map.tileSize;
      const h = room.height * map.tileSize;
      const isPortalUp = room.roomId === this.portalUpRoomId;
      const isPortalDown = this.portalDownRoomIds.has(room.roomId);
      const isPortal = isPortalUp || isPortalDown;

      // Room shells stay in cool slate/indigo tones to avoid warm browns.
      const fill = isPortal ? 0x1f2a3a : room.isRoot ? 0x1c2c4f : 0x16233d;
      g.fillStyle(fill, 1);
      g.fillRect(x, y, w, h);
      // Inner floor tile band to suggest a tiled chamber.
      g.fillStyle(isPortal ? 0x2a3a5c : 0x22355e, 0.65);
      g.fillRect(x + 4, y + 4, w - 8, h - 8);
      this.drawRoomWallsWithDoors(
        g,
        room,
        doorsByRoom.get(room.roomId) ?? [],
        map.tileSize,
        isPortal ? 0x7fb2ff : statusColor(room.status),
      );

      const labelPrefix = isPortalUp ? '↑ ' : isPortalDown ? '↓ ' : '';
      const label = this.add
        .text(x + w / 2, y + h - 12, `${labelPrefix}${room.topic}`, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '12px',
          color: isPortal ? '#cfe1ff' : '#dbe6ff',
          align: 'center',
          wordWrap: { width: w - 8 },
        })
        .setOrigin(0.5, 1)
        .setDepth(5);
      this.roomLabels.set(room.roomId, label);
    }
  }

  /**
   * Stroke a room's wall border one edge at a time, leaving a 1-tile gap
   * everywhere a door punches through. Without the gap the door sprite would
   * sit on top of an unbroken wall line and look wrong.
   */
  private drawRoomWallsWithDoors(
    g: Phaser.GameObjects.Graphics,
    room: DungeonRoom,
    doors: readonly DungeonDoor[],
    tileSize: number,
    color: number,
  ): void {
    g.lineStyle(3, color, 1);
    const left = room.gridX * tileSize;
    const top = room.gridY * tileSize;
    const right = (room.gridX + room.width) * tileSize;
    const bottom = (room.gridY + room.height) * tileSize;
    const doorsBySide: Record<DungeonDoor['side'], DungeonDoor[]> = {
      N: [],
      S: [],
      W: [],
      E: [],
    };
    for (const door of doors) doorsBySide[door.side].push(door);

    // Horizontal walls (N at top, S at bottom): split into segments around
    // door tile columns.
    const drawHorizontal = (y: number, side: DungeonDoor['side']): void => {
      const gaps = doorsBySide[side]
        .map((d) => d.x - room.gridX)
        .sort((a, b) => a - b);
      let startCol = 0;
      for (const gap of gaps) {
        if (gap > startCol) {
          g.strokeLineShape(
            new Phaser.Geom.Line(
              left + startCol * tileSize,
              y,
              left + gap * tileSize,
              y,
            ),
          );
        }
        startCol = gap + 1;
      }
      if (startCol < room.width) {
        g.strokeLineShape(
          new Phaser.Geom.Line(
            left + startCol * tileSize,
            y,
            right,
            y,
          ),
        );
      }
    };
    const drawVertical = (x: number, side: DungeonDoor['side']): void => {
      const gaps = doorsBySide[side]
        .map((d) => d.y - room.gridY)
        .sort((a, b) => a - b);
      let startRow = 0;
      for (const gap of gaps) {
        if (gap > startRow) {
          g.strokeLineShape(
            new Phaser.Geom.Line(
              x,
              top + startRow * tileSize,
              x,
              top + gap * tileSize,
            ),
          );
        }
        startRow = gap + 1;
      }
      if (startRow < room.height) {
        g.strokeLineShape(
          new Phaser.Geom.Line(x, top + startRow * tileSize, x, bottom),
        );
      }
    };

    drawHorizontal(top, 'N');
    drawHorizontal(bottom, 'S');
    drawVertical(left, 'W');
    drawVertical(right, 'E');
  }

  private drawCorridors(map: DungeonMap): void {
    if (!this.corridorGraphics) return;
    const g = this.corridorGraphics;
    g.clear();
    // Tear down any pathway tile-sprites from a previous render (floor swap,
    // teleport, etc.) so we don't leak game objects.
    for (const tile of this.corridorTileSprites) tile.destroy();
    this.corridorTileSprites = [];
    for (const door of this.doorSprites) door.destroy();
    this.doorSprites = [];
    const baseColor = 0x4f679f;
    const portalColor = 0x7fb2ff;
    const corridorTextureKey = ensureBiomeFloorTexture(
      this,
      resolveFloorBiome(this.floorSeed, this.floorBiomeOverride ?? undefined),
    );
    const canTilePath = !!corridorTextureKey;
    const canDrawDoor = this.textures.exists(DOOR_TEXTURE_KEY);
    const tileSize = map.tileSize;

    for (const corridor of map.corridors) {
      if (
        this.visibleRoomIds &&
        (!this.visibleRoomIds.has(corridor.fromRoomId) ||
          !this.visibleRoomIds.has(corridor.toRoomId))
      ) {
        continue;
      }
      const isPortalEdge =
        corridor.fromRoomId === this.portalUpRoomId ||
        corridor.toRoomId === this.portalUpRoomId ||
        this.portalDownRoomIds.has(corridor.fromRoomId) ||
        this.portalDownRoomIds.has(corridor.toRoomId);
      const strokeColor = isPortalEdge ? portalColor : baseColor;
      g.lineStyle(5, strokeColor, 1);

      // Stroke each axis-aligned segment so the corridor still reads when
      // tile sprites have not loaded yet.
      for (const seg of corridor.segments) {
        const ax = (seg.x1 + 0.5) * tileSize;
        const ay = (seg.y1 + 0.5) * tileSize;
        const bx = (seg.x2 + 0.5) * tileSize;
        const by = (seg.y2 + 0.5) * tileSize;
        g.strokeLineShape(new Phaser.Geom.Line(ax, ay, bx, by));
      }

      if (canTilePath) {
        for (const seg of corridor.segments) {
          const lenTiles = Math.max(
            1,
            seg.orientation === 'h'
              ? seg.x2 - seg.x1 + 1
              : seg.y2 - seg.y1 + 1,
          );
          const cxTile = (seg.x1 + seg.x2 + 1) / 2;
          const cyTile = (seg.y1 + seg.y2 + 1) / 2;
          const cx = cxTile * tileSize;
          const cy = cyTile * tileSize;
          const length = lenTiles * tileSize;
          const tile = this.add
            .tileSprite(
              cx,
              cy,
              length,
              PATHWAY_TILE_SIZE,
              corridorTextureKey,
            )
            .setRotation(seg.orientation === 'h' ? 0 : Math.PI / 2)
            .setAlpha(isPortalEdge ? 0.55 : 0.75)
            .setDepth(0.5);
          this.corridorTileSprites.push(tile);
        }
        if (corridor.elbow) {
          const cx = (corridor.elbow.x + 0.5) * tileSize;
          const cy = (corridor.elbow.y + 0.5) * tileSize;
          const cornerTile = this.add
            .tileSprite(cx, cy, PATHWAY_TILE_SIZE, PATHWAY_TILE_SIZE, corridorTextureKey)
            .setAlpha(isPortalEdge ? 0.55 : 0.78)
            .setDepth(0.6);
          this.corridorTileSprites.push(cornerTile);
        }
      }

      // Draw doors at both endpoints. Doors live on the room's perimeter, so
      // they sit visually right where the corridor meets the wall.
      if (canDrawDoor) {
        for (const door of [corridor.fromDoor, corridor.toDoor] as const) {
          const sprite = this.drawDoor(door, tileSize, isPortalEdge);
          if (sprite) this.doorSprites.push(sprite);
        }
      }
    }
  }

  private drawDoor(
    door: DungeonDoor,
    tileSize: number,
    isPortalEdge: boolean,
  ): Phaser.GameObjects.Image | null {
    const cx = (door.x + 0.5) * tileSize;
    const cy = (door.y + 0.5) * tileSize;
    const img = this.add
      .image(cx, cy, DOOR_TEXTURE_KEY)
      .setDepth(2.5)
      .setAlpha(isPortalEdge ? 0.85 : 1);
    // Rotate so the door's hinge axis aligns with the wall it sits on.
    // North/south doors keep the upright pose; east/west doors are rotated 90°.
    if (door.side === 'E' || door.side === 'W') {
      img.setRotation(Math.PI / 2);
    }
    return img;
  }

  private roomCenter(room: DungeonRoom, tileSize: number): { x: number; y: number } {
    return {
      x: (room.gridX + room.width / 2) * tileSize,
      y: (room.gridY + room.height / 2) * tileSize,
    };
  }

  private findRoomAtWorld(x: number, y: number, map: DungeonMap): DungeonRoom | null {
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      const left = room.gridX * map.tileSize;
      const top = room.gridY * map.tileSize;
      const right = left + room.width * map.tileSize;
      const bottom = top + room.height * map.tileSize;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return room;
      }
    }
    return null;
  }

  private enterRoom(roomId: string): void {
    this.currentRoomId = roomId;
    this.refreshRoomNpcs();
    this.callbacks?.onRoomEntered(roomId);
    this.refreshPortalHint();
    this.refreshImageFrameIcons();
  }

  private setZoomTarget(zoom: number): void {
    if (this.currentZoomTarget === zoom) return;
    this.currentZoomTarget = zoom;
    // Tween the camera zoom so transitions are smooth instead of snapping.
    this.tweens.add({
      targets: this.cameras.main,
      zoom,
      duration: ZOOM_TWEEN_MS,
      ease: 'Sine.easeInOut',
    });
  }

  // ── Touch / pointer event handlers ──────────────────────────────────────

  /**
   * Minimum pixel travel before a touch/pointer contact is treated as a drag
   * rather than a tap.
   */
  private static readonly TOUCH_DRAG_THRESHOLD = 12;
  /** Maximum milliseconds for a contact to qualify as a tap. */
  private static readonly TOUCH_TAP_MAX_MS = 300;
  /** Minimum and maximum allowed camera zoom when pinching. */
  private static readonly PINCH_ZOOM_MIN = 0.4;
  private static readonly PINCH_ZOOM_MAX = 3.5;

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;

    if (p1?.isDown && p2?.isDown) {
      // Two fingers are now active - start a pinch-to-zoom gesture.
      const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
      // Guard against the degenerate case where both touch points are at the same position.
      if (dist < 1) return;
      this.pinchStartDistance = dist;
      this.pinchStartZoom = this.cameras.main.zoom;
      this.pinchActive = true;
      // A pinch cancels any single-finger movement/tap that was in progress.
      this.touchPointerActive = false;
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
      return;
    }

    // Single finger - begin tracking for drag (movement) or tap (interact).
    if (!this.touchPointerActive) {
      this.touchPointerActive = true;
      this.touchPointerStartX = pointer.x;
      this.touchPointerStartY = pointer.y;
      this.touchPointerStartTime = pointer.time;
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
    }
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    // ── Pinch zoom ────────────────────────────────────────────────────────
    if (this.pinchActive) {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown && this.pinchStartDistance > 0) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        const newZoom = Phaser.Math.Clamp(
          this.pinchStartZoom * (dist / this.pinchStartDistance),
          DungeonScene.PINCH_ZOOM_MIN,
          DungeonScene.PINCH_ZOOM_MAX,
        );
        // Stop any ongoing auto-zoom tween so pinch takes full control.
        this.tweens.killTweensOf(this.cameras.main);
        this.cameras.main.setZoom(newZoom);
        // Keep currentZoomTarget in sync so the auto-zoom guard in update()
        // does not immediately re-trigger a tween for the same target level.
        this.currentZoomTarget = newZoom;
      }
      return;
    }

    // ── Single-finger drag → directional movement ─────────────────────────
    if (!this.touchPointerActive || !pointer.isDown) return;

    const dx = pointer.x - this.touchPointerStartX;
    const dy = pointer.y - this.touchPointerStartY;
    const dist = Math.hypot(dx, dy);

    if (dist > DungeonScene.TOUCH_DRAG_THRESHOLD) {
      this.touchMoveVx = dx / dist;
      this.touchMoveVy = dy / dist;
    } else {
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    // End pinch when fewer than two fingers remain on screen.
    if (this.pinchActive && (!this.input.pointer1.isDown || !this.input.pointer2.isDown)) {
      this.pinchActive = false;
      this.touchPointerActive = false;
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
      return;
    }

    if (!this.touchPointerActive) return;

    const dx = pointer.x - this.touchPointerStartX;
    const dy = pointer.y - this.touchPointerStartY;
    const dist = Math.hypot(dx, dy);
    const elapsed = pointer.time - this.touchPointerStartTime;

    // A short contact with minimal movement is a tap → trigger the room action.
    if (dist < DungeonScene.TOUCH_DRAG_THRESHOLD && elapsed < DungeonScene.TOUCH_TAP_MAX_MS) {
      this.triggerInteract();
    }

    this.touchPointerActive = false;
    this.touchMoveVx = 0;
    this.touchMoveVy = 0;
  }
}

function statusColor(status: string): number {
  switch (status) {
    case 'EncounterDefeated':
    case 'ArtifactCollected':
      return 0x4fd1a5;
    case 'NotesDrafted':
      return 0x7be3ff;
    case 'NeedsRevalidation':
      return 0xff7676;
    case 'Visited':
      return 0x7fb2ff;
    default:
      return 0x636b85;
  }
}

/** Tiny FNV-1a-style string hash, used to seed per-floor/per-room PRNGs. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG - small, deterministic, good enough for layout jitter. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
