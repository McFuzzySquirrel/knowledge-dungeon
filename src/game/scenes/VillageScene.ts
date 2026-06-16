import Phaser from 'phaser';
import { VILLAGE_MAP, type VillageStructure } from '@/data/villageLayout';

const BASE = import.meta.env.BASE_URL;

const PLAYER_SPEED = 120;
const NPC_SPEED = 30;
const INTERACT_RADIUS = 32;
const STRUCTURE_APPROACH_RADIUS = 48;

export interface VillageSceneEvents {
  onStructureApproached: (structureId: string) => void;
  onStructureLeft: (structureId: string) => void;
  onStructureInteract: (structureId: string) => void;
  onNpcApproached: (npcId: string) => void;
  onNpcLeft: (npcId: string) => void;
  onNpcInteract: (npcId: string) => void;
  onNpcDialogPosition?: (payload: { npcId: string; clientX: number; clientY: number }) => void;
  onReady: () => void;
}

const SPRITE_PATHS = {
  ground: `${BASE}assets/sprites/village/ground-tile.svg`,
  path: `${BASE}assets/sprites/village/path-tile.svg`,
  keeperTower: `${BASE}assets/sprites/village/keeper-tower.svg`,
  guildHall: `${BASE}assets/sprites/village/guild-hall.svg`,
  dungeonPortal: `${BASE}assets/sprites/village/dungeon-portal.svg`,
  trainingGate: `${BASE}assets/sprites/village/training-gate.svg`,
  fountain: `${BASE}assets/sprites/village/fountain.svg`,
  tree: `${BASE}assets/sprites/village/tree.svg`,
  lamp: `${BASE}assets/sprites/village/lamp.svg`,
  bench: `${BASE}assets/sprites/village/bench.svg`,
  villageGate: `${BASE}assets/sprites/village/village-gate.svg`,
  keeperNpc: `${BASE}assets/sprites/npc-keeper.svg`,
  playerHero: `${BASE}assets/sprites/player-hero.svg`,
  playerExplorer: `${BASE}assets/sprites/player-explorer.svg`,
  playerArchivist: `${BASE}assets/sprites/player-archivist.svg`,
} as const;

const TEX = {
  ground: 'v-ground',
  path: 'v-path',
  keeperTower: 'v-keeper-tower',
  guildHall: 'v-guild-hall',
  dungeonPortal: 'v-dungeon-portal',
  trainingGate: 'v-training-gate',
  fountain: 'v-fountain',
  tree: 'v-tree',
  lamp: 'v-lamp',
  bench: 'v-bench',
  villageGate: 'v-gate',
  keeperNpc: 'v-npc-keeper',
  playerHero: 'v-player-hero',
  playerExplorer: 'v-player-explorer',
  playerArchivist: 'v-player-archivist',
} as const;

const PLAYER_TEX_BY_CLASS: Record<string, string> = {
  scholar: TEX.playerHero,
  cartographer: TEX.playerExplorer,
  archivist: TEX.playerArchivist,
};

const STRUCTURE_TEXTURE: Record<string, string> = {
  'keeper-tower': TEX.keeperTower,
  'guild-hall': TEX.guildHall,
  'dungeon-portal': TEX.dungeonPortal,
  'training-gate': TEX.trainingGate,
  'fountain': TEX.fountain,
  'tree': TEX.tree,
  'lamp': TEX.lamp,
  'bench': TEX.bench,
  'gate': TEX.villageGate,
};

interface NpcState {
  sprite: Phaser.GameObjects.Image;
  pathIndex: number;
  targetX: number;
  targetY: number;
  waiting: boolean;
  waitTimer: number;
}

export class VillageScene extends Phaser.Scene {
  private callbacks: VillageSceneEvents | null = null;
  private player: Phaser.GameObjects.Image | null = null;
  private playerBody: Phaser.Physics.Arcade.Body | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private wasdKeys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private interactKey: Phaser.Input.Keyboard.Key | null = null;
  private npcStates = new Map<string, NpcState>();
  private groundTiles: Phaser.GameObjects.TileSprite[] = [];
  private pathTiles: Phaser.GameObjects.Image[] = [];
  private structureSprites: Phaser.GameObjects.Image[] = [];
  private structureZones: Phaser.GameObjects.Zone[] = [];
  private structureLabels: Phaser.GameObjects.Text[] = [];
  private structureGraphics: Phaser.GameObjects.Graphics[] = [];
  /** All structures (static + dynamic) for proximity checks */
  private allStructures: VillageStructure[] = [...VILLAGE_MAP.structures];
  private currentStructureId: string | null = null;
  private currentNpcId: string | null = null;
  private pendingDynamicStructures: VillageStructure[] | null = null;
  private currentPlayerClass: string = 'scholar';

  constructor() {
    super({ key: 'VillageScene' });
  }

  init(data: { callbacks: VillageSceneEvents; dynamicStructures?: VillageStructure[]; playerClass?: string }): void {
    this.callbacks = data.callbacks;
    if (data.playerClass) {
      this.currentPlayerClass = data.playerClass;
    }
    if (data.dynamicStructures && data.dynamicStructures.length > 0) {
      this.allStructures = [...VILLAGE_MAP.structures, ...data.dynamicStructures];
    }
  }

  /** Update dynamic structures after initial render (e.g. when subjects change). */
  setDynamicStructures(structures: VillageStructure[]): void {
    this.allStructures = [...VILLAGE_MAP.structures, ...structures];
    if (this.scene.isActive()) {
      this.rebuildDynamicStructures(structures);
    } else {
      this.pendingDynamicStructures = structures;
    }
  }

  /** Update the player sprite to reflect the selected class. */
  setPlayerClass(playerClass: string): void {
    this.currentPlayerClass = playerClass;
    this.updatePlayerSprite();
  }

  preload(): void {
    const loadSvg = (key: string, path: string, w: number, h: number) => {
      this.load.svg(key, path, { width: w, height: h });
    };

    loadSvg(TEX.ground, SPRITE_PATHS.ground, 48, 48);
    loadSvg(TEX.path, SPRITE_PATHS.path, 48, 48);
    loadSvg(TEX.keeperTower, SPRITE_PATHS.keeperTower, 160, 180);
    loadSvg(TEX.guildHall, SPRITE_PATHS.guildHall, 180, 160);
    loadSvg(TEX.dungeonPortal, SPRITE_PATHS.dungeonPortal, 96, 120);
    loadSvg(TEX.trainingGate, SPRITE_PATHS.trainingGate, 120, 120);
    loadSvg(TEX.fountain, SPRITE_PATHS.fountain, 96, 96);
    loadSvg(TEX.tree, SPRITE_PATHS.tree, 64, 80);
    loadSvg(TEX.lamp, SPRITE_PATHS.lamp, 32, 64);
    loadSvg(TEX.bench, SPRITE_PATHS.bench, 64, 32);
    loadSvg(TEX.villageGate, SPRITE_PATHS.villageGate, 120, 96);
    loadSvg(TEX.keeperNpc, SPRITE_PATHS.keeperNpc, 48, 48);
    loadSvg(TEX.playerHero, SPRITE_PATHS.playerHero, 32, 32);
    loadSvg(TEX.playerExplorer, SPRITE_PATHS.playerExplorer, 32, 32);
    loadSvg(TEX.playerArchivist, SPRITE_PATHS.playerArchivist, 32, 32);
  }

  create(): void {
    const map = VILLAGE_MAP;
    const ts = map.tileSize;
    const worldW = map.width * ts;
    const worldH = map.height * ts;

    this.cameras.main.setBackgroundColor(0x1a2a1a);

    this.renderGround(map);
    this.renderStructures(this.allStructures);
    this.renderNpcs(map);
    this.spawnPlayer(map);

    this.physics.world.setBounds(0, 0, worldW, worldH);
    this.cameras.main.setBounds(0, 0, worldW, worldH);
    this.cameras.main.startFollow(this.player!, true, 0.08, 0.08);
    this.cameras.main.setZoom(1.2);

    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasdKeys = this.input.keyboard.addKeys('W,A,S,D', false) as Record<string, Phaser.Input.Keyboard.Key>;
      this.interactKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E, false);
      this.input.keyboard.removeCapture([
        Phaser.Input.Keyboard.KeyCodes.W, Phaser.Input.Keyboard.KeyCodes.A,
        Phaser.Input.Keyboard.KeyCodes.S, Phaser.Input.Keyboard.KeyCodes.D,
        Phaser.Input.Keyboard.KeyCodes.E, Phaser.Input.Keyboard.KeyCodes.UP,
        Phaser.Input.Keyboard.KeyCodes.DOWN, Phaser.Input.Keyboard.KeyCodes.LEFT,
        Phaser.Input.Keyboard.KeyCodes.RIGHT, Phaser.Input.Keyboard.KeyCodes.SPACE,
        Phaser.Input.Keyboard.KeyCodes.SHIFT,
      ]);
    }

    // Apply any structures that arrived before create() finished
    if (this.pendingDynamicStructures) {
      this.rebuildDynamicStructures(this.pendingDynamicStructures);
      this.pendingDynamicStructures = null;
    }

    this.callbacks?.onReady();
  }

  update(_time: number, delta: number): void {
    if (!this.playerBody) return;
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
      const len = Math.hypot(vx, vy) || 1;
      vx = (vx / len) * PLAYER_SPEED;
      vy = (vy / len) * PLAYER_SPEED;
    }

    this.playerBody.setVelocity(0, 0);
    if (this.player) {
      this.player.x += vx * dt;
      this.player.y += vy * dt;
      this.playerBody.reset(this.player.x, this.player.y);
    }

    this.updateNpcMovement(dt);
    this.checkStructureProximity();
    this.checkNpcProximity();

    if (this.interactKey && Phaser.Input.Keyboard.JustDown(this.interactKey)) {
      this.handleInteract();
    }
  }

  private renderGround(map: typeof VILLAGE_MAP): void {
    const ts = map.tileSize;

    if (this.textures.exists(TEX.ground)) {
      const tilesX = Math.ceil(map.width / 8);
      const tilesY = Math.ceil(map.height / 8);
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          const tile = this.add.tileSprite(
            tx * 8 * ts, ty * 8 * ts,
            8 * ts, 8 * ts,
            TEX.ground,
          ).setOrigin(0, 0).setDepth(0);
          this.groundTiles.push(tile);
        }
      }
    }

    const pathCoords = [
      { x: 3, y: 22 }, { x: 4, y: 22 }, { x: 5, y: 22 }, { x: 6, y: 22 },
      { x: 4, y: 20 }, { x: 4, y: 18 }, { x: 4, y: 16 },
      { x: 6, y: 14 }, { x: 8, y: 14 },
      { x: 10, y: 14 }, { x: 12, y: 14 }, { x: 14, y: 14 }, { x: 16, y: 14 },
      { x: 16, y: 12 }, { x: 16, y: 10 }, { x: 16, y: 8 },
      { x: 18, y: 14 }, { x: 20, y: 14 }, { x: 22, y: 14 }, { x: 24, y: 14 },
      { x: 24, y: 16 }, { x: 24, y: 18 },
      { x: 26, y: 14 },
      { x: 16, y: 20 }, { x: 16, y: 22 },
      { x: 16, y: 16 }, { x: 16, y: 18 },
    ];

    if (this.textures.exists(TEX.path)) {
      for (const coord of pathCoords) {
        const p = this.add.image(
          coord.x * ts + ts / 2,
          coord.y * ts + ts / 2,
          TEX.path,
        ).setDepth(0.5);
        this.pathTiles.push(p);
      }
    }
  }

  private renderStructures(structures: VillageStructure[]): void {
    const ts = VILLAGE_MAP.tileSize;
    for (const struct of structures) {
      const texKey = STRUCTURE_TEXTURE[struct.type];
      if (!texKey || !this.textures.exists(texKey)) {
        this.drawFallbackStructure(struct);
        continue;
      }
      const cx = (struct.gridX + struct.width / 2) * ts;
      const cy = (struct.gridY + struct.height / 2) * ts;
      const sprite = this.add.image(cx, cy, texKey).setDepth(2);
      this.structureSprites.push(sprite);

      const isInteractive = struct.type === 'dungeon-portal' || struct.type === 'keeper-tower' || struct.type === 'guild-hall' || struct.type === 'training-gate';
      if (isInteractive) {
        const zone = this.add.zone(cx, cy, struct.width * ts, struct.height * ts).setInteractive();
        zone.setData('structureId', struct.id);
        this.structureZones.push(zone);
      }

      if (struct.label) {
        const label = this.add.text(cx, cy + struct.height / 2 * ts + 10, struct.label, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: struct.type === 'dungeon-portal' ? '12px' : '11px',
          color: struct.type === 'dungeon-portal' ? '#7be3ff' : '#dbe6ff',
          align: 'center',
          fontStyle: struct.type === 'dungeon-portal' ? 'bold' : 'normal',
        }).setOrigin(0.5, 0).setDepth(5);
        this.structureLabels.push(label);
      }
    }
  }

  private drawFallbackStructure(struct: VillageStructure): void {
    const ts = VILLAGE_MAP.tileSize;
    const x = struct.gridX * ts;
    const y = struct.gridY * ts;
    const w = struct.width * ts;
    const h = struct.height * ts;

    const g = this.add.graphics();
    this.structureGraphics.push(g);
    const isPortal = struct.type === 'dungeon-portal';
    const isImportant = struct.type === 'keeper-tower' || struct.type === 'guild-hall' || struct.type === 'training-gate';

    g.fillStyle(isPortal ? 0x3a1a6a : isImportant ? 0x3a2a1a : 0x2a3a1a, 0.85);
    g.fillRect(x + 2, y + 2, w - 4, h - 4);
    g.lineStyle(2, isPortal ? 0x7be3ff : 0x8b6a3a, 1);
    g.strokeRect(x + 2, y + 2, w - 4, h - 4);

    if (struct.label) {
      const label = this.add.text(x + w / 2, y + h + 6, struct.label, {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '11px',
        color: '#dbe6ff',
        align: 'center',
      }).setOrigin(0.5, 0).setDepth(5);
      this.structureLabels.push(label);
    }

    if (isPortal || isImportant) {
      const zone = this.add.zone(x + w / 2, y + h / 2, w, h).setInteractive();
      zone.setData('structureId', struct.id);
      this.structureZones.push(zone);
    }
  }

  private rebuildDynamicStructures(structures: VillageStructure[]): void {
    // Destroy all existing structure objects
    for (const s of this.structureSprites) s.destroy();
    for (const z of this.structureZones) z.destroy();
    for (const l of this.structureLabels) l.destroy();
    for (const g of this.structureGraphics) g.destroy();
    this.structureSprites = [];
    this.structureZones = [];
    this.structureLabels = [];
    this.structureGraphics = [];

    // Re-render all structures (static + dynamic)
    this.renderStructures(VILLAGE_MAP.structures);
    this.renderStructures(structures);
  }

  private spawnPlayer(map: typeof VILLAGE_MAP): void {
    const ts = map.tileSize;
    const sx = map.playerStart.x * ts + ts / 2;
    const sy = map.playerStart.y * ts + ts / 2;

    const playerTex = PLAYER_TEX_BY_CLASS[this.currentPlayerClass] ?? TEX.playerHero;
    if (!this.textures.exists(playerTex)) return;
    this.player = this.add.image(sx, sy, playerTex).setDepth(10);
    this.physics.add.existing(this.player);
    this.playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    this.playerBody.setSize(16, 16);
    this.playerBody.setOffset(8, 8);
    this.playerBody.setCollideWorldBounds(true);

    // Idle breathing animation — subtle scale pulse, doesn't fight movement
    this.tweens.add({
      targets: this.player,
      scaleX: { from: 1, to: 1.008 },
      scaleY: { from: 1, to: 1.012 },
      duration: 1400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private updatePlayerSprite(): void {
    if (!this.player) return;
    const texKey = PLAYER_TEX_BY_CLASS[this.currentPlayerClass] ?? TEX.playerHero;
    if (this.textures.exists(texKey)) {
      this.player.setTexture(texKey);
    }
  }

  private renderNpcs(map: typeof VILLAGE_MAP): void {
    const ts = map.tileSize;
    for (const npcData of map.npcs) {
      if (!this.textures.exists(TEX.keeperNpc)) continue;
      const nx = npcData.gridX * ts + ts / 2;
      const ny = npcData.gridY * ts + ts / 2;
      const sprite = this.add.image(nx, ny, TEX.keeperNpc).setDepth(9);
      this.tweens.add({
        targets: sprite,
        y: { from: ny, to: ny - 3 },
        duration: 1500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });

      const state: NpcState = {
        sprite,
        pathIndex: 0,
        targetX: nx,
        targetY: ny,
        waiting: true,
        waitTimer: 3000,
      };

      if (npcData.path && npcData.path.length > 0) {
        const first = npcData.path[0];
        state.targetX = first.x * ts + ts / 2;
        state.targetY = first.y * ts + ts / 2;
        state.waiting = false;
        state.waitTimer = 0;
      }

      this.npcStates.set(npcData.id, state);
    }
  }

  private updateNpcMovement(dt: number): void {
    const ts = VILLAGE_MAP.tileSize;
    for (const npcData of VILLAGE_MAP.npcs) {
      const state = this.npcStates.get(npcData.id);
      if (!state || !npcData.path || npcData.path.length === 0) continue;

      if (state.waiting) {
        state.waitTimer -= dt * 1000;
        if (state.waitTimer <= 0) {
          state.waiting = false;
          state.pathIndex = (state.pathIndex + 1) % npcData.path.length;
          const target = npcData.path[state.pathIndex];
          state.targetX = target.x * ts + ts / 2;
          state.targetY = target.y * ts + ts / 2;
        }
        continue;
      }

      const dx = state.targetX - state.sprite.x;
      const dy = state.targetY - state.sprite.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 4) {
        state.waiting = true;
        state.waitTimer = 3000 + Math.random() * 2000;
        continue;
      }

      const step = NPC_SPEED * dt;
      state.sprite.x += (dx / dist) * step;
      state.sprite.y += (dy / dist) * step;
    }
  }

  private checkStructureProximity(): void {
    if (!this.player) return;
    const ts = VILLAGE_MAP.tileSize;
    const approachThreshold = STRUCTURE_APPROACH_RADIUS;

    let closestId: string | null = null;
    let closestDist = approachThreshold;

    for (const zone of this.structureZones) {
      const structId = zone.getData('structureId') as string;
      if (!structId) continue;
      const struct = this.allStructures.find((s) => s.id === structId);
      if (!struct) continue;

      const structCx = (struct.gridX + struct.width / 2) * ts;
      const structCy = (struct.gridY + struct.height / 2) * ts;
      const dist = Math.hypot(this.player.x - structCx, this.player.y - structCy);

      if (dist < closestDist) {
        closestDist = dist;
        closestId = structId;
      }
    }

    if (closestId !== this.currentStructureId) {
      if (this.currentStructureId) {
        this.callbacks?.onStructureLeft(this.currentStructureId);
      }
      this.currentStructureId = closestId;
      if (closestId) {
        this.callbacks?.onStructureApproached(closestId);
      }
    }
  }

  private checkNpcProximity(): void {
    if (!this.player) return;

    let closestId: string | null = null;
    let closestDist = INTERACT_RADIUS;

    for (const npcData of VILLAGE_MAP.npcs) {
      const state = this.npcStates.get(npcData.id);
      if (!state) continue;
      const dist = Math.hypot(this.player.x - state.sprite.x, this.player.y - state.sprite.y);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = npcData.id;
      }
    }

    if (closestId !== this.currentNpcId) {
      if (this.currentNpcId) {
        this.callbacks?.onNpcLeft(this.currentNpcId);
      }
      this.currentNpcId = closestId;
      if (closestId) {
        this.callbacks?.onNpcApproached(closestId);
        const state = this.npcStates.get(closestId);
        if (state) {
          const camera = this.cameras.main;
          const screenX = (state.sprite.x - camera.worldView.x) * camera.zoom;
          const screenY = (state.sprite.y - camera.worldView.y) * camera.zoom;
          const canvasRect = this.game.canvas?.getBoundingClientRect();
          this.callbacks?.onNpcDialogPosition?.({
            npcId: closestId,
            clientX: (canvasRect?.left ?? 0) + screenX,
            clientY: (canvasRect?.top ?? 0) + screenY,
          });
        }
      }
    }
  }

  private handleInteract(): void {
    if (this.currentStructureId) {
      this.callbacks?.onStructureInteract(this.currentStructureId);
    } else if (this.currentNpcId) {
      this.callbacks?.onNpcInteract(this.currentNpcId);
    }
  }
}
