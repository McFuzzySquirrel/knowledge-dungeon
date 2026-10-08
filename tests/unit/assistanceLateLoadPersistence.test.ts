/**
 * Phase 22: a stored assistance mode survives a default build that never loads the store at boot.
 *
 * ## The regression this file exists to catch
 *
 * The production default build (`VITE_ADAPTIVE_ASSISTANCE=false`) no longer fetches
 * `assistanceStore-*.js` at boot: the bootstrap reads and holds the record through
 * `@/services/assistance/assistanceRecord` instead. But the store is still loaded **later** on
 * that build - `useVillageFishing.onDecide` dynamically imports it to call `bumpSignals` when a
 * recall is missed - and `bumpSignals` rebuilds the whole record from the store's in-memory
 * state. If the store's initial state were the documented pre-hydration default (`standard`)
 * rather than the record the bootstrap read, that missed recall would **silently overwrite** a
 * learner's stored `off` with `standard`, on the very build whose flag is off. That is the
 * persistence loss this guard is written to make impossible.
 *
 * ## Why this file imports the store dynamically, and nothing static
 *
 * The store binds itself into the record module's hydration bridge at module load, and the
 * bridge also hands its pending record to the store at the store's creation. So the property
 * under test - "a store created *after* the bootstrap starts from the boot record" - only
 * exists while the store has never been loaded. A static `import` anywhere in this file (or a
 * transitively static one) would load and bind the store before the bootstrap runs and the test
 * would be measuring the flagged-build path instead. Hence: no static import of
 * `@/store/assistanceStore`, and the store is loaded with `await import(...)` exactly where a
 * production later-write would load it.
 *
 * ## The red proof
 *
 * If `initialStateFromPending` in `src/store/assistanceStore.ts` is removed - the store starts
 * from the literal defaults instead of the pending record - the post-load assertion below sees
 * `standard` and the write assertion sees `standard` in `localStorage`, so this file fails on
 * both counts. Verified by mutating that one function and re-running; see the Phase 22 record.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetAssistanceRecordForTests,
  assistanceStoreBound,
  pendingAssistanceRecord,
  readPersistedAssistance,
} from '@/services/assistance/assistanceRecord';
import {
  bootstrapApplication,
  resetBootstrap,
  type BootstrapDeps,
} from '@/application/bootstrap';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';

const KEY = 'knowledge-dungeon:session:assistance';
const NOW = '2026-07-01T12:00:00.000Z';

/** A stored record with a mode the defaults can never produce, so a lost hydration is visible. */
const STORED_OFF: AssistanceRecordValue = Object.freeze({
  assistanceId: 'default',
  mode: 'off',
  signals: { repeatedDraft: 2 },
  dismissalCount: 3,
  updatedAt: '2026-06-01T00:00:00.000Z',
});

/**
 * The smallest dependency set that reaches the **real** assistance wiring on the legacy path.
 *
 * `readAssistance`, `hydrateAssistance`, and `setAssistanceSource` are deliberately omitted, so
 * the bootstrap's own defaults run - which is the shipping `createDefaultBootstrapDeps` shape for
 * these three. Everything else is a no-op, because it is not what this file is about.
 */
function depsWithoutAssistanceOverrides(): BootstrapDeps {
  return {
    repository: 'legacy',
    openRepository: () => Promise.reject(new Error('the legacy lane must not open a repository')),
    generationId: 'gen-late-load-0001',
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
    storageWarningFor: () => '',
    setDualWriteSink: () => {},
    setSessionSource: () => {},
    installSessionLifecycle: () => {},
    hydrateStatisticsSessions: () => {},
    hydratePreferences: () => {},
    hydrateShortcuts: () => {},
    hydrateProgression: () => {},
    setSubjectSnapshot: () => {},
    setSessionActiveSubjectId: () => {},
    setProgressionActiveSubject: () => {},
  };
}

beforeEach(() => {
  resetBootstrap();
  resetRepositorySelection();
  __resetAssistanceRecordForTests();
  window.localStorage.clear();
});

describe('a record read at boot survives a store that loads only when it is first written to', () => {
  it('holds the record while no store is loaded, and the later store starts from it without clobbering it', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(STORED_OFF));

    // ── The boot, on a build that does not preload the store ────────────────────────────────
    await bootstrapApplication(depsWithoutAssistanceOverrides());

    // The bootstrap read the record (its default reader follows the selected repository) ...
    const held = pendingAssistanceRecord();
    expect(held?.mode, 'the bootstrap did not read the stored mode').toBe('off');
    expect(held?.dismissalCount).toBe(3);
    // ... and did **not** load the store to do it. This is the unit-level statement of the
    // browser observation that `assistanceStore-*.js` is not requested at boot on the default
    // artifact: nothing has bound the store, so nothing has loaded it.
    expect(
      assistanceStoreBound(),
      'a default build bootstrap loaded the assistance store, so the fetch was not removed',
    ).toBe(false);

    // ── The later load, exactly as a missed-recall `bumpSignals` performs it ─────────────────
    const store = await import('@/store/assistanceStore');
    const state = store.useAssistanceStore.getState();
    expect(
      state.mode,
      'the store loaded with the pre-hydration default instead of the stored mode, so a later ' +
        'write would overwrite the learner’s choice',
    ).toBe('off');
    expect(state.dismissalCount).toBe(3);
    expect(state.signals.repeatedDraft).toBe(2);

    // The write that would have clobbered it. `bumpSignals` is a counter and rebuilds the whole
    // record from in-memory state, so this is the exact path that loses a mode.
    state.bumpSignals({ fishingRecallMiss: 1 });

    const persisted = readPersistedAssistance();
    expect(persisted?.mode, 'a write on the default build overwrote the stored mode').toBe('off');
    expect(persisted?.dismissalCount, 'a write discarded the stored dismissal count').toBe(3);
    expect(persisted?.signals.fishingRecallMiss, 'the counter the write was for did not land').toBe(1);
    expect(persisted?.signals.repeatedDraft, 'a write discarded a stored signal').toBe(2);
  });
});
