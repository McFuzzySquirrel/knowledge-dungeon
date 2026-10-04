/**
 * Phase 17: the pure fishing state machine.
 *
 * The machine is the phase's headline deliverable, so this file drives it the way the
 * scene drives it - one event at a time, with an injected clock - and asserts on the
 * four things the phase is about:
 *
 * 1. **Every legal transition happens, and every illegal one is refused** rather than
 *    silently ignored.
 * 2. **`missed` is a state a test can drive**, not an emergent timeout, because both
 *    windows are deadline arithmetic on the injected clock.
 * 3. **A session is reproducible** from its seed, which is what "preserve seeded random
 *    behavior" has to mean for a machine that reads no clock and no `Math.random`.
 * 4. **The audio hooks fire in the scene's order, once each**, because a duplicate
 *    hook is a sound that plays twice.
 *
 * Every fixture is obviously synthetic. No learner data.
 */
import { describe, expect, it } from 'vitest';
import {
  FISHING_STATE_NAMES,
  canResetFishing,
  createFishingSessionRng,
  createFishingState,
  deriveFishingSeed,
  didFishStrike,
  fishingHorizonY,
  fishingPhaseHint,
  fishingPlayerStartX,
  fishingPlayerY,
  fishingRodTip,
  fishingShoreY,
  isFishingEligible,
  reduceFishing,
  type CreateFishingStateInput,
  type FishingMachineEvent,
  type FishingMachineState,
  type FishingStateName,
} from '@/core/fishing/fishingStateMachine';
import {
  FISHING_BOBBER_EDGE_MARGIN,
  FISHING_CAST_SPEED,
  FISHING_FISH_SWIM_SPEED,
  FISHING_HORIZON_MARGIN,
  FISHING_MAX_PROXIMITY_WAIT_MS,
  FISHING_MIN_CAST_POWER,
  FISHING_PLAYER_EDGE_MARGIN,
  FISHING_PLAYER_MOVE_SPEED,
  FISHING_POWER_BUILD_TIME_MS,
  FISHING_PROXIMITY_THRESHOLD,
  FISHING_REEL_DURATION_MS,
} from './support/fishingConstants';

// ── Helpers ──────────────────────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 720 };
const T0 = 1_000_000;

/** Build a session, optionally overriding the defaults. */
function session(overrides: Partial<CreateFishingStateInput> = {}): FishingMachineState {
  return createFishingState({
    viewport: VIEWPORT,
    nowMs: T0,
    eligible: true,
    ...overrides,
  });
}

/** The species and direction one stream's landing tick rolled. */
function rollFor(
  rng: () => number,
): { catalogId: string; rarity: string; direction: string } {
  const waiting = tickUntil(castTo(session(), 0.5, rng), 'waiting', 16, 2_000, rng);
  return {
    catalogId: waiting.candidate!.id,
    rarity: waiting.candidate!.rarity,
    direction: waiting.fishDirection,
  };
}

/**
 * A generator over a fixed stream.
 *
 * Lets a test drive the machine's four gameplay draws deterministically, which is how
 * the two entry directions and a never-arriving fish are reached without depending on
 * which direction a given day's seed happens to roll.
 */
function scriptedRng(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

/**
 * A session on `dateString` for `playerClass`, with that session's own stream.
 *
 * Both are returned because a test that wants a *specific* day's rolls has to use the
 * same date for the state and the generator or the two will not agree.
 */
function seeded(
  dateString: string,
  playerClass: string,
  overrides: Partial<CreateFishingStateInput> = {},
): { state: FishingMachineState; rng: () => number } {
  return {
    state: createFishingState({
      viewport: VIEWPORT,
      nowMs: T0,
      eligible: true,
      ...overrides,
    }),
    rng: createFishingSessionRng(dateString, playerClass),
  };
}

/** Fold a list of events from `from` through **one** generator. */
function fold(
  from: FishingMachineState,
  events: readonly FishingMachineEvent[],
  rng: () => number = createFishingSessionRng('2026-10-03', 'scholar'),
): FishingMachineState {
  let state = from;
  for (const event of events) state = reduceFishing(state, event, rng).state;
  return state;
}

/** One reduction. */
function step(
  state: FishingMachineState,
  event: FishingMachineEvent,
  rng: () => number = createFishingSessionRng('2026-10-03', 'scholar'),
): ReturnType<typeof reduceFishing> {
  return reduceFishing(state, event, rng);
}

/**
 * Charge a cast to `power` and release it, returning the `casting` state.
 *
 * The charge is **ticked** to the requested power before the release, because the
 * machine's power bar only fills on `tick` - releasing on the same timestamp as
 * `begin-power` would always cast at the 0.12 floor.
 */
function castTo(
  state: FishingMachineState,
  power: number,
  rng?: () => number,
): FishingMachineState {
  const stream = rng ?? createFishingSessionRng('2026-10-03', 'scholar');
  const began = reduceFishing(state, { type: 'begin-power', nowMs: T0 }, stream).state;
  const at = T0 + power * FISHING_POWER_BUILD_TIME_MS;
  const charged = reduceFishing(began, { type: 'tick', nowMs: at }, stream).state;
  return reduceFishing(charged, { type: 'release', nowMs: at }, stream).state;
}

/**
 * Tick until the machine reaches `phase`, or fail.
 *
 * The scene reaches `waiting`, `biting`, and `caught` on its own clock, and a test
 * needs to get there without hard-coding frame counts that a future tweak would
 * invalidate. The bound is generous: `MAX_PROXIMITY_WAIT_MS` is 20 s, and nothing here
 * needs more than that plus a bite window.
 */
function tickUntil(
  state: FishingMachineState,
  phase: FishingStateName,
  stepMs = 16,
  limit = 2_000,
  rng?: () => number,
): FishingMachineState {
  let current = state;
  let nowMs = current.lastNowMs;
  for (let index = 0; index < limit && current.phase !== phase; index += 1) {
    nowMs += stepMs;
    current = step(current, { type: 'tick', nowMs }, rng).state;
  }
  if (current.phase !== phase) {
    throw new Error(`never reached "${phase}"; stuck in "${current.phase}"`);
  }
  return current;
}

/** Charge, release, and run to `caught`. The whole cast-to-catch loop. */
function playOneCatch(state: FishingMachineState, rng?: () => number): FishingMachineState {
  const casting = castTo(state, 0.5, rng);
  const waiting = tickUntil(casting, 'waiting', 16, 2_000, rng);
  const biting = tickUntil(waiting, 'biting', 16, 2_000, rng);
  const reeling = step(biting, { type: 'hook', nowMs: biting.lastNowMs }, rng).state;
  return tickUntil(reeling, 'caught', 16, 2_000, rng);
}

// ── The state union ──────────────────────────────────────────────────────────

describe('fishingStateMachine - the state union', () => {
  it('is exactly the eight phases the scene declares and the phase scope names', () => {
    expect(FISHING_STATE_NAMES).toEqual([
      'idle',
      'powering',
      'casting',
      'waiting',
      'biting',
      'reeling',
      'caught',
      'missed',
    ]);
  });

  it('starts idle, with the player centred and nothing in the water', () => {
    const state = session();
    expect(state.phase).toBe('idle');
    expect(state.playerX).toBe(fishingPlayerStartX(VIEWPORT));
    expect(state.bobber.visible).toBe(false);
    expect(state.fish.visible).toBe(false);
    expect(state.candidate).toBeNull();
    expect(state.power).toBe(0);
  });

  it('starts with no casts started, so the first release is cast 1', () => {
    expect(session().castNumber).toBe(0);
  });
});

// ── Layout ───────────────────────────────────────────────────────────────────

describe('fishingStateMachine - layout is derived from the viewport', () => {
  it('places the horizon, shore, and player where the scene places them', () => {
    expect(fishingHorizonY(VIEWPORT)).toBe(72); // floor(720 * 0.10)
    expect(fishingShoreY(VIEWPORT)).toBe(576); // floor(720 * 0.80)
    expect(fishingPlayerY(VIEWPORT)).toBe(626); // floor(720 * 0.87)
    expect(fishingPlayerStartX(VIEWPORT)).toBe(640);
  });

  it('puts the rod tip 12 right and 70 above the player, as the scene does', () => {
    const tip = fishingRodTip(500, VIEWPORT);
    expect(tip).toEqual({ x: 512, y: 556 });
  });

  it('recomputes the lines on resize and keeps the learner where they stood', () => {
    const moved = fold(session(), [
      { type: 'move', nowMs: T0, intent: -1 },
      { type: 'tick', nowMs: T0 + 1_000 },
    ]);
    expect(moved.playerX).toBeLessThan(fishingPlayerStartX(VIEWPORT));

    const resized = step(moved, {
      type: 'resize',
      nowMs: moved.lastNowMs,
      viewport: { width: 800, height: 480 },
    }).state;

    expect(resized.viewport).toEqual({ width: 800, height: 480 });
    // The player's x survives; only the lines move. `relayout` did the same.
    expect(resized.playerX).toBe(moved.playerX);
  });
});

// ── Legal transitions ────────────────────────────────────────────────────────

describe('fishingStateMachine - every legal transition', () => {
  it('idle -> powering -> casting, and the release plays the cast hook', () => {
    const begun = step(session(), { type: 'begin-power', nowMs: T0 });
    expect(begun.accepted).toBe(true);
    expect(begun.state.phase).toBe('powering');
    expect(begun.effects).toEqual([]);

    const released = step(begun.state, { type: 'release', nowMs: T0 + 750 });
    expect(released.state.phase).toBe('casting');
    expect(released.effects).toEqual([{ type: 'audio', hook: 'cast' }]);
  });

  it('shows the bobber at the rod tip while charging, as startPowering did', () => {
    const begun = step(session(), { type: 'begin-power', nowMs: T0 }).state;
    expect(begun.bobber).toEqual({ ...fishingRodTip(begun.playerX, VIEWPORT), visible: true });
  });

  it('casting -> waiting, and the landing plays the splash hook', () => {
    const casting = castTo(session(), 0.5);
    const waiting = tickUntil(casting, 'waiting');
    expect(waiting.phase).toBe('waiting');
    expect(waiting.candidate).not.toBeNull();
    expect(waiting.fishDirection === 'right' || waiting.fishDirection === 'bottom').toBe(true);
    expect(waiting.proximityDeadlineMs).not.toBeNull();
  });

  it('waiting -> biting on proximity, and the bite plays the bite hook', () => {
    const waiting = tickUntil(castTo(session(), 0.5), 'waiting');
    const biting = tickUntil(waiting, 'biting');
    expect(biting.phase).toBe('biting');
    expect(biting.biteWindowDeadlineMs).not.toBeNull();
    expect(biting.proximityDeadlineMs).toBeNull();
  });

  it('biting -> reeling, and the hook plays the reel-in hook', () => {
    const biting = tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting');
    const hooked = step(biting, { type: 'hook', nowMs: biting.lastNowMs });
    expect(hooked.state.phase).toBe('reeling');
    expect(hooked.effects).toEqual([{ type: 'audio', hook: 'reel-in' }]);
    expect(hooked.state.biteWindowDeadlineMs).toBeNull();
  });

  it('reeling -> caught, and the catch plays the catch hook and reveals the fish', () => {
    const casting = castTo(session(), 0.5);
    const waiting = tickUntil(casting, 'waiting');
    const biting = tickUntil(waiting, 'biting');
    const reeling = step(biting, { type: 'hook', nowMs: biting.lastNowMs }).state;

    // The reel takes its full duration: the scene's `REEL_DURATION_MS`.
    const stillReeling = step(reeling, {
      type: 'tick',
      nowMs: reeling.lastNowMs + FISHING_REEL_DURATION_MS - 1,
    });
    expect(stillReeling.state.phase).toBe('reeling');

    const caught = step(reeling, {
      type: 'tick',
      nowMs: reeling.lastNowMs + FISHING_REEL_DURATION_MS,
    });
    expect(caught.state.phase).toBe('caught');
    expect(caught.effects[0]).toEqual({ type: 'audio', hook: 'catch' });
    expect(caught.effects[1]).toMatchObject({
      type: 'catch-revealed',
      catalogId: caught.state.candidate?.id,
      castNumber: 1,
    });
  });

  it('caught -> idle and missed -> idle, both clearing the water', () => {
    const caught = playOneCatch(session());
    expect(canResetFishing(caught)).toBe(true);

    const reset = step(caught, { type: 'reset', nowMs: caught.lastNowMs });
    expect(reset.state.phase).toBe('idle');
    expect(reset.state.bobber.visible).toBe(false);
    expect(reset.state.fish.visible).toBe(false);
    expect(reset.state.candidate).toBeNull();
    expect(reset.state.power).toBe(0);
    expect(reset.state.biteWindowDeadlineMs).toBeNull();
    expect(reset.state.proximityDeadlineMs).toBeNull();
    expect(reset.state.reelDeadlineMs).toBeNull();
    expect(reset.effects).toEqual([]);
  });

  it('does not rewind the cast counter on reset', () => {
    const caught = playOneCatch(session());
    expect(caught.castNumber).toBe(1);

    const reset = step(caught, { type: 'reset', nowMs: caught.lastNowMs }).state;
    expect(reset.castNumber).toBe(1);

    // The second cast is cast 2, which is what tells the two catches apart.
    const second = castTo(reset, 0.5);
    expect(second.castNumber).toBe(2);
  });

  it('advances the cast counter exactly once per accepted release', () => {
    // A refused release must not advance it, or a double press would skip a cast
    // number and the catch identity would silently skip a value.
    const powering = step(session(), { type: 'begin-power', nowMs: T0 }).state;
    expect(step(powering, { type: 'release', nowMs: T0 }).state.castNumber).toBe(1);
    // Already casting: refused, and still 1.
    expect(step(castTo(session(), 0.5), { type: 'release', nowMs: T0 }).state.castNumber).toBe(1);
  });
});

// ── Illegal transitions ──────────────────────────────────────────────────────

describe('fishingStateMachine - every illegal transition is refused', () => {
  const idle = session();

  it('refuses release in idle, and leaves the state byte-identical', () => {
    const result = step(idle, { type: 'release', nowMs: T0 });
    expect(result.accepted).toBe(false);
    expect(result.refusal).toBe('illegal-transition');
    expect(result.effects).toEqual([]);
    expect(result.state).toBe(idle);
  });

  it('refuses begin-power in every phase but idle', () => {
    const powering = step(idle, { type: 'begin-power', nowMs: T0 }).state;
    for (const busy of [
      powering,
      castTo(idle, 0.5),
      tickUntil(castTo(idle, 0.5), 'waiting'),
      tickUntil(tickUntil(castTo(idle, 0.5), 'waiting'), 'biting'),
      playOneCatch(idle),
    ]) {
      expect(step(busy, { type: 'begin-power', nowMs: T0 }).refusal).toBe('illegal-transition');
    }
  });

  it('refuses hook outside biting', () => {
    expect(step(idle, { type: 'hook', nowMs: T0 }).refusal).toBe('illegal-transition');
    const powering = step(idle, { type: 'begin-power', nowMs: T0 }).state;
    expect(step(powering, { type: 'hook', nowMs: T0 }).refusal).toBe('illegal-transition');
  });

  it('refuses reset outside caught and missed, and offers it only in those two', () => {
    const midCast = [
      idle,
      step(idle, { type: 'begin-power', nowMs: T0 }).state,
      castTo(idle, 0.5),
      tickUntil(castTo(idle, 0.5), 'waiting'),
      tickUntil(tickUntil(castTo(idle, 0.5), 'waiting'), 'biting'),
    ];
    for (const state of midCast) {
      expect(canResetFishing(state)).toBe(false);
      expect(step(state, { type: 'reset', nowMs: T0 }).refusal).toBe('illegal-transition');
    }
    expect(canResetFishing(playOneCatch(idle))).toBe(true);
  });

  it('refuses movement while casting, waiting, biting, or reeling', () => {
    const locked = [
      step(idle, { type: 'begin-power', nowMs: T0 }).state,
      castTo(idle, 0.5),
      tickUntil(castTo(idle, 0.5), 'waiting'),
      tickUntil(tickUntil(castTo(idle, 0.5), 'waiting'), 'biting'),
    ];
    for (const state of locked) {
      const result = step(state, { type: 'move', nowMs: T0, intent: 1 });
      expect(result.refusal).toBe('illegal-transition');
      expect(result.state).toBe(state);
    }
  });

  it('accepts movement in idle, caught, and missed, matching the scene', () => {
    for (const walkable of [session(), playOneCatch(session())]) {
      expect(step(walkable, { type: 'move', nowMs: T0, intent: 1 }).accepted).toBe(true);
      expect(step(walkable, { type: 'move', nowMs: T0, intent: -1 }).accepted).toBe(true);
      expect(step(walkable, { type: 'move', nowMs: T0, intent: 0 }).accepted).toBe(true);
    }
  });

  it('never throws, for any event in any phase', () => {
    const phases: FishingMachineState[] = [
      session(),
      step(session(), { type: 'begin-power', nowMs: T0 }).state,
      castTo(session(), 0.5),
      tickUntil(castTo(session(), 0.5), 'waiting'),
      tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting'),
      playOneCatch(session()),
    ];
    const events: FishingMachineEvent[] = [
      { type: 'begin-power', nowMs: T0 },
      { type: 'release', nowMs: T0 },
      { type: 'hook', nowMs: T0 },
      { type: 'reset', nowMs: T0 },
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 },
      { type: 'resize', nowMs: T0, viewport: { width: 10, height: 10 } },
    ];
    for (const state of phases) {
      for (const event of events) {
        expect(() => step(state, event)).not.toThrow();
      }
    }
  });

  it('is total for a hostile clock: a backwards timestamp does not integrate', () => {
    const moved = fold(session(), [
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 500 },
    ]);
    expect(moved.playerX).toBe(fishingPlayerStartX(VIEWPORT) + FISHING_PLAYER_MOVE_SPEED * 0.5);

    // Ticking with a *smaller* timestamp must not walk backwards.
    const back = step(moved, { type: 'tick', nowMs: moved.lastNowMs - 1_000 }).state;
    expect(back.playerX).toBe(moved.playerX);
  });

  it('is total for a hostile viewport: zero and negative sizes do not throw', () => {
    for (const viewport of [
      { width: 0, height: 0 },
      { width: -100, height: -100 },
      { width: Number.NaN, height: Number.NaN },
    ]) {
      const state = step(session(), { type: 'resize', nowMs: T0, viewport }).state;
      expect(state.viewport.width).toBe(0);
      expect(state.viewport.height).toBe(0);
    }
  });
});

// ── The bite window and the hook outcome ─────────────────────────────────────

describe('fishingStateMachine - the bite window is explicit', () => {
  it('opens the window for BITE_WINDOW_SEC and expires into missed', () => {
    const biting = tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting');
    const windowMs = biting.biteWindowDeadlineMs! - biting.lastNowMs;

    // Two seconds, from `BITE_WINDOW_SEC`. One frame short of it, still biting.
    const justInside = step(biting, { type: 'tick', nowMs: biting.biteWindowDeadlineMs! - 1 });
    expect(justInside.state.phase).toBe('biting');

    // At the deadline, the fish is gone.
    const expired = step(biting, { type: 'tick', nowMs: biting.biteWindowDeadlineMs! });
    expect(expired.state.phase).toBe('missed');
    expect(expired.effects).toEqual([{ type: 'audio', hook: 'miss' }]);
    expect(windowMs).toBe(2_000);
  });

  it('refuses a hook after the window closed, naming the reason', () => {
    const biting = tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting');
    const expired = step(biting, { type: 'tick', nowMs: biting.biteWindowDeadlineMs! }).state;
    // `missed` is not `biting`, so the phase gate answers first - which is right: the
    // learner pressing after the fish is gone is a phase error, not a window error.
    expect(step(expired, { type: 'hook', nowMs: expired.lastNowMs }).refusal).toBe(
      'illegal-transition',
    );
  });

  it('produces missed from the proximity timeout too, when the fish never arrives', () => {
    // A viewport far wider than the fish can cross in 20 s at 80 px/s, plus a scripted
    // stream that picks the `right` entry (which starts at `width + 40`) instead of
    // `bottom` (which starts just below the shore and would arrive). Deterministic and
    // total: no timeout, no sleep, no dependence on which way a day's seed happens to
    // roll.
    const rng = scriptedRng([0.5, 0.1, 0.1, 0.2]);
    const wide = createFishingState({
      viewport: { width: 100_000, height: 720 },
      nowMs: T0,
      eligible: true,
    });
    const waiting = tickUntil(castTo(wide, FISHING_MIN_CAST_POWER, rng), 'waiting', 16, 2_000, rng);
    expect(waiting.fishDirection).toBe('right');
    // The approach is far longer than the search allows.
    expect(waiting.approach!.length).toBeGreaterThan(
      FISHING_FISH_SWIM_SPEED * (FISHING_MAX_PROXIMITY_WAIT_MS / 1000),
    );

    let nowMs = waiting.lastNowMs;
    let current = waiting;
    for (let index = 0; index < 2_000 && current.phase === 'waiting'; index += 1) {
      nowMs += 100;
      current = step(current, { type: 'tick', nowMs }, rng).state;
    }

    expect(current.phase).toBe('missed');
  });

  it('lets the fish arrive from the bottom entry too, and bites from it', () => {
    // The other direction: a fourth draw at or above 0.5 selects `bottom`, which starts
    // below the shore and uses the fourth gameplay draw for its x offset.
    const rng = scriptedRng([0.5, 0.1, 0.1, 0.9]);
    const casting = castTo(session(), 0.5, rng);
    const waiting = tickUntil(casting, 'waiting', 16, 2_000, rng);
    expect(waiting.fishDirection).toBe('bottom');
    // Started below the viewport, as `startFishSwim`'s bottom branch does.
    expect(waiting.fish.y).toBe(VIEWPORT.height + 40);
    expect(tickUntil(waiting, 'biting', 16, 2_000, rng).phase).toBe('biting');
  });

  it('gives the proximity timeout exactly MAX_PROXIMITY_WAIT_MS from the landing', () => {
    const waiting = tickUntil(castTo(session(), 0.5), 'waiting');
    expect(waiting.proximityDeadlineMs! - waiting.lastNowMs).toBe(FISHING_MAX_PROXIMITY_WAIT_MS);
  });
});

// ── Proximity detection ──────────────────────────────────────────────────────

describe('fishingStateMachine - proximity-based bite detection', () => {
  it('is the scene\'s test: distance from the fish bite centre to the bobber', () => {
    const waiting = tickUntil(castTo(session(), 0.5), 'waiting');
    // Off the bobber, no bite.
    expect(didFishStrike(waiting)).toBe(false);

    // Walk the fish onto the bobber and the test fires.
    const dx = waiting.bobber.x - waiting.fish.x;
    const dy = waiting.bobber.y - (waiting.fish.y + 16);
    const scale = FISHING_PROXIMITY_THRESHOLD / Math.hypot(dx, dy);
    const atThreshold = step(waiting, { type: 'tick', nowMs: waiting.lastNowMs + 16 }).state;
    expect(atThreshold.phase).toBe('waiting');

    // Exactly at the threshold counts, as `<=` did in the scene.
    const placed = {
      ...atThreshold,
      fish: {
        x: atThreshold.bobber.x,
        y: atThreshold.bobber.y - 16,
        visible: true,
      },
    };
    expect(didFishStrike(placed)).toBe(true);

    // A hair beyond it does not.
    const justBeyond = {
      ...placed,
      fish: { x: placed.bobber.x + FISHING_PROXIMITY_THRESHOLD + 0.01, y: placed.fish.y, visible: true },
    };
    expect(didFishStrike(justBeyond)).toBe(false);
    expect(scale).toBeGreaterThan(0);
  });

  it('never bites when the fish or the bobber is not visible', () => {
    const waiting = tickUntil(castTo(session(), 0.5), 'waiting');
    const centred = { ...waiting, fish: { x: waiting.bobber.x, y: waiting.bobber.y - 16, visible: true } };
    expect(didFishStrike(centred)).toBe(true);
    expect(didFishStrike({ ...centred, fish: { ...centred.fish, visible: false } })).toBe(false);
    expect(didFishStrike({ ...centred, bobber: { ...centred.bobber, visible: false } })).toBe(false);
  });

  it('does not bite outside the waiting phase', () => {
    const biting = tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting');
    expect(didFishStrike(biting)).toBe(false);
  });
});

// ── Seeding and reproducibility ──────────────────────────────────────────────

describe('fishingStateMachine - seeded reproducibility', () => {
  it('reproduces FishingScene.seedRng\'s derivation exactly', () => {
    // Golden values, computed from the scene's own algorithm and frozen. Pinning the
    // literal rather than re-deriving it in the test is what makes this catch a
    // change to the rule instead of agreeing with it.
    expect(deriveFishingSeed('2026-01-01', 'scholar')).toBe(778628068);
    expect(deriveFishingSeed('2026-10-03', 'scholar')).toBe(1895315520);
    expect(deriveFishingSeed('2026-10-03', 'artist')).toBe(-1132717395);
  });

  it('varies by date and by archetype', () => {
    expect(deriveFishingSeed('2026-01-01', 'scholar')).not.toBe(
      deriveFishingSeed('2026-01-02', 'scholar'),
    );
    expect(deriveFishingSeed('2026-01-01', 'scholar')).not.toBe(
      deriveFishingSeed('2026-01-01', 'artist'),
    );
  });

  it('makes a whole session reproducible: same seed, same cast, bite, and catch', () => {
    const play = (): { catalogId: string; castNumber: number; phase: string; direction: string } => {
      const caught = playOneCatch(session());
      return {
        catalogId: caught.candidate!.id,
        castNumber: caught.castNumber,
        phase: caught.phase,
        direction: caught.fishDirection,
      };
    };
    expect(play()).toEqual(play());
  });

  it('reproduces a whole day-and-archetype session, not just a fresh generator', () => {
    const play = (): string => {
      const { state, rng } = seeded('2026-10-03', 'artist');
      const caught = playOneCatch(state, rng);
      return `${caught.candidate!.id}/${caught.fishDirection}/${caught.castNumber}`;
    };
    const first = play();
    expect(first).toBe(play());
    // And a different archetype on the same day rolls a different pond.
    const other = seeded('2026-10-03', 'explorer');
    expect(playOneCatch(other.state, other.rng).candidate!.id).not.toBe(
      playOneCatch(seeded('2026-10-03', 'scholar').state, createFishingSessionRng('2026-10-03', 'scholar'))
        .candidate!.id,
    );
  });

  it('draws in the documented order: spread, then rarity, index, direction', () => {
    // The spread angle is the **first** draw, so a scripted stream whose first value is
    // exactly 0.5 must produce a dead-straight cast - `sin(0) === 0`, so `vx === 0`.
    const straight = scriptedRng([0.5, 0.1, 0.1, 0.9]);
    expect(castTo(session(), 1, straight).bobberVelocity.vx).toBe(0);

    // The second draw is the rarity roll, so a stream of 0 can never pick anything but
    // `common`, and 0.99 picks `epic`. `rollFishRarity` uses `roll <= cumulative`, so
    // a roll of exactly 0 lands in `common`.
    const common = rollFor(scriptedRng([0.5, 0.0, 0.0, 0.9]));
    expect(common.rarity).toBe('common');
    const epic = rollFor(scriptedRng([0.5, 0.999, 0.0, 0.9]));
    expect(epic.rarity).toBe('epic');

    // The third draw is the index within the rarity, so two streams differing only
    // there roll two different species of the same rarity.
    const first = rollFor(scriptedRng([0.5, 0.0, 0.0, 0.9]));
    const second = rollFor(scriptedRng([0.5, 0.0, 0.9, 0.9]));
    expect(second.rarity).toBe(first.rarity);
    expect(second.catalogId).not.toBe(first.catalogId);

    // The fourth draw is the direction, and a cast to completion resolves on the same
    // stream, so the whole catch is a function of the four draws.
    expect(rollFor(scriptedRng([0.5, 0.0, 0.0, 0.2])).direction).toBe('right');
    expect(rollFor(scriptedRng([0.5, 0.0, 0.0, 0.9])).direction).toBe('bottom');
  });

  it('makes a second cast in the same session use the next draws, not the first four', () => {
    const rng = createFishingSessionRng('2026-10-03', 'scholar');
    const first = playOneCatch(session(), rng);
    const reset = step(first, { type: 'reset', nowMs: first.lastNowMs }, rng).state;
    const second = playOneCatch(reset, rng);

    // The species are *not* required to differ - two casts can roll the same fish, and
    // that is correct. What must differ is the cast's own identity, which is the
    // `castNumber` half of the catch identity and is what stops the second catch being
    // mistaken for a replay of the first.
    expect(second.castNumber).toBe(2);
    expect(first.castNumber).toBe(1);
    expect(reset.castNumber).toBe(1);
  });

  it('rolls the second cast from further along the stream', () => {
    // Proved with a scripted stream whose values are distinguishable per draw, so the
    // assertion is about *which* draws were used rather than about luck.
    const draws = [0.5, 0.0, 0.0, 0.2, 0.5, 0.999, 0.0, 0.2];
    let index = 0;
    const counting = (): number => {
      const value = draws[index];
      index += 1;
      return value;
    };

    // The same stream has to be threaded through **every** reduction, including the
    // flight and approach ticks, or the landing would draw from a different generator
    // than the cast. The first catch is played to completion because `reset` is only
    // legal from `caught` or `missed`.
    const first = playOneCatch(session(), counting);
    expect(first.candidate!.rarity).toBe('common'); // draw 2 was 0.0
    expect(first.fishDirection).toBe('right'); // draw 4 was 0.2

    const second = playOneCatch(
      step(first, { type: 'reset', nowMs: first.lastNowMs }, counting).state,
      counting,
    );
    expect(second.candidate!.rarity).toBe('epic'); // draw 6 was 0.999
    expect(second.castNumber).toBe(2);
  });

  it('yields a different session for a different seed', () => {
    const rollFor = (date: string, klass: string): string => {
      const rng = createFishingSessionRng(date, klass);
      const rng2 = createFishingSessionRng(date, klass);
      return rng() === rng2() ? 'same' : 'different';
    };
    expect(rollFor('2026-10-03', 'scholar')).toBe('same');
    expect(createFishingSessionRng('2026-10-03', 'scholar')()).not.toBe(
      createFishingSessionRng('2026-10-04', 'scholar')(),
    );
  });
});

// ── Audio hooks ──────────────────────────────────────────────────────────────

describe('fishingStateMachine - audio hooks', () => {
  it('emits cast, splash, bite, reel-in, catch in order, once each', () => {
    const hooks: string[] = [];
    let state = session();
    const rng = createFishingSessionRng('2026-10-03', 'scholar');
    const record = (event: FishingMachineEvent): void => {
      const result = reduceFishing(state, event, rng);
      for (const effect of result.effects) {
        if (effect.type === 'audio') hooks.push(effect.hook);
      }
      state = result.state;
    };

    record({ type: 'begin-power', nowMs: T0 });
    record({ type: 'release', nowMs: T0 + 750 });

    // One frame at a time until the catch, so nothing is skipped.
    for (let index = 0; index < 4_000 && state.phase !== 'caught'; index += 1) {
      const at = state.lastNowMs + 16;
      if (state.phase === 'biting' && state.biteWindowDeadlineMs !== null && at >= state.biteWindowDeadlineMs) {
        continue; // let the window expire rather than hooking
      }
      record({ type: 'tick', nowMs: at });
      if (state.phase === 'biting') record({ type: 'hook', nowMs: state.lastNowMs });
    }

    expect(hooks).toEqual(['cast', 'splash', 'bite', 'reel-in', 'catch']);
  });

  it('emits exactly one miss hook, and only for the expired window', () => {
    const biting = tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting');
    const first = step(biting, { type: 'tick', nowMs: biting.biteWindowDeadlineMs! });
    expect(first.effects).toEqual([{ type: 'audio', hook: 'miss' }]);

    // Further ticks in `missed` emit nothing at all.
    for (let index = 1; index <= 10; index += 1) {
      expect(
        step(first.state, { type: 'tick', nowMs: first.state.lastNowMs + index * 100 }).effects,
      ).toEqual([]);
    }
  });

  it('emits nothing for a refused event', () => {
    for (const event of [
      { type: 'release', nowMs: T0 },
      { type: 'hook', nowMs: T0 },
      { type: 'reset', nowMs: T0 },
    ] as const) {
      expect(step(session(), event).effects).toEqual([]);
    }
  });

  it('emits no hook for a reset, and no hook for movement', () => {
    const caught = playOneCatch(session());
    expect(step(caught, { type: 'reset', nowMs: caught.lastNowMs }).effects).toEqual([]);
    expect(step(session(), { type: 'move', nowMs: T0, intent: 1 }).effects).toEqual([]);
  });
});

// ── Movement bounds ──────────────────────────────────────────────────────────

describe('fishingStateMachine - movement bounds are the scene\'s', () => {
  it('walks at PLAYER_MOVE_SPEED, integrating the injected elapsed time', () => {
    const moving = fold(session(), [
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 1_000 },
    ]);
    expect(moving.playerX).toBe(fishingPlayerStartX(VIEWPORT) + FISHING_PLAYER_MOVE_SPEED);
  });

  it('integrates the elapsed time, so a slow tick rate gives the same position', () => {
    const slow = fold(session(), [
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 2_000 },
    ]);
    const fast = fold(session(), [
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 500 },
      { type: 'tick', nowMs: T0 + 1_000 },
      { type: 'tick', nowMs: T0 + 1_500 },
      { type: 'tick', nowMs: T0 + 2_000 },
    ]);
    expect(slow.playerX).toBe(fast.playerX);
  });

  it('clamps to the edge margins and stops there', () => {
    const right = fold(session(), [
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 10_000 },
    ]);
    expect(right.playerX).toBe(VIEWPORT.width - FISHING_PLAYER_EDGE_MARGIN);

    const left = fold(session(), [
      { type: 'move', nowMs: T0, intent: -1 },
      { type: 'tick', nowMs: T0 + 10_000 },
    ]);
    expect(left.playerX).toBe(FISHING_PLAYER_EDGE_MARGIN);
  });

  it('resolves to the lower bound when the viewport is narrower than both margins', () => {
    // `Phaser.Math.Clamp` resolves inverted bounds to `min`; reproduced exactly.
    const narrow = createFishingState({
      viewport: { width: 40, height: 720 },
      nowMs: T0,
      eligible: true,
    });
    const walked = fold(narrow, [
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 1_000 },
    ]);
    expect(walked.playerX).toBe(FISHING_PLAYER_EDGE_MARGIN);
  });

  it('keeps the facing sticky when the walk stops', () => {
    const left = fold(session(), [
      { type: 'move', nowMs: T0, intent: -1 },
      { type: 'tick', nowMs: T0 + 100 },
    ]);
    expect(left.facing).toBe('left');

    const stopped = step(left, { type: 'move', nowMs: left.lastNowMs, intent: 0 }).state;
    expect(stopped.facing).toBe('left');

    const right = step(stopped, { type: 'move', nowMs: stopped.lastNowMs, intent: 1 }).state;
    expect(right.facing).toBe('right');
  });
});

// ── Power casting ────────────────────────────────────────────────────────────

describe('fishingStateMachine - power casting bounds are the scene\'s', () => {
  it('fills from zero over POWER_BUILD_TIME_MS and saturates at 1', () => {
    const begun = step(session(), { type: 'begin-power', nowMs: T0 }).state;
    const half = step(begun, { type: 'tick', nowMs: T0 + FISHING_POWER_BUILD_TIME_MS / 2 }).state;
    expect(half.power).toBeCloseTo(0.5, 10);

    const full = step(begun, { type: 'tick', nowMs: T0 + FISHING_POWER_BUILD_TIME_MS }).state;
    expect(full.power).toBe(1);

    const held = step(full, { type: 'tick', nowMs: T0 + FISHING_POWER_BUILD_TIME_MS * 4 }).state;
    expect(held.power).toBe(1);
  });

  it('floors the cast at the scene\'s minimum power', () => {
    // Released on the very first tick, power is ~0. The scene floored it at 0.12.
    const begun = step(session(), { type: 'begin-power', nowMs: T0 }).state;
    const released = step(begun, { type: 'release', nowMs: T0 + 1 });
    expect(released.state.power).toBe(FISHING_MIN_CAST_POWER);
  });

  it('keeps the launch velocity upward for every spread', () => {
    // `cos(spread)` is positive for every spread in +/- 0.15 rad, so `vy` is always
    // negative: the bobber always flies toward the lake, never away.
    for (const power of [FISHING_MIN_CAST_POWER, 0.5, 1]) {
      const casting = castTo(session(), power);
      expect(casting.bobberVelocity.vy).toBeLessThan(0);
      expect(Math.abs(casting.bobberVelocity.vy)).toBeLessThanOrEqual(
        power * FISHING_CAST_SPEED + 1e-9,
      );
    }
  });

  it('aims further for more power, and stops above the horizon margin', () => {
    const straight = (): (() => number) => scriptedRng([0.5]);
    const weak = castTo(session(), FISHING_MIN_CAST_POWER, straight());
    const strong = castTo(session(), 1, straight());
    const shore = fishingShoreY(VIEWPORT);
    const horizon = fishingHorizonY(VIEWPORT);

    // More power means a *smaller* y: further up the screen.
    expect(strong.castTargetY).toBeLessThan(weak.castTargetY);
    expect(weak.castTargetY).toBe(
      shore - FISHING_MIN_CAST_POWER * (shore - horizon - FISHING_HORIZON_MARGIN * 2),
    );
    // Full power lands exactly one margin below the horizon.
    expect(strong.castTargetY).toBe(shore - (shore - horizon - FISHING_HORIZON_MARGIN * 2));
    expect(strong.castTargetY).toBeGreaterThan(horizon);
  });

  it('clamps the bobber to the water area and zeroes its horizontal drift', () => {
    // The scene applies two *independent* clamps, so a viewport narrower than
    // `2 * margin` resolves to the right-hand one, not to the left margin. Preserved
    // exactly, because it is what the scene does at any small width.
    const tooNarrow = createFishingState({
      viewport: { width: 20, height: 720 },
      nowMs: T0,
      eligible: true,
    });
    const narrowFlight = tickUntil(castTo(tooNarrow, 1), 'waiting');
    expect(narrowFlight.bobber.x).toBe(tooNarrow.viewport.width - FISHING_BOBBER_EDGE_MARGIN);

    // A viewport wide enough for the two clamps not to overlap clamps at the margin and
    // stops the bobber drifting along the shore.
    const wide = createFishingState({
      viewport: { width: 1280, height: 720 },
      nowMs: T0,
      eligible: true,
    });
    // A leftward spread, so the bobber tries to leave through the left edge.
    const leftward = scriptedRng([0.0, 0.1, 0.1, 0.9]);
    const casting = castTo(wide, 1, leftward);
    expect(casting.bobberVelocity.vx).toBeLessThan(0);

    let current = casting;
    let nowMs = casting.lastNowMs;
    for (let index = 0; index < 4_000 && current.phase === 'casting'; index += 1) {
      nowMs += 16;
      current = step(current, { type: 'tick', nowMs }, leftward).state;
    }
    expect(current.bobber.x).toBeGreaterThanOrEqual(FISHING_BOBBER_EDGE_MARGIN);
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('fishingStateMachine - eligibility is an input, not a lookup', () => {
  it('needs at least one cleared room', () => {
    expect(isFishingEligible(0)).toBe(false);
    expect(isFishingEligible(1)).toBe(true);
    expect(isFishingEligible(12)).toBe(true);
  });

  it('is total for a hostile count', () => {
    expect(isFishingEligible(-5)).toBe(false);
    expect(isFishingEligible(Number.NaN)).toBe(false);
    expect(isFishingEligible(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('refuses begin-power when the subject is not eligible', () => {
    const blocked = session({ eligible: false });
    const result = step(blocked, { type: 'begin-power', nowMs: T0 });
    expect(result.accepted).toBe(false);
    expect(result.refusal).toBe('fishing-not-eligible');
    expect(result.state).toBe(blocked);
  });

  it('tests eligibility only on begin-power, and prefers the phase answer', () => {
    // A control in the wrong phase gets the phase answer, which is the one it can act
    // on; the eligibility answer would be true but unhelpful.
    const blocked = session({ eligible: false });
    const midCharge = castTo(blocked, 0.5, scriptedRng([0.5]));
    // Mid-charge, the learner is *in* the sequence, so the gate no longer applies -
    // eligibility is tested on `begin-power`, the one event that starts it.
    expect(step(midCharge, { type: 'release', nowMs: T0 }).refusal).toBe('illegal-transition');

    // Every other event is unaffected by eligibility, which is deliberate: a learner who
    // is already casting must not be frozen by a flag that changed mid-session.
    expect(step(midCharge, { type: 'tick', nowMs: T0 }).accepted).toBe(true);
    expect(step(blocked, { type: 'move', nowMs: T0, intent: 1 }).accepted).toBe(true);
  });
});

// ── Hints ────────────────────────────────────────────────────────────────────

describe('fishingStateMachine - the phase hint', () => {
  it('carries the rollback lane\'s own strings, and an eligibility line', () => {
    expect(fishingPhaseHint(session())).toBe(
      'Hold click on the lake to build power, release to cast',
    );
    expect(fishingPhaseHint(session({ eligible: false }))).toBe(
      'Return to the village and clear some dungeon rooms first',
    );

    const powering = step(session(), { type: 'begin-power', nowMs: T0 }).state;
    expect(fishingPhaseHint(powering)).toBe('Hold...');
    expect(fishingPhaseHint(castTo(session(), 0.5))).toBe('Casting...');
    expect(fishingPhaseHint(playOneCatch(session()))).toBe('Fish caught! Click to cast again');
  });

  it('reports the bite and the miss', () => {
    const biting = tickUntil(tickUntil(castTo(session(), 0.5), 'waiting'), 'biting');
    expect(fishingPhaseHint(biting)).toBe('BITE! Click to reel in!');
    const missed = step(biting, { type: 'tick', nowMs: biting.biteWindowDeadlineMs! }).state;
    expect(fishingPhaseHint(missed)).toBe('The fish got away... Click to cast again');
  });
});

// ── Purity ───────────────────────────────────────────────────────────────────

describe('fishingStateMachine - purity', () => {
  it('never mutates the state it is given', () => {
    const original = playOneCatch(session());
    const snapshot = JSON.stringify(original);
    const rng = createFishingSessionRng('2026-10-03', 'scholar');
    for (const event of [
      { type: 'begin-power', nowMs: T0 },
      { type: 'release', nowMs: T0 },
      { type: 'hook', nowMs: T0 },
      { type: 'reset', nowMs: T0 },
      { type: 'move', nowMs: T0, intent: 1 },
      { type: 'tick', nowMs: T0 + 1_000 },
      { type: 'resize', nowMs: T0, viewport: VIEWPORT },
    ] as const) {
      reduceFishing(original, event, rng);
    }
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('reads no real clock: two reductions at the same nowMs give the same state', () => {
    const at = T0 + 123_456;
    const first = step(castTo(session(), 0.4), { type: 'tick', nowMs: at }).state;
    const second = step(castTo(session(), 0.4), { type: 'tick', nowMs: at }).state;
    expect(first).toEqual(second);
  });

  it('holds no generator in its state, so a state is a plain value', () => {
    // `JSON.stringify` on the whole state is the assertion: a function-valued field
    // would silently vanish and the state would still round-trip.
    const caught = playOneCatch(session());
    expect(JSON.parse(JSON.stringify(caught))).toEqual(caught);
  });
});