/**
 * Phaser adapter for the village world.
 *
 * This module is the only place where the village world model, the
 * renderer-neutral renderer contract, and the Phaser engine meet. Everything
 * Phaser-specific lives here, in `phaserFishingRenderer.ts`, and in
 * `src/game/scenes`:
 *
 * - `Phaser.Game` construction, scale/physics options, and the canvas parent
 * - the `game.events.once('ready')` readiness handshake
 * - `game.scene.getScene('VillageScene')` scene lookup and its cast
 * - `scene.scene.restart()` for the custom-sprite rebuild
 * - `game.destroy(true)` teardown
 * - the custom-sprite blob-URL revocation that has to happen before a restart
 * - ownership of the fishing sub-renderer, which shares this game and canvas
 *
 * The returned object is described entirely by renderer-neutral types, so the
 * React screen never names Phaser. Replacing Phaser means replacing this
 * directory (and the two `createGame*` seams that construct it) and nothing
 * else.
 */
import Phaser from 'phaser';
import { VillageScene, type VillageSceneEvents } from '@/game/scenes/VillageScene';
import { FishingScene } from '@/game/scenes/FishingScene';
import {
  createPhaserFishingRenderer,
  type PhaserFishingRenderer,
} from '@/game/adapters/phaserFishingRenderer';
import type { VillageRendererCapabilities, WorldRenderer } from '@/application/contracts/renderer';
import type { VillageWorldModel } from '@/application/contracts/world';
import type { VillageStructure } from '@/data/villageLayout';

/** Phaser scene key the village world runs in. */
const VILLAGE_SCENE_KEY = 'VillageScene';

/** Canvas clear color behind the village. */
const VILLAGE_BACKGROUND = '#1a2a1a';

/**
 * Callbacks the village world reports through. Re-exported from the scene so
 * hosts can type the object without importing a Phaser module: the type is
 * derived from the renderer-neutral event contract, not from Phaser.
 */
export type { VillageSceneEvents };

/** One-time world spawn override, restored by the village scene. */
export interface VillageSpawnPoint {
  gridX: number | null;
  gridY: number | null;
}

/** Everything the village adapter needs to present one village world. */
export interface PhaserVillageRendererOptions {
  /** Element the canvas is appended to. */
  parent: HTMLElement;
  /** Renderer-neutral model of the village to present. */
  world: VillageWorldModel;
  /** Contract-derived callbacks the scene reports through. */
  callbacks: VillageSceneEvents;
  /** One-time spawn grid override, or `null` for the map default. */
  spawn?: VillageSpawnPoint;
}

/**
 * The village world renderer as the application layer sees it: the neutral
 * `WorldRenderer` lifecycle, the neutral `VillageRendererCapabilities` port,
 * one renderer-neutral readiness subscription, and the fishing world renderer
 * that shares this host's canvas.
 */
export interface PhaserVillageRenderer extends WorldRenderer, VillageRendererCapabilities {
  /**
   * Subscribe to the first-frame notification. Returns an unsubscribe
   * function; listeners added after readiness are not replayed.
   */
  onReady(listener: () => void): () => void;
  /**
   * The fishing world renderer bound to this host's game. The fishing world
   * has no canvas of its own: it swaps the running scene, so the village host
   * owns the object that starts and stops it.
   */
  fishing(): PhaserFishingRenderer;
}

/**
 * Build the Phaser-backed village renderer.
 *
 * The returned renderer is inert until {@link PhaserVillageRenderer.mount} is
 * called, so a host can subscribe to readiness first and then start the world.
 */
export function createPhaserVillageRenderer(
  options: PhaserVillageRendererOptions,
): PhaserVillageRenderer {
  const { parent, world, callbacks } = options;
  const spawn = options.spawn ?? { gridX: null, gridY: null };

  let game: Phaser.Game | null = null;
  let scene: VillageScene | null = null;
  let ready = false;
  let readyListeners: (() => void)[] = [];

  const fishing = createPhaserFishingRenderer({ game: () => game });

  function notifyReady(): void {
    const listeners = readyListeners;
    readyListeners = [];
    for (const listener of listeners) listener();
  }

  return {
    mount(): void {
      if (game) return;
      const created = new Phaser.Game({
        type: Phaser.AUTO,
        parent,
        backgroundColor: VILLAGE_BACKGROUND,
        scale: {
          mode: Phaser.Scale.RESIZE,
          autoCenter: Phaser.Scale.CENTER_BOTH,
          width: '100%',
          height: '100%',
        },
        physics: {
          default: 'arcade',
          arcade: { gravity: { x: 0, y: 0 }, debug: false },
        },
        scene: [VillageScene, FishingScene],
      });
      game = created;

      created.scene.start(VILLAGE_SCENE_KEY, {
        callbacks,
        // An empty list is equivalent to omitting the key: the scene only
        // merges dynamic structures when it receives a non-empty array.
        dynamicStructures: world.structures,
        playerClass: world.playerClass ?? 'scholar',
        spawnGridX: spawn.gridX,
        spawnGridY: spawn.gridY,
      });

      created.events.once('ready', () => {
        scene = created.scene.getScene(VILLAGE_SCENE_KEY) as VillageScene;
        ready = true;
        notifyReady();
      });
    },

    unmount(): void {
      const current = game;
      game = null;
      scene = null;
      ready = false;
      readyListeners = [];
      current?.destroy(true);
    },

    isReady(): boolean {
      return ready;
    },

    restart(): void {
      const current = game;
      if (!current) return;
      // Revoke old blob URLs before restarting so the engine reloads fresh SVGs.
      import('@/services/customSprites').then(({ revokeAllBlobUrls }) => revokeAllBlobUrls());
      const active = current.scene.getScene(VILLAGE_SCENE_KEY);
      if (active) active.scene.restart();
      scene = current.scene.getScene(VILLAGE_SCENE_KEY) as VillageScene;
    },

    onReady(listener: () => void): () => void {
      readyListeners.push(listener);
      return () => {
        readyListeners = readyListeners.filter((entry) => entry !== listener);
      };
    },

    setDynamicStructures(structures: readonly VillageStructure[]): void {
      scene?.setDynamicStructures([...structures]);
    },

    setPlayerClass(playerClass): void {
      scene?.setPlayerClass(playerClass ?? 'scholar');
    },

    triggerInteract(): void {
      scene?.triggerInteract();
    },

    readPoi() {
      const poi = scene?.lastPoi;
      if (!poi || poi.distance >= 1e9) return null;
      return { name: poi.name, angle: poi.angle, distance: poi.distance };
    },

    fishing(): PhaserFishingRenderer {
      return fishing;
    },
  };
}
