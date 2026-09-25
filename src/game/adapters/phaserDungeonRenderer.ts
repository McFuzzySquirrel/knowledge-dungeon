/**
 * Phaser adapter for the dungeon world.
 *
 * This module is the only place where the dungeon world model, the
 * renderer-neutral renderer contract, and the Phaser engine meet. Everything
 * Phaser-specific lives here and in `src/game/scenes`:
 *
 * - `Phaser.Game` construction, scale/physics options, and the canvas parent
 * - the `game.events.once('ready')` readiness handshake
 * - `game.scene.getScene('DungeonScene')` scene lookup and its cast
 * - `scene.scene.restart()` for the custom-sprite rebuild
 * - `game.destroy(true)` teardown
 * - the custom-sprite blob-URL revocation that has to happen before a restart
 *
 * The returned object is described entirely by renderer-neutral types, so the
 * React screens never name Phaser. Replacing Phaser means replacing this file
 * (and the two `createGame*` seams that construct it) and nothing else.
 */
import Phaser from 'phaser';
import { DungeonScene, type DungeonSceneEvents } from '@/game/scenes/DungeonScene';
import type { ColorTheme } from '@/store/preferencesStore';
import type { DungeonRendererCapabilities, WorldRenderer } from '@/application/contracts/renderer';
import type { DungeonWorldModel } from '@/application/contracts/world';

/** Phaser scene key the dungeon world runs in. */
const DUNGEON_SCENE_KEY = 'DungeonScene';

/** Canvas clear color per UI theme, so the first frame matches the DOM shell. */
const GAME_BACKGROUND_BY_THEME: Record<ColorTheme, string> = {
  dark: '#101a30',
  colorful: '#111b33',
  aurora: '#101a30',
};

/**
 * Callbacks the dungeon world reports through. Re-exported from the scene so
 * hosts can type the object without importing a Phaser module: the type is
 * derived from the renderer-neutral event contract, not from Phaser.
 */
export type { DungeonSceneEvents };

/** Everything the dungeon adapter needs to present one dungeon world. */
export interface PhaserDungeonRendererOptions {
  /** Element the canvas is appended to. */
  parent: HTMLElement;
  /** Renderer-neutral model of the dungeon to present. */
  world: DungeonWorldModel;
  /** Contract-derived callbacks the scene reports through. */
  callbacks: DungeonSceneEvents;
  colorTheme?: ColorTheme;
}

/**
 * The dungeon world renderer as the application layer sees it: the neutral
 * `WorldRenderer` lifecycle, the neutral `DungeonRendererCapabilities` port,
 * and one renderer-neutral readiness subscription.
 *
 * The extra `onReady` member is the host-side counterpart of the contract's
 * "first frame" rule: `WorldRenderer.isReady()` is a poll, while `onReady`
 * lets a React screen flip its own state without polling.
 */
export interface PhaserDungeonRenderer extends WorldRenderer, DungeonRendererCapabilities {
  /**
   * Subscribe to the first-frame notification. Returns an unsubscribe
   * function; listeners added after readiness are not replayed.
   */
  onReady(listener: () => void): () => void;
}

/**
 * Build the Phaser-backed dungeon renderer.
 *
 * The returned renderer is inert until {@link PhaserDungeonRenderer.mount} is
 * called, so a host can subscribe to readiness first and then start the world.
 */
export function createPhaserDungeonRenderer(
  options: PhaserDungeonRendererOptions,
): PhaserDungeonRenderer {
  const { parent, world, callbacks } = options;
  const theme = options.colorTheme ?? 'dark';

  let game: Phaser.Game | null = null;
  let scene: DungeonScene | null = null;
  let ready = false;
  let readyListeners: (() => void)[] = [];

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
        backgroundColor: GAME_BACKGROUND_BY_THEME[theme],
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
        scene: [DungeonScene],
      });
      game = created;

      created.scene.start(DUNGEON_SCENE_KEY, {
        dungeonMap: world.map,
        callbacks,
        playerClass: world.playerClass ?? null,
        // `FloorVisibilityInput` accepts the neutral readonly arrays, so the
        // world model crosses the boundary without conversion.
        initialFloor: world.floor,
      });

      created.events.once('ready', () => {
        scene = created.scene.getScene(DUNGEON_SCENE_KEY) as DungeonScene;
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
      const active = current.scene.getScene(DUNGEON_SCENE_KEY);
      if (active) active.scene.restart();
      scene = current.scene.getScene(DUNGEON_SCENE_KEY) as DungeonScene;
    },

    onReady(listener: () => void): () => void {
      readyListeners.push(listener);
      return () => {
        readyListeners = readyListeners.filter((entry) => entry !== listener);
      };
    },

    setFloorVisibility(visibility): void {
      scene?.setFloorVisibility(visibility);
    },

    teleportToRoom(roomId): void {
      scene?.teleportToRoom(roomId);
    },

    setArtifactRooms(roomIds, visible): void {
      scene?.setArtifactRooms(roomIds, visible);
    },

    setCollectedArtifactRooms(roomIds): void {
      scene?.setCollectedArtifactRooms(roomIds);
    },

    setReviewedArtifactRooms(roomIds): void {
      scene?.setReviewedArtifactRooms(roomIds);
    },

    setImageRooms(roomIds): void {
      scene?.setImageRooms(roomIds);
    },

    setRoomOverlayStates(states): void {
      scene?.setRoomOverlayStates(states);
    },

    triggerInteract(): void {
      scene?.triggerInteract();
    },
  };
}
