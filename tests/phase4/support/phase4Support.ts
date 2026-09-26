/**
 * Shared setup for the independent Phase 4 verification suite.
 *
 * Nothing here is imported by `vitest.setup.ts`: the IndexedDB shim must not
 * reach the rest of the suite, which characterizes real behaviour against real
 * `localStorage`.
 *
 * Every fixture value is synthetic and self-describing. The only host named
 * anywhere in this directory is the reserved `example.invalid`.
 */
import 'fake-indexeddb/auto';

import {
  openTestRepository,
  deleteTestDatabase,
  MIGRATION_NOW,
} from '../../migrations/support/storageV2TestSupport';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { SubjectSnapshot } from '@/core/validation/persistence';

export { MIGRATION_NOW as NOW };

export const SUBJECT_ID = 'subject-phase4-independent';
export const GENERATION_ID = 'gen-phase4-independent-0001';

export const SUBJECT_NAME = 'Phase4 Independent Synthetic Subject';
export const ROOT_ROOM_ID = 'room-phase4-independent-root';
export const ROOT_ROOM_TOPIC = 'Phase4 independent synthetic root topic';

export const PREFERENCES_KEY = 'knowledge-dungeon:session:preferences';
export const SHORTCUTS_KEY = 'knowledge-dungeon:session:shortcuts';
export const SESSIONS_KEY = 'knowledge-dungeon:v1:sessions';
export const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
export const SUBJECT_INDEX_KEY = 'knowledge-dungeon:v1:subjects';
export const ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';

/** A complete, structurally valid synthetic 1.1.0 subject snapshot. */
export function syntheticSnapshot(overrides: Partial<SubjectSnapshot> = {}): SubjectSnapshot {
  const base = {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName: SUBJECT_NAME,
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:09:05.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: ROOT_ROOM_ID,
      rooms: [{ roomId: ROOT_ROOM_ID, topic: ROOT_ROOM_TOPIC, status: 'Created' }],
      edges: [],
      tagIndex: {},
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      [ROOT_ROOM_ID]: {
        roomId: ROOT_ROOM_ID,
        topic: ROOT_ROOM_TOPIC,
        createdAt: '2026-01-04T03:04:05.000Z',
        updatedAt: '2026-01-04T03:09:05.000Z',
        state: 'Created',
        notePath: `rooms/${ROOT_ROOM_ID}/notes.txt`,
        artifactPath: `rooms/${ROOT_ROOM_ID}/artifact.md`,
        noteText: 'Phase4 independent synthetic note body.',
        artifactMarkdown: null,
        validationState: {
          wordCount: 3,
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
        sm2: null,
        artifacts: [],
        attachments: [],
      },
    },
  } as unknown as SubjectSnapshot;
  return { ...base, ...overrides } as SubjectSnapshot;
}

/** A legacy key set a pre-Phase-4 build would really have written. */
export function seedLegacyKeys(): void {
  window.localStorage.setItem(SUBJECT_INDEX_KEY, JSON.stringify([SUBJECT_ID]));
  window.localStorage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_ID}`, JSON.stringify(syntheticSnapshot()));
  window.localStorage.setItem(ACTIVE_SUBJECT_KEY, SUBJECT_ID);
  window.localStorage.setItem(
    PROGRESSION_KEY,
    JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: 11,
          rank: 'Novice',
          badges: ['synthetic-phase4-seed-badge'],
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
  window.localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'dark', activeSpritePack: null }),
  );
  window.localStorage.setItem(
    SHORTCUTS_KEY,
    JSON.stringify([
      { labelKey: 'shortcuts.toggleHelp', key: '/', ctrlKey: false, shiftKey: false },
      { labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false },
      { labelKey: 'shortcuts.toggleInfoPanel', key: 'i', ctrlKey: false, shiftKey: false },
    ]),
  );
  window.localStorage.setItem(
    SESSIONS_KEY,
    JSON.stringify([
      {
        sessionId: 'session-phase4-seed',
        subjectId: SUBJECT_ID,
        startedAt: '2026-01-04T03:00:00.000Z',
        endedAt: '2026-01-04T03:30:00.000Z',
        roomsVisited: [ROOT_ROOM_ID],
        notesSubmitted: 1,
        reviewsCompleted: 0,
        xpEarned: 11,
      },
    ]),
  );
  window.localStorage.setItem('knowledge-dungeon:locale', 'en');
}

/** Every legacy key, as a comparable object, in storage order. */
export function legacyKeySet(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index) as string;
    out[key] = window.localStorage.getItem(key) as string;
  }
  return out;
}

export async function openRepo(name: string): Promise<StorageV2Repository> {
  return openTestRepository(`kd-phase4-independent-${name}`, MIGRATION_NOW);
}

export async function dropRepo(name: string): Promise<void> {
  await deleteTestDatabase(`kd-phase4-independent-${name}`);
}

/** Names of every database the origin currently holds, in sorted order. */
export async function openDatabaseNames(): Promise<string[]> {
  const factory = globalThis.indexedDB as IDBFactory & {
    databases?: () => Promise<{ name?: string }[]>;
  };
  if (typeof factory.databases !== 'function') return [];
  const found = await factory.databases();
  return found
    .map((entry) => entry.name ?? '')
    .filter((name) => name.length > 0)
    .sort();
}

/** The store names and record count of one database, read raw. */
export async function rawStoreSummary(
  databaseName: string,
): Promise<{ storeNames: string[]; counts: Record<string, number> } | null> {
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = globalThis.indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  if (!db) return null;
  const storeNames = [...db.objectStoreNames].sort();
  const counts: Record<string, number> = {};
  for (const name of storeNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await new Promise<any[]>((resolve) => {
      const request = db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => resolve([]);
    });
    counts[name] = rows.length;
  }
  db.close();
  return { storeNames, counts };
}
