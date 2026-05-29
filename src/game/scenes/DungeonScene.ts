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

const PLAYER_TEXTURE_KEY = 'kd-player';
const SIGNPOST_TEXTURE_KEY = 'kd-signpost';
const ARTIFACT_LOOT_TEXTURE_KEY = 'kd-artifact-loot';
const PLAYER_SPRITE_SIZE = 32;
const SIGNPOST_SPRITE_SIZE = 28;
const ARTIFACT_LOOT_SPRITE_SIZE = 26;
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

  constructor() {
    super({ key: 'DungeonScene' });
  }

  init(data: {
    dungeonMap: DungeonMap;
    callbacks: DungeonSceneEvents;
    playerClass?: PlayerClassId | null;
    graphicsMode?: GraphicsMode;
  }): void {
    this.dungeonMap = data.dungeonMap;
    this.callbacks = data.callbacks;
    this.playerClass = data.playerClass ?? null;
    this.graphicsMode = data.graphicsMode ?? 'rpg';
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
  }

  create(): void {
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;

    this.cameras.main.setBackgroundColor(this.graphicsMode === 'rpg' ? 0x1a120a : 0x10131a);

    this.corridorGraphics = this.add.graphics();
    this.roomGraphics = this.add.graphics();

    this.drawCorridors(map);
    this.drawRooms(map);

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
        this.callbacks?.onInteract(this.currentRoomId);
      }
    }
  }

  /** Programmatic interact, used by on-screen touch button. */
  triggerInteract(): void {
    if (this.currentRoomId) {
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
    // Drop any icons that no longer belong (room removed or hidden).
    for (const [roomId, icon] of this.artifactIcons) {
      if (!this.showArtifactIcons || !this.artifactRoomIds.has(roomId)) {
        icon.destroy();
        this.artifactIcons.delete(roomId);
      }
    }
    if (!this.showArtifactIcons) return;
    for (const room of map.rooms) {
      if (!this.artifactRoomIds.has(room.roomId)) continue;
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

  private drawRooms(map: DungeonMap): void {
    if (!this.roomGraphics) return;
    const g = this.roomGraphics;
    g.clear();
    const isRpg = this.graphicsMode === 'rpg';
    for (const room of map.rooms) {
      const x = room.gridX * map.tileSize;
      const y = room.gridY * map.tileSize;
      const w = room.width * map.tileSize;
      const h = room.height * map.tileSize;

      if (isRpg) {
        // Stone-floor chamber with a thick mortared wall border.
        const fill = room.isRoot ? 0x4a3520 : 0x2a1f12;
        g.fillStyle(fill, 1);
        g.fillRect(x, y, w, h);
        // Inner floor tile band to suggest a tiled chamber.
        g.fillStyle(0x3b2a18, 0.65);
        g.fillRect(x + 4, y + 4, w - 8, h - 8);
        g.lineStyle(3, statusColor(room.status), 1);
        g.strokeRect(x, y, w, h);
      } else {
        // Mind-map flavour: flat node, rounded by an outlined ellipse on top
        // of a soft-fill rectangle so room collision still maps to the grid.
        const fill = room.isRoot ? 0x223259 : 0x1a2032;
        g.fillStyle(fill, 1);
        g.fillRect(x, y, w, h);
        g.lineStyle(2, statusColor(room.status), 1);
        g.strokeEllipse(x + w / 2, y + h / 2, w, h);
      }

      const label = this.add
        .text(x + w / 2, y + h - 12, room.topic, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '12px',
          color: isRpg ? '#f4e4c2' : '#f5f7ff',
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
    g.lineStyle(isRpg ? 5 : 4, isRpg ? 0x6b4a24 : 0x3b455e, 1);

    const roomById = new Map(map.rooms.map((room) => [room.roomId, room] as const));
    for (const corridor of map.corridors) {
      const from = roomById.get(corridor.fromRoomId);
      const to = roomById.get(corridor.toRoomId);
      if (!from || !to) continue;
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
