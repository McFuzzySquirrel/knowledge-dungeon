/**
 * Phaser dungeon-crawler scene.
 * Renders rooms and corridors derived from the topic graph, supports
 * WASD/arrow movement, room collision, an interact trigger for the Scribe
 * encounter, and emits visited-room / interact events via Phaser's emitter.
 */
import Phaser from 'phaser';
import type { DungeonMap, DungeonRoom } from '@/game/systems/dungeonTypes';
import type { PlayerClassId } from '@/game/systems/playerClasses';
import type { GraphicsMode } from '@/store/preferencesStore';
import { isEditableElementFocused } from '@/ui/utils/editableElement';

export interface DungeonSceneEvents {
  onRoomEntered: (roomId: string) => void;
  onInteract: (roomId: string) => void;
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

export interface FloorVisibilityInput {
  floorId: string;
  visibleRoomIds: ReadonlySet<string> | readonly string[];
  portalUpRoomId: string | null;
  portalDownRoomIds: ReadonlySet<string> | readonly string[];
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
const ARTIFACT_LOOT_SPRITE = `${BASE}assets/sprites/objects/artifact-loot.svg`;
const STAIRS_UP_SPRITE = `${BASE}assets/sprites/objects/stairs-up.svg`;
const STAIRS_DOWN_SPRITE = `${BASE}assets/sprites/objects/stairs-down.svg`;
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

// Tileset textures used as RPG-mode floor backgrounds. Cycled deterministically
// per floor so each floor has its own visual identity.
const TILESET_SPRITES = {
  ancientLibrary: `${BASE}assets/tilesets/ancient-library.svg`,
  lostArchive: `${BASE}assets/tilesets/lost-archive.svg`,
  deepDungeon: `${BASE}assets/tilesets/deep-dungeon.svg`,
} as const;
type TilesetKey = keyof typeof TILESET_SPRITES;
const TILESET_TEXTURE_KEYS: Record<TilesetKey, string> = {
  ancientLibrary: 'kd-tileset-ancient-library',
  lostArchive: 'kd-tileset-lost-archive',
  deepDungeon: 'kd-tileset-deep-dungeon',
};
const TILESET_KEYS: readonly TilesetKey[] = [
  'ancientLibrary',
  'lostArchive',
  'deepDungeon',
];
const TILESET_TILE_SIZE = 32;

const PLAYER_TEXTURE_KEY = 'kd-player';
const SIGNPOST_TEXTURE_KEY = 'kd-signpost';
const ARTIFACT_LOOT_TEXTURE_KEY = 'kd-artifact-loot';
const STAIRS_UP_TEXTURE_KEY = 'kd-stairs-up';
const STAIRS_DOWN_TEXTURE_KEY = 'kd-stairs-down';
const PLAYER_SPRITE_SIZE = 32;
const SIGNPOST_SPRITE_SIZE = 28;
const ARTIFACT_LOOT_SPRITE_SIZE = 26;
const PORTAL_SPRITE_SIZE = 28;
// Square collider, tighter than the rendered sprite so movement feels right.
const PLAYER_COLLIDER_SIZE = 16;

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
  private graphicsMode: GraphicsMode = 'rpg';
  private artifactIcons = new Map<string, Phaser.GameObjects.Image>();
  private artifactRoomIds = new Set<string>();
  private showArtifactIcons = false;
  private currentFloorId: string | null = null;
  private visibleRoomIds: Set<string> | null = null;
  private portalUpRoomId: string | null = null;
  private portalDownRoomIds = new Set<string>();
  private portalIcons = new Map<string, Phaser.GameObjects.Image>();
  private portalHintText: Phaser.GameObjects.Text | null = null;
  private floorTileSprites: Phaser.GameObjects.TileSprite[] = [];
  private decorIcons: Phaser.GameObjects.Image[] = [];
  /** Per-room floor id, captured when visibility is applied — used to seed
   * decor placement and tileset selection so the layout is stable across
   * redraws on the same floor. */
  private floorSeed = 0;

  constructor() {
    super({ key: 'DungeonScene' });
  }

  init(data: {
    dungeonMap: DungeonMap;
    callbacks: DungeonSceneEvents;
    playerClass?: PlayerClassId | null;
    graphicsMode?: GraphicsMode;
    initialFloor?: FloorVisibilityInput;
  }): void {
    this.dungeonMap = data.dungeonMap;
    this.callbacks = data.callbacks;
    this.playerClass = data.playerClass ?? null;
    this.graphicsMode = data.graphicsMode ?? 'rpg';
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
    for (const key of DECOR_KEYS) {
      this.load.svg(DECOR_TEXTURE_KEYS[key], DECOR_SPRITES[key], {
        width: DECOR_SPRITE_SIZE,
        height: DECOR_SPRITE_SIZE,
      });
    }
    for (const key of TILESET_KEYS) {
      this.load.svg(TILESET_TEXTURE_KEYS[key], TILESET_SPRITES[key], {
        width: TILESET_TILE_SIZE,
        height: TILESET_TILE_SIZE,
      });
    }
  }

  create(): void {
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;

    this.cameras.main.setBackgroundColor(this.graphicsMode === 'rpg' ? 0x1a120a : 0x10131a);

    this.corridorGraphics = this.add.graphics();
    this.roomGraphics = this.add.graphics();

    this.renderFloorTiles();
    this.drawCorridors(map);
    this.drawRooms(map);
    this.refreshDecor();

    const root = map.rooms.find((r) => r.isRoot) ?? map.rooms[0];
    if (!root) return;
    const start = this.roomCenter(root, map.tileSize);

    // Mark the root room with a signpost so the spawn location is obvious.
    this.add
      .image(start.x, start.y - root.height * map.tileSize * 0.3, SIGNPOST_TEXTURE_KEY)
      .setDepth(4);

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
    this.refreshPortalIcons();
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

    if (vx !== 0 || vy !== 0) {
      const length = Math.hypot(vx, vy) || 1;
      vx = (vx / length) * PLAYER_SPEED;
      vy = (vy / length) * PLAYER_SPEED;
    }

    this.playerBody.setVelocity(vx, vy);
    void dt;

    const player = this.player;
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
    }

    if (
      !typingInTextField &&
      this.interactKey &&
      Phaser.Input.Keyboard.JustDown(this.interactKey)
    ) {
      if (this.currentRoomId) {
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
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      if (this.artifactIcons.has(room.roomId)) continue;
      const center = this.roomCenter(room, map.tileSize);
      // Place the loot icon in the upper portion of the room so it doesn't
      // overlap the topic label rendered at the bottom edge.
      const icon = this.add
        .image(center.x, center.y - room.height * map.tileSize * 0.25, ARTIFACT_LOOT_TEXTURE_KEY)
        .setDepth(6);
      this.artifactIcons.set(room.roomId, icon);
    }
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
        ? 'Press E to ascend'
        : 'Press E to descend';
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
   * Switch the visible floor. Safe to call before `create()` — the scene
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
      this.refreshArtifactIcons();
      this.refreshPortalHint();
    }
  }

  private applyFloorVisibility(input: FloorVisibilityInput): void {
    this.currentFloorId = input.floorId;
    this.visibleRoomIds = new Set(input.visibleRoomIds);
    this.portalUpRoomId = input.portalUpRoomId;
    this.portalDownRoomIds = new Set(input.portalDownRoomIds);
    this.floorSeed = hashString(input.floorId);
  }

  /**
   * Render an RPG-mode tiled floor inside each visible room. Mindmap mode
   * intentionally leaves rooms as flat shapes so the floor tile texture
   * doesn't compete with the abstract node look.
   */
  private renderFloorTiles(): void {
    for (const tile of this.floorTileSprites) tile.destroy();
    this.floorTileSprites = [];
    if (!this.dungeonMap || this.graphicsMode !== 'rpg') return;
    // Pick a single tileset per floor so each floor reads as a distinct
    // location (Ancient Library vs Lost Archive vs Deep Dungeon).
    const tilesetKey = TILESET_KEYS[this.floorSeed % TILESET_KEYS.length];
    const textureKey = TILESET_TEXTURE_KEYS[tilesetKey];
    if (!this.textures.exists(textureKey)) return;
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
   * layout is stable across redraws. RPG-mode only — mindmap mode would
   * look noisy with object sprites layered onto its abstract nodes.
   */
  private refreshDecor(): void {
    for (const icon of this.decorIcons) icon.destroy();
    this.decorIcons = [];
    if (!this.dungeonMap || this.graphicsMode !== 'rpg') return;
    const map = this.dungeonMap;
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      // Don't clutter portal rooms — the stairs sprite should read clearly.
      if (
        room.roomId === this.portalUpRoomId ||
        this.portalDownRoomIds.has(room.roomId)
      ) {
        continue;
      }
      const roomSeed = hashString(`${this.currentFloorId ?? ''}::${room.roomId}`);
      const prng = mulberry32(roomSeed);
      // 2 decor pieces per room, picked from the four corners (top-left,
      // top-right, bottom-left only — bottom-right reserved for the topic
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

  private drawRooms(map: DungeonMap): void {
    if (!this.roomGraphics) return;
    const g = this.roomGraphics;
    g.clear();
    // Tear down any text labels we drew previously so a redraw doesn't leak
    // game objects when the floor is switched.
    for (const label of this.roomLabels.values()) label.destroy();
    this.roomLabels.clear();
    const isRpg = this.graphicsMode === 'rpg';
    for (const room of map.rooms) {
      if (this.visibleRoomIds && !this.visibleRoomIds.has(room.roomId)) continue;
      const x = room.gridX * map.tileSize;
      const y = room.gridY * map.tileSize;
      const w = room.width * map.tileSize;
      const h = room.height * map.tileSize;
      const isPortalUp = room.roomId === this.portalUpRoomId;
      const isPortalDown = this.portalDownRoomIds.has(room.roomId);
      const isPortal = isPortalUp || isPortalDown;

      if (isRpg) {
        // Stone-floor chamber with a thick mortared wall border.
        const fill = isPortal ? 0x1f2a3a : room.isRoot ? 0x4a3520 : 0x2a1f12;
        g.fillStyle(fill, 1);
        g.fillRect(x, y, w, h);
        // Inner floor tile band to suggest a tiled chamber.
        g.fillStyle(isPortal ? 0x2a3a5c : 0x3b2a18, 0.65);
        g.fillRect(x + 4, y + 4, w - 8, h - 8);
        g.lineStyle(3, isPortal ? 0x7fb2ff : statusColor(room.status), 1);
        g.strokeRect(x, y, w, h);
      } else {
        // Mind-map flavour: flat node, rounded by an outlined ellipse on top
        // of a soft-fill rectangle so room collision still maps to the grid.
        const fill = isPortal ? 0x2a3a5c : room.isRoot ? 0x223259 : 0x1a2032;
        g.fillStyle(fill, 1);
        g.fillRect(x, y, w, h);
        g.lineStyle(2, isPortal ? 0x7fb2ff : statusColor(room.status), 1);
        // Phaser's `strokeEllipse(cx, cy, width, height)` takes the FULL
        // ellipse dimensions (not radii), so passing `w` and `h` here makes
        // the ellipse exactly fill the room's grid footprint.
        g.strokeEllipse(x + w / 2, y + h / 2, w, h);
      }

      const labelPrefix = isPortalUp ? '↑ ' : isPortalDown ? '↓ ' : '';
      const label = this.add
        .text(x + w / 2, y + h - 12, `${labelPrefix}${room.topic}`, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '12px',
          color: isPortal ? '#cfe1ff' : isRpg ? '#f4e4c2' : '#f5f7ff',
          align: 'center',
          wordWrap: { width: w - 8 },
        })
        .setOrigin(0.5, 1)
        .setDepth(5);
      this.roomLabels.set(room.roomId, label);
    }
  }

  private drawCorridors(map: DungeonMap): void {
    if (!this.corridorGraphics) return;
    const g = this.corridorGraphics;
    g.clear();
    const isRpg = this.graphicsMode === 'rpg';
    const baseColor = isRpg ? 0x6b4a24 : 0x3b455e;
    const portalColor = 0x7fb2ff;

    const roomById = new Map(map.rooms.map((room) => [room.roomId, room] as const));
    for (const corridor of map.corridors) {
      if (
        this.visibleRoomIds &&
        (!this.visibleRoomIds.has(corridor.fromRoomId) ||
          !this.visibleRoomIds.has(corridor.toRoomId))
      ) {
        continue;
      }
      const from = roomById.get(corridor.fromRoomId);
      const to = roomById.get(corridor.toRoomId);
      if (!from || !to) continue;
      const isPortalEdge =
        corridor.fromRoomId === this.portalUpRoomId ||
        corridor.toRoomId === this.portalUpRoomId ||
        this.portalDownRoomIds.has(corridor.fromRoomId) ||
        this.portalDownRoomIds.has(corridor.toRoomId);
      g.lineStyle(isRpg ? 5 : 4, isPortalEdge ? portalColor : baseColor, 1);
      const a = this.roomCenter(from, map.tileSize);
      const b = this.roomCenter(to, map.tileSize);
      g.strokeLineShape(new Phaser.Geom.Line(a.x, a.y, b.x, b.y));
    }
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
    this.callbacks?.onRoomEntered(roomId);
    this.refreshPortalHint();
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
}

function statusColor(status: string): number {
  switch (status) {
    case 'EncounterDefeated':
    case 'ArtifactCollected':
      return 0x4fd1a5;
    case 'NotesDrafted':
      return 0xf2c879;
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

/** Mulberry32 PRNG — small, deterministic, good enough for layout jitter. */
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
