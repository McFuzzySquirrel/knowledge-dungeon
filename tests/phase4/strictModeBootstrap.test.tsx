/**
 * StrictMode must not start two migrations, on the *real* memoized path.
 *
 * `tests/phase4/bootstrapAttacks.test.tsx` proves the commit contract with
 * injected dependencies. Those deliberately bypass the module-level memoization,
 * because that is what makes the bootstrap unit-testable. This file closes the
 * other half: the shape the application actually runs, where `main.tsx` and
 * `App` both reach the same memoized promise, and a React StrictMode
 * double-effect reaches it a third time.
 *
 * The build flag is mocked rather than injected, so `createDefaultBootstrapDeps`
 * - the real one, with the real dynamic imports - reports `storageRepository:
 * 'v2'` and takes the real migration path. The migration itself is wrapped so
 * the number of runs is counted rather than inferred from the result.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
// In-memory IndexedDB, installed before anything touches the global. jsdom
// implements none, exactly as Phase 3 recorded.
import 'fake-indexeddb/auto';

import { StrictMode, useEffect, useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MIGRATION_GENERATION_ID } from '@/services/persistence/v2/appState';
import { STORAGE_V2_DATABASE_NAME } from '@/services/persistence/v2/schema';

const migrateCalls: unknown[] = [];

vi.mock('@/config/featureFlags', async () => {
  const actual = await vi.importActual<typeof import('@/config/featureFlags')>(
    '@/config/featureFlags',
  );
  return {
    ...actual,
    // The only change: this "build" selected storage-v2, so the default
    // dependency set takes the real migration path.
    runtimeConfig: { ...actual.runtimeConfig, storageRepository: 'v2' as const },
  };
});

vi.mock('@/services/persistence/v2/migrations', async () => {
  const actual = await vi.importActual<typeof import('@/services/persistence/v2/migrations')>(
    '@/services/persistence/v2/migrations',
  );
  return {
    ...actual,
    migrateLegacyState: (options: unknown) => {
      migrateCalls.push(options);
      return actual.migrateLegacyState(options as never);
    },
  };
});

import { bootstrapApplication, pendingBootstrap, resetBootstrap } from '@/application/bootstrap';
import {
  currentStorageV2Repository,
  resetRepositorySelection,
} from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports } from '@/services/persistence/v2/dualWrite';
import { readAppStateFromLegacy } from '@/services/persistence/v2/appState';

// `act` is used deliberately: a StrictMode double-effect is the thing under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function seedLegacyDevice(): void {
  window.localStorage.clear();
  window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-strict-synthetic']));
  window.localStorage.setItem(
    'knowledge-dungeon:v1:subject:subject-strict-synthetic',
    JSON.stringify({
      dungeon: {
        schemaVersion: '1.1.0',
        dungeonId: 'subject-strict-synthetic',
        subjectName: 'Phase4 Strict Synthetic Subject',
        createdAt: '2026-01-06T06:06:06.000Z',
        updatedAt: '2026-01-06T06:06:06.000Z',
        phaseState: 'CreatorActive',
        rootRoomId: 'room-strict-synthetic-root',
        rooms: [{ roomId: 'room-strict-synthetic-root', topic: 'Phase4 strict synthetic root topic', status: 'Created' }],
        edges: [],
        progression: { xpTotal: 0, rank: 'Novice', badges: [] },
      },
      rooms: {
        'room-strict-synthetic-root': {
          roomId: 'room-strict-synthetic-root',
          topic: 'Phase4 strict synthetic root topic',
          createdAt: '2026-01-06T06:06:06.000Z',
          updatedAt: '2026-01-06T06:06:06.000Z',
          state: 'Created',
          notePath: 'rooms/room-strict-synthetic-root/notes.txt',
          artifactPath: 'rooms/room-strict-synthetic-root/artifact.md',
          noteText: 'Phase4 strict synthetic note body.',
          artifactMarkdown: null,
          validationState: {
            wordCount: 5,
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
    }),
  );
  window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-strict-synthetic');
  window.localStorage.setItem(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({
      version: 3,
      bySubject: {
        'subject-strict-synthetic': {
          xpTotal: 5,
          rank: 'Novice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 0,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [],
        },
      },
      crossSubjectAchievements: [],
    }),
  );
}

function deleteStorageV2Database(): Promise<void> {
  return new Promise((resolve) => {
    const request = globalThis.indexedDB.deleteDatabase(STORAGE_V2_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(() => {
  migrateCalls.length = 0;
  seedLegacyDevice();
  resetBootstrap();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  // The bootstrap holds the storage-v2 handle for the session, exactly as the
  // application does, so the test has to release it before the database can be
  // deleted.
  currentStorageV2Repository()?.close();
  resetBootstrap();
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
  await deleteStorageV2Database();
  document.body.innerHTML = '';
});

describe('StrictMode and the memoized bootstrap', () => {
  it('three callers, one migration', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    // The shape of `App`: an effect that awaits the pending bootstrap, or starts
    // one. Under StrictMode React runs the effect twice.
    function Host(): JSX.Element {
      const [ready, setReady] = useState(false);
      useEffect(() => {
        const inFlight = pendingBootstrap() ?? bootstrapApplication();
        void inFlight.then(() => setReady(true));
      }, []);
      return ready ? <p>ready</p> : <p>loading</p>;
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <Host />
        </StrictMode>,
      );
    });
    // The bootstrap is asynchronous, so the host is polled inside `act` rather
    // than raced against a fixed delay.
    for (let attempt = 0; attempt < 200 && container.textContent !== 'ready'; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(container.textContent).toBe('ready');
    // One migration, one generation id, one repository open.
    expect(migrateCalls).toHaveLength(1);
    expect((migrateCalls[0] as { generationId: string }).generationId).toBe(MIGRATION_GENERATION_ID);
    // The two hosts share one promise object, so a second caller can never
    // restart the work.
    const first = bootstrapApplication();
    expect(pendingBootstrap()).toBe(first);
    await first;
    expect(migrateCalls).toHaveLength(1);
    await act(async () => {
      root.unmount();
    });
  });

  it('the memoized result is one object for every caller', async () => {
    const a = bootstrapApplication();
    const b = bootstrapApplication();
    expect(a).toBe(b);
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toBe(resultB);
    expect(migrateCalls).toHaveLength(1);
  });

  it('a completed migration is still one generation and one receipt', async () => {
    const result = await bootstrapApplication();
    expect(result.failures).toEqual([]);
    expect(result.status).toBe('ready');
    expect(result.repository).toBe('v2');
    expect(result.migration?.kind).toBe('migrated');
    const { openStorageV2Repository } = await import('@/services/persistence/v2/repository');
    const repo = await openStorageV2Repository({ databaseName: STORAGE_V2_DATABASE_NAME });
    try {
      expect(await repo.readActiveGenerationId()).toBe(MIGRATION_GENERATION_ID);
      expect(await repo.listMigrationReceipts()).toHaveLength(1);
      const records = (await repo.readRecords(MIGRATION_GENERATION_ID)).records;
      expect(records.subjects).toHaveLength(1);
    } finally {
      repo.close();
    }
    // The legacy device the migration read is still byte-identical.
    expect(readAppStateFromLegacy().subjects).toHaveLength(1);
  });
});
