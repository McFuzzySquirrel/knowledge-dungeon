import { useEffect, useState, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { WelcomeScreen } from '@/ui/screens/WelcomeScreen';
import { GameScreen } from '@/ui/screens/GameScreen';
import { useLoadSubjectFlow } from '@/ui/hooks/useLoadSubjectFlow';
import {
  getActiveSubjectId,
  listSubjectIds,
} from '@/services/persistence/subjectPersistence';

export function App(): JSX.Element {
  const snapshot = useSubjectStore((state) => state.snapshot);
  const selectedClass = useSessionStore((state) => state.selectedClass);
  const loadSubjectFlow = useLoadSubjectFlow();
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
        if (!cancelled) {
          await loadSubjectFlow(active);
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
  }, [loadSubjectFlow]);

  if (!bootstrapped) {
    return (
      <div className="welcome-screen">
        <h1>Knowledge Dungeon</h1>
        <p>Loading…</p>
      </div>
    );
  }

  if (!snapshot || !selectedClass) {
    return <WelcomeScreen />;
  }

  return <GameScreen />;
}
