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
import type {
  VillageActionInvocation,
  VillageNpcSnapshot,
} from './villageNpc';

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

/**
 * A learner's position in the village grid. Two tile indices; never personal data.
 *
 * A **tile**, not a pixel, and not a bounding box, because the tile is the unit
 * interaction and collision are computed in on both lanes: `VILLAGE_MAP.tileSize` on
 * the Phaser scene and `VILLAGE_TILE_SIZE` on the Pixi scene are the same 48 px, and
 * both scenes place a structure at `(gridX + width / 2) * tile`. A consumer that aims
 * at a structure's `gridX`/`gridY` and at its own published tile is therefore working
 * in the same frame as the renderer, so a heading it computes is a heading the
 * renderer will agree with.
 *
 * Renderer-neutral and renderer-free by construction: it names no engine, no scene,
 * and no display object, so it can be declared here and read from `src/ui/**` without
 * the `src/application/**` boundary being crossed.
 *
 * **Privacy.** A tile index into an authored map is not personal data and cannot
 * become any: it is not a subject id, a quest step, a timestamp, or a location a
 * learner can be recognised from - two learners standing on the same tile publish the
 * identical pair. There is nothing here for a privacy boundary to exempt, because
 * there is nothing personal in it.
 */
export interface WorldGridPosition {
  readonly gridX: number;
  readonly gridY: number;
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
  /**
   * Read the village's NPC state as one value: proximity measurements, the
   * selected nearby-action rows, and the dialogue currently on show.
   *
   * This is the read a React panel uses to render a nearby-action list and a quest
   * overview without reaching into a renderer object. It is deliberately *data out
   * of a port* rather than a second way to get at the scene: `readPoi()` set the
   * pattern and the answer to "how do I watch the world from React" is one
   * renderer-neutral read, not a handle.
   *
   * Optional while both adapters are still being wired. `src/game/**` and
   * `src/renderers/**` were outside the contract work package that introduced it, and
   * making this required before an adapter implements it would be a build break
   * rather than a statement about the contract. The fully-wired form is
   * {@link VillageNpcHost}; the `?` comes off when both adapters implement it.
   */
  readNpcSnapshot?(): VillageNpcSnapshot;
  /**
   * Perform a renderer-neutral village action on behalf of a DOM control.
   *
   * The one route from DOM to world. An adapter forwards it into its own dispatch
   * rather than acting directly, so a button click, a canvas tap, and the world's
   * keyboard shortcut stay one action and the state republishes once - the Phase 9
   * rule, restated for the village.
   *
   * Optional for the same reason and with the same promotion as
   * {@link VillageRendererCapabilities.readNpcSnapshot}.
   */
  invokeAction?(invocation: VillageActionInvocation): void;
  /**
   * The learner's current tile, or `null` before a world exists.
   *
   * ## Why the village states where it is
   *
   * The village has always published a *distance* to each nearby structure and never a
   * *position*. A walker - a keyboard learner pressing arrow keys, or an end-to-end
   * harness doing the same - therefore could not know where it was standing, so each
   * leg aimed at a structure's centre while pressing from wherever the previous leg
   * ended: measured **30.8 px and 41.6 px** off on a 48 px tile, up to 0.9 of a tile,
   * with the next leg then aiming a 25-tile heading from a position it was never at.
   * This read is the missing half.
   *
   * ## A read, not a callback
   *
   * Deliberately a method and not a subscription. Position changes every frame, and a
   * callback would push it into React as state - the per-frame-render regression
   * `CompassOverlay` removed when it was rewritten as a sampled read-out. A caller
   * that wants to watch the learner take a sample at whatever cadence it needs; the
   * village does not decide the frequency on its behalf.
   *
   * Computed **on read**, never cached into a field. A cached position is correct for
   * the frame that produced it and wrong the moment it is read outside that frame,
   * which is exactly how the stale-distance bug happened.
   *
   * Optional for the same reason and with the same promotion as
   * {@link VillageRendererCapabilities.readNpcSnapshot}. An adapter that has not
   * implemented it *absents* rather than guesses: a missing member and a member that
   * answers `null` are both "the world cannot say", and neither is ever a wrong tile.
   */
  readPlayerGridPosition?(): WorldGridPosition | null;
}

/**
 * A village host that has wired Phase 12's NPC surface.
 *
 * Declared as the narrowing of {@link VillageRendererCapabilities} rather than as a
 * fourth capability port, so it cannot drift from the members it requires: a member
 * that disappears or changes type here fails `npm run typecheck` at the adapters and
 * not silently at a call site. A screen that needs the NPC surface depends on this;
 * a screen that must work against a not-yet-wired adapter keeps using
 * {@link VillageRendererCapabilities} and feature-detects.
 */
export interface VillageNpcHost extends VillageRendererCapabilities {
  readNpcSnapshot(): VillageNpcSnapshot;
  invokeAction(invocation: VillageActionInvocation): void;
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
