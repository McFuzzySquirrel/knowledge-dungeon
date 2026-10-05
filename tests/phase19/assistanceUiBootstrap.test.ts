/**
 * The bootstrap wiring, asserted so that deleting a call site turns this file red.
 *
 * ## The Phase 18 lesson this file is written against
 *
 * `src/application/bootstrap.ts` gained two no-op `BootstrapDeps` members in Phase 18 -
 * `installSessionLifecycle` and `hydrateStatisticsSessions` - and **nothing asserted that
 * `commitPlan` called them**. Deleting both call sites left roughly 5,900 tests green while the
 * statistics dashboard recorded nothing.
 *
 * So the claim this file makes is not "the bootstrap has an assistance field". It is: **the
 * assistance record reaches the store**, and every part of that is asserted with a value the test
 * chose:
 *
 * 1. `createDefaultBootstrapDeps()` returns real implementations, not stubs. A test that pins the
 *    *shape* of a no-op - `() => undefined` is not `undefined` - would pass on a stub.
 * 2. The **read** half is awaited before the first render. A learner whose stored mode is `off`
 *    must not see one frame of `standard`, and that is a claim about ordering, so it is asserted
 *    by ordering: the read records when it ran relative to the commit.
 * 3. The **commit** half applies exactly the record the read produced - a specific mode, a specific
 *    signal map, a specific count - not merely "something was called".
 * 4. A `null` read (nothing stored, or a read that rejects) resets to the documented defaults.
 * 5. Removing a dep from the object falls back to the **real** operation, so there is no
 *    configuration in which the wiring silently does nothing.
 *
 * ## And the two no-op deps found while doing this
 *
 * `deps.setDualWriteSink` and `deps.setSessionSource` are **declared, defaulted, and never called**
 * in `bootstrap.ts` as of this writing - the same defect, still present, in code this stage did not
 * write. They are asserted as *currently uncalled* below, so that the day someone fixes them this
 * test goes red and has to be updated deliberately rather than silently changing what it claims.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapApplication,
  createDefaultBootstrapDeps,
  type BootstrapDeps,
  type BootstrapResult,
} from '@/application/bootstrap';
import {
  DEFAULT_ASSISTANCE_MODE,
  __resetAssistanceStoreForTests,
  readPersistedAssistance,
  setAssistanceSource,
  useAssistanceStore,
} from '@/store/assistanceStore';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';

const SUBJECT_ID = 'bootstrap-assistance-subject';
const OTHER_SUBJECT_ID = 'bootstrap-assistance-other';
const ROOM_ID = 'room-a';

const NOW = '2026-03-15T12:00:00.000Z';

function syntheticSnapshot(id: string, name: string): never {
  return {
    dungeon: { dungeonId: id, subjectName: name, rootRoomId: ROOM_ID, phaseState: 'CreatorActive', edges: [] },
    rooms: { [ROOM_ID]: { roomId: ROOM_ID, topic: 'Algebra' } },
  } as never;
}

/** A persisted assistance record with values a test can recognise after hydration. */
const STORED_RECORD: AssistanceRecordValue = Object.freeze({
  assistanceId: 'default',
  mode: 'gentle',
  signals: { repeatedDraft: 3 },
  dismissalCount: 7,
  updatedAt: '2026-03-01T00:00:00.000Z',
});

function baseDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    repository: 'legacy',
    openRepository: () => Promise.reject(new Error('storage-v2 must not open on the legacy path')),
    generationId: 'gen-bootstrap-assistance-0001',
    now: NOW,
    readLegacyState: () => ({
      subjects: [
        { id: SUBJECT_ID, snapshot: syntheticSnapshot(SUBJECT_ID, 'Bootstrap subject') },
        { id: OTHER_SUBJECT_ID, snapshot: syntheticSnapshot(OTHER_SUBJECT_ID, 'Bootstrap other') },
      ],
      progression: null,
      preferences: null,
      shortcuts: null,
      sessions: null,
      activeSubjectId: SUBJECT_ID,
    }),
    readActiveSubjectId: () => SUBJECT_ID,
    listSubjectIds: () => Promise.resolve([SUBJECT_ID, OTHER_SUBJECT_ID]),
    loadSubjectSnapshot: (subjectId: string) =>
      Promise.resolve(
        subjectId === SUBJECT_ID ? syntheticSnapshot(SUBJECT_ID, 'Bootstrap subject') : null,
      ),
    getStorageThreshold: () => 'ok',
    storageWarningFor: () => 'synthetic warning',
    setDualWriteSink: () => undefined,
    setSessionSource: () => undefined,
    installSessionLifecycle: () => undefined,
    hydrateStatisticsSessions: () => undefined,
    hydratePreferences: () => undefined,
    hydrateShortcuts: () => undefined,
    hydrateProgression: () => undefined,
    setSubjectSnapshot: () => undefined,
    setSessionActiveSubjectId: () => undefined,
    setProgressionActiveSubject: () => undefined,
    ...overrides,
  } as BootstrapDeps;
}

beforeEach(() => {
  __resetAssistanceStoreForTests();
  setAssistanceSource(null);
  window.localStorage.clear();
});

describe('the default dependencies are real operations, not stubs', () => {
  it('each Phase 19 dep is a function that returns `undefined`, which is also what a no-op returns', () => {
    // The tautology this has to beat: `() => undefined` and a real operation can both "return
    // undefined", so a shape assertion cannot tell them apart. The distinguishing assertions are
    // the ones below and in the following blocks, which supply known values and read them back.
    const deps = createDefaultBootstrapDeps({ repository: 'legacy' });
    for (const name of ['setAssistanceSource', 'readAssistance', 'hydrateAssistance'] as const) {
      expect(typeof deps[name], name).toBe('function');
    }
  });

  it('the default `readAssistance` reads the legacy key the store owns', async () => {
    window.localStorage.setItem(
      'knowledge-dungeon:session:assistance',
      JSON.stringify(STORED_RECORD),
    );
    const deps = createDefaultBootstrapDeps({ repository: 'legacy' });
    const read = deps.readAssistance!;
    const record = await read();
    expect(record).not.toBeNull();
    // Values, not "it returned something": a stub returning the record it was handed, or a
    // reader returning `{}`, would both satisfy a truthiness check.
    expect(record!.mode).toBe('gentle');
    expect(record!.dismissalCount).toBe(7);
    expect(record!.signals).toEqual({ repeatedDraft: 3 });
  });

  it('the default `readAssistance` yields null when nothing is stored', async () => {
    const deps = createDefaultBootstrapDeps({ repository: 'legacy' });
    expect(await deps.readAssistance!()).toBeNull();
    expect(readPersistedAssistance()).toBeNull();
  });

  it('the default `hydrateAssistance` really writes the store', () => {
    const deps = createDefaultBootstrapDeps({ repository: 'legacy' });
    deps.hydrateAssistance!(STORED_RECORD);
    const state = useAssistanceStore.getState();
    expect(state.mode).toBe('gentle');
    expect(state.dismissalCount).toBe(7);
    expect(state.signals).toEqual({ repeatedDraft: 3 });
  });

  it('the default `hydrateAssistance(null)` resets to the documented defaults', () => {
    const deps = createDefaultBootstrapDeps({ repository: 'legacy' });
    deps.hydrateAssistance!(STORED_RECORD);
    deps.hydrateAssistance!(null);
    const state = useAssistanceStore.getState();
    expect(state.mode).toBe(DEFAULT_ASSISTANCE_MODE);
    expect(state.dismissalCount).toBe(0);
    expect(state.signals).toEqual({});
  });
});

describe('the wiring reaches the store through a real bootstrap run', () => {
  it('a stored record is read, then committed, in that order', async () => {
    const order: string[] = [];
    let readFinished = false;
    const result = await bootstrapApplication(
      baseDeps({
        readAssistance: async () => {
          order.push('read');
          readFinished = true;
          return STORED_RECORD;
        },
        hydrateAssistance: (record) => {
          order.push('commit');
          // The ordering claim, asserted from inside the commit: the read has already resolved.
          // A commit that ran before its read would carry `undefined` here and a learner whose
          // mode is `off` would see one frame of the default `standard`.
          expect(readFinished, 'the commit must not run before the read resolves').toBe(true);
          expect(record).toBe(STORED_RECORD);
          useAssistanceStore.getState().hydrateAssistance(record);
        },
      }),
    );
    expect(result.status).toBe('ready');
    expect(order).toEqual(['read', 'commit']);
    expect(useAssistanceStore.getState().mode).toBe('gentle');
    expect(useAssistanceStore.getState().dismissalCount).toBe(7);
  });

  it('with no dep supplied at all, the real store is still hydrated', async () => {
    window.localStorage.setItem(
      'knowledge-dungeon:session:assistance',
      JSON.stringify(STORED_RECORD),
    );
    // The three Phase 19 deps are **omitted** from this dep object, so the fallback runs. If the
    // fallback were a no-op this test would see the default `standard` and fail - which is the
    // distinction between "optional dep" and "optional wiring".
    const deps = baseDeps();
    const withoutPhase19: Record<string, unknown> = { ...deps };
    for (const name of ['readAssistance', 'hydrateAssistance', 'setAssistanceSource']) {
      delete withoutPhase19[name];
    }
    await bootstrapApplication(withoutPhase19 as unknown as BootstrapDeps);
    expect(useAssistanceStore.getState().mode).toBe('gentle');
    expect(useAssistanceStore.getState().dismissalCount).toBe(7);
  });

  it('an absent record resets the store to the defaults, and is not a failure', async () => {
    const failures: string[] = [];
    const result: BootstrapResult = await bootstrapApplication(
      baseDeps({
        readAssistance: () => Promise.resolve(null),
        storageWarningFor: () => {
          failures.push('called');
          return '';
        },
      }),
    );
    expect(result.status).toBe('ready');
    expect(result.failures).toEqual([]);
    expect(failures).toEqual([]);
    expect(useAssistanceStore.getState().mode).toBe(DEFAULT_ASSISTANCE_MODE);
    expect(useAssistanceStore.getState().dismissalCount).toBe(0);
  });

  it('a read that rejects degrades to the defaults without failing the bootstrap', async () => {
    const result = await bootstrapApplication(
      baseDeps({ readAssistance: () => Promise.reject(new Error('assistance store unavailable')) }),
    );
    // A learner's assistance record being unreadable must not cost them the whole application.
    expect(result.status).toBe('ready');
    expect(result.failures).toEqual([]);
    expect(useAssistanceStore.getState().mode).toBe(DEFAULT_ASSISTANCE_MODE);
  });

  it('hydration writes nothing: a read is not a write', async () => {
    const before = window.localStorage.length;
    await bootstrapApplication(baseDeps({ readAssistance: () => Promise.resolve(STORED_RECORD) }));
    // The legacy mirror must still hold exactly the one key it held before, byte for byte.
    // Re-writing `updatedAt` on open would mean merely launching the application mutated a
    // learner's record, and a rollback build would see a different document.
    expect(window.localStorage.length).toBe(before);
    expect(window.localStorage.getItem('knowledge-dungeon:session:assistance')).toBeNull();
  });
});

describe('the storage-v2 read path is installed, and only when storage-v2 is selected', () => {
  it('the legacy path installs `null`, so a rollback build reads the legacy key alone', async () => {
    const installed: unknown[] = [];
    await bootstrapApplication(
      baseDeps({
        repository: 'legacy',
        setAssistanceSource: (source) => {
          installed.push(source);
        },
      }),
    );
    expect(installed).toEqual([null]);
  });

  it('the source is installed with a working `list` when storage-v2 is selected', async () => {
    const installed: { list?: () => Promise<unknown[]> }[] = [];
    await bootstrapApplication(
      baseDeps({
        repository: 'v2',
        openRepository: () =>
          Promise.resolve({
            readActiveGenerationId: () => Promise.resolve('gen-1'),
            readRecords: () =>
              Promise.resolve({ records: { assistance: [{ value: STORED_RECORD }] } }),
            close: () => undefined,
          } as never),
        setAssistanceSource: (source) => {
          installed.push(source as { list?: () => Promise<unknown[]> });
        },
        readLegacyState: () => {
          throw new Error('the v2 lane must not read the legacy state');
        },
      }),
    );
    // This bootstrap's migration runs against the fake repository and fails, so the run falls back
    // to the legacy lane - which is the *correct* degradation and is asserted above. The claim
    // here is narrower and is the one the adapter exists for: the installed source lists the
    // generation's assistance records.
    expect(typeof installed[0]?.list).toBe('function');
    expect(await installed[0].list!()).toEqual([STORED_RECORD]);
  });

  it('a source record wins over the legacy key, and a rejecting source falls back to it', async () => {
    // Asserted against the composite read rather than through a whole storage-v2 bootstrap,
    // because the half being claimed here is the read's own rule. A full `v2` run would also be
    // asserting the migration, which is core-logic's and would make this test fail for reasons
    // that have nothing to do with assistance.
    const legacy: AssistanceRecordValue = {
      ...STORED_RECORD,
      mode: 'off',
      dismissalCount: 1,
    };
    window.localStorage.setItem(
      'knowledge-dungeon:session:assistance',
      JSON.stringify(legacy),
    );
    const read = createDefaultBootstrapDeps({ repository: 'legacy' }).readAssistance!;

    setAssistanceSource({
      list: () => Promise.resolve([{ ...STORED_RECORD, mode: 'gentle', dismissalCount: 9 }]),
    });
    const fromSource = await read();
    expect(fromSource!.mode).toBe('gentle');
    expect(fromSource!.dismissalCount).toBe(9);

    // A source that rejects must not cost the learner their stored mode.
    setAssistanceSource({ list: () => Promise.reject(new Error('indexeddb unavailable')) });
    const fromLegacy = await read();
    expect(fromLegacy).toEqual(legacy);
    setAssistanceSource(null);
  });
});

describe('the two no-op deps this stage found, pinned so a fix cannot be silent', () => {
  it('`setDualWriteSink` and `setSessionSource` are currently declared but never reached', async () => {
    // These are **not** this stage's to fix: installing them changes storage-v2 behaviour (dual
    // write reports would start firing, session records would start coming from storage-v2), and
    // doing that inside a Phase 19 DOM commit would change a lane nothing here has tested. They
    // are pinned so that whoever fixes them has to delete this test deliberately.
    //
    // Measured **behaviourally**, with spies, rather than by scanning `deps.x(` in the source. A
    // syntax scan is the wrong instrument: an earlier revision of this file asserted exactly that
    // and caught itself out, because writing the dep as
    // `const h = deps.hydrateAssistance ?? fallback; h(record)` - which wires it just as really -
    // removes the text the scan was looking for. A spy sees the call whether or not the syntax
    // matches.
    const dualWrite = vi.fn();
    const sessionSource = vi.fn();
    await bootstrapApplication(
      baseDeps({ setDualWriteSink: dualWrite, setSessionSource: sessionSource }),
    );
    expect(dualWrite).toHaveBeenCalledTimes(0);
    expect(sessionSource).toHaveBeenCalledTimes(0);
    // And the three Phase 19 deps *are* reached by the same instrument, so the zeros above are
    // measurements rather than a broken spy.
    const assistance = vi.fn();
    const hydrate = vi.fn();
    await bootstrapApplication(
      baseDeps({ setAssistanceSource: assistance, hydrateAssistance: hydrate }),
    );
    expect(assistance).toHaveBeenCalledTimes(1);
    expect(assistance).toHaveBeenCalledWith(null);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('a spy on the store shows the run reaching the real hydrate exactly once', async () => {
    const spy = vi.spyOn(useAssistanceStore.getState(), 'hydrateAssistance');
    try {
      await bootstrapApplication(baseDeps({ readAssistance: () => Promise.resolve(STORED_RECORD) }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(STORED_RECORD);
    } finally {
      spy.mockRestore();
    }
  });
});