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
import type {
  AssistanceMode as PersistedAssistanceMode,
  AssistanceRecordValue,
} from '@/services/persistence/v2/schema';

/**
 * The engine's mode vocabulary and the persistence contract's must be the **same set**.
 *
 * `src/core/assistance/types.ts` declares its own `AssistanceMode` rather than importing the
 * persisted one, because a `src/core/` module must not reach into `src/services/` even for a
 * type - that edge is what eventually becomes a runtime import. The cost of the duplication is
 * a drift risk, so this is where it is paid off: a `src/store/` module *may* import the
 * persistence schema, and this bidirectional assignability check is a **typecheck failure** if
 * either declaration adds, removes, or renames a mode.
 *
 * So "do not add a fourth mode" is enforced by the compiler rather than by review, and it
 * stays enforced without anyone having to remember this file exists.
 *
 * Written with `extends` on both sides rather than an equality helper so the failure mode is
 * a type error at the assignment below, pointing at this line, rather than a runtime check
 * somebody could delete.
 */
type _EngineModeMatchesPersistence = AssistanceMode extends PersistedAssistanceMode
  ? PersistedAssistanceMode extends AssistanceMode
    ? true
    : never
  : never;
const _engineModeMatchesPersistence: _EngineModeMatchesPersistence = true;
void _engineModeMatchesPersistence;

/**
 * The legacy mirror key.
 *
 * A `knowledge-dungeon:session:` key, matching the preferences and shortcuts families, and
 * distinct from every key the Phase 3 migration reads - so adding it cannot change what a
 * migration sees on a device that has never used assistance.
 */
export const ASSISTANCE_STORAGE_KEY = 'knowledge-dungeon:session:assistance';

/** The record id this build writes. Stable, so a rewrite supersedes rather than duplicates. */
export const DEFAULT_ASSISTANCE_ID = 'default';

/** The documented pre-hydration mode. */
export const DEFAULT_ASSISTANCE_MODE: AssistanceMode = 'standard';

/** The documented pre-hydration dismissal count. */
export const DEFAULT_ASSISTANCE_DISMISSAL_COUNT = 0;

// ── Untrusted input ──────────────────────────────────────────────────────────

/**
 * The legacy mirror's payload, as read from `localStorage`.
 *
 * `unknown`-shaped on purpose, exactly like `PersistedPreferencesValue`: this is read from
 * `localStorage` and from a storage-v2 generation, so a stored value can have any type, and
 * the store coerces rather than trusting. Typing it precisely here would assert a guarantee
 * this layer cannot make and would make the coercion look redundant.
 */
export interface PersistedAssistancePayload {
  readonly mode?: unknown;
  readonly signals?: unknown;
  readonly dismissalCount?: unknown;
}

/**
 * Read and normalize one assistance record from untrusted input.
 *
 * Total, and never throws: this value arrives from `localStorage`, a restored `.kdbak`, a
 * `.kdsubject`, or a hand-edited generation, and those are exactly the places where a
 * throwing parse turns a corrupt preference into a blank application.
 *
 * Every field is coerced rather than rejected, and the coercion is a *narrowing* one:
 *
 * - `mode` - an unrecognised value becomes {@link DEFAULT_ASSISTANCE_MODE}, not `'off'`.
 *   That direction matters: a corrupted mode must never be the reason a learner silently
 *   loses every suggestion they had configured, and `'off'` is the one value whose
 *   accidental arrival would be invisible.
 * - `signals` - a non-object becomes `{}`; each kept number is coerced by
 *   {@link mergeAssistanceSignals}, which turns `NaN`, `Infinity`, and negatives into `0` and
 *   preserves keys this build does not know.
 * - `dismissalCount` - `NaN` and negatives become `0`.
 *
 * `null` means "this payload holds nothing usable", and callers treat it as the documented
 * defaults rather than as an error.
 */
export function parseAssistanceRecord(value: unknown): AssistanceRecordValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const mode = isAssistanceMode(record.mode) ? record.mode : DEFAULT_ASSISTANCE_MODE;
  const rawSignals =
    typeof record.signals === 'object' && record.signals !== null && !Array.isArray(record.signals)
      ? (record.signals as AssistanceSignals)
      : {};
  const dismissalCount =
    typeof record.dismissalCount === 'number' && Number.isFinite(record.dismissalCount)
      ? Math.max(0, Math.trunc(record.dismissalCount))
      : DEFAULT_ASSISTANCE_DISMISSAL_COUNT;

  return {
    assistanceId: typeof record.assistanceId === 'string' && record.assistanceId.length > 0
      ? record.assistanceId
      : DEFAULT_ASSISTANCE_ID,
    mode,
    signals: mergeAssistanceSignals(rawSignals, null),
    dismissalCount,
    updatedAt:
      typeof record.updatedAt === 'string' && record.updatedAt.length > 0
        ? record.updatedAt
        : '',
  };
}

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** The legacy repository's read. Synchronous, and `null` when nothing usable is stored. */
export function readPersistedAssistance(): AssistanceRecordValue | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(ASSISTANCE_STORAGE_KEY);
    if (!raw) return null;
    return parseAssistanceRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** The legacy mirror's write. Returns `false` rather than throwing, as every mirror here does. */
function writePersistedAssistance(record: AssistanceRecordValue): boolean {
  if (!hasWindow()) return false;
  try {
    window.localStorage.setItem(ASSISTANCE_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// ── The storage-v2 lane ──────────────────────────────────────────────────────

/**
 * An alternative read path for assistance records, injected by the bootstrap.
 *
 * The same shape as `SessionSource` in `src/services/sessionTracker.ts`, and for the same
 * reason: it keeps `src/store/` free of a hard dependency on the storage-v2 repository, so
 * a test can install a fake without touching module state, and so the default build carries
 * no storage-v2 bytes on this path.
 */
export interface AssistanceSource {
  list(): Promise<AssistanceRecordValue[]>;
}

let assistanceSource: AssistanceSource | null = null;

/**
 * Install the storage-v2 read path. Called once by the application bootstrap.
 *
 * Passing `null` restores legacy-only behaviour, which is what the default build uses and what
 * a rollback build needs.
 */
export function setAssistanceSource(source: AssistanceSource | null): void {
  assistanceSource = source;
}

/** The installed source, or `null` on the legacy path. Test support and diagnostics. */
export function currentAssistanceSource(): AssistanceSource | null {
  return assistanceSource;
}

/**
 * Read the record from the selected repository, or `null`.
 *
 * Mirrors `loadSessionsWithSource`: the legacy key is read first and on its own so the default
 * build is untouched, the injected source's records are layered on top, and a source that
 * rejects falls back to the legacy read rather than losing the learner's mode. De-duplicated
 * by `assistanceId`, with the source winning, because storage-v2 is authoritative on the
 * flagged build.
 */
async function readAssistanceWithSource(): Promise<AssistanceRecordValue | null> {
  const legacy = readPersistedAssistance();
  if (assistanceSource === null) return legacy;
  let fromSource: AssistanceRecordValue | null = null;
  try {
    const listed = await assistanceSource.list();
    // Highest id in code-unit order, so the choice is a property of the data rather than of
    // the order the repository happened to return records in.
    const parsed = listed
      .map(parseAssistanceRecord)
      .filter((record): record is AssistanceRecordValue => record !== null);
    fromSource =
      parsed.length === 0
        ? null
        : parsed.reduce((best, record) =>
            record.assistanceId > best.assistanceId ? record : best,
          );
  } catch {
    return legacy;
  }
  if (fromSource === null) return legacy;
  return fromSource;
}

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

export const useAssistanceStore = create<AssistanceState>((set, get) => ({
  // The documented pre-hydration state. A device with no stored record hydrates to exactly
  // these values, so nothing renders differently before and after hydration.
  mode: DEFAULT_ASSISTANCE_MODE,
  signals: {},
  dismissalCount: DEFAULT_ASSISTANCE_DISMISSAL_COUNT,

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
  assistanceSource = null;
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
