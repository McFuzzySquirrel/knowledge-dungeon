import Phaser from 'phaser';
import { VILLAGE_MAP, type VillageStructure } from '@/data/villageLayout';

const BASE = import.meta.env.BASE_URL;

const PLAYER_SPEED = 120;
const NPC_SPEED = 45;
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
  portalIcon: `${BASE}assets/sprites/village/portal-icon.svg`,
  bush: `${BASE}assets/sprites/village/bush.svg`,
  rock: `${BASE}assets/sprites/village/rock.svg`,
  lamp: `${BASE}assets/sprites/village/lamp.svg`,
  torch: `${BASE}assets/sprites/village/torch.svg`,
  pond: `${BASE}assets/sprites/village/pond.svg`,
  bird: `${BASE}assets/sprites/village/bird.svg`,
  npcScholar: `${BASE}assets/sprites/village/npc-scholar.svg`,
  npcWanderer: `${BASE}assets/sprites/village/npc-wanderer.svg`,
  npcSage: `${BASE}assets/sprites/village/npc-sage.svg`,
  signpost: `${BASE}assets/sprites/village/signpost.svg`,
  waysign: `${BASE}assets/sprites/village/waysign.svg`,
  trophyHall: `${BASE}assets/sprites/village/trophy-hall.svg`,
  library: `${BASE}assets/sprites/village/library.svg`,
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
  torch: 'v-torch',
  pond: 'v-pond',
  bird: 'v-bird',
  npcScholar: 'v-npc-scholar',
  npcWanderer: 'v-npc-wanderer',
  npcSage: 'v-npc-sage',
  signpost: 'v-signpost',
  waysign: 'v-waysign',
  portalIcon: 'v-portal-icon',
  bush: 'v-bush',
  rock: 'v-rock',
  trophyHall: 'v-trophy-hall',
  library: 'v-library',
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
  'torch': TEX.torch,
  'signpost': TEX.signpost,
  'waysign': TEX.waysign,
  'portal-icon': TEX.portalIcon,
  'bush': TEX.bush,
  'rock': TEX.rock,
  'pond': TEX.pond,
  'flower': TEX.tree,  // reuse tree texture for flowers
  'trophy-hall': TEX.trophyHall,
  'bench': TEX.bench,
  'gate': TEX.villageGate,
  'library': TEX.library,
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
  /** Last known nearest POI data for React compass overlay. Updated every frame. */
  lastPoi: { name: string; angle: number; distance: number } = { name: '', angle: 0, distance: Infinity };

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
    loadSvg(TEX.keeperTower, SPRITE_PATHS.keeperTower, 120, 140);
    loadSvg(TEX.guildHall, SPRITE_PATHS.guildHall, 130, 120);
    loadSvg(TEX.dungeonPortal, SPRITE_PATHS.dungeonPortal, 80, 100);
    loadSvg(TEX.trainingGate, SPRITE_PATHS.trainingGate, 96, 96);
    loadSvg(TEX.fountain, SPRITE_PATHS.fountain, 72, 72);
    loadSvg(TEX.tree, SPRITE_PATHS.tree, 48, 60);
    loadSvg(TEX.lamp, SPRITE_PATHS.lamp, 24, 48);
    loadSvg(TEX.torch, SPRITE_PATHS.torch, 24, 48);
    loadSvg(TEX.signpost, SPRITE_PATHS.signpost, 72, 90);
    loadSvg(TEX.waysign, SPRITE_PATHS.waysign, 72, 90);
    loadSvg(TEX.pond, SPRITE_PATHS.pond, 64, 48);
    loadSvg(TEX.bird, SPRITE_PATHS.bird, 36, 24);
    loadSvg(TEX.npcScholar, SPRITE_PATHS.npcScholar, 40, 56);
    loadSvg(TEX.npcWanderer, SPRITE_PATHS.npcWanderer, 40, 56);
    loadSvg(TEX.npcSage, SPRITE_PATHS.npcSage, 48, 64);
    loadSvg(TEX.portalIcon, SPRITE_PATHS.portalIcon, 48, 48);
    loadSvg(TEX.bush, SPRITE_PATHS.bush, 48, 48);
    loadSvg(TEX.rock, SPRITE_PATHS.rock, 32, 24);
    loadSvg(TEX.trophyHall, SPRITE_PATHS.trophyHall, 120, 120);
    loadSvg(TEX.library, SPRITE_PATHS.library, 120, 140);
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

    this.initTouchControls();

    // Apply any structures that arrived before create() finished
    if (this.pendingDynamicStructures) {
      this.rebuildDynamicStructures(this.pendingDynamicStructures);
      this.pendingDynamicStructures = null;
    }

    this.createBirds();
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

    // Merge touch/pointer drag direction
    vx += this.touchMoveVx;
    vy += this.touchMoveVy;

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
    this.updatePoiData();

    if (this.interactKey && Phaser.Input.Keyboard.JustDown(this.interactKey)) {
      this.handleInteract();
    }
  }

  private renderGround(map: typeof VILLAGE_MAP): void {
    const ts = map.tileSize;

    // Ground tiles
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

    // Axis-aligned stone paths - every segment is horizontal or vertical
    const pathSegments: { x1: number; y1: number; x2: number; y2: number }[] = [
      // ── Entrance ──────────────────────────────────
      { x1: 3,  y1: 22, x2: 6,  y2: 22 },  // gate approach
      { x1: 4,  y1: 22, x2: 4,  y2: 16 },  // up from gate
      { x1: 4,  y1: 16, x2: 4,  y2: 14 },  // continue north to cross

      // ── East-west spine (y=14) ────────────────────
      { x1: 4,  y1: 14, x2: 6,  y2: 14 },
      { x1: 6,  y1: 14, x2: 16, y2: 14 },
      { x1: 16, y1: 14, x2: 24, y2: 14 },
      { x1: 24, y1: 14, x2: 26, y2: 14 },
      { x1: 26, y1: 14, x2: 30, y2: 14 },  // extend to east edge

      // ── North-south spine (x=16) ──────────────────
      { x1: 16, y1: 14, x2: 16, y2: 8  },  // north to library/keeper split
      { x1: 16, y1: 8,  x2: 16, y2: 5  },  // continue to keeper
      { x1: 16, y1: 14, x2: 16, y2: 17 },  // south to fountain
      { x1: 16, y1: 17, x2: 16, y2: 22 },  // continue to trophy split
      { x1: 16, y1: 22, x2: 16, y2: 24 },  // continue south

      // ── Library branch ────────────────────────────
      { x1: 12, y1: 8,  x2: 16, y2: 8  },  // west from north spine
      { x1: 12, y1: 5,  x2: 12, y2: 8  },  // north to library

      // ── Training gate ─────────────────────────────
      { x1: 6,  y1: 14, x2: 6,  y2: 8  },  // north from cross
      { x1: 6,  y1: 8,  x2: 6,  y2: 7  },  // continue to training entrance

      // ── Fountain ──────────────────────────────────
      { x1: 16, y1: 17, x2: 18, y2: 17 },  // east spur

      // ── Guild hall ────────────────────────────────
      { x1: 30, y1: 14, x2: 30, y2: 11 },  // south from cross

      // ── Trophy hall ───────────────────────────────
      { x1: 16, y1: 24, x2: 30, y2: 24 },  // east from south spine

      // ── East connector ────────────────────────────
      { x1: 24, y1: 14, x2: 24, y2: 18 },  // south from cross

      // ── Portal connections (L-shaped, axis-aligned) ──
      { x1: 4,  y1: 14, x2: 4,  y2: 4  },  // NW portal: north
      { x1: 4,  y1: 4,  x2: 3,  y2: 4  },  // NW portal: west
      { x1: 4,  y1: 16, x2: 7,  y2: 16 },  // W portal: east
      { x1: 7,  y1: 16, x2: 7,  y2: 17 },  // W portal: north
      { x1: 16, y1: 22, x2: 12, y2: 22 },  // SW portal: west
      { x1: 12, y1: 22, x2: 12, y2: 24 },  // SW portal: south
      { x1: 16, y1: 22, x2: 23, y2: 22 },  // SE portal: east
      { x1: 23, y1: 22, x2: 23, y2: 23 },  // SE portal: south
      { x1: 24, y1: 14, x2: 24, y2: 5  },  // NE portal: north
      { x1: 24, y1: 5,  x2: 25, y2: 5  },  // NE portal: east
      { x1: 30, y1: 14, x2: 30, y2: 15 },  // E portal: south
    ];

    const pathG = this.add.graphics().setDepth(0.5);
    const pathColor = Phaser.Display.Color.HexStringToColor('#5a4a3a').color;
    const pathAlpha = 0.6;
    const pathWidth = ts * 0.5;

    for (const seg of pathSegments) {
      const px1 = seg.x1 * ts + ts / 2;
      const py1 = seg.y1 * ts + ts / 2;
      const px2 = seg.x2 * ts + ts / 2;
      const py2 = seg.y2 * ts + ts / 2;
      pathG.lineStyle(pathWidth, pathColor, pathAlpha);
      pathG.beginPath();
      pathG.moveTo(px1, py1);
      pathG.lineTo(px2, py2);
      pathG.strokePath();
    }

    // Junctions - circles at every intersection point
    const junctionColor = Phaser.Display.Color.HexStringToColor('#4a3a2a').color;
    const junctionCoords = [
      { x: 4,  y: 14 }, { x: 6,  y: 14 }, { x: 16, y: 14 }, { x: 24, y: 14 },
      { x: 26, y: 14 }, { x: 30, y: 14 }, { x: 16, y: 8  }, { x: 16, y: 17 },
      { x: 16, y: 22 }, { x: 16, y: 24 }, { x: 12, y: 8  }, { x: 4,  y: 16 },
      { x: 4,  y: 22 }, { x: 6,  y: 8  }, { x: 24, y: 18 },
    ];
    for (const j of junctionCoords) {
      pathG.fillStyle(junctionColor, 0.5);
      pathG.fillCircle(j.x * ts + ts / 2, j.y * ts + ts / 2, ts * 0.28);
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
      // Decorative elements (trees, benches, torches, fountain, signpost) sit above player
      const decorTypes = new Set(['tree', 'bench', 'torch', 'fountain', 'lamp', 'signpost', 'waysign', 'pond', 'flower']);
      const depth = decorTypes.has(struct.type) ? 11 : 2;
      const sprite = this.add.image(cx, cy, texKey).setDepth(depth);
      this.structureSprites.push(sprite);

      // Stone circle under portal icons
      if (struct.type === 'portal-icon') {
        const stoneG = this.add.graphics().setDepth(1);
        stoneG.fillStyle(0x3a3a3a, 0.4);
        stoneG.fillEllipse(cx, cy + 8, struct.width * ts * 0.7, struct.height * ts * 0.2);
        stoneG.lineStyle(1, 0x5a5a5a, 0.3);
        stoneG.strokeEllipse(cx, cy + 8, struct.width * ts * 0.7, struct.height * ts * 0.2);
        this.structureGraphics.push(stoneG);
      }

      // Portal icon animation - spinning + pulse
      if (struct.type === 'portal-icon') {
        const portal = sprite;
        this.tweens.add({
          targets: portal,
          angle: 360,
          duration: 6000,
          repeat: -1,
          ease: 'Linear',
        });
        this.tweens.add({
          targets: portal,
          scale: { from: 0.95, to: 1.05 },
          duration: 1500,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }

      // Fountain water animation (Phaser tween replaces SVG CSS)
      if (struct.type === 'fountain') {
        this.tweens.add({
          targets: sprite,
          scaleY: { from: 1, to: 1.03 },
          duration: 1800,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }

      const interactiveTypes = new Set(['portal-icon', 'keeper-tower', 'guild-hall', 'training-gate', 'signpost', 'waysign', 'trophy-hall', 'library']);
      const isInteractive = interactiveTypes.has(struct.type);
      if (isInteractive) {
        const zone = this.add.zone(cx, cy, struct.width * ts, struct.height * ts).setInteractive();
        zone.setData('structureId', struct.id);
        this.structureZones.push(zone);
      }

      if (struct.label) {
        // Banner overlay on top of the building
        const topY = cy - (struct.height / 2) * ts;
        const isPortalStyle = struct.type === 'portal-icon';
        const bannerH = isPortalStyle ? 22 : 20;
        const bannerG = this.add.graphics().setDepth(4.9);
        bannerG.fillStyle(0x0a0a1a, 0.75);
        bannerG.fillRoundedRect(cx - (struct.width * ts) / 2 + 4, topY + 4, struct.width * ts - 8, bannerH, 4);
        bannerG.lineStyle(1, 0xffffff, 0.1);
        bannerG.strokeRoundedRect(cx - (struct.width * ts) / 2 + 4, topY + 4, struct.width * ts - 8, bannerH, 4);
        this.structureGraphics.push(bannerG);

        const label = this.add.text(cx, topY + 4 + bannerH / 2, struct.label, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: isPortalStyle ? '12px' : '11px',
          color: isPortalStyle ? '#7be3ff' : '#f2e2c4',
          align: 'center',
          fontStyle: isPortalStyle ? 'bold' : 'normal',
        }).setOrigin(0.5, 0.5).setDepth(5);
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
    const isPortal = struct.type === 'portal-icon';
    const isImportant = struct.type === 'keeper-tower' || struct.type === 'guild-hall' || struct.type === 'training-gate';

    g.fillStyle(isPortal ? 0x3a1a6a : isImportant ? 0x3a2a1a : 0x2a3a1a, 0.85);
    g.fillRect(x + 2, y + 2, w - 4, h - 4);
    g.lineStyle(2, isPortal ? 0x7be3ff : 0x8b6a3a, 1);
    g.strokeRect(x + 2, y + 2, w - 4, h - 4);

    if (struct.label) {
      // Banner on top of the fallback building
      const bannerH = isPortal ? 22 : 20;
      const bannerG = this.add.graphics().setDepth(4.9);
      bannerG.fillStyle(0x0a0a1a, 0.75);
      bannerG.fillRoundedRect(x + 4, y + 4, w - 8, bannerH, 4);
      bannerG.lineStyle(1, 0xffffff, 0.1);
      bannerG.strokeRoundedRect(x + 4, y + 4, w - 8, bannerH, 4);
      this.structureGraphics.push(bannerG);

      const label = this.add.text(x + w / 2, y + 4 + bannerH / 2, struct.label, {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: isPortal ? '12px' : '11px',
        color: isPortal ? '#7be3ff' : '#f2e2c4',
        align: 'center',
        fontStyle: isPortal ? 'bold' : 'normal',
      }).setOrigin(0.5, 0.5).setDepth(5);
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

    // Subtle idle sway (rotation) - does not conflict with movement
    this.tweens.add({
      targets: this.player,
      angle: { from: -0.5, to: 0.5 },
      duration: 1200,
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

  /** Populate `lastPoi` each frame so the React compass overlay can read it. */
  private updatePoiData(): void {
    if (!this.player) return;
    const ts = VILLAGE_MAP.tileSize;
    let nearestName = '';
    let nearestDistSq = Infinity;
    let nearestAngle = 0;

    for (const struct of this.allStructures) {
      if (struct.type !== 'portal-icon' && struct.type !== 'keeper-tower') continue;
      const cx = (struct.gridX + struct.width / 2) * ts;
      const cy = (struct.gridY + struct.height / 2) * ts;
      const dx = cx - this.player.x;
      const dy = cy - this.player.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestAngle = Math.atan2(dy, dx);
        nearestName = struct.type === 'keeper-tower'
          ? 'Keeper'
          : (struct as VillageStructure & { subjectName?: string }).subjectName || struct.label || 'Dungeon';
      }
    }

    if (nearestName) {
      this.lastPoi = { name: nearestName, angle: nearestAngle, distance: Math.sqrt(nearestDistSq) };
    }
  }

  private createBirds(): void {
    if (!this.textures.exists(TEX.bird)) return;
    const ts = VILLAGE_MAP.tileSize;
    const worldW = VILLAGE_MAP.width * ts;
    const worldH = VILLAGE_MAP.height * ts;

    // Define 6 birds with start positions and flight destinations (arc paths)
    // Bird start positions (fraction of world) and destination x-fraction
    const birdRoutes: { sx: number; sy: number; dx: number }[] = [
      { sx: 0.1, sy: 0.05, dx: 0.4 },
      { sx: 0.5, sy: 0.02, dx: 0.7 },
      { sx: 0.8, sy: 0.10, dx: 0.55 },
      { sx: 0.3, sy: 0.15, dx: 0.15 },
      { sx: 0.65, sy: 0.06, dx: 0.9 },
      { sx: 0.45, sy: 0.12, dx: 0.3 },
    ];

    for (let bi = 0; bi < birdRoutes.length; bi++) {
      const r = birdRoutes[bi];
      const bx = worldW * r.sx;
      const by = worldH * r.sy;
      const tx = worldW * r.dx;
      const ty = by + 20 - Math.random() * 40; // slight y variation at destination

      const bird = this.add.image(bx, by, TEX.bird).setDepth(12).setAlpha(0.85);

      // Sweep horizontally
      this.tweens.add({
        targets: bird,
        x: { from: bx, to: tx },
        y: { from: by, to: ty },
        duration: 4000 + Math.random() * 3000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: bi * 700,
        hold: 1000,
      });
    }
  }

  private renderNpcs(map: typeof VILLAGE_MAP): void {
    const ts = map.tileSize;
    const npcTexMap: Record<string, string> = {
      keeper: TEX.keeperNpc,
      'villager-1': TEX.npcScholar,
      'villager-2': TEX.npcWanderer,
      'villager-3': TEX.npcScholar,
      'villager-4': TEX.npcSage,
      'villager-5': TEX.npcScholar,
    };
    for (const npcData of map.npcs) {
      const texKey = npcTexMap[npcData.id] ?? TEX.keeperNpc;
      if (!this.textures.exists(texKey)) continue;
      const nx = npcData.gridX * ts + ts / 2;
      const ny = npcData.gridY * ts + ts / 2;
      const sprite = this.add.image(nx, ny, texKey).setDepth(9);
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
        waitTimer: Math.random() * 2000,
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
        state.waitTimer = 400 + Math.random() * 1200;
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

  /** Programmatic interact, called from the on-screen touch button. */
  triggerInteract(): void {
    this.handleInteract();
  }

  // ── Touch / pointer controls ──────────────────────────────────────────
  private static readonly TOUCH_DRAG_THRESHOLD = 10;
  private static readonly TOUCH_TAP_MAX_MS = 300;
  private static readonly PINCH_ZOOM_MIN = 0.6;
  private static readonly PINCH_ZOOM_MAX = 2.4;
  private touchPointerActive = false;
  private touchPointerStartX = 0;
  private touchPointerStartY = 0;
  private touchPointerStartTime = 0;
  private touchMoveVx = 0;
  private touchMoveVy = 0;
  private pinchActive = false;
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;

  private initTouchControls(): void {
    this.input.addPointer(1);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { this.handleTouchDown(p); });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { this.handleTouchMove(p); });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => { this.handleTouchUp(p); });
    this.input.on('pointercancel', (p: Phaser.Input.Pointer) => { this.handleTouchUp(p); });
  }

  private handleTouchDown(pointer: Phaser.Input.Pointer): void {
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;
    if (p1?.isDown && p2?.isDown) {
      const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
      if (dist < 1) return;
      this.pinchStartDistance = dist;
      this.pinchStartZoom = this.cameras.main.zoom;
      this.pinchActive = true;
      this.touchPointerActive = false;
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
      return;
    }
    if (!this.touchPointerActive) {
      this.touchPointerActive = true;
      this.touchPointerStartX = pointer.x;
      this.touchPointerStartY = pointer.y;
      this.touchPointerStartTime = pointer.time;
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
    }
  }

  private handleTouchMove(pointer: Phaser.Input.Pointer): void {
    if (this.pinchActive) {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown && this.pinchStartDistance > 0) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        this.cameras.main.setZoom(Phaser.Math.Clamp(
          this.pinchStartZoom * (dist / this.pinchStartDistance),
          VillageScene.PINCH_ZOOM_MIN,
          VillageScene.PINCH_ZOOM_MAX,
        ));
      }
      return;
    }
    if (!this.touchPointerActive || !pointer.isDown) return;
    const dx = pointer.x - this.touchPointerStartX;
    const dy = pointer.y - this.touchPointerStartY;
    const dist = Math.hypot(dx, dy);
    if (dist > VillageScene.TOUCH_DRAG_THRESHOLD) {
      this.touchMoveVx = dx / dist;
      this.touchMoveVy = dy / dist;
    } else {
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
    }
  }

  private handleTouchUp(_pointer: Phaser.Input.Pointer): void {
    if (this.pinchActive && (!this.input.pointer1.isDown || !this.input.pointer2.isDown)) {
      this.pinchActive = false;
      this.touchPointerActive = false;
      this.touchMoveVx = 0;
      this.touchMoveVy = 0;
      return;
    }
    if (!this.touchPointerActive) return;
    const dx = this.touchPointerStartX !== 0 ? _pointer.x - this.touchPointerStartX : 0;
    const dy = this.touchPointerStartY !== 0 ? _pointer.y - this.touchPointerStartY : 0;
    const dist = Math.hypot(dx, dy);
    const elapsed = _pointer.time - this.touchPointerStartTime;
    if (dist < VillageScene.TOUCH_DRAG_THRESHOLD && elapsed < VillageScene.TOUCH_TAP_MAX_MS) {
      this.handleInteract();
    }
    this.touchPointerActive = false;
    this.touchMoveVx = 0;
    this.touchMoveVy = 0;
  }
}
