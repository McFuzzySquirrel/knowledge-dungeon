/**
 * The fishing HUD's view of the pond: a renderer-neutral capability port.
 *
 * ## Why this module re-declares a port that already exists
 *
 * `src/renderers/pixi/fishing/FishingController.ts` declares the real one, and this file
 * must **not** import it - or anything else under `src/renderers/**`, or `src/game/**`, or
 * `pixi.js`. Three enforced gates make that non-negotiable rather than merely tidy:
 *
 * - `tests/phase14/study-shell-boundary.test.ts` refuses *any* first-party reach from
 *   `src/ui/study/**` into `src/renderers/**`, the engine packages included, and it walks
 *   the import graph rather than scanning text - so a `import type` is an edge too.
 * - `tests/phase17/fishing-renderer-boundary.test.ts` refuses the *reverse* direction:
 *   nothing in the renderer tree may reach `src/ui/study/**`, because a renderer reaching
 *   into a DOM surface makes the engine depend on a screen.
 * - `tests/phase12/village-shell-split.test.ts` refuses a `@/renderers` reach from
 *   `src/ui/village/**`, which is where the lake the HUD's sibling panels are opened from
 *   lives.
 *
 * So the DOM side declares what it needs, explicitly and with **nothing optional**, and
 * `tests/phase17/fishing-hud-port.test.ts` proves the two declarations are the same type
 * in both directions. A duplicate declaration without that test would be a liability; with
 * it, a learner action added to the renderer port and not to this one is a type error in a
 * test rather than a control that silently does nothing.
 *
 * ## Why "explicit and nothing optional" and not a structural base
 *
 * The header of `FishingController.ts` records the defect this shape exists to prevent:
 * typed against the broad structural `FishingRendererCapabilities`, `VillageWorld.tsx`'s
 * handle literal compiled while omitting two members, and a nearby-action panel
 * feature-detected `undefined` and rendered its rows permanently disabled - no type error,
 * nothing in the build. A port with an optional member has that failure built into it,
 * because `port.hook?.()` is legal at every call site. Every learner-triggerable
 * transition the state machine accepts is therefore a required method here.
 *
 * ## The six learner actions, and the control each one has
 *
 * The state machine's own header tabulates them; this file restates the *DOM* half only,
 * because that is what this module constrains.
 *
 * | # | Method | Legal from | Control | Key |
 * |---|--------|-----------|---------|-----|
 * | 1 | `beginPower` | `idle` | the charge control, pressed | `Space` / `Enter` down |
 * | 2 | `move` | `idle`, `caught`, `missed` | walk left / right, held | `A` `←` / `D` `→` held |
 * | 3 | `release` | `powering` | the charge control, released | `Space` / `Enter` up |
 * | 4 | `hook` | `biting` | set the hook | `Space` / `Enter` down |
 * | 5 | `reset` | `caught` | cast again | `Space` / `Enter` down |
 * | 6 | `reset` | `missed` | try again | `Space` / `Enter` down |
 *
 * `tick` and `resize` are deliberately absent: the clock and the layout are not learner
 * actions and plan 10.1 asks for a DOM equivalent for *world interactions*, not for the
 * renderer's own frame.
 *
 * ## Totality, and why it matters more than it looks
 *
 * Every member is total. `beginPower` before the world has mounted, `readReadout` after it
 * has been torn down, and `onPhase` before a scene exists all return without throwing,
 * because the HUD is mounted by the *same component* that mounts the world and the world's
 * handle is a `useImperativeHandle` that outlives the renderer by one frame. A port that
 * could answer "not yet" would push a null check into every control and make the shape of
 * the null check the thing a test has to cover.
 *
 * ## No learner data
 *
 * Nothing here reads a store, names a subject, or logs. The one identifier that crosses is
 * the canonical `catalogId`, which is catalogue content; the display name is resolved from
 * `FISH_CATALOG` on the DOM side and is never a key.
 */

/** Which of the eight cast phases the session is in. Mirrors the machine's union. */
export type FishingHudPhase =
  | 'idle'
  | 'powering'
  | 'casting'
  | 'waiting'
  | 'biting'
  | 'reeling'
  | 'caught'
  | 'missed';

/** The learner's walking intent. `-1`, `0`, `1`, exactly as the machine's `move` event. */
export type FishingHudMoveIntent = -1 | 0 | 1;

/**
 * Everything the HUD mirrors about the pond, as one frozen value.
 *
 * Facts only. The instructional copy is a separate table in `fishingHudCopy.ts`, because a
 * readout that carries sentences cannot be compared field-by-field with the renderer's own
 * and a drift between the two would only show up as a wrong noun in a sentence.
 */
export interface FishingHudReadout {
  /** Which of the eight cast phases the session is in. */
  readonly phase: FishingHudPhase;
  /** Cast charge, `0`..`1`. Also the power meter's width and its announced percentage. */
  readonly power: number;
  /** Whether `reset` would be accepted, so a control can disable itself. */
  readonly canReset: boolean;
  /** Whether this subject may be fished at all. */
  readonly eligible: boolean;
  /** The held walking intent. */
  readonly moveIntent: FishingHudMoveIntent;
  /** Which way the angler faces. Sticky: no intent keeps the last facing. */
  readonly facing: 'left' | 'right';
  /** Casts started this session, one-based for the cast in flight. Never rewound. */
  readonly castNumber: number;
  /** Fish kept in this session's bucket. */
  readonly caughtCount: number;
}

/**
 * The readout a caller gets before the pond exists, and after it is gone.
 *
 * `eligible: false` and `power: 0` are the two values that matter: an eligible pond is never
 * claimed before the machine has read the subject's cleared rooms, so a HUD that renders
 * before the world does states the truth rather than a hopeful default.
 */
export const FISHING_HUD_IDLE_READOUT: FishingHudReadout = Object.freeze({
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
 * The pond, as a DOM control reaches it.
 *
 * Six learner actions, two reads, and one subscription. Nothing optional anywhere on this
 * interface, for the reason the module header gives.
 */
export interface FishingHudPort {
  /** Learner action 1. Legal in `idle` only. */
  beginPower(): void;
  /** Learner action 3. The release of the hold `beginPower` began. */
  release(): void;
  /** Learner action 4. Legal in `biting`, inside the window. */
  hook(): void;
  /** Learner action 5 and 6. Legal in `caught` and `missed` only. */
  reset(): void;
  /** Learner action 2. A held walking intent. */
  move(intent: FishingHudMoveIntent): void;
  /** The current readout. Total: a value before mount and after teardown, never `undefined`. */
  readReadout(): FishingHudReadout;
  /** Leave the pond for the village. */
  returnToVillage(): void;
  /**
   * Subscribe to phase changes. Never fires per frame.
   *
   * The subscription is taken *before* the world exists and survives its teardown, so a
   * control that mounts alongside the pond never misses the first readout. Returns the
   * unsubscribe, which is `() => {}` rather than throwing when there is nothing to stop.
   */
  onPhase(listener: (readout: FishingHudReadout) => void): () => void;
}

/**
 * A port that does nothing.
 *
 * For the one legitimate case: a build with no fishing chunk has no pond, and a HUD that
 * feature-detected `undefined` would either crash or render controls that silently fail -
 * which is the exact defect `FishingController.ts`'s header records. This is the *total*
 * alternative: every control renders, every press reaches a port, and the port declines
 * because there is nothing behind it. The lane does not render a HUD in that case, so this
 * exists for tests and for a future second pond, not for the current one.
 */
export const INERT_FISHING_HUD_PORT: FishingHudPort = Object.freeze({
  beginPower: () => {},
  release: () => {},
  hook: () => {},
  reset: () => {},
  move: () => {},
  readReadout: () => FISHING_HUD_IDLE_READOUT,
  returnToVillage: () => {},
  onPhase: () => () => {},
});