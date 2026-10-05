/**
 * Phase 19: the assistance store's persistence, on both repository lanes.
 *
 * ## The four properties this file is responsible for
 *
 * 1. **Untrusted input.** An assistance record arrives from `localStorage`, a restored
 *    `.kdbak`, a `.kdsubject`, or a hand-edited generation. The Phase 18 lesson is that
 *    `validateAssistanceRecord` accepts `NaN` in `signals` because `typeof NaN === 'number'`,
 *    so a total coercion is this store's job, not the validator's.
 * 2. **The legacy lane reports nothing.** Phase 18 established that a flag-off device must
 *    record no dual-write report, because a report about a repository that is not in play is a
 *    report about nothing - and `tests/phase4/exitCriteria2And3.test.ts` asserts the silence.
 * 3. **The storage-v2 lane is keyed, serialized, and reports once.** A whole-store publish
 *    makes two concurrent writes drop one another; `fireAndForget(writeThrough(...))` counts a
 *    `primary-failed` twice; both were real defects and both are avoided here.
 * 4. **Hydration never writes.** A read that turns into a write rewrites every record's
 *    `updatedAt` on every application open.
 *
 * ## The non-vacuity guard
 *
 * `describe('the lanes are distinguishable')` asserts that a legacy-lane write produces **no**
 * dual-write report while a storage-v2-lane write produces one, and that a storage-v2 write
 * reaches the generation. Without it, "the legacy lane reports nothing" would be satisfied by a
 * store that never wrote at all.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ASSISTANCE_SIGNAL_KEYS } from '@/core/assistance/types';
import {
  ASSISTANCE_STORAGE_KEY,
  DEFAULT_ASSISTANCE_ID,
  DEFAULT_ASSISTANCE_MODE,
  __resetAssistanceStoreForTests,
  parseAssistanceRecord,
  pendingAssistanceWrites,
  readPersistedAssistance,
  selectAssistanceDismissalSummary,
  selectAssistanceRecord,
  selectResolvedSignals,
  setAssistanceSource,
  useAssistanceStore,
  type AssistanceSource,
} from '@/store/assistanceStore';
import {
  dualWriteReports,
  clearDualWriteReports,
} from '@/services/persistence/v2/dualWrite';
import {
  resetRepositorySelection,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';

type Repository = Awaited<ReturnType<typeof openStorageV2Repository>>;

let repository: Repository | null = null;
let counter = 0;

async function openRepository(): Promise<Repository> {
  counter += 1;
  return openStorageV2Repository({
    databaseName: `p19-store-${process.pid}-${counter}`,
    clock: fixedClock('2026-03-15T12:00:00.000Z'),
    idFactory: createDeterministicIdFactory(`p19-store-${counter}`),
  });
}

/** An {@link AssistanceSource} over the real generation, so the read lane is exercised. */
function generationSource(repo: Repository): AssistanceSource {
  return {
    list: async () => {
      const generationId = await repo.readActiveGenerationId();
      if (generationId === null) return [];
      const snapshot = await repo.readRecords(generationId);
      return snapshot.records.assistance.map((entry) => entry.value);
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  clearDualWriteReports();
  setAssistanceSource(null);
  __resetAssistanceStoreForTests();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  resetRepositorySelection();
  setAssistanceSource(null);
  window.localStorage.clear();
  __resetAssistanceStoreForTests();
});

describe('the pre-hydration state is the documented default', () => {
  it('a device with nothing stored starts at standard mode, no signals, and no dismissals', () => {
    expect(useAssistanceStore.getState().mode).toBe(DEFAULT_ASSISTANCE_MODE);
    expect(useAssistanceStore.getState().signals).toEqual({});
    expect(useAssistanceStore.getState().dismissalCount).toBe(0);
    // And a legacy read of an empty device is `null`, not a zero-valued record.
    expect(readPersistedAssistance()).toBeNull();
  });

  it('hydrating with null resets to the defaults without writing', () => {
    useAssistanceStore.getState().dismissSuggestion();
    useAssistanceStore.getState().hydrateAssistance(null);
    expect(useAssistanceStore.getState().mode).toBe(DEFAULT_ASSISTANCE_MODE);
    expect(useAssistanceStore.getState().signals).toEqual({});
    expect(useAssistanceStore.getState().dismissalCount).toBe(0);
  });
});

describe('untrusted input is coerced, never trusted and never thrown on', () => {
  it('rejects the shapes that are not records at all', () => {
    for (const value of [null, undefined, 42, 'a string', true, [], [{ assistanceId: 'x' }]]) {
      expect(parseAssistanceRecord(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('an unrecognised mode becomes standard, never off', () => {
    // The direction of the coercion matters more than the coercion. A corrupted mode that fell
    // back to `'off'` would silently remove every suggestion a learner had configured, and the
    // learner would have no way to tell that from the feature being broken.
    for (const mode of ['OFF', 'Off', 'on', 'strong', 'gentler', '', 0, null, undefined, {}]) {
      const parsed = parseAssistanceRecord({ assistanceId: 'default', mode });
      expect(parsed, String(mode)).not.toBeNull();
      expect(parsed?.mode, `mode ${String(mode)} fell back to off`).toBe('standard');
    }
    // And a *recognised* mode survives verbatim, including `'off'`.
    for (const mode of ['off', 'gentle', 'standard'] as const) {
      expect(parseAssistanceRecord({ assistanceId: 'default', mode })?.mode).toBe(mode);
    }
  });

  it('a non-object signals map becomes empty, and every kept count is coerced', () => {
    for (const signals of ['nope', 42, [], null, true]) {
      const parsed = parseAssistanceRecord({ assistanceId: 'default', mode: 'standard', signals });
      expect(parsed?.signals, JSON.stringify(signals)).toEqual({});
    }
    const parsed = parseAssistanceRecord({
      assistanceId: 'default',
      mode: 'standard',
      signals: {
        noteValidationFailure: Number.NaN,
        lowRecallRating: Number.POSITIVE_INFINITY,
        repeatedDraft: -8,
        fishingRecallMiss: 4.9,
        'future.key': 'not a number',
      },
      dismissalCount: Number.NaN,
    });
    expect(parsed?.signals).toEqual({
      noteValidationFailure: 0,
      lowRecallRating: 0,
      repeatedDraft: 0,
      fishingRecallMiss: 4,
      'future.key': 0,
    });
    expect(parsed?.dismissalCount).toBe(0);
  });

  it('a corrupt legacy key reads as nothing stored rather than throwing', () => {
    for (const raw of ['not json', '[1,2,3]', '"a string"', '{"mode": {}}', 'null']) {
      window.localStorage.setItem(ASSISTANCE_STORAGE_KEY, raw);
      const record = readPersistedAssistance();
      expect(record, raw).not.toBeUndefined();
      // Either `null` (unusable) or the documented default mode - never a throw.
      if (record !== null) expect(record.mode).toBe('standard');
    }
  });

  it('an unknown signal key survives a hydrate-and-persist round trip', () => {
    // The "preserve unknown app-owned fields" rule, applied to a flat map. A record written by a
    // newer build must not lose its keys on this build.
    const record = parseAssistanceRecord({
      assistanceId: 'default',
      mode: 'gentle',
      signals: { 'future.build.signal': 11 },
      dismissalCount: 2,
    }) as AssistanceRecordValue;
    useAssistanceStore.getState().hydrateAssistance(record);
    useAssistanceStore.getState().dismissSuggestion();
    const after = readPersistedAssistance();
    expect(after?.signals['future.build.signal']).toBe(11);
    expect(after?.dismissalCount).toBe(3);
    // The known keys this device never recorded stay **absent**, not zero. `mergeAssistanceSignals`
    // emits a key only when the base or the patch supplies a value, because writing `0` for a key
    // nobody recorded would make a sparse record dense on its first save - and then a `.kdbak`
    // checksum would move for a device whose assistance state had not changed.
    // Only the key the device actually recorded survives. `dismissSuggestion` changes
    // `dismissalCount`, not `signals`, so it adds no key at all - which is the point: a dismissal
    // is not a signal and must never become one.
    expect(Object.keys(after?.signals ?? {}).sort()).toEqual(['future.build.signal']);
    expect(after?.signals['future.build.signal']).toBe(11);
  });

  it('an unknown assistance id survives hydration rather than being replaced', () => {
    useAssistanceStore.getState().hydrateAssistance({
      assistanceId: 'from-a-newer-build',
      mode: 'off',
      signals: {},
      dismissalCount: 4,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(useAssistanceStore.getState().mode).toBe('off');
    expect(useAssistanceStore.getState().dismissalCount).toBe(4);
    // The selector projects the store's own state, using this build's id, because a *write* is
    // this build's own record - and `putRecords` merges by id, so the newer build's record
    // survives untouched rather than being overwritten. Asserted below in the storage lane.
    expect(selectAssistanceRecord(useAssistanceStore.getState(), '2026-03-15T12:00:00.000Z').assistanceId).toBe(
      DEFAULT_ASSISTANCE_ID,
    );
  });
});

describe('the legacy lane writes synchronously and reports nothing', () => {
  it('a mode change lands in localStorage and produces no dual-write report', async () => {
    useAssistanceStore.getState().setMode('gentle');
    // Synchronous: the key is already populated on the line after the call, with no await.
    const raw = window.localStorage.getItem(ASSISTANCE_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ mode: 'gentle', assistanceId: 'default' });
    await pendingAssistanceWrites();
    // Phase 18's property, kept: a device on the legacy repository reports nothing at all.
    expect(dualWriteReports()).toEqual([]);
  });

  it('dismissals and signal bumps land synchronously, and neither reports', async () => {
    useAssistanceStore.getState().dismissSuggestion();
    useAssistanceStore.getState().bumpSignals({ repeatedDraft: 3, noteValidationFailure: 2 });
    const after = readPersistedAssistance();
    expect(after?.dismissalCount).toBe(1);
    expect(after?.signals.repeatedDraft).toBe(3);
    expect(after?.signals.noteValidationFailure).toBe(2);
    await pendingAssistanceWrites();
    expect(dualWriteReports()).toEqual([]);
  });

  it('setting the mode it already has writes nothing', async () => {
    useAssistanceStore.getState().setMode('off');
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).not.toBeNull();
    const before = window.localStorage.getItem(ASSISTANCE_STORAGE_KEY);
    useAssistanceStore.getState().setMode('off');
    useAssistanceStore.getState().setMode('off');
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).toBe(before);
    expect(dualWriteReports()).toEqual([]);
  });

  it('an unrecognised mode is refused rather than coerced', () => {
    const before = useAssistanceStore.getState().mode;
    useAssistanceStore.getState().setMode('extremely-helpful' as never);
    expect(useAssistanceStore.getState().mode).toBe(before);
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).toBeNull();
  });

  it('a zero-delta or non-numeric bump writes nothing', () => {
    useAssistanceStore.getState().bumpSignals({ repeatedDraft: 0 });
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).toBeNull();
    useAssistanceStore.getState().bumpSignals({ repeatedDraft: Number.NaN });
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).toBeNull();
    useAssistanceStore.getState().bumpSignals(null as never);
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).toBeNull();
  });
});

describe('the storage-v2 lane is keyed, serialized, and reports once per write', () => {
  it('a write reaches the generation and reports exactly one written outcome', async () => {
    repository = await openRepository();
    selectStorageV2Repository(repository);
    clearDualWriteReports();
    useAssistanceStore.getState().setMode('off');
    await pendingAssistanceWrites();
    const generationId = await repository.readActiveGenerationId();
    expect(generationId).not.toBeNull();
    const snapshot = await repository.readRecords(generationId as string);
    expect(snapshot.records.assistance).toHaveLength(1);
    expect(snapshot.records.assistance[0].value.mode).toBe('off');
    // And the legacy mirror was written too, first - the rollback lane.
    expect(readPersistedAssistance()?.mode).toBe('off');
    // One report, not two: `fireAndForget(writeThrough(...))` would produce the `written` report
    // twice, which is the composition `dualWrite.ts` documents as wrong.
    expect(dualWriteReports()).toEqual([
      { sequence: 1, operation: 'assistance', outcome: 'written', code: null },
    ]);
  });

  it('a write that does not change anything produces no record and no report', async () => {
    repository = await openRepository();
    selectStorageV2Repository(repository);
    clearDualWriteReports();
    useAssistanceStore.getState().setMode(DEFAULT_ASSISTANCE_MODE);
    useAssistanceStore.getState().clearDismissals();
    await pendingAssistanceWrites();
    const generationId = await repository.readActiveGenerationId();
    expect(generationId).toBeNull();
    expect(dualWriteReports()).toEqual([]);
  });

  it('fifty mode changes in one tick converge on the last one, as one record', async () => {
    // The serialization requirement. Fifty unsynchronized writes would each build their payload
    // from their own read, and the last write to land would not be the last one chosen.
    repository = await openRepository();
    selectStorageV2Repository(repository);
    clearDualWriteReports();
    // Consecutive repeats are deliberate: `setMode` is idempotent, so a repeat writes nothing and
    // the report count below is a *measurement* of idempotence rather than a guess at it. With a
    // cycle of strictly alternating modes all 50 calls are transitions and the count is 50 - which
    // is correct and would make the assertion below unfailable.
    const order = [
      'off', 'off', 'gentle', 'gentle', 'gentle', 'standard', 'standard', 'off', 'off',
      'standard', 'standard', 'standard', 'gentle', 'gentle', 'off', 'off',
    ] as const;
    for (let index = 0; index < 50; index += 1) {
      useAssistanceStore.getState().setMode(order[index % order.length]);
    }
    await pendingAssistanceWrites();
    const expected = order[(50 - 1) % order.length];
    expect(useAssistanceStore.getState().mode).toBe(expected);
    const generationId = (await repository.readActiveGenerationId()) as string;
    const snapshot = await repository.readRecords(generationId);
    // One record, not fifty: `putRecords` merges by id and the queue serializes the payloads.
    expect(snapshot.records.assistance).toHaveLength(1);
    expect(snapshot.records.assistance[0].value.mode).toBe(expected);
    // Exactly the transitions that changed the mode wrote anything: 50 calls, 16-cycle, so the
    // number of *transitions* is computed here from the input rather than hard-coded, and the
    // assertion is that the store wrote that many and no more.
    let transitions = 0;
    let previous: string | null = null;
    for (let index = 0; index < 50; index += 1) {
      const mode = order[index % order.length];
      if (mode !== previous) transitions += 1;
      previous = mode;
    }
    const writes = dualWriteReports().filter((entry) => entry.outcome === 'written');
    expect(writes.length).toBe(transitions);
    expect(transitions).toBeLessThan(50);
    expect(transitions).toBeGreaterThan(10);
  });

  it('a generation written by a newer build keeps its record when this build writes', async () => {
    repository = await openRepository();
    selectStorageV2Repository(repository);
    const generationId = (await repository.readActiveGenerationId()) ?? null;
    const { ensureInitialGeneration, INITIAL_GENERATION_ID } = await import(
      '@/services/persistence/v2/appState'
    );
    const active =
      generationId ??
      (await ensureInitialGeneration(repository, {
        generationId: INITIAL_GENERATION_ID,
        now: '2026-03-15T12:00:00.000Z',
      }));
    await repository.putRecords(active, {
      assistance: [
        {
          assistanceId: 'from-a-newer-build',
          mode: 'off',
          signals: { 'future.key': 3 },
          dismissalCount: 9,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    useAssistanceStore.getState().setMode('gentle');
    await pendingAssistanceWrites();
    const snapshot = await repository.readRecords(active);
    // Two records: the newer build's, untouched, and this build's own.
    expect(snapshot.records.assistance.map((entry) => entry.value.assistanceId).sort()).toEqual([
      'default',
      'from-a-newer-build',
    ]);
    const foreign = snapshot.records.assistance.find((entry) => entry.value.assistanceId === 'from-a-newer-build');
    expect(foreign?.value).toEqual({
      assistanceId: 'from-a-newer-build',
      mode: 'off',
      signals: { 'future.key': 3 },
      dismissalCount: 9,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('a failing primary is reported once, as a primary failure, and the mirror still holds', async () => {
    repository = await openRepository();
    selectStorageV2Repository(repository);
    clearDualWriteReports();
    // Close the repository underneath the store: `putRecords` will reject.
    repository.close();
    useAssistanceStore.getState().setMode('gentle');
    await pendingAssistanceWrites();
    // The learner's choice applies in this session even though the durable write did not land -
    // the property `persist` documents, and the reason a store action cannot await.
    expect(useAssistanceStore.getState().mode).toBe('gentle');
    expect(readPersistedAssistance()?.mode).toBe('gentle');
    const reports = dualWriteReports();
    expect(reports.filter((entry) => entry.outcome === 'primary-failed')).toHaveLength(1);
    expect(reports.filter((entry) => entry.outcome === 'mirror-failed')).toHaveLength(0);
  });
});

describe('the read lanes', () => {
  it('with no source installed, hydration reads the legacy key', async () => {
    window.localStorage.setItem(
      ASSISTANCE_STORAGE_KEY,
      JSON.stringify({
        assistanceId: 'default',
        mode: 'gentle',
        signals: { repeatedDraft: 5 },
        dismissalCount: 3,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    await useAssistanceStore.getState().hydrateAssistanceFromRepository();
    expect(useAssistanceStore.getState().mode).toBe('gentle');
    expect(useAssistanceStore.getState().dismissalCount).toBe(3);
    expect(useAssistanceStore.getState().signals.repeatedDraft).toBe(5);
  });

  it('with a source installed, the generation wins over the legacy key', async () => {
    repository = await openRepository();
    selectStorageV2Repository(repository);
    const { ensureInitialGeneration, INITIAL_GENERATION_ID } = await import(
      '@/services/persistence/v2/appState'
    );
    const generationId = await ensureInitialGeneration(repository, {
      generationId: INITIAL_GENERATION_ID,
      now: '2026-03-15T12:00:00.000Z',
    });
    await repository.putRecords(generationId, {
      assistance: [
        {
          assistanceId: 'default',
          mode: 'off',
          signals: { repeatedDraft: 8 },
          dismissalCount: 7,
          updatedAt: '2026-03-10T00:00:00.000Z',
        },
      ],
    });
    window.localStorage.setItem(
      ASSISTANCE_STORAGE_KEY,
      JSON.stringify({
        assistanceId: 'default',
        mode: 'gentle',
        signals: {},
        dismissalCount: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    setAssistanceSource(generationSource(repository));
    await useAssistanceStore.getState().hydrateAssistanceFromRepository();
    // Storage-v2 is authoritative on the flagged build.
    expect(useAssistanceStore.getState().mode).toBe('off');
    expect(useAssistanceStore.getState().dismissalCount).toBe(7);
    expect(useAssistanceStore.getState().signals.repeatedDraft).toBe(8);
  });

  it('a source that rejects falls back to the legacy read rather than losing the mode', async () => {
    window.localStorage.setItem(
      ASSISTANCE_STORAGE_KEY,
      JSON.stringify({
        assistanceId: 'default',
        mode: 'gentle',
        signals: {},
        dismissalCount: 2,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    setAssistanceSource({
      list: async () => {
        throw new Error('synthetic source failure');
      },
    });
    await useAssistanceStore.getState().hydrateAssistanceFromRepository();
    expect(useAssistanceStore.getState().mode).toBe('gentle');
    expect(useAssistanceStore.getState().dismissalCount).toBe(2);
  });

  it('hydration never writes, on either lane', async () => {
    repository = await openRepository();
    selectStorageV2Repository(repository);
    clearDualWriteReports();
    const { ensureInitialGeneration, INITIAL_GENERATION_ID } = await import(
      '@/services/persistence/v2/appState'
    );
    const generationId = await ensureInitialGeneration(repository, {
      generationId: INITIAL_GENERATION_ID,
      now: '2026-03-15T12:00:00.000Z',
    });
    await repository.putRecords(generationId, {
      assistance: [
        {
          assistanceId: 'default',
          mode: 'gentle',
          signals: { repeatedDraft: 4 },
          dismissalCount: 1,
          updatedAt: '2026-03-10T00:00:00.000Z',
        },
      ],
    });
    window.localStorage.setItem(
      ASSISTANCE_STORAGE_KEY,
      JSON.stringify({
        assistanceId: 'default',
        mode: 'gentle',
        signals: { repeatedDraft: 4 },
        dismissalCount: 1,
        updatedAt: '2026-03-10T00:00:00.000Z',
      }),
    );
    setAssistanceSource(generationSource(repository));
    const before = JSON.stringify(await repository.readRecords(generationId));
    await useAssistanceStore.getState().hydrateAssistanceFromRepository();
    await pendingAssistanceWrites();
    // Merely opening the application must not rewrite every record's `updatedAt`.
    expect(JSON.stringify(await repository.readRecords(generationId))).toBe(before);
    expect(dualWriteReports()).toEqual([]);
  });
});

describe('the selectors a settings surface reads', () => {
  it('the record selector projects the exact persisted shape', () => {
    useAssistanceStore.getState().setMode('gentle');
    useAssistanceStore.getState().bumpSignals({ lowRecallRating: 2 });
    useAssistanceStore.getState().dismissSuggestion();
    const record = selectAssistanceRecord(useAssistanceStore.getState(), '2026-03-15T12:00:00.000Z');
    expect(Object.keys(record).sort()).toEqual([
      'assistanceId',
      'dismissalCount',
      'mode',
      'signals',
      'updatedAt',
    ]);
    expect(record).toMatchObject({
      assistanceId: 'default',
      mode: 'gentle',
      dismissalCount: 1,
      updatedAt: '2026-03-15T12:00:00.000Z',
    });
    // And the signals object is a **copy**: mutating the returned record must not reach the
    // store, or a caller that "tidied up" a record could change persisted state.
    const mutated = record.signals as Record<string, number>;
    mutated.repeatedDraft = 999;
    // Nothing in the store was named `repeatedDraft` in this test, so the key is absent and
    // absent is the correct answer - the point is that the mutation did not *create* it.
    expect((useAssistanceStore.getState().signals as Record<string, number>).repeatedDraft).toBeUndefined();
    expect(useAssistanceStore.getState().signals.lowRecallRating).toBe(2);
  });

  it('the resolved-signal selector coerces and reports every known key', () => {
    useAssistanceStore.getState().bumpSignals({ repeatedDraft: 2 });
    useAssistanceStore.getState().hydrateAssistance({
      assistanceId: 'default',
      mode: 'standard',
      signals: { noteValidationFailure: Number.NaN, 'unknown.key': 5 },
      dismissalCount: 0,
      updatedAt: '',
    });
    const resolved = selectResolvedSignals(useAssistanceStore.getState());
    // Every known key present, so a settings row does not have to handle a missing field.
    expect(Object.keys(resolved).sort()).toEqual([...ASSISTANCE_SIGNAL_KEYS].sort());
    for (const key of ASSISTANCE_SIGNAL_KEYS) {
      expect(Number.isInteger(resolved[key]), key).toBe(true);
      expect(resolved[key], key).toBeGreaterThanOrEqual(0);
    }
    expect(resolved.noteValidationFailure).toBe(0);
    // Unknown keys are **dropped by this selector** - unlike in `bumpSignals`, where they are
    // preserved. Deliberate: this is a read for display, and an unknown key has no label.
    expect((resolved as Record<string, unknown>)['unknown.key']).toBeUndefined();
    expect((useAssistanceStore.getState().signals as Record<string, unknown>)['unknown.key']).toBe(5);
  });

  it('the dismissal summary reports the count and states that it changes nothing', () => {
    for (let index = 0; index < 7; index += 1) useAssistanceStore.getState().dismissSuggestion();
    expect(selectAssistanceDismissalSummary(useAssistanceStore.getState())).toEqual({
      dismissalCount: 7,
      affectsSuggestions: false,
    });
    // A corrupt count cannot produce a negative or fractional summary.
    useAssistanceStore.setState({ dismissalCount: Number.NaN });
    expect(selectAssistanceDismissalSummary(useAssistanceStore.getState()).dismissalCount).toBe(0);
    useAssistanceStore.setState({ dismissalCount: -3 });
    expect(selectAssistanceDismissalSummary(useAssistanceStore.getState()).dismissalCount).toBe(0);
    useAssistanceStore.setState({ dismissalCount: 2.9 });
    expect(selectAssistanceDismissalSummary(useAssistanceStore.getState()).dismissalCount).toBe(2);
  });

  it('clearing dismissals resets the count and is a no-op when it is already zero', async () => {
    useAssistanceStore.getState().dismissSuggestion();
    useAssistanceStore.getState().dismissSuggestion();
    expect(useAssistanceStore.getState().dismissalCount).toBe(2);
    useAssistanceStore.getState().clearDismissals();
    expect(useAssistanceStore.getState().dismissalCount).toBe(0);
    // Second clear writes nothing at all.
    await pendingAssistanceWrites();
    const before = window.localStorage.getItem(ASSISTANCE_STORAGE_KEY);
    useAssistanceStore.getState().clearDismissals();
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY)).toBe(before);
  });
});

describe('the lanes are distinguishable, so neither assertion above is vacuous', () => {
  it('a legacy write produces no report and a storage-v2 write produces exactly one', async () => {
    // The guard for the whole file. "The legacy lane reports nothing" would also be satisfied by
    // a store that never writes, and "the storage-v2 lane writes" by a lane that only writes
    // locally. This asserts both halves in one place.
    clearDualWriteReports();
    useAssistanceStore.getState().setMode('off');
    await pendingAssistanceWrites();
    expect(dualWriteReports(), 'the legacy lane reported').toEqual([]);
    expect(window.localStorage.getItem(ASSISTANCE_STORAGE_KEY), 'the legacy lane wrote nothing').not.toBeNull();

    repository = await openRepository();
    selectStorageV2Repository(repository);
    clearDualWriteReports();
    useAssistanceStore.getState().setMode('gentle');
    await pendingAssistanceWrites();
    const generationId = (await repository.readActiveGenerationId()) as string;
    expect((await repository.readRecords(generationId)).records.assistance, 'the generation holds nothing').toHaveLength(1);
    expect(dualWriteReports().filter((entry) => entry.operation === 'assistance')).toEqual([
      { sequence: 1, operation: 'assistance', outcome: 'written', code: null },
    ]);
  });
});
