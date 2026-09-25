/**
 * Renderer-neutral world model contract.
 *
 * These are plain data descriptions of what each world shows right now. The
 * current Phaser host adapts them to `Phaser.Scene` state; the future PixiJS
 * host adapts the very same models to its own scene graph. Nothing in this file
 * may import a renderer, a DOM global, or a store.
 */
import type { DungeonMap } from '@/core/layout/dungeonTypes';
import type { FloorBiomeId } from '@/core/biomes';
import type { VillageStructure } from '@/data/villageLayout';

/**
 * Study-archetype identifier, duplicated here so the renderer-neutral
 * application layer never imports from the renderer tree.
 *
 * `src/game/systems/playerClasses.ts` stays the runtime source of truth and
 * asserts union parity with this type at compile time, so the two cannot drift.
 */
export type PlayerClassId = 'scholar' | 'cartographer' | 'archivist';

/** Discriminant for the three worlds the application can be showing. */
export type WorldKind = 'village' | 'dungeon' | 'fishing';

/**
 * Which rooms of the active floor the renderer may draw, plus the portals that
 * lead off it.
 *
 * Collections are readonly arrays rather than `Set`s so a host can consume them
 * without depending on a collection implementation. The Phaser adapter converts
 * them into `Set`s at the edge (see `FloorVisibilityInput` in
 * `src/game/scenes/DungeonScene.ts`).
 */
export interface FloorVisibilityModel {
  floorId: string;
  visibleRoomIds: readonly string[];
  portalUpRoomId: string | null;
  portalDownRoomIds: readonly string[];
  biomeId?: FloorBiomeId;
}

/** Renderer-neutral model of the dungeon world. */
export interface DungeonWorldModel {
  kind: 'dungeon';
  map: DungeonMap;
  floor: FloorVisibilityModel;
  playerClass: PlayerClassId | null;
}

/** Renderer-neutral model of the village world. */
export interface VillageWorldModel {
  kind: 'village';
  structures: readonly VillageStructure[];
  playerClass: PlayerClassId | null;
}

/** Renderer-neutral model of the fishing world. */
export interface FishingWorldModel {
  kind: 'fishing';
  playerClass: PlayerClassId | null;
  hasClearedRooms: boolean;
  subjectId: string | null;
}

/** Discriminated union of every world the application can present. */
export type WorldModel = DungeonWorldModel | VillageWorldModel | FishingWorldModel;

/** A single point of interest reported by a renderer for a compass/HUD read-out. */
export interface WorldPointOfInterest {
  name: string;
  angle: number;
  distance: number;
}
