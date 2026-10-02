/**
 * The PixiJS village renderer: the renderer-neutral port over the village scene.
 *
 * ## What this module is
 *
 * It is the composition root for one village world. It assembles the pieces a
 * caller should not have to know about - the PixiJS application binding, the
 * renderer-neutral world host, the Phase 10 asset loader, and the Cozy theme -
 * and returns exactly the contract the application layer already speaks:
 * `WorldRenderer` lifecycle, `VillageRendererCapabilities`, and one readiness
 * subscription. No React, no direct `pixi.js`, and no learner data.
 *
 * ## The one thing it must not do
 *
 * Name `pixi.js`. `tests/phase9/pixi-host-boundary.test.ts` pins the set of
 * modules that import the engine; this module reaches the engine only through
 * `createPixiApplication` and `asPixiApplication`, which are the binding, and
 * through `createVillageScene`, which is the deliberate scene importer. That keeps
 * the answer to "where is PixiJS named" a short, reviewable list rather than a
 * property of every file that mentions a village.
 *
 * ## Asset loader, and why it is loaded but not drawn from
 *
 * Phase 11 draws the village procedurally, so the loader's textures are not on
 * the stage. It is still wired here because Phase 10's bundle lifecycle is the
 * thing later phases consume, and a loader that no world ever mounts is a loader
 * whose ref counts, deferred releases, and diagnostics are never exercised on a
 * route. The `village` bundle is keys and procedural recipes with no files, so
 * loading it issues no network request; `dispose` releases it on unmount.
 */
import { createAssetLoader } from '@/renderers/pixi/assets/AssetLoader';
import {
  asPixiApplication,
  createPixiApplication,
  createPixiAssetRuntime,
} from '@/renderers/pixi/runtime/createPixiApplication';
import { createPixiWorldHost } from '@/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile, type WorldApplication, type WorldQualityId } from '@/renderers/pixi/runtime/types';
import { readWorldQuality } from '@/renderers/pixi/runtime/useWorldQuality';
import { currentWorldEnvironment } from '@/renderers/pixi/runtime/worldEnvironment';
import type { VillageNpcHost, WorldRenderer } from '@/application/contracts/renderer';
import {
  createVillageNpcSnapshot,
  type VillageActionInvocation,
  type VillageNpcSnapshot,
} from '@/application/contracts/villageNpc';
import type { VillageWorldModel, WorldPointOfInterest } from '@/application/contracts/world';
import { createVillageScene, type VillageScene } from './createVillageScene';

/**
 * One-time world spawn override.
 *
 * `null` on either axis means "no override", and the scene falls back to the
 * stored spawn and then to the map's own player start. The shape is the Phaser
 * adapter's, so a screen can build one object for either renderer.
 */
export type VillageSpawnPoint = { gridX: number | null; gridY: number | null };

/**
 * The renderer-neutral callbacks the village reports through.
 *
 * Deliberately plain data-free function types rather than Phaser's `*SceneEvents`
 * derivations: the Pixi host is not a Phaser scene, and a screen that binds these
 * does not import an engine. The `onNpc*` members are optional because Phase 11
 * does not emit them; Phase 12 will, and a caller that already passes them is not
 * required to change.
 */
export interface VillageSceneCallbacks {
  onStructureApproached: (structureId: string) => void;
  onStructureLeft: (structureId: string) => void;
  onStructureInteract: (structureId: string) => void;
  onReady: () => void;
  onNpcApproached?: (npcId: string) => void;
  onNpcLeft?: (npcId: string) => void;
  onNpcInteract?: (npcId: string) => void;
  onNpcDialogPosition?: (anchor: { npcId: string; clientX: number; clientY: number }) => void;
}

/**
 * The village renderer as the application layer sees it: the Phase 2 lifecycle,
 * the village capability port, and one renderer-neutral readiness subscription.
 *
 * Extends {@link VillageNpcHost} rather than the base
 * `VillageRendererCapabilities` because the scene now implements `readNpcSnapshot`
 * and `invokeAction`, and this is what turns that from an implementation detail
 * into a typechecked fact: the object literal below cannot drop either member
 * without failing `npm run typecheck` here, and a screen that depends on
 * `VillageNpcHost` can take this renderer without a feature detection that would
 * quietly be `undefined` on a build where nothing is implemented.
 */
export interface PixiVillageRenderer extends WorldRenderer, VillageNpcHost {
  /**
   * Subscribe to the first-frame notification. Returns an unsubscribe function;
   * listeners added after readiness are not replayed.
   */
  onReady(listener: () => void): () => void;
}

/** Everything the renderer needs to present one village world. */
export interface CreatePixiVillageRendererOptions {
  /** Element the canvas is appended to. Never `document.body`. */
  readonly host: HTMLElement;
  /** Renderer-neutral model of the village to present. */
  readonly world: VillageWorldModel;
  /** Contract callbacks the scene reports through. */
  readonly callbacks: VillageSceneCallbacks;
  /** One-time spawn grid override, or `null`/absent for the stored or map default. */
  readonly spawn?: VillageSpawnPoint;
  /** A Cozy theme name, or a persisted legacy colour-theme string. */
  readonly colorTheme?: string;
  /** A pinned quality profile. Absent lets the device heuristic decide. */
  readonly quality?: WorldQualityId;
}

/**
 * Build the PixiJS-backed village renderer.
 *
 * The returned renderer is inert until {@link PixiVillageRenderer.mount} is
 * called, so a host can subscribe to readiness and set the mirror element first.
 */
export function createPixiVillageRenderer(
  options: CreatePixiVillageRendererOptions,
): PixiVillageRenderer {
  const observed = readWorldQuality();
  const quality = resolveWorldQualityProfile(options.quality ?? observed.profile.id);
  const theme = resolveCozyWorldTheme({
    theme: options.colorTheme ?? null,
    reducedMotion: observed.reducedMotion,
  });

  // One loader per mount, created lazily and disposed on unmount. A single loader
  // shared across a StrictMode mount/unmount/mount would have a `dispose` in flight
  // when the second `loadBundle` starts; a per-mount instance has no such overlap.
  let loader: ReturnType<typeof createAssetLoader> | null = null;
  let bundleHeld = false;

  const host = createPixiWorldHost<WorldApplication, VillageScene, VillageNpcHost>({
    host: options.host,
    createApplication: createPixiApplication,
    createScene: (application, init) =>
      createVillageScene(asPixiApplication(application), init, {
        world: options.world,
        callbacks: options.callbacks,
        spawn: options.spawn,
      }),
    theme,
    quality,
    reducedMotion: observed.reducedMotion,
    environment: currentWorldEnvironment(),
  });

  return {
    mount(): void {
      if (loader === null) {
        loader = createAssetLoader({ runtime: createPixiAssetRuntime(), theme });
      }
      if (!bundleHeld) {
        bundleHeld = true;
        // The village bundle is keys and procedural recipes, so this reads no
        // file and makes no request; it is the lifecycle, not the art.
        void loader
          .loadBundle('village')
          .catch(() => {
            bundleHeld = false;
          });
      }
      // A mount failure is the screen's to show; `onReady` is the success channel
      // and `isReady()` is the poll. The host has already released anything it
      // created before rejecting, so there is nothing here to clean up.
      void host.mount().catch(() => {});
    },
    unmount(): void {
      host.unmount();
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
    setDynamicStructures(structures): void {
      host.capabilities?.setDynamicStructures(structures);
    },
    setPlayerClass(playerClass): void {
      host.capabilities?.setPlayerClass(playerClass);
    },
    triggerInteract(): void {
      host.capabilities?.triggerInteract();
    },
    readPoi(): WorldPointOfInterest | null {
      return host.capabilities?.readPoi() ?? null;
    },

    /**
     * The scene's NPC snapshot, forwarded.
     *
     * Before a mount there is no scene and no world, so the answer is the contract's
     * empty snapshot - a value, so a panel polling early renders nothing instead of
     * branching on a missing method.
     */
    readNpcSnapshot(): VillageNpcSnapshot {
      return host.capabilities?.readNpcSnapshot() ?? EMPTY_NPC_SNAPSHOT;
    },

    /**
     * Forward a DOM control's named intent into the scene, through the host.
     *
     * The scene routes it back out through `init.onAction` and reads the intent back
     * in the activation that dispatch performs, so the button click, the canvas tap,
     * and the `E` key remain one action through one dispatcher - which is also what
     * republishes the `aria-live` state once for all three.
     */
    invokeAction(invocation: VillageActionInvocation): void {
      host.capabilities?.invokeAction(invocation);
    },
  };
}

/**
 * The snapshot a caller gets before the scene exists.
 *
 * Frozen and shared rather than allocated per call, because it is the same empty
 * value every time and a panel that polls at 60fps would otherwise allocate sixty
 * objects a second to learn nothing had changed yet.
 */
const EMPTY_NPC_SNAPSHOT: VillageNpcSnapshot = createVillageNpcSnapshot({
  candidates: [],
  anchor: null,
});
