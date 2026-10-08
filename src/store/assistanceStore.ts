/**
 * The assistance store: mode, aggregate signals, and the dismissal count.
 *
 * ## What this store owns, and what it deliberately does not
 *
 * It owns exactly the three fields `AssistanceRecordValue` has - `mode`, `signals`, and
 * `dismissalCount` - plus the hydration and write path for them. It owns **no** suggestion.
 * Ranking is {@link import('@/core/assistance/assistanceEngine').rankAssistance}, a pure
 * function, and this store is not one of its inputs. That split is the store's most important
 * property and it is why:
 *
 * - a learner changing their assistance mode cannot change what is *stored*, because nothing
 *   about a suggestion is stored;
 * - this module's runtime closure contains no store it could write through, so there is no
 *   code path from a mode change - or a dismissal - to a progression, review, or validation
 *   write. `tests/phase19/assistanceAdvisoryBoundary.test.ts` walks the import graph and
 *   asserts that closure, and a second gate snapshots every relevant store and every
 *   storage-v2 record before and after a dismissal and requires byte equality.
 *
 * ## `dismissalCount` is recorded and never read back
 *
 * The plan requires dismissal to have "no punitive effects", and the persistence contract
 * gives one aggregate number with no per-suggestion identity. The two facts together have
 * one honest implementation, which is the one here: **`dismissalCount` is written and
 * displayed, and nothing else in the application reads it.**
 *
 * Specifically:
 *
 * - it is **not** an input to `rankAssistance`. The engine's input type does not have the
 *   field, so "no punitive effect" is a type-level fact rather than a code-review request.
 * - it is **not** used to suppress, throttle, or deprioritise any suggestion. There is no
 *   "you have dismissed N, so here is less" path, because any such path would make
 *   dismissal a punishment and the plan forbids it.
 * - it is **not** an input to the signal map. A dismissal does not raise
 *   `repeatedDraft` or any other counter, so it cannot make a later suggestion stronger
 *   either.
 *
 * It is surfaced in exactly one place: {@link selectAssistanceDismissalSummary}, whose whole
 * job is to let the settings screen say "you have dismissed 7 suggestions" as a fact about
 * the learner. The plan asks for dismissal to be non-punitive; it does not ask for the count
 * to be hidden, and a hidden count would be the more suspicious choice - a learner who
 * cannot see that their dismissals are counted cannot tell whether the count is being used
 * against them.
 *
 * ## The per-suggestion question, answered rather than ignored
 *
 * The missing piece is real: with one aggregate number, dismissing "add a Summary heading"
 * cannot be distinguished from dismissing "navigate back to room 7". So *if* per-suggestion
 * memory is ever wanted, it cannot live in this record without a change, and the change has a
 * price worth stating now rather than discovering later:
 *
 * **The minimal change** is one additive field on `AssistanceRecordValue`, e.g.
 * `dismissedSuggestionIds: string[]`, plus a second key under `signals` named by
 * `suggestionId`. The engine would need a non-punitive rule for reading it, and the
 * only non-punitive rule available is "a dismissed suggestion is not shown again until the
 * underlying condition changes" - which is a *suppression* and therefore still touches what
 * the learner is offered.
 *
 * **The migration cost is not zero.** `validateAssistanceRecord` gains a field, so every
 * validator caller and every archive reader that round-trips the record is in scope
 * (`subjectBackup.ts` and `archiveValidation.ts` both call it). `idRemapping.ts` must decide
 * what happens to a suppression list when it rewrites ids - it currently carries `signals`
 * verbatim, which would silently carry a stale suppression for a room that no longer exists.
 * And `.kdbak` / `.kdsubject` format versions may need to move, because a suppression list is
 * per-subject in meaning while the record is device-global in shape.
 *
 * **Recommendation: do not do it in Phase 19.** The plan's requirement is non-punitive
 * dismissal, which a count-and-forget satisfies completely and a suppression list does not
 * (it introduces the first mechanism by which what a learner sees depends on what they
 * dismissed). Recorded here so the next person to want it starts from the trade-off instead
 * of from the idea.
 *
 * ## The persistence path is `sessionTracker`'s, unchanged in shape
 *
 * - **Legacy repository** (the shipping default, `VITE_STORAGE_REPOSITORY=legacy`): a
 *   synchronous `localStorage` write, and **no dual-write report at all**. Phase 18
 *   established that property because `tests/phase4/exitCriteria2And3.test.ts` asserts a
 *   flag-off device reports nothing, and a report about a repository that is not in play is
 *   a report about nothing. This store keeps it.
 * - **Storage-v2 selected**: the legacy key is written first and synchronously - that is
 *   the rollback mirror and the historical ordering a rollback build reads - and the
 *   generation publish follows through `writeThroughInBackground`, which is the composition
 *   `dualWrite.ts` documents as correct. `fireAndForget(writeThrough(...))` is deliberately
 *   **not** used: it counts a `primary-failed` twice and the pre-Phase-18 code used it.
 * - The generation adapter is reached by **dynamic `import`**, so a default build that never
 *   selects storage-v2 does not carry its bytes. This is the same lazy-adapter shape
 *   `preferencesStore.ts` uses, and it is one of the two reasons this store is safe against
 *   the Welcome initial-payload budget.
 *
 * ## Phase 22 moved the record half out, and the store now starts from it
 *
 * The primitives above - the key, the parser, the legacy mirror, and the read seam - now live in
 * `@/services/assistance/assistanceRecord`, and this module re-exports them unchanged. The reason
 * is a Phase 21 finding: `runBootstrap` awaited `loadAssistanceStore()` on **every** build, so
 * the production default build fetched `assistanceStore-*.js` on every launch for a feature it
 * renders nothing of. The bootstrap now reads the record through the record module - which has no
 * `zustand` - and this store is fetched only when a build actually uses it: the flagged build
 * preloads it, and a default build loads it on the first write (`bumpSignals`).
 *
 * Because that first write rebuilds the whole record from in-memory state, this store reads the
 * record module's pending record **into its initial state**. Without it, a store created by that
 * first write would start from the pre-hydration `standard` and overwrite a learner's stored
 * `off`. See `tests/unit/assistanceLateLoadPersistence.test.ts` for the guard, and the record
 * module's header for the bridge.
 *
 * ## Nothing here reads a clock to decide anything
 *
 * `updatedAt` is the one timestamp this module writes, it comes from an injected `now()`
 * that defaults to `Date.now().toISOString()` **for the record envelope only**, and no
 * suggestion, mode, or signal decision reads it. The engine takes its own injected `nowIso`.
 */
import { create } from 'zustand';

import {
  ASSISTANCE_SIGNAL_KEYS,
  isAssistanceMode,
  mergeAssistanceSignals,
  resolveAssistanceSignals,
  type AssistanceMode,
  type AssistanceSignalKey,
  type AssistanceSignals,
  type ResolvedAssistanceSignals,
} from '@/core/assistance/types';
import { writeThrough } from '@/services/persistence/v2/dualWrite';
import {
  currentStorageV2Repository,
  isStorageV2Selected,
} from '@/services/persistence/v2/repositorySelection';
import type { AssistanceRecordValue } from '@/services/persistence/v2/schema';
import {
  ASSISTANCE_STORAGE_KEY,
  DEFAULT_ASSISTANCE_DISMISSAL_COUNT,
  DEFAULT_ASSISTANCE_ID,
  DEFAULT_ASSISTANCE_MODE,
  __resetAssistanceRecordForTests,
  bindAssistanceStoreHydration,
  currentAssistanceSource,
  parseAssistanceRecord,
  pendingAssistanceRecord,
  readAssistanceWithSource,
  readPersistedAssistance,
  setAssistanceSource,
  writePersistedAssistance,
} from '@/services/assistance/assistanceRecord';
import type {
  AssistanceSource,
  PersistedAssistancePayload,
} from '@/services/assistance/assistanceRecord';

/**
 * The public persistence surface, re-exported for the callers and tests that have always
 * imported it from here.
 *
 * Phase 22 moved the implementations to `@/services/assistance/assistanceRecord` so the
 * application bootstrap can read a record **without fetching this module** (the fetch was the
 * per-launch request on the production default build). The names are unchanged, so every
 * existing import keeps working; this module is now the store half of the contract, and the
 * record module is the persistence half. See that module's header for the bridge that keeps a
 * stored mode from being overwritten when the store loads after the bootstrap.
 */
export {
  ASSISTANCE_STORAGE_KEY,
  DEFAULT_ASSISTANCE_DISMISSAL_COUNT,
  DEFAULT_ASSISTANCE_ID,
  DEFAULT_ASSISTANCE_MODE,
  currentAssistanceSource,
  parseAssistanceRecord,
  readPersistedAssistance,
  setAssistanceSource,
};
export type { AssistanceSource, PersistedAssistancePayload };

/**
 * Publish the record to the storage-v2 generation, keyed by its own `assistanceId`.
 *
 * **One record per write**, never the whole store - the same rule
 * `publishSessionToActiveGeneration` follows and for the same reason: publishing a whole
 * collection makes two concurrent writes publish two collections and the second drops the
 * first. The repository's `putRecords` merges by record id, so a concurrent pair of mode
 * changes leaves one record, and which mode that is decided by the store's own serialized
 * write queue below rather than by transaction ordering.
 */
async function publishToStorageV2(record: AssistanceRecordValue): Promise<void> {
  const repository = currentStorageV2Repository();
  if (repository === null) return;
  const adapter = await import('@/services/persistence/v2/appRepository');
  await adapter.publishAssistanceToActiveGeneration(repository, record, record.updatedAt);
}

/**
 * The serialized write queue.
 *
 * Mirrors `enqueueSessionWrite` in `src/services/sessionTracker.ts`. The store updates its
 * in-memory state synchronously, so two `setMode` calls in one tick would otherwise both
 * build their publish payload from their own read and the second could land first - leaving
 * storage-v2 holding a mode the learner never chose. Serializing the *payload construction*
 * and the publish is the fix, and the in-memory record is the transaction boundary here,
 * exactly as it is in `progressionStore`.
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueAssistanceWrite(task: () => Promise<void>): void {
  writeQueue = writeQueue.then(task, task);
}

/** The pending write queue, so a test can await durability. */
export function pendingAssistanceWrites(): Promise<void> {
  return writeQueue;
}

/**
 * Write the record to the selected repository.
 *
 * Synchronous by contract - a zustand action cannot await - and lazy, because the storage-v2
 * adapter is not part of the default artifact.
 *
 * The legacy lane writes and **reports nothing**. The storage-v2 lane writes the legacy mirror
 * first and synchronously (it is the rollback mirror, and the historical legacy-first ordering
 * is what a rollback build reads), then publishes through the serialized queue.
 *
 * ## `writeThrough` inside the queue, not `writeThroughInBackground` inside it
 *
 * `writeThroughInBackground` starts the publish and returns `void`, which is right for a store
 * action that must not await and wrong for a queue documented as "so a test can await
 * durability". Wrapping it in the queue that way made the queue resolve the moment the publish
 * was *started*, so `await pendingAssistanceWrites()` returned before any record had landed - and
 * a reload test written against it would have passed against a device that had lost the write.
 * Found by `tests/phase19/assistanceStore.test.ts`, which awaited the queue and then read the
 * generation and found it empty.
 *
 * So the queue awaits {@link writeThrough} itself, whose promise covers the publish, and the
 * rejection is caught here. The report count is unchanged: `writeThrough` records
 * `primary-failed` itself and rethrows, so keeping the `writeThroughInBackground` wrapper as
 * well would have been exactly the double-counting that wrapper exists to prevent.
 *
 * A failure becomes a sanitized dual-write report and never a rejected promise, because a mode
 * the learner just chose must apply in the current session even if the write did not land.
 */
function persist(record: AssistanceRecordValue): void {
  if (!isStorageV2Selected()) {
    // The default, shipping repository. No report, for the reason on
    // `sessionPersistencePort.write`: a report about a repository that is not in play is a
    // report about nothing, and `tests/phase4/exitCriteria2And3.test.ts` asserts silence here.
    writePersistedAssistance(record);
    return;
  }
  const legacyOk = writePersistedAssistance(record);
  enqueueAssistanceWrite(async () => {
    try {
      await writeThrough({
        operation: 'assistance',
        primary: () => publishToStorageV2(record),
        // The mirror already happened above, before the primary, so it cannot fail here.
        // Reported as a success so the operation is not counted twice.
        mirror: () => legacyOk,
      });
    } catch {
      // Already recorded as `primary-failed` by `writeThrough`. Swallowed so the queue never
      // rejects and so a later write is not skipped by a chain that died here.
    }
  });
}

// ── State ────────────────────────────────────────────────────────────────────

/** The assistance summary a settings surface shows about dismissal. */
export interface AssistanceDismissalSummary {
  /** How many suggestions this device has recorded dismissing. A count. Never negative. */
  readonly dismissalCount: number;
  /**
   * The one sentence's worth of meaning, stated here so a surface cannot editorialise it:
   * dismissal is recorded and displayed, and **nothing in the application reads this number
   * to change what a learner is offered.**
   */
  readonly affectsSuggestions: false;
}

export interface AssistanceState {
  /** The mode. The pre-hydration value is {@link DEFAULT_ASSISTANCE_MODE}. */
  mode: AssistanceMode;
  /** The persisted signal map, unknown keys preserved. */
  signals: AssistanceSignals;
  /** How many dismissals this device has recorded. */
  dismissalCount: number;
  /**
   * Apply a persisted record. Called once by the application bootstrap, before the first
   * render. Passing `null` resets to the documented defaults.
   */
  hydrateAssistance: (record: AssistanceRecordValue | null) => void;
  /**
   * Read the record from the selected repository and apply it.
   *
   * Asynchronous because the storage-v2 lane is asynchronous, and separate from
   * {@link AssistanceState.hydrateAssistance} so a host can hydrate from a payload it already
   * holds without awaiting. A read that rejects leaves the current state untouched.
   */
  hydrateAssistanceFromRepository: () => Promise<void>;
  /**
   * Change the mode.
   *
   * Idempotent: setting the mode it already has writes nothing, so a re-render, a StrictMode
   * double invocation, and a retried click all converge on one record.
   */
  setMode: (mode: AssistanceMode) => void;
  /**
   * Add to the aggregate signal counters.
   *
   * `deltas` names only the keys being changed; every other key of the stored map - including
   * a key a future build wrote - is carried through untouched by {@link mergeAssistanceSignals}.
   *
   * **This is a counter, and a counter is not idempotent.** A retried call adds twice. That is
   * acceptable here for one stated reason: the only thing these numbers do is raise a
   * suggestion's priority, and no suggestion can write anything
   * (`tests/phase19/assistanceAdvisoryBoundary.test.ts` pins the import graph). So a
   * double-counted hesitation produces a slightly stronger cue and cannot produce a wrong
   * outcome - whereas making it idempotent would require a per-event identity, and the
   * persisted contract has room for exactly one number per key.
   *
   * Non-integer, negative, and non-finite deltas are coerced by {@link mergeAssistanceSignals}
   * rather than rejected, and the resulting counts are clamped at `0`.
   */
  bumpSignals: (deltas: Partial<Record<AssistanceSignalKey, number>>) => void;
  /**
   * Record that the learner dismissed a suggestion.
   *
   * Takes **no suggestion argument**, deliberately. The only use of the parameter would be to
   * build a per-suggestion suppression key, and that is the mechanism that would make
   * dismissal punitive - see the module header for the trade-off and the migration cost. By
   * taking nothing, the non-punitive property is visible in the signature: there is nowhere
   * for a suppression to be stored even if a future author wanted one.
   */
  dismissSuggestion: () => void;
  /**
   * Reset the dismissal counter to zero.
   *
   * An explicit, voluntary act, and the reason the store can show the count at all: a learner
   * who wants the record gone has one button. It changes nothing about what is offered, before
   * or after.
   */
  clearDismissals: () => void;
}

/** The ISO timestamp for a record envelope. Injected so a test can pin it. */
export type AssistanceNow = () => string;

const defaultNow: AssistanceNow = () => new Date().toISOString();

function buildRecord(state: Pick<AssistanceState, 'mode' | 'signals' | 'dismissalCount'>, now: string): AssistanceRecordValue {
  return {
    assistanceId: DEFAULT_ASSISTANCE_ID,
    mode: state.mode,
    // Copied, so the store's own `signals` object cannot be mutated by a later `set` in a way
    // that changes a record already handed to the writer.
    signals: { ...state.signals },
    dismissalCount: state.dismissalCount,
    updatedAt: now,
  };
}

/**
 * The state a store created after the bootstrap starts from.
 *
 * On the flagged build the store is loaded before the bootstrap reads anything, so the pending
 * record is `null` and this is the documented pre-hydration default; the bootstrap then
 * hydrates it. On the default build the store is **not** fetched at boot, so when a consumer
 * finally loads it - a missed-recall `bumpSignals`, for instance - the record the bootstrap
 * read is waiting here. Reading it at creation is what makes the first later *write* rebuild
 * the record from the learner's stored mode rather than from the pre-hydration default, which
 * is the persistence regression the record module's bridge exists to prevent.
 */
function initialStateFromPending(): Pick<AssistanceState, 'mode' | 'signals' | 'dismissalCount'> {
  const pending = pendingAssistanceRecord();
  const normalized = pending === null ? null : parseAssistanceRecord(pending);
  return normalized === null
    ? {
        mode: DEFAULT_ASSISTANCE_MODE,
        signals: {},
        dismissalCount: DEFAULT_ASSISTANCE_DISMISSAL_COUNT,
      }
    : {
        mode: normalized.mode,
        signals: normalized.signals,
        dismissalCount: normalized.dismissalCount,
      };
}

export const useAssistanceStore = create<AssistanceState>((set, get) => ({
  // The documented pre-hydration state, or the bootstrap's pending record when this store is
  // loading after the bootstrap. A device with no stored record gets exactly these defaults, so
  // nothing renders differently before and after hydration.
  ...initialStateFromPending(),

  hydrateAssistance(record) {
    if (record === null) {
      set({
        mode: DEFAULT_ASSISTANCE_MODE,
        signals: {},
        dismissalCount: DEFAULT_ASSISTANCE_DISMISSAL_COUNT,
      });
      return;
    }
    const normalized = parseAssistanceRecord(record);
    if (normalized === null) {
      set({
        mode: DEFAULT_ASSISTANCE_MODE,
        signals: {},
        dismissalCount: DEFAULT_ASSISTANCE_DISMISSAL_COUNT,
      });
      return;
    }
    // Hydration **writes nothing**. A read must not turn into a write, or merely opening the
    // application would rewrite every assistance record's `updatedAt`.
    set({
      mode: normalized.mode,
      signals: normalized.signals,
      dismissalCount: normalized.dismissalCount,
    });
  },

  async hydrateAssistanceFromRepository() {
    const record = await readAssistanceWithSource();
    get().hydrateAssistance(record);
  },

  setMode(mode) {
    if (!isAssistanceMode(mode)) return;
    if (get().mode === mode) return;
    set((state) => {
      const next = { ...state, mode };
      persist(buildRecord(next, defaultNow()));
      return { mode };
    });
  },

  bumpSignals(deltas) {
    if (deltas === null || typeof deltas !== 'object') return;
    // The deltas are resolved against the **current resolved values** and the *sum* is what
    // goes into the merge.
    //
    // It is tempting to pass the deltas straight to `mergeAssistanceSignals`, which takes a map
    // of absolute values - and that is exactly what the first implementation did, so
    // `bumpSignals({ repeatedDraft: 5 })` followed by `bumpSignals({ repeatedDraft: 2 })` left
    // `repeatedDraft` at `2` instead of `7`. A counter that assigns is not a counter, and the
    // symptom is a cue that gets *weaker* as a learner re-saves a failing note, which is the
    // exact opposite of what the signal is for. Found by
    // `tests/phase19/assistanceAdvisoryBoundary.test.ts`, which bumps twice and expects a sum.
    const current = resolveAssistanceSignals(get().signals);
    const patch: Partial<Record<AssistanceSignalKey, number>> = {};
    let changed = false;
    for (const key of ASSISTANCE_SIGNAL_KEYS) {
      const delta = (deltas as Record<string, unknown>)[key];
      if (typeof delta !== 'number' || !Number.isFinite(delta)) continue;
      const truncated = Math.trunc(delta);
      if (truncated === 0) continue;
      patch[key] = current[key] + truncated;
      changed = true;
    }
    if (!changed) return;
    set((state) => {
      const signals = mergeAssistanceSignals(state.signals, patch);
      const next = { ...state, signals };
      persist(buildRecord(next, defaultNow()));
      return { signals };
    });
  },

  dismissSuggestion() {
    set((state) => {
      const dismissalCount = state.dismissalCount + 1;
      const next = { ...state, dismissalCount };
      persist(buildRecord(next, defaultNow()));
      return { dismissalCount };
    });
  },

  clearDismissals() {
    if (get().dismissalCount === 0) return;
    set((state) => {
      const next = { ...state, dismissalCount: 0 };
      persist(buildRecord(next, defaultNow()));
      return { dismissalCount: 0 };
    });
  },
}));

/**
 * Bind this store into the record module's bridge.
 *
 * The bootstrap runs `readAssistance` and then `applyAssistanceRecord`; when this store has
 * already loaded (the flagged build preloads it, and every unit test imports it statically),
 * the bridge reaches this binding and hydrates synchronously - byte-identical to the
 * pre-Phase-22 `assistanceStore()...hydrateAssistance` default. When the store loads *after*
 * the bootstrap, {@link initialStateFromPending} has already consumed the pending record, so
 * the binding is what keeps every later `applyAssistanceRecord` from being a no-op.
 */
bindAssistanceStoreHydration((record) => {
  useAssistanceStore.getState().hydrateAssistance(record);
});

/**
 * The live record for a write, for a caller that wants to inspect rather than set it.
 *
 * The store's in-memory state is the authority for the current session; this projects it into
 * the exact persisted shape so a test - or a Data Center export - never has to re-derive the
 * field set and get it subtly wrong.
 */
export function selectAssistanceRecord(
  state: Pick<AssistanceState, 'mode' | 'signals' | 'dismissalCount'>,
  now: string = defaultNow(),
): AssistanceRecordValue {
  return buildRecord(state, now);
}

/**
 * The four known signals, coerced.
 *
 * The selector a surface uses when it wants "how many times has this happened" without
 * handling `NaN` from a restored record itself. Unknown keys are dropped here **on purpose**,
 * unlike in {@link AssistanceState.bumpSignals} where they are preserved: this is a read for
 * display, and a key this build does not understand has no label to display it under.
 */
export function selectResolvedSignals(state: Pick<AssistanceState, 'signals'>): ResolvedAssistanceSignals {
  return resolveAssistanceSignals(state.signals);
}

/**
 * The dismissal summary, for the settings screen.
 *
 * See the module header for why this number is visible and unread. `affectsSuggestions` is a
 * literal `false` rather than a boolean read from somewhere, so a surface that renders it
 * cannot drift from the property, and a test can assert the type.
 */
export function selectAssistanceDismissalSummary(
  state: Pick<AssistanceState, 'dismissalCount'>,
): AssistanceDismissalSummary {
  const count =
    typeof state.dismissalCount === 'number' && Number.isFinite(state.dismissalCount)
      ? Math.max(0, Math.trunc(state.dismissalCount))
      : 0;
  return { dismissalCount: count, affectsSuggestions: false };
}

/** Reset module-level state. Test teardown only. */
export function __resetAssistanceStoreForTests(): void {
  __resetAssistanceRecordForTests();
  writeQueue = Promise.resolve();
  useAssistanceStore.setState({
    mode: DEFAULT_ASSISTANCE_MODE,
    signals: {},
    dismissalCount: DEFAULT_ASSISTANCE_DISMISSAL_COUNT,
  });
}

/** Exported so a unit test can exercise the persistence primitives without the store. */
export const __testing = {
  ASSISTANCE_STORAGE_KEY,
  DEFAULT_ASSISTANCE_ID,
  DEFAULT_ASSISTANCE_MODE,
  readPersistedAssistance,
  parseAssistanceRecord,
  buildRecord,
};
