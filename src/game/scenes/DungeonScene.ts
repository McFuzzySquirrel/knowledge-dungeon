/**
 * Phaser dungeon-crawler scene.
 * Renders rooms and corridors derived from the topic graph, supports
 * WASD/arrow movement, room collision, an interact trigger for the Scribe
 * encounter, and emits visited-room / interact events via Phaser's emitter.
 */
import Phaser from 'phaser';
import type { DungeonMap, DungeonRoom } from '@/game/systems/dungeonTypes';

export interface DungeonSceneEvents {
  onRoomEntered: (roomId: string) => void;
  onInteract: (roomId: string) => void;
}

const PLAYER_SPEED = 160;

export class DungeonScene extends Phaser.Scene {
  private dungeonMap: DungeonMap | null = null;
  private callbacks: DungeonSceneEvents | null = null;
  private player: Phaser.GameObjects.Rectangle | null = null;
  private playerBody: Phaser.Physics.Arcade.Body | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private wasdKeys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private interactKey: Phaser.Input.Keyboard.Key | null = null;
  private currentRoomId: string | null = null;
  private roomLabels = new Map<string, Phaser.GameObjects.Text>();
  private roomGraphics: Phaser.GameObjects.Graphics | null = null;
  private corridorGraphics: Phaser.GameObjects.Graphics | null = null;

  constructor() {
    super({ key: 'DungeonScene' });
  }

  init(data: { dungeonMap: DungeonMap; callbacks: DungeonSceneEvents }): void {
    this.dungeonMap = data.dungeonMap;
    this.callbacks = data.callbacks;
  }

  create(): void {
    if (!this.dungeonMap) return;
    const map = this.dungeonMap;

    this.cameras.main.setBackgroundColor(0x10131a);

    this.corridorGraphics = this.add.graphics();
    this.roomGraphics = this.add.graphics();

    this.drawCorridors(map);
    this.drawRooms(map);

    const root = map.rooms.find((r) => r.isRoot) ?? map.rooms[0];
    if (!root) return;
    const start = this.roomCenter(root, map.tileSize);

    this.player = this.add.rectangle(start.x, start.y, 16, 16, 0xf2c879).setDepth(10);
    this.physics.add.existing(this.player);
    this.playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    this.playerBody.setCollideWorldBounds(false);

    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D') as Record<
        string,
        Phaser.Input.Keyboard.Key
      >;
      this.interactKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    }

    // Configure world & camera bounds based on the dungeon layout.
    const left = map.bounds.minX * map.tileSize;
    const top = map.bounds.minY * map.tileSize;
    const width = (map.bounds.maxX - map.bounds.minX) * map.tileSize;
    const height = (map.bounds.maxY - map.bounds.minY) * map.tileSize;
    this.physics.world.setBounds(left, top, width, height);
    this.cameras.main.setBounds(left, top, width, height);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);

    this.enterRoom(root.roomId);
  }

  update(_time: number, delta: number): void {
    if (!this.playerBody || !this.dungeonMap) return;
    const map = this.dungeonMap;

    const dt = delta / 1000;
    let vx = 0;
    let vy = 0;

    const left = this.cursors?.left?.isDown || this.wasdKeys.A?.isDown;
    const right = this.cursors?.right?.isDown || this.wasdKeys.D?.isDown;
    const up = this.cursors?.up?.isDown || this.wasdKeys.W?.isDown;
    const down = this.cursors?.down?.isDown || this.wasdKeys.S?.isDown;

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

    if (this.interactKey && Phaser.Input.Keyboard.JustDown(this.interactKey)) {
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

  private drawRooms(map: DungeonMap): void {
    if (!this.roomGraphics) return;
    const g = this.roomGraphics;
    g.clear();
    for (const room of map.rooms) {
      const x = room.gridX * map.tileSize;
      const y = room.gridY * map.tileSize;
      const w = room.width * map.tileSize;
      const h = room.height * map.tileSize;

      const fill = room.isRoot ? 0x223259 : 0x1a2032;
      g.fillStyle(fill, 1);
      g.fillRect(x, y, w, h);

      g.lineStyle(2, statusColor(room.status), 1);
      g.strokeRect(x, y, w, h);

      const label = this.add
        .text(x + w / 2, y + h - 12, room.topic, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '12px',
          color: '#f5f7ff',
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
    g.lineStyle(4, 0x3b455e, 1);

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
