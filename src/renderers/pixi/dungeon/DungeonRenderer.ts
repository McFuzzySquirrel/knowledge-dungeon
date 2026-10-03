/**
 * The PixiJS dungeon renderer: the renderer-neutral port over the dungeon scene.
 *
 * ## What this module is
 *
 * It is the composition root for one dungeon world. It assembles the pieces a caller
 * should not have to know about - the PixiJS application binding, the renderer-neutral
 * world host, the Phase 10 asset loader, and the Cozy theme - and returns exactly the
 * contract the application layer already speaks: the `WorldRenderer` lifecycle,
 * `DungeonRendererCapabilities`, one readiness subscription, and the one extra verb
 * Phase 11's village handle also carries.
 *
 * ## The one thing it must not do
 *
 * Name `pixi.js`. `tests/phase9/pixi-host-boundary.test.ts` pins the set of modules that
 * import the engine; this module reaches the engine only through `createPixiApplication`
 * and `asPixiApplication`, which are the binding, and through `createDungeonScene`,
 * which is the deliberate scene importer. That keeps "where is PixiJS named" a short,
 * reviewable list rather than a property of every file that mentions a dungeon.
 *
 * ## The callbacks are renderer-neutral data, not a Phaser scene type
 *
 * `DungeonSceneCallbacks` is this module's own declaration, derived from
 * `WorldEventPayloadMap` exactly as the Phaser scene's `DungeonSceneEvents` is. That is
 * what lets `GameScreen` type one callback bag for both renderers and never name either
 * engine - and it is why the flag switch below can change which renderer mounts without
 * the screen's callback object changing shape.
 *
 * ## Asset loader, and why it is loaded but not drawn from
 *
 * The dungeon is drawn procedurally, so the loader's textures are not on the stage. It
 * is wired for the same reason the village wires it: Phase 10's bundle lifecycle is the
 * thing later phases consume, and the `dungeon` bundle is keys and procedural recipes
 * with no files, so loading it issues no network request and `dispose` releases it on
 * unmount.
 */
import { createAssetLoader } from '@/renderers/pixi/assets/AssetLoader';
import {
  asPixiApplication,
  createPixiApplication,
  createPixiAssetRuntime,
} from '@/renderers/pixi/runtime/createPixiApplication';
import { createPixiWorldHost } from '@/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import {
  resolveWorldQualityProfile,
  type WorldActionState,
  type WorldApplication,
  type WorldQualityId,
} from '@/renderers/pixi/runtime/types';
import { readWorldQuality } from '@/renderers/pixi/runtime/useWorldQuality';
import { currentWorldEnvironment } from '@/renderers/pixi/runtime/worldEnvironment';
import type { DungeonRendererCapabilities, WorldRenderer } from '@/application/contracts/renderer';
import type {
  WorldEventHandler,
  WorldEventPayload,
  WorldEventPayloadField,
} from '@/application/contracts/events';
import type { DungeonWorldModel } from '@/application/contracts/world';
import {
  IDLE_DUNGEON_ARTIFACT_SNAPSHOT,
  type DungeonArtifactSnapshot,
} from './dungeonArtifact';
import { createDungeonScene, type DungeonScene } from './createDungeonScene';

/**
 * The renderer-neutral callbacks the dungeon reports through.
 *
 * Every member is derived from the Phase 2 event contract, so the Pixi host and the
 * Phaser host cannot drift. The `onNpc*`, `onArtifactCollected`, and `onFloorTransition`
 * members are optional because the screen treats each as a capability it may not be
 * given; a caller that passes them is not required to change.
 */
export interface DungeonSceneCallbacks {
  onRoomEntered: (roomId: WorldEventPayloadField<'dungeon:room-entered', 'roomId'>) => void;
  onInteract: (roomId: WorldEventPayloadField<'dungeon:interact', 'roomId'>) => void;
  onNpcInteract?: WorldEventHandler<'dungeon:npc-interact'>;
  onNpcDialogPosition?: WorldEventHandler<'dungeon:npc-dialog-position'>;
  onNpcOutOfRange?: (roomId: WorldEventPayloadField<'dungeon:npc-out-of-range', 'roomId'>) => void;
  onArtifactCollected?: (
    roomId: WorldEventPayloadField<'dungeon:artifact-collected', 'roomId'>,
  ) => void;
  onFloorTransition?: WorldEventHandler<'dungeon:floor-transition'>;
}

/** The payload of `dungeon:npc-interact`, under the name a caller already uses. */
export type DungeonNpcDialogAnchor = WorldEventPayload<'dungeon:npc-interact'>;

/**
 * The dungeon renderer as the application layer sees it.
 *
 * Extends `DungeonRendererCapabilities` because the scene implements that port, and that
 * is what turns "the Pixi dungeon can be driven by the flow controller" into a
 * typechecked fact rather than a convention: the object literal below cannot drop a
 * member without failing `npm run typecheck` here.
 *
 * The extra members are the three the DOM mirror needs. `onReady` is the host-side
 * counterpart of the contract's "first frame" rule - `isReady()` is a poll, `onReady` lets
 * a React screen flip its own state. `onState` carries the per-action status sentences, and
 * `activateFromDom` is the one route from a DOM control into a world action, so a screen
 * never has to reach for a scene object.
 *
 * ## Why `onState` needed a second source alongside the host's
 *
 * The host republishes after every *dispatch*, which covers the keyboard, the canvas tap,
 * and the DOM controls. It does not republish after a *capability* call, and the dungeon has
 * capability calls that move the player - `teleportToRoom`, `setFloorVisibility` - so a
 * sentence about the room the player is standing in has to follow them. `onState` therefore
 * subscribes to the host *and* to a renderer-owned set, and every capability method
 * republishes from the same `scene.readState()` the host reads. One value, two triggers,
 * no second answer.
 */
export interface PixiDungeonRenderer extends WorldRenderer, DungeonRendererCapabilities {
  /** Subscribe to the first-frame notification. Returns the unsubscribe function. */
  onReady(listener: () => void): () => void;
  /**
   * Subscribe to the per-action status the DOM mirror announces.
   *
   * Returns the unsubscribe function. Fires once as soon as the world is built, and again
   * after every action and after every capability call, so a mirror control can render
   * "there are no stairs up in this room" without polling the scene.
   *
   * This member is the whole of the D1 fix: the host has published
   * `WorldActionState` since Phase 9 and this port simply never forwarded it, so the
   * dungeon's status sentences existed and no learner heard them.
   */
  onState(listener: (state: WorldActionState) => void): () => void;
  /** Perform a named world action the way a DOM control does. */
  activateFromDom(actionId: string): void;
  /**
   * Read the dungeon's artifact surface, for a DOM surface that renders it.
   *
   * ## Why this is not on `DungeonRendererCapabilities`
   *
   * Because that port is shared with the Phaser adapter and could not be widened here, and
   * because a read and a verb belong together: `state.canCollect` is what a control checks
   * before it enables itself, and `activateFromDom(DUNGEON_ARTIFACT_ACTION_ID)` is what it
   * dispatches when pressed. The two are only meaningful as a pair, so they sit on the same
   * object.
   *
   * The same pattern the village's Phase 12 `readNpcSnapshot` set, and for the same reason:
   * a React surface must not have to hold a scene to ask a question. Total - before mount,
   * after unmount, and on a corridor it reports {@link IDLE_DUNGEON_ARTIFACT_SNAPSHOT}'s
   * shape rather than `undefined`.
   *
   * The action to dispatch from it is {@link DUNGEON_ARTIFACT_ACTION_ID}, which routes
   * through the host's own dispatch, so a pickup taken from a DOM control is announced once
   * and is the same action as the marker the learner walks onto.
   */
  readArtifactSnapshot(): DungeonArtifactSnapshot;
}

/** Everything the renderer needs to present one dungeon world. */
export interface CreatePixiDungeonRendererOptions {
  /** Element the canvas is appended to. Never `document.body`. */
  readonly host: HTMLElement;
  /** Renderer-neutral model of the dungeon to present. */
  readonly world: DungeonWorldModel;
  /** Contract callbacks the scene reports through. */
  readonly callbacks: DungeonSceneCallbacks;
  /** UI colour theme, which selects the Cozy token set. */
  readonly colorTheme?: string | null;
  /** Quality profile id. Defaults to whatever the device heuristic observes. */
  readonly quality?: WorldQualityId | null;
}

/**
 * Build the PixiJS dungeon renderer.
 *
 * The returned renderer is inert until {@link PixiDungeonRenderer.mount} is called, so a
 * host can subscribe to readiness and set the mirror element first.
 */
export function createPixiDungeonRenderer(
  options: CreatePixiDungeonRendererOptions,
): PixiDungeonRenderer {
  const observed = readWorldQuality();
  const quality = resolveWorldQualityProfile(options.quality ?? observed.profile.id);
  const theme = resolveCozyWorldTheme({
    theme: options.colorTheme ?? null,
    reducedMotion: observed.reducedMotion,
  });

  // One loader per mount, created lazily and disposed on unmount, for the reason
  // `createPixiVillageRenderer` documents: a single loader shared across a StrictMode
  // mount/unmount/mount would have a `dispose` in flight when the second `loadBundle`
  // starts.
  let loader: ReturnType<typeof createAssetLoader> | null = null;
  let bundleHeld = false;

  // The scene the host built, held so a capability-driven state change can be republished.
  // The host calls `createScene` exactly once per mount and once per `restart`, so this is
  // always the scene that is currently on the stage.
  let scene: DungeonScene | null = null;
  // Listeners this renderer serves itself, in addition to the host's own.
  const stateListeners = new Set<(state: WorldActionState) => void>();

  const host = createPixiWorldHost<WorldApplication, DungeonScene, DungeonRendererCapabilities>({
    host: options.host,
    createApplication: createPixiApplication,
    createScene: (application, init) => {
      scene = createDungeonScene(asPixiApplication(application), init, {
        world: options.world,
        callbacks: options.callbacks,
      });
      return scene;
    },
    theme,
    quality,
    reducedMotion: observed.reducedMotion,
    environment: currentWorldEnvironment(),
  });

  /** Republish the scene's current status to the renderer-owned listeners. */
  function refreshState(): void {
    if (scene === null || stateListeners.size === 0) return;
    const state = scene.readState();
    for (const listener of [...stateListeners]) listener(state);
  }

  return {
    mount(): void {
      if (loader === null) {
        loader = createAssetLoader({ runtime: createPixiAssetRuntime(), theme });
      }
      if (!bundleHeld) {
        bundleHeld = true;
        // The dungeon bundle is keys and procedural recipes, so this reads no file and
        // makes no request; it is the lifecycle, not the art.
        void loader.loadBundle('dungeon').catch(() => {
          bundleHeld = false;
        });
      }
      // A mount failure is the screen's to show; `onReady` is the success channel and
      // `isReady()` is the poll. The host has already released anything it created
      // before rejecting, so there is nothing here to clean up.
      void host.mount().catch(() => {});
    },
    unmount(): void {
      host.unmount();
      scene = null;
      stateListeners.clear();
      bundleHeld = false;
      const current = loader;
      loader = null;
      if (current !== null) void current.dispose().catch(() => {});
    },
    isReady(): boolean {
      return host.isReady();
    },
    restart(): void {
      host.restart();
    },
    onReady(listener: () => void): () => void {
      return host.onReady(listener);
    },
    onState(listener: (state: WorldActionState) => void): () => void {
      const stopHost = host.onState(listener);
      stateListeners.add(listener);
      return () => {
        stopHost();
        stateListeners.delete(listener);
      };
    },
    activateFromDom(actionId: string): void {
      // The host dispatches and republishes in one function, so no `refreshState()` is
      // needed here: the activation *is* the trigger.
      host.activateFromDom(actionId);
    },
    readArtifactSnapshot(): DungeonArtifactSnapshot {
      return scene?.readArtifactSnapshot() ?? IDLE_DUNGEON_ARTIFACT_SNAPSHOT;
    },
    setFloorVisibility(visibility): void {
      host.capabilities?.setFloorVisibility(visibility);
      refreshState();
    },
    teleportToRoom(roomId): void {
      host.capabilities?.teleportToRoom(roomId);
      refreshState();
    },
    setArtifactRooms(roomIds, visible): void {
      host.capabilities?.setArtifactRooms(roomIds, visible);
      refreshState();
    },
    setCollectedArtifactRooms(roomIds): void {
      host.capabilities?.setCollectedArtifactRooms(roomIds);
      refreshState();
    },
    setReviewedArtifactRooms(roomIds): void {
      host.capabilities?.setReviewedArtifactRooms(roomIds);
      refreshState();
    },
    setImageRooms(roomIds): void {
      host.capabilities?.setImageRooms(roomIds);
      refreshState();
    },
    setRoomOverlayStates(states): void {
      host.capabilities?.setRoomOverlayStates(states);
      refreshState();
    },
    triggerInteract(): void {
      // Routed through the host's dispatch, so the DOM button's interact is the same
      // action as the key's and the state republishes once for both.
      host.capabilities?.triggerInteract();
    },
  };
}