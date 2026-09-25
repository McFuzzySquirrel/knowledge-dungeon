/**
 * React wrapper around the canonical subject-activation flow.
 *
 * The implementation lives in `src/application/subjectActivation.ts` so every
 * activation site (this hook, the village world callbacks, future hosts) shares
 * one code path. This hook only binds the store actions and preserves the
 * historical `(subjectId) => Promise<boolean>` signature.
 */
import { useCallback } from 'react';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { activateSubject } from '@/application/subjectActivation';

/**
 * Canonical subject activation flow so session and progression stores stay in sync.
 */
export function useLoadSubjectFlow(): (subjectId: string) => Promise<boolean> {
  const loadSubject = useSubjectStore((s) => s.loadSubject);
  const setSessionActiveSubject = useSessionStore((s) => s.setActiveSubjectId);
  const setProgressionActiveSubject = useProgressionStore((s) => s.setActiveSubject);

  return useCallback(
    async (subjectId: string) => {
      const result = await activateSubject(subjectId, {
        loadSubject,
        setSessionActiveSubjectId: setSessionActiveSubject,
        setProgressionActiveSubject,
      });
      return result.activated;
    },
    [loadSubject, setProgressionActiveSubject, setSessionActiveSubject],
  );
}
