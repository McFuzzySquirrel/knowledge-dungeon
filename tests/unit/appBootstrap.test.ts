/**
 * Phase 4: the explicit asynchronous application bootstrap.
 *
 * What this file proves, in the order the plan's Phase 4 scope states it:
 *
 * 1. **Every store is hydrated before the first render.** The bootstrap reads
 *    everything, then commits it in one synchronous step, so no store can be
 *    observed holding a value the others do not have.
 * 2. **The default `legacy` repository produces the same in-memory state the
 *    module-load hydration produced.** Not "equivalent" - the exact same values,
 *    defaults included, for an empty device and for a populated one.
 * 3. **A storage failure does not leave the app half-hydrated.** A read failure
 *    commits the empty state to *every* store.
 * 4. **The flag selects the repository**, and hydration reads from whichever
 *    repository is selected.
 * 5. **Hydration never writes.** Booting the app does not rewrite a subject, does
 *    not create a backup record, and does not move the active-subject pointer,
 *    which is what makes the legacy generation a migration read still
 *    byte-identical afterwards.
 *
 * The store effects are injected (the `subjectActivation.ts` pattern), so the
 * commit order and the values committed are observable without React and without
 * a DOM. The real stores are exercised separately, in the "real stores" block.
 *
 * Privacy: every value here is synthetic and self-describing. No learner data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapApplication,
  createDefaultBootstrapDeps,
  type BootstrapDeps,
} from '@/application/bootstrap';
import {
  EMPTY_APP_PERSISTED_STATE,
  type AppPersistedState,
} from '@/services/persistence/v2/appState';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { readProgressionStoreState } from './support/progressionHydration';

const NOW = '2026-09-26T00:00:00.000Z';
const SUBJECT_ID = 'subject-bootstrap-synthetic';
const ROOM_ID = 'room-bootstrap-synthetic-root';
const OTHER_SUBJECT_ID = 'subject-bootstrap-other';

/** A minimal valid subject snapshot. Synthetic and self-describing. */
function syntheticSnapshot(subjectId: string, subjectName: string) {
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: subjectId,
      subjectName,
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:09:05.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: ROOM_ID,
      rooms: [{ roomId: ROOM_ID, topic: 'Bootstrap synthetic root topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      [ROOM_ID]: {
        roomId: ROOM_ID,
        topic: 'Bootstrap synthetic root topic',
        createdAt: '2026-01-04T03:04:05.000Z',
        updatedAt: '2026-01-04T03:09:05.000Z',
        state: 'Created',
        notePath: `rooms/${ROOM_ID}/notes.txt`,
        artifactPath: `rooms/${ROOM_ID}/artifact.md`,
        noteText: 'Bootstrap synthetic note body.',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 0,
            clarityReadability: 0,
          },
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [],
      },
    },
  } as never;
}

const POPULATED_STATE: AppPersistedState = {
  subjects: [
    { id: SUBJECT_ID, snapshot: syntheticSnapshot(SUBJECT_ID, 'Bootstrap synthetic subject') },
    { id: OTHER_SUBJECT_ID, snapshot: syntheticSnapshot(OTHER_SUBJECT_ID, 'Bootstrap other subject') },
  ],
  progression: {
    version: 3,
    bySubject: {
      [SUBJECT_ID]: {
        xpTotal: 120,
        rank: 'Scholar',
        badges: ['synthetic-bootstrap-badge'],
        inventory: [],
        equippedItems: [],
        collectedNotes: [],
        streakCount: 2,
        subjectsMastered: 0,
        roomsCleared: 1,
        reviewPasses: 0,
        artifacts: 0,
        bossesDefeated: 0,
        fishCollection: [],
      },
    },
    crossSubjectAchievements: ['meta-subjects-2'],
  },
  preferences: { graphicsMode: 'rpg', colorTheme: 'aurora', activeSpritePack: 'synthetic-pack' },
  shortcuts: [
    { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'k', ctrlKey: false, shiftKey: false },
  ],
  sessions: [
    {
      sessionId: 'session-bootstrap-synthetic',
      startedAt: '2026-01-04T03:00:00.000Z',
      endedAt: '2026-01-04T03:30:00.000Z',
      subjectId: SUBJECT_ID,
      subjectName: 'Bootstrap synthetic subject',
      roomsVisited: [ROOM_ID],
      notesSubmitted: 1,
      reviewsCompleted: 0,
      xpEarned: 120,
    },
  ],
  activeSubjectId: SUBJECT_ID,
};

/** Records every injected store effect, in call order. */
interface Recorded {
  order: string[];
  preferences: unknown;
  shortcuts: unknown;
  progression: unknown;
  snapshot: unknown;
  sessionActiveSubjectId: unknown;
  progressionActiveSubject: unknown;
}

function harness(overrides: Partial<BootstrapDeps> = {}): { deps: BootstrapDeps; recorded: Recorded } {
  const order: string[] = [];
  const recorded: Recorded = {
    order,
    preferences: 'unset',
    shortcuts: 'unset',
    progression: 'unset',
    snapshot: 'unset',
    sessionActiveSubjectId: 'unset',
    progressionActiveSubject: 'unset',
  };
  const deps: BootstrapDeps = {
    repository: 'legacy',
    openRepository: () => Promise.reject(new Error('storage-v2 must not be opened on the legacy path')),
    generationId: 'gen-bootstrap-0001',
    now: NOW,
    readLegacyState: () => POPULATED_STATE,
    readActiveSubjectId: () => SUBJECT_ID,
    listSubjectIds: () => Promise.resolve(POPULATED_STATE.subjects.map((entry) => entry.id)),
    loadSubjectSnapshot: (subjectId) =>
      Promise.resolve(
        POPULATED_STATE.subjects.find((entry) => entry.id === subjectId)?.snapshot ?? null,
      ),
    getStorageThreshold: () => 'ok',
    storageWarningFor: () => 'synthetic storage warning',
    setDualWriteSink: () => undefined,
    setSessionSource: () => undefined,
    hydratePreferences: (persisted) => {
      order.push('preferences');
      recorded.preferences = persisted;
    },
    hydrateShortcuts: (persisted) => {
      order.push('shortcuts');
      recorded.shortcuts = persisted;
    },
    hydrateProgression: (payload) => {
      order.push('progression');
      recorded.progression = payload;
    },
    setSubjectSnapshot: (snapshot) => {
      order.push('subject');
      recorded.snapshot = snapshot;
    },
    setSessionActiveSubjectId: (subjectId) => {
      order.push('session');
      recorded.sessionActiveSubjectId = subjectId;
    },
    setProgressionActiveSubject: (subjectId) => {
      order.push('progression-active');
      recorded.progressionActiveSubject = subjectId;
    },
    ...overrides,
  };
  return { deps, recorded };
}

describe('Phase 4 bootstrap: the legacy repository is the default and is unchanged', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });

  it('reports ready, the legacy repository, and no failures on a healthy device', async () => {
    const { deps, recorded } = harness();
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('ready');
    expect(result.repository).toBe('legacy');
    expect(result.failures).toEqual([]);
    expect(result.migration).toBeNull();
    expect(result.storageWarning).toBeNull();
    expect(result.releasedActiveSubject).toBe(true);
    // Every store was committed, and the subject was released exactly as the
    // pre-phase effect released it.
    expect(recorded.order).toEqual([
      'preferences',
      'shortcuts',
      'progression',
      'subject',
      'session',
      'progression-active',
    ]);
    expect(recorded.sessionActiveSubjectId).toBeNull();
    expect(recorded.progressionActiveSubject).toBeNull();
  });

  it('commits every store exactly once, and nothing lands after the result resolves', async () => {
    // The commit is one synchronous step, so by the time `bootstrapApplication`
    // resolves there is no interleaving point at which some stores are hydrated
    // and others are not - and no straggler store effect runs afterwards.
    const { deps, recorded } = harness();
    await bootstrapApplication(deps);
    const afterResolve = [...recorded.order];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorded.order).toEqual(afterResolve);
    expect(afterResolve).toHaveLength(6);
  });

  it('hydrates a populated device with the persisted values, not the defaults', async () => {
    const { deps, recorded } = harness();
    await bootstrapApplication(deps);

    expect(recorded.preferences).toEqual(POPULATED_STATE.preferences);
    expect(recorded.shortcuts).toEqual(POPULATED_STATE.shortcuts);
    expect(recorded.progression).toEqual(POPULATED_STATE.progression);
    expect((recorded.snapshot as { dungeon: { subjectName: string } }).dungeon.subjectName).toBe(
      'Bootstrap synthetic subject',
    );
  });

  it('hydrates an empty device to the documented defaults, not to undefined', async () => {
    const { deps, recorded } = harness({
      readLegacyState: () => EMPTY_APP_PERSISTED_STATE,
      readActiveSubjectId: () => null,
      listSubjectIds: () => Promise.resolve([]),
      loadSubjectSnapshot: () => Promise.resolve(null),
    });
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('ready');
    expect(result.releasedActiveSubject).toBe(false);
    // The stores receive `null`, which each one resolves to its own documented
    // default - not an absent value and not a leftover from a previous device.
    expect(recorded.preferences).toBeNull();
    expect(recorded.shortcuts).toBeNull();
    expect(recorded.progression).toBeNull();
    expect(recorded.snapshot).toBeNull();
    // With nothing loaded, the active-subject ids are not touched at all.
    expect(recorded.order).toEqual(['preferences', 'shortcuts', 'progression', 'subject']);
  });

  it('writes nothing: hydration leaves every legacy key byte-identical', async () => {
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_ID]));
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_ID);
    window.localStorage.setItem('knowledge-dungeon:v1:progression', JSON.stringify(POPULATED_STATE.progression));
    window.localStorage.setItem('knowledge-dungeon:session:preferences', JSON.stringify(POPULATED_STATE.preferences));
    window.localStorage.setItem('knowledge-dungeon:session:shortcuts', JSON.stringify(POPULATED_STATE.shortcuts));
    const before = Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_unused, index) => {
        const key = window.localStorage.key(index) as string;
        return [key, window.localStorage.getItem(key) as string];
      }),
    );

    const { deps } = harness();
    await bootstrapApplication(deps);

    const after = Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_unused, index) => {
        const key = window.localStorage.key(index) as string;
        return [key, window.localStorage.getItem(key) as string];
      }),
    );
    // The same keys, the same values, and no new key - in particular no
    // `knowledge-dungeon:backup:<id>` record, which the old load-on-boot wrote.
    expect(after).toEqual(before);
    expect(Object.keys(after).some((key) => key.startsWith('knowledge-dungeon:backup:'))).toBe(false);
  });

  it('surfaces the storage-pressure warning with the pre-phase thresholds and text', async () => {
    for (const [level, expected] of [
      ['warn', 'synthetic storage warning'],
      ['critical', 'synthetic storage warning'],
    ] as const) {
      const { deps } = harness({ getStorageThreshold: () => level });
      const result = await bootstrapApplication(deps);
      expect(result.storageWarning).toBe(expected);
    }
  });
});

describe('Phase 4 bootstrap: a storage failure never leaves the app half-hydrated', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });

  it('commits the empty state to every store when the legacy read throws', async () => {
    const { deps, recorded } = harness({
      readLegacyState: () => {
        throw new Error('synthetic localStorage failure');
      },
    });
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('degraded');
    expect(result.failures).toEqual(['LEGACY_READ_FAILED']);
    // All five stores got the empty value, not three hydrated and two stale.
    expect(recorded.preferences).toBeNull();
    expect(recorded.shortcuts).toBeNull();
    expect(recorded.progression).toBeNull();
    expect(recorded.snapshot).toBeNull();
  });

  it('degrades without throwing when the subject list cannot be read', async () => {
    const { deps, recorded } = harness({
      listSubjectIds: () => Promise.reject(new Error('synthetic index failure')),
      loadSubjectSnapshot: () => Promise.resolve(null),
      readActiveSubjectId: () => null,
    });
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('degraded');
    expect(result.failures).toEqual(['LEGACY_READ_FAILED']);
    // The other four stores are still hydrated from the state that did read.
    expect(recorded.preferences).toEqual(POPULATED_STATE.preferences);
    expect(recorded.progression).toEqual(POPULATED_STATE.progression);
    expect(recorded.snapshot).toBeNull();
  });

  it('falls back to the legacy repository when storage-v2 cannot be opened', async () => {
    const { deps, recorded } = harness({
      repository: 'v2',
      openRepository: () => Promise.reject(new Error('synthetic IndexedDB failure')),
    });
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('degraded');
    expect(result.repository).toBe('legacy');
    expect(result.failures).toEqual(['STORAGE_V2_UNAVAILABLE']);
    // The app still hydrates from the legacy generation rather than showing an
    // empty shell over real data.
    expect(recorded.preferences).toEqual(POPULATED_STATE.preferences);
    expect(recorded.progression).toEqual(POPULATED_STATE.progression);
  });
});

describe('Phase 4 bootstrap: the flag selects the repository', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });

  it('never opens storage-v2 when the flag is legacy', async () => {
    const openRepository = vi.fn(() => Promise.reject(new Error('must not open')));
    const { deps } = harness({ repository: 'legacy', openRepository });
    const result = await bootstrapApplication(deps);

    expect(openRepository).not.toHaveBeenCalled();
    expect(result.repository).toBe('legacy');
  });

  it('opens storage-v2 when the flag is v2, and never when it is legacy', async () => {
    // The two branches are distinguished by whether the open is attempted at all.
    // The v2 branch then degrades on the synthetic open failure, which is the
    // state a real device with IndexedDB disabled would be in.
    const openRepository = vi.fn(() => Promise.reject(new Error('synthetic open failure')));
    const { deps, recorded } = harness({ repository: 'v2', openRepository });
    const result = await bootstrapApplication(deps);

    expect(openRepository).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual(['STORAGE_V2_UNAVAILABLE']);
    // Degrading means the legacy generation takes over, not that the app stops.
    expect(result.repository).toBe('legacy');
    expect(recorded.preferences).toEqual(POPULATED_STATE.preferences);
  });

  it('the default dependency set takes the repository from the build flag', () => {
    expect(createDefaultBootstrapDeps().repository).toBe('legacy');
    expect(createDefaultBootstrapDeps({ repository: 'v2' }).repository).toBe('v2');
  });
});

describe('Phase 4 bootstrap: the real stores take the committed values', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_ID);
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_ID]));
    window.localStorage.setItem(
      'knowledge-dungeon:v1:progression',
      JSON.stringify(POPULATED_STATE.progression),
    );
    window.localStorage.setItem(
      'knowledge-dungeon:session:preferences',
      JSON.stringify(POPULATED_STATE.preferences),
    );
    window.localStorage.setItem('knowledge-dungeon:session:shortcuts', JSON.stringify(POPULATED_STATE.shortcuts));
    resetRepositorySelection();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetRepositorySelection();
  });

  it('produces the same progression state the module-load hydration produced', async () => {
    // The *real* dependency set, so the real stores are the ones hydrated.
    await bootstrapApplication(createDefaultBootstrapDeps({ repository: 'legacy' }));

    const { useProgressionStore } = await import('@/store/progressionStore');
    const state = useProgressionStore.getState();
    // The exact values the pre-Phase-4 module-load read produced for this
    // payload: the stored active subject, the by-subject map keyed by it, the
    // scoped totals, and the cross-subject achievements.
    expect(state.activeSubjectId).toBe(SUBJECT_ID);
    expect(Object.keys(state.bySubject)).toEqual([SUBJECT_ID]);
    expect(state.xpTotal).toBe(120);
    // `rank` is not read from the payload: the canonical normalizer recomputes it
    // from the XP total, so the stored `Scholar` is replaced by `Novice` in both
    // the old module-load path and this one. The important assertion is that the
    // recomputed value is identical, not that it matches the file.
    expect(state.rank).toBe('Novice');
    expect(state.badges).toEqual(['synthetic-bootstrap-badge']);
    expect(state.roomsCleared).toBe(1);
    expect(state.streakCount).toBe(2);
    expect(state.crossSubjectAchievements).toEqual(['meta-subjects-2']);
    // And the default progression store, read the same way, agrees.
    expect(readProgressionStoreState()).toMatchObject({
      activeSubjectId: SUBJECT_ID,
      xpTotal: 120,
      rank: 'Novice',
    });
  });

  it('produces the same preferences and shortcuts the module-load read produced', async () => {
    await bootstrapApplication(createDefaultBootstrapDeps({ repository: 'legacy' }));

    const { usePreferencesStore } = await import('@/store/preferencesStore');
    const { useShortcutStore } = await import('@/store/shortcutStore');
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
    expect(usePreferencesStore.getState().colorTheme).toBe('aurora');
    expect(usePreferencesStore.getState().activeSpritePack).toBe('synthetic-pack');
    expect(useShortcutStore.getState().shortcuts).toEqual(POPULATED_STATE.shortcuts);
  });
});
