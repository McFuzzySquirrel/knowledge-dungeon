import Phaser from 'phaser';
import {
  FISH_CATALOG,
  BITE_WINDOW_SEC,
  FISH_DIRECTION_WEIGHTS,
  MAX_PROXIMITY_WAIT_MS,
  type FishCatalogEntry,
  type FishRarity,
  type FishDirection,
} from '@/game/systems/fishingTypes';
import { rollFishRarity } from '@/game/systems/fishingMechanics';
import { resolveSpriteUrl, getAnimationConfig, applySpriteAnimation } from '@/services/customSprites';

// ── Layout constants ──────────────────────────────────────────────────────
/** Fraction of canvas height for the distant horizon/shore at top. */
const HORIZON_FRACTION = 0.10;
/** Fraction of canvas height where the foreground shore starts (bottom). */
const SHORE_FRACTION = 0.80;
/** Player vertical position as fraction of canvas height (on the shore). */
const PLAYER_Y_FRACTION = 0.87;
/** Player horizontal position as fraction of canvas width (centered). */
const PLAYER_START_X_FRACTION = 0.50;
/** Player movement speed in px/s. */
const PLAYER_MOVE_SPEED = 200;
/** Horizontal margin (px) from screen edges for player movement bounds. */
const PLAYER_EDGE_MARGIN = 50;
/** Bobber bob animation amount. */
const BOBBER_BOB_AMOUNT = 4;
/** Speed (px/s) the bobber travels upward during cast. */
const CAST_SPEED = 380;
/** How long the reeling animation takes (ms). */
const REEL_DURATION_MS = 600;
/** How long the missed/flee animation takes (ms). */
const MISS_DURATION_MS = 800;
/** Fish silhouette swim speed for off-screen entry. */
const FISH_SWIM_SPEED = 80;
/** Water tile height. */
const WATER_TILE_SIZE = 32;
/** Margin (px) from horizon for max cast distance. */
const HORIZON_MARGIN = 16;
/** Distance (px) between fish center and bobber center to trigger a bite. */
const PROXIMITY_THRESHOLD = 50;
/** Time (ms) for the power meter to fill from 0 to 1. */
const POWER_BUILD_TIME_MS = 1500;

// Colors
const SHORE_GREEN = 0x2a4a1a;
const SHORE_DIRT = 0x3a2a14;

// ── Player sprite paths (same as VillageScene) ────────────────────────────
const PLAYER_SPRITE_BY_CLASS: Record<string, string> = {
  scholar: 'sprites/player-hero.svg',
  cartographer: 'sprites/player-explorer.svg',
  archivist: 'sprites/player-archivist.svg',
};
const PLAYER_TEX_KEY = 'fish-player';
const PLAYER_SIZE = 40;

// Fishing sprite texture keys
const TEX_TREE = 'fish-tree';
const TEX_BUSH = 'fish-bush';
const TEX_WATER = 'fish-water';
const TEX_BOBBER = 'fish-bobber';
const TEX_ROD = 'fish-rod';

// ── Fishing state ──────────────────────────────────────────────────────────
type FishingState = 'idle' | 'powering' | 'casting' | 'waiting' | 'biting' | 'reeling' | 'caught' | 'missed';

export interface FishingSceneEvents {
  /** Fired when a fish is successfully caught. */
  onFishCaught?: (data: { fishName: string; rarity: FishRarity; catalogId: string; description: string }) => void;
  /** Fired when the player wants to return to the village. */
  onReturnToVillage: () => void;
  /** Fired when the scene is fully created and ready. */
  onReady: () => void;
}

export class FishingScene extends Phaser.Scene {
  private callbacks: FishingSceneEvents | null = null;
  private state: FishingState = 'idle';
  private playerClass: string = 'scholar';

  // ── Layout (recalculated on resize) ──────────────────────────────────────
  private horizonY = 0;
  private shoreY = 0;
  private playerY = 0;
  private playerX = 0;
  private canvasW = 0;
  private canvasH = 0;

  // ── Visual objects ───────────────────────────────────────────────────────
  private skyGfx: Phaser.GameObjects.Graphics | null = null;
  private starGfx: Phaser.GameObjects.Graphics | null = null;
  private shoreGfx: Phaser.GameObjects.Graphics | null = null;
  private waterTiles: Phaser.GameObjects.TileSprite[] = [];
  private playerSprite: Phaser.GameObjects.Image | null = null;
  private rodSprite: Phaser.GameObjects.Image | null = null;
  private bobberSprite: Phaser.GameObjects.Image | null = null;
  private fishSprite: Phaser.GameObjects.Image | null = null;
  private lineGfx: Phaser.GameObjects.Graphics | null = null;
  private bucketGfx: Phaser.GameObjects.Graphics | null = null;
  private bucketFishSprites: Phaser.GameObjects.Image[] = [];
  private caughtCount = 0;
  private hintText: Phaser.GameObjects.Text | null = null;
  private returnBtn: Phaser.GameObjects.Text | null = null;

  // ── Power meter visuals ──────────────────────────────────────────────────
  private powerBarGfx: Phaser.GameObjects.Graphics | null = null;
  private powerBarText: Phaser.GameObjects.Text | null = null;
  private powerBarBg: Phaser.GameObjects.Graphics | null = null;

  // ── Gameplay state ───────────────────────────────────────────────────────
  private currentFish: FishCatalogEntry | null = null;
  private bobberTargetX = 0;
  /** Velocity of bobber during 'casting' state (px/s). */
  private bobberVX = 0;
  private bobberVY = 0;
  private biteWindowTimer: Phaser.Time.TimerEvent | null = null;
  private biteWindowActive = false;
  /** Current power level 0..1 built during the 'powering' state. */
  private powerValue = 0;
  /** Timestamp (ms) when the 'waiting' state started; used for max-timeout fallback. */
  private waitStartTime = 0;
  /** Direction the current fish is entering from. */
  private fishDirection: FishDirection = 'right';

  constructor() {
    super({ key: 'FishingScene' });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  init(data: { callbacks: FishingSceneEvents; playerClass?: string }): void {
    this.callbacks = data.callbacks;
    if (data.playerClass) this.playerClass = data.playerClass;
  }

  preload(): void {
    // Fishing sprites
    this.load.svg(TEX_TREE, 'assets/sprites/village/tree.svg', { width: 64, height: 80 });
    this.load.svg(TEX_BUSH, 'assets/sprites/village/bush.svg', { width: 48, height: 48 });
    this.load.svg(TEX_WATER, 'assets/sprites/fishing/water-surface.svg', { width: 64, height: WATER_TILE_SIZE });
    this.load.svg(TEX_BOBBER, 'assets/sprites/fishing/bobber.svg', { width: 24, height: 32 });
    this.load.svg(TEX_ROD, 'assets/sprites/fishing/rod.svg', { width: 16, height: 120 });

    // Load all fish silhouette sprites from the catalog
    for (const fish of FISH_CATALOG) {
      const texKey = `fish-${fish.id}`;
      if (!this.textures.exists(texKey)) {
        this.load.svg(texKey, `assets/sprites/fishing/${fish.sprite}`, { width: 64, height: 32 });
      }
    }

    // Player sprite (uses resolveSpriteUrl for customization support)
    const playerSpritePath = PLAYER_SPRITE_BY_CLASS[this.playerClass] ?? PLAYER_SPRITE_BY_CLASS.scholar;
    this.load.svg(PLAYER_TEX_KEY, resolveSpriteUrl(playerSpritePath), {
      width: PLAYER_SIZE,
      height: PLAYER_SIZE,
    });
  }

  create(): void {
    this.canvasW = this.cameras.main.width;
    this.canvasH = this.cameras.main.height;
    this.horizonY = Math.floor(this.canvasH * HORIZON_FRACTION);
    this.shoreY = Math.floor(this.canvasH * SHORE_FRACTION);
    this.playerY = Math.floor(this.canvasH * PLAYER_Y_FRACTION);
    this.playerX = Math.floor(this.canvasW * PLAYER_START_X_FRACTION);
    this.state = 'idle';
    this.powerValue = 0;

    this.cameras.main.setBackgroundColor(0x0a1220);

    this.renderSky();
    this.renderHorizon();
    this.renderWater();
    this.renderShore();
    this.placeTrees();
    this.createPlayer();
    this.createRod();
    this.createBobber();
    this.createFish();
    this.createBucket();
    this.lineGfx = this.add.graphics().setDepth(5);
    this.createUI();

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => this.handlePointerDown(pointer));
    this.input.on('pointerup', () => this.handlePointerUp());
    if (this.input.keyboard) {
      this.input.keyboard.on('keydown-ESC', () => this.returnToVillage());
      this.input.keyboard.removeCapture([Phaser.Input.Keyboard.KeyCodes.ESC]);
    }

    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.canvasW = gameSize.width;
      this.canvasH = gameSize.height;
      this.horizonY = Math.floor(this.canvasH * HORIZON_FRACTION);
      this.shoreY = Math.floor(this.canvasH * SHORE_FRACTION);
      this.playerY = Math.floor(this.canvasH * PLAYER_Y_FRACTION);
      this.relayout();
    });

    this.callbacks?.onReady();
  }

  update(_time: number, delta: number): void {
    // ── Player horizontal movement ──────────────────────────────────────────
    if (this.state === 'idle' || this.state === 'caught' || this.state === 'missed') {
      this.updatePlayerMovement(delta);
    }

    // ── Power meter fill ───────────────────────────────────────────────────
    if (this.state === 'powering') {
      this.powerValue = Math.min(1, this.powerValue + delta / POWER_BUILD_TIME_MS);
      this.updatePowerBar();
      return;
    }

    // ── Physics-based bobber flight (upward toward lake) ───────────────────
    if (this.state === 'casting') {
      if (this.bobberSprite) {
        const dt = delta / 1000;
        this.bobberSprite.x += this.bobberVX * dt;
        this.bobberSprite.y += this.bobberVY * dt;

        // Clamp within water area
        const margin = 20;
        if (this.bobberSprite.x < margin) { this.bobberSprite.x = margin; this.bobberVX = 0; }
        if (this.bobberSprite.x > this.canvasW - margin) { this.bobberSprite.x = this.canvasW - margin; this.bobberVX = 0; }

        // Bobber reaches its target Y (traveling upward) — snap and splash
        if (this.bobberSprite.y <= this.bobberTargetX) {
          this.bobberSprite.y = this.bobberTargetX;
          this.splashAt(this.bobberSprite.x, this.bobberSprite.y);
          this.startWaiting();
          return;
        }
      }
      this.updateLine();
      return;
    }

    // ── Line rendering while bobber is visible ─────────────────────────────
    if (this.state === 'waiting' || this.state === 'biting') {
      this.updateLine();
    }

    // ── Proximity-based bite check ─────────────────────────────────────────
    if (this.state === 'waiting' && this.fishSprite && this.fishSprite.visible && this.bobberSprite && this.bobberSprite.visible) {
      const dx = this.fishSprite.x - this.bobberSprite.x;
      const dy = (this.fishSprite.y + (this.fishSprite.displayHeight ?? 32) / 2) - this.bobberSprite.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= PROXIMITY_THRESHOLD) {
        this.triggerBite();
      }
    }

    // ── Max-timeout fallback for stuck state ───────────────────────────────
    if (this.state === 'waiting' && this.waitStartTime > 0) {
      const elapsed = this.time.now - this.waitStartTime;
      if (elapsed >= MAX_PROXIMITY_WAIT_MS) {
        this.missFish();
      }
    }

    // ── Line rendering during reeling ──────────────────────────────────────
    if (this.state === 'reeling') {
      this.updateLine();
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderSky(): void {
    const skyH = this.horizonY;
    if (skyH <= 0) return;
    this.skyGfx = this.add.graphics().setDepth(-1);
    const steps = 16;
    const topColor = { r: 0x06, g: 0x0c, b: 0x1e };
    const botColor = { r: 0x18, g: 0x28, b: 0x48 };
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const r = Math.round(topColor.r + (botColor.r - topColor.r) * t);
      const g = Math.round(topColor.g + (botColor.g - topColor.g) * t);
      const b = Math.round(topColor.b + (botColor.b - topColor.b) * t);
      this.skyGfx.fillStyle((r << 16) | (g << 8) | b, 1);
      this.skyGfx.fillRect(0, Math.floor(skyH * i / steps), this.canvasW, Math.ceil(skyH / steps) + 1);
    }
    this.starGfx = this.add.graphics().setDepth(0);
    for (let i = 0; i < 12; i++) {
      const sx = ((17 * (i + 5)) % Math.max(1, this.canvasW - 40)) + 20;
      const sy = 4 + ((11 * (i + 13)) % Math.max(1, skyH - 12));
      this.starGfx.fillStyle(0xffffff, 0.35 + ((i * 7) % 3) * 0.15);
      this.starGfx.fillRect(sx, sy, i % 4 === 0 ? 2 : 1, i % 4 === 0 ? 2 : 1);
    }
  }

  private renderHorizon(): void {
    const g = this.add.graphics().setDepth(1);
    // Tree silhouettes along the far shore
    g.fillStyle(0x0a1a0a, 0.9);
    for (let i = 0; i < 12; i++) {
      const tx = ((23 * i + 7) % (this.canvasW + 40)) - 20;
      const th = 18 + ((i * 13) % 14);
      const tw = 6 + (i % 4) * 2;
      g.fillRect(tx, this.horizonY - th, tw, th);
      // Simple triangle canopy
      g.fillStyle(0x0a1a0a, 0.7);
      g.fillTriangle(
        tx + tw / 2, this.horizonY - th - 10,
        tx - tw, this.horizonY - th + 4,
        tx + tw * 2, this.horizonY - th + 4,
      );
      g.fillStyle(0x0a1a0a, 0.9);
    }
  }

  private renderWater(): void {
    const waterTop = this.horizonY;
    const waterH = this.shoreY - waterTop;
    if (waterH <= 0) return;

    // Deep water base fill
    const deepG = this.add.graphics().setDepth(0);
    deepG.fillStyle(0x1a3050, 1);
    deepG.fillRect(0, waterTop, this.canvasW, waterH);

    const vTiles = Math.ceil(waterH / WATER_TILE_SIZE);
    for (let i = 0; i < vTiles; i++) {
      const tileTop = waterTop + i * WATER_TILE_SIZE;
      const tileH = Math.min(WATER_TILE_SIZE, this.shoreY - tileTop);
      if (tileH <= 0) break;
      const tile = this.add.tileSprite(
        0, tileTop,
        this.canvasW, tileH,
        TEX_WATER,
      ).setOrigin(0, 0).setDepth(3).setAlpha(0.35 + (1 - i / vTiles) * 0.25);
      this.waterTiles.push(tile);

      if (this.textures.exists(TEX_WATER)) {
        this.tweens.add({
          targets: tile,
          tilePositionX: { from: 0, to: 24 },
          duration: 2200 + i * 350,
          repeat: -1,
          yoyo: true,
          ease: 'Sine.easeInOut',
        });
      }
    }
  }

  private renderShore(): void {
    this.shoreGfx = this.add.graphics().setDepth(4);

    // Ground at bottom
    this.shoreGfx.fillStyle(SHORE_GREEN, 1);
    this.shoreGfx.fillRect(0, this.shoreY, this.canvasW, this.canvasH - this.shoreY);

    // Dirt strip at water edge
    this.shoreGfx.fillStyle(SHORE_DIRT, 1);
    this.shoreGfx.fillRect(0, this.shoreY - 4, this.canvasW, 8);

    // Grass tufts at water edge
    this.shoreGfx.fillStyle(0x1a3a0a, 0.5);
    for (let i = 0; i < 14; i++) {
      const gx = ((29 * i + 11) % this.canvasW);
      this.shoreGfx.fillRect(gx, this.shoreY - 8, 3, 10);
      this.shoreGfx.fillRect(gx - 2, this.shoreY - 4, 7, 2);
    }
  }

  private placeTrees(): void {
    if (!this.textures.exists(TEX_TREE)) return;
    // Tree bases sit on the shore. Origin is (0.5, 0.5) — Y is center.
    // tree 80px × 0.65 = 52px visible, half = 26
    // bush 48px × 0.6 = 29px visible, half = 14.5
    const tScale = 0.65;
    const bScale = 0.6;
    const tHalfH = 80 * tScale / 2; // 26
    const bHalfH = 48 * bScale / 2; // 14.4
    // Place so bottom of sprite = shoreY
    const treeY = this.shoreY - tHalfH;
    const bushY = this.shoreY - bHalfH;

    this.add.image(this.canvasW * 0.12, treeY, TEX_TREE).setDepth(7).setScale(tScale);
    this.add.image(this.canvasW * 0.42, treeY - 4, TEX_TREE).setDepth(7).setScale(tScale * 0.92);
    this.add.image(this.canvasW * 0.82, treeY + 2, TEX_TREE).setDepth(7).setScale(tScale * 0.88);

    if (this.textures.exists(TEX_BUSH)) {
      this.add.image(this.canvasW * 0.22, bushY, TEX_BUSH).setDepth(7).setScale(bScale);
      this.add.image(this.canvasW * 0.56, bushY + 1, TEX_BUSH).setDepth(7).setScale(bScale * 0.88);
      this.add.image(this.canvasW * 0.08, bushY + 2, TEX_BUSH).setDepth(7).setScale(bScale * 1.08);
      this.add.image(this.canvasW * 0.72, bushY - 1, TEX_BUSH).setDepth(7).setScale(bScale * 0.84);
    }
  }

  private createBucket(): void {
    const bx = this.getPlayerX() + 50;
    const by = this.shoreY - 28;

    this.bucketGfx = this.add.graphics().setDepth(8);
    // Bucket body (trapezoid)
    this.bucketGfx.fillStyle(0x6a4a2a, 1);
    this.bucketGfx.beginPath();
    this.bucketGfx.moveTo(bx - 14, by);
    this.bucketGfx.lineTo(bx + 14, by);
    this.bucketGfx.lineTo(bx + 10, by + 20);
    this.bucketGfx.lineTo(bx - 10, by + 20);
    this.bucketGfx.closePath();
    this.bucketGfx.fillPath();
    // Bucket rim
    this.bucketGfx.fillStyle(0x8a6a3a, 1);
    this.bucketGfx.fillRect(bx - 15, by - 3, 30, 5);
    // Bucket bands
    this.bucketGfx.fillStyle(0x5a3a1a, 1);
    this.bucketGfx.fillRect(bx - 13, by + 6, 26, 2);
    this.bucketGfx.fillRect(bx - 12, by + 12, 24, 2);
  }

  private addFishToBucket(fishTexKey: string): void {
    if (!this.textures.exists(fishTexKey)) return;
    const bx = this.getPlayerX() + 50;
    const by = this.shoreY - 30;
    // Stack fish sprites inside the bucket
    const idx = this.caughtCount;
    const fx = bx + ((idx % 3) - 1) * 6;
    const fy = by - 2 - Math.floor(idx / 3) * 8;
    const fish = this.add.image(fx, fy, fishTexKey)
      .setDepth(9)
      .setScale(0.4)
      .setAlpha(0.9);
    // Pop-in animation
    fish.setScale(0);
    this.tweens.add({
      targets: fish,
      scaleX: 0.4,
      scaleY: 0.4,
      duration: 250,
      ease: 'Back.easeOut',
    });
    this.bucketFishSprites.push(fish);
    this.caughtCount++;
  }

  private createPlayer(): void {
    if (!this.textures.exists(PLAYER_TEX_KEY)) return;
    const px = this.getPlayerX();
    const py = this.playerY;
    this.playerSprite = this.add.image(px, py, PLAYER_TEX_KEY).setDepth(10);

    // Player faces UP toward the lake (back to camera in first-person perspective)
    this.playerSprite.setAngle(0);

    const playerPath = PLAYER_SPRITE_BY_CLASS[this.playerClass] ?? PLAYER_SPRITE_BY_CLASS.scholar;
    const config = getAnimationConfig(playerPath);
    if (config.type !== 'none') {
      applySpriteAnimation(this, this.playerSprite, config);
    } else {
      this.tweens.add({
        targets: this.playerSprite,
        angle: { from: -0.3, to: 0.3 },
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  private createRod(): void {
    if (!this.textures.exists(TEX_ROD)) return;
    const px = this.getPlayerX() + 12;
    const py = this.playerY - 18;
    this.rodSprite = this.add.image(px, py, TEX_ROD)
      .setOrigin(0.5, 0.8)
      .setDepth(9);

    // Rod extends upward/forward toward the lake
    this.rodSprite.setAngle(-5);

    this.tweens.add({
      targets: this.rodSprite,
      angle: { from: -7, to: -3 },
      duration: 1800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private createBobber(): void {
    if (!this.textures.exists(TEX_BOBBER)) return;
    this.bobberSprite = this.add.image(0, 0, TEX_BOBBER)
      .setDepth(6)
      .setVisible(false);
  }

  private createFish(): void {
    this.fishSprite = this.add.image(0, 0, 'fish-moss-carp')
      .setDepth(2.5)
      .setVisible(false)
      .setAlpha(0.85);
  }

  private createUI(): void {
    // Hint text
    this.hintText = this.add.text(this.canvasW / 2, this.canvasH - 40, '', {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: '14px',
      color: '#cfe1ff',
      backgroundColor: '#1a2a1acc',
      padding: { left: 12, right: 12, top: 6, bottom: 6 },
    }).setOrigin(0.5, 0.5).setDepth(20).setScrollFactor(0);
    this.updateHint('Hold click on the lake to build power, release to cast');

    // Return button
    this.returnBtn = this.add.text(12, 12, '← Return to Village', {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: '13px',
      color: '#f2e2c4',
      backgroundColor: '#1a2a1abb',
      padding: { left: 10, right: 10, top: 6, bottom: 6 },
    }).setOrigin(0, 0).setDepth(20).setScrollFactor(0).setInteractive({ useHandCursor: true });
    this.returnBtn.on('pointerdown', () => this.returnToVillage());
    this.returnBtn.on('pointerover', () => this.returnBtn?.setColor('#ffffff'));
    this.returnBtn.on('pointerout', () => this.returnBtn?.setColor('#f2e2c4'));

    // Catch text
    // (removed — handled by React overlay via onFishCaught callback)
  }

  // ── Layout helpers ───────────────────────────────────────────────────────

  private getPlayerX(): number {
    return this.playerX;
  }

  private updatePlayerMovement(delta: number): void {
    if (!this.input.keyboard) return;
    let dx = 0;
    const kb = this.input.keyboard;
    if (kb.checkDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.A))) dx -= 1;
    if (kb.checkDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT))) dx -= 1;
    if (kb.checkDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.D))) dx += 1;
    if (kb.checkDown(kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT))) dx += 1;

    if (dx !== 0) {
      this.playerX = Phaser.Math.Clamp(
        this.playerX + dx * PLAYER_MOVE_SPEED * (delta / 1000),
        PLAYER_EDGE_MARGIN,
        this.canvasW - PLAYER_EDGE_MARGIN,
      );

      if (this.playerSprite) this.playerSprite.x = this.playerX;
      if (this.rodSprite) this.rodSprite.x = this.playerX + 12;
      this.redrawBucket();

      for (let i = 0; i < this.bucketFishSprites.length; i++) {
        const fish = this.bucketFishSprites[i];
        if (fish && fish.active) {
          fish.x = this.playerX + 50 + ((i % 3) - 1) * 6;
        }
      }
    }
  }

  private redrawBucket(): void {
    if (this.bucketGfx) { this.bucketGfx.destroy(); this.bucketGfx = null; }
    const bx = this.playerX + 50;
    const by = this.shoreY - 28;

    this.bucketGfx = this.add.graphics().setDepth(8);
    this.bucketGfx.fillStyle(0x6a4a2a, 1);
    this.bucketGfx.beginPath();
    this.bucketGfx.moveTo(bx - 14, by);
    this.bucketGfx.lineTo(bx + 14, by);
    this.bucketGfx.lineTo(bx + 10, by + 20);
    this.bucketGfx.lineTo(bx - 10, by + 20);
    this.bucketGfx.closePath();
    this.bucketGfx.fillPath();
    this.bucketGfx.fillStyle(0x8a6a3a, 1);
    this.bucketGfx.fillRect(bx - 15, by - 3, 30, 5);
    this.bucketGfx.fillStyle(0x5a3a1a, 1);
    this.bucketGfx.fillRect(bx - 13, by + 6, 26, 2);
    this.bucketGfx.fillRect(bx - 12, by + 12, 24, 2);
  }

  private getRodTip(): { x: number; y: number } {
    if (!this.rodSprite) {
      return {
        x: this.getPlayerX() + 12,
        y: this.playerY - 70,
      };
    }
    // Rod SVG 16×120, origin at (0.5, 0.8) = tip at local (0, -120*0.8) = (0, -96)
    const tipLocalX = 0;
    const tipLocalY = -96;
    const cos = Math.cos(Phaser.Math.DegToRad(this.rodSprite.angle));
    const sin = Math.sin(Phaser.Math.DegToRad(this.rodSprite.angle));
    return {
      x: this.rodSprite.x + tipLocalX * cos - tipLocalY * sin,
      y: this.rodSprite.y + tipLocalX * sin + tipLocalY * cos,
    };
  }

  private updateLine(): void {
    if (!this.lineGfx || !this.bobberSprite || !this.bobberSprite.visible) {
      if (this.lineGfx) this.lineGfx.clear();
      return;
    }
    const tip = this.getRodTip();
    const bx = this.bobberSprite.x;
    const by = this.bobberSprite.y;

    // Slight curve for line going forward into water
    const cpx = (tip.x + bx) / 2 + 8;
    const cpy = (tip.y + by) / 2;

    this.lineGfx.clear();
    this.lineGfx.lineStyle(1.5, 0xcccccc, 0.6);
    this.lineGfx.beginPath();
    this.lineGfx.moveTo(tip.x, tip.y);
    const segments = 12;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const t1 = 1 - t;
      const x = t1 * t1 * tip.x + 2 * t1 * t * cpx + t * t * bx;
      const y = t1 * t1 * tip.y + 2 * t1 * t * cpy + t * t * by;
      this.lineGfx.lineTo(x, y);
    }
    this.lineGfx.strokePath();
  }

  private relayout(): void {
    if (this.skyGfx) { this.skyGfx.destroy(); this.skyGfx = null; }
    if (this.starGfx) { this.starGfx.destroy(); this.starGfx = null; }
    if (this.shoreGfx) { this.shoreGfx.destroy(); this.shoreGfx = null; }
    for (const tile of this.waterTiles) { if (tile && tile.active) tile.destroy(); }
    this.waterTiles = [];

    for (const child of this.children.list) {
      if (child instanceof Phaser.GameObjects.Graphics && child !== this.lineGfx && child !== this.powerBarGfx && child !== this.powerBarBg) {
        child.destroy();
      }
    }

    this.renderSky();
    this.renderHorizon();
    this.renderWater();
    this.renderShore();
    this.placeTrees();

    const px = this.getPlayerX();
    if (this.playerSprite) this.playerSprite.setPosition(px, this.playerY);
    if (this.rodSprite) this.rodSprite.setPosition(px + 12, this.playerY - 18);

    this.createBucket();

    if (this.hintText) this.hintText.setPosition(this.canvasW / 2, this.canvasH - 40);

    if (this.powerBarBg) this.powerBarBg.destroy();
    if (this.powerBarGfx) this.powerBarGfx.destroy();
    if (this.powerBarText) this.powerBarText.destroy();
    this.powerBarBg = null;
    this.powerBarGfx = null;
    this.powerBarText = null;
    if (this.state === 'powering') this.createPowerBar();
  }

  private updateHint(text: string): void {
    if (this.hintText) this.hintText.setText(text);
  }

  // ── Power meter ─────────────────────────────────────────────────────────

  private createPowerBar(): void {
    const barW = 320;
    const barH = 24;
    const barX = (this.canvasW - barW) / 2;
    const barY = this.canvasH - 80;

    // Background (dark)
    this.powerBarBg = this.add.graphics().setDepth(25).setScrollFactor(0);
    this.powerBarBg.fillStyle(0x111122, 0.85);
    this.powerBarBg.fillRoundedRect(barX - 2, barY - 2, barW + 4, barH + 4, 6);
    this.powerBarBg.lineStyle(1.5, 0x556688, 0.6);
    this.powerBarBg.strokeRoundedRect(barX - 2, barY - 2, barW + 4, barH + 4, 6);

    // Fill (drawn fresh each frame)
    this.powerBarGfx = this.add.graphics().setDepth(26).setScrollFactor(0);

    // Label
    this.powerBarText = this.add.text(this.canvasW / 2, barY + barH / 2, 'Power', {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: '12px',
      color: '#dddddd',
      fontStyle: 'bold',
    }).setOrigin(0.5, 0.5).setDepth(27).setScrollFactor(0);
  }

  private updatePowerBar(): void {
    if (!this.powerBarBg || !this.powerBarGfx || !this.powerBarText) {
      this.createPowerBar();
    }
    if (!this.powerBarBg || !this.powerBarGfx || !this.powerBarText) return;

    const barW = 320;
    const barH = 24;
    const barX = (this.canvasW - barW) / 2;
    const barY = this.canvasH - 80;

    // Interpolate color: green (low) → yellow (mid) → red (high)
    const t = this.powerValue;
    let color: number;
    if (t < 0.5) {
      // green → yellow
      const r = Math.round(0x00 + (0xff - 0x00) * (t * 2));
      const g = 0xff;
      const b = 0x00;
      color = (r << 16) | (g << 8) | b;
    } else {
      // yellow → red
      const r = 0xff;
      const g = Math.round(0xff - (0xff - 0x40) * ((t - 0.5) * 2));
      const b = 0x00;
      color = (r << 16) | (g << 8) | b;
    }

    this.powerBarGfx.clear();
    this.powerBarGfx.fillStyle(color, 0.9);
    this.powerBarGfx.fillRoundedRect(barX, barY, barW * this.powerValue, barH, 4);

    // Build power text: filled blocks + empty blocks
    const totalBlocks = 10;
    const filledBlocks = Math.round(this.powerValue * totalBlocks);
    const powerLabel = `Power: ${'█'.repeat(filledBlocks)}${'░'.repeat(totalBlocks - filledBlocks)}`;
    this.powerBarText.setText(powerLabel);
  }

  private destroyPowerBar(): void {
    if (this.powerBarGfx) { this.powerBarGfx.destroy(); this.powerBarGfx = null; }
    if (this.powerBarBg) { this.powerBarBg.destroy(); this.powerBarBg = null; }
    if (this.powerBarText) { this.powerBarText.destroy(); this.powerBarText = null; }
  }

  // ── Input handling ───────────────────────────────────────────────────────

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (pointer.y < 36 && pointer.x < 180) return;
    // Cast anywhere in the water area (above shore)
    if (pointer.y > this.shoreY - 20) return;

    switch (this.state) {
      case 'idle':
        this.startPowering();
        break;
      case 'biting':
        if (this.biteWindowActive) this.setHook();
        break;
      case 'caught':
      case 'missed':
        this.resetToIdle();
        break;
    }
  }

  private handlePointerUp(): void {
    if (this.state === 'powering') {
      this.castLine(this.powerValue);
    }
  }

  // ── Fishing mechanics ────────────────────────────────────────────────────

  private startPowering(): void {
    this.state = 'powering';
    this.powerValue = 0;
    this.updateHint('Hold...');

    // Show bobber at rod tip so player sees where it'll go
    const tip = this.getRodTip();
    if (this.bobberSprite) {
      this.bobberSprite.setPosition(tip.x, tip.y);
      this.bobberSprite.setVisible(true);
      this.bobberSprite.setAlpha(0.5);
      // Start gentle bob at tip
      this.tweens.killTweensOf(this.bobberSprite);
    }

    this.createPowerBar();
  }

  private castLine(powerValue: number): void {
    if (this.state !== 'powering') return;
    this.state = 'casting';
    this.updateHint('Casting...');
    this.destroyPowerBar();

    const tip = this.getRodTip();
    if (!this.bobberSprite) return;

    this.tweens.killTweensOf(this.bobberSprite);
    this.bobberSprite.setPosition(tip.x, tip.y);
    this.bobberSprite.setVisible(true);
    this.bobberSprite.setAlpha(1);

    const p = Math.max(0.12, powerValue);

    // Launch upward: slight horizontal spread, strong upward velocity
    const spreadAngle = (Math.random() - 0.5) * 0.3; // slight random left/right
    this.bobberVX = p * CAST_SPEED * Math.sin(spreadAngle);
    this.bobberVY = -p * CAST_SPEED * Math.cos(spreadAngle); // negative = upward

    // Target Y for bobber landing: further = higher on screen (closer to horizon)
    this.bobberTargetX = this.shoreY - p * (this.shoreY - this.horizonY - HORIZON_MARGIN * 2);
  }

  private startWaiting(): void {
    this.state = 'waiting';
    this.biteWindowActive = false;
    this.waitStartTime = this.time.now;

    // Determine what fish will bite
    const { entry } = rollFishRarity();
    this.currentFish = entry;

    // Pick a random fish direction
    this.fishDirection = this.rollFishDirection();

    // Start bobber bobbing animation
    if (this.bobberSprite) {
      this.tweens.add({
        targets: this.bobberSprite,
        y: { from: this.bobberSprite.y, to: this.bobberSprite.y + BOBBER_BOB_AMOUNT },
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Show fish silhouette swimming toward the bobber
    this.startFishSwim();

    this.updateHint('Waiting for a bite...');
  }

  /**
   * Roll a random {@link FishDirection} using equal weights.
   */
  private rollFishDirection(): FishDirection {
    const total = Object.values(FISH_DIRECTION_WEIGHTS).reduce((a, b) => a + b, 0);
    const roll = Math.random() * total;
    let cumulative = 0;
    for (const [dir, weight] of Object.entries(FISH_DIRECTION_WEIGHTS)) {
      cumulative += weight;
      if (roll <= cumulative) return dir as FishDirection;
    }
    return 'right';
  }

  private startFishSwim(): void {
    if (!this.fishSprite) return;

    // Switch to correct fish texture
    const fishTexKey = this.currentFish ? `fish-${this.currentFish.id}` : 'fish-moss-carp';
    if (this.textures.exists(fishTexKey)) {
      this.fishSprite.setTexture(fishTexKey);
    }

    // Reset any transforms from previous fish
    this.fishSprite.setAngle(0);
    this.fishSprite.setFlipX(false);
    this.fishSprite.setFlipY(false);

    const targetX = this.bobberSprite ? this.bobberSprite.x : this.canvasW / 2;
    const targetY = this.bobberSprite
      ? Math.min(this.bobberSprite.y + 24, this.shoreY - 10)
      : this.shoreY * 0.5;

    let startX: number;
    let startY: number;
    let duration: number;

    switch (this.fishDirection) {
      case 'right': {
        startX = this.canvasW + 40;
        startY = targetY;
        this.fishSprite.setFlipX(false);
        const dist = startX - targetX;
        duration = (dist / FISH_SWIM_SPEED) * 1000;
        break;
      }
      case 'bottom': {
        startX = targetX + (Math.random() * 160 - 80);
        startY = this.canvasH + 40;
        this.fishSprite.setAngle(-90);
        const vertDist = this.canvasH + 40 - targetY;
        duration = (vertDist / FISH_SWIM_SPEED) * 1000;
        break;
      }
      default: {
        startX = this.canvasW + 40;
        startY = targetY;
        this.fishSprite.setFlipX(false);
        const dist = startX - targetX;
        duration = (dist / FISH_SWIM_SPEED) * 1000;
      }
    }

    this.fishSprite.setPosition(startX, startY);
    this.fishSprite.setVisible(true);
    this.fishSprite.setAlpha(0.7);

    // Swim toward the bobber
    this.tweens.add({
      targets: this.fishSprite,
      x: targetX,
      y: targetY,
      duration,
      ease: 'Linear',
    });
  }

  private triggerBite(): void {
    if (this.state !== 'waiting') return;
    this.state = 'biting';
    this.biteWindowActive = true;

    // Splash effect on bobber
    if (this.bobberSprite) {
      this.tweens.killTweensOf(this.bobberSprite);

      const origY = this.bobberSprite.y;
      this.tweens.add({
        targets: this.bobberSprite,
        y: origY + 10,
        duration: 120,
        yoyo: true,
        ease: 'Bounce.easeOut',
        onComplete: () => {
          if (this.bobberSprite) {
            this.bobberSprite.y = origY;
          }
        },
      });

      this.tweens.add({
        targets: this.bobberSprite,
        scaleX: { from: 1, to: 1.3 },
        scaleY: { from: 1, to: 1.3 },
        duration: 300,
        yoyo: true,
        repeat: 2,
        ease: 'Sine.easeInOut',
      });
    }

    this.updateHint('⚡ BITE! Click to reel in!');

    this.biteWindowTimer = this.time.delayedCall(BITE_WINDOW_SEC * 1000, () => {
      if (this.state === 'biting') {
        this.missFish();
      }
    });
  }

  private setHook(): void {
    if (this.state !== 'biting' || !this.biteWindowActive) return;
    this.biteWindowActive = false;
    this.state = 'reeling';

    if (this.biteWindowTimer) {
      this.biteWindowTimer.remove();
      this.biteWindowTimer = null;
    }

    this.updateHint('Reeling in...');

    if (this.bobberSprite) {
      this.tweens.killTweensOf(this.bobberSprite);
    }

    if (this.bobberSprite && this.fishSprite) {
      const tip = this.getRodTip();

      this.tweens.add({
        targets: this.bobberSprite,
        x: tip.x,
        y: tip.y,
        duration: REEL_DURATION_MS,
        ease: 'Sine.easeIn',
        onUpdate: () => this.updateLine(),
      });

      this.tweens.add({
        targets: this.fishSprite,
        x: tip.x,
        y: tip.y,
        duration: REEL_DURATION_MS,
        ease: 'Sine.easeIn',
        onComplete: () => {
          this.catchFish();
        },
      });
    } else {
      this.catchFish();
    }
  }

  private catchFish(): void {
    this.state = 'caught';

    if (this.bobberSprite) this.bobberSprite.setVisible(false);
    if (this.lineGfx) this.lineGfx.clear();

    const fish = this.currentFish;
    const fishTexKey = fish ? `fish-${fish.id}` : 'fish-moss-carp';

    if (this.fishSprite) {
      this.fishSprite.setAngle(0);
      this.fishSprite.setFlipX(false);
      this.fishSprite.setFlipY(false);

      const tip = this.getRodTip();
      this.fishSprite.setPosition(tip.x, tip.y - 20);
      this.fishSprite.setVisible(true);
      this.fishSprite.setAlpha(1);
      this.fishSprite.setScale(1.3);

      this.tweens.add({
        targets: this.fishSprite,
        y: { from: tip.y - 20, to: tip.y - 30 },
        duration: 600,
        yoyo: true,
        repeat: 1,
        ease: 'Sine.easeInOut',
        onComplete: () => {
          if (this.fishSprite) this.fishSprite.setVisible(false);
        },
      });
    }

    // Add to bucket
    if (fish) {
      this.addFishToBucket(fishTexKey);
    }

    this.updateHint('Fish caught! Click to cast again');

    if (fish) {
      this.callbacks?.onFishCaught?.({
        fishName: fish.name,
        rarity: fish.rarity,
        catalogId: fish.id,
        description: fish.description,
      });
    }
  }

  private missFish(): void {
    this.state = 'missed';
    this.biteWindowActive = false;

    this.updateHint('The fish got away... Click to cast again');

    if (this.bobberSprite) {
      this.tweens.killTweensOf(this.bobberSprite);
    }

    // Fish swims away in its original entry direction
    if (this.fishSprite) {
      this.tweens.killTweensOf(this.fishSprite);

      let fleeX: number;
      let fleeY: number;

      switch (this.fishDirection) {
        case 'right':
          // Swims back right
          fleeX = this.canvasW + 60;
          fleeY = this.fishSprite.y;
          break;
        case 'bottom':
          fleeX = this.fishSprite.x;
          fleeY = this.canvasH + 60;
          break;
        default:
          fleeX = this.canvasW + 60;
          fleeY = this.fishSprite.y;
      }

      this.tweens.add({
        targets: this.fishSprite,
        x: fleeX,
        y: fleeY,
        duration: MISS_DURATION_MS,
        ease: 'Sine.easeIn',
        onComplete: () => {
          if (this.fishSprite) this.fishSprite.setVisible(false);
        },
      });
    }

    if (this.bobberSprite) {
      this.bobberSprite.setVisible(true);
    }

    this.time.delayedCall(400, () => {
      if (this.lineGfx) this.lineGfx.clear();
    });
  }

  private resetToIdle(): void {
    // Cancel the proximity max timeout
    this.waitStartTime = 0;

    if (this.biteWindowTimer) { this.biteWindowTimer.remove(); this.biteWindowTimer = null; }
    this.biteWindowActive = false;

    this.destroyPowerBar();
    this.powerValue = 0;

    if (this.bobberSprite) {
      this.tweens.killTweensOf(this.bobberSprite);
      this.bobberSprite.setVisible(false);
      this.bobberSprite.setScale(1);
    }
    if (this.fishSprite) {
      this.tweens.killTweensOf(this.fishSprite);
      this.fishSprite.setVisible(false);
      this.fishSprite.setScale(1);
      this.fishSprite.setAngle(0);
      this.fishSprite.setFlipX(false);
      this.fishSprite.setFlipY(false);
    }
    if (this.lineGfx) this.lineGfx.clear();

    this.state = 'idle';
    this.currentFish = null;
    this.bobberVX = 0;
    this.bobberVY = 0;
    this.updateHint('Hold click on the lake to build power, release to cast');
  }

  private splashAt(x: number, y: number): void {
    // Ripple rings expanding outward
    for (let i = 0; i < 3; i++) {
      const ring = this.add.circle(x, y, 6, 0x8899aa, 0).setDepth(15).setStrokeStyle(1.5, 0xaabbcc, 0.7);
      this.tweens.add({
        targets: ring,
        radius: { from: 6, to: 30 + i * 10 },
        alpha: { from: 0.7, to: 0 },
        duration: 400 + i * 120,
        delay: i * 80,
        onUpdate: () => ring.setStrokeStyle(1.5, 0xaabbcc, ring.alpha),
        onComplete: () => ring.destroy(),
      });
    }

    // Water droplets flying up
    for (let i = 0; i < 5; i++) {
      const dx = (Math.random() - 0.5) * 40;
      const dy = -(15 + Math.random() * 20);
      const drop = this.add.circle(x, y, 2, 0x8899cc, 0.8).setDepth(16);
      this.tweens.add({
        targets: drop,
        x: x + dx,
        y: y + dy,
        alpha: { from: 0.8, to: 0 },
        duration: 350 + Math.random() * 200,
        onComplete: () => drop.destroy(),
      });
    }
  }

  // ── Exit ─────────────────────────────────────────────────────────────────

  private returnToVillage(): void {
    if (this.biteWindowTimer) this.biteWindowTimer.remove();
    this.callbacks?.onReturnToVillage();
  }
}
