/**
 * The Phase 18 rollback: a panel-level gate on the statistics dashboard.
 *
 * ## What the plan asks for
 *
 * Phase 18's rollback line is one sentence: *"Disable statistics display while
 * retaining collected records."* That is a **display** switch. It says nothing about
 * stopping collection, nothing about deleting history, and nothing about a second
 * answer to "how many notes have I written".
 *
 * ## Why this is a DOM-layer module and not a feature flag
 *
 * The maintainer decided Phase 18 gets a panel-level gate rather than a new build-time
 * flag, so this module deliberately does **not** touch `src/config/featureFlags.ts` or
 * `src/config/runtimeConfig.ts`. Two reasons, and the second is the important one:
 *
 * 1. `NON_CUTOVER_FLAG_KEYS` is exactly `['audioEnabled']`, and the three gates that
 *    assert "no cutover flag defaults on" are correct as written. Adding a Phase 18
 *    entry to the matrix, or to that list, would either fail those gates or require
 *    weakening them to accommodate a flag that does not exist.
 * 2. A build-time flag switches a *behaviour* for every learner in a release. The
 *    Phase 18 rollback is a **presentation** rollback for one panel, and a switch for
 *    one panel does not belong in the release matrix: a reviewer reading
 *    `src/config/featureFlags.ts` should see only the cuts that change what the
 *    application *does*.
 *
 * So the gate lives here, next to the surface it gates, and it is a module-level
 * boolean with a subscribe function.
 *
 * ## Why the module is structurally incapable of losing a record
 *
 * The rollback's dangerous half is the word "while retaining". A gate that reached a
 * store, a repository, or `localStorage` could satisfy "display is off" by clearing the
 * snapshot, and a learner would come back to an empty dashboard with no way to know why.
 *
 * So this module's entire capability surface is:
 *
 * - one boolean, {@link isStudyStatsDashboardEnabled};
 * - one setter, {@link setStudyStatsDashboardEnabled}, which assigns that boolean and
 *   notifies subscribers;
 * - one subscribe/unsubscribe pair, for React's `useSyncExternalStore`;
 * - one React hook, {@link useStudyStatsDashboardEnabled}.
 *
 * It imports **React and nothing else**. No `@/store`, no `@/services`, no
 * `@/core`, no storage, no `fetch`. There is no code path from here to a record, which
 * is a stronger property than a comment promising the setter is careful:
 * `tests/phase18/studyStatsDashboard.test.tsx` reads this file's import set and fails if
 * a single specifier other than `react` appears.
 *
 * ## Why `true` is the default
 *
 * There is no build here that reads an environment variable, so "the production default
 * build" is simply "the build that does not install an override". That is
 * {@link STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT}, and it is `true`, which is the
 * Phase 18 deliverable. The override exists for a review, a screenshot comparison, and a
 * rollback; none of those are the default state.
 *
 * ## Why the override is not persisted
 *
 * It is not learner data, and persisting it would put a presentation switch into the
 * backup products, where it would then need a migration, a conflict rule, and a place in
 * every export schema - for a decision that is supposed to be per-build and per-review.
 * An override lives only as long as the process that installed it.
 */
import { useSyncExternalStore } from 'react';

/**
 * Whether the redesigned statistics dashboard renders when no override is installed.
 *
 * `true`, and it is a named constant rather than a bare `true` at the use site so a test
 * can hold the default without re-deriving it, and so the "the default build shows the
 * dashboard" claim is one readable line rather than a boolean in a component.
 */
export const STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT = true;

/** The live value. A boolean in this module, and nothing else. */
let enabled = STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT;

/** Notified on every change. A `Set`, so one subscriber cannot block another. */
const listeners = new Set<() => void>();

function notify(): void {
  // Copied first: a listener may unsubscribe itself while being called, and iterating
  // the live set while it mutates would skip the next listener.
  for (const listener of [...listeners]) listener();
}

/**
 * Whether the dashboard is currently displayed.
 *
 * The plain read a non-React caller uses. Reactive callers want
 * {@link useStudyStatsDashboardEnabled}, which re-renders on change; this does not and
 * does not pretend to.
 */
export function isStudyStatsDashboardEnabled(): boolean {
  return enabled;
}

/**
 * Subscribe to gate changes. Returns the unsubscribe function.
 *
 * The shape `useSyncExternalStore` wants, exposed as its own function so the store can
 * be read from a test with no React at all - which is what lets the rollback test prove
 * that flipping the gate changes the rendered tree *and* leaves every record alone,
 * without a render in the second half of the claim.
 */
export function subscribeStudyStatsGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The gate's value as a server snapshot.
 *
 * There is no server render of this application, but `useSyncExternalStore` requires the
 * argument and returning the constant is the honest answer: the default build's value is
 * known without asking a mutable module.
 */
export function studyStatsGateServerSnapshot(): boolean {
  return STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT;
}

/**
 * Turn the dashboard off, or back on.
 *
 * @param next The value to display with.
 * @returns A function that restores the value this call replaced, and only if the value
 *   is still `next`. Two overrides installed over the same value would otherwise restore
 *   in an order neither caller chose, and the second restore would silently undo the
 *   first - a test helper that leaks a gate is worse than one that throws.
 *
 * Setting the value it already has notifies nobody: an unchanged value is not a change,
 * and a no-op that re-renders every statistics surface would be a lie about the work.
 */
export function setStudyStatsDashboardEnabled(next: boolean): () => void {
  const previous = enabled;
  if (previous === next) return () => {};
  enabled = next;
  notify();
  return () => {
    if (enabled !== next) return;
    enabled = previous;
    notify();
  };
}

/**
 * Restore the production default and drop every subscriber.
 *
 * For test teardown only. A test that installs an override and does not restore it leaves
 * a module-level boolean wrong for every later file in the same worker, which is the
 * failure mode that makes a suite order-dependent.
 */
export function resetStudyStatsGate(): void {
  enabled = STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT;
  listeners.clear();
  notify();
}

/**
 * The gate as a React surface reads it.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect: the gate's value can be
 * changed from outside React - by a review harness, by a test, by a future settings
 * control - and a component that only learns about it in an effect would render one frame
 * with the dashboard on after it was switched off.
 */
export function useStudyStatsDashboardEnabled(): boolean {
  return useSyncExternalStore(
    subscribeStudyStatsGate,
    isStudyStatsDashboardEnabled,
    studyStatsGateServerSnapshot,
  );
}
