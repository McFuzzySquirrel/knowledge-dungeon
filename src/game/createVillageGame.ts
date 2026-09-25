/**
 * Village world seam for the application layer.
 *
 * The React screen imports only this module: it hands over a host element, a
 * renderer-neutral {@link VillageWorldModel}, and the contract-derived scene
 * callbacks, and receives a renderer-neutral {@link PhaserVillageRenderer}
 * that also owns the fishing world sharing its canvas. Nothing Phaser-shaped
 * crosses this boundary.
 */
import {
  createPhaserVillageRenderer,
  type PhaserVillageRenderer,
  type VillageSceneEvents,
  type VillageSpawnPoint,
} from '@/game/adapters';
import type { VillageWorldModel } from '@/application/contracts/world';

export interface CreateVillageGameOptions {
  /** Element the world canvas is appended to. */
  parent: HTMLElement;
  /** Renderer-neutral model of the village to present. */
  world: VillageWorldModel;
  /** Contract-derived callbacks the village world reports through. */
  callbacks: VillageSceneEvents;
  /** One-time spawn grid override, or `null` for the map default. */
  spawn?: VillageSpawnPoint;
}

export type { VillageSceneEvents, VillageSpawnPoint, PhaserVillageRenderer };

/**
 * Build the village world renderer for a host element.
 *
 * The returned renderer is inert until `mount()` is called.
 */
export function createVillageGame(options: CreateVillageGameOptions): PhaserVillageRenderer {
  return createPhaserVillageRenderer(options);
}
