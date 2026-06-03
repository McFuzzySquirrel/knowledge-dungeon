import { useEffect, useState, type JSX } from 'react';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { WelcomeScreen } from '@/ui/screens/WelcomeScreen';
import { GameScreen } from '@/ui/screens/GameScreen';
import {
  getActiveSubjectId,
  listSubjectIds,
} from '@/services/persistence/subjectPersistence';

export function App(): JSX.Element {
  const snapshot = useSubjectStore((state) => state.snapshot);
  const loadSubject = useSubjectStore((state) => state.loadSubject);
  const selectedClass = useSessionStore((state) => state.selectedClass);
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);
  const setActiveSubjectId = useSessionStore((state) => state.setActiveSubjectId);
  const setProgressionActiveSubject = useProgressionStore((state) => state.setActiveSubject);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-graphics', 'rpg');
    return () => {
      document.documentElement.removeAttribute('data-graphics');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const active = getActiveSubjectId();
      if (active) {
        const loaded = await loadSubject(active);
        if (!cancelled && loaded) {
          setActiveSubjectId(null);
          setProgressionActiveSubject(null);
        }
      } else {
        await listSubjectIds(); // warm cache
      }
      if (!cancelled) setBootstrapped(true);
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [loadSubject, setActiveSubjectId, setProgressionActiveSubject]);

  if (!bootstrapped) {
    return (
      <div className="welcome-screen">
        <h1>Knowledge Dungeon</h1>
        <p>Loading…</p>
      </div>
    );
  }

  if (!snapshot || !selectedClass || !activeSubjectId) {
    return <WelcomeScreen />;
  }

  return <GameScreen />;
}
