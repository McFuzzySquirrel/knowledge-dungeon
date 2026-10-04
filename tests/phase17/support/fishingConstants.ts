/**
 * Phase 17 test support: the machine's tuned constants, imported by the tests.
 *
 * These are *re-declarations*, not re-exports, on purpose. A test that imports
 * `FISHING_REEL_DURATION_MS` from the module under test cannot catch someone changing
 * the reel duration: the assertion moves with the implementation. Declaring them here
 * means `tests/phase17/fishingStateMachine.test.ts` fails if a constant the plan calls
 * "preserve" ever changes, which is exactly the guarantee the phase's "preserve
 * power casting, bite detection, hook window, movement" scope line asks for.
 *
 * Every value is `FishingScene`'s, at `ade1f78`.
 */

/** `REEL_DURATION_MS` - how long the reel animation takes, ms. */
export const FISHING_REEL_DURATION_MS = 600;

/** `PROXIMITY_THRESHOLD` - distance at which a fish strikes, px. */
export const FISHING_PROXIMITY_THRESHOLD = 50;

/** `MAX_PROXIMITY_WAIT_MS` - how long the fish searches before giving up, ms. */
export const FISHING_MAX_PROXIMITY_WAIT_MS = 20_000;

/** `BITE_WINDOW_SEC` - the hook window, ms. */
export const FISHING_BITE_WINDOW_MS = 2_000;

/** `PLAYER_MOVE_SPEED` - walk speed, px/s. */
export const FISHING_PLAYER_MOVE_SPEED = 200;

/** `PLAYER_EDGE_MARGIN` - the movement bound from each viewport edge, px. */
export const FISHING_PLAYER_EDGE_MARGIN = 50;

/** `POWER_BUILD_TIME_MS` - zero to full charge, ms. */
export const FISHING_POWER_BUILD_TIME_MS = 1500;

/** `CAST_SPEED` - the bobber's launch speed, px/s. */
export const FISHING_CAST_SPEED = 380;

/** `HORIZON_MARGIN` - the margin from the horizon for a full cast, px. */
export const FISHING_HORIZON_MARGIN = 16;

/** The bobber's horizontal inset - the scene's local `margin = 20`, px. */
export const FISHING_BOBBER_EDGE_MARGIN = 20;

/** `Math.max(0.12, powerValue)` - the floor on a cast's charge. */
export const FISHING_MIN_CAST_POWER = 0.12;

/** `FISH_SWIM_SPEED` - the approaching fish's speed, px/s. */
export const FISHING_FISH_SWIM_SPEED = 80;

/** The bite window, in the module's own unit. */
export const FISHING_BITE_WINDOW_SEC = FISHING_BITE_WINDOW_MS / 1000;