import { useEffect, useState, type JSX } from 'react';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { WelcomeScreen } from '@/ui/screens/WelcomeScreen';
import { VillageScreen } from '@/ui/screens/VillageScreen';
import { GameScreen } from '@/ui/screens/GameScreen';
import {
  getActiveSubjectId,
  listSubjectIds,
} from '@/services/persistence/subjectPersistence';
import { getStorageThreshold } from '@/services/errorRecovery';

export function App(): JSX.Element {
  const snapshot = useSubjectStore((state) => state.snapshot);
  const loadSubject = useSubjectStore((state) => state.loadSubject);
  const selectedClass = useSessionStore((state) => state.selectedClass);
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);
  const activeScreen = useSessionStore((state) => state.activeScreen);
  const setActiveSubjectId = useSessionStore((state) => state.setActiveSubjectId);
  const setActiveScreen = useSessionStore((state) => state.setActiveScreen);
  const setProgressionActiveSubject = useProgressionStore((state) => state.setActiveSubject);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [storageWarn, setStorageWarn] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-graphics', 'rpg');
    // Phase 5 accessibility: add skip-to-content link
    const skipLink = document.getElementById('skip-to-content');
    if (!skipLink) {
      const link = document.createElement('a');
      link.id = 'skip-to-content';
      link.href = '#app-main';
      link.className = 'skip-link';
      link.textContent = 'Skip to main content';
      document.body.prepend(link);
    }
    return () => {
      document.documentElement.removeAttribute('data-graphics');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const ids = await listSubjectIds();
      const hasSome = ids.length > 0;

      const active = getActiveSubjectId();
      if (active && hasSome) {
        const loaded = await loadSubject(active);
        if (!cancelled && loaded) {
          setActiveSubjectId(null);
          setProgressionActiveSubject(null);
        }
      }
      if (!cancelled) {
        setBootstrapped(true);
      }

      // Phase 5: check storage threshold on boot
      if (!cancelled) {
        const threshold = getStorageThreshold();
        if (threshold === 'critical') {
          setStorageWarn('Storage space is critically low. Please export your data and remove unused subjects to prevent data loss.');
        } else if (threshold === 'warn') {
          setStorageWarn('Storage space is running low. Consider exporting your data for backup.');
        }
      }
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [loadSubject, setActiveSubjectId, setProgressionActiveSubject, setActiveScreen]);

  if (!bootstrapped) {
    return (
      <div className="welcome-screen" role="status" aria-label="Loading Knowledge Dungeon">
        <h1>Knowledge Dungeon</h1>
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div id="app-main" role="main">
      {storageWarn && (
        <div className="storage-warning-banner" role="alert" aria-live="polite">
          <span>{storageWarn}</span>
          <button
            type="button"
            onClick={() => setStorageWarn(null)}
            aria-label="Dismiss storage warning"
          >
            ×
          </button>
        </div>
      )}
      {activeScreen === 'village' ? (
        <VillageScreen />
      ) : activeScreen === 'game' && snapshot && selectedClass && activeSubjectId ? (
        <GameScreen />
      ) : (
        <WelcomeScreen />
      )}
    </div>
  );
}
