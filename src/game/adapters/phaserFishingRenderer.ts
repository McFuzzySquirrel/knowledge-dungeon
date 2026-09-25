/**
 * Phaser adapter for the fishing world.
 *
 * The fishing world shares the village's Phaser game and canvas: entering it
 * sleeps `VillageScene` and starts `FishingScene` in the same `Phaser.Game`,
 * which is why this adapter is a facade over a game handle rather than its own
 * `Phaser.Game`.
 *
 * Phaser-specific detail that stays in this file: the scene keys, the
 * `scene.sleep()` / `scene.start()` / `scene.stop()` / `scene.wake()` calls,
 * the scene's start payload shape, and the deferred (0 ms) teardown that
 * matches the previous screen behaviour exactly.
 */
import type Phaser from 'phaser';
import type { FishingScene, FishingSceneEvents } from '@/game/scenes/FishingScene';
import type { FishingRendererCapabilities } from '@/application/contracts/renderer';
import type { WorldEventPayload } from '@/application/contracts/events';
import type { FishingWorldModel, PlayerClassId } from '@/application/contracts/world';

/** Phaser scene keys the fishing world swaps with. */
const VILLAGE_SCENE_KEY = 'VillageScene';
const FISHING_SCENE_KEY = 'FishingScene';

/**
 * Callbacks the fishing world reports through, expressed as the neutral event
 * payloads. The neutral `fishing/enter` command payload is projected onto this
 * shape at the adapter edge.
 */
export interface PhaserFishingHandlers {
  onFishCaught(payload: WorldEventPayload<'fishing:fish-caught'>): void;
  onReturnToVillage(): void;
  onReady(): void;
}

/**
 * The fishing world renderer as the application layer sees it: the neutral
 * `FishingRendererCapabilities` port plus the world-start operation the
 * neutral `fishing/enter` command maps onto.
 */
export interface PhaserFishingRenderer extends FishingRendererCapabilities {
  /**
   * Start the fishing world for `model`, reporting through `handlers`.
   *
   * No-ops while the owning world host is not mounted, so the renderer and the
   * application layer enforce the same mount guard independently.
   */
  enter(model: FishingWorldModel, handlers: PhaserFishingHandlers): void;
}

/** Factory input: a live game handle, or `null` once the host unmounted. */
export interface PhaserFishingRendererHost {
  /** The Phaser game the village mounted, or `null` while unmounted. */
  game(): Phaser.Game | null;
}

/**
 * Build the Phaser-backed fishing renderer for a mounted village game.
 */
export function createPhaserFishingRenderer(
  host: PhaserFishingRendererHost,
): PhaserFishingRenderer {
  let overridePlayerClass: PlayerClassId | null = null;

  return {
    enter(model, handlers): void {
      const game = host.game();
      if (!game) return;
      const playerClass = model.playerClass ?? overridePlayerClass;
      const sceneCallbacks: FishingSceneEvents = {
        onFishCaught: (payload) => handlers.onFishCaught(payload),
        onReturnToVillage: () => handlers.onReturnToVillage(),
        onReady: () => handlers.onReady(),
      };
      game.scene.getScene(VILLAGE_SCENE_KEY)?.scene.sleep();
      game.scene.start(FISHING_SCENE_KEY, {
        callbacks: sceneCallbacks,
        playerClass: playerClass ?? 'scholar',
        hasClearedRooms: model.hasClearedRooms,
      });
    },

    /**
     * Set the study archetype used for the angler sprite.
     *
     * `FishingScene` loads its directional player textures in `preload`, so a
     * mid-session change would need a texture reload this phase does not
     * perform. The value is held and applied to the next `enter`, which is the
     * only point at which the current scene reads the archetype.
     */
    setPlayerClass(playerClass): void {
      overridePlayerClass = playerClass;
    },

    getCaughtCount(): number {
      const game = host.game();
      const scene = game?.scene.getScene(FISHING_SCENE_KEY) as FishingScene | null;
      return scene?.getCaughtCount() ?? 0;
    },

    returnToVillage(): void {
      // Deferred by one task, exactly as the previous screen did, so the
      // stop/wake pair still runs after the current interaction completes.
      setTimeout(() => {
        const game = host.game();
        if (!game) return;
        game.scene.stop(FISHING_SCENE_KEY);
        game.scene.getScene(VILLAGE_SCENE_KEY)?.scene.wake();
      }, 0);
    },
  };
}
