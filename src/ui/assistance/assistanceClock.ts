/**
 * The one place `src/ui/assistance/**` is allowed to ask what time it is.
 *
 * ## Why this module exists rather than a prop
 *
 * Plan section 8's exit criterion is "identical state always produces identical assistance",
 * and the engine is proved on it: `AssistanceEngineInput.nowIso` is the engine's *only* time
 * input, and `tests/phase19/assistanceDeterminism.test.ts` fails on any `Date.now`,
 * `new Date`, `Date()`, `performance.now`, or `Math.random` in the executable code of
 * `src/core/assistance/**`.
 *
 * A component that called `new Date().toISOString()` would satisfy every type in that
 * interface and quietly destroy the property, because the clock would move between two renders
 * of the same state and the same learner would be shown two different cards. So the UI needs a
 * seam, and the seam is a module-level clock rather than a prop because the four integration
 * points are four unrelated component trees that would otherwise each need the value threaded
 * from wherever the session began.
 *
 * ## The installed default, and why it is not the component
 *
 * The default below is the only `new Date` in this directory's source, and
 * `tests/phase19/assistanceUiAdvisory.test.ts` proves that mechanically: it scans
 * `src/ui/assistance/**` for the same token list the determinism gate uses and fails on any
 * hit outside this file, then asserts this file contains exactly one. The gate is two-sided on
 * purpose - a scan that passed because the pattern did not match would assert nothing.
 *
 * ## Read during render, never cached in a field
 *
 * `assistanceNowIso()` is called from component bodies and from the view-model builder, so the
 * value a card renders with belongs to the frame that produced it. Phase 17's rule applies: a
 * clock captured into a module constant or a `useState` initialiser is right for the render
 * that read it and wrong for every render after it. Nothing in this directory stores one.
 */

/** An injected ISO-8601 clock. */
export type AssistanceClock = () => string;

/**
 * The shipped clock.
 *
 * `toISOString()`, not `Date.now()`, because the engine takes a string and a numeric clock
 * would invite a component to format it - and formatting a timestamp is where a locale leaks
 * into a value the engine is supposed to be pure over.
 */
const systemClock: AssistanceClock = () => new Date().toISOString();

let installed: AssistanceClock = systemClock;

/**
 * Install a clock, or pass `null` to restore the system one.
 *
 * A test installs a fixed clock and gets byte-identical cards on every run; a host that has a
 * session clock already can hand it over rather than having two disagree.
 */
export function setAssistanceClock(clock: AssistanceClock | null): void {
  installed = clock ?? systemClock;
}

/** The current time as an ISO-8601 string. Called during render, never stored. */
export function assistanceNowIso(): string {
  return installed();
}

/** Restore the system clock and drop any installed one. Test teardown only. */
export function __resetAssistanceClockForTests(): void {
  installed = systemClock;
}