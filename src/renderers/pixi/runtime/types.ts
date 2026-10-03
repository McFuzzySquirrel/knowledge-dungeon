/**
 * The renderer-neutral half of the PixiJS host.
 *
 * ## What this module is for
 *
 * Plan section 6.1 says neither `src/core/` nor a renderer-neutral application
 * module may import Phaser or PixiJS, and Phase 9's non-goals keep Village,
 * dungeon, and fishing out of this phase. What is left is the *host*: a lifecycle
 * that owns a renderer, a canvas, a ticker, and a teardown, plus a mirror of every
 * world interaction in real DOM controls.
 *
 * This module declares the vocabulary that lifecycle is written in. It names no
 * PixiJS type, imports no renderer, and touches no DOM global at module scope, so
 * every policy that does not need a canvas can be exercised in a realm that has
 * none - which is what the phase exit criterion about reduced motion asks for.
 *
 * ## Where the concrete binding stops
 *
 * The PixiJS `Application` appears in exactly one module,
 * `createPixiApplication.ts`. Everything above it speaks {@link WorldApplication},
 * an interface that a WebGL renderer, a Canvas2D renderer, or a test double all
 * satisfy, and the world host is generic over that application type so a scene
 * factory can still reach the real object without the contract layer naming it.
 * The stop is enforced three ways rather than by convention: `no-restricted-imports`
 * in `eslint.config.js` covers the renderer-neutral application layers, the
 * `createPixiApplication` module is the only file in this tree that imports
 * `pixi.js`, and `tests/phase9/pixi-host-boundary.test.ts` walks the import graph
 * to prove it.
 */

// The one intra-tree dependency, and it is a *type* import: the host's options
// name the Cozy theme, while the theme module knows nothing about the host. One
// direction, no cycle, and nothing at run time is pulled in from here.
import type { WorldRenderer } from '@/application/contracts/renderer';

import type { CozyWorldTheme } from './cozyWorldTheme';
import type { CozyMotionProfile } from '@/theme';

export type { CozyWorldTheme };

/** Which quality profile the host is running. */
export type WorldQualityId = 'high' | 'balanced' | 'constrained';

/** A renderer preference, in PixiJS's own vocabulary. */
export type WorldRendererPreference = 'webgl' | 'webgpu' | 'canvas';

/**
 * The numeric knobs a constrained device gets, resolved once per mount.
 *
 * Plan section 10.2 asks for "lower resolution and antialiasing profiles for
 * constrained devices", so the three fields that cost pixels are a single named
 * profile rather than three flags a caller can set independently. `maxFps` is a
 * ceiling in frames per second, and `0` means the ticker is uncapped - which is
 * what the `high` profile uses, because capping a desktop browser to a profile
 * number would throw away frames for no measured reason.
 */
export interface WorldQualityProfile {
  readonly id: WorldQualityId;
  /** Backing-store pixels per CSS pixel. Capped from the device's own ratio. */
  readonly resolution: number;
  readonly antialias: boolean;
  readonly maxFps: number;
  /** Renderer preference. A single value, so Pixi's own fallback chain applies. */
  readonly preference: WorldRendererPreference;
}

/**
 * The three profiles, as plain frozen data.
 *
 * `balanced` is the default because it is the one that is defensible without a
 * measurement: device-pixel resolution up to 2, antialiasing on, uncapped frame
 * rate, WebGL preferred. `constrained` is the phone profile, where the backing
 * store is what costs the most: at a device-pixel ratio of 2, resolution 1 is a
 * quarter of the pixels, and a 30 FPS ceiling stops a thermal throttle from turning
 * into a visible stutter.
 *
 * `high` currently resolves to the same rendering as `balanced`, and that is
 * deliberate rather than unfinished: a profile that raised the backing store above a
 * device-pixel ratio of 2 would quadruple the memory for a difference no one has
 * measured, and a profile that raised the frame cap above "uncapped" would raise
 * nothing. It exists so a caller can *name* the choice, so the heuristic has a place
 * to promote a device into, and so a later phase with a real frame-time budget can
 * give it content. Inventing a difference here would be a claim with no evidence
 * behind it, which is the thing Phase 10's measurement exists to avoid.
 */
export const WORLD_QUALITY_PROFILES: Readonly<Record<WorldQualityId, WorldQualityProfile>> =
  Object.freeze({
    high: Object.freeze({
      id: 'high',
      resolution: 2,
      antialias: true,
      maxFps: 0,
      preference: 'webgl',
    }),
    balanced: Object.freeze({
      id: 'balanced',
      resolution: 2,
      antialias: true,
      maxFps: 0,
      preference: 'webgl',
    }),
    constrained: Object.freeze({
      id: 'constrained',
      resolution: 1,
      antialias: false,
      maxFps: 30,
      preference: 'webgl',
    }),
  });

/** The profile used when the caller does not choose. */
export const DEFAULT_WORLD_QUALITY_ID: WorldQualityId = 'balanced';

/**
 * The profile a named id means, for any value a caller can hold.
 *
 * Total over `string | null | undefined` for the same reason
 * `resolveMotionProfile` is total over its boolean: a renderer host reads this from
 * a media query, a persisted preference, or a build-time flag, and a name that is
 * not in the table must land on a defined profile rather than on `undefined`,
 * which would be read as a missing object three property reads later.
 *
 * `Object.hasOwn` rather than an index, because an inherited key such as
 * `constructor` would otherwise resolve to something that is not a profile.
 */
export function resolveWorldQualityProfile(id: string | null | undefined): WorldQualityProfile {
  if (typeof id === 'string' && Object.hasOwn(WORLD_QUALITY_PROFILES, id)) {
    return WORLD_QUALITY_PROFILES[id as WorldQualityId];
  }
  return WORLD_QUALITY_PROFILES[DEFAULT_WORLD_QUALITY_ID];
}

/* -------------------------------------------------------------------------- */
/* The application seam                                                        */
/* -------------------------------------------------------------------------- */

/** What the host needs to create a renderer. */
export interface WorldApplicationSpec {
  /**
   * The canvas the renderer draws into.
   *
   * Supplied by the caller rather than created by the renderer, for two reasons:
   * the host appends it into a host element the caller owns, so the canvas never
   * reaches `document.body` by default; and a caller that supplies a canvas can
   * put `aria-hidden` and a focus policy on it before anything renders into it.
   */
  readonly canvas: HTMLCanvasElement;
  readonly quality: WorldQualityProfile;
  /** Canvas clear colour, as the numeric form a Cozy token converts to. */
  readonly background: number;
  readonly backgroundAlpha: number;
}

/**
 * The renderer lifecycle, with no renderer in it.
 *
 * Deliberately narrow. Everything a PixiJS `Application` offers and a world host
 * does not need is absent on purpose, because every member here is a member a test
 * double has to implement and a reviewer has to reason about - and each one is a
 * thing teardown has to get right.
 *
 * The single exception is {@link WorldApplication.native}, which is not a lifecycle
 * member at all: it is the escape hatch that lets the one layer above this one - the
 * composition root, which is the only place allowed to know which engine is bound -
 * hand a *real* engine object to a scene, without this port naming that engine and
 * without a cast inventing one. See its own documentation for why it is `unknown`
 * and for what a scene factory must do with it.
 */
export interface WorldApplication {
  /** The canvas the renderer draws into. */
  readonly canvas: HTMLCanvasElement;
  /** Visible size in CSS pixels, after any resize the host has asked for. */
  readonly screenWidth: number;
  readonly screenHeight: number;
  /** True while the private ticker is running. */
  readonly tickerRunning: boolean;
  /**
   * The engine's own application object, or `null` where there is no engine.
   *
   * ## Why this exists
   *
   * A scene draws display objects: it needs a root it can add children to and a
   * surface size. Neither is on the lifecycle above, because the lifecycle is about
   * starting and stopping a renderer rather than about drawing into one. The two
   * options are to put drawing members on the port, or to give the port an opaque
   * handle. The opaque handle is the one taken, for two reasons.
   *
   * First, it is honest. `stage` and `screen` on a renderer-neutral port would say
   * "every renderer in this application has a scene graph", which is a claim about
   * a Canvas2D binding and a WebGPU binding that this interface cannot make. An
   * `unknown` makes no claim at all: it says there is an object behind the facade,
   * and leaves what it *is* to the module that put it there.
   *
   * Second, it is checkable. The composition root narrows it with a real test rather
   * than with an assertion - `asPixiApplication` in `createPixiApplication.ts`
   * throws unless the value really is a PixiJS `Application`. A facade that was
   * never given an engine therefore fails at the binding, in one line, with a
   * sentence naming the cause; it cannot reach a scene as an object that merely
   * claims to be one.
   *
   * A double with no engine underneath sets this to `null`, which is the same thing
   * said plainly: there is nothing here to narrow.
   */
  readonly native: unknown;
  /** Resize the drawing surface. Width and height are CSS pixels. */
  resize(width: number, height: number): void;
  startTicker(): void;
  stopTicker(): void;
  /**
   * Subscribe to a frame. Returns the unsubscribe function.
   *
   * A delta in milliseconds rather than a ticker object, so a scene written against
   * this interface cannot accidentally read the v7 `ticker.deltaTime` shape - the
   * one migration mistake that type-checks and produces `NaN` in motion.
   */
  onFrame(listener: (deltaMs: number) => void): () => void;
  destroy(options: WorldApplicationDestroyOptions): void;
}

/** How far teardown reaches into renderer-wide state. */
export interface WorldApplicationDestroyOptions {
  /**
   * Whether to drain the renderer's process-wide resource pools.
   *
   * Correct for this host and wrong for a host that shares a renderer with
   * another live application, which is why it is an option rather than a fixed
   * behaviour. See `createPixiApplication.ts` for why the Phase 9 default is
   * `true`.
   */
  readonly releaseGlobalResources: boolean;
}

/** Creates the renderer for one mount. */
export type WorldApplicationFactory = (spec: WorldApplicationSpec) => Promise<WorldApplication>;

/* -------------------------------------------------------------------------- */
/* The world seam                                                              */
/* -------------------------------------------------------------------------- */

/** Which input path performed an action. Reported to the scene, never branched on. */
export type WorldActionSource = 'keyboard' | 'pointer' | 'dom';

/**
 * One interaction the world offers, and the DOM control that mirrors it.
 *
 * Declared by the scene rather than by the host because the host cannot know what
 * a world can be interacted with, and plan section 10.1 requires "a DOM equivalent
 * for every Pixi interaction" - which is only checkable if the world enumerates its
 * interactions in one place that the canvas path and the DOM path both read.
 *
 * `label` is the accessible name of the mirror control *and* the text drawn on the
 * canvas affordance, so the two cannot describe the same action in two vocabularies.
 */
export interface WorldAction {
  readonly id: string;
  /** Accessible name. Also the canvas label. */
  readonly label: string;
  /** Longer description, for the control's `aria-describedby`. */
  readonly hint: string;
  /**
   * The key that performs this action while the world host has focus, or `null`
   * when the action is pointer-only.
   *
   * Lower-case, single character, so the DOM mirror can put it in the accessible
   * name and a keyboard user can discover it rather than guess it.
   */
  readonly keyboardKey: string | null;
  /** Whether the canvas draws a pointer target for this action. */
  readonly pointer: boolean;
}

/** A plain status string per action id, for the DOM mirror's non-colour state. */
export type WorldActionState = Readonly<Record<string, string>>;

/**
 * The one function a scene may call to make the world do something.
 *
 * It is the host's, not the scene's, and that ownership is the whole point. A scene
 * can *ask*; only the host can *answer*, and answering is what also republishes the
 * state to every `onState` listener - the per-control `aria-live` line that is the
 * only way a screen-reader user learns what the world just did.
 *
 * ## Why this is not `activate` handed to the scene
 *
 * Because a scene holding its own `activate` can call it directly. The Phase 9 test
 * world's bell did exactly that: its `pointertap` handler called its local `activate`,
 * the bell rang, the world changed, and nothing reached the host - so the DOM mirror
 * kept announcing the state from before the tap and the next control click jumped to
 * a count the learner never saw happen. Two real taps on the bell read `Bell quiet`
 * on the mirror and then `Bell rung 3 times` after one click. It is recorded here
 * because the alternative - "all three input paths call the same function" - is
 * exactly the claim that was false, and a claim that is false in a comment is worse
 * than no claim.
 *
 * So the rule is: **a scene never holds a reference to its own action verb.** Every
 * canvas-initiated interaction calls `init.onAction`, the host performs the action
 * and publishes in the same function, and there is no second route. The gates for
 * that are `tests/phase9/pixi-dispatch-ownership.test.ts` (the host hands out one
 * dispatcher, never two, and nothing in `src/renderers/**` calls `activate` but the
 * host), `tests/phase9/pixi-composition-root.test.tsx` (a real `pointerdown` and
 * `pointerup` on the real canvas change the mirror's text), and
 * `tests/phase9/browser/pixi-canvas-pointer.spec.ts` (the same in a real browser).
 */
export type WorldActionDispatcher = (actionId: string, source: WorldActionSource) => void;

/** How a scene is told to rebuild itself. */
export interface WorldSceneInit {
  /**
   * The Cozy tokens, already numbers.
   *
   * A renderer never sees a CSS length, so there is no `parseFloat` in a scene and
   * no way for a unit assumption to hide in one. See `cozyWorldTheme.ts`.
   */
  readonly theme: CozyWorldTheme;
  readonly quality: WorldQualityProfile;
  /**
   * Perform an action, and publish the state that results.
   *
   * Required rather than optional, so a scene cannot be built at all without a route
   * through the host - and so "a pointer target calls the host" is a type-level fact
   * rather than a reviewer's memory. See {@link WorldActionDispatcher}.
   */
  readonly onAction: WorldActionDispatcher;
  /**
   * Publish the current state, for a change that was not an action.
   *
   * ## Why this exists, and when it is the wrong call
   *
   * The host already publishes after every dispatch, so anything a learner *does* is
   * announced without a scene asking. What it cannot see is a change the world made to
   * itself: a scene that walked the player into a room, or whose camera the learner
   * pinched, changes what its status sentences say, and nothing about that passes
   * through `onAction`.
   *
   * The dungeon is the case that made this necessary, and the failure it fixes is worse
   * than a missing announcement: availability is part of the sentence, so a stale publish
   * leaves a control *disabled* with on-page text saying the opposite of the truth. A
   * learner walks into a room with stairs and is told there are no stairs.
   *
   * Three rules, and the third is the one that matters:
   *
   * 1. **Call it on change, never per frame.** The dungeon calls it on the branch where
   *    `currentRoomId` changes and after a zoom gesture. A scene that called it every
   *    `update` would re-render every `aria-live` region sixty times a second and turn a
   *    screen reader into a machine-gun.
   * 2. **Do not call it for an action.** `onAction` already publishes; a scene that also
   *    called this on the same event would deliver the same state twice.
   * 3. **It is optional.** A scene with nothing to announce - the Phase 9 test world's
   *    state changes only through its own actions - omits it, and `undefined` is a normal
   *    value rather than a silent failure.
   */
  readonly publishState?: () => void;
}

/**
 * The renderable world, with no renderer in it.
 *
 * ## `activate` is the host's to call, not the scene's
 *
 * `activate` is the *only* way into a world action, and only the host calls it: the
 * canvas keyboard handler, the canvas pointer handler, and the DOM mirror control all
 * converge on the host's one dispatch, which calls `activate` and republishes the
 * state on the next line. A scene reaches that dispatch through
 * {@link WorldSceneInit.onAction} and through nothing else.
 *
 * This wording used to claim that "this phase's gates assert that mapping rather than
 * trusting it", and the gates did not exist - the only pointer test was a synthetic
 * `emit` on the scene's own emitter, which never entered Pixi's event system and
 * never reached the host. The mapping is now asserted three times over, in the places
 * named on {@link WorldActionDispatcher}.
 */
export interface WorldScene<TCapabilities = unknown> {
  /** Every action, in the order the DOM mirror renders them. */
  readonly actions: readonly WorldAction[];
  /**
   * Perform an action. Returns whether the action existed, so an unknown id from a
   * stale mirror control is a no-op rather than a crash.
   *
   * Called by the host's dispatch and by nothing else. A scene must not keep a
   * reference to its own implementation of this: that is the route that changed the
   * world without publishing, and {@link WorldSceneInit.onAction} exists to close it.
   */
  activate(actionId: string, source: WorldActionSource): boolean;
  /** Per-action status, read after every change so the mirror can announce it. */
  readState(): WorldActionState;
  /** Per-frame update. Delta is milliseconds. */
  update(deltaMs: number): void;
  /** The drawing surface changed size. Width and height are CSS pixels. */
  onResize(width: number, height: number): void;
  /**
   * Apply a live `prefers-reduced-motion` change.
   *
   * Called by the host, not by the scene, because the profile is the host's to
   * resolve and the *effect* is the scene's. A scene that animates reads
   * `profile.travelPx` and `profile.durationMs` on the next frame and gets `0`,
   * so no scene has to re-derive the policy for itself - and one that keeps no
   * animation at all may simply omit this.
   */
  setMotionProfile?(profile: CozyMotionProfile): void;
  /**
   * The capability port this world implements, for a host that binds
   * `DungeonRendererCapabilities` and friends.
   *
   * Declared here so Phase 11, 13, and 17 can bind an existing contract port
   * without reshaping this lifecycle: the host forwards `scene.capabilities`
   * unchanged, and a screen that already speaks the port keeps speaking it.
   */
  readonly capabilities?: TCapabilities;
  /** Release every display object, texture, and listener the scene created. */
  destroy(): void;
}

/** Builds the scene for one application instance. */
export type WorldSceneFactory<
  TApplication,
  TScene extends WorldScene<unknown>,
> = (application: TApplication, init: WorldSceneInit) => TScene;

/* -------------------------------------------------------------------------- */
/* The environment seam                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The three things a world host observes about its environment.
 *
 * Split out as an interface for the reason plan section 10.2 and section 10.1 name
 * separately: the *policy* - pause the ticker, scale motion to zero - is fixed
 * here, while the *observation* is the caller's, and the caller may be a browser,
 * a worker, or a test. A host that read `window.matchMedia` itself could not be
 * exercised outside a DOM at all.
 */
export interface WorldEnvironment {
  /** The current `prefers-reduced-motion` state. */
  reducedMotion(): boolean;
  /** Whether the document is hidden right now. */
  hidden(): boolean;
  /** Subscribe to `prefers-reduced-motion` changes. Returns the unsubscribe. */
  observeReducedMotion(listener: (reduced: boolean) => void): () => void;
  /** Subscribe to document visibility changes. Returns the unsubscribe. */
  observeVisibility(listener: (hidden: boolean) => void): () => void;
  /** Subscribe to size changes of an element. Returns the unsubscribe. */
  observeSize(
    element: HTMLElement,
    listener: (width: number, height: number) => void,
  ): () => void;
}

/* -------------------------------------------------------------------------- */
/* The host contract                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The world host the application layer holds: `WorldRenderer`'s lifecycle plus the
 * members a React screen needs and the contract does not have.
 *
 * Extends rather than replaces `WorldRenderer`, so a caller that only knows the
 * Phase 2 contract can hold this object and ignore the rest - which is the whole
 * point of the seam. `onReady` is the host-side counterpart of the contract's "first
 * frame" rule: `isReady()` is a poll, and a React screen should not have to poll.
 */
export interface PixiWorldHost<TCapabilities = unknown> extends WorldRenderer {
  /** Attach to the host element and start presenting the world. */
  mount(): Promise<void>;
  /** Detach and release every resource. Safe to call twice, and before mount. */
  unmount(): void;
  /** True once the first frame has been presented. */
  isReady(): boolean;
  /** Rebuild the world in place. */
  restart(): void;
  /**
   * Perform an action the way the DOM mirror does.
   *
   * The host's one dispatch, with `source: 'dom'` - the same function the canvas
   * keyboard handler and every canvas pointer handler reach through
   * {@link WorldSceneInit.onAction}. It is on the port rather than inlined into a
   * React handler so that "the mirror and the canvas share one path" is a property
   * of this type and not a convention a scene author has to follow.
   */
  activateFromDom(actionId: string): void;
  /** Subscribe to the first-frame notification. Returns the unsubscribe. */
  onReady(listener: () => void): () => void;
  /**
   * Subscribe to per-action state. Fires once as soon as the world is built, and
   * again after every action, so a mirror control can render its status without
   * polling. Returns the unsubscribe.
   */
  onState(listener: (state: WorldActionState) => void): () => void;
  /**
   * The actions the mounted world offers, in DOM focus order.
   *
   * Empty before mount and after unmount, which is what makes it safe for a mirror
   * to render its controls straight from it.
   */
  readonly actions: readonly WorldAction[];
  /**
   * Apply a live `prefers-reduced-motion` change.
   *
   * Separate from construction because the media query can change while a world is
   * mounted, and a host that only read the preference at mount time would keep
   * animating for a learner who turned it on.
   */
  setReducedMotion(reduced: boolean): void;
  /**
   * The DOM mirror's own container.
   *
   * The host needs it for exactly one reason: to know which keystrokes are already
   * handled by a mirror control, so pressing Enter on a focused mirror button runs
   * its action once rather than twice. Set by the React host, which owns the ref.
   */
  setMirrorElement(element: HTMLElement | null): void;
  /** The capability port the scene exposes, if it exposes one. */
  readonly capabilities: TCapabilities | undefined;
}

/** Options for {@link createWorldHost}. */
export interface CreateWorldHostOptions<
  TApplication extends WorldApplication,
  TScene extends WorldScene<unknown>,
> {
  /** Element the canvas is appended into. Never `document.body`. */
  readonly host: HTMLElement;
  /**
   * Creates the renderer.
   *
   * Typed to return the concrete application type rather than the widest one, so
   * the lifecycle can hold a `TApplication` without casting it back from a port at
   * every use - and so a scene factory's parameter is genuinely the object the
   * binding produced.
   */
  readonly createApplication: (spec: WorldApplicationSpec) => Promise<TApplication>;
  readonly createScene: WorldSceneFactory<TApplication, TScene>;
  readonly theme: CozyWorldTheme;
  readonly quality: WorldQualityProfile;
  /**
   * The observed `prefers-reduced-motion` state at construction.
   *
   * A plain boolean rather than a `MediaQueryList`, because the host owns the
   * policy and the caller owns the observation - and because a plain boolean is
   * the only form a realm with no DOM can supply.
   */
  readonly reducedMotion: boolean;
  /**
   * Whether teardown drains the renderer's process-wide pools.
   *
   * `true` by default: the host is the only renderer in the application, and a
   * mount/unmount loop that keeps its pooled batches and shader programs is the
   * leak plan section 10.2's twenty-cycle criterion is about.
   */
  readonly releaseGlobalResources?: boolean;
  readonly environment: WorldEnvironment;
}
