/**
 * The PixiJS fishing renderer: the composition root, and the narrow port a screen drives.
 *
 * ## What this module is
 *
 * It is two things that belong together and nothing else:
 *
 * 1. **`createPixiFishingRenderer`** - the composition root for one fishing world. It
 *    assembles the pieces a caller should not have to know about (the PixiJS application
 *    binding, the renderer-neutral world host, the Phase 10 asset loader, and the Cozy
 *    theme) and returns the contract the application layer already speaks: the
 *    `WorldRenderer` lifecycle plus {@link FishingController}.
 * 2. **The port declarations** - {@link FishingReadout}, {@link FishingCatchReveal},
 *    {@link FishingScenePort}, and {@link FishingController} - which are *this file's*
 *    declarations, not a re-export of a shared one.
 *
 * ## Why the port is declared here rather than in `src/application/contracts/renderer.ts`
 *
 * `FishingRendererCapabilities` already exists and this renderer implements all three of
 * its members. It is deliberately **not** the type the screen drives, and the reason is
 * the defect `VillageWorld.tsx`'s header documents: typed against the broad structural
 * base, that component's object literal compiled while silently omitting `readNpcSnapshot`
 * and `invokeAction`, and a nearby-action panel feature-detected `undefined` and rendered
 * its rows permanently disabled - with no type error anywhere and nothing in the build to
 * say so. A narrow, explicitly declared port turns a missing member into a `typecheck`
 * failure.
 *
 * So {@link FishingController} is a **superset with nothing optional**: every
 * learner-triggerable transition the machine accepts is a named method, plus the two
 * lifecycle reads a React screen needs (`isReady`, `destroy`) and two subscriptions. A
 * capability added here and implemented by only the renderer fails `npm run typecheck` at
 * the object literal below, and a screen that omits one fails at its own handle literal.
 * `src/application/contracts/**` is not edited by this phase, so the superset lives here;
 * the prompt for a later cut-over is that it belongs in the contract once the Phaser
 * adapter is removed.
 *
 * ## Every learner-triggerable transition has a method, and no control has a duplicate
 *
 * The state machine's header tabulates the six learner actions, and this port carries one
 * method each:
 *
 * | Method       | Machine event | Legal from        | To        |
 * |--------------|---------------|-------------------|-----------|
 * | `beginPower` | `begin-power` | `idle`            | `powering` |
 * | `release`    | `release`     | `powering`        | `casting` |
 * | `hook`       | `hook`        | `biting`          | `reeling` |
 * | `reset`      | `reset`       | `caught`,`missed` | `idle`     |
 * | `move`       | `move`        | `idle`,`caught`,`missed` | same |
 *
 * `tick` and `resize` are not learner actions; `resize` is on the port as a forced layout
 * and routes into the same place the host's own observer does.
 *
 * ## The audio hook mapping
 *
 * The machine **names** six hooks and plays nothing. The mapping from a hook to a sound is
 * the one `fishingStateMachine.ts`'s own header tabulates against `FishingScene`'s
 * `audioManager.playSfx` calls, and it is applied here rather than in the scene, for two
 * reasons: the scene must stay a presenter with no audio implementation import, and this
 * is the composition root, which is the layer whose job is wiring a service into a world.
 *
 * The service is `src/services/audioManager.ts` - **not** a renderer-private path. Its own
 * header states that it is "the single renderer-neutral entry point for sound" and that "a
 * Pixi world and a React DOM screen call the same methods", naming Phase 17 among the
 * worlds it is for. It is gesture-gated by construction, so a hook emitted before the
 * learner's first gesture is dropped rather than queued, which is the documented policy
 * for SFX. A caller may pass `playAudioHook` to replace it, which is what the parity tests
 * do.
 *
 * ## Nothing here awards a catch
 *
 * This module forwards a reveal and nothing more. `src/application/fishingCommands.ts` and
 * `src/store/fishingCommands.ts` are the catch transaction - the idempotent operation that
 * awards fish, XP, and badges exactly once - and a renderer reaching either of them would be
 * a third writer of progression outside that transaction, deciding from inside a frame
 * callback where "awarded once" has no meaning. `FishingCatchReveal` exists so the *screen*
 * can hand the catch to that transaction; the pond's job ends at forwarding it.
 * `tests/phase17/fishing-renderer-boundary.test.ts` is the gate.
 *
 * ## No learner data
 *
 * Nothing here reads a store, names a subject, or logs. The only identifier that crosses
 * this boundary is the canonical `catalogId` the machine minted from `FISH_CATALOG`, which
 * is catalog content and is why {@link FishingCatchReveal} carries no display name: the
 * DOM resolves the name from the catalog, and nothing is keyed on it.
 */
import { createAssetLoader } from '@/renderers/pixi/assets/AssetLoader';
import {
  asPixiApplication,
  createPixiApplication,
  createPixiAssetRuntime,
} from '@/renderers/pixi/runtime/createPixiApplication';
import { createPixiWorldHost } from '@/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { WorldRenderer } from '@/application/contracts/renderer';
import type { PlayerClassId } from '@/application/contracts/world';
import type { FishingWorldModel } from '@/application/contracts/world';
import {
  resolveWorldQualityProfile,
  type WorldApplication,
  type WorldQualityId,
} from '@/renderers/pixi/runtime/types';
import { readWorldQuality } from '@/renderers/pixi/runtime/useWorldQuality';
import { currentWorldEnvironment } from '@/renderers/pixi/runtime/worldEnvironment';
import { audioManager } from '@/services/audioManager';
import type { SfxKind } from '@/services/audioManager';
import type { FishingAudioHook, FishingStateName } from '@/core/fishing/fishingStateMachine';
import type { FishRarity } from '@/core/fishing/fishingTypes';
import {
  createFishingScene,
  type CreateFishingSceneOptions,
  type FishingScene,
  type FishingScenePresentation,
} from './createFishingScene';

/* -------------------------------------------------------------------------- */
/* Audio                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Each hook, and the sound the rollback lane played for it.
 *
 * Verbatim from `fishingStateMachine.ts`'s own table, which is verbatim from
 * `FishingScene`'s six `audioManager.playSfx` calls. Exported so the mapping is one table
 * that a test can assert against rather than six calls that have to be read.
 */
export const FISHING_AUDIO_HOOK_SFX: Readonly<Record<FishingAudioHook, SfxKind>> = Object.freeze({
  cast: 'fish-cast',
  splash: 'fish-splash',
  bite: 'fish-bite',
  'reel-in': 'fish-reel',
  catch: 'fish-catch',
  miss: 'fish-miss',
});

/**
 * The default hook player: Phase 10's renderer-neutral audio service.
 *
 * A module-level function rather than an inline closure so a caller can compare it, and so
 * the service is touched in exactly one place in this file.
 */
export function playFishingAudioHook(hook: FishingAudioHook): void {
  audioManager.playSfx(FISHING_AUDIO_HOOK_SFX[hook]);
}

/* -------------------------------------------------------------------------- */
/* The port                                                                    */
/* -------------------------------------------------------------------------- */

/** The learner's walking intent. `-1`, `0`, `1`, exactly as the machine's `move` event. */
export type FishingMoveIntent = -1 | 0 | 1;

/**
 * Everything a DOM surface needs to mirror the pond, as one frozen value.
 *
 * Facts only. No instructional copy - plan section 6.2 gives that to React DOM, and
 * `fishingPhaseHint` is the machine's shared starting point, imported from the machine
 * rather than smuggled through here.
 */
export interface FishingReadout {
  /** Which of the eight cast phases the session is in. */
  readonly phase: FishingStateName;
  /** Cast charge, `0`..`1`. Also the power meter's width. */
  readonly power: number;
  /** Whether `reset` would be accepted, so a control can disable itself. */
  readonly canReset: boolean;
  /** Whether this subject may be fished at all. */
  readonly eligible: boolean;
  /** The held walking intent. */
  readonly moveIntent: FishingMoveIntent;
  /** Which way the angler faces. Sticky: no intent keeps the last facing. */
  readonly facing: 'left' | 'right';
  /** Casts started this session, one-based for the cast in flight. Never rewound. */
  readonly castNumber: number;
  /** Fish kept in this session's bucket. */
  readonly caughtCount: number;
}

/**
 * A catch, as the machine revealed it.
 *
 * The `catch-revealed` effect verbatim: a canonical `catalogId`, the rarity, the one-based
 * cast number that half-identifies the catch with the session, and the catalogue
 * description. **No display name** - `ui-engineer` resolves it from `FISH_CATALOG`, and a
 * display name must never be keyed on.
 */
export interface FishingCatchReveal {
  readonly catalogId: string;
  readonly rarity: FishRarity;
  readonly castNumber: number;
  readonly description: string;
}

/**
 * The capability port the scene itself implements.
 *
 * Everything a DOM control can reach, and nothing about pixels. `readPresentation` is the
 * one exception and it exists for verification: it is a read of the scene graph, so a test
 * can ask whether the renderer drew what the machine said rather than whether it copied
 * the state.
 */
export interface FishingScenePort {
  /** Learner action 1. Legal in `idle` only. */
  beginPower(): void;
  /** Learner action 3. The release of the hold `beginPower` began. */
  release(): void;
  /** Learner action 4. Legal in `biting`, inside the window. */
  hook(): void;
  /** Learner action 5 and 6. Legal in `caught` and `missed` only. */
  reset(): void;
  /** Learner action 2. A held walking intent. */
  move(intent: FishingMoveIntent): void;
  /** Force a layout, in CSS pixels. The host's own observer takes the same route. */
  resize(width: number, height: number): void;
  /** The current readout. Total: before mount it reads {@link FISHING_IDLE_READOUT}. */
  readReadout(): FishingReadout;
  /** What the pond is currently drawing, for a verification lane. */
  readPresentation(): FishingScenePresentation;
  /** Subscribe to phase changes. Never fires per frame. Returns the unsubscribe. */
  onPhase(listener: (readout: FishingReadout) => void): () => void;
  /** Subscribe to revealed catches. Returns the unsubscribe. */
  onCatchRevealed(listener: (reveal: FishingCatchReveal) => void): () => void;
  /** Fish kept in this session's bucket. `FishingRendererCapabilities`. */
  getCaughtCount(): number;
  /**
   * Update the study archetype used for the angler. `FishingRendererCapabilities`.
   *
   * Implemented as a no-op in the Pixi scene because the pond draws its angler
   * procedurally and reads no archetype; kept on the port so both adapters present the
   * same capability set and a screen need not feature-detect it.
   */
  setPlayerClass(playerClass: PlayerClassId | null): void;
  /** Leave the pond for the village. `FishingRendererCapabilities`. */
  returnToVillage(): void;
}

/**
 * What a screen drives.
 *
 * {@link FishingScenePort} plus the two lifecycle reads a React screen needs. Declared
 * narrowly and explicitly for the reason `VillageWorld.tsx`'s header records: a
 * structurally-typed handle silently omitted a member once, and a panel feature-detected
 * `undefined` and rendered itself permanently disabled with no type error anywhere.
 */
export interface FishingController extends FishingScenePort {
  /** True once the first frame has been presented. */
  isReady(): boolean;
  /**
   * Release this controller: the scene, the renderer, the canvas, the ticker, and the
   * asset bundle.
   *
   * The same teardown as `WorldRenderer.unmount`, under the name a screen reaches for, and
   * idempotent: React runs mount effects twice under StrictMode and a screen may unmount
   * while `app.init()` is still negotiating a GPU context. `FishingWorld` calls this and
   * never `unmount`, so the component has exactly one teardown path.
   */
  destroy(): void;
}

/**
 * The readout a caller gets before the scene exists, and after it is gone.
 *
 * Frozen and shared rather than allocated per call, for `createVillageRenderer`'s reason: a
 * HUD that polls at 60 fps would otherwise allocate sixty objects a second to learn nothing
 * had changed. This is also what makes `readReadout` *total* - a value, never `undefined` -
 * so a DOM surface renders a sentence before the world exists instead of branching on a
 * missing method.
 */
export const FISHING_IDLE_READOUT: FishingReadout = Object.freeze({
  phase: 'idle',
  power: 0,
  canReset: false,
  eligible: false,
  moveIntent: 0,
  facing: 'right',
  castNumber: 0,
  caughtCount: 0,
});

/**
 * What the pond is drawing before a scene exists: nothing.
 *
 * Frozen and shared for {@link FISHING_IDLE_READOUT}'s reason, and total for the same
 * reason - a verification lane that polls before mount gets a value rather than a
 * `TypeError` on a missing method.
 */
export const FISHING_IDLE_PRESENTATION: FishingScenePresentation = Object.freeze({
  phase: 'idle',
  bobber: Object.freeze({ x: 0, y: 0, visible: false }),
  fish: Object.freeze({ x: 0, y: 0, visible: false }),
  lineVisible: false,
  powerBarVisible: false,
  bucketCount: 0,
});

/* -------------------------------------------------------------------------- */
/* The renderer                                                                */
/* -------------------------------------------------------------------------- */

/** Everything the renderer needs to present one fishing world. */
export interface CreatePixiFishingRendererOptions {
  /** Element the canvas is appended to. Never `document.body`. */
  readonly host: HTMLElement;
  /** Renderer-neutral model: archetype, eligibility, and subject context. */
  readonly world: FishingWorldModel;
  /** Leave the pond for the village. Bound by the host, not by the scene. */
  readonly onReturnToVillage: () => void;
  /**
   * Play one audio hook. Defaults to Phase 10's `audioManager`.
   *
   * Present as an option so a test can record the hook sequence without an audio device,
   * and so a build with its own sound policy has one place to say so.
   */
  readonly playAudioHook?: (hook: FishingAudioHook) => void;
  /** A Cozy theme name, or a persisted legacy colour-theme string. */
  readonly colorTheme?: string | null;
  /** A pinned quality profile. Absent lets the device heuristic decide. */
  readonly quality?: WorldQualityId | null;
  /**
   * Scene inputs forwarded verbatim, for a reproducible session.
   *
   * `CreateFishingSceneOptions` without `world` and `callbacks`, which this function owns.
   * A parity test passes `sessionDate`, `cosmeticRng`, and `nowMs` so a run is
   * byte-reproducible and a frame is a stated number of milliseconds.
   */
  readonly scene?: Omit<CreateFishingSceneOptions, 'world' | 'callbacks'>;
}

/** The fishing renderer as the application layer sees it. */
export interface PixiFishingRenderer extends WorldRenderer, FishingController {
  /** Subscribe to the first-frame notification. Returns the unsubscribe function. */
  onReady(listener: () => void): () => void;
}

/**
 * Build the PixiJS fishing renderer.
 *
 * Inert until {@link PixiFishingRenderer.mount} is called, so a host can subscribe to
 * readiness and set its DOM mirror first.
 */
export function createPixiFishingRenderer(
  options: CreatePixiFishingRendererOptions,
): PixiFishingRenderer {
  const observed = readWorldQuality();
  const quality = resolveWorldQualityProfile(options.quality ?? observed.profile.id);
  const theme = resolveCozyWorldTheme({
    theme: options.colorTheme ?? null,
    reducedMotion: observed.reducedMotion,
  });
  const playHook = options.playAudioHook ?? playFishingAudioHook;
  const callbacks = { onAudioHook: playHook, onReturnToVillage: options.onReturnToVillage };

  // One loader per mount, created lazily and disposed on unmount, for the reason
  // `createPixiVillageRenderer` documents: a single loader shared across a StrictMode
  // mount/unmount/mount would have a `dispose` in flight when the second `loadBundle`
  // starts.
  let loader: ReturnType<typeof createAssetLoader> | null = null;
  let bundleHeld = false;
  let scene: FishingScene | null = null;

  // The renderer owns its own listener sets, and the scene forwards into them.
  //
  // The reason is lifetime, and it is the same reason `PixiDungeonRenderer` holds `scene`:
  // a subscription taken before the scene exists, or one taken before a `restart()` that
  // replaced the scene, would otherwise die with the object it was attached to. One set
  // here means a host can subscribe once, before `mount()`, and keep receiving.
  const phaseListeners = new Set<(readout: FishingReadout) => void>();
  const catchListeners = new Set<(reveal: FishingCatchReveal) => void>();

  const host = createPixiWorldHost<WorldApplication, FishingScene, FishingScenePort>({
    host: options.host,
    createApplication: createPixiApplication,
    createScene: (application, init) => {
      const built = createFishingScene(asPixiApplication(application), init, {
        ...options.scene,
        world: options.world,
        callbacks,
      });
      built.capabilities.onPhase((value) => {
        for (const listener of [...phaseListeners]) listener(value);
      });
      built.capabilities.onCatchRevealed((reveal) => {
        for (const listener of [...catchListeners]) listener(reveal);
      });
      scene = built;
      return built;
    },
    theme,
    quality,
    reducedMotion: observed.reducedMotion,
    environment: currentWorldEnvironment(),
  });

  /**
   * The one teardown.
   *
   * Idempotent, because React runs mount effects twice under StrictMode and a screen may
   * unmount while `app.init()` is still negotiating a GPU context - and `host.unmount()`
   * is documented as tearing down whatever is present rather than whatever was present when
   * teardown was scheduled. It also drops the listener sets, so a subscription held by an
   * unmounted component cannot be invoked by a scene that outlived it.
   */
  function teardown(): void {
    host.unmount();
    scene = null;
    phaseListeners.clear();
    catchListeners.clear();
    bundleHeld = false;
    const current = loader;
    loader = null;
    if (current !== null) void current.dispose().catch(() => {});
  }

  return {
    mount(): void {
      if (loader === null) {
        loader = createAssetLoader({ runtime: createPixiAssetRuntime(), theme });
      }
      if (!bundleHeld) {
        bundleHeld = true;
        // The fishing bundle is keys and procedural recipes with no files, so this reads
        // no file and makes no request; it is the lifecycle, not the art.
        void loader.loadBundle('fishing').catch(() => {
          bundleHeld = false;
        });
      }
      // A mount failure is the screen's to show; `onReady` is the success channel and
      // `isReady()` is the poll. The host has already released anything it created before
      // rejecting, so there is nothing here to clean up.
      void host.mount().catch(() => {});
    },

    /**
     * `WorldRenderer.unmount`, and the same work as `destroy`.
     *
     * Two names for one teardown on purpose: a screen holding a `WorldRenderer` sees
     * `unmount`, and `FishingWorld`'s handle is `destroy`. Neither can leave the other with
     * a controller it cannot release.
     */
    unmount: teardown,
    destroy: teardown,

    isReady(): boolean {
      return host.isReady();
    },
    restart(): void {
      host.restart();
    },
    onReady(listener: () => void): () => void {
      return host.onReady(listener);
    },
    beginPower(): void {
      scene?.capabilities.beginPower();
    },
    release(): void {
      scene?.capabilities.release();
    },
    hook(): void {
      scene?.capabilities.hook();
    },
    reset(): void {
      scene?.capabilities.reset();
    },
    move(intent: FishingMoveIntent): void {
      scene?.capabilities.move(intent);
    },
    resize(width: number, height: number): void {
      scene?.capabilities.resize(width, height);
    },
    readReadout(): FishingReadout {
      // Total, before mount and after teardown: the same reason the village's
      // `readNpcSnapshot` answers with the contract's empty snapshot rather than `undefined`.
      return scene?.capabilities.readReadout() ?? FISHING_IDLE_READOUT;
    },
    readPresentation(): FishingScenePresentation {
      return scene?.capabilities.readPresentation() ?? FISHING_IDLE_PRESENTATION;
    },

    /**
     * Subscribe to the readout.
     *
     * Two sources and one channel, which is `PixiDungeonRenderer.onState`'s shape restated:
     * the host publishes once at mount and after every dispatch, and the scene publishes the
     * phase changes it made to *itself* - the landing, the bite, the window expiry, the reel
     * completing - which pass through no dispatch at all. A screen hears the initial state
     * before the first frame and every later phase change, and never hears it per frame.
     */
    onPhase(listener: (readout: FishingReadout) => void): () => void {
      phaseListeners.add(listener);
      const stopHost = host.onState(() => {
        listener(scene?.capabilities.readReadout() ?? FISHING_IDLE_READOUT);
      });
      return () => {
        stopHost();
        phaseListeners.delete(listener);
      };
    },
    onCatchRevealed(listener: (reveal: FishingCatchReveal) => void): () => void {
      catchListeners.add(listener);
      return () => {
        catchListeners.delete(listener);
      };
    },
    getCaughtCount(): number {
      return scene?.capabilities.getCaughtCount() ?? 0;
    },
    setPlayerClass(playerClass: PlayerClassId | null): void {
      scene?.capabilities.setPlayerClass(playerClass);
    },
    returnToVillage(): void {
      scene?.capabilities.returnToVillage();
    },
  };
}