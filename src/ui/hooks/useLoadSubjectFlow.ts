import { useCallback } from 'react';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';

/**
 * Canonical subject activation flow so session and progression stores stay in sync.
 */
export function useLoadSubjectFlow(): (subjectId: string) => Promise<boolean> {
  const loadSubject = useSubjectStore((s) => s.loadSubject);
  const setSessionActiveSubject = useSessionStore((s) => s.setActiveSubjectId);
  const setProgressionActiveSubject = useProgressionStore((s) => s.setActiveSubject);

  return useCallback(
    async (subjectId: string) => {
      const loaded = await loadSubject(subjectId);
      if (!loaded) return false;
      const activeId = loaded.dungeon.dungeonId;
      setSessionActiveSubject(activeId);
      setProgressionActiveSubject(activeId);
      return true;
    },
    [loadSubject, setProgressionActiveSubject, setSessionActiveSubject],
  );
}
