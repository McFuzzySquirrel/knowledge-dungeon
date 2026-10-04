/**
 * The PixiJS fishing world: sky, horizon, water, shore, angler, rod, bobber, line,
 * fish, bucket, and the ambient effects that move them.
 *
 * ## What this scene is, and what it is not allowed to decide
 *
 * It is a **presenter**. Every fishing decision - which cast phase the session is in,
 * whether an event is legal, which fish bites, when it is close enough to strike, when
 * a window expires, and which audio hook should be heard - belongs to
 * `src/core/fishing/fishingStateMachine.ts` and to nothing else. This file owns the
 * display objects and translates one `FishingMachineState` into pixels.
 *
 * That is a stricter rule than "do not duplicate the obvious", and the parts of this
 * scene that look like rules are the parts worth naming:
 *
 * - **There is no second bite timer.** `biting` ends because the machine's
 *   `biteWindowDeadlineMs` passed on a tick this scene emitted.
 * - **There is no second proximity test.** `waiting` becomes `biting` because the
 *   machine measured the fish against the bobber. This scene never measures a distance.
 * - **There is no second power curve.** `power` is read from the state every frame.
 * - **There is no second cast ballistics.** The bobber's position is read from the
 *   state; this scene integrates nothing.
 * - **There is no eligibility rule.** `eligible` is a construction input the application
 *   layer computed; `studyFlow.enterFishing` applied `isFishingEligible` before the world
 *   was handed over.
 * - **The catch is the machine's.** `castNumber`, the catalogue roll, and the rarity all
 *   arrive in `FishingMachineState` or in a `catch-revealed` effect. This scene draws
 *   what it is given and counts what it is told.
 * - **Nothing here awards anything.** A renderer that reached
 *   `src/application/fishingCommands.ts` or `src/store/fishingCommands.ts` to settle a catch
 *   would be a second writer of progression, outside the idempotent transaction the catch is
 *   awarded through - and would be awarding from inside a frame callback, where a retry has no
 *   meaning. The reveal is *forwarded* and the application decides; see
 *   `tests/phase17/fishing-renderer-boundary.test.ts` for the gate that holds this.
 *
 * `tests/phase17/fishing-scene-parity.test.ts` drives a run through this scene and the
 * same run through `reduceFishing` alone and compares them, so a renderer that grew a
 * rule fails there rather than being argued about in review. The strongest form of that
 * check is the one this file is *shaped* for: under `prefers-reduced-motion` the scene
 * applies **no** local animation at all, so every drawn position is the machine's
 * position and the two can be compared value by value.
 *
 * ## What the renderer *does* own, and why each one is presentation
 *
 * Plan section 6.2 gives Pixi "world rendering, camera, navigation visuals, and
 * renderer-local animation". The four things this file animates are all local animation
 * of something the machine has already decided:
 *
 * 1. **The water shimmer, the star twinkle, and the bobber's idle bob.** Ambient motion,
 *    scaled by the Cozy motion profile, so `prefers-reduced-motion` freezes them rather
 *    than merely shortening them.
 * 2. **The reel-in interpolation.** The machine holds the bobber in the water and the
 *    fish at the bite point for the whole of `reeling`, then places both at the rod tip
 *    on the tick that crosses `reelDeadlineMs`. `FishingScene` tweened the two objects
 *    to the tip over `REEL_DURATION_MS`, and the machine deliberately left that to the
 *    renderer. The interpolation is derived from the machine's own deadline -
 *    `1 - (reelDeadlineMs - nowMs) / FISHING_REEL_DURATION_MS` - so there is no second
 *    timer and no second end point. At reduced motion it is not drawn at all.
 * 3. **The flee after a miss.** The machine leaves the fish visible in `missed` and clears
 *    it on `reset`. Which way it swims off is a direction the machine already named in
 *    `fishDirection`, so the renderer reads that rather than choosing.
 * 4. **The landing splash and the bite pulse.** Cosmetic particles off a **separate**
 *    random stream (see below), keyed to the phase entry that produced the audio hook.
 *
 * ## The two random streams, which must not be confused
 *
 * `createFishingSessionRng(date, playerClass)` is the *gameplay* stream and belongs to
 * the machine: its header pins the four-draw order, and a renderer that drew from it
 * would move the catalogue roll by one splash droplet. Every cosmetic random value here -
 * a droplet's offset, a star's phase - comes from `options.cosmeticRng`, which defaults
 * to `Math.random` and is injectable so a test can make a pond byte-reproducible.
 *
 * ## What is drawn, and why it is procedural
 *
 * Every visual is `Graphics`. The legacy SVGs `FishingScene` loaded -
 * `public/assets/sprites/fishing/*.svg`, the village's `tree.svg` and `bush.svg`, and the
 * four directional player sprites - are `legacy-unverified` and are not admitted to a
 * Pixi bundle by the CC0 gate, which is the same finding that made the village
 * procedural. Two consequences worth stating rather than leaving to be discovered:
 *
 * - **A fish silhouette is not per-species.** `FishingScene` switched texture per
 *   catalogue entry. Here one silhouette is drawn and tinted by `rarity`, because rarity
 *   is the one piece of catalogue information the machine hands a renderer and the state
 *   machine's own header anticipates it ("a renderer that draws a rarity's colour needs
 *   the table"). **The species is named in DOM**, by `ui-engineer`, from `FISH_CATALOG`
 *   and the `catalogId` this scene forwards. The tint is decoration and is never the only
 *   statement of what was caught.
 * - **The instructional text is gone from the canvas.** `FishingScene` drew a hint line, a
 *   "Power: [blocks]" read-out, and a "Return to Village" button as canvas text. Plan
 *   6.2 gives educational and instructional text to React DOM, and plan 10.1 requires a
 *   real DOM control for every canvas action. So this scene draws the power meter as a
 *   *shape* - whose width, not whose colour, is the state - and no words at all. The
 *   canvas is `aria-hidden`, so a word drawn on it was never reachable anyway.
 *
 * The top-left pointer exclusion `FishingScene.handlePointerDown` carried
 * (`pointer.y < 36 && pointer.x < 180`) protected an on-canvas Return button. That button
 * is a DOM control now, so the exclusion would be dead space a learner could press into
 * and see nothing happen; it is gone.
 *
 * ## The `pixi.js` importer
 *
 * This file deliberately joins the binding (`createPixiApplication.ts`), the Phase 9 test
 * world, the two village modules, and the three dungeon modules in
 * `tests/phase9/pixi-host-boundary.test.ts`'s enumerated list. The two rejected
 * alternatives are the ones that header already records: widening the renderer-neutral
 * host to hand a scene its display classes, and drawing the pond through a neutral shape
 * abstraction, which would be a second renderer to maintain for one world. The boundary
 * test fails until its list is updated; that is the review.
 *
 * ## Input, and why the shared controller is not used here
 *
 * The keyboard is bound directly (`A`/`Left`/`D`/`Right` held to walk, `Space`/`Enter`
 * pressed for the phase's verb and released to cast) and the pointer is bound to the
 * canvas for a water-area hold. `src/renderers/pixi/input/WorldInputController.ts` is not
 * used, and the reason is specific rather than a preference: that controller's pointer
 * channel is **drag-to-move** and its interact channel is **press-only**, while the cast
 * is a press-and-hold *on the water* whose release is the cast. Binding both would mean
 * one drag across the pond both charged a cast and walked the angler, which is a
 * behaviour `FishingScene` never had. Its `isHandledElsewhere` rule - a keystroke aimed at
 * a text control or at this host's own mirror belongs to that control - *is* reused, from
 * the module that exports it, so "typing a note must not cast a line" is one rule and not
 * two.
 */
import { Container, Graphics } from 'pixi.js';

import {
  canResetFishing,
  createFishingSessionRng,
  createFishingState,
  fishingHorizonY,
  fishingPlayerY,
  fishingRodTip,
  fishingShoreY,
  reduceFishing,
  FISHING_REEL_DURATION_MS,
  type FishingAudioHook,
  type FishingMachineEffect,
  type FishingMachineEvent,
  type FishingMachineState,
  type FishingStateName,
  type FishingViewport,
} from '@/core/fishing/fishingStateMachine';
/**
 * The rarity vocabulary, by type only.
 *
 * A type import rather than a value import, and that is the whole of why: the scene needs to
 * *name* the three rarities to map one to a colour, and needs nothing else from
 * `fishingTypes.ts`. A value import would hand the scene the catalogue as well, and with it
 * every species name - which is catalog content and must never be keyed on, logged, or
 * rendered as a label. The state machine's header anticipates exactly this and re-exports
 * the catalogue for renderers that genuinely need it; this one does not.
 */
import type { FishRarity } from '@/core/fishing/fishingTypes';
import type { PlayerClassId } from '@/application/contracts/world';
import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { PixiApplication } from '@/renderers/pixi/runtime/createPixiApplication';
import { isHandledElsewhere } from '@/renderers/pixi/runtime/createPixiWorldHost';
import type { WorldAction, WorldScene, WorldSceneInit } from '@/renderers/pixi/runtime/types';
import type { CozyMotionProfile } from '@/theme';
import type { FishingCatchReveal, FishingReadout, FishingScenePort } from './FishingController';

/* -------------------------------------------------------------------------- */
/* The actions this world offers                                              */
/* -------------------------------------------------------------------------- */

/** Hold to charge a cast. The press begins it; the release casts. */
export const FISHING_BEGIN_POWER_ACTION_ID = 'fishing-begin-power';
/** Strike at a bite. One press. */
export const FISHING_HOOK_ACTION_ID = 'fishing-hook';
/** Abandon a settled outcome and return to the shore. One press. */
export const FISHING_RESET_ACTION_ID = 'fishing-reset';

/**
 * The learner-triggerable transitions, as the host's action table.
 *
 * **Two machine events are deliberately absent**, and their absence is the point:
 *
 * | Event    | Why it is not an action                                                    |
 * |----------|----------------------------------------------------------------------------|
 * | `release` | the *release* of the hold `fishing-begin-power` began. An action is a press. |
 * | `move`    | a held intent, not a press. `moveIntent` lives in the state and is re-read every frame. |
 *
 * `tick` and `resize` are not actions either; the machine's own header lists them as the
 * two events no learner triggers.
 *
 * `keyboardKey` is `null` on all three, for the reason `VILLAGE_ACTIONS` gives: the
 * binding is a press **and a release**, so one key cannot perform it, and a host shortcut
 * bound to that key would fire the press twice - once from the host's map and once from
 * the handler below. The keyboard surface is the handler; the DOM surface is
 * `ui-engineer`'s hold button.
 *
 * The labels are the accessible names of those DOM mirrors, so the canvas affordance and
 * the button cannot describe one action in two vocabularies.
 */
export const FISHING_ACTIONS: readonly WorldAction[] = Object.freeze([
  Object.freeze({
    id: FISHING_BEGIN_POWER_ACTION_ID,
    label: 'Hold to charge a cast',
    hint: 'Hold to build cast power, then let go to cast the line.',
    keyboardKey: null,
    pointer: true,
  }),
  Object.freeze({
    id: FISHING_HOOK_ACTION_ID,
    label: 'Set the hook',
    hint: 'Strikes when a fish bites.',
    keyboardKey: null,
    pointer: true,
  }),
  Object.freeze({
    id: FISHING_RESET_ACTION_ID,
    label: 'Cast again',
    hint: 'Returns to the shore after a catch or after a missed fish.',
    keyboardKey: null,
    pointer: true,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Renderer-local art constants                                               */
/* -------------------------------------------------------------------------- */

/**
 * A small fixed terrain palette.
 *
 * These are art inputs, not a second token source, and the reasoning is
 * `createVillageScene`'s: the Cozy semantic tokens do not name night sky, deep water, or
 * wet sand, and inventing token names for them would put the design system's vocabulary
 * somewhere the design system is not. Everything that *is* a Cozy surface - the bucket,
 * the meter, the angler's tunic, the padlock - reads `init.theme`.
 */
const POND = {
  skyTop: 0x060c1e,
  skyBottom: 0x182848,
  star: 0xffffff,
  farShore: 0x0a1a0a,
  waterDeep: 0x1a3050,
  waterShimmer: 0x8fb4d8,
  shoreGrass: 0x2a4a1a,
  shoreDirt: 0x3a2a14,
  shoreGrassTip: 0x1a3a0a,
  trunk: 0x6b4f2a,
  foliage: 0x2f4f2f,
  foliageLight: 0x3f7d3a,
  rod: 0x8a6a3a,
  rodTip: 0xc8a06a,
  bobber: 0xd8503c,
  bobberPale: 0xf5f0e2,
  fishFin: 0x5b7b93,
  bucket: 0x6a4a2a,
  bucketRim: 0x8a6a3a,
  bucketBand: 0x5a3a1a,
  splash: 0x8899cc,
  ripple: 0xaabbcc,
} as const;

/** Water row height the shimmer bands are cut at. `WATER_TILE_SIZE`. */
const WATER_BAND_HEIGHT = 32;
/** `BOBBER_BOB_AMOUNT`: how far the float drifts while it waits, px. */
const BOBBER_BOB_PX = 4;
/** `MISS_DURATION_MS`: how long a missed fish takes to swim off, ms. */
const FISHING_FLEE_MS = 800;
/** The bite pulse's radius. The machine owns the proximity *threshold*; this is decoration. */
const BITE_PULSE_RADIUS_PX = 26;
/** The power meter, in CSS pixels. `FishingScene.createPowerBar`'s 320 x 24. */
const POWER_BAR_WIDTH = 320;
const POWER_BAR_HEIGHT = 24;
/** The rod's drawn height. `FishingScene`'s rod SVG is 16 x 120. */
const ROD_LENGTH = 120;
/** The angler's drawn size. `FishingScene`'s `PLAYER_SIZE`. */
const PLAYER_SIZE = 40;
/** How far above the shore line the bucket sits. `FishingScene`'s `shoreY - 28`. */
const BUCKET_LIFT_PX = 28;
/** How far right of the angler the bucket sits. */
const BUCKET_OFFSET_X = 50;
/** The band below `shoreY - 20` that is not water and not a cast gesture. */
const WATER_POINTER_MARGIN_PX = 20;
/** The shimmer band's scroll stroke pitch, and the period the dashes wrap on. */
const SHIMMER_STEP_PX = 48;
/** Milliseconds of ambient time per shimmer pixel, a repaint throttle. See `paintShimmerBands`. */
const SHIMMER_MS_PER_PX = 80;

/** How much ambient detail each quality profile draws. */
const AMBIENT_DETAIL = {
  high: { stars: 12, shimmerBands: true },
  balanced: { stars: 12, shimmerBands: true },
  constrained: { stars: 6, shimmerBands: false },
} as const;

/* -------------------------------------------------------------------------- */
/* Options and callbacks                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The renderer-neutral callbacks the pond reports through.
 *
 * `onAudioHook` is required rather than optional, and that is the whole audio decision:
 * the machine **names** a hook and something must carry it out, so there is no
 * configuration in which a cast is silently mute. `FishingController` supplies the
 * Phase 10 `audioManager` mapping by default; a test supplies a recorder.
 *
 * There is deliberately **no `onReady`** here. The Phase 9 host already flips readiness on
 * the first presented frame, and a scene-level second readiness channel is a second
 * answer to a question one channel already answers.
 */
export interface FishingSceneCallbacks {
  /**
   * Play one named audio hook.
   *
   * The hook-to-sound mapping belongs outside this file: a renderer that imported an
   * audio *implementation* would couple the pond to one provider, and the machine's own
   * contract is that it names these hooks and never plays them.
   */
  onAudioHook(hook: FishingAudioHook): void;
  /** The learner asked to leave the pond. */
  onReturnToVillage(): void;
}

/** Everything the scene needs beyond the host's own init. */
export interface CreateFishingSceneOptions {
  /** Renderer-neutral model: archetype and eligibility. */
  readonly world: {
    readonly playerClass: PlayerClassId | null;
    readonly hasClearedRooms: boolean;
  };
  readonly callbacks: FishingSceneCallbacks;
  /**
   * The `YYYY-MM-DD` the gameplay stream is seeded from.
   *
   * Defaults to today, which is what `FishingScene.seedRng` read, so a build with no
   * override reproduces the session the rollback lane does. A test passes it explicitly,
   * because a session seeded from the real clock is not reproducible.
   */
  readonly sessionDate?: string;
  /**
   * The cosmetic random stream: splash droplets, star phases, flees.
   *
   * Separate from the gameplay stream by construction, which is what the machine's header
   * requires and what lets a test pin a pond's particles without touching the catalogue
   * roll. Defaults to `Math.random`, matching the scene's own ambient behaviour.
   */
  readonly cosmeticRng?: () => number;
  /**
   * The session's start, in milliseconds on the scene's own clock.
   *
   * The scene integrates its clock from frame deltas rather than reading `Date.now()`, so a
   * test states time in data and two runs at different frame rates still agree with the
   * machine. Defaults to `0`.
   */
  readonly nowMs?: number;
}

/**
 * The scene contract this world exposes.
 *
 * An interface rather than an alias so `capabilities` is **required** here. `WorldScene`
 * declares it optional - a world with no port has none - and this pond has one, so the
 * renderer that forwards into it does not have to write `?.` on every call and cannot
 * silently skip a capability because the base interface said the member was optional.
 * Narrowing a base member's optionality in a derived interface is exactly what the Phase 12
 * `VillageNpcHost` promotion did, one level down.
 */
export interface FishingScene extends WorldScene<FishingScenePort> {
  readonly capabilities: FishingScenePort;
}

/**
 * What the pond is *currently drawing*, as one value.
 *
 * A read of the scene graph, not of the machine, so a test can ask "did the renderer put
 * the float where the machine said?" rather than "did the renderer copy the state?" Under
 * `prefers-reduced-motion` the two must be equal on every frame, because with no local
 * animation there is nothing between them.
 */
export interface FishingScenePresentation {
  readonly phase: FishingStateName;
  readonly bobber: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly fish: { readonly x: number; readonly y: number; readonly visible: boolean };
  /** Whether the line's geometry exists at all. */
  readonly lineVisible: boolean;
  /** Whether the power meter's frame is on the stage. */
  readonly powerBarVisible: boolean;
  /** How many fish glyphs the bucket holds. */
  readonly bucketCount: number;
}

/* -------------------------------------------------------------------------- */
/* Procedural art                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The angler, mirrored for facing.
 *
 * Two facing states rather than the four the Phaser scene had, because the machine's
 * `facing` is `'left' | 'right'`: walking is a shoreline movement and the up/down variants
 * were only reachable from movement this pond does not have.
 */
function drawAngler(g: Graphics, size: number, theme: CozyWorldTheme): void {
  g.rect(-size * 0.22, size * 0.18, size * 0.44, size * 0.5).fill({
    color: theme.color.accentDeep,
    alpha: 1,
  });
  g.circle(0, -size * 0.26, size * 0.2).fill({ color: theme.color.surfaceRaised, alpha: 1 });
  g.rect(-size * 0.24, -size * 0.34, size * 0.48, size * 0.06).fill({
    color: theme.color.accentDeep,
    alpha: 1,
  });
  g.rect(size * 0.04, -size * 0.34, size * 0.14, size * 0.16).fill({
    color: theme.color.accentDeep,
    alpha: 1,
  });
}

/** The rod, pointing up and forward from the angler's hands. */
function drawRod(g: Graphics, length: number): void {
  g.rect(-2, -length, 4, length).fill({ color: POND.rod, alpha: 1 });
  g.circle(0, -length, 3).fill({ color: POND.rodTip, alpha: 1 });
}

/** The float: a pale top half and a warm bottom half, so it reads on dark water. */
function drawFloat(g: Graphics, width: number, height: number): void {
  g.rect(-width / 2, -height / 2, width, height / 2).fill({ color: POND.bobberPale, alpha: 1 });
  g.rect(-width / 2, 0, width, height / 2).fill({ color: POND.bobber, alpha: 1 });
}

/** The fish silhouette, in the one colour its rarity maps to. */
function drawFish(g: Graphics, width: number, height: number, color: number): void {
  g.ellipse(0, 0, width * 0.5, height * 0.3).fill({ color, alpha: 0.85 });
  g.poly([
    width * 0.5,
    0,
    width * 0.5 - height * 0.34,
    -height * 0.28,
    width * 0.5 - height * 0.34,
    height * 0.28,
  ]).fill({ color: POND.fishFin, alpha: 0.85 });
  g.poly([-width * 0.1, -height * 0.22, width * 0.16, 0, -width * 0.1, height * 0.22]).fill({
    color: POND.fishFin,
    alpha: 0.7,
  });
}

/** The catch bucket: a trapezoid body, a rim, and two bands. */
function drawBucket(g: Graphics): void {
  g.poly([-14, 0, 14, 0, 10, 20, -10, 20]).fill({ color: POND.bucket, alpha: 1 });
  g.rect(-15, -3, 30, 5).fill({ color: POND.bucketRim, alpha: 1 });
  g.rect(-13, 6, 26, 2).fill({ color: POND.bucketBand, alpha: 1 });
  g.rect(-12, 12, 24, 2).fill({ color: POND.bucketBand, alpha: 1 });
}

/**
 * A padlock, for a pond whose subject may not be fished yet.
 *
 * Shapes only. `FishingScene` put a sentence and a portal arrow on the canvas here; the
 * words are React DOM's now, and a canvas that is `aria-hidden` was never a place a
 * screen reader could read them from.
 */
function drawPadlock(g: Graphics, size: number, theme: CozyWorldTheme): void {
  g.rect(-size * 0.4, -size * 0.1, size * 0.8, size * 0.6).fill({
    color: theme.color.surfaceRaised,
    alpha: 0.92,
  });
  g.circle(0, -size * 0.1, size * 0.32).stroke({
    width: 2,
    color: theme.color.surfaceRaised,
    alpha: 0.92,
  });
}

/** Blend two packed RGB colours. */
function lerpColor(from: number, to: number, t: number): number {
  const r = Math.round(((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * t);
  const g = Math.round(((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * t);
  const b = Math.round((from & 0xff) + ((to & 0xff) - (from & 0xff)) * t);
  return (r << 16) | (g << 8) | b;
}

/** Normalise an `event.key` the way the shared input controller does. */
function normalizeKey(key: string): string {
  if (key === ' ' || key === 'Spacebar' || key === 'Space') return ' ';
  return key.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* The readout the DOM mirrors                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything a DOM surface is given to mirror the pond, in one frozen value.
 *
 * Deliberately **not** a copy of `FishingMachineState`:
 *
 * - no pixel positions, because a DOM control does not place a float;
 * - no catalogue entry, because a renderer that forwarded one would be a second place the
 *   catch identity could be read from, and `catalogId` is enough;
 * - **no hint text.** `fishingPhaseHint` is the machine's shared starting copy and it
 *   reads "Hold click on the lake", which is canvas vocabulary. Plan 6.2 gives
 *   instructional text to React DOM, so `ui-engineer` imports `fishingPhaseHint` from the
 *   machine directly and this readout carries only facts.
 */
function buildReadout(state: FishingMachineState, caughtCount: number): FishingReadout {
  return Object.freeze({
    phase: state.phase,
    power: state.power,
    canReset: canResetFishing(state),
    eligible: state.eligible,
    moveIntent: state.moveIntent,
    facing: state.facing,
    castNumber: state.castNumber,
    caughtCount,
  });
}

/* -------------------------------------------------------------------------- */
/* The scene                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the fishing scene for one PixiJS application.
 *
 * @param application - the real PixiJS 8 `Application`, narrowed by `asPixiApplication`.
 * @param init - the renderer-neutral host's scene init.
 * @param options - the world model, the callbacks, and the injectable inputs.
 */
export function createFishingScene(
  application: PixiApplication,
  init: WorldSceneInit,
  options: CreateFishingSceneOptions,
): FishingScene {
  const theme = init.theme;
  const canvas = application.canvas;
  const detail = AMBIENT_DETAIL[init.quality.id] ?? AMBIENT_DETAIL.balanced;

  let motion: CozyMotionProfile = theme.motion;
  let clockMs = options.nowMs ?? 0;
  let ambientMs = 0;
  let caughtCount = 0;
  let lastPaintedShimmerPx = -1;

  // The gameplay stream. Owned by the machine: this scene hands it over and never draws
  // from it, which is what keeps the catalogue roll reproducible while the pond splashes.
  const sessionDate = options.sessionDate ?? new Date().toISOString().slice(0, 10);
  const gameplayRng = createFishingSessionRng(sessionDate, options.world.playerClass ?? 'scholar');
  const cosmeticRng = options.cosmeticRng ?? Math.random;

  /**
   * The machine is built from the *renderer's* surface, not from a placeholder.
   *
   * The host resizes the application before it asks for a scene - `createPixiWorldHost`
   * measures the host element and calls `created.resize(...)` immediately above
   * `createScene` - so `application.screen` is already the real size here. Building from a
   * 1x1 placeholder instead would place the angler at `floor(1 * 0.5) = 0` and the
   * machine's `resize` does not move him: every subsequent cast would fly from the left
   * edge. That is a state, not a presentation bug, which is why it is seeded here.
   */
  let state = createFishingState({
    viewport: { width: application.screen.width, height: application.screen.height },
    nowMs: clockMs,
    eligible: options.world.hasClearedRooms,
  });
  let previousPhase: FishingStateName = state.phase;

  /* ── Listeners, declared before anything can fire ─────────────────────────── */

  const phaseListeners = new Set<(readout: FishingReadout) => void>();
  const catchListeners = new Set<(reveal: FishingCatchReveal) => void>();
  let lastPublishedPhase: FishingStateName | null = null;

  /* ── Layers ──────────────────────────────────────────────────────────────── */

  // Depth is sibling order, not `zIndex`: Pixi renders children in the order they were
  // added, so an ordered set of `addChild` calls is the same picture with no per-frame
  // sort, and nothing here re-parents at runtime.
  const root = new Container();
  root.label = 'fishing-world';
  application.stage.addChild(root);

  const skyLayer = new Container();
  skyLayer.label = 'fishing-sky';
  const starLayer = new Container();
  starLayer.label = 'fishing-stars';
  const horizonLayer = new Container();
  horizonLayer.label = 'fishing-horizon';
  const waterLayer = new Container();
  waterLayer.label = 'fishing-water';
  const fishLayer = new Container();
  fishLayer.label = 'fishing-fish';
  const shoreLayer = new Container();
  shoreLayer.label = 'fishing-shore';
  const treeLayer = new Container();
  treeLayer.label = 'fishing-trees';
  const lineLayer = new Graphics();
  lineLayer.label = 'fishing-line';
  const bobberLayer = new Container();
  bobberLayer.label = 'fishing-bobber';
  const rodLayer = new Container();
  rodLayer.label = 'fishing-rod';
  const playerLayer = new Container();
  playerLayer.label = 'fishing-player';
  const bucketLayer = new Container();
  bucketLayer.label = 'fishing-bucket';
  const bucketFishLayer = new Container();
  bucketFishLayer.label = 'fishing-bucket-fish';
  const splashLayer = new Container();
  splashLayer.label = 'fishing-splash';
  const powerLayer = new Container();
  powerLayer.label = 'fishing-power';

  root.addChild(
    skyLayer,
    starLayer,
    horizonLayer,
    waterLayer,
    fishLayer,
    shoreLayer,
    treeLayer,
    lineLayer,
    bobberLayer,
    rodLayer,
    playerLayer,
    bucketLayer,
    bucketFishLayer,
    splashLayer,
    powerLayer,
  );

  /* ── Layout, rebuilt on every resize ─────────────────────────────────────── */

  let viewport: FishingViewport = state.viewport;
  let horizonY = fishingHorizonY(viewport);
  let shoreY = fishingShoreY(viewport);
  let playerY = fishingPlayerY(viewport);

  const sky = new Graphics();
  const stars = new Graphics();
  const farShore = new Graphics();
  const deepWater = new Graphics();
  const shore = new Graphics();
  const padlock = new Graphics();
  const shimmerBands: Array<{ graphics: Graphics; index: number }> = [];

  waterLayer.addChild(deepWater);
  starLayer.addChild(stars);
  horizonLayer.addChild(farShore);
  shoreLayer.addChild(shore, padlock);
  skyLayer.addChild(sky);

  function rebuildStaticArt(): void {
    const skySteps = 16;
    const waterTop = horizonY;
    const waterHeight = Math.max(0, shoreY - waterTop);

    sky.clear();
    for (let index = 0; index < skySteps; index += 1) {
      sky
        .rect(0, Math.floor((horizonY * index) / skySteps), viewport.width, Math.ceil(horizonY / skySteps) + 1)
        .fill({ color: lerpColor(POND.skyTop, POND.skyBottom, index / (skySteps - 1)), alpha: 1 });
    }

    // The deep water body, drawn here rather than per band so a constrained profile with
    // no shimmer bands still has water.
    deepWater.clear();
    deepWater.rect(0, waterTop, viewport.width, waterHeight).fill({ color: POND.waterDeep, alpha: 1 });

    stars.clear();
    for (let index = 0; index < detail.stars; index += 1) {
      const x = ((17 * (index + 5)) % Math.max(1, viewport.width - 40)) + 20;
      const y = 4 + ((11 * (index + 13)) % Math.max(1, horizonY - 12));
      const size = index % 4 === 0 ? 2 : 1;
      stars.rect(x, y, size, size).fill({
        color: POND.star,
        alpha: 0.35 + ((index * 7) % 3) * 0.15,
      });
    }

    farShore.clear();
    for (let index = 0; index < 12; index += 1) {
      const x = ((23 * index + 7) % (viewport.width + 40)) - 20;
      const height = 18 + ((index * 13) % 14);
      const width = 6 + (index % 4) * 2;
      farShore.rect(x, horizonY - height, width, height).fill({
        color: POND.farShore,
        alpha: 0.9,
      });
      farShore
        .poly([
          x + width / 2,
          horizonY - height - 10,
          x - width,
          horizonY - height + 4,
          x + width * 2,
          horizonY - height + 4,
        ])
        .fill({ color: POND.farShore, alpha: 0.7 });
    }

    shore.clear();
    shore.rect(0, shoreY, viewport.width, Math.max(0, viewport.height - shoreY)).fill({
      color: POND.shoreGrass,
      alpha: 1,
    });
    shore.rect(0, shoreY - 4, viewport.width, 8).fill({ color: POND.shoreDirt, alpha: 1 });
    for (let index = 0; index < 14; index += 1) {
      const x = (29 * index + 11) % Math.max(1, viewport.width);
      shore.rect(x, shoreY - 8, 3, 10).fill({ color: POND.shoreGrassTip, alpha: 0.5 });
      shore.rect(x - 2, shoreY - 4, 7, 2).fill({ color: POND.shoreGrassTip, alpha: 0.5 });
    }

    treeLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    for (const [xFactor, scale, kind] of [
      [0.12, 0.65, 'tree'],
      [0.42, 0.6, 'tree'],
      [0.82, 0.57, 'tree'],
      [0.22, 0.6, 'bush'],
      [0.56, 0.53, 'bush'],
      [0.08, 0.65, 'bush'],
      [0.72, 0.5, 'bush'],
    ] as const) {
      const graphics = new Graphics();
      const sourceSize = kind === 'tree' ? 80 : 48;
      const halfHeight = (sourceSize * scale) / 2;
      const y = shoreY - halfHeight;
      if (kind === 'tree') {
        const trunkW = Math.max(3, 64 * scale * 0.16);
        graphics
          .rect(-trunkW / 2, y + halfHeight - sourceSize * scale * 0.36, trunkW, sourceSize * scale * 0.36)
          .fill({ color: POND.trunk, alpha: 1 });
        graphics.circle(0, y, 64 * scale * 0.34).fill({ color: POND.foliage, alpha: 1 });
        graphics
          .circle(-64 * scale * 0.16, y - 80 * scale * 0.12, 64 * scale * 0.24)
          .fill({ color: POND.foliageLight, alpha: 1 });
      } else {
        graphics.circle(-48 * scale * 0.18, y, 48 * scale * 0.3).fill({
          color: POND.foliage,
          alpha: 1,
        });
        graphics.circle(48 * scale * 0.18, y, 48 * scale * 0.3).fill({
          color: POND.foliage,
          alpha: 1,
        });
        graphics.circle(0, y - 48 * scale * 0.08, 48 * scale * 0.34).fill({
          color: POND.foliageLight,
          alpha: 1,
        });
      }
      graphics.position.set(viewport.width * xFactor, y);
      treeLayer.addChild(graphics);
    }

    waterLayer.removeChildren().forEach((child) => {
      if (child !== deepWater) child.destroy({ children: true });
    });
    shimmerBands.length = 0;
    waterLayer.addChild(deepWater);
    if (detail.shimmerBands && waterHeight > 0) {
      const rows = Math.ceil(waterHeight / WATER_BAND_HEIGHT);
      for (let index = 0; index < rows; index += 1) {
        const top = waterTop + index * WATER_BAND_HEIGHT;
        const height = Math.min(WATER_BAND_HEIGHT, shoreY - top);
        if (height <= 0) break;
        const graphics = new Graphics();
        graphics.label = `fishing-water-band-${index}`;
        waterLayer.addChild(graphics);
        shimmerBands.push({ graphics, index });
      }
      lastPaintedShimmerPx = -1;
    }
  }

  /**
   * Repaint the shimmer bands at an ambient offset.
   *
   * `FishingScene` tweened each water tile's `tilePositionX` from 0 to 24 and back, over
   * `2200 + i * 350` ms, with an alpha ramp down the rows. The dashes here are the same
   * idea in geometry: a row of short strokes slid by the offset, modulo the period, with
   * the same ramp.
   *
   * Repainted **only when the offset crosses a whole pixel**, at
   * {@link SHIMMER_MS_PER_PX} milliseconds per pixel of scroll. That is roughly a dozen
   * geometry rebuilds a second rather than sixty, and no measurement in this phase says a
   * learner can tell the difference; a resampling that is invisible is not worth a
   * per-frame tessellation.
   */
  function paintShimmerBands(): void {
    const offsetPx = Math.floor(ambientMs / SHIMMER_MS_PER_PX);
    if (offsetPx === lastPaintedShimmerPx) return;
    lastPaintedShimmerPx = offsetPx;
    const rows = Math.max(1, shimmerBands.length);
    for (const band of shimmerBands) {
      const graphics = band.graphics;
      graphics.clear();
      const alpha = 0.35 + (1 - band.index / rows) * 0.25;
      const top = horizonY + band.index * WATER_BAND_HEIGHT;
      for (let x = -SHIMMER_STEP_PX; x < viewport.width + SHIMMER_STEP_PX; x += SHIMMER_STEP_PX) {
        const shift = ((x + offsetPx) % SHIMMER_STEP_PX) - SHIMMER_STEP_PX;
        graphics.rect(x + shift, top + 8 + (band.index % 3) * 6, 18, 2).fill({
          color: POND.waterShimmer,
          alpha,
        });
      }
    }
  }

  /* ── Actors ──────────────────────────────────────────────────────────────── */

  const player = new Graphics();
  player.label = 'fishing-angler';
  drawAngler(player, PLAYER_SIZE, theme);
  playerLayer.addChild(player);

  const rod = new Graphics();
  rod.label = 'fishing-rod-shaft';
  drawRod(rod, ROD_LENGTH);
  rodLayer.addChild(rod);

  const bobber = new Container();
  bobber.label = 'fishing-float';
  const bobberBody = new Graphics();
  drawFloat(bobberBody, 14, 22);
  bobber.addChild(bobberBody);
  bobberLayer.addChild(bobber);

  const fish = new Container();
  fish.label = 'fishing-fish-silhouette';
  const fishBody = new Graphics();
  fish.addChild(fishBody);
  fishLayer.addChild(fish);

  const bucket = new Container();
  bucket.label = 'fishing-bucket-body';
  const bucketBody = new Graphics();
  drawBucket(bucketBody);
  bucket.addChild(bucketBody);
  bucketLayer.addChild(bucket);

  /** One glyph per revealed catch, oldest at the bottom, as `FishingScene` stacked them. */
  const bucketFish: Graphics[] = [];
  /** The rarity the fish silhouette is currently drawn in, so it redraws on a change only. */
  let drawnRarity: FishRarity | null = null;

  const powerBarBg = new Graphics();
  powerBarBg.label = 'fishing-power-frame';
  const powerBarFill = new Graphics();
  powerBarFill.label = 'fishing-power-fill';
  powerBarFill
    .rect(0, 0, POWER_BAR_WIDTH, POWER_BAR_HEIGHT)
    .fill({ color: theme.color.accent, alpha: 0.9 });
  powerLayer.addChild(powerBarBg, powerBarFill);

  /** Transient cosmetic effects, advanced and retired on the scene's own clock. */
  interface CosmeticEffect {
    readonly display: Container;
    remainingMs: number;
    readonly lifetimeMs: number;
    readonly step: (progress: number) => void;
  }
  const cosmeticEffects: CosmeticEffect[] = [];

  let reelFrom: { bobberX: number; bobberY: number; fishX: number; fishY: number } | null = null;
  let flee: { fromX: number; fromY: number; toX: number; toY: number } | null = null;
  /**
   * How long the flee has been swimming.
   *
   * The scene's own elapsed time, because the machine has already ended the approach and
   * has no remaining clock to read. The *direction* is the machine's (`fishDirection`),
   * which is why this is a duration and not a destination.
   */
  let fleeElapsedMs = 0;

  let presentation: FishingScenePresentation = Object.freeze({
    phase: state.phase,
    bobber: Object.freeze({ x: 0, y: 0, visible: false }),
    fish: Object.freeze({ x: 0, y: 0, visible: false }),
    lineVisible: false,
    powerBarVisible: false,
    bucketCount: 0,
  });

  /* ── Cosmetic effects ────────────────────────────────────────────────────── */

  /**
   * The landing splash: three expanding rings and five droplets.
   *
   * Every random value comes from `cosmeticRng`, never from the gameplay stream. The
   * lifetime is `motion.durationMs('base')`, which the Cozy profile resolves to `0` at
   * `prefers-reduced-motion: reduce` - so under that preference nothing travels, which is
   * the preference stated as a policy rather than as a shorter animation.
   */
  function spawnSplash(x: number, y: number): void {
    const lifetime = motion.durationMs('base');
    for (let index = 0; index < 3; index += 1) {
      if (lifetime <= 0) break;
      const ring = new Graphics();
      ring.circle(0, 0, 6).stroke({ width: 1.5, color: POND.ripple, alpha: 0.7 });
      ring.position.set(x, y);
      splashLayer.addChild(ring);
      cosmeticEffects.push({
        display: ring,
        remainingMs: lifetime - index * 80,
        lifetimeMs: lifetime,
        step: (progress) => {
          ring.scale.set(1 + progress * progress * 4);
          ring.alpha = 0.7 * (1 - progress);
        },
      });
    }
    for (let index = 0; index < 5 && lifetime > 0; index += 1) {
      const dx = (cosmeticRng() - 0.5) * 40;
      const dy = -(15 + cosmeticRng() * 20);
      const drop = new Graphics();
      drop.circle(0, 0, 2).fill({ color: POND.splash, alpha: 0.8 });
      drop.position.set(x, y);
      splashLayer.addChild(drop);
      cosmeticEffects.push({
        display: drop,
        remainingMs: lifetime,
        lifetimeMs: lifetime,
        step: (progress) => {
          drop.position.set(x + dx * progress, y + dy * progress);
          drop.alpha = 0.8 * (1 - progress);
        },
      });
    }
  }

  /** The bite pulse: one ring around the float, sized by the renderer and not the machine. */
  function spawnBitePulse(x: number, y: number): void {
    const lifetime = motion.durationMs('quick');
    if (lifetime <= 0) return;
    const ring = new Graphics();
    ring.circle(0, 0, BITE_PULSE_RADIUS_PX).stroke({
      width: 2,
      color: theme.color.warning,
      alpha: 0.9,
    });
    ring.position.set(x, y);
    splashLayer.addChild(ring);
    cosmeticEffects.push({
      display: ring,
      remainingMs: lifetime,
      lifetimeMs: lifetime,
      step: (progress) => {
        ring.alpha = 0.9 * (1 - progress);
      },
    });
  }

  /** One fish in the bucket, with the pop-in the Phaser scene tweened. */
  function addFishToBucket(rarity: FishRarity): void {
    const index = caughtCount;
    const glyph = new Graphics();
    glyph.label = `fishing-bucket-fish-${index}`;
    drawFish(glyph, 30, 16, rarityColor(rarity));
    glyph.scale.set(0);
    glyph.position.set(
      bucketX() + ((index % 3) - 1) * 6,
      shoreY - BUCKET_LIFT_PX - 2 - Math.floor(index / 3) * 8,
    );
    bucketFishLayer.addChild(glyph);
    bucketFish.push(glyph);
    caughtCount += 1;
  }

  /* ── The one route into the machine ──────────────────────────────────────── */

  /**
   * Carry out one reducer call's effects.
   *
   * An `audio` effect goes to `callbacks.onAudioHook` and to nothing else here: the
   * splash is keyed to the *phase entry* that produced the `splash` hook, so the pond's
   * visuals and its audio cannot drift apart by one emission. Only the payload-bearing
   * `catch-revealed` effect drives presentation.
   */
  function applyEffects(effects: readonly FishingMachineEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'audio') {
        options.callbacks.onAudioHook(effect.hook);
        continue;
      }
      addFishToBucket(effect.rarity);
      // The effect's own `type` discriminator is *not* forwarded. `FishingCatchReveal` is the
      // port's shape and a DOM panel should not have to know the machine's tag names to read
      // a catch; projecting the four members is what makes the port a port rather than a
      // re-export of the machine's internal union.
      const reveal: FishingCatchReveal = {
        catalogId: effect.catalogId,
        rarity: effect.rarity,
        castNumber: effect.castNumber,
        description: effect.description,
      };
      for (const listener of [...catchListeners]) listener(reveal);
    }
  }

  function dispatch(event: FishingMachineEvent): void {
    const result = reduceFishing(state, event, gameplayRng);
    state = result.state;
    applyEffects(result.effects);
    publish();
  }

  /**
   * Publish the readout, but only when the phase has moved.
   *
   * That is `WorldSceneInit.publishState`'s own rule - on change, never per frame. A
   * readout published sixty times a second would re-render every `aria-live` region in
   * the pond's DOM mirror sixty times a second and turn a screen reader into a machine
   * gun. The power meter's fill is a visual and not a live region; a DOM surface that
   * wants it reads {@link FishingScenePort.readReadout} on its own cadence.
   */
  function publish(): void {
    if (phaseListeners.size === 0) return;
    if (lastPublishedPhase === state.phase) return;
    lastPublishedPhase = state.phase;
    const value = readout();
    for (const listener of [...phaseListeners]) listener(value);
  }

  /* ── Phase transitions ───────────────────────────────────────────────────── */

  function onPhaseEntered(phase: FishingStateName): void {
    switch (phase) {
      case 'powering':
        // The machine holds the float hidden at the origin because no cast has been
        // launched. Showing it at the rod tip at half alpha is `FishingScene`'s affordance
        // and a presentation choice this renderer owns.
        reelFrom = null;
        flee = null;
        break;
      case 'waiting':
        // The landing tick is the splash, and the float starts its idle bob.
        spawnSplash(state.bobber.x, state.bobber.y);
        break;
      case 'biting':
        spawnBitePulse(state.bobber.x, state.bobber.y);
        break;
      case 'reeling':
        reelFrom = {
          bobberX: state.bobber.x,
          bobberY: state.bobber.y,
          fishX: state.fish.x,
          fishY: state.fish.y,
        };
        break;
      case 'missed':
        flee = {
          fromX: state.fish.x,
          fromY: state.fish.y,
          toX: state.fishDirection === 'right' ? viewport.width + 60 : state.fish.x,
          toY: state.fishDirection === 'right' ? state.fish.y : viewport.height + 60,
        };
        fleeElapsedMs = 0;
        reelFrom = null;
        break;
      case 'caught':
      case 'idle':
        reelFrom = null;
        flee = null;
        break;
      default:
        break;
    }
  }

  /* ── Drawing the machine's state ─────────────────────────────────────────── */

  function bucketX(): number {
    return state.playerX + BUCKET_OFFSET_X;
  }

  function rarityColor(rarity: FishRarity): number {
    switch (rarity) {
      case 'epic':
        return theme.color.accent;
      case 'rare':
        return theme.color.info;
      default:
        return theme.color.textSecondary;
    }
  }

  function readout(): FishingReadout {
    return buildReadout(state, caughtCount);
  }

  /**
   * Write the machine's state onto the display objects.
   *
   * The only decisions here are *presentation* decisions the machine leaves open: which of
   * its positions to draw, whether a silhouette is mirrored, and whether the rod and bucket
   * follow the angler.
   */
  function present(): void {
    const tip = fishingRodTip(state.playerX, viewport);

    player.position.set(state.playerX, playerY);
    player.scale.x = state.facing === 'left' ? -1 : 1;

    rod.position.set(state.playerX + 12, playerY - 18);
    // `FishingScene` rocked the rod between -7 and -3 degrees. The tip the machine draws
    // the line to is the *unrotated* geometry, so the sway is an overlay that never moves
    // the line's origin.
    rod.rotation = ((-5 + Math.sin((ambientMs / 1800) * Math.PI * 2) * 4 * motion.scale) * Math.PI) / 180;

    bucket.position.set(bucketX(), shoreY - BUCKET_LIFT_PX);
    for (let index = 0; index < bucketFish.length; index += 1) {
      bucketFish[index]?.position.set(
        bucketX() + ((index % 3) - 1) * 6,
        shoreY - BUCKET_LIFT_PX - 2 - Math.floor(index / 3) * 8,
      );
    }

    padlock.visible = !state.eligible;
    if (!state.eligible) {
      padlock.clear();
      drawPadlock(padlock, 22, theme);
      padlock.position.set(bucketX(), shoreY - BUCKET_LIFT_PX - 26);
    }

    // The float: the machine's position, plus the idle bob, plus the reel interpolation.
    const bobOffset =
      motion.scale * BOBBER_BOB_PX * (0.5 - 0.5 * Math.cos((ambientMs / 900) * Math.PI * 2));
    let bobberX = state.bobber.x;
    let bobberY = state.bobber.y + bobOffset;
    let bobberVisible = state.bobber.visible;

    if (state.phase === 'powering') {
      bobberX = tip.x;
      bobberY = tip.y;
      bobberVisible = true;
    }

    let fishX = state.fish.x;
    let fishY = state.fish.y;
    let fishVisible = state.fish.visible;
    let fishFacing: 1 | -1 = state.fishDirection === 'right' ? -1 : 1;

    if (state.phase === 'reeling' && reelFrom !== null) {
      fishVisible = true;
      fishFacing = tip.x >= reelFrom.fishX ? 1 : -1;
      if (motion.scale > 0 && state.reelDeadlineMs !== null) {
        const progress = Math.min(
          1,
          Math.max(0, 1 - (state.reelDeadlineMs - clockMs) / FISHING_REEL_DURATION_MS),
        );
        bobberX = reelFrom.bobberX + (tip.x - reelFrom.bobberX) * progress;
        bobberY = reelFrom.bobberY + (tip.y - reelFrom.bobberY) * progress;
        fishX = reelFrom.fishX + (tip.x - reelFrom.fishX) * progress;
        fishY = reelFrom.fishY + (tip.y - 20 - reelFrom.fishY) * progress;
      } else {
        // Reduced motion: no travel, so both objects stay exactly where the machine is.
        bobberX = reelFrom.bobberX;
        bobberY = reelFrom.bobberY;
      }
    } else if (state.phase === 'missed' && flee !== null && motion.scale > 0) {
      // Swim off in the direction the machine named. Under reduced motion nothing travels,
      // so the fish stays exactly where the machine left it until `reset` clears it.
      const progress = Math.min(1, fleeElapsedMs / FISHING_FLEE_MS);
      fishX = flee.fromX + (flee.toX - flee.fromX) * progress;
      fishY = flee.fromY + (flee.toY - flee.fromY) * progress;
      fishVisible = progress < 1;
    }

    bobber.position.set(bobberX, bobberY);
    bobber.visible = bobberVisible;
    bobber.alpha = state.phase === 'powering' ? 0.5 : 1;

    fish.position.set(fishX, fishY);
    fish.scale.x = fishFacing;
    fish.visible = fishVisible;
    if (state.candidate !== null && drawnRarity !== state.candidate.rarity) {
      drawnRarity = state.candidate.rarity;
      fishBody.clear();
      drawFish(fishBody, 48, 28, rarityColor(drawnRarity));
    }

    // The line, only while the float is out.
    const lineVisible = bobberVisible && state.phase !== 'powering';
    if (lineVisible) {
      lineLayer.clear();
      // The curve is presentation: `FishingScene.updateLine` built a quadratic Bezier from
      // the rod tip to the float with its control point 8 px right of the midpoint, and
      // the machine owns only the two endpoints.
      lineLayer.moveTo(tip.x, tip.y);
      lineLayer.quadraticCurveTo((tip.x + bobberX) / 2 + 8, (tip.y + bobberY) / 2, bobberX, bobberY);
      lineLayer.stroke({ width: 1.5, color: POND.waterShimmer, alpha: 0.6 });
    } else {
      lineLayer.clear();
    }

    // The power meter. Width is the state; the tint is a second, redundant cue.
    const barX = (viewport.width - POWER_BAR_WIDTH) / 2;
    const barY = Math.max(0, viewport.height - 80);
    const powering = state.phase === 'powering';
    if (powering) {
      powerBarBg.clear();
      powerBarBg
        .roundRect(barX - 2, barY - 2, POWER_BAR_WIDTH + 4, POWER_BAR_HEIGHT + 4, 6)
        .fill({ color: theme.color.surfaceSunken, alpha: 0.85 })
        .stroke({ width: 1.5, color: theme.color.borderStrong, alpha: 0.6 });
      powerBarFill.visible = true;
      powerBarFill.position.set(barX, barY);
      powerBarFill.scale.x = Math.max(0.001, Math.min(1, state.power));
    } else {
      powerBarBg.clear();
      powerBarFill.visible = false;
    }

    presentation = Object.freeze({
      phase: state.phase,
      bobber: Object.freeze({ x: bobberX, y: bobberY, visible: bobberVisible }),
      fish: Object.freeze({ x: fishX, y: fishY, visible: fishVisible }),
      lineVisible,
      powerBarVisible: powering,
      bucketCount: bucketFish.length,
    });
  }

  /* ── Per-frame update ────────────────────────────────────────────────────── */

  function updateFrame(deltaMs: number): void {
    if (deltaMs <= 0) return;
    clockMs += deltaMs;
    if (!motion.reduced) ambientMs += deltaMs;

    // Walking first: the scene resolves opposed keys into one intent, because the
    // machine's `move` event carries a single direction and its header says so. Compared
    // against `state.moveIntent` rather than against a renderer-local "last sent" value, so
    // an event the machine refuses (a walk held through `powering`) re-sends itself the
    // moment the phase allows it instead of stranding the learner.
    const intent = resolveWalkIntent();
    if (intent !== state.moveIntent) {
      dispatch({ type: 'move', nowMs: clockMs, intent });
    }

    // The clock: the only event the renderer emits on its own.
    dispatch({ type: 'tick', nowMs: clockMs });

    if (state.phase !== previousPhase) {
      previousPhase = state.phase;
      onPhaseEntered(state.phase);
    }

    if (motion.scale > 0) paintShimmerBands();
    advanceCosmetics(deltaMs);
    if (flee !== null && motion.scale > 0) fleeElapsedMs += deltaMs;
    advanceBucketPopIn(deltaMs);
    present();
  }

  function advanceCosmetics(deltaMs: number): void {
    for (let index = cosmeticEffects.length - 1; index >= 0; index -= 1) {
      const effect = cosmeticEffects[index];
      if (effect === undefined) continue;
      effect.remainingMs -= deltaMs;
      effect.step(Math.min(1, Math.max(0, 1 - effect.remainingMs / effect.lifetimeMs)));
      if (effect.remainingMs > 0) continue;
      effect.display.removeFromParent();
      effect.display.destroy({ children: true });
      cosmeticEffects.splice(index, 1);
    }
  }

  /** The pop-in for a newly caught glyph, on the same cosmetic clock. */
  function advanceBucketPopIn(deltaMs: number): void {
    const target = 0.4;
    for (const glyph of bucketFish) {
      if (glyph.scale.x >= target) continue;
      glyph.scale.set(Math.min(target, glyph.scale.x + (deltaMs / 250) * target));
    }
  }

  /* ── Keyboard and pointer ────────────────────────────────────────────────── */

  const win: Window | undefined =
    canvas.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? undefined : window);
  const heldKeys = new Set<string>();
  let pointerHolding = false;
  let pointerId: number | null = null;

  const LEFT_KEYS: ReadonlySet<string> = new Set(['a', 'arrowleft']);
  const RIGHT_KEYS: ReadonlySet<string> = new Set(['d', 'arrowright']);
  const HOLD_KEYS: ReadonlySet<string> = new Set([' ', 'enter']);

  /**
   * Resolve the held keys into the machine's single `-1 | 0 | 1` intent.
   *
   * `FishingScene` accumulated `-1` then `+1` into a `dx`, so two opposed keys held at once
   * produce `0` and the machine never sees both. Same rule, same reason: two opposed keys
   * is a learner who has changed their mind, not a learner moving twice as fast.
   */
  function resolveWalkIntent(): -1 | 0 | 1 {
    let total = 0;
    for (const key of heldKeys) {
      if (LEFT_KEYS.has(key)) total -= 1;
      if (RIGHT_KEYS.has(key)) total += 1;
    }
    if (total > 0) return 1;
    if (total < 0) return -1;
    return 0;
  }

  /**
   * The verb a press performs, for the phase the machine is in.
   *
   * `null` means "no invitation", and `null` sends nothing at all. This is the same
   * `switch` `FishingScene.handlePointerDown` wrote: a mapping from a gesture to an
   * event, not a rule about legality. The machine still refuses anything sent in the wrong
   * phase; this table simply never sends anything there.
   */
  function actionForCurrentPhase(): string | null {
    switch (state.phase) {
      case 'idle':
        return FISHING_BEGIN_POWER_ACTION_ID;
      case 'biting':
        return FISHING_HOOK_ACTION_ID;
      case 'caught':
      case 'missed':
        return FISHING_RESET_ACTION_ID;
      default:
        return null;
    }
  }

  /** Begin the hold. Routed through the host's dispatch, never through `activate`. */
  function beginHold(source: 'keyboard' | 'pointer'): void {
    const actionId = actionForCurrentPhase();
    if (actionId === null) return;
    init.onAction(actionId, source);
  }

  /**
   * End the hold, which for `powering` is the cast itself.
   *
   * Not an action, because an action is a press; it is the completion of the press that
   * `fishing-begin-power` began. It publishes explicitly for that reason.
   */
  function endHold(): void {
    if (state.phase !== 'powering') return;
    dispatch({ type: 'release', nowMs: clockMs });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isHandledElsewhere(event.target, canvas.parentElement)) return;
    const key = normalizeKey(event.key);

    if (LEFT_KEYS.has(key) || RIGHT_KEYS.has(key)) {
      heldKeys.add(key);
      if (key.startsWith('arrow') && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      return;
    }
    if (!HOLD_KEYS.has(key)) return;
    // Key repeat would otherwise re-enter `beginHold` on every autorepeat tick.
    if (event.repeat) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    beginHold('keyboard');
  }

  function onKeyUp(event: KeyboardEvent): void {
    const key = normalizeKey(event.key);
    heldKeys.delete(key);
    endHold();
  }

  /** A window that loses focus never delivers the matching keyup. */
  function onWindowBlur(): void {
    const wasHolding = heldKeys.size > 0 || pointerHolding;
    heldKeys.clear();
    pointerHolding = false;
    pointerId = null;
    if (wasHolding) endHold();
  }

  function pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: PointerEvent): void {
    if (typeof event.button === 'number' && event.button > 0) return;
    const point = pointerPosition(event);
    // "Cast anywhere in the water area (above shore)", with `FishingScene`'s own
    // `shoreY - 20` band. A press on the shore is not a refusal - it is not the gesture.
    if (point.y > shoreY - WATER_POINTER_MARGIN_PX) return;
    pointerHolding = true;
    pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    // Capture so the release still reaches this canvas when the finger leaves it.
    if (pointerId !== null && typeof canvas.setPointerCapture === 'function') {
      try {
        canvas.setPointerCapture(pointerId);
      } catch {
        // A canvas that will not take the capture still gets the release on the window.
      }
    }
    if (typeof event.preventDefault === 'function') event.preventDefault();
    beginHold('pointer');
  }

  function onPointerUp(event: PointerEvent): void {
    if (!pointerHolding) return;
    if (pointerId !== null && event.pointerId !== pointerId) return;
    pointerHolding = false;
    pointerId = null;
    endHold();
  }

  function onPointerCancel(): void {
    // A gesture the browser took away is not one the learner finished, exactly as the
    // shared input controller's pointercancel rule states. No cast is cast.
    if (!pointerHolding) return;
    pointerHolding = false;
    pointerId = null;
  }

  if (win !== undefined) {
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('blur', onWindowBlur);
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  // The pond owns its gestures; without this a touch-hold scrolls the page underneath.
  canvas.style.touchAction = 'none';

  /* ── Layout on resize ────────────────────────────────────────────────────── */

  function onResize(width: number, height: number): void {
    dispatch({ type: 'resize', nowMs: clockMs, viewport: { width, height } });
    viewport = state.viewport;
    horizonY = fishingHorizonY(viewport);
    shoreY = fishingShoreY(viewport);
    playerY = fishingPlayerY(viewport);
    rebuildStaticArt();
    present();
  }

  /* ── World actions, per the host's dispatch ──────────────────────────────── */

  function activate(actionId: string): boolean {
    switch (actionId) {
      case FISHING_BEGIN_POWER_ACTION_ID:
        dispatch({ type: 'begin-power', nowMs: clockMs });
        return true;
      case FISHING_HOOK_ACTION_ID:
        dispatch({ type: 'hook', nowMs: clockMs });
        return true;
      case FISHING_RESET_ACTION_ID:
        dispatch({ type: 'reset', nowMs: clockMs });
        return true;
      default:
        return false;
    }
  }

  /** Per-action status, for the host's per-control `aria-live` line. */
  function readState(): Readonly<Record<string, string>> {
    return Object.freeze({
      [FISHING_BEGIN_POWER_ACTION_ID]: `Cast phase: ${state.phase}. Power ${Math.round(state.power * 100)} percent.`,
      [FISHING_HOOK_ACTION_ID]: `Cast phase: ${state.phase}.`,
      [FISHING_RESET_ACTION_ID]: `Cast phase: ${state.phase}.`,
    });
  }

  function setMotionProfile(profile: CozyMotionProfile): void {
    motion = profile;
  }

  /* ── The port a screen drives ────────────────────────────────────────────── */

  const capabilities: FishingScenePort = {
    beginPower(): void {
      dispatch({ type: 'begin-power', nowMs: clockMs });
    },
    release(): void {
      dispatch({ type: 'release', nowMs: clockMs });
    },
    hook(): void {
      dispatch({ type: 'hook', nowMs: clockMs });
    },
    reset(): void {
      dispatch({ type: 'reset', nowMs: clockMs });
    },
    move(intent: -1 | 0 | 1): void {
      dispatch({
        type: 'move',
        nowMs: clockMs,
        intent: intent === -1 || intent === 1 ? intent : 0,
      });
    },
    resize(width: number, height: number): void {
      onResize(width, height);
    },
    readReadout: readout,
    readPresentation(): FishingScenePresentation {
      return presentation;
    },
    onPhase(listener: (value: FishingReadout) => void): () => void {
      phaseListeners.add(listener);
      return () => {
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
      return caughtCount;
    },
    setPlayerClass(): void {
      // `FishingRendererCapabilities.setPlayerClass` exists for the Phaser lane, whose four
      // directional player textures are loaded in `preload` and cannot change mid-scene.
      // This pond draws its angler procedurally and reads no archetype, so there is
      // nothing to apply - and the member is implemented rather than omitted so the two
      // adapters present the same port.
    },
    returnToVillage(): void {
      options.callbacks.onReturnToVillage();
    },
  };

  rebuildStaticArt();
  present();

  return {
    actions: FISHING_ACTIONS,
    activate,
    readState,
    update: updateFrame,
    onResize,
    setMotionProfile,
    capabilities,

    /**
     * Release every display object, listener, and effect this scene created.
     *
     * Order matters and is the order `createVillageScene.destroy` uses: the listeners
     * first, so nothing can call into a scene that is being released; then the transient
     * effects; then the layer tree. The memory gate mounts and unmounts this scene
     * repeatedly, so anything left behind shows up as retained display objects.
     */
    destroy(): void {
      if (win !== undefined) {
        win.removeEventListener('keydown', onKeyDown);
        win.removeEventListener('keyup', onKeyUp);
        win.removeEventListener('blur', onWindowBlur);
      }
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      heldKeys.clear();
      pointerHolding = false;
      pointerId = null;

      for (const effect of cosmeticEffects.splice(0)) {
        effect.display.removeFromParent();
        effect.display.destroy({ children: true });
      }
      for (const glyph of bucketFish.splice(0)) glyph.destroy({ children: true });
      phaseListeners.clear();
      catchListeners.clear();
      lastPublishedPhase = null;
      reelFrom = null;
      flee = null;

      root.removeChildren();
      root.destroy({ children: true });
    },
  };
}