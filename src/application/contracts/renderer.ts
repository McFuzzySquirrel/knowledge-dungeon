/**
 * Renderer-neutral renderer lifecycle and capability contract.
 *
 * A world host (the Phaser wrapper today, the PixiJS host later) mounts a
 * renderer for a {@link WorldModel}, reports readiness, and exposes the small
 * set of imperative capabilities the application layer needs. Nothing here
 * names a Phaser or PixiJS type: a renderer adapter is what binds the concrete
 * engine to these interfaces.
 */
import type { VillageStructure } from '@/data/villageLayout';
import type { FloorVisibilityModel, PlayerClassId, WorldPointOfInterest } from './world';

/** Lifecycle every world renderer adapter implements. */
export interface WorldRenderer {
  /** Attach the renderer to its host element and start presenting the world. */
  mount(): void;
  /** Detach the renderer and release its resources. */
  unmount(): void;
  /** True once the renderer has finished its first frame and accepts commands. */
  isReady(): boolean;
  /** Rebuild the world in place (used after custom sprites are applied). */
  restart(): void;
}

/**
 * Capability port of the dungeon renderer. Mirrors the public methods the
 * Phaser `DungeonScene` exposes today.
 */
export interface DungeonRendererCapabilities {
  /** Switch the visible floor; safe to call before the first frame. */
  setFloorVisibility(visibility: FloorVisibilityModel): void;
  /** Place the player in a room on the active floor. */
  teleportToRoom(roomId: string): void;
  /** Rooms that produced an artifact, and whether the icons should be drawn. */
  setArtifactRooms(roomIds: readonly string[], visible: boolean): void;
  /** Rooms whose artifact has already been collected into the journal. */
  setCollectedArtifactRooms(roomIds: readonly string[]): void;
  /** Rooms that already carry a review marker. */
  setReviewedArtifactRooms(roomIds: readonly string[]): void;
  /** Rooms that have image attachments. */
  setImageRooms(roomIds: readonly string[]): void;
  /** Per-room overlay state key (e.g. `Created`, `EncounterDefeated`). */
  setRoomOverlayStates(states: Record<string, string>): void;
  /** Programmatic interact, used by the on-screen touch button. */
  triggerInteract(): void;
}

/** Capability port of the village renderer. */
export interface VillageRendererCapabilities {
  /** Replace the runtime portal structures derived from the subject list. */
  setDynamicStructures(structures: readonly VillageStructure[]): void;
  /** Update the study archetype used for the player sprite. */
  setPlayerClass(playerClass: PlayerClassId | null): void;
  /** Programmatic interact, used by the on-screen touch button. */
  triggerInteract(): void;
  /** Read the current point of interest for a compass/HUD read-out. */
  readPoi(): WorldPointOfInterest | null;
}

/** Capability port of the fishing renderer. */
export interface FishingRendererCapabilities {
  /** Update the study archetype used for the angler sprite. */
  setPlayerClass(playerClass: PlayerClassId | null): void;
  /** Number of fish already kept in this fishing session. */
  getCaughtCount(): number;
  /** Send the player back to the village from the fishing world. */
  returnToVillage(): void;
}
