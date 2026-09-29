import { lazy, Suspense, useEffect, useState, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { WelcomeScreen } from '@/ui/screens/WelcomeScreen';
import { VillageScreen } from '@/ui/screens/VillageScreen';
import { GameScreen } from '@/ui/screens/GameScreen';
import { MigrationStateSurface, type MigrationAction } from '@/ui/components/MigrationStateSurface';
import { runtimeConfig } from '@/config/featureFlags';
import {
  bootstrapApplication,
  pendingBootstrap,
  type BootstrapResult,
  type MigrationState,
} from '@/application/bootstrap';

/**
 * The build-time renderer switch (plan 11, Phase 9).
 *
 * ## Why the comparison is against a literal
 *
 * `import.meta.env.VITE_WORLD_RENDERER` is replaced by its value as a string
 * literal at build time, so a *literal* comparison lets the bundler see that one
 * branch is dead and delete the other - along with the `import()` in it, and
 * therefore along with the whole PixiJS chunk. That is the difference between a
 * default build that ships no PixiJS bytes at all and one that ships 1.1 MB of
 * vendor chunk that Welcome never requests. A comparison that normalises first
 * (`String(raw).trim().toLowerCase() === 'pixi'`) is equally correct at run time
 * and defeats the folding, because no bundler evaluates a method call on a string
 * constant; this was measured rather than assumed.
 *
 * The run-time value that decides anything is `runtimeConfig.worldRenderer`, which
 * is the *parsed* flag - trimmed, lower-cased, and validated. The two are used for
 * two different jobs and the split is deliberate:
 *
 * - this literal decides what the bundler may delete, and must be exactly the value
 *   the build script passes, which `build:web:pixi` does;
 * - `runtimeConfig.worldRenderer` decides what the application does, and is total
 *   over every spelling the parser accepts.
 *
 * So `VITE_WORLD_RENDERER=" pixi "` parses to `pixi`, requests the Pixi host at run
 * time, and is caught by the build-time chunk audit as a build that asked for Pixi
 * and emitted none - a loud, accurate failure rather than a silent fallback. The
 * screen below reports the same condition in words if it is ever reached.
 *
 * ## Why the switch is at the screen level
 *
 * The world host is chosen here rather than inside `GameScreen`, and that is what
 * keeps the Phaser path byte-for-byte untouched: `GameScreen`'s mount effect, its
 * dungeon adapter, and its HUD are not read, not conditionalised, and not
 * restructured. Phase 11 replaces `PixiWorldHost` with the Village host at this same
 * seam, and Phase 13 and 17 follow.
 *
 * The cost is honest and worth stating: on the flagged build, the game screen is
 * the Phase 9 *test world* rather than the dungeon, because Phase 9's non-goals rule
 * out implementing the dungeon. `GameScreen` returns nothing Pixi-shaped today, so
 * there was no smaller switch available that did not pretend a dungeon existed.
 */
const pixiWorldHostFactory =
  import.meta.env.VITE_WORLD_RENDERER === 'pixi'
    ? () => import('@/renderers/pixi/runtime/PixiWorldHost')
    : null;

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
        <WorldRoute />
      ) : (
        <WelcomeScreen />
      )}
    </div>
  );
}

/**
 * The world route: Phaser's dungeon, or the PixiJS host.
 *
 * A component rather than an inline ternary because `React.lazy` needs a component
 * type, and because a `lazy` boundary needs a `Suspense` boundary - the fallback
 * below is what a learner sees for the one or two frames it takes to fetch and
 * evaluate a renderer that was deliberately not in the first paint.
 */
function WorldRoute(): JSX.Element {
  const requested = runtimeConfig.worldRenderer === 'pixi';
  if (!requested) {
    return <GameScreen />;
  }
  if (pixiWorldHostFactory === null) {
    // Reachable only when the parsed flag is `pixi` while the build-time literal
    // comparison said otherwise, which means the environment value was not
    // literally `pixi`. Named in words rather than by echoing the raw value, so a
    // build-time string can never become a channel for anything.
    return (
      <p role="alert">
        This build was asked for the PixiJS world renderer but contains no PixiJS chunk. Build it with
        VITE_WORLD_RENDERER=pixi.
      </p>
    );
  }
  const PixiWorldHost = lazy(pixiWorldHostFactory);
  return (
    <Suspense fallback={<p role="status">Loading the world…</p>}>
      <PixiWorldHost />
    </Suspense>
  );
}
