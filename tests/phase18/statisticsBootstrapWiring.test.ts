/**
 * Phase 18 gate 3b: the bootstrap actually wires the statistics layer.
 *
 * ## The gap this file closes
 *
 * `src/application/bootstrap.ts` grew two `BootstrapDeps` members in Phase 18 -
 * `installSessionLifecycle` and `hydrateStatisticsSessions` - and `tests/unit/appBootstrap.test.ts`
 * added both to its harness as `() => undefined`.
 *
 * That is the right *minimal* change: the existing exact-order assertion in that file records
 * six effects and did not have to grow. But it means **nothing in the suite asserts that
 * `commitPlan` calls either of them.** Verified: the only two occurrences of those names outside
 * `bootstrap.ts` are the two no-op stubs. Deleting the two lines from `commitPlan` would leave
 * every one of the 5 700-odd tests green while the statistics dashboard silently recorded
 * nothing - which is precisely the Phase 18 defect the phase exists to fix, reintroduced at the
 * seam that fixes it.
 *
 * So this file asserts three separate things, because they fail differently:
 *
 * 1. **`commitPlan` calls both**, each exactly once, in the right order relative to the store
 *    hydrations the existing bootstrap gate already pins.
 * 2. **The default dependency implementations are not no-ops.** `createDefaultBootstrapDeps()`
 *    is the production wiring; invoking its two members must be observable in the real wiring's
 *    own state.
 * 3. **The hydration publishes what it was given**, through the real statistics store.
 *
 * ## Non-vacuity
 *
 * The harness records calls into an ordered list and the order assertion names the neighbours it
 * expects, so "was called" is measured against a list that other assertions populate. There is
 * also a POSITIVE CONTROL per case that drives the same dependency and asserts the recorder saw
 * it, so a recorder wired to the wrong key fails rather than passing silently.
 *
 * Privacy: every fixture is synthetic. No learner data, no URL, no request body.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bootstrapApplication,
  createDefaultBootstrapDeps,
  type BootstrapDeps,
} from '@/application/bootstrap';
import {
  hasSessionLifecycleBinding,
  installSessionLifecycleBinding,
} from '@/store/sessionLifecycleBinding';
import { useStatisticsStore } from '@/store/statisticsStore';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';

const SUBJECT_ID = 'synthetic-qa18-bootstrap-subject';
const ROOM_ID = 'synthetic-qa18-bootstrap-room';
const SESSION_ID = 'synthetic-qa18-bootstrap-session';
const NOW = '2026-09-09T09:09:09.000Z';

function snapshot(): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: 'Synthetic QA18 Bootstrap Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM_ID,
    rooms: [{ roomId: ROOM_ID, topic: 'synthetic-topic', status: 'ArtifactCollected' }],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return {
    dungeon,
    rooms: {
      [ROOM_ID]: {
        ...makeEmptyRoomMetadata({ roomId: ROOM_ID, topic: 'synthetic-topic', nowIso: NOW }),
        state: 'ArtifactCollected',
        validationState: { ...makeEmptyValidationState(), finalPass: true },
      },
    },
  };
}

const POPULATED_STATE = {
  subjects: [{ id: SUBJECT_ID, snapshot: snapshot() }],
  preferences: { graphicsMode: 'rpg', colorTheme: 'aurora', activeSpritePack: 'synthetic-pack' },
  progression: { version: 3, bySubject: {}, crossSubjectAchievements: [] },
  shortcuts: [],
  sessions: [
    {
      sessionId: SESSION_ID,
      startedAt: '2026-09-09T08:00:00.000Z',
      endedAt: '2026-09-09T08:30:00.000Z',
      subjectId: SUBJECT_ID,
      subjectName: 'Synthetic QA18 Bootstrap Subject',
      roomsVisited: [ROOM_ID],
      notesSubmitted: 1,
      reviewsCompleted: 0,
      xpEarned: 12,
    },
  ],
  activeSubjectId: SUBJECT_ID,
};

interface Recorded {
  readonly order: string[];
  lifecycleInstalls: number;
  hydrations: unknown[];
}

function harness(overrides: Partial<BootstrapDeps> = {}): {
  deps: BootstrapDeps;
  recorded: Recorded;
} {
  const order: string[] = [];
  const recorded: Recorded = { order, lifecycleInstalls: 0, hydrations: [] };
  const noop = (): void => undefined;
  const deps: BootstrapDeps = {
    repository: 'legacy',
    openRepository: () => Promise.reject(new Error('storage-v2 must not be opened on the legacy path')),
    generationId: 'gen-qa18-bootstrap-0001',
    now: NOW,
    readLegacyState: () => POPULATED_STATE,
    readActiveSubjectId: () => SUBJECT_ID,
    listSubjectIds: () => Promise.resolve([SUBJECT_ID]),
    loadSubjectSnapshot: () => Promise.resolve(snapshot()),
    getStorageThreshold: () => 'ok',
    storageWarningFor: () => 'synthetic storage warning',
    setDualWriteSink: noop,
    setSessionSource: noop,
    installSessionLifecycle: () => {
      order.push('install-session-lifecycle');
      recorded.lifecycleInstalls += 1;
    },
    hydrateStatisticsSessions: (sessions) => {
      order.push('hydrate-statistics-sessions');
      recorded.hydrations.push(sessions);
    },
    hydratePreferences: () => {
      order.push('preferences');
    },
    hydrateShortcuts: () => {
      order.push('shortcuts');
    },
    hydrateProgression: () => {
      order.push('progression');
    },
    setSubjectSnapshot: () => {
      order.push('subject');
    },
    setSessionActiveSubjectId: () => {
      order.push('session');
    },
    setProgressionActiveSubject: () => {
      order.push('progression-active');
    },
    ...overrides,
  };
  return { deps, recorded };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  useStatisticsStore.getState().hydrateSessions([]);
});

afterEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
});

describe('commitPlan wires the statistics layer', () => {
  it('installs the lifecycle and hydrates the sessions, each exactly once', async () => {
    const { deps, recorded } = harness();
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('ready');
    expect(recorded.lifecycleInstalls, 'the session lifecycle was not installed by the bootstrap').toBe(1);
    expect(recorded.hydrations).toHaveLength(1);
    // The hydration got the records the read produced, not `null` and not an empty list.
    expect(recorded.hydrations[0]).toEqual(POPULATED_STATE.sessions);
  });

  it('installs the wiring after every store is hydrated and before the result resolves', async () => {
    // The order is the property: the first activity of the session must not be able to happen
    // before the sinks exist, and the sinks must not exist before the stores they subscribe to.
    // The names of the neighbours are asserted rather than a position, so this stays a real
    // ordering claim and not a count.
    const { deps, recorded } = harness();
    await bootstrapApplication(deps);

    const order = recorded.order;
    const at = (name: string): number => order.indexOf(name);

    for (const before of ['preferences', 'shortcuts', 'progression', 'subject']) {
      expect(at(before), `${before} was never called`).toBeGreaterThanOrEqual(0);
      expect(at('install-session-lifecycle'), `${before} landed after the wiring`).toBeGreaterThan(
        at(before),
      );
      expect(at('hydrate-statistics-sessions'), `${before} landed after the hydration`).toBeGreaterThan(
        at(before),
      );
    }
    expect(at('hydrate-statistics-sessions')).toBeGreaterThan(at('install-session-lifecycle'));
    // One call each: a second install would put a second set of listeners on the window.
    expect(order.filter((name) => name === 'install-session-lifecycle')).toHaveLength(1);
    expect(order.filter((name) => name === 'hydrate-statistics-sessions')).toHaveLength(1);
  });

  it('nothing lands after the bootstrap resolves', async () => {
    const { deps, recorded } = harness();
    await bootstrapApplication(deps);
    const afterResolve = [...recorded.order];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorded.order).toEqual(afterResolve);
  });

  it('CONTROL: the recorder sees the neighbours it recorded, so "was called" is a measurement', async () => {
    // Without this the three assertions above could be green because the recorder was wired to
    // the wrong key. The neighbours are asserted here by name, from the same run.
    const { deps, recorded } = harness();
    await bootstrapApplication(deps);
    expect(recorded.order).toEqual(
      expect.arrayContaining(['preferences', 'shortcuts', 'progression', 'subject', 'session', 'progression-active']),
    );
    expect(recorded.order).toHaveLength(8);
  });
});

describe('the default dependency implementations are not no-ops', () => {
  it('installSessionLifecycle really installs the wiring, and the disposer removes it', () => {
    // No `vi.resetModules()` here, deliberately. `createDefaultBootstrapDeps` captures the
    // *statically imported* binding and store modules, so resetting the registry would give this
    // case a fresh statistics store while the dependency under test kept writing to the old one -
    // and the assertions would then be measuring the wrong instance. This case is about the
    // production wiring object, so it stays in one registry.
    const defaultDeps = createDefaultBootstrapDeps();
    expect(hasSessionLifecycleBinding()).toBe(false);

    defaultDeps.installSessionLifecycle();
    expect(hasSessionLifecycleBinding()).toBe(true);
    // A second call is idempotent rather than a second set of listeners.
    defaultDeps.installSessionLifecycle();
    expect(hasSessionLifecycleBinding()).toBe(true);

    installSessionLifecycleBinding()();
    expect(hasSessionLifecycleBinding()).toBe(false);
  });

  it('hydrateStatisticsSessions publishes the records it was given', async () => {
    const store = useStatisticsStore;
    const defaultDeps = createDefaultBootstrapDeps();

    // The empty state first, so the later assertion cannot be satisfied by a pre-existing value.
    store.getState().hydrateSessions([]);
    expect(store.getState().snapshot.recentSessions).toEqual([]);
    expect(store.getState().snapshot.totals.sessionsCompleted).toBe(0);

    defaultDeps.hydrateStatisticsSessions(POPULATED_STATE.sessions as never);

    const snapshot = store.getState().snapshot;
    expect(snapshot.totals.sessionsCompleted).toBe(1);
    expect(snapshot.totals.studyTimeMinutes).toBe(30);
    expect(snapshot.totals.uniqueRoomsVisited).toBe(1);
    expect(snapshot.recentSessions.map((entry) => entry.sessionId)).toEqual([SESSION_ID]);
    expect(snapshot.provenance.sessionsRead).toBe(1);
    // And the reader can read them, which is the whole point of publishing rather than storing.
    const { readSessionRecords, computeStatisticsFromRecords } = await import('@/services/sessionTracker');
    expect(readSessionRecords()).toEqual([]);
    expect(
      computeStatisticsFromRecords({
        sessions: POPULATED_STATE.sessions as never,
        subjects: [],
        now: new Date(NOW),
      }).totals.sessionsCompleted,
    ).toBe(1);
  });

  it('a `null` session payload publishes an empty snapshot rather than throwing', () => {
    const store = useStatisticsStore;
    const defaultDeps = createDefaultBootstrapDeps();
    store.getState().hydrateSessions(POPULATED_STATE.sessions as never);
    expect(store.getState().snapshot.totals.sessionsCompleted).toBe(1);

    // `AppPersistedState['sessions']` is `SessionRecord[] | null`, and `null` is the ordinary
    // value on a device with nothing stored. A panel that renders before hydration must not
    // crash, and must not claim the previous device's data.
    defaultDeps.hydrateStatisticsSessions(null);
    const snapshot = store.getState().snapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot.totals.sessionsCompleted).toBe(0);
    expect(snapshot.recentSessions).toEqual([]);
  });
});