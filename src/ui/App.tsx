import { useEffect, useState, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { WelcomeScreen } from '@/ui/screens/WelcomeScreen';
import { VillageScreen } from '@/ui/screens/VillageScreen';
import { GameScreen } from '@/ui/screens/GameScreen';
import { MigrationStateSurface, type MigrationAction } from '@/ui/components/MigrationStateSurface';
import {
  bootstrapApplication,
  pendingBootstrap,
  type BootstrapResult,
  type MigrationState,
} from '@/application/bootstrap';

export function App(): JSX.Element {
  const snapshot = useSubjectStore((state) => state.snapshot);
  const selectedClass = useSessionStore((state) => state.selectedClass);
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);
  const activeScreen = useSessionStore((state) => state.activeScreen);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [storageWarn, setStorageWarn] = useState<string | null>(null);
  // `null` on the default build: the legacy repository never runs a migration, so
  // the surface below renders nothing at all there.
  const [migration, setMigration] = useState<MigrationState | null>(null);
  // Non-null only for a state that offers `retry-migration`, so the surface can
  // render a retry control it can actually honour.
  const [retryMigration, setRetryMigration] = useState<MigrationAction | null>(null);

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

    // `main.tsx` starts the bootstrap before the first render, so in the real app
    // this resolves against already-hydrated stores. Awaiting the same memoized
    // promise here is what keeps `<App />` correct when it is rendered directly -
    // a component test, or any other host - and it is why a StrictMode
    // double-invoke cannot start a second migration.
    const inFlight = pendingBootstrap() ?? bootstrapApplication();
    void inFlight.then((result: BootstrapResult) => {
      if (cancelled) return;
      setBootstrapped(true);
      setStorageWarn(result.storageWarning);
      // Handed to the surface unchanged. The retry callable is non-null only for a
      // state that offers a retry, so the offer and the capability stay in step.
      setMigration(result.migration);
      setRetryMigration(result.retryMigration);
    });

    return () => {
      cancelled = true;
    };
  }, []);

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
      {/* Renders `null` unless the bootstrap produced a migration state worth
          showing, so the default build's output is unchanged. Mounted before the
          active screen so a notice reads first in the document order, and before
          the storage-pressure banner so a migration notice outranks a warning
          about a move that has not happened yet. */}
      <MigrationStateSurface migration={migration} retryMigration={retryMigration} />
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
