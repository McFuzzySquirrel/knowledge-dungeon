/**
 * Renderer adapter boundary.
 *
 * Everything renderer-specific about a world host lives behind this barrel:
 * the adapters below are the only modules in the app that name Phaser types
 * outside `src/game/scenes`, and the only modules that turn a renderer-neutral
 * world model into engine calls.
 *
 * The two application seams, `src/game/createGame.ts` and
 * `src/game/createVillageGame.ts`, are thin factories over these adapters and
 * are what the React screens import. A future PixiJS host is added here,
 * beside the Phaser adapter rather than through it.
 */
export {
  createPhaserDungeonRenderer,
  type PhaserDungeonRenderer,
  type PhaserDungeonRendererOptions,
  type DungeonSceneEvents,
} from './phaserDungeonRenderer';
export {
  createPhaserVillageRenderer,
  type PhaserVillageRenderer,
  type PhaserVillageRendererOptions,
  type VillageSpawnPoint,
  type VillageSceneEvents,
} from './phaserVillageRenderer';
export {
  createPhaserFishingRenderer,
  type PhaserFishingHandlers,
  type PhaserFishingRenderer,
  type PhaserFishingRendererHost,
} from './phaserFishingRenderer';
