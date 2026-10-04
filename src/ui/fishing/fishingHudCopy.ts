/**
 * The words the fishing surfaces say.
 *
 * ## Why the copy is a table and not inline in the component
 *
 * Three reasons, and the third is why this file exists rather than being folded into
 * `FishingHud.tsx`:
 *
 * 1. **Plan 10.1 forbids colour-only state.** Every one of the eight cast phases therefore
 *    needs a *sentence*, and the sentence is a fact about the session rather than a fact
 *    about the component. A test can assert that `biting` says something about a bite
 *    without rendering anything.
 * 2. **A sentence per phase is a promise.** If the instruction for `caught` were written in
 *    the JSX, there would be nothing to hold it to and a re-render could quietly change it.
 *    A table is one object that a test walks phase by phase, so "every phase says something,
 *    and no two phases say the same thing" is a checkable claim rather than a review note.
 * 3. **The control labels are part of the contract with the state machine.** The machine's
 *    header tabulates the six learner actions and names the control for each; this file is
 *    the DOM half of that table, and keeping it beside the phases means a control's label
 *    and the phase it exists for are edited together.
 *
 * ## No learner data
 *
 * Every string here is a fixed sentence or a fixed label. None is interpolated, none carries
 * a subject name, a room name, a fish name, or a count that a learner chose. The two numbers
 * that *are* rendered - the charge percentage and the catch count - are formatted from a
 * number by {@link formatPowerPercent} and {@link formatCaughtCount}, and neither is derived
 * from anything a learner typed.
 */

/** The words for one cast phase: what is happening, and what the learner can do about it. */
export interface FishingPhaseCopy {
  /**
   * The phase's name, for the status sentence and the phase chip.
   *
   * A word, never a colour and never an icon: this is the fact plan 10.1's no-colour-only
   * rule exists to guarantee is reachable.
   */
  readonly phaseName: string;
  /** What is happening, in one sentence. */
  readonly status: string;
  /** What to do next, in one sentence. Empty when there is nothing to do. */
  readonly instruction: string;
}

/**
 * Every cast phase, in the machine's declaration order.
 *
 * All eight, including the three a learner cannot act on (`casting`, `waiting`, `reeling`).
 * That is deliberate: a phase with an empty `instruction` still has a `status`, so a learner
 * watching a cast that is already in the air is told it is in the air rather than being shown
 * a blank instruction line. `tests/phase17/fishing-hud.test.tsx` asserts that all eight are
 * present and that each has a non-empty name and status.
 */
export const FISHING_PHASE_COPY: Readonly<Record<string, FishingPhaseCopy>> = Object.freeze({
  idle: {
    phaseName: 'Ready',
    status: 'You are standing at the water with your line ready.',
    instruction: 'Hold the charge button to build power, then let go to cast.',
  },
  powering: {
    phaseName: 'Charging',
    status: 'You are pulling the line back and the cast is charging up.',
    instruction: 'Let go of the charge button to cast at that strength.',
  },
  casting: {
    phaseName: 'Casting',
    status: 'The line is flying out over the water.',
    instruction: 'Wait for the float to land.',
  },
  waiting: {
    phaseName: 'Waiting',
    status: 'The float is on the water, waiting for a fish to come near it.',
    instruction: 'Wait. When a fish bites, set the hook straight away.',
  },
  biting: {
    phaseName: 'Bite',
    status: 'A fish has taken the bait.',
    instruction: 'Set the hook now, before the fish swims away.',
  },
  reeling: {
    phaseName: 'Reeling in',
    status: 'The fish is on the line and you are reeling it in.',
    instruction: 'Wait for the catch to come up out of the water.',
  },
  caught: {
    phaseName: 'Caught',
    status: 'You have a fish on the bank.',
    instruction: 'Cast again when you are ready for the next one.',
  },
  missed: {
    phaseName: 'Missed',
    status: 'The fish got away.',
    instruction: 'Try again to cast for another one.',
  },
});

/** The sentence for a phase name, and `Ready` for one this file does not know. */
export function fishingPhaseCopy(phase: string): FishingPhaseCopy {
  return (
    FISHING_PHASE_COPY[phase] ?? {
      phaseName: 'Ready',
      status: 'You are standing at the water with your line ready.',
      instruction: 'Hold the charge button to build power, then let go to cast.',
    }
  );
}

/** One of the six learner actions, as the DOM presents it. */
export interface FishingControlCopy {
  /** The button's accessible name. */
  readonly label: string;
  /** The keys that do the same thing, for the visible hint. */
  readonly keys: string;
  /** Whether the control is a press-and-hold rather than a tap. */
  readonly hold: boolean;
}

/**
 * The six controls, keyed by the port method they drive.
 *
 * `beginPower` and `release` deliberately **share** one control, and this is the shape that
 * says so: one entry whose `hold: true`, and the same entry named by the release. A learner
 * charging a cast needs the press and the lift to be the same finger on the same button -
 * two buttons would mean moving between them, and moving between them is how a charge gets
 * dropped.
 *
 * `reset` has two labels and two ids because it is two *outcomes*: `caught` is "Cast again"
 * and `missed` is "Try again". They are the same transition and they are not the same
 * sentence, and the sentence is what tells the learner the fish got away.
 */
export const FISHING_CONTROL_COPY: Readonly<
  Record<'beginPower' | 'hook' | 'resetCaught' | 'resetMissed' | 'walkLeft' | 'walkRight', FishingControlCopy>
> = Object.freeze({
  beginPower: {
    label: 'Hold to charge a cast',
    keys: 'Space or Enter, hold and release',
    hold: true,
  },
  hook: { label: 'Set the hook', keys: 'Space or Enter', hold: false },
  resetCaught: { label: 'Cast again', keys: 'Space or Enter', hold: false },
  resetMissed: { label: 'Try again', keys: 'Space or Enter', hold: false },
  walkLeft: { label: 'Walk left', keys: 'A or Left arrow, hold', hold: true },
  walkRight: { label: 'Walk right', keys: 'D or Right arrow, hold', hold: true },
});

/** The key names, for the visible hint beside the walk pair and the visible hint alone. */
export const FISHING_WALK_KEY_HINT =
  'Hold A or the Left arrow to walk left, D or the Right arrow to walk right.';

/**
 * The charge as a whole-number percentage, clamped to `0`..`100`.
 *
 * Written out rather than `Math.round(power * 100) % 100` so three edge cases are handled in
 * one place and are testable: a `NaN` power (which `Math.round` would render as `NaN%` in the
 * middle of a sentence), a power above `1` from a machine that was asked to overcharge, and a
 * negative one. A percentage that is not a number is worse than no percentage.
 */
export function formatPowerPercent(power: number): number {
  if (!Number.isFinite(power)) return 0;
  const scaled = Math.round(power * 100);
  if (scaled <= 0) return 0;
  if (scaled >= 100) return 100;
  return scaled;
}

/** The session's kept-fish count as a noun phrase, so `1` does not read as `1 fishs`. */
export function formatCaughtCount(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return `${safe} fish kept in this trip`;
}

/**
 * The sentence an ineligible pond shows instead of the controls.
 *
 * One sentence, and it says what to do about it. The pre-Phase-17 village said the same thing
 * in a structure-panel hint, but the pond itself had no DOM text at all, so a learner who
 * arrived at the water by a route other than that panel had nothing.
 */
export const FISHING_INELIGIBLE_STATUS =
  'This pond is closed for now. Clear at least one dungeon room for this subject, then come back to fish.';