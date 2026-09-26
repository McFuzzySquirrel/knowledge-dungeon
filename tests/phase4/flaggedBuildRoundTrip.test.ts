/**
 * Phase 4 independent verification: what the *flagged* build actually hydrates.
 *
 * The default build reads `knowledge-dungeon:v1:progression`, whose envelope
 * carries `"version": 3`. The flagged build does not read that key: it
 * reconstructs an envelope from the active generation
 * (`progressionEnvelopeFrom` in `src/services/persistence/v2/appState.ts`) and
 * hands that to the same canonical normalizer. A round trip through a reader is
 * only lossless if the reader emits a payload its own normalizer still
 * recognises, so this file holds the two smallest user journeys that can expose
 * a difference, plus the evidence table for every persisted store.
 *
 * Findings in this file are QA probes. Nothing here modifies the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUBJECT_ID,
  NOW,
  seedLegacyKeys,
  openRepo,
  dropRepo,
  PREFERENCES_KEY,
  SHORTCUTS_KEY,
  legacyKeySet,
  syntheticSnapshot,
} from './support/phase4Support';

import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import {
  resetRepositorySelection,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import {
  readAppStateFromStorageV2,
  progressionEnvelopeFrom,
} from '@/services/persistence/v2/appState';
import { clearDualWriteReports, dualWriteReports } from '@/services/persistence/v2/dualWrite';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useShortcutStore } from '@/store/shortcutStore';
import { useProgressionStore } from '@/store/progressionStore';
import { normalizeProgressionRecord } from '@/core/progression/canonicalProgression';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

let repository: StorageV2Repository | null = null;
let name = '';

/** Migrate the seeded legacy device and select storage-v2, as the bootstrap does. */
async function flaggedDevice(suffix: string): Promise<StorageV2Repository> {
  name = suffix;
  const repo = await openRepo(suffix);
  repository = repo;
  const outcome = await migrateLegacyState({
    repository: repo,
    generationId: `gen-phase4-independent-${suffix}`,
    now: NOW,
    clock: { now: () => NOW },
  });
  expect(outcome.report.status, `migration outcome for ${suffix}`).toBe('migrated');
  selectStorageV2Repository(repo);
  return repo;
}

/** Read the app-shaped state the flagged bootstrap would read, and hydrate. */
async function reloadInFlaggedBuild(): Promise<void> {
  const repo = repository as StorageV2Repository;
  const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
  usePreferencesStore.getState().hydratePreferences(state.preferences);
  useShortcutStore.getState().hydrateShortcuts(state.shortcuts);
  useProgressionStore.getState().hydrateProgression(state.progression);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Wait for a condition, so a fire-and-forget write is observed, not raced. */
async function waitFor(read: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function legacyProgression(): { bySubject: Record<string, { badges: string[]; xpTotal: number }> } {
  return JSON.parse(window.localStorage.getItem('knowledge-dungeon:v1:progression') as string) as {
    bySubject: Record<string, { badges: string[]; xpTotal: number }>;
  };
}

beforeEach(() => {
  window.localStorage.clear();
  seedLegacyKeys();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  if (name) await dropRepo(name);
  name = '';
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

describe('QA defect 1: the flagged build loses every progression record on reload', () => {
  it('reads the envelope the storage-v2 reader emits as one flat empty record', async () => {
    // The envelope the storage-v2 reader builds has no `version` marker, so the
    // canonical normalizer - the same one the store has always used - does not
    // recognise its own `bySubject` map.
    const envelope = progressionEnvelopeFrom([
      {
        subjectId: SUBJECT_ID,
        sourceVersion: 3,
        rank: 'Novice',
        xpTotal: 11,
        bySubject: {
          [SUBJECT_ID]: {
            xpTotal: 11,
            rank: 'Novice',
            badges: ['synthetic-phase4-seed-badge'],
            fishCollection: [],
          },
        },
        crossSubjectAchievements: [],
      },
      {
        subjectId: 'subject-phase4-independent-second',
        sourceVersion: 3,
        rank: 'Novice',
        xpTotal: 5,
        bySubject: {
          'subject-phase4-independent-second': {
            xpTotal: 5,
            rank: 'Novice',
            badges: ['synthetic-phase4-second-subject-badge'],
            fishCollection: [],
          },
        },
        crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
      },
    ] as never);

    const canonical = normalizeProgressionRecord(envelope, { activeSubjectId: SUBJECT_ID });

    // Expected: the per-subject map survives, and the cross-subject achievements
    // with it. Observed: the whole envelope is filed as a flat record for the
    // active subject, every badge is gone, and the real map is buried in
    // `extraFields` where no reader looks.
    expect({
      sourceVersion: canonical.sourceVersion,
      subjectIds: Object.keys(canonical.bySubject).sort(),
      xpBySubject: Object.fromEntries(
        Object.entries(canonical.bySubject).map(([id, record]) => [id, record.xpTotal]),
      ),
      badgesBySubject: Object.fromEntries(
        Object.entries(canonical.bySubject).map(([id, record]) => [id, record.badges]),
      ),
      crossSubjectAchievements: canonical.crossSubjectAchievements,
    }).toEqual({
      sourceVersion: 3,
      subjectIds: ['subject-phase4-independent', 'subject-phase4-independent-second'],
      xpBySubject: {
        'subject-phase4-independent': 11,
        'subject-phase4-independent-second': 5,
      },
      badgesBySubject: {
        'subject-phase4-independent': ['synthetic-phase4-seed-badge'],
        'subject-phase4-independent-second': ['synthetic-phase4-second-subject-badge'],
      },
      crossSubjectAchievements: ['synthetic-phase4-cross-achievement'],
    });
  });

  it('a reload in the flagged build keeps every progression record', async () => {
    await flaggedDevice('progression-loss');
    await reloadInFlaggedBuild();

    // The generation really holds the learner's progression.
    const repo = repository as StorageV2Repository;
    const active = await repo.readActiveGenerationId();
    const stored = (await repo.readRecords(active as string)).records.progression;
    expect(JSON.stringify(stored)).toContain('synthetic-phase4-seed-badge');

    // What the flagged build hydrates from it.
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
    ]);
    expect(useProgressionStore.getState().xpTotal).toBe(11);
  });

  it('the next progression write persists the change without erasing the rest', async () => {
    await flaggedDevice('progression-permanent');
    await reloadInFlaggedBuild();
    // Previously: the reload hydrated an empty store, so this first assertion
    // held and proved the loss. It now proves the reload kept the record, and
    // every assertion below would fail if the envelope were flattened again.
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.badges ?? []).toContain(
      'synthetic-phase4-seed-badge',
    );

    // One ordinary learner action after the reload: award a badge.
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-after-reload-badge');
    // Waited for, not raced: the write is a fire-and-forget into IndexedDB, so a
    // fixed settle budget is a race on a loaded machine.
    await waitFor(
      () =>
        (legacyProgression().bySubject[SUBJECT_ID]?.badges ?? []).includes(
          'synthetic-phase4-after-reload-badge',
        ),
      'the awarded badge to reach the legacy mirror',
    );

    // The badge is saved, and so is everything that was already there.
    const legacy = legacyProgression();
    expect(legacy.bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
      'synthetic-phase4-after-reload-badge',
    ]);
    expect(legacy.bySubject[SUBJECT_ID]?.xpTotal).toBe(11);

    // And the generation agrees, so a roll-forward cannot lose it either.
    const repo = repository as StorageV2Repository;
    const active = await repo.readActiveGenerationId();
    const stored = (await repo.readRecords(active as string)).records.progression;
    expect(JSON.stringify(stored)).toContain('synthetic-phase4-seed-badge');
    expect(JSON.stringify(stored)).toContain('synthetic-phase4-after-reload-badge');
  });
});

describe('QA defect 2: the flagged build loses a preference change on reload', () => {
  it('a colour-theme change is still there after a reload', async () => {
    await flaggedDevice('prefs');
    await reloadInFlaggedBuild();
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');

    // The learner changes the theme on the flagged device.
    usePreferencesStore.getState().setColorTheme('colorful');

    // The legacy mirror is written, so a *rollback* build would still see it.
    expect(
      (JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) as string) as { colorTheme: string })
        .colorTheme,
    ).toBe('colorful');
    // The change is not reported as a problem. It is not silent either: a
    // successful primary write is reported as `written`, but only once the
    // asynchronous write resolves, so at this instant there is no report for
    // `preferences` at all. (`publishPreferencesToActiveGeneration` used to have
    // no caller at all, so the generation never learned about the change.)
    expect(dualWriteReports().filter((report) => report.operation === 'preferences')).toEqual([]);

    await settle();
    expect(
      dualWriteReports().filter((report) => report.operation === 'preferences'),
      'the preference change was published to the generation and reported',
    ).toEqual([{ sequence: expect.any(Number), operation: 'preferences', outcome: 'written', code: null }]);
    await reloadInFlaggedBuild();

    // The flagged build reads preferences from the active generation, where the
    // change is now published.
    expect(usePreferencesStore.getState().colorTheme).toBe('colorful');
  });
});

describe('Phase 4 QA: the stores that do round-trip, proved rather than assumed', () => {
  it('a shortcut rebind survives a flagged-build reload', async () => {
    await flaggedDevice('round-trip');
    await reloadInFlaggedBuild();

    useShortcutStore.getState().setShortcutKey(1, 'v');
    await waitFor(
      () =>
        (JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY) as string) as { key: string }[]).some(
          (binding) => binding.key === 'v',
        ),
      'the shortcut mirror write',
    );
    const rebound = useShortcutStore
      .getState()
      .shortcuts.find((binding) => binding.key === 'v')?.labelKey;
    const { saveSubjectSnapshot } = await import('@/services/persistence/subjectPersistence');
    await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    await settle();
    await reloadInFlaggedBuild();

    expect(
      useShortcutStore.getState().shortcuts.find((binding) => binding.key === 'v')?.labelKey,
    ).toBe(rebound);
    const { loadSubjectSnapshot } = await import('@/services/persistence/subjectPersistence');
    expect((await loadSubjectSnapshot(SUBJECT_ID))?.dungeon.subjectName).toBe(
      'Phase4 Independent Synthetic Subject',
    );
  });

  it('the two repositories hydrate shortcuts in the same order', async () => {
    // `setShortcutKey` is index-based and the settings list is rendered in
    // store order, so the order the store hydrates in is a user-visible
    // property: if the two repositories disagree, index 1 binds a different
    // action before and after a reload in one of them.
    const { DEFAULT_SHORTCUTS, readPersistedShortcuts } = await import('@/store/shortcutStore');
    await flaggedDevice('shortcut-order');
    await reloadInFlaggedBuild();
    const flaggedOrder = useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey);

    resetRepositorySelection();
    useShortcutStore.getState().hydrateShortcuts(readPersistedShortcuts());
    const legacyOrder = useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey);

    expect(flaggedOrder).toEqual(legacyOrder);
    expect(legacyOrder).toEqual(DEFAULT_SHORTCUTS.map((binding) => binding.labelKey));
  });

  it('a rollback build reads the same device through the legacy keys alone', async () => {
    await flaggedDevice('rollback-read');
    useShortcutStore.getState().setShortcutKey(2, 'k');
    usePreferencesStore.getState().setActiveSpritePack('synthetic-pack');
    await waitFor(
      () =>
        (
          JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY) as string) as { key: string }[]
        )[2]?.key === 'k',
      'the shortcut mirror write',
    );

    // `VITE_STORAGE_REPOSITORY=legacy`: no handle, no generation, no read from
    // IndexedDB at all.
    resetRepositorySelection();
    const { listSubjectIds, loadSubjectSnapshot, STORAGE_KEYS } = await import(
      '@/services/persistence/subjectPersistence'
    );
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);
    expect((await loadSubjectSnapshot(SUBJECT_ID))?.dungeon.subjectName).toBe(
      'Phase4 Independent Synthetic Subject',
    );
    const keys = legacyKeySet();
    expect(Object.keys(keys)).toEqual(
      expect.arrayContaining([
        STORAGE_KEYS.subject(SUBJECT_ID),
        STORAGE_KEYS.subjectIndex,
        STORAGE_KEYS.progression,
        PREFERENCES_KEY,
        SHORTCUTS_KEY,
      ]),
    );
  });
});
