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
 */

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
  /** Milliseconds for a named duration, already scaled. */
  durationMs(name: CozyMotionDuration): number;
  /** Pixels for a named travel, already scaled. */
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
    durationMs: (name: CozyMotionDuration) => durations[name],
    travelPx: (name: CozyMotionTravel) => travel[name],
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
