/**
 * Phaser adapter for the village world.
 *
 * This module is the only place where the village world model, the
 * renderer-neutral renderer contract, and the Phaser engine meet. Everything
 * Phaser-specific lives here, in `phaserFishingRenderer.ts`, and in
 * `src/game/scenes`:
 *
 * - `Phaser.Game` construction, scale/physics options, and the canvas parent
 * - the `game.events.once('ready')` readiness handshake
 * - `game.scene.getScene('VillageScene')` scene lookup and its cast
 * - `scene.scene.restart()` for the custom-sprite rebuild
 * - `game.destroy(true)` teardown
 * - the custom-sprite blob-URL revocation that has to happen before a restart
 * - ownership of the fishing sub-renderer, which shares this game and canvas
 *
 * The returned object is described entirely by renderer-neutral types, so the
 * React screen never names Phaser. Replacing Phaser means replacing this
 * directory (and the two `createGame*` seams that construct it) and nothing
 * else.
 *
 * ## Phase 12: the NPC surface is not optional here
 *
 * `readNpcSnapshot` and `invokeAction` are declared `?` on the base
 * `VillageRendererCapabilities` because both adapters still had to be wired when the
 * contract was written. A screen that feature-detects therefore sees `undefined`
 * rather than a type error, and a DOM nearby-action control quietly does nothing -
 * on *this* adapter, which is the default build until Phase 24, and it would do so
 * at runtime with nothing in the build to say so. Both are implemented below,
 * sourced from the Phaser scene's own state.
 *
 * The scene keeps no new state. An earlier version of this adapter also published a
 * `dialogue` on the snapshot, computed here by wrapping the NPC callbacks and
 * running the contract's line selection against an empty quest step. Nothing read
 * that field - the bubble a learner sees comes from the screen's own state - and a
 * renderer could not have filled it correctly in any case, because it does not know
 * the learner's quest step and the Phase 9 rule is that it does not reach into a
 * store to find out. The line is chosen by the application layer; the snapshot now
 * carries measurements and an anchor, which are the two things a renderer *can* know,
 * and this adapter forwards the scene's callbacks untouched.
 */
import Phaser from 'phaser';
import { VillageScene, type VillageSceneEvents } from '@/game/scenes/VillageScene';
import { FishingScene } from '@/game/scenes/FishingScene';
import {
  createPhaserFishingRenderer,
  type PhaserFishingRenderer,
} from '@/game/adapters/phaserFishingRenderer';
import {
  createVillageNpcSnapshot,
  VILLAGE_ACTION_INTERACT,
  type VillageActionInvocation,
  type VillageNpcSnapshot,
} from '@/application/contracts/villageNpc';
import type { VillageNpcHost, WorldGridPosition, WorldRenderer } from '@/application/contracts/renderer';
import type { VillageWorldModel } from '@/application/contracts/world';
import { type VillageStructure } from '@/data/villageLayout';

/** Phaser scene key the village world runs in. */
const VILLAGE_SCENE_KEY = 'VillageScene';

/** Canvas clear color behind the village. */
const VILLAGE_BACKGROUND = '#1a2a1a';

/**
 * Callbacks the village world reports through. Re-exported from the scene so
 * hosts can type the object without importing a Phaser module: the type is
 * derived from the renderer-neutral event contract, not from Phaser.
 */
export type { VillageSceneEvents };

/** One-time world spawn override, restored by the village scene. */
export interface VillageSpawnPoint {
  gridX: number | null;
  gridY: number | null;
}

/** Everything the village adapter needs to present one village world. */
export interface PhaserVillageRendererOptions {
  /** Element the canvas is appended to. */
  parent: HTMLElement;
  /** Renderer-neutral model of the village to present. */
  world: VillageWorldModel;
  /** Contract-derived callbacks the scene reports through. */
  callbacks: VillageSceneEvents;
  /** One-time spawn grid override, or `null` for the map default. */
  spawn?: VillageSpawnPoint;
}

/**
 * The village world renderer as the application layer sees it: the neutral
 * `WorldRenderer` lifecycle, the neutral `VillageNpcHost` port, one
 * renderer-neutral readiness subscription, and the fishing world renderer that
 * shares this host's canvas.
 *
 * `VillageNpcHost` and not the base `VillageRendererCapabilities`, because this
 * adapter implements `readNpcSnapshot` and `invokeAction` and the whole point of
 * implementing them is that a consumer should not have to feature-detect: with the
 * optional base port, a DOM nearby-action control compiles fine and does nothing at
 * runtime on the default build. Extending the narrowed port makes the object literal
 * below fail `npm run typecheck` if either member is ever removed, and lets a screen
 * that depends on `VillageNpcHost` accept this renderer directly.
 */
export interface PhaserVillageRenderer extends WorldRenderer, VillageNpcHost {
  /**
   * Subscribe to the first-frame notification. Returns an unsubscribe
   * function; listeners added after readiness are not replayed.
   */
  onReady(listener: () => void): () => void;
  /**
   * Re-declared as required here, and narrowed from the base port's optional member,
   * for the reason the interface header gives for `VillageNpcHost`: this adapter
   * implements the read, so the object literal below must not be able to drop it
   * without a `typecheck` failure. The contract member stays `?` - the promotion
   * belongs on the adapter that has earned it.
   */
  readPlayerGridPosition(): WorldGridPosition | null;
  /**
   * The fishing world renderer bound to this host's game. The fishing world
   * has no canvas of its own: it swaps the running scene, so the village host
   * owns the object that starts and stops it.
   */
  fishing(): PhaserFishingRenderer;
}

/**
 * Build the Phaser-backed village renderer.
 *
 * The returned renderer is inert until {@link PhaserVillageRenderer.mount} is
 * called, so a host can subscribe to readiness first and then start the world.
 */
export function createPhaserVillageRenderer(
  options: PhaserVillageRendererOptions,
): PhaserVillageRenderer {
  const { parent, world, callbacks } = options;
  const spawn = options.spawn ?? { gridX: null, gridY: null };

  let game: Phaser.Game | null = null;
  let scene: VillageScene | null = null;
  let ready = false;
  let readyListeners: (() => void)[] = [];

  /**
   * The scene's callbacks, forwarded unwrapped.
   *
   * This adapter used to wrap the three NPC events so it could maintain its own
   * conversation cursor and publish the snapshot's `dialogue`. Both are gone: nothing
   * read that field, and a renderer has no quest step to select the right line with -
   * which is why it could only ever have produced a quest-agnostic answer. The
   * application layer selects the line, through the one pure function both renderers
   * used to duplicate.
   *
   * The callbacks object is therefore passed straight through, so the screen receives
   * the identical payloads in the identical order from this adapter and from Pixi.
   */
  const observedCallbacks: VillageSceneEvents = { ...callbacks };

  const fishing = createPhaserFishingRenderer({ game: () => game });

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
        backgroundColor: VILLAGE_BACKGROUND,
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
        scene: [VillageScene, FishingScene],
      });
      game = created;

      created.scene.start(VILLAGE_SCENE_KEY, {
        callbacks: observedCallbacks,
        // An empty list is equivalent to omitting the key: the scene only
        // merges dynamic structures when it receives a non-empty array.
        dynamicStructures: world.structures,
        playerClass: world.playerClass ?? 'scholar',
        spawnGridX: spawn.gridX,
        spawnGridY: spawn.gridY,
      });

      created.events.once('ready', () => {
        scene = created.scene.getScene(VILLAGE_SCENE_KEY) as VillageScene;
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
      const active = current.scene.getScene(VILLAGE_SCENE_KEY);
      if (active) active.scene.restart();
      scene = current.scene.getScene(VILLAGE_SCENE_KEY) as VillageScene;
    },

    onReady(listener: () => void): () => void {
      readyListeners.push(listener);
      return () => {
        readyListeners = readyListeners.filter((entry) => entry !== listener);
      };
    },

    setDynamicStructures(structures: readonly VillageStructure[]): void {
      scene?.setDynamicStructures([...structures]);
    },

    setPlayerClass(playerClass): void {
      scene?.setPlayerClass(playerClass ?? 'scholar');
    },

    triggerInteract(): void {
      scene?.triggerInteract();
    },

    readPoi() {
      const poi = scene?.lastPoi;
      if (!poi || poi.distance >= 1e9) return null;
      return { name: poi.name, angle: poi.angle, distance: poi.distance };
    },

    /**
     * The scene's tile, computed on read.
     *
     * Forwarded, never recomputed here and never cached here. Recomputing in this
     * adapter would mean a second answer to "where is the learner" derived from a
     * different source than the scene measures proximity from, and caching it would
     * reintroduce exactly the staleness `readPoi`'s cached `lastPoi` is acceptable
     * with and a position is not.
     *
     * `null` before a scene exists, which is the whole of the "no world yet" case on
     * this lane: `scene` is `null` until `game.events.once('ready')` has handed it
     * over, and the optional call collapses that to the contract's `null`.
     */
    readPlayerGridPosition(): WorldGridPosition | null {
      return scene?.readPlayerGridPosition() ?? null;
    },

    /**
     * One coherent read of the village's NPC surface, from the Phaser scene's state.
     *
     * Three reads composed into one value, and the composition is the contract's:
     * `createVillageNpcSnapshot` applies `selectVillageNearbyTargets` to the
     * measurements, so `nearby` here cannot disagree with `candidates`. Before a
     * scene exists the answer is the empty snapshot - a *value*, not `undefined`, so
     * a panel that polls before readiness renders nothing instead of branching on a
     * missing method.
     */
    readNpcSnapshot(): VillageNpcSnapshot {
      return createVillageNpcSnapshot({
        candidates: scene?.readNpcSnapshotCandidates() ?? [],
        // The anchor follows the NPC in range, recomputed from the live camera rather
        // than replayed from the approach, so a panel positioned from the snapshot
        // tracks a wandering villager. `village:npc-dialog-position` still fires once
        // per approach exactly as before.
        anchor: scene?.readNpcDialogAnchor() ?? null,
      });
    },

    /**
     * The one route from a DOM control into the Phaser village.
     *
     * Phaser has no host-side dispatcher the way the Pixi host does, so the equivalent
     * of "one action" here is the scene's own `triggerInteract` family - the same
     * function the touch button and the `E` key already call. A named target is
     * honoured when it is in range and otherwise falls back to that bare verb, which
     * `VillageActionInvocation` explicitly permits.
     *
     * An unrecognised action id is ignored rather than forced through: the scene owns
     * the action table, and a second one here would be a second source of truth.
     */
    invokeAction(invocation: VillageActionInvocation): void {
      if (invocation.actionId !== VILLAGE_ACTION_INTERACT) return;
      scene?.triggerInteractWithTarget(invocation.target);
    },

    fishing(): PhaserFishingRenderer {
      return fishing;
    },
  };
}
