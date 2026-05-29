import { useEffect, useState, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { usePreferencesStore } from '@/store/preferencesStore';
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
  const setActiveSubjectId = useSessionStore((state) => state.setActiveSubjectId);
  const graphicsMode = usePreferencesStore((state) => state.graphicsMode);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Mirror the user's graphics-mode preference onto the document root so
  // global CSS skins (e.g. parchment HUD in RPG mode) can react via
  // `[data-graphics="rpg"]` selectors without prop-drilling.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-graphics', graphicsMode);
    return () => {
      document.documentElement.removeAttribute('data-graphics');
    };
  }, [graphicsMode]);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const active = getActiveSubjectId();
      if (active) {
        const loaded = await loadSubject(active);
        if (!cancelled && loaded) {
          setActiveSubjectId(loaded.dungeon.dungeonId);
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
  }, [loadSubject, setActiveSubjectId]);

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
