/**
 * Phase 19: `commitPlan` really hydrates the assistance store, on **both** repository paths.
 *
 * ## Why this gate exists, in the shape of the failure it prevents
 *
 * In Phase 18, `commitPlan` gained two new hydration dependencies, two tests in
 * `tests/unit/appBootstrap.test.ts` were amended to pass them as no-ops, and **nothing verified the
 * wiring**. Deleting both call sites left roughly 5,900 tests green while the statistics dashboard
 * recorded nothing at all: the plan read the data, put it in the plan object, and no test noticed
 * that no store ever received it. A passing test that supplies a dependency and asserts nothing
 * about it is the exact shape of that hole.
 *
 * So this gate asserts the *effect*, not the presence of a parameter:
 *
 * 1. `commitPlan` calls the `hydrateAssistance` dependency **exactly once**, with the record the
 *    plan carries - the Phase 18 assertion, made real.
 * 2. The dependency is **optional**, and when it is absent the fallback hydrates the real store.
 *    Without this, the `??` fallback would be an untested branch and the optional marker would be
 *    an escape hatch: a caller that omits the dep would silently get nothing.
 * 3. `readPlan` calls the `readAssistance` dependency and puts its result on `plan.assistance`.
 * 4. The **legacy** repository path hydrates the store from the legacy `localStorage` key. This is
 *    the leg that matters for the shipping default: a gate that only exercises the storage-v2 lane
 *    would pass while the default artifact recorded nothing.
 * 5. Hydration happens **before** the first render, not after, so a stored mode of `off` is applied
 *    to the first frame.
 *
 * ## Non-vacuity
 *
 * Every test below asserts that a spy was called with a **non-null** record, and `it('the control')`
 * asserts the whole harness reaches the hydration at all. A bootstrap that dropped the
 * assistance record entirely would leave the spies at zero calls and fail tests 1, 2, 3, and 4 -
 * which is checked by mutation, not assumed: see the file's companion note in the phase report, where
 * the call site and the fallback were each deleted in turn and each turned this file red.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bootstrapApplication,
  createDefaultBootstrapDeps,
  resetBootstrap,
  type BootstrapDeps,
} from '@/application/bootstrap';
import { ASSISTANCE_STORAGE_KEY, useAssistanceStore } from '@/store/assistanceStore';
import { pendingBootstrap } from '@/application/bootstrap';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';

const NOW = '2026-03-15T12:00:00.000Z';

/** A stored record with four distinct counters, so a field-by-field mix-up cannot pass. */
const STORED: AssistanceRecordValue = {
  assistanceId: 'default',
  mode: 'off',
  signals: { noteValidationFailure: 7, lowRecallRating: 3, repeatedDraft: 12, fishingRecallMiss: 5 },
  dismissalCount: 4,
  updatedAt: NOW,
};

/**
 * The smallest dependency set that reaches `commitPlan` on the legacy path.
 *
 * Only the reads that `readPlan` actually calls are supplied; everything else is a no-op, and each
 * no-op is here because the plan requires it to *exist*, not because it is asserted. That
 * distinction is the point of the file: a no-op dep in a test is fine, a no-op dep in
 * `commitPlan` is the Phase 18 defect.
 */
function legacyDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return complete(overrides);
}

/**
 * Complete the required dependency set.
 *
 * `readActiveSubjectId`, `loadSubjectSnapshot`, `setDualWriteSink`, and `setSessionSource` are
 * required by `BootstrapDeps` but not reached on a legacy run with no subjects. They are supplied
 * as no-ops - which is fine **here**, in a test, and is exactly what is not fine in `commitPlan`.
 */
function complete(partial: Partial<BootstrapDeps>): BootstrapDeps {
  return {
    repository: 'legacy',
    openRepository: () => {
      throw new Error('the legacy lane must not open a repository');
    },
    generationId: 'gen-initial-0001',
    now: NOW,
    readLegacyState: () => ({
      subjects: [],
      progression: null,
      preferences: null,
      shortcuts: null,
      sessions: null,
      activeSubjectId: null,
    }),
    readActiveSubjectId: () => null,
    listSubjectIds: async () => [],
    loadSubjectSnapshot: async () => null,
    getStorageThreshold: () => 'ok',
    storageWarningFor: () => 'synthetic warning',
    setDualWriteSink: () => {},
    setSessionSource: () => {},
    hydratePreferences: () => {},
    hydrateShortcuts: () => {},
    hydrateProgression: () => {},
    setSubjectSnapshot: () => {},
    setSessionActiveSubjectId: () => {},
    setProgressionActiveSubject: () => {},
    installSessionLifecycle: () => {},
    hydrateStatisticsSessions: () => {},
    ...partial,
  };
}

/** A record that is unmistakably not the default, so "hydrated with the stored value" is checkable. */
function recordWith(overrides: Partial<AssistanceRecordValue>): AssistanceRecordValue {
  return { ...STORED, ...overrides };
}

let hydrateCalls: Array<AssistanceRecordValue | null> = [];
let readCalls = 0;

beforeEach(() => {
  hydrateCalls = [];
  readCalls = 0;
  // `bootstrapApplication` memoizes its promise in module state, so without this the second test
  // in this file would receive the *first* test's result and every assertion after the first would
  // be measuring the wrong run. This is the memoization the StrictMode test below is about, used
  // here as the test-support reset it exists for.
  resetBootstrap();
  resetRepositorySelection();
  useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 0 });
  window.localStorage.clear();
});

describe('commitPlan really hydrates the assistance store', () => {
  it('the control: the harness reaches hydration at all', async () => {
    // If this fails, every other assertion in this file is measuring nothing. Stated first and on
    // purpose, so a failure here is legible rather than looking like a wiring regression.
    //
    // It supplies **no** `hydrateAssistance` dep, so it exercises the same fallback the shipping
    // build uses. A control that supplied a spy would pass even if the fallback were the broken
    // half.
    await bootstrapApplication(legacyDeps({ readAssistance: async () => STORED }));
    expect(hydrateCalls).toHaveLength(0);
    expect(useAssistanceStore.getState().mode, 'the control never reached hydration').toBe('off');
    expect(useAssistanceStore.getState().dismissalCount).toBe(4);
  });

  it('commitPlan calls hydrateAssistance exactly once, with the record the plan carries', async () => {
    // The Phase 18 assertion, made real: a dependency that exists and is passed is not the same as
    // a dependency that is called.
    await bootstrapApplication(
      legacyDeps({
        readAssistance: async () => {
          readCalls += 1;
          return STORED;
        },
        hydrateAssistance: (record) => {
          hydrateCalls.push(record);
        },
      }),
    );
    expect(readCalls, 'the plan never read the record').toBe(1);
    expect(hydrateCalls).toHaveLength(1);
    // Value for value, so a caller that hydrated the *default* rather than the stored record
    // cannot pass.
    expect(hydrateCalls[0]).toEqual(STORED);
    expect(hydrateCalls[0]?.mode).toBe('off');
    expect(hydrateCalls[0]?.dismissalCount).toBe(4);
  });

  it('the optional dependency is not an escape hatch: with no dep, the real store is hydrated', async () => {
    // `hydrateAssistance` is declared optional and `commitPlan` falls back to
    // `useAssistanceStore.getState().hydrateAssistance(record)`. If that fallback were wrong, or were
    // removed, every test above would still pass - they all supply a spy - and the **shipping**
    // build, which uses `createDefaultBootstrapDeps`, would record nothing. This is the leg that
    // closes that.
    await bootstrapApplication(legacyDeps({ readAssistance: async () => STORED }));
    expect(hydrateCalls).toHaveLength(0);
    const state = useAssistanceStore.getState();
    expect(state.mode, 'the real store was not hydrated with the stored mode').toBe('off');
    expect(state.dismissalCount).toBe(4);
    expect(state.signals.repeatedDraft).toBe(12);
    expect(state.signals.fishingRecallMiss).toBe(5);
  });

  it('the default dependency set hydrates the store, which is the shipping build', async () => {
    // One level up from the previous test: `createDefaultBootstrapDeps()` is what `main.tsx` uses,
    // so this is the assertion about the artifact rather than about a hand-built dependency set.
    window.localStorage.setItem(ASSISTANCE_STORAGE_KEY, JSON.stringify(STORED));
    await bootstrapApplication(createDefaultBootstrapDeps({ repository: 'legacy' }));
    expect(useAssistanceStore.getState().mode).toBe('off');
    expect(useAssistanceStore.getState().dismissalCount).toBe(4);
  });

  it('the legacy repository path reads the legacy key, which is the shipping default artifact', async () => {
    // The default build runs `VITE_STORAGE_REPOSITORY=legacy`. A gate that only exercised the
    // storage-v2 lane would be green while the default artifact recorded nothing - the same shape
    // of failure as Phase 18, one repository over.
    window.localStorage.setItem(ASSISTANCE_STORAGE_KEY, JSON.stringify(recordWith({ mode: 'gentle' })));
    let sourceInstalled: unknown = 'not-called';
    await bootstrapApplication(
      legacyDeps({
        // No `readAssistance` dep: this is the real reader, which is what the legacy lane uses.
        setAssistanceSource: (source) => {
          sourceInstalled = source;
        },
      }),
    );
    // On the legacy lane the storage-v2 source must be installed as `null`, or a device that ran
    // the flagged build and came back would keep reading a repository this run never selected.
    expect(sourceInstalled, 'the legacy lane did not clear the assistance source').toBeNull();
    expect(useAssistanceStore.getState().mode).toBe('gentle');
    expect(useAssistanceStore.getState().signals.lowRecallRating).toBe(3);
  });

  it('a device with nothing stored hydrates to the documented defaults, not to undefined', async () => {
    // The pre-hydration state and the post-hydration state of an empty device must be the same, so
    // nothing renders differently before and after hydration.
    await bootstrapApplication(legacyDeps({ readAssistance: async () => null }));
    const state = useAssistanceStore.getState();
    expect(state.mode).toBe('standard');
    expect(state.signals).toEqual({});
    expect(state.dismissalCount).toBe(0);
  });

  it('a read that rejects is not a bootstrap failure, and hydration still happens', async () => {
    // An unreadable assistance record must not cost the learner their app. Asserted as a
    // *successful* bootstrap, because the alternative - propagating the rejection - would leave a
    // blank screen over one unreadable key.
    const result = await bootstrapApplication(
      legacyDeps({
        readAssistance: async () => {
          throw new Error('synthetic read failure');
        },
        hydrateAssistance: (record) => {
          hydrateCalls.push(record);
        },
      }),
    );
    expect(result.status).toBe('ready');
    expect(result.failures).not.toContain('LEGACY_READ_FAILED');
    expect(hydrateCalls).toHaveLength(1);
    expect(hydrateCalls[0]).toBeNull();
  });

  it('a corrupt stored record hydrates to the defaults rather than to a half-parsed value', async () => {
    window.localStorage.setItem(ASSISTANCE_STORAGE_KEY, JSON.stringify({ mode: 'aggressive', signals: 'nope' }));
    await bootstrapApplication(legacyDeps());
    const state = useAssistanceStore.getState();
    expect(state.mode).toBe('standard');
    expect(state.signals).toEqual({});
  });

  it('hydration happens before the bootstrap resolves, so the first render already sees it', async () => {
    // Ordering, not just presence. A record applied after the first render would show one frame of
    // a learner's `off` mode as `standard` - a visible flash of suggestions they had turned off,
    // which is the failure `BootstrapDeps.readAssistance`'s own comment says this placement avoids.
    await bootstrapApplication(
      legacyDeps({
        readAssistance: async () => STORED,
        hydrateAssistance: (record) => {
          hydrateCalls.push(record);
        },
      }),
    );
    // No await between the resolution of this call and the assertion: the record was applied by
    // the time this promise settled, not by some later task.
    expect(hydrateCalls).toHaveLength(1);
    expect(hydrateCalls[0]).toEqual(STORED);
  });

  it('the no-args bootstrap is memoized, so a StrictMode double-invoke runs it once', async () => {
    // `bootstrapApplication()` with **no** argument is the form `main.tsx` uses, and it is the
    // only memoized form - `bootstrapApplication(deps)` deliberately runs fresh every time, because
    // a test that supplies its own dependencies must not inherit another run's result.
    //
    // So this asserts the memoization where it exists. Two calls must resolve to the *same*
    // promise and the *same* result object, and `pendingBootstrap()` must hand back the in-flight
    // promise: `main.tsx` awaits it before the first render and `App` awaits the same promise, so a
    // StrictMode double-invoke that re-ran the read would double-apply a signal count - a real data
    // defect, not a cosmetic one.
    const first = bootstrapApplication();
    const inFlight = pendingBootstrap();
    expect(inFlight, 'the no-args bootstrap did not publish a pending promise').not.toBeNull();
    const second = bootstrapApplication();
    expect(second, 'the second call built a new promise instead of reusing the memo').toBe(first);
    expect(pendingBootstrap()).toBe(inFlight);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    // And the memo is real state, not a no-op: it is clearable and the reset is what makes every
    // other test in this file independent.
    resetBootstrap();
    expect(pendingBootstrap()).toBeNull();
  });
});
