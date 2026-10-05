/**
 * The one place the statistics and session-lifecycle wiring is installed.
 *
 * ## Why this module exists
 *
 * Plan 5.3's defect - "session tracking functions are not wired into real gameplay" - was not
 * a missing call site somewhere in the application. It was that **nothing ever set
 * `currentSession`**, so every `track*` returned early and the statistics were structurally
 * always zero. Fixing that needs a wiring point, and the wiring spans three kinds of source:
 *
 * - **the session store**, for `focusedRoomId` (the funnel every room entry on both renderers
 *   already reports through) and `activeScreen` (the app-level route transition);
 * - **the DOM**, for `pagehide` and `visibilitychange`;
 * - **the application layer**, for canonical subject activation and for the award sites, via
 *   the two nullable sinks in `@/core/statistics/activitySink`.
 *
 * Putting all of it in one module means one module knows the statistics layer is wired, one
 * disposer removes it, and a test can install and uninstall the whole thing without touching
 * another module's state.
 *
 * ## What it wires, and why each seam
 *
 * | Seam | Signal | Why here |
 * | --- | --- | --- |
 * | `useSessionStore.focusedRoomId` | room visit | `onRoomEntered` from the Pixi dungeon, the Phaser `DungeonScene`, and `studyFlow.roomInteract` **all** end in `setFocusedRoomId`. One subscription therefore covers every renderer and the DOM navigation path, and it needs no renderer import and no change to `GameScreen`. |
 * | `useSessionStore.activeScreen` | route unmount | Leaving `'game'` is the app-level route unmount, and it is a store transition rather than a React lifecycle, so it survives a renderer crash and does not need a component. |
 * | `window.pagehide` | tab close | The only close event a browser fires reliably, and unlike `beforeunload` it does not block the back/forward cache. |
 * | `document.visibilitychange` | backgrounding | The transition a browser guarantees before it may freeze or discard a page. |
 * | `@/core/statistics/activitySink` subject sink | session start | `subjectActivation.ts` reports through it, and that function is the single canonical activation path. |
 * | `@/core/statistics/activitySink` activity sink | note / review / XP / catch | `progressionStore`'s three award actions emit through it, in the same place they decide the award. |
 *
 * ## Idempotency
 *
 * Installation is idempotent: a second call returns the existing disposer instead of
 * installing a second set of listeners, because two sets would double every room visit.
 * Every handler is also idempotent by itself - `recordActivity` de-duplicates a room inside
 * the session's own `roomsVisited` set, and `endSession` finds nothing open the second time -
 * so a StrictMode double effect, a repeated close event, and a `pagehide` that follows a
 * `visibilitychange` each produce one record.
 *
 * ## What it deliberately does not do
 *
 * - It does not import a renderer. `src/store/` may not reach `src/renderers/**` or
 *   `src/game/**`, and nothing here needs to.
 * - It does not subscribe to the lifecycle's own `onChange`. `focusedRoomId` already covers
 *   the room-visit case, and subscribing to both would rebuild the statistics snapshot twice
 *   per room entry.
 * - It does not add a feature flag. Statistics are always collected; only the *display* is
 *   a surface decision, which is the plan's rollback ("disable statistics display while
 *   retaining collected records").
 */
import {
  emitSubjectActivated,
  setSessionEndSink,
  setStatisticsActivitySink,
  setSubjectActivationSink,
} from '@/core/statistics/activitySink';
import { sessionLifecycle, setSessionSubjectPort } from '@/services/sessionTracker';
import { useSessionStore } from '@/store/sessionStore';
import { installStatisticsStoreBinding } from '@/store/statisticsStore';
import { useSubjectStore } from '@/store/subjectStore';

let disposeInstalled: (() => void) | null = null;

/**
 * Install the statistics and session-lifecycle wiring.
 *
 * Returns a disposer. Calling it twice is safe and the second disposer removes the first
 * installation, which is the only ordering a test and a host can both rely on.
 */
export function installSessionLifecycleBinding(): () => void {
  if (disposeInstalled !== null) return disposeInstalled;
  if (typeof window === 'undefined') {
    // A non-DOM host (a Node script, an Electron main process, a test with no jsdom) has no
    // `pagehide` and no `visibilitychange`. The store subscriptions and both sinks still
    // install, so the award sites keep recording, and the two DOM handlers are simply absent.
    disposeInstalled = installWithoutDom();
    return disposeInstalled;
  }

  const onPageHide = (): void => {
    sessionLifecycle().handlePageHide();
  };
  const onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      sessionLifecycle().handleVisibilityHidden();
    }
  };

  const unsubscribes: Array<() => void> = [];

  // Room visits. `focusedRoomId` is the funnel both renderers and the DOM navigation path
  // already report through, so this one subscription is the whole room-visit wiring.
  let lastFocusedRoomId: string | null = useSessionStore.getState().focusedRoomId;
  unsubscribes.push(
    useSessionStore.subscribe((state) => {
      const roomId = state.focusedRoomId;
      // Only a transition *into* a room is a visit, so re-focusing the room the learner is
      // already standing in does not add one. The session record de-duplicates as well; this
      // is the cheaper of the two guards.
      if (roomId === null || roomId === lastFocusedRoomId) return;
      lastFocusedRoomId = roomId;
      sessionLifecycle().recordActivity({ kind: 'room-visit', roomId });
    }),
  );

  // Route unmount. Leaving the dungeon is the app-level route transition, and it arrives
  // before `setFocusedRoomId(null)` in `studyFlow.returnToVillage`, so the session is closed
  // while the room list is still intact.
  let lastScreen: string | null = useSessionStore.getState().activeScreen;
  unsubscribes.push(
    useSessionStore.subscribe((state) => {
      const screen = state.activeScreen;
      if (screen === lastScreen) return;
      const wasInDungeon = lastScreen === 'game';
      lastScreen = screen;
      if (wasInDungeon && screen !== 'game') sessionLifecycle().handleRouteUnmount();
    }),
  );

  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);
  unsubscribes.push(() => {
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  const removeStatisticsBinding = installStatisticsStoreBinding();
  unsubscribes.push(removeStatisticsBinding);

  // The subject port the lifecycle reads on a resume-from-background. Reads through
  // `getState()` so it is always current, and returns `null` when no subject is active so a
  // visibility change on the welcome screen starts nothing.
  setSessionSubjectPort({
    readActiveSubject: () => {
      const session = useSessionStore.getState();
      const subjectId = session.activeSubjectId;
      if (subjectId === null || subjectId.trim().length === 0) return null;
      const snapshot = useSubjectStore.getState().snapshot;
      // A subject pointer with no loaded graph is not a study session: the learner is on the
      // welcome screen or in the village with a remembered pointer, and a
      // `visibilitychange` there must start nothing.
      if (snapshot === null || snapshot.dungeon.dungeonId !== subjectId) return null;
      return { subjectId, subjectName: snapshot.dungeon.subjectName };
    },
  });

  setSubjectActivationSink((event) => {
    sessionLifecycle().handleSubjectActivated(event);
  });
  setStatisticsActivitySink((activity) => {
    sessionLifecycle().recordActivity(activity);
  });
  setSessionEndSink((reason) => {
    sessionLifecycle().endSession(reason);
  });

  disposeInstalled = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    setSubjectActivationSink(null);
    setStatisticsActivitySink(null);
    setSessionEndSink(null);
    setSessionSubjectPort(null);
    disposeInstalled = null;
  };

  // Recovering an unterminated session is the last step, and it runs *after* the sinks are
  // installed so a recovered record cannot be mistaken for a live one. It is deliberately
  // not awaited: recovery is a read plus one write per unterminated record, and neither the
  // first paint nor a learner waiting at the welcome screen should wait for it. A failure is
  // swallowed for the same reason the controller swallows a persistence failure - the next
  // activity re-publishes the record, so a failed recovery is a lag and not a loss.
  void sessionLifecycle().recoverUnterminatedSessions().catch(() => undefined);

  disposeInstalled = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    setSubjectActivationSink(null);
    setStatisticsActivitySink(null);
    setSessionEndSink(null);
    setSessionSubjectPort(null);
    disposeInstalled = null;
  };
  return disposeInstalled;
}

function installWithoutDom(): () => void {
  const removeStatisticsBinding = installStatisticsStoreBinding();
  setSubjectActivationSink((event) => {
    sessionLifecycle().handleSubjectActivated(event);
  });
  setStatisticsActivitySink((activity) => {
    sessionLifecycle().recordActivity(activity);
  });
  setSessionEndSink((reason) => {
    sessionLifecycle().endSession(reason);
  });
  return () => {
    removeStatisticsBinding();
    setSubjectActivationSink(null);
    setStatisticsActivitySink(null);
    setSessionEndSink(null);
    disposeInstalled = null;
  };
}

/** Whether the wiring is currently installed. Test support. */
export function hasSessionLifecycleBinding(): boolean {
  return disposeInstalled !== null;
}

/**
 * Report a canonical subject activation through the installed sink.
 *
 * `subjectActivation.ts` calls the sink in `@/core/statistics/activitySink` directly; this
 * re-export exists so a host that wants to announce an activation it performed itself - a
 * tutorial hand-off, a restored subject - goes through the same one function rather than
 * reaching for the controller.
 */
export { emitSubjectActivated };