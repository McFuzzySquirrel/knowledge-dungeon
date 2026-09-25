/**
 * Dungeon world seam for the application layer.
 *
 * The React screen imports only this module: it hands over a host element, a
 * renderer-neutral {@link DungeonWorldModel}, and the contract-derived scene
 * callbacks, and receives a renderer-neutral
 * {@link PhaserDungeonRenderer}. Nothing Phaser-shaped crosses this boundary,
 * so swapping the engine means replacing the adapter this factory delegates to
 * and nothing in `src/ui` or `src/application`.
 */
import {
  createPhaserDungeonRenderer,
  type PhaserDungeonRenderer,
} from '@/game/adapters';
import type { DungeonSceneEvents } from '@/game/adapters';
import type { DungeonWorldModel } from '@/application/contracts/world';
import type { ColorTheme } from '@/store/preferencesStore';

export interface CreateGameOptions {
  /** Element the world canvas is appended to. */
  parent: HTMLElement;
  /** Renderer-neutral model of the dungeon to present. */
  world: DungeonWorldModel;
  /** Contract-derived callbacks the dungeon world reports through. */
  callbacks: DungeonSceneEvents;
  /** UI theme, which selects the canvas clear color. */
  colorTheme?: ColorTheme;
}

export type { DungeonSceneEvents, PhaserDungeonRenderer };

/**
 * Build the dungeon world renderer for a host element.
 *
 * The returned renderer is inert until `mount()` is called.
 */
export function createGame(options: CreateGameOptions): PhaserDungeonRenderer {
  return createPhaserDungeonRenderer(options);
}
