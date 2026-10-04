/**
 * The pure fishing state machine.
 *
 * ## What this decides
 *
 * Every fishing state change in Knowledge Dungeon, with no renderer, no clock of
 * its own, and no randomness of its own:
 *
 * - **Which cast phase the session is in.** `idle`, `powering`, `casting`,
 *   `waiting`, `biting`, `reeling`, `caught`, `missed` - the union `FishingScene`
 *   has embedded in a private field since before the rebuild, verbatim.
 * - **Which events are legal in which phase.** An illegal event is *refused*
 *   (returned with `accepted: false` and the state untouched), never thrown and
 *   never silently ignored, so a DOM control and a canvas tap cannot disagree
 *   about whether an action happened.
 * - **The catch itself.** Which catalog entry bites, from which direction, and
 *   when it is close enough to strike - the catalog roll, the rarity weights, and
 *   the proximity test all live here so a test can drive a catch without a
 *   browser.
 * - **The two windows that make `missed` a state rather than a timeout.**
 *   `BITE_WINDOW_SEC` after a bite, and `MAX_PROXIMITY_WAIT_MS` after the bobber
 *   lands. Both end in `missed`, both are deadline arithmetic on the injected
 *   clock, and both are drivable in one tick in a test.
 * - **The world model the renderer draws**: viewport-derived layout lines, the
 *   player's position and facing, the bobber's position and velocity, the power
 *   meter, and the approaching fish's position. Movement bounds and the
 *   power-cast ballistic are preserved from the scene exactly.
 * - **The audio hooks.** {@link FishingAudioHook} names what should be heard;
 *   this module never plays it.
 *
 * ## What this deliberately leaves to the renderer
 *
 * Plan section 6.2 gives Pixi "world rendering, camera, navigation visuals, and
 * renderer-local animation". Everything below is renderer-local and is therefore
 * *not* in this file:
 *
 * - **Drawing.** Sprites, textures, tints, depth ordering, and the parallax
 *   water. The renderer reads {@link FishingMachineState} and draws it.
 * - **The fishing line's curve.** `FishingScene.getRodTip` / `updateLine` build a
 *   quadratic Bézier from the rod tip to the bobber. The curve is presentation;
 *   the two endpoints are state. {@link fishingRodTip} is exported so both sides
 *   use one rod-tip geometry rather than two that can drift.
 * - **Sprite-presence branches.** `FishingScene` skips the splash when
 *   `bobberSprite` is null and calls `catchFish()` immediately from `setHook` when
 *   a sprite is missing. Those are renderer conditions with no domain meaning; here
 *   the bobber always exists and `reeling` always takes its full duration.
 * - **Pointer hit-testing.** "Cast anywhere in the water area" is a screen-space
 *   judgement about a canvas the machine never sees. The machine answers
 *   `begin-power`; deciding *where the learner aimed* is the renderer's job, and it
 *   answers by simply not sending the event.
 * - **Cosmetics that used to draw from the seeded stream.** `FishingScene.splashAt`
 *   draws ten values from `this.fishingRng` to scatter five water droplets and
 *   their fade times. Those are cosmetic, they are interleaved with gameplay draws
 *   in the current build, and moving them out is what lets the machine's stream be
 *   gameplay-only. The renderer gets its own generator.
 *
 * ## Determinism
 *
 * Every input is a parameter. The clock arrives as `nowMs` on **every** event, so
 * this module reads no clock; `Math.random` arrives as the injected `rng`; the
 * viewport arrives in the state and changes only through {@link resize}. Two runs
 * with the same seed, the same viewport, and the same event sequence produce
 * equal states. {@link deriveFishingSeed} reproduces `FishingScene.seedRng`'s
 * derivation byte for byte, so a given day and player class produce the same
 * session as before the rebuild - that is what "preserve seeded random behavior"
 * means here, and `tests/phase17/fishingStateMachine.test.ts` pins it with golden
 * values rather than against the scene.
 *
 * ## The RNG draw order, which is part of the contract
 *
 * The seeded stream is consumed in exactly this order, so a session's catalogue
 * rolls are reproducible:
 *
 * 1. `release` - the cast's spread angle.
 * 2. the landing tick - rarity roll, then catalogue index within that rarity.
 * 3. the landing tick - entry direction.
 * 4. the landing tick - only when the direction is `bottom`, the entry x offset.
 *
 * The renderer must not draw from this generator. Cosmetic randomness belongs to a
 * separate stream (see the header's cosmetic paragraph).
 *
 * ## Learner-triggerable transitions, and the control each one needs
 *
 * Plan section 10.1 and plan exit criterion "Every Pixi world action has a
 * DOM-equivalent control" / "A complete cast-to-catch-to-keep flow works using
 * touch and keyboard". `ui-engineer` builds one control per row; this list is the
 * contract and it is kept accurate rather than aspirational.
 *
 * | # | Event | From | To | DOM control | Keyboard | Touch |
 * |---|-------|------|----|-----------|----------|-------|
 * | 1 | `begin-power` | `idle` | `powering` | "Hold to charge" button, `onPointerDown` | `Space`/`Enter` keydown, or a hold-to-charge button | tap and hold |
 * | 2 | `move` | `idle`, `caught`, `missed` | same | "Walk left" / "Walk right" hold buttons | `A`/`←` and `D`/`→` held | hold either button |
 * | 3 | `release` | `powering` | `casting` | the control from (1), `onPointerUp` | `Space`/`Enter` keyup | lift the finger |
 * | 4 | `hook` | `biting` | `reeling` | "Set the hook!" button | `Space`/`Enter` | tap |
 * | 5 | `reset` | `caught` | `idle` | "Cast again" button | `Space`/`Enter` | tap |
 * | 6 | `reset` | `missed` | `idle` | "Try again" button | `Space`/`Enter` | tap |
 *
 * Three more events are **not** learner-triggerable and must not have a control:
 *
 * - `tick` is the clock. A renderer emits it every frame; nothing else does.
 * - `resize` is the layout. A host emits it on viewport change.
 *
 * Two outcomes are reachable with **no** control at all, and that is intentional -
 * they are the parts of the loop the learner does not act on:
 *
 * - `casting` → `waiting` is the bobber landing, decided by the machine.
 * - `waiting` → `biting` is proximity, decided by the machine.
 * - `reeling` → `caught` is the reel completing, decided by the machine.
 * - `biting` → `missed` and `waiting` → `missed` are window expiries, decided by
 *   the machine. No control, and no learner action could prevent them; they are the
 *   two ways the fish gets away.
 *
 * ## Why `eligible` is an input and not a lookup
 *
 * `FishingScene` blocks casting on a `hasClearedRooms` flag that
 * `studyFlow.enterFishing` computed from the *nearest portal slot* - a village
 * layout lookup, not the learner's subject. That is plan 5.3's "fishing
 * eligibility ... may use different subject contexts". The machine takes
 * `eligible` as a construction input, and the application layer computes it from
 * **the context's own subject**. The machine therefore cannot be right and wrong
 * about eligibility at once, and {@link isFishingEligible} holds the rule.
 *
 * No renderer imports appear anywhere in this file, and no React, no DOM, no
 * store, no `Date`, and no `Math.random`.
 */
import type { FishCatalogEntry, FishDirection, FishRarity } from './fishingTypes';
import {
  BITE_WINDOW_SEC,
  FISH_CATALOG,
  FISH_DIRECTION_WEIGHTS,
  FISH_RARITY_XP_MULTIPLIER,
  MAX_PROXIMITY_WAIT_MS,
} from './fishingTypes';

/**
 * The rarity weights a cast rolls against, re-exported for the same reason as the
 * catalogue below.
 *
 * `rollFishRarity` reads them itself, so this phase does not restate them; a renderer
 * that draws a rarity's colour needs the table and should not have to reach into a
 * second module for it.
 */
export { FISH_RARITY_WEIGHTS } from './fishingTypes';
import { createSeededRng, rollFishRarity } from './fishingMechanics';

// ── States ───────────────────────────────────────────────────────────────────

/**
 * The eight fishing phases.
 *
 * Byte-for-byte the union `FishingScene` declares at line 70, and exactly the eight
 * names plan section 17's scope line names. See the module header's reconciliation
 * note; there is nothing to normalise, so nothing is.
 */
export type FishingStateName =
  | 'idle'
  | 'powering'
  | 'casting'
  | 'waiting'
  | 'biting'
  | 'reeling'
  | 'caught'
  | 'missed';

/** Every state name, in the scene's declaration order. */
export const FISHING_STATE_NAMES: readonly FishingStateName[] = [
  'idle',
  'powering',
  'casting',
  'waiting',
  'biting',
  'reeling',
  'caught',
  'missed',
];

// ── Audio hooks ──────────────────────────────────────────────────────────────

/**
 * What the machine says should be heard.
 *
 * The machine **names** these; it never plays them. The renderer maps each to its
 * sound. The six are `FishingScene`'s six `audioManager.playSfx` calls, in the
 * order the scene plays them, and the comments record the `playSfx` key each one
 * corresponds to so the mapping cannot be re-derived by guesswork:
 *
 * | Hook | Scene call | `playSfx` key |
 * |------|-----------|---------------|
 * | `cast` | `castLine` | `fish-cast` |
 * | `splash` | `splashAt`, from the landing tick | `fish-splash` |
 * | `bite` | `triggerBite` | `fish-bite` |
 * | `reel-in` | `setHook` | `fish-reel` |
 * | `catch` | `catchFish` | `fish-catch` |
 * | `miss` | `missFish`, from either window expiry | `fish-miss` |
 *
 * `triggerBite` and `missFish` also carry `TODO: wire sound effect` comments in the
 * scene even though they call `playSfx`. Those TODOs are stale and are left in the
 * rollback lane untouched; here every hook is emitted by construction, which is
 * what makes "emitted in the right order with no duplicates" a testable claim.
 */
export type FishingAudioHook = 'cast' | 'splash' | 'bite' | 'reel-in' | 'catch' | 'miss';

/** An effect the renderer must carry out. The machine produces; nobody plays. */
export type FishingMachineEffect =
  | { readonly type: 'audio'; readonly hook: FishingAudioHook }
  | {
      readonly type: 'catch-revealed';
      readonly catalogId: string;
      readonly rarity: FishRarity;
      /** The one-based cast this catch belongs to, for the catch identity. */
      readonly castNumber: number;
      readonly description: string;
    };

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * Every input the machine accepts.
 *
 * `nowMs` is required on every member and is the **only** clock. Elapsed time for
 * integration is derived from the difference between successive `nowMs`, so a
 * renderer that ticks at 30 fps and one that ticks at 120 Hz agree, and a renderer
 * cannot pass a delta that disagrees with its own timestamps.
 */
export type FishingMachineEvent =
  /** Learner action (1). Begin charging the cast. Legal in `idle` only. */
  | { readonly type: 'begin-power'; readonly nowMs: number }
  /**
   * Learner action (2). Walking intent along the shore.
   *
   * `-1`, `0`, or `1`. Two opposed keys held at once is `0` in `FishingScene`
   * (`dx` accumulates `-1` then `+1`), and `0` is that result; the renderer
   * resolves opposed keys, the machine never sees both. Legal in `idle`, `caught`,
   * and `missed` only - the scene gates `updatePlayerMovement` on exactly those
   * three states.
   */
  | {
      readonly type: 'move';
      readonly nowMs: number;
      readonly intent: -1 | 0 | 1;
    }
  /** Learner action (3). Let go at the current power. Legal in `powering` only. */
  | { readonly type: 'release'; readonly nowMs: number }
  /** Learner action (4). Strike at a bite. Legal in `biting`, inside the window. */
  | { readonly type: 'hook'; readonly nowMs: number }
  /** Learner action (5, 6). Abandon the outcome and return to the shore. */
  | { readonly type: 'reset'; readonly nowMs: number }
  /**
   * The clock. Integrates motion, power, deadlines.
   *
   * Legal in every state, and a no-op in `idle`. This is the event that makes
   * `missed` reachable: both windows are checked here and nowhere else.
   */
  | { readonly type: 'tick'; readonly nowMs: number }
  /** The layout. Recomputes every viewport-derived line, as `relayout` did. */
  | {
      readonly type: 'resize';
      readonly nowMs: number;
      readonly viewport: FishingViewport;
    };

// ── State ────────────────────────────────────────────────────────────────────

/** The viewport the machine lays the world out in. */
export interface FishingViewport {
  readonly width: number;
  readonly height: number;
}

/** What the machine knows about the world it is describing. */
export interface FishingMachineState {
  readonly phase: FishingStateName;
  readonly viewport: FishingViewport;
  /** The learner's walk intent, held between `move` events. */
  readonly moveIntent: -1 | 0 | 1;
  /** Which way the learner faces. Sticky: `FishingScene` keeps the last facing. */
  readonly facing: 'left' | 'right';
  /** Player x, clamped to `[PLAYER_EDGE_MARGIN, width - PLAYER_EDGE_MARGIN]`. */
  readonly playerX: number;
  /** Cast charge, `0`..`1`, filling at `POWER_BUILD_TIME_MS` from zero. */
  readonly power: number;
  /** The bobber, while it is in the air or on the water. */
  readonly bobber: { readonly x: number; readonly y: number; readonly visible: boolean };
  /** The bobber's velocity, px/s. Zeroed when the bobber hits a side edge. */
  readonly bobberVelocity: { readonly vx: number; readonly vy: number };
  /** Where the cast is aimed: the y the bobber stops at. */
  readonly castTargetY: number;
  /** The fish that will bite, rolled at the landing tick from the seeded stream. */
  readonly candidate: FishCatalogEntry | null;
  /** Where that fish is swimming in from. */
  readonly fishDirection: FishDirection;
  readonly fish: { readonly x: number; readonly y: number; readonly visible: boolean };
  /** Straight-line approach the fish is on, from its entry point to the bobber. */
  readonly approach: {
    readonly fromX: number;
    readonly fromY: number;
    readonly toX: number;
    readonly toY: number;
    /** Pixels already swum along the line. */
    readonly travelled: number;
    /** Length of the line, px. */
    readonly length: number;
  } | null;
  /**
   * The bite window's deadline, or `null` when no window is open.
   *
   * Set when the bite fires, consumed by `hook` or by the expiry that produces
   * `missed`. `FishingScene` holds this in a `Phaser.Time.TimerEvent` plus a
   * `biteWindowActive` flag; a deadline in state is the same rule with no
   * renderer-owned timer to keep in step, which is what lets a test produce
   * `missed` in one tick.
   */
  readonly biteWindowDeadlineMs: number | null;
  /**
   * The proximity search's deadline, or `null` when the bobber is not down.
   *
   * `MAX_PROXIMITY_WAIT_MS` after the landing. This is the scene's
   * `waitStartTime` fallback, kept as a deadline rather than compared against a
   * `Phaser` clock read inside `update`.
   */
  readonly proximityDeadlineMs: number | null;
  /** The reel's deadline, or `null` when not reeling. */
  readonly reelDeadlineMs: number | null;
  /**
   * How many casts this session has started, so the one in flight or just resolved is
   * the session's *n*-th cast, one-based.
   *
   * `0` before any cast; `1` on the first `release`. Monotonic for the life of the
   * state and **never** reset by `reset`; a new session is a new state with a new
   * context. This is the component that tells two catches of the same species in one
   * session apart, so it must not rewind - see `src/core/fishing/catchRewards.ts` for
   * the identity it is half of.
   */
  readonly castNumber: number;
  /** Whether this subject may be fished at all. See the header's eligibility note. */
  readonly eligible: boolean;
  /** `nowMs` of the most recent event, so `tick` can derive elapsed time. */
  readonly lastNowMs: number;
}

// ── Result ───────────────────────────────────────────────────────────────────

/**
 * Why an event was refused.
 *
 * A code, never data. `illegal-transition` is the interesting one: it is what a
 * DOM control learns when it fires in the wrong phase, and it is why no control has
 * to guess whether its press did anything.
 */
export type FishingRefusalReason =
  | 'illegal-transition'
  | 'fishing-not-eligible'
  | 'bite-window-closed';

/** What one reducer call did. */
export interface FishingMachineResult {
  /** The next state. Byte-equal to the input state when `accepted` is `false`. */
  readonly state: FishingMachineState;
  /** Whether the event was applied. */
  readonly accepted: boolean;
  /** Why it was not, or `null` when it was. */
  readonly refusal: FishingRefusalReason | null;
  /** What the renderer must now do, in order. Empty when refused. */
  readonly effects: readonly FishingMachineEffect[];
}

// ── Layout and physics constants ─────────────────────────────────────────────
//
// Every value below is `FishingScene`'s, named the same as in the scene so the two
// can be compared line by line. Nothing here is tuned: changing a number changes
// the feel of the pond, which is a product decision and not this phase's.

/** Fraction of the viewport height at the distant horizon. `HORIZON_FRACTION`. */
export const FISHING_HORIZON_FRACTION = 0.1;
/** Fraction of the viewport height where the foreground shore starts. */
export const FISHING_SHORE_FRACTION = 0.8;
/** Player y as a fraction of viewport height, standing on the shore. */
export const FISHING_PLAYER_Y_FRACTION = 0.87;
/** Player's starting x as a fraction of viewport width. */
export const FISHING_PLAYER_START_X_FRACTION = 0.5;
/** Player walk speed, px/s. `PLAYER_MOVE_SPEED`. */
export const FISHING_PLAYER_MOVE_SPEED = 200;
/** Margin from the viewport edges for player movement bounds. */
export const FISHING_PLAYER_EDGE_MARGIN = 50;
/** Speed the bobber travels upward during a cast, px/s. `CAST_SPEED`. */
export const FISHING_CAST_SPEED = 380;
/** Time to charge a cast from zero to full, ms. `POWER_BUILD_TIME_MS`. */
export const FISHING_POWER_BUILD_TIME_MS = 1500;
/** Margin from the horizon for the maximum cast distance, px. `HORIZON_MARGIN`. */
export const FISHING_HORIZON_MARGIN = 16;
/** Horizontal inset the bobber is clamped to, px. The scene's `margin = 20`. */
export const FISHING_BOBBER_EDGE_MARGIN = 20;
/** Reel animation duration, ms. `REEL_DURATION_MS`. */
export const FISHING_REEL_DURATION_MS = 600;
/** Distance at which a fish strikes, px. `PROXIMITY_THRESHOLD`. */
export const FISHING_PROXIMITY_THRESHOLD = 50;
/** Fish silhouette swim speed, px/s. `FISH_SWIM_SPEED`. */
export const FISHING_FISH_SWIM_SPEED = 80;
/** The minimum charge a cast can have. `Math.max(0.12, powerValue)`. */
export const FISHING_MIN_CAST_POWER = 0.12;

/**
 * Where a fish's bite centre sits relative to its drawn position.
 *
 * The scene measures proximity to `fishSprite.y + displayHeight / 2`, and the
 * silhouette is loaded at 64x32, so the bite centre is 16 px below the sprite's
 * top-left. Baking it into the state removes a sprite measurement from a domain
 * rule while keeping the exact test the scene performed; a renderer that scales the
 * silhouette should pass a scaled threshold rather than re-deriving this.
 */
export const FISHING_FISH_BITE_CENTRE_OFFSET_Y = 16;

/**
 * A subject must have cleared at least this many rooms before it may be fished.
 *
 * `FishingScene`'s overlay says "Defeat encounters in the nearby dungeon to unlock
 * fish here", and `studyFlow.enterFishing` tests `clearedRoomCount > 0`. The count
 * is now read from the **context's** subject.
 */
export const FISHING_ELIGIBILITY_MIN_CLEARED_ROOMS = 1;

/**
 * Whether a subject with `clearedRoomCount` cleared rooms may be fished.
 *
 * Total for every integer input, including a negative one, so a snapshot from a
 * half-migrated record cannot make eligibility throw.
 */
export function isFishingEligible(clearedRoomCount: number): boolean {
  if (!Number.isFinite(clearedRoomCount)) return false;
  return Math.max(0, Math.trunc(clearedRoomCount)) >= FISHING_ELIGIBILITY_MIN_CLEARED_ROOMS;
}

// ── Derived layout ───────────────────────────────────────────────────────────

/** The horizon line's y for a viewport. */
export function fishingHorizonY(viewport: FishingViewport): number {
  return Math.floor(viewport.height * FISHING_HORIZON_FRACTION);
}

/** The near shore line's y for a viewport. */
export function fishingShoreY(viewport: FishingViewport): number {
  return Math.floor(viewport.height * FISHING_SHORE_FRACTION);
}

/** The player line's y for a viewport. */
export function fishingPlayerY(viewport: FishingViewport): number {
  return Math.floor(viewport.height * FISHING_PLAYER_Y_FRACTION);
}

/** The player's starting x for a viewport. */
export function fishingPlayerStartX(viewport: FishingViewport): number {
  return Math.floor(viewport.width * FISHING_PLAYER_START_X_FRACTION);
}

/**
 * Where the rod tip is, given the player's x.
 *
 * `FishingScene.getRodTip`'s no-sprite fallback, `(playerX + 12, playerY - 70)`,
 * which is also the bobber's launch point. The sprite path rotates the same lever
 * by ±7°, which moves the tip by a few pixels; this machine uses the unrotated
 * geometry so that the cast trajectory, the proximity test, and the drawn line all
 * agree on one point. Exported because the renderer draws the line to it.
 */
export function fishingRodTip(
  playerX: number,
  viewport: FishingViewport,
): { readonly x: number; readonly y: number } {
  return { x: playerX + 12, y: fishingPlayerY(viewport) - 70 };
}

/**
 * `Phaser.Math.Clamp`, including its inverted-bounds behaviour.
 *
 * Reproduced rather than imported because this module may not depend on Phaser, and
 * because the inverted case is real: a viewport narrower than
 * `2 * FISHING_PLAYER_EDGE_MARGIN` makes the bounds cross, and Phaser resolves that
 * to `min`. Reproducing it keeps a narrow embedded viewport from teleporting the
 * learner somewhere the rollback lane would not.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * The seed `FishingScene.seedRng` derives from a date string and a player class.
 *
 * Reproduced exactly - the same 31-fold multiply-minus hash over the same two code
 * point runs - so the pond rolls the same fish on the same day for the same
 * archetype as it did before the rebuild. `dateString` is `YYYY-MM-DD`, which is
 * `new Date().toISOString().slice(0, 10)` at the call site.
 *
 * The return value is a signed 32-bit integer, so `createSeededRng` receives the
 * same input it received before.
 */
export function deriveFishingSeed(dateString: string, playerClass: string): number {
  let hash = 0;
  for (let index = 0; index < dateString.length; index += 1) {
    hash = ((hash << 5) - hash) + dateString.charCodeAt(index);
    hash |= 0;
  }
  for (let index = 0; index < playerClass.length; index += 1) {
    hash = ((hash << 5) - hash) + playerClass.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

/**
 * A seeded generator for a day and an archetype.
 *
 * The seam a renderer uses instead of calling `createSeededRng` itself: the seed
 * rule is here, in one place, with the date and the class as the only inputs.
 */
export function createFishingSessionRng(dateString: string, playerClass: string): () => number {
  return createSeededRng(deriveFishingSeed(dateString, playerClass));
}

// ── Construction ─────────────────────────────────────────────────────────────

/** Everything {@link createFishingState} needs. */
export interface CreateFishingStateInput {
  readonly viewport: FishingViewport;
  /** The session's start, ms. Becomes `lastNowMs`. */
  readonly nowMs: number;
  readonly eligible: boolean;
  /**
   * Casts already started in this session. Defaults to `0`, so the first `release`
   * makes the first cast.
   *
   * Only a caller **restoring** a session sets this, to continue a counter it had
   * already advanced. There is no production caller that needs it, because a pond is
   * never re-entered after a reload - and a cast in progress cannot be resumed, since
   * nothing about it is durable. It exists so the counter's meaning is expressible, not
   * so a reload can continue mid-cast.
   */
  readonly castNumber?: number;
}

/**
 * A fresh session, waiting on the shore.
 *
 * `castNumber` starts at `0` and is incremented by each accepted `release`, so the
 * first cast of a session is cast 1. It is never rewound, because the catch identity is
 * built from it: a session whose counter reset would let a later cast re-derive an
 * earlier cast's identity and suppress a real catch. See
 * `src/core/fishing/catchRewards.ts`.
 */
export function createFishingState(input: CreateFishingStateInput): FishingMachineState {
  const viewport = normalizeViewport(input.viewport);
  const nowMs = safeNow(input.nowMs);
  return {
    phase: 'idle',
    viewport,
    moveIntent: 0,
    facing: 'right',
    playerX: fishingPlayerStartX(viewport),
    power: 0,
    bobber: { x: 0, y: 0, visible: false },
    bobberVelocity: { vx: 0, vy: 0 },
    castTargetY: 0,
    candidate: null,
    fishDirection: 'right',
    fish: { x: 0, y: 0, visible: false },
    approach: null,
    biteWindowDeadlineMs: null,
    proximityDeadlineMs: null,
    reelDeadlineMs: null,
    castNumber: Math.max(0, Math.trunc(input.castNumber ?? 0)),
    eligible: input.eligible,
    lastNowMs: nowMs,
  };
}

function normalizeViewport(viewport: FishingViewport): FishingViewport {
  const width = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const height = Number.isFinite(viewport.height) ? Math.max(0, viewport.height) : 0;
  return { width, height };
}

function safeNow(nowMs: number): number {
  return Number.isFinite(nowMs) ? nowMs : 0;
}

function refuse(
  state: FishingMachineState,
  reason: FishingRefusalReason,
): FishingMachineResult {
  return { state, accepted: false, refusal: reason, effects: [] };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

/**
 * Advance the machine by one event.
 *
 * Total: every event produces a result, and every result has a state. An event that
 * is illegal in the current phase returns the input state unchanged with
 * `accepted: false`. Nothing throws, and the reducer never mutates its input.
 *
 * @param state The current state.
 * @param event The input. Carries `nowMs`, the only clock.
 * @param rng The seeded stream, from {@link createFishingSessionRng} or a test's own
 *   generator. Consumed in the order the header documents; a state that transitions
 *   without a roll draws nothing.
 */
export function reduceFishing(
  state: FishingMachineState,
  event: FishingMachineEvent,
  rng: () => number,
): FishingMachineResult {
  const nowMs = safeNow(event.nowMs);

  switch (event.type) {
    case 'begin-power':
      return beginPower(state, nowMs);
    case 'release':
      return release(state, nowMs, rng);
    case 'hook':
      return hook(state, nowMs);
    case 'reset':
      return reset(state, nowMs);
    case 'move':
      return move(state, event.intent === -1 || event.intent === 1 ? event.intent : 0, nowMs);
    case 'tick':
      return tick(state, nowMs, rng);
    case 'resize':
      return resize(state, normalizeViewport(event.viewport), nowMs);
    default: {
      // Structural exhaustiveness: adding an event member without a runner here
      // fails `npm run typecheck` at this line.
      const unhandled: never = event;
      return unhandled;
    }
  }
}

// ── Learners' actions ────────────────────────────────────────────────────────

function beginPower(state: FishingMachineState, nowMs: number): FishingMachineResult {
  if (state.phase !== 'idle') return refuse(state, 'illegal-transition');
  // The eligibility gate, after the phase gate: a control in the wrong phase gets
  // the phase answer, which is the one it can act on.
  if (!state.eligible) return refuse(state, 'fishing-not-eligible');

  const tip = fishingRodTip(state.playerX, state.viewport);
  return {
    state: {
      ...state,
      phase: 'powering',
      power: 0,
      bobber: { x: tip.x, y: tip.y, visible: true },
      lastNowMs: nowMs,
    },
    accepted: true,
    refusal: null,
    // No hook here: `startPowering` plays nothing. The `cast` hook is on release.
    effects: [],
  };
}

function release(
  state: FishingMachineState,
  nowMs: number,
  rng: () => number,
): FishingMachineResult {
  if (state.phase !== 'powering') return refuse(state, 'illegal-transition');

  // Draw 1 of 4: the spread angle.
  const spreadAngle = (rng() - 0.5) * 0.3;
  const power = Math.max(FISHING_MIN_CAST_POWER, state.power);
  const vx = power * FISHING_CAST_SPEED * Math.sin(spreadAngle);
  const vy = -power * FISHING_CAST_SPEED * Math.cos(spreadAngle);

  const viewport = state.viewport;
  const targetY =
    fishingShoreY(viewport) -
    power *
      (fishingShoreY(viewport) - fishingHorizonY(viewport) - FISHING_HORIZON_MARGIN * 2);

  const tip = fishingRodTip(state.playerX, viewport);
  // The cast about to begin is the session's *n*-th, one-based. A `release` that is
  // refused never reaches here, so the counter cannot advance twice for one cast.
  const castNumber = state.castNumber + 1;

  return {
    state: {
      ...state,
      phase: 'casting',
      power,
      castNumber,
      bobber: { x: tip.x, y: tip.y, visible: true },
      bobberVelocity: { vx, vy },
      castTargetY: targetY,
      // A cast that has not landed has no candidate. Carrying the previous one
      // would let a `biting` state report a fish the stream never rolled.
      candidate: null,
      fish: { x: 0, y: 0, visible: false },
      approach: null,
      fishDirection: 'right',
      biteWindowDeadlineMs: null,
      proximityDeadlineMs: null,
      reelDeadlineMs: null,
      lastNowMs: nowMs,
    },
    accepted: true,
    refusal: null,
    effects: [{ type: 'audio', hook: 'cast' }],
  };
}

function hook(state: FishingMachineState, nowMs: number): FishingMachineResult {
  if (state.phase !== 'biting') return refuse(state, 'illegal-transition');
  // The scene's `if (this.state === 'biting') { if (this.biteWindowActive) ... }`:
  // a press after the window closed did nothing, and here it says why.
  if (state.biteWindowDeadlineMs === null) return refuse(state, 'bite-window-closed');

  return {
    state: {
      ...state,
      phase: 'reeling',
      biteWindowDeadlineMs: null,
      proximityDeadlineMs: null,
      reelDeadlineMs: nowMs + FISHING_REEL_DURATION_MS,
      lastNowMs: nowMs,
    },
    accepted: true,
    refusal: null,
    effects: [{ type: 'audio', hook: 'reel-in' }],
  };
}

function reset(state: FishingMachineState, nowMs: number): FishingMachineResult {
  if (state.phase !== 'caught' && state.phase !== 'missed') {
    return refuse(state, 'illegal-transition');
  }

  const tip = fishingRodTip(state.playerX, state.viewport);
  return {
    state: {
      ...state,
      phase: 'idle',
      moveIntent: 0,
      power: 0,
      bobber: { x: tip.x, y: tip.y, visible: false },
      bobberVelocity: { vx: 0, vy: 0 },
      candidate: null,
      fish: { x: 0, y: 0, visible: false },
      approach: null,
      biteWindowDeadlineMs: null,
      proximityDeadlineMs: null,
      reelDeadlineMs: null,
      // `castNumber` is deliberately carried: it is the session's cast counter, not
      // the current cast's, and rewinding it would let a later cast re-derive an
      // earlier catch's identity.
      lastNowMs: nowMs,
    },
    accepted: true,
    refusal: null,
    effects: [],
  };
}

function move(
  state: FishingMachineState,
  intent: -1 | 0 | 1,
  nowMs: number,
): FishingMachineResult {
  if (
    state.phase !== 'idle' &&
    state.phase !== 'caught' &&
    state.phase !== 'missed'
  ) {
    return refuse(state, 'illegal-transition');
  }
  // Facing is sticky, as in the scene: no intent keeps the last facing rather than
  // snapping to `right`.
  const facing = intent === 0 ? state.facing : intent < 0 ? 'left' : 'right';
  return {
    state: { ...state, moveIntent: intent, facing, lastNowMs: nowMs },
    accepted: true,
    refusal: null,
    effects: [],
  };
}

function resize(
  state: FishingMachineState,
  viewport: FishingViewport,
  nowMs: number,
): FishingMachineResult {
  // `relayout` recomputed the lines and re-placed the player at his x, so the
  // player's position survives a resize and only the lines move. A bobber already
  // in the water keeps its pixel position; the renderer redraws it there.
  return {
    state: { ...state, viewport, lastNowMs: nowMs },
    accepted: true,
    refusal: null,
    effects: [],
  };
}

// ── The clock ────────────────────────────────────────────────────────────────

function tick(
  state: FishingMachineState,
  nowMs: number,
  rng: () => number,
): FishingMachineResult {
  const elapsedMs = Math.max(0, nowMs - state.lastNowMs);
  const effects: FishingMachineEffect[] = [];

  // Movement, first, because it moves the rod tip and therefore the bobber's
  // position. Gated on the same three states as the scene's `updatePlayerMovement`.
  const walkable =
    state.phase === 'idle' || state.phase === 'caught' || state.phase === 'missed';
  let playerX = state.playerX;
  if (walkable && state.moveIntent !== 0 && elapsedMs > 0) {
    playerX = clamp(
      playerX + state.moveIntent * FISHING_PLAYER_MOVE_SPEED * (elapsedMs / 1000),
      FISHING_PLAYER_EDGE_MARGIN,
      state.viewport.width - FISHING_PLAYER_EDGE_MARGIN,
    );
  }

  const phase = state.phase;

  // ── powering: the meter fills, and nothing else ───────────────────────────
  if (phase === 'powering') {
    const power = Math.min(1, state.power + elapsedMs / FISHING_POWER_BUILD_TIME_MS);
    return accept({ ...state, power, playerX, lastNowMs: nowMs }, effects);
  }

  // ── casting: ballistic flight, then the landing ───────────────────────────
  if (phase === 'casting') {
    const next = flyBobber({ ...state, playerX }, nowMs);
    if (next.landed) {
      effects.push({ type: 'audio', hook: 'splash' });
      // Draws 2-4 of 4, on the landing tick: the catalogue roll, the direction, and
      // the bottom-entry offset.
      return accept(startWaiting(next.state, nowMs, rng), effects);
    }
    return accept({ ...next.state, lastNowMs: nowMs }, effects);
  }

  // ── waiting: the fish swims in, and two deadlines race ─────────────────────
  if (phase === 'waiting') {
    const approached = advanceApproach({ ...state, playerX }, elapsedMs);

    // Proximity first, deadline second: the scene checks proximity above the
    // max-timeout fallback in one `update` body, so on the tick where both are true
    // the bite wins. Preserved, because it is the order the learner observes.
    const struck = didFishStrike(approached);
    if (struck) {
      effects.push({ type: 'audio', hook: 'bite' });
      return accept(
        {
          ...approached,
          phase: 'biting',
          biteWindowDeadlineMs: nowMs + BITE_WINDOW_SEC * 1000,
          proximityDeadlineMs: null,
          fish: { x: approached.fish.x, y: approached.fish.y, visible: true },
          lastNowMs: nowMs,
        },
        effects,
      );
    }
    if (
      approached.proximityDeadlineMs !== null &&
      nowMs >= approached.proximityDeadlineMs
    ) {
      effects.push({ type: 'audio', hook: 'miss' });
      return accept(missFish(approached, nowMs), effects);
    }
    return accept({ ...approached, lastNowMs: nowMs }, effects);
  }

  // ── biting: the window, and only the window ───────────────────────────────
  if (phase === 'biting') {
    if (state.biteWindowDeadlineMs !== null && nowMs >= state.biteWindowDeadlineMs) {
      effects.push({ type: 'audio', hook: 'miss' });
      return accept(missFish({ ...state, playerX }, nowMs), effects);
    }
    return accept({ ...state, playerX, lastNowMs: nowMs }, effects);
  }

  // ── reeling: the catch arrives when the reel completes ─────────────────────
  if (phase === 'reeling') {
    if (state.reelDeadlineMs !== null && nowMs >= state.reelDeadlineMs) {
      const candidate = state.candidate;
      effects.push({ type: 'audio', hook: 'catch' });
      const tip = fishingRodTip(playerX, state.viewport);
      return accept(
        {
          ...state,
          phase: 'caught',
          playerX,
          bobber: { x: tip.x, y: tip.y, visible: false },
          fish: { x: tip.x, y: tip.y - 20, visible: true },
          reelDeadlineMs: null,
          lastNowMs: nowMs,
        },
        candidate === null
          ? effects
          : [
              ...effects,
              {
                type: 'catch-revealed' as const,
                catalogId: candidate.id,
                rarity: candidate.rarity,
                castNumber: state.castNumber,
                description: candidate.description,
              },
            ],
      );
    }
    return accept({ ...state, playerX, lastNowMs: nowMs }, effects);
  }

  // `idle`, `caught`, and `missed` tick: nothing to integrate but the walk.
  return accept({ ...state, playerX, lastNowMs: nowMs }, effects);
}

function accept(
  state: FishingMachineState,
  effects: readonly FishingMachineEffect[],
): FishingMachineResult {
  return { state, accepted: true, refusal: null, effects };
}

// ── Cast flight ──────────────────────────────────────────────────────────────

function flyBobber(
  state: FishingMachineState,
  nowMs: number,
): { readonly state: FishingMachineState; readonly landed: boolean } {
  const elapsedSeconds = Math.max(0, nowMs - state.lastNowMs) / 1000;
  const margin = FISHING_BOBBER_EDGE_MARGIN;
  let { x, y } = state.bobber;
  let { vx, vy } = state.bobberVelocity;

  x += vx * elapsedSeconds;
  y += vy * elapsedSeconds;

  // The scene zeroes the horizontal velocity on a side clamp, so the bobber stops
  // drifting once it is against an edge. Preserved.
  if (x < margin) {
    x = margin;
    vx = 0;
  }
  if (x > state.viewport.width - margin) {
    x = state.viewport.width - margin;
    vx = 0;
  }

  // `FishingScene` compares against `bobberTargetX`, which despite its name holds
  // the target **y**. The behaviour is preserved; the misnomer is not carried over.
  if (y <= state.castTargetY) {
    y = state.castTargetY;
    return {
      landed: true,
      state: {
        ...state,
        bobber: { x, y, visible: true },
        bobberVelocity: { vx: 0, vy: 0 },
        lastNowMs: nowMs,
      },
    };
  }

  return {
    landed: false,
    state: { ...state, bobber: { x, y, visible: true }, bobberVelocity: { vx, vy } },
  };
}

// ── Waiting: the roll and the approach ───────────────────────────────────────

function startWaiting(
  state: FishingMachineState,
  nowMs: number,
  rng: () => number,
): FishingMachineState {
  // Draws 2 and 3 of 4: rarity, then the catalogue index inside that rarity; then
  // the entry direction.
  const { entry } = rollFishRarity(rng);
  const direction = rollFishDirection(rng);

  // The approach target is `startFishSwim`'s: the bobber, nudged 24 px down and
  // clamped to 10 px above the shore.
  const toX = state.bobber.x;
  const toY = Math.min(state.bobber.y + 24, fishingShoreY(state.viewport) - 10);

  let fromX: number;
  let fromY: number;
  if (direction === 'right') {
    fromX = state.viewport.width + 40;
    fromY = toY;
  } else {
    // Draw 4 of 4, only on the bottom entry: the horizontal offset of the approach.
    fromX = toX + (rng() * 160 - 80);
    fromY = state.viewport.height + 40;
  }

  const length = Math.hypot(toX - fromX, toY - fromY);

  return {
    ...state,
    phase: 'waiting',
    candidate: entry,
    fishDirection: direction,
    fish: { x: fromX, y: fromY, visible: true },
    approach: { fromX, fromY, toX, toY, travelled: 0, length },
    biteWindowDeadlineMs: null,
    proximityDeadlineMs: nowMs + MAX_PROXIMITY_WAIT_MS,
    reelDeadlineMs: null,
    lastNowMs: nowMs,
  };
}

/**
 * Roll an entry direction with `FISH_DIRECTION_WEIGHTS`, from the seeded stream.
 *
 * `FishingScene.rollFishDirection`, verbatim, including the `<=` comparison and the
 * `'right'` fallback for a roll that exhausts the table.
 */
function rollFishDirection(rng: () => number): FishDirection {
  const total = Object.values(FISH_DIRECTION_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const roll = rng() * total;
  let cumulative = 0;
  for (const [direction, weight] of Object.entries(FISH_DIRECTION_WEIGHTS)) {
    cumulative += weight;
    if (roll <= cumulative) return direction as FishDirection;
  }
  return 'right';
}

/** Move the approaching fish along its line at the scene's swim speed. */
function advanceApproach(state: FishingMachineState, elapsedMs: number): FishingMachineState {
  const approach = state.approach;
  if (approach === null || elapsedMs <= 0) return state;

  const travelled = Math.min(approach.length, approach.travelled + FISHING_FISH_SWIM_SPEED * (elapsedMs / 1000));
  const ratio = approach.length === 0 ? 1 : travelled / approach.length;
  return {
    ...state,
    fish: {
      x: approach.fromX + (approach.toX - approach.fromX) * ratio,
      y: approach.fromY + (approach.toY - approach.fromY) * ratio,
      visible: true,
    },
    approach: { ...approach, travelled },
  };
}

/**
 * The scene's proximity test, exactly.
 *
 * `hypot(fish.x - bobber.x, fish.y + displayHeight / 2 - bobber.y)` at or under
 * `PROXIMITY_THRESHOLD`, with the sprite's 32 px height folded into
 * {@link FISHING_FISH_BITE_CENTRE_OFFSET_Y}. The scene also required both sprites
 * to be visible; that is a renderer condition with no domain meaning and is not
 * checked here.
 */
export function didFishStrike(state: FishingMachineState): boolean {
  if (state.phase !== 'waiting') return false;
  if (!state.fish.visible || !state.bobber.visible) return false;
  const dx = state.fish.x - state.bobber.x;
  const dy = state.fish.y + FISHING_FISH_BITE_CENTRE_OFFSET_Y - state.bobber.y;
  return Math.hypot(dx, dy) <= FISHING_PROXIMITY_THRESHOLD;
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

function missFish(state: FishingMachineState, nowMs: number): FishingMachineState {
  return {
    ...state,
    phase: 'missed',
    // The scene keeps the fish sprite flying off on a tween, so it stays visible
    // for the renderer to animate; only the bobber is left where it was.
    biteWindowDeadlineMs: null,
    proximityDeadlineMs: null,
    reelDeadlineMs: null,
    lastNowMs: nowMs,
  };
}

// ── Read helpers for surfaces ────────────────────────────────────────────────

/**
 * The label a surface should show for the current phase.
 *
 * A *hint*, not instructional text: plan 6.2 gives instructional text to React DOM,
 * so this is one shared starting point rather than a substitute for copy the UI owns.
 * Kept here because "which phase am I in, and what does it invite" is a domain
 * fact, and because the rollback lane's hint strings are worth preserving verbatim
 * for a Pixi HUD that has not shipped yet.
 */
export function fishingPhaseHint(state: FishingMachineState): string {
  if (!state.eligible) return 'Return to the village and clear some dungeon rooms first';
  switch (state.phase) {
    case 'idle':
      return 'Hold click on the lake to build power, release to cast';
    case 'powering':
      return 'Hold...';
    case 'casting':
      return 'Casting...';
    case 'waiting':
      return 'Waiting for a bite...';
    case 'biting':
      return 'BITE! Click to reel in!';
    case 'reeling':
      return 'Reeling in...';
    case 'caught':
      return 'Fish caught! Click to cast again';
    case 'missed':
      return 'The fish got away... Click to cast again';
    default:
      return '';
  }
}

/**
 * Whether the phase's outcome is settled, so a surface can offer "cast again".
 *
 * The two phases `reset` accepts. Provided so a UI control can be disabled rather
 * than firing an event that would be refused.
 */
export function canResetFishing(state: FishingMachineState): boolean {
  return state.phase === 'caught' || state.phase === 'missed';
}

/**
 * The catalogue a cast can roll from, re-exported so a renderer configures itself
 * from one import of this module.
 *
 * A re-export rather than a copy: `FISH_CATALOG`, `FISH_RARITY_WEIGHTS`, and
 * `FISH_RARITY_XP_MULTIPLIER` are unchanged by this phase and stay the single
 * definitions in `fishingTypes.ts`.
 */
export { FISH_CATALOG, FISH_RARITY_XP_MULTIPLIER };