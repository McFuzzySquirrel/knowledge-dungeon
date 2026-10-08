/**
 * The assistance **record**: its untrusted-input reader, the legacy mirror, the storage-v2
 * read seam, and the lazy bridge that lets a build store a record before the store loads.
 *
 * ## Why this module exists, and why it is not `src/store/assistanceStore.ts`
 *
 * Phase 22 carried one finding from Phase 21: on the production default build
 * (`VITE_ADAPTIVE_ASSISTANCE=false`) the assistance store module was dynamically fetched on
 * **every launch**, because `runBootstrap` awaited `loadAssistanceStore()` unconditionally.
 * That fetch is not counted by `check:budget:welcome` (the entry document does not name the
 * chunk) but it is a real per-launch request for a feature the build renders nothing of.
 *
 * Removing it means the bootstrap must be able to **read the persisted record without loading
 * the store module** - the store's own bundle is what the fetch is for. So the persistence
 * primitives the bootstrap genuinely needs (the key, the untrusted-input parser, the legacy
 * mirror read, and the selected-repository seam) live here, in a module with **no `zustand`
 * and no imports of its own beyond the pure `src/core/assistance` vocabulary**. `assistanceStore`
 * imports this module and re-exports its public surface, so every existing caller and test is
 * unchanged; the bootstrap imports this module directly, so a default build never pulls the
 * store chunk at boot.
 *
 * This module is deliberately **not** under `src/store/`, because the Phase 19 boundary gate
 * asserts that `src/store/assistanceStore.ts` is the only `src/store/` module in its runtime
 * closure - the assistance advisory boundary is a property of that closure and this module is
 * a leaf it may reach. See `tests/phase19/assistanceAdvisoryBoundary.test.ts`.
 *
 * ## The lazy bridge, and why a record survives a build that never loaded the store
 *
 * On a build where the store is never loaded at boot, a write can still happen later:
 * `useVillageFishing.onDecide` dynamically imports the store to call `bumpSignals` when a
 * recall is missed, and that action rebuilds the whole record from the store's in-memory
 * state. If the store were loaded for the first time at that moment with its documented
 * pre-hydration defaults (`standard`), a learner who had chosen `off` on the flagged build
 * would have their stored mode **silently overwritten** by a missed recall on the very build
 * whose flag is off. That is the persistence regression this module's bridge exists to make
 * impossible.
 *
 * The bridge is two pieces of module state and one binding:
 *
 * - {@link applyAssistanceRecord} is what the bootstrap calls instead of hydrating the store
 *   directly. It always records the value in {@link pendingAssistanceRecord}, and, **when the
 *   store has loaded and bound itself**, it hands the value to the store's real
 *   `hydrateAssistance` action through {@link bindAssistanceStoreHydration}.
 * - The store reads {@link pendingAssistanceRecord} for its initial state, so a store that
 *   loads *after* the bootstrap finds the persisted record already there - the same record it
 *   would have been hydrated with, one module load later.
 *
 * The binding is what keeps the unit-test and flagged-build paths byte-identical to the old
 * unconditional hydration: there the store is already loaded, so `applyAssistanceRecord`
 * reaches it synchronously, exactly as the removed `assistanceStore()...hydrateAssistance`
 * default did.
 *
 * ## The throw-rather-than-skip contract, preserved
 *
 * The Phase 18 defect this area was written against was a dep that was *present* and was a
 * **no-op**. Nothing here is a no-op: {@link applyAssistanceRecord} always records the value,
 * and the store always consumes what was recorded. A build where the record is neither
 * hydrated nor pending is not reachable through these functions.
 */
import {
  isAssistanceMode,
  mergeAssistanceSignals,
  type AssistanceMode,
  type AssistanceSignals,
} from '@/core/assistance/types';
import type {
  AssistanceMode as PersistedAssistanceMode,
  AssistanceRecordValue,
} from '@/services/persistence/v2/schema';

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

/**
 * The store's mode vocabulary and the persistence contract's must be the **same set**.
 *
 * `src/core/assistance/types.ts` declares its own `AssistanceMode` rather than importing the
 * persisted one, because a `src/core/` module must not reach into `src/services/` even for a
 * type - that edge is what eventually becomes a runtime import. This bidirectional
 * assignability check makes the drift risk a **typecheck failure**: if either declaration
 * adds, removes, or renames a mode, the assignment below stops compiling.
 */
type _EngineModeMatchesPersistence = AssistanceMode extends PersistedAssistanceMode
  ? PersistedAssistanceMode extends AssistanceMode
    ? true
    : never
  : never;
const _engineModeMatchesPersistence: _EngineModeMatchesPersistence = true;
void _engineModeMatchesPersistence;

// ── Untrusted input ──────────────────────────────────────────────────────────

/**
 * The legacy mirror's payload, as read from `localStorage`.
 *
 * `unknown`-shaped on purpose, exactly like `PersistedPreferencesValue`: this is read from
 * `localStorage` and from a storage-v2 generation, so a stored value can have any type, and
 * the coercion below is what makes a corrupt record a defaulted one rather than a blank
 * application.
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
export function writePersistedAssistance(record: AssistanceRecordValue): boolean {
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
 *
 * This is the **single** composite read. It used to be restated in `src/application/bootstrap.ts`
 * as `readAssistanceRecord`, because the bootstrap could not call a private store function
 * without moving a write into its read phase; the Phase 19 comment that recorded that
 * duplication named making it shared as the follow-up. This module is that follow-up, and both
 * callers now use this function.
 */
export async function readAssistanceWithSource(): Promise<AssistanceRecordValue | null> {
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
    // A source that rejects must not cost the learner their stored mode.
    return legacy;
  }
  // Storage-v2 is authoritative on the flagged build, so its record wins.
  return fromSource ?? legacy;
}

// ── The lazy-hydration bridge ────────────────────────────────────────────────

/**
 * The record the bootstrap read, held until a store consumes it.
 *
 * `null` is a real value here ("nothing stored"), not "unset": the store's documented defaults
 * are what a `null` hydrates to, and the bootstrap always calls {@link applyAssistanceRecord},
 * so a store that loads late still finds the bootstrap's own answer.
 */
let pendingRecord: AssistanceRecordValue | null = null;

/**
 * The live store's `hydrateAssistance`, bound by `assistanceStore.ts` at its module load.
 *
 * `null` until the store module has loaded. Once bound, every subsequent
 * {@link applyAssistanceRecord} reaches the store synchronously, exactly as the flagged build
 * and the pre-Phase-22 unconditional hydration did.
 */
let boundHydrate: ((record: AssistanceRecordValue | null) => void) | null = null;

/**
 * Bind the live store's hydration action. Called once by `assistanceStore.ts`.
 *
 * A callback rather than a store import: this module must stay free of `zustand` so the
 * bootstrap can use it without the store chunk, and a store-to-here import edge is the wrong
 * direction for the same reason.
 */
export function bindAssistanceStoreHydration(
  hydrate: (record: AssistanceRecordValue | null) => void,
): void {
  boundHydrate = hydrate;
}

/**
 * The record the bootstrap read, for a store that is loading after the bootstrap.
 *
 * A store's initial state is created once, so this is only consulted at that moment; every
 * later value reaches the store through {@link applyAssistanceRecord}.
 */
export function pendingAssistanceRecord(): AssistanceRecordValue | null {
  return pendingRecord;
}

/**
 * Publish the bootstrap's read: hold it, and hydrate the store when one is live.
 *
 * Always records. When a store is bound - the flagged build, and every unit test, both of
 * which import the store - it also applies, so the observable behaviour is unchanged there.
 * When no store is bound (the default build, where the store is not fetched at boot) the value
 * is held for the store to read at its own load, which is what keeps a stored mode from being
 * overwritten by the first later write.
 */
export function applyAssistanceRecord(record: AssistanceRecordValue | null): void {
  pendingRecord = record;
  if (boundHydrate !== null) boundHydrate(record);
}

/** Whether a live store has bound itself to this bridge. Test support and diagnostics. */
export function assistanceStoreBound(): boolean {
  return boundHydrate !== null;
}

/**
 * Reset the module state a test must not inherit.
 *
 * The hydration binding is deliberately **not** cleared: a store binds itself once at module
 * load, and a reset that unbound it would make every later `applyAssistanceRecord` a silent
 * no-op - the exact failure this module exists to prevent.
 */
export function __resetAssistanceRecordForTests(): void {
  assistanceSource = null;
  pendingRecord = null;
}
