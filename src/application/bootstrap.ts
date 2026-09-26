/**
 * The explicit, asynchronous application bootstrap.
 *
 * Before Phase 4, four modules read `localStorage` at *module load* - the
 * progression, preferences, and shortcut stores and the session tracker - and
 * `App.tsx` then did an ad-hoc `listSubjectIds()` plus `loadSubject()` in an
 * effect. That had three problems this module removes:
 *
 * 1. A store's initial value depended on import order rather than on an awaited
 *    read, so a store imported before storage was available started empty and
 *    stayed empty.
 * 2. Hydration was not awaited before the first render, so the first paint could
 *    show an empty shell over real data.
 * 3. There was no single point that knew which repository was in use, so "read
 *    everything, then commit" - the property that makes a half-hydrated app
 *    impossible - was not expressible.
 *
 * The contract here is:
 *
 * - **Read, then commit.** Every value is read into a {@link BootstrapPlan}
 *   first; nothing touches a store until all of it has been read. A read failure
 *   therefore leaves every store on its documented default rather than some
 *   hydrated and some not.
 * - **Driven by the selected repository.** The `legacy` repository reads the keys
 *   the current build reads; the `v2` repository reads the active generation and,
 *   when there is legacy data to move, migrates it first.
 * - **Hydration never writes.** No store action here persists anything, so
 *   booting the app cannot rewrite a subject, create a backup record, or move the
 *   active-subject pointer. The legacy generation a migration read is still
 *   byte-identical afterwards, which is what makes a rollback read the same data.
 *
 * Renderer-neutral: this module imports stores, not a renderer. Every store
 * effect is injected (with defaults that read the real stores), following
 * `subjectActivation.ts`, so the whole bootstrap is unit-testable without React.
 */

import type { StorageRepository } from '@/config/runtimeConfig';
import { runtimeConfig } from '@/config/featureFlags';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import {
  getActiveSubjectId,
  listSubjectIds,
  loadSubjectSnapshot,
} from '@/services/persistence/subjectPersistence';
import { getStorageThreshold } from '@/services/errorRecovery';
import { setSessionSource, type SessionSource } from '@/services/sessionTracker';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useShortcutStore } from '@/store/shortcutStore';
import { useSubjectStore } from '@/store/subjectStore';
import {
  EMPTY_APP_PERSISTED_STATE,
  INITIAL_GENERATION_ID,
  MIGRATION_GENERATION_ID,
  ensureInitialGeneration,
  readAppStateFromLegacy,
  readAppStateFromStorageV2,
  type AppPersistedState,
} from '@/services/persistence/v2/appState';
// The storage-v2 implementation - the repository, the migration, and the state
// model - is loaded **only** when `VITE_STORAGE_REPOSITORY=v2`. With the flag off
// the default build does not contain these modules at all, so "the flag off writes
// nothing to storage-v2" is a property of the artifact rather than of a runtime
// check. `appState`, `dualWrite`, and `repositorySelection` are imported
// statically because their own imports are type-only and they cost nothing.
import {
  setDualWriteSink,
  summarizeDualWriteReports,
  type DualWriteReport,
  type DualWriteSink,
} from '@/services/persistence/v2/dualWrite';
import {
  selectLegacyRepository,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { MigrationState } from '@/services/persistence/v2/migrationState';

// ── The migration state contract, as the application publishes it ──────────

/**
 * The migration types, re-exported so no other module has to name a storage-v2
 * path.
 *
 * `tests/migrations/qaHardening.test.ts` allows exactly one file outside
 * `services/persistence/v2/` to reference a storage-v2 module, and this is it -
 * the gate's own stated reason is "there is exactly one place in the application
 * that knows storage-v2 exists". A screen that wants to render a migration state
 * therefore takes its types from here, which is also the right layering: a
 * component reads the application's contract rather than a persistence internal.
 *
 * Every export below is type-only, so this adds no runtime edge, no cycle, and no
 * bytes to the default build.
 */
export type {
  MigrationNextAction,
  MigrationPreviewState,
  MigrationRecoveryRequiredState,
  MigrationRunningState,
  MigrationSucceededState,
  MigrationState,
  MigrationStateCounts,
  MigrationStateKind,
} from '@/services/persistence/v2/migrationState';
/**
 * The attachment report shape, for the one thing a screen needs from it: the
 * fixed union of external-only reason codes, so a screen's copy table is
 * type-checked against the core's set rather than drifting from it.
 */
export type { ExternalOnlyAttachmentReport } from '@/services/persistence/v2/schema';

// ── Result shape ──────────────────────────────────────────────────────────

export type BootstrapStatus = 'ready' | 'degraded';

/** Why the app is showing defaults instead of hydrated state. A code, no content. */
export type BootstrapFailureCode =
  | 'STORAGE_V2_UNAVAILABLE'
  | 'MIGRATION_RECOVERY_REQUIRED'
  | 'LEGACY_READ_FAILED'
  | 'STORAGE_V2_READ_FAILED';

export interface BootstrapResult {
  readonly status: BootstrapStatus;
  readonly repository: StorageRepository;
  /** `null` unless a migration ran. */
  readonly migration: MigrationState | null;
  /**
   * Re-run the staged migration, or `null` when the state offers no such action.
   *
   * The callable half of `MigrationState.nextActions`: a recovery screen binds its
   * button to the code the state named and calls this, so the core owns which
   * retries are safe instead of each screen deciding for itself. Returns `null`
   * for any state whose `nextActions` do not include `retry-migration` - a
   * migrated device, a running migration, and a device whose store is gone.
   */
  readonly retryMigration: (() => Promise<MigrationState | null>) | null;
  /** Codes only. */
  readonly failures: readonly BootstrapFailureCode[];
  /** Storage-pressure warning, or `null`. Mirrors the pre-phase banner text. */
  readonly storageWarning: string | null;
  /** `true` when a subject was loaded and then released, as the pre-phase did. */
  readonly releasedActiveSubject: boolean;
}

// ── Injected effects ──────────────────────────────────────────────────────

export interface BootstrapDeps {
  /** The repository to route through, from `VITE_STORAGE_REPOSITORY`. */
  readonly repository: StorageRepository;
  /** Injected so a test never opens a real browser database. */
  readonly openRepository: () => Promise<StorageV2Repository>;
  /**
   * The generation id the migration stages. Defaults to
   * {@link MIGRATION_GENERATION_ID}, and is injectable so a test can use a
   * database-specific id.
   */
  readonly generationId: string;
  readonly now: string;
  /** Reads the legacy state, the way the pre-phase build did. */
  readonly readLegacyState: () => AppPersistedState;
  readonly readActiveSubjectId: () => string | null;
  readonly listSubjectIds: () => Promise<string[]>;
  readonly loadSubjectSnapshot: (subjectId: string) => Promise<SubjectSnapshot | null>;
  readonly getStorageThreshold: () => 'ok' | 'warn' | 'critical';
  readonly storageWarningFor: (level: 'warn' | 'critical') => string;
  readonly setDualWriteSink: (sink: DualWriteSink | null) => void;
  readonly setSessionSource: (source: SessionSource | null) => void;

  // Store effects.
  readonly hydratePreferences: (persisted: AppPersistedState['preferences']) => void;
  readonly hydrateShortcuts: (persisted: NonNullable<AppPersistedState['shortcuts']> | null) => void;
  readonly hydrateProgression: (payload: unknown) => void;
  readonly setSubjectSnapshot: (snapshot: SubjectSnapshot | null) => void;
  readonly setSessionActiveSubjectId: (subjectId: string | null) => void;
  readonly setProgressionActiveSubject: (subjectId: string | null) => void;
}

const STORAGE_WARNINGS: Record<'warn' | 'critical', string> = {
  warn: 'Storage space is running low. Consider exporting your data for backup.',
  critical:
    'Storage space is critically low. Please export your data and remove unused subjects to prevent data loss.',
};

/**
 * The real store effects, read through `getState()` at call time.
 *
 * `now` is read once per bootstrap rather than per store, so every record a
 * single run writes carries the same timestamp.
 */
export function createDefaultBootstrapDeps(
  options: { repository: StorageRepository; generationId?: string } = {
    repository: runtimeConfig.storageRepository,
  },
): BootstrapDeps {
  return {
    repository: options.repository,
    // Lazy: the repository module is in the same chunk as the rest of storage-v2
    // and is fetched only when the flag asks for it.
    openRepository: async () => (await import('@/services/persistence/v2/repository')).openStorageV2Repository(),
    generationId: options.generationId ?? MIGRATION_GENERATION_ID,
    now: new Date().toISOString(),
    readLegacyState: readAppStateFromLegacy,
    readActiveSubjectId: getActiveSubjectId,
    listSubjectIds,
    loadSubjectSnapshot,
    getStorageThreshold,
    storageWarningFor: (level) => STORAGE_WARNINGS[level],
    setDualWriteSink,
    setSessionSource,
    hydratePreferences: (persisted) =>
      usePreferencesStore.getState().hydratePreferences(persisted),
    hydrateShortcuts: (persisted) => useShortcutStore.getState().hydrateShortcuts(persisted),
    hydrateProgression: (payload) => useProgressionStore.getState().hydrateProgression(payload),
    setSubjectSnapshot: (snapshot) => useSubjectStore.getState().hydrateSnapshot(snapshot),
    setSessionActiveSubjectId: (subjectId) =>
      useSessionStore.getState().setActiveSubjectId(subjectId),
    setProgressionActiveSubject: (subjectId) =>
      useProgressionStore.getState().setActiveSubject(subjectId),
  };
}

// ── The bootstrap ─────────────────────────────────────────────────────────

/** The state the bootstrap commits, assembled before any store is touched. */
interface BootstrapPlan {
  readonly state: AppPersistedState;
  readonly activeSubjectId: string | null;
  /** The subject the device was last in, when one was loaded. */
  readonly releasedSubject: SubjectSnapshot | null;
}

/**
 * Run the bootstrap once and return its result.
 *
 * Idempotent by memoization: `main.tsx` awaits it before the first render and
 * `App` awaits the same promise, so the stores are hydrated exactly once and a
 * React StrictMode double-invoke cannot run a migration twice.
 */
let pending: Promise<BootstrapResult> | null = null;

export function bootstrapApplication(deps?: BootstrapDeps): Promise<BootstrapResult> {
  if (deps === undefined) {
    pending ??= runBootstrap(createDefaultBootstrapDeps()).catch((error: unknown) =>
      degradedResult('legacy', 'LEGACY_READ_FAILED', error),
    );
    return pending;
  }
  return runBootstrap(deps).catch((error: unknown) => degradedResult(deps.repository, 'LEGACY_READ_FAILED', error));
}

/** The in-flight or completed bootstrap, or `null` before it starts. */
export function pendingBootstrap(): Promise<BootstrapResult> | null {
  return pending;
}

/** Forget the memoized bootstrap. Test support. */
export function resetBootstrap(): void {
  pending = null;
}

function degradedResult(
  repository: StorageRepository,
  code: BootstrapFailureCode,
  error: unknown,
): BootstrapResult {
  // The failure is a code, never a message: a bootstrap failure must not be able
  // to carry a subject name, a note, or a URL into a log.
  void error;
  return {
    status: 'degraded',
    repository,
    migration: null,
    // A degraded start that never reached a migration has nothing to retry.
    retryMigration: null,
    failures: [code],
    storageWarning: null,
    releasedActiveSubject: false,
  };
}

async function runBootstrap(deps: BootstrapDeps): Promise<BootstrapResult> {
  const failures: BootstrapFailureCode[] = [];
  let migration: MigrationState | null = null;
  let repository: StorageRepository = 'legacy';
  let handle: StorageV2Repository | null = null;

  // ── Phase A: decide the repository, and migrate if storage-v2 is selected ──
  if (deps.repository === 'v2') {
    repository = 'v2';
    try {
      handle = await deps.openRepository();
      selectStorageV2Repository(handle);
      migration = await runLegacyMigration(handle, deps, failures);
      if (migration.kind === 'recovery-required') {
        // A failed migration leaves the legacy generation authoritative, so the
        // app has to *read* from it too. Staying on an empty storage-v2 would show
        // the learner a blank Welcome screen for data that is still right there -
        // the one outcome a recovery state must never cause.
        selectLegacyRepository();
        handle.close();
        handle = null;
        repository = 'legacy';
      }
    } catch (error) {
      // Storage-v2 could not be opened at all. The legacy generation is still
      // authoritative and the app still works, so this is a degraded start rather
      // than a blank screen - and the legacy repository is selected so nothing
      // downstream tries to talk to a repository that is not there.
      void error;
      failures.push('STORAGE_V2_UNAVAILABLE');
      handle?.close();
      handle = null;
      repository = 'legacy';
      selectLegacyRepository();
    }
  } else {
    selectLegacyRepository();
  }

  // ── Phase B: read everything, touching no store ──
  const plan = await readPlan(deps, handle, failures);

  // ── Phase C: commit in one synchronous step ──
  commitPlan(deps, plan);

  // ── Phase D: post-hydration app state that is not persisted data ──
  const threshold = deps.getStorageThreshold();
  const storageWarning = threshold === 'ok' ? null : deps.storageWarningFor(threshold);

  return {
    status: failures.length > 0 ? 'degraded' : 'ready',
    repository,
    migration,
    retryMigration: buildRetryAffordance(migration, deps),
    failures,
    storageWarning,
    releasedActiveSubject: plan.releasedSubject !== null,
  };
}

/**
 * The retry affordance for a migration state, or `null` when it offers none.
 *
 * Re-opens the repository rather than reusing the bootstrap's handle, because a
 * `recovery-required` bootstrap closed that handle and fell back to the legacy
 * repository - which is what keeps a failed migration showing the learner their
 * data instead of a blank screen. The retry therefore starts from a clean handle
 * and only re-selects storage-v2 once the new run has actually succeeded, so a
 * second failed retry degrades to the same safe state rather than stranding the
 * app on an empty repository.
 */
function buildRetryAffordance(
  migration: MigrationState | null,
  deps: BootstrapDeps,
): (() => Promise<MigrationState | null>) | null {
  if (migration === null) return null;
  if (!migration.nextActions.includes('retry-migration')) return null;
  return async () => {
    const failures: BootstrapFailureCode[] = [];
    let handle: StorageV2Repository;
    try {
      handle = await deps.openRepository();
    } catch {
      // The store is still unreachable. The legacy repository stays selected, so
      // nothing about the learner's data changes.
      return null;
    }
    try {
      selectStorageV2Repository(handle);
      const state = await runLegacyMigration(handle, deps, failures);
      if (state.kind === 'migrated' || state.kind === 'partial') {
        return state;
      }
      // Still not migrated: hand the app back to the legacy repository exactly as
      // the failed bootstrap did, and report the new state.
      selectLegacyRepository();
      handle.close();
      return state;
    } catch {
      selectLegacyRepository();
      handle.close();
      return null;
    }
  };
}

/**
 * Migrate the legacy device into a new generation, when there is anything to move.
 *
 * The application entry point always passes {@link NO_MIGRATION_SEAMS}-equivalent
 * options - no `onStage`, no `forceValidationFailure` - so there is no reachable
 * failure-injection seam in the application path. A `recovery-required` outcome is
 * recorded as a failure code and leaves the legacy generation authoritative, which
 * is exactly what the plan requires of a failed migration.
 */
async function runLegacyMigration(
  repository: StorageV2Repository,
  deps: BootstrapDeps,
  failures: BootstrapFailureCode[],
): Promise<MigrationState> {
  const [{ migrateLegacyState }, { classifyMigrationReport, assertMigrationStatusReachable }] =
    await Promise.all([
      import('@/services/persistence/v2/migrations'),
      import('@/services/persistence/v2/migrationState'),
    ]);
  const outcome = await migrateLegacyState({
    repository,
    generationId: deps.generationId,
    now: deps.now,
    clock: { now: () => deps.now },
  });
  const state: MigrationState = classifyMigrationReport(outcome.report);
  if (state.kind === 'recovery-required') failures.push('MIGRATION_RECOVERY_REQUIRED');
  if (state.kind === 'migrated' || state.kind === 'partial') {
    // The migration already refuses to report success for a generation that is
    // still only `staged`, and this guard is the belt to that braces: it reads
    // what the repository actually holds, so a future change cannot reintroduce
    // an outcome that tells a caller the device is migrated when its data is
    // unreachable. A throw degrades the bootstrap rather than rendering success.
    const staged = await repository.readGeneration(deps.generationId);
    assertMigrationStatusReachable(outcome.report, staged?.descriptor?.status ?? null);
  }
  if (state.kind === 'no-source-data') {
    // Nothing to migrate: make the device writable so the first subject save has
    // a generation to land in.
    await ensureInitialGeneration(repository, {
      generationId: INITIAL_GENERATION_ID,
      now: deps.now,
    });
  }
  return state;
}

/**
 * Read every value the stores need, without writing to a store.
 *
 * A read failure yields {@link EMPTY_APP_PERSISTED_STATE} for the whole plan, so
 * the commit is all-or-nothing and the app can never be left with, say, a
 * hydrated progression store and an empty subject store.
 */
async function readPlan(
  deps: BootstrapDeps,
  handle: StorageV2Repository | null,
  failures: BootstrapFailureCode[],
): Promise<BootstrapPlan> {
  const activeSubjectId = deps.readActiveSubjectId();
  let state: AppPersistedState;
  let stateReadable = true;
  try {
    if (handle !== null) {
      state = await readAppStateFromStorageV2(handle, { activeSubjectId });
    } else {
      state = deps.readLegacyState();
    }
  } catch (error) {
    void error;
    failures.push(handle === null ? 'LEGACY_READ_FAILED' : 'STORAGE_V2_READ_FAILED');
    state = { ...EMPTY_APP_PERSISTED_STATE, activeSubjectId };
    stateReadable = false;
  }

  // The subject list the Welcome screen needs. With storage-v2 selected the
  // repository is the authority; the legacy index is only consulted for the
  // active-subject pointer, which is app-owned session state.
  const ids = handle === null ? await safeList(deps, failures) : state.subjects.map((entry) => entry.id);

  // Load the subject the device was last in, then release it, exactly as the
  // pre-phase effect did: Welcome is the first screen, the subject store holds
  // the snapshot so the Welcome screen can name it, and the persisted
  // active-subject pointer is left untouched so a rollback build still knows
  // which subject was active.
  //
  // A subject is loaded only when the state read succeeded. If it did not, the
  // plan holds the empty state, and loading a subject from a *different* read
  // would produce a half-hydrated app: a subject in the store and nothing behind
  // it.
  let releasedSubject: SubjectSnapshot | null = null;
  if (stateReadable && activeSubjectId && ids.length > 0) {
    releasedSubject = await deps.loadSubjectSnapshot(activeSubjectId);
  }

  return { state, activeSubjectId, releasedSubject };
}

async function safeList(deps: BootstrapDeps, failures: BootstrapFailureCode[]): Promise<string[]> {
  try {
    return await deps.listSubjectIds();
  } catch (error) {
    void error;
    failures.push('LEGACY_READ_FAILED');
    return [];
  }
}

/** Apply the plan to the stores. Synchronous, ordered, and all of it. */
function commitPlan(deps: BootstrapDeps, plan: BootstrapPlan): void {
  const { state } = plan;
  deps.hydratePreferences(state.preferences);
  deps.hydrateShortcuts(state.shortcuts);
  deps.hydrateProgression(state.progression);
  deps.setSubjectSnapshot(plan.releasedSubject);

  if (plan.releasedSubject !== null) {
    deps.setSessionActiveSubjectId(null);
    deps.setProgressionActiveSubject(null);
  }
}

// ── Reporting helpers ─────────────────────────────────────────────────────

/** A sink that keeps the most recent dual-write report, for a recovery screen. */
export function createDualWriteCollector(limit = 20): DualWriteSink & {
  reports(): readonly DualWriteReport[];
  summary(): ReturnType<typeof summarizeDualWriteReports>;
} {
  const collected: DualWriteReport[] = [];
  return {
    onDualWriteReport(report) {
      collected.push(report);
      while (collected.length > limit) collected.shift();
    },
    reports: () => collected,
    summary: () => summarizeDualWriteReports(collected),
  };
}
