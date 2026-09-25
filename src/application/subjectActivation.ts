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
 */
import type { SubjectSnapshot } from '@/core/validation/persistence';
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
  return { activated: true, subjectId: activeId, snapshot: loaded };
}
