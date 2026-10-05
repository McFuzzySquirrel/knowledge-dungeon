/**
 * Canonical subject activation.
 *
 * This is the single implementation of "make this subject the active subject".
 * It is plain TypeScript with no React and no renderer dependency, so both the
 * React hook wrapper and any future host call exactly the same code. Every
 * store side effect is injected (with defaults that read the real Zustand
 * stores), which keeps the flow unit-testable without React.
 *
 * Semantics (unchanged from the previous `useLoadSubjectFlow` implementation):
 * load the subject, return `activated: false` when the load fails, otherwise
 * point both the session and the progression stores at
 * `loaded.dungeon.dungeonId`. Calling it repeatedly is safe: the result is the
 * same active state, and the store writes are idempotent.
 *
 * ## Phase 18: a study session starts here
 *
 * This is the **single canonical subject-activation path** - `useLoadSubjectFlow` and the
 * village world both reach it - so it is also the one place a study session starts, and no
 * second activation site is added anywhere. The report goes through the nullable sink in
 * `@/core/statistics/activitySink` rather than through a direct call, for the same reason
 * every store here takes its effects as injected ports: `subjectActivation.ts` must not
 * import a store, and the sink keeps the dependency direction one-way. With no sink
 * installed - a unit test, a rollback build, a host that has not installed the statistics
 * layer - the report is a silent no-op and nothing else changes.
 *
 * The report happens **after** both store writes and only on `activated: true`, so a
 * failed load cannot start a session for a subject that never loaded.
 */
import type { SubjectSnapshot } from '@/core/validation/persistence';
import { emitSubjectActivated } from '@/core/statistics/activitySink';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';

/** Outcome of a subject-activation attempt. */
export interface SubjectActivationResult {
  /** True when the subject loaded and the active ids were synchronized. */
  activated: boolean;
  /** The active subject id after the call, or null when activation failed. */
  subjectId: string | null;
  /** The loaded snapshot, or null when activation failed. */
  snapshot: SubjectSnapshot | null;
}

/** Store side effects used by {@link activateSubject}; all injectable. */
export interface SubjectActivationDeps {
  loadSubject: (subjectId: string) => Promise<SubjectSnapshot | null>;
  setSessionActiveSubjectId: (subjectId: string | null) => void;
  setProgressionActiveSubject: (subjectId: string | null) => void;
}

/**
 * Real-store defaults, read through `getState()` at call time so an activation
 * always sees the current actions.
 */
export const defaultSubjectActivationDeps: SubjectActivationDeps = {
  loadSubject: (subjectId) => useSubjectStore.getState().loadSubject(subjectId),
  setSessionActiveSubjectId: (subjectId) =>
    useSessionStore.getState().setActiveSubjectId(subjectId),
  setProgressionActiveSubject: (subjectId) =>
    useProgressionStore.getState().setActiveSubject(subjectId),
};

/**
 * Load a subject and synchronize the session + progression active subject ids.
 *
 * @param subjectId Subject/dungeon id to activate.
 * @param deps Injectable store side effects; defaults to the real stores.
 */
export async function activateSubject(
  subjectId: string,
  deps: SubjectActivationDeps = defaultSubjectActivationDeps,
): Promise<SubjectActivationResult> {
  const loaded = await deps.loadSubject(subjectId);
  if (!loaded) {
    return { activated: false, subjectId: null, snapshot: null };
  }
  const activeId = loaded.dungeon.dungeonId;
  deps.setSessionActiveSubjectId(activeId);
  deps.setProgressionActiveSubject(activeId);
  // Phase 18: the canonical activation is where a study session starts. A no-op when no
  // statistics sink is installed, and idempotent for a repeated activation of the same
  // subject - the lifecycle returns the session already open and writes nothing.
  emitSubjectActivated({
    subjectId: activeId,
    subjectName: loaded.dungeon.subjectName,
  });
  return { activated: true, subjectId: activeId, snapshot: loaded };
}
