/**
 * Exit criteria 2 and 3: repeated migration, and the rollback mirror.
 *
 * Criterion 2 - "Migration can run repeatedly without duplication". Attacked
 * here: two handles on one database at the same time, three sequential runs, a
 * run interrupted and retried, a re-run after success, a run after the active
 * generation advanced, and a run whose generation id differs. For each: one
 * generation per completed migration, one receipt, no duplicated subject or
 * session record, and a byte-identical legacy key set.
 *
 * Criterion 3 - "Phaser rollback can still read mirrored changes". With the flag
 * on, a subject, progression, preferences, shortcuts, sessions, and an
 * attachment are written; the repository is then switched to `legacy` and every
 * one of them must still be readable, in the bytes a pre-Phase-4 build would
 * parse. The mirror is then attacked: a quota-exhausted `localStorage` and a
 * `localStorage` that throws on every write. And the reverse: a device written
 * with the flag off must have no storage-v2 database at all - proved by reading
 * the browser's own database list and, for a database that does exist, its raw
 * store names and record counts.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUBJECT_ID,
  NOW,
  seedLegacyKeys,
  openRepo,
  dropRepo,
  legacyKeySet,
  syntheticSnapshot,
  openDatabaseNames,
  rawStoreSummary,
  PREFERENCES_KEY,
  SHORTCUTS_KEY,
  SESSIONS_KEY,
  PROGRESSION_KEY,
  ROOT_ROOM_ID,
} from './support/phase4Support';

import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import {
  resetRepositorySelection,
  selectLegacyRepository,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports, dualWriteReports } from '@/services/persistence/v2/dualWrite';
import { useProgressionStore } from '@/store/progressionStore';
import { useShortcutStore } from '@/store/shortcutStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { startSession, endCurrentSession, setSessionSource } from '@/services/sessionTracker';
import {
  addDeviceLocalRoomAttachment,
} from '@/services/persistence/deviceAttachments';
import {
  deleteDeviceLocalAttachmentDatabase,
  closeDeviceLocalAttachmentStore,
  DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME,
} from '@/services/persistence/v2/attachmentBytes';
import {
  listSubjectIds,
  loadSubjectSnapshot,
  saveSubjectSnapshot,
  STORAGE_KEYS,
} from '@/services/persistence/subjectPersistence';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const STORAGE_V2_DATABASE_NAME = 'knowledge-dungeon-storage-v2';

/** A picked file, exactly the shape a browser file input produces. */
function pickedFile(bytes: readonly number[], name: string, type = 'image/png'): Blob & { name?: string } {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  Object.defineProperty(blob, 'name', { value: name, configurable: true });
  return blob as Blob & { name?: string };
}

/** A repository proxy that counts the calls a re-run would make. */
function countingRepository(
  inner: StorageV2Repository,
  calls: Record<string, number>,
): StorageV2Repository {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const key = String(property);
      return (...args: unknown[]) => {
        calls[key] = (calls[key] ?? 0) + 1;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

let repository: StorageV2Repository | null = null;
const openNames: string[] = [];
const handles: StorageV2Repository[] = [];

async function open(suffix: string): Promise<StorageV2Repository> {
  openNames.push(suffix);
  const repo = await openRepo(suffix);
  handles.push(repo);
  return repo;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitFor(read: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  window.localStorage.clear();
  seedLegacyKeys();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  setSessionSource(null);
  closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase().catch(() => undefined);
  // Every handle is closed before its database is deleted: an open connection
  // makes `deleteDatabase` block forever under the shim, which would turn a
  // product failure into a hook timeout.
  for (const handle of handles.splice(0)) handle.close();
  repository?.close();
  repository = null;
  for (const suffix of openNames.splice(0)) await dropRepo(suffix);
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

describe('Exit criterion 2: a migration can run repeatedly without duplication', () => {
  it('two handles migrating at once produce one generation, one receipt, and one record set', async () => {
    const before = legacyKeySet();
    const first = await open('concurrent-1');
    // Both handles name the *same* physical database, as two tabs would.
    const shared = await open('concurrent-1');
    repository = first;

    const options = {
      generationId: 'gen-phase4-criterion2',
      now: NOW,
      clock: { now: () => NOW },
    };
    const [a, b] = await Promise.all([
      migrateLegacyState({ repository: first, ...options }),
      migrateLegacyState({ repository: shared, ...options }),
    ]);
    shared.close();

    // Whatever the interleaving, both runs agree on the outcome.
    expect([a.report.status, b.report.status].sort()).toEqual(['migrated', 'migrated']);
    const active = await first.readActiveGenerationId();
    expect(active).toBe('gen-phase4-criterion2');
    const records = (await first.readRecords(active as string)).records;
    expect(records.subjects.map((envelope) => envelope.recordId)).toEqual([SUBJECT_ID]);
    expect(records.sessions).toHaveLength(1);
    expect(await first.listMigrationReceipts()).toHaveLength(1);
    expect((await first.listMigrationReceipts())[0]?.status).toBe('activated');
    // The registry holds one entry, and the legacy device is untouched.
    const registry = (await first.readGeneration('gen-phase4-criterion2'))?.descriptor;
    expect(registry?.status).toBe('active');
    expect(legacyKeySet()).toEqual(before);
  });

  it('three sequential runs, and a re-run after success, add nothing', async () => {
    const before = legacyKeySet();
    const inner = await open('triple');
    const calls: Record<string, number> = {};
    const repo = countingRepository(inner, calls);
    repository = inner;
    const options = { generationId: 'gen-phase4-triple', now: NOW, clock: { now: () => NOW } };

    const runs = [
      await migrateLegacyState({ repository: repo, ...options }),
      await migrateLegacyState({ repository: repo, ...options }),
      await migrateLegacyState({ repository: repo, ...options }),
    ];
    for (const run of runs) expect(run.report.status).toBe('migrated');
    // Exactly one run staged a generation. The other two short-circuited, so
    // "no duplication" is a count of real work, not of a stable payload.
    expect(calls.stageGeneration).toBe(1);
    expect(calls.activateGeneration).toBe(1);
    expect(calls.writeMigrationReceipt).toBe(1);
    expect(new Set(runs.map((run) => run.report.receiptId)).size).toBe(1);
    expect(await inner.listMigrationReceipts()).toHaveLength(1);
    const active = await inner.readActiveGenerationId();
    const records = (await inner.readRecords(active as string)).records;
    expect(records.subjects).toHaveLength(1);
    expect(records.sessions).toHaveLength(1);
    expect(legacyKeySet()).toEqual(before);
  });

  it('an interrupted run is retried, and the retry is a clean single migration', async () => {
    const before = legacyKeySet();
    const repo = await open('interrupted');
    repository = repo;
    const options = { generationId: 'gen-phase4-interrupted', now: NOW, clock: { now: () => NOW } };

    // Fail after the stage commit, which is the state the discard path exists for.
    const failed = await migrateLegacyState({
      repository: repo,
      ...options,
      // After the stage commit, so the retry has an abandoned `staged`
      // generation to reclaim.
      seams: { onStage: (stage) => { if (stage === 'validate') throw new Error('qa injected'); } },
    });
    expect(failed.report.status).toBe('recovery-required');
    expect(await repo.readActiveGenerationId()).toBeNull();

    const retried = await migrateLegacyState({ repository: repo, ...options });
    expect(retried.report.status).toBe('migrated');
    expect(retried.report.activated).toBe(true);
    const records = (await repo.readRecords('gen-phase4-interrupted')).records;
    expect(records.subjects).toHaveLength(1);
    expect(records.sessions).toHaveLength(1);
    expect(await repo.listMigrationReceipts()).toHaveLength(1);
    expect(legacyKeySet()).toEqual(before);
  });

  it('a run after the active generation advanced does not steal the pointer', async () => {
    const repo = await open('advanced');
    repository = repo;
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-first',
      now: NOW,
      clock: { now: () => NOW },
    });
    // A later phase's generation becomes active.
    await repo.stageGeneration({ generationId: 'gen-phase4-later', source: 'subject-import', records: {} });
    await repo.activateGeneration('gen-phase4-later');
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-later');

    // Re-running the *same* migration id is a no-op, and the pointer stays put.
    const again = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-first',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(again.report.status).toBe('migrated');
    expect(again.report.activated).toBe(false);
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-later');

    // A *different* migration id migrates again and does take the pointer, which
    // is the only case in which the previous generation is retained as
    // `superseded` rather than deleted.
    const second = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-second',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(second.report.status).toBe('migrated');
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-second');
    expect((await repo.readGeneration('gen-phase4-first'))?.descriptor?.status).toBe('superseded');
    const later = (await repo.readRecords('gen-phase4-later')).records.subjects;
    expect(later).toEqual([]);
  });
});

describe('Exit criterion 3: a rollback build reads everything the flagged build wrote', () => {
  it('the mirrored progression keeps the value the flagged build would have lost', async () => {
    // Regression, formerly red. `progressionEnvelopeFrom` used to build an
    // envelope with no `version`, so the flagged build hydrated *empty* and its
    // next dual write mirrored the empty record over the learner's real one. The
    // version is what makes `normalizeProgressionRecord` recognise its own
    // `bySubject` map. Same defect as `flaggedBuildRoundTrip.test.ts`, observed
    // through the mirror rather than through the store.
    const repo = await open('mirror-fidelity');
    repository = repo;
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-mirror-fidelity',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const { readAppStateFromStorageV2 } = await import('@/services/persistence/v2/appState');
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    useProgressionStore.getState().hydrateProgression(state.progression);
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-after-hydration-badge');
    await waitFor(
      () =>
        (
          (JSON.parse(window.localStorage.getItem(PROGRESSION_KEY) as string) as {
            bySubject: Record<string, { badges: string[] }>;
          }).bySubject[SUBJECT_ID]?.badges ?? []
        ).includes('synthetic-phase4-after-hydration-badge'),
      'the progression mirror write',
    );
    const mirrored = JSON.parse(window.localStorage.getItem(PROGRESSION_KEY) as string) as {
      bySubject: Record<string, { badges: string[]; xpTotal: number }>;
    };
    expect(mirrored.bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
      'synthetic-phase4-after-hydration-badge',
    ]);
    expect(mirrored.bySubject[SUBJECT_ID]?.xpTotal).toBe(11);
  });

  it('subject, progression, preferences, shortcuts, sessions, and an attachment all survive the switch', async () => {
    const repo = await open('rollback');
    repository = repo;
    const migrated = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-rollback',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(migrated.report.status).toBe('migrated');
    selectStorageV2Repository(repo);

    // Hydrate, as the flagged build does, and then work on the device.
    const { readAppStateFromStorageV2 } = await import('@/services/persistence/v2/appState');
    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    useProgressionStore.getState().hydrateProgression(state.progression);
    usePreferencesStore.getState().hydratePreferences(state.preferences);
    useShortcutStore.getState().hydrateShortcuts(state.shortcuts);
    setSessionSource({ list: async () => [...(state.sessions ?? [])] });

    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-rollback-badge');
    usePreferencesStore.getState().setColorTheme('colorful');
    useShortcutStore.getState().setShortcutKey(2, 'k');
    startSession(SUBJECT_ID, 'Phase4 Independent Synthetic Subject');
    endCurrentSession();
    const edited = syntheticSnapshot();
    await saveSubjectSnapshot(SUBJECT_ID, {
      ...edited,
      dungeon: { ...edited.dungeon, subjectName: 'Phase4 Independent Synthetic Subject, edited' },
    } as typeof edited);
    const attachment = await addDeviceLocalRoomAttachment({
      subjectId: SUBJECT_ID,
      roomId: ROOT_ROOM_ID,
      file: pickedFile([1, 2, 3, 4, 5], 'phase4-synthetic-rolled-back.png'),
    });
    expect(attachment?.sourceType).toBe('local');

    await waitFor(
      () => dualWriteReports().length > 0 || true,
      'the mirror writes to settle',
    );
    await settle();

    // Roll back: the legacy repository, with no handle and no generation.
    resetRepositorySelection();
    selectLegacyRepository();
    window.localStorage.removeItem('knowledge-dungeon:v1:activeSubjectId');

    // Every one of the six is readable, and in the shape a pre-Phase-4 build
    // parses: the index names the subject, the subject payload is JSON, the
    // progression envelope declares `version: 3` with the thirteen legacy record
    // keys, preferences and shortcuts are objects/arrays, and sessions is an
    // array of session records.
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);
    expect((await loadSubjectSnapshot(SUBJECT_ID))?.dungeon.subjectName).toBe(
      'Phase4 Independent Synthetic Subject, edited',
    );
    const keys = legacyKeySet();
    const progression = JSON.parse(keys[STORAGE_KEYS.progression] as string) as {
      version: number;
      bySubject: Record<string, { badges: string[]; xpTotal: number }>;
      crossSubjectAchievements: string[];
    };
    // The mirrored progression is the *pre-Phase-4 v3 document*: a version
    // marker, a by-subject map, and the cross-subject list. A rollback build
    // parses it with no knowledge of storage-v2. (The record's *values* are
    // asserted separately below, because they are the subject of a defect.)
    expect(progression.version).toBe(3);
    expect(Object.keys(progression).sort()).toEqual(['bySubject', 'crossSubjectAchievements', 'version']);
    expect(Object.keys(progression.bySubject[SUBJECT_ID] ?? {}).slice(0, 13)).toEqual([
      'xpTotal',
      'rank',
      'badges',
      'inventory',
      'equippedItems',
      'collectedNotes',
      'streakCount',
      'subjectsMastered',
      'roomsCleared',
      'reviewPasses',
      'artifacts',
      'bossesDefeated',
      'fishCollection',
    ]);
    expect(progression.bySubject[SUBJECT_ID]?.badges).toContain('synthetic-phase4-rollback-badge');
    const preferences = JSON.parse(keys[PREFERENCES_KEY] as string) as { colorTheme: string };
    expect(preferences.colorTheme).toBe('colorful');
    const shortcuts = JSON.parse(keys[SHORTCUTS_KEY] as string) as { key: string }[];
    expect(shortcuts[2]?.key).toBe('k');
    const sessions = JSON.parse(keys[SESSIONS_KEY] as string) as { sessionId: string }[];
    expect(sessions.length).toBe(2);
    // The attachment bytes are device-local, and the rollback build reads them
    // from the same device-local database - no server, no network.
    const { readDeviceLocalAttachmentUrl } = await import('@/services/persistence/deviceAttachments');
    const url = await readDeviceLocalAttachmentUrl(attachment?.attachmentId as string);
    expect(url).toMatch(/^blob:/);
    URL.revokeObjectURL(url as string);
  });

  it('a quota-exhausted localStorage fails the mirror, not the primary, and is reported', async () => {
    const repo = await open('quota');
    repository = repo;
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-quota',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);

    // A localStorage that refuses every write the way a full quota does.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const result = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    setItem.mockRestore();
    await settle();

    // The primary landed in the generation...
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.subjects.map((e) => e.recordId)).toEqual([
      SUBJECT_ID,
    ]);
    // ...the caller was told it succeeded, because the write the learner asked
    // for did succeed...
    expect(result.success).toBe(true);
    // ...and both halves of that are reported: the primary succeeded, and the
    // mirror did not take it. `written` is independent of the mirror, so a
    // write that landed and then failed to mirror reports both.
    expect(dualWriteReports()).toEqual([
      { sequence: 1, operation: 'subject.save', outcome: 'written', code: null },
      {
        sequence: 2,
        operation: 'subject.save',
        outcome: 'mirror-failed',
        code: 'LEGACY_MIRROR_WRITE_FAILED',
      },
    ]);
  });

  it('a localStorage that throws on every write never stops a storage-v2 write', async () => {
    const repo = await open('throwing');
    repository = repo;
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-throwing',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is unavailable');
    });
    useProgressionStore.getState().hydrateProgression({ version: 3, bySubject: {}, crossSubjectAchievements: [] });
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-throwing-badge');
    await settle();
    setItem.mockRestore();

    const active = await repo.readActiveGenerationId();
    const records = (await repo.readRecords(active as string)).records.progression;
    expect(JSON.stringify(records)).toContain('synthetic-phase4-throwing-badge');
    expect(dualWriteReports().filter((entry) => entry.outcome === 'mirror-failed').length).toBeGreaterThan(0);
  });
});

describe('Exit criterion 3, reversed: the flag-off device has no storage-v2 database', () => {
  it('writes only the legacy keys, and the origin holds no storage-v2 database at all', async () => {
    // No repository is opened anywhere in this test, so nothing could have
    // created the database: the flag-off path must not even name it.
    selectLegacyRepository();
    const openSpy = vi.spyOn(globalThis.indexedDB, 'open');

    await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-flag-off-badge');
    usePreferencesStore.getState().setColorTheme('aurora');
    useShortcutStore.getState().setShortcutKey(0, '?');
    startSession(SUBJECT_ID, 'Phase4 Independent Synthetic Subject');
    endCurrentSession();
    const attachment = await addDeviceLocalRoomAttachment({
      subjectId: SUBJECT_ID,
      roomId: ROOT_ROOM_ID,
      file: pickedFile([9, 9, 9], 'phase4-synthetic-flag-off.png'),
    });
    expect(attachment?.sourceType).toBe('local');
    await settle();

    // The device-local attachment database is a *different* database and is
    // expected; storage-v2 is not, and it was never even opened.
    const names = await openDatabaseNames();
    expect(names).toContain(DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME);
    expect(names, 'the flag-off device created a storage-v2 database').not.toContain(
      STORAGE_V2_DATABASE_NAME,
    );
    const opened = openSpy.mock.calls.map((call) => String(call[0]));
    expect(opened, 'the flag-off path opened storage-v2').not.toContain(STORAGE_V2_DATABASE_NAME);
    expect(opened).toContain(DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME);
    // And nothing was reported, because nothing dual-wrote.
    expect(dualWriteReports()).toEqual([]);
  });

  it('a storage-v2 database that already exists is left untouched by a flag-off write', async () => {
    // The hostile ordering: a device that was migrated once, then rolled back.
    // The rollback build must not write to the generation it no longer owns.
    const repo = await open('preexisting');
    repository = repo;
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-preexisting',
      now: NOW,
      clock: { now: () => NOW },
    });
    const before = await rawStoreSummary(`kd-phase4-independent-preexisting`);
    expect(before?.counts.subjects).toBe(1);

    selectLegacyRepository();
    await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot({ dungeon: { ...syntheticSnapshot().dungeon, subjectName: 'Flag-off edit' } } as never));
    await settle();

    const after = await rawStoreSummary(`kd-phase4-independent-preexisting`);
    expect(after).toEqual(before);
    // The legacy key took the edit, so the rollback device really is current.
    expect(
      (await loadSubjectSnapshot(SUBJECT_ID))?.dungeon.subjectName,
    ).toBe('Flag-off edit');
  });
});
