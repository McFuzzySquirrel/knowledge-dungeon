/**
 * The Cozy motion contract, including reduced motion (Phase 8).
 *
 * Plan 10.1 requires `prefers-reduced-motion` support "in React and Pixi". The
 * two halves of that are deliberately separated here:
 *
 * - **React** reads the `@media (prefers-reduced-motion: reduce)` block in
 *   `src/styles/cozy.css`, which zeroes the emitted `--cozy-duration-*` and
 *   `--cozy-motion-scale` custom properties. No JavaScript is involved, so
 *   there is no first-paint flash of motion.
 * - **A renderer host** calls {@link resolveMotionProfile} with whatever its own
 *   environment observed. The function takes a plain boolean and never reads
 *   `window.matchMedia`, so it is usable from a worker or a non-DOM context.
 *
 * Renderer-neutral by contract: see `RENDERER_NEUTRAL_THEME_MODULES` in
 * `cozyTokens.ts`.
 *
 * Every exported table is frozen, and so is every profile
 * {@link resolveMotionProfile} hands back, because these are read by a renderer
 * on every frame and shared with React: a host that edited a duration in place
 * would silently change it for every other consumer. See the integrity contract
 * in `cozyTokens.ts`.
 *
 * Phase 9 added two things here, both additive: the numeric easing curves a
 * tween library needs, and a defined answer for a name this module does not know.
 */

import { cozyEasingCurve, type CozyEasingCurve } from './cozyNumbers';

/** Named durations in milliseconds. A host multiplies by `MotionProfile.scale`. */
export const COZY_MOTION_DURATION_MS = Object.freeze({
  instant: 0,
  quick: 120,
  base: 200,
  slow: 320,
  deliberate: 480,
} as const);

export type CozyMotionDuration = keyof typeof COZY_MOTION_DURATION_MS;

/** Easing curves, as CSS `cubic-bezier()` argument lists. */
export const COZY_MOTION_EASING = Object.freeze({
  /** Default for a state change that starts and ends in place. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** For something entering the viewport. */
  enter: 'cubic-bezier(0, 0, 0, 1)',
  /** For something leaving. Accelerates away. */
  exit: 'cubic-bezier(0.3, 0, 1, 1)',
} as const);

export type CozyMotionEasing = keyof typeof COZY_MOTION_EASING;

/**
 * The same curves as four numbers each, for a renderer host (Phase 9).
 *
 * `cubic-bezier(...)` is a CSS function, and a WebGL or canvas tween cannot be
 * handed one: it wants `(x1, y1, x2, y2)`. Phase 8 recorded that gap rather than
 * papering over it - "there is no `COZY_MOTION_EASING_CURVE` accessor", in
 * `tests/phase8/pixi-token-consumption.test.ts` - and the derivation closes it.
 *
 * Derived from {@link COZY_MOTION_EASING} at module scope, so the tuple and the
 * string cannot drift: there is no second list of curves to keep in step, and
 * `cozyEasingCurve` throws rather than guessing if a curve is authored in a shape
 * it cannot read. Each tuple is frozen, which matters more here than elsewhere -
 * a tween that received a live array could sort it in place and change the curve
 * for every later animation in the session.
 */
export const COZY_MOTION_EASING_CURVE: Readonly<Record<CozyMotionEasing, CozyEasingCurve>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(COZY_MOTION_EASING) as CozyMotionEasing[]).map((name) => [
        name,
        cozyEasingCurve(COZY_MOTION_EASING[name], `COZY_MOTION_EASING.${name}`),
      ]),
    ) as Record<CozyMotionEasing, CozyEasingCurve>,
  );

/**
 * Named travel distances in pixels. A host multiplies by `MotionProfile.scale`;
 * at scale 0 nothing moves, which is the point of reduced motion.
 */
export const COZY_MOTION_TRAVEL_PX = Object.freeze({
  micro: 2,
  small: 6,
  medium: 12,
  large: 24,
} as const);

export type CozyMotionTravel = keyof typeof COZY_MOTION_TRAVEL_PX;

/** The multiplier a renderer applies with motion allowed. */
export const FULL_MOTION_SCALE = 1;

/**
 * The multiplier a renderer applies under reduced motion.
 *
 * `0` rather than a small non-zero value: a learner's request is "do not move
 * things", and a 0.001 scale still animates, just imperceptibly, which keeps a
 * ticker alive for no benefit.
 */
export const REDUCED_MOTION_SCALE = 0;

/** The duration a reduced-motion profile substitutes for every named duration. */
export const REDUCED_MOTION_DURATION_MS = 0;

/** The distance a reduced-motion profile substitutes for every named travel. */
export const REDUCED_MOTION_TRAVEL_PX = 0;

/**
 * What a profile substitutes for a name it does not know (Phase 9).
 *
 * `0`, and defined at all, because the alternative is worse than a wrong number:
 * `undefined` reaches a host that computes `durationMs(name) / 1000` from a name
 * it read out of data, and that host gets `NaN` seconds - a tween that never
 * settles, or a `setTimeout` that fires immediately, depending on the library.
 * `0` is a real answer in the same units as the table it stands in for: no time,
 * and no distance, which is also the reduced-motion answer.
 *
 * The name is a constant rather than a bare `0` at each call site so the
 * fallback is something a test can name, a host can log, and a future change has
 * to be made in one place.
 */
export const COZY_MOTION_UNKNOWN_VALUE = 0;

/**
 * What a renderer host reads. Immutable, plain data, no DOM.
 *
 * `reduceAll` is a convenience for a host that wants to skip its animation
 * plumbing entirely rather than multiply by `scale`; both are provided so a host
 * cannot accidentally honour the preference in one place and not another.
 */
export interface CozyMotionProfile {
  readonly reduced: boolean;
  readonly scale: number;
  readonly reduceAll: boolean;
  /**
   * Milliseconds for a named duration, already scaled.
   *
   * Total: a name the table does not hold answers {@link COZY_MOTION_UNKNOWN_VALUE}
   * rather than `undefined`, because a host computes seconds from this by dividing
   * by 1000 and `undefined` would become `NaN`. Every declared name is unaffected.
   */
  durationMs(name: CozyMotionDuration): number;
  /**
   * Pixels for a named travel, already scaled.
   *
   * Total in the same way as {@link durationMs}, for the same reason.
   */
  travelPx(name: CozyMotionTravel): number;
  /** The same profile as plain data, for a store or a worker message. */
  readonly serialized: Readonly<{
    reduced: boolean;
    scale: number;
    reduceAll: boolean;
    durations: Readonly<Record<CozyMotionDuration, number>>;
    travel: Readonly<Record<CozyMotionTravel, number>>;
  }>;
}

/**
 * The value for `name`, or `undefined` when the table does not have that key.
 *
 * `Object.hasOwn` rather than a bare index, because the tables are built by
 * `Object.fromEntries` and therefore carry `Object.prototype`: `durations
 * ['toString']` returns a *function*, which `?? COZY_MOTION_UNKNOWN_VALUE` would
 * wave straight through, and a host would then multiply a function by a delta.
 * The same defence `cozyThemeForInput` uses in `cozyTokens.ts`, for the same
 * reason.
 *
 * Costs a property read and no allocation, so a per-frame read stays a per-frame
 * read.
 */
function known<T, K extends PropertyKey>(table: Readonly<Record<K, T>>, name: K): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

function buildProfile(reduced: boolean): CozyMotionProfile {
  const scale = reduced ? REDUCED_MOTION_SCALE : 1;
  const durations = Object.freeze(
    Object.fromEntries(
      Object.entries(COZY_MOTION_DURATION_MS).map(([name, ms]) => [
        name,
        reduced ? REDUCED_MOTION_DURATION_MS : ms,
      ]),
    ) as Record<CozyMotionDuration, number>,
  );
  const travel = Object.freeze(
    Object.fromEntries(
      Object.entries(COZY_MOTION_TRAVEL_PX).map(([name, px]) => [
        name,
        reduced ? REDUCED_MOTION_TRAVEL_PX : px,
      ]),
    ) as Record<CozyMotionTravel, number>,
  );
  return Object.freeze({
    reduced,
    scale,
    reduceAll: reduced,
    // `?? COZY_MOTION_UNKNOWN_VALUE` rather than a bare index: a name that is not
    // a `CozyMotionDuration` can still arrive at runtime - from JSON, from a
    // content table, from a typo in a renderer that has not been type-checked
    // against this module - and the contract here is that a profile answers with
    // a number. The typed behaviour for every declared name is unchanged, because
    // `known` returns exactly what the index would have returned for a key the
    // table owns.
    durationMs: (name: CozyMotionDuration) =>
      known(durations, name) ?? COZY_MOTION_UNKNOWN_VALUE,
    // The same guard on travel, for the same reason and the same per-frame read.
    // Not in the Phase 9 contract, and deliberately not a separate policy: a
    // displacement that resolves to a function is the same defect as a duration
    // that resolves to `undefined`.
    travelPx: (name: CozyMotionTravel) => known(travel, name) ?? COZY_MOTION_UNKNOWN_VALUE,
    serialized: Object.freeze({ reduced, scale, reduceAll: reduced, durations, travel }),
  });
}

const FULL_MOTION_PROFILE = buildProfile(false);
const REDUCED_MOTION_PROFILE = buildProfile(true);

/**
 * Resolve the motion profile for an observed `prefers-reduced-motion` state.
 *
 * The caller owns the detection. In React that is the CSS media query; in a
 * PixiJS host it is `matchMedia('(prefers-reduced-motion: reduce)').matches` in
 * the host, re-evaluated on change.
 */
export function resolveMotionProfile(prefersReducedMotion: boolean): CozyMotionProfile {
  return prefersReducedMotion ? REDUCED_MOTION_PROFILE : FULL_MOTION_PROFILE;
}
