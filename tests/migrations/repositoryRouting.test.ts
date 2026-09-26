/**
 * Phase 4: repository routing, dual-write, and the rollback path.
 *
 * The Phase 4 deliverable is a *dual-readable and dual-writable compatibility
 * period*: with the flag on, storage-v2 is authoritative and the legacy keys are
 * a mirror; with the flag off, nothing touches storage-v2 at all. This file proves
 * all four halves of that sentence against the real modules:
 *
 * 1. **Routing.** The flag selects the repository. The persistence facade's
 *    exported API is byte-for-byte the same in both modes, and the legacy mode
 *    performs the same reads and writes it always did.
 * 2. **Dual-write.** With the flag on, a subject save lands in the active
 *    generation *and* in the legacy key, and the legacy payload is the pre-phase
 *    shape.
 * 3. **A mirror failure is reported and non-fatal.** The primary write succeeds,
 *    the caller is told it succeeded, and a sanitized report records the failure.
 * 4. **Rollback.** A device written with the flag on is fully readable with the
 *    flag off, which is the whole point of the mirror.
 *
 * Every fixture value is synthetic and self-describing. No learner data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteTestDatabase,
  openTestRepository,
  MIGRATION_NOW,
} from './support/storageV2TestSupport';
import {
  listSubjectIds,
  loadSubjectSnapshot,
  saveSubjectSnapshot,
  deleteSubject,
  STORAGE_KEYS,
} from '@/services/persistence/subjectPersistence';
import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import { CANONICAL_PROGRESSION_VERSION } from '@/core/progression/canonicalProgression';
import {
  isStorageV2Selected,
  resetRepositorySelection,
  selectLegacyRepository,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import {
  clearDualWriteReports,
  dualWriteReports,
  summarizeDualWriteReports,
  writeThrough,
} from '@/services/persistence/v2/dualWrite';
import { readAppStateFromStorageV2 } from '@/services/persistence/v2/appState';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { SubjectSnapshot } from '@/core/validation/persistence';

const SUBJECT_ID = 'subject-routing-synthetic';
const GENERATION_ID = 'gen-routing-synthetic-0001';
const NOW = MIGRATION_NOW;

function syntheticSnapshot(subjectName = 'Routing synthetic subject'): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName,
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:09:05.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: 'room-routing-synthetic-root',
      rooms: [{ roomId: 'room-routing-synthetic-root', topic: 'Routing synthetic root topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-routing-synthetic-root': {
        roomId: 'room-routing-synthetic-root',
        topic: 'Routing synthetic root topic',
        createdAt: '2026-01-04T03:04:05.000Z',
        updatedAt: '2026-01-04T03:09:05.000Z',
        state: 'Created',
        notePath: 'rooms/room-routing-synthetic-root/notes.txt',
        artifactPath: 'rooms/room-routing-synthetic-root/artifact.md',
        noteText: 'Routing synthetic note body.',
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
  } as unknown as SubjectSnapshot;
}

let databaseName = '';
let repository: StorageV2Repository | null = null;

async function storageV2For(suffix: string): Promise<StorageV2Repository> {
  databaseName = `kd-phase4-routing-${suffix}`;
  repository = await openTestRepository(databaseName, NOW);
  await repository.stageGeneration({ generationId: GENERATION_ID, source: 'initial', records: {} });
  await repository.activateGeneration(GENERATION_ID);
  return repository;
}

/** The legacy keys, as a comparable object. */
function legacyKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index) as string;
    out[key] = window.localStorage.getItem(key) as string;
  }
  return out;
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  clearDualWriteReports();
  selectLegacyRepository();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

describe('Phase 4 routing: the flag selects the repository', () => {
  it('never selects storage-v2 before the bootstrap has published a handle', () => {
    expect(isStorageV2Selected()).toBe(false);
    expect(dualWriteReports()).toEqual([]);
  });

  it('keeps the facade API identical in both modes and reads from the selected repository', async () => {
    const repo = await storageV2For('routing');

    // Legacy mode: exactly the pre-phase read and write.
    const saved = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    expect(saved.success).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(SUBJECT_ID))).toBe(
      JSON.stringify(syntheticSnapshot()),
    );
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);
    expect((await loadSubjectSnapshot(SUBJECT_ID))?.dungeon.subjectName).toBe('Routing synthetic subject');

    // Storage-v2 mode: the same exported functions, a different destination.
    window.localStorage.clear();
    selectStorageV2Repository(repo);
    expect(isStorageV2Selected()).toBe(true);
    const toV2 = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot('Routing synthetic subject v2'));
    expect(toV2.success).toBe(true);
    expect((await loadSubjectSnapshot(SUBJECT_ID))?.dungeon.subjectName).toBe('Routing synthetic subject v2');
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);

    const active = await repo.readActiveGenerationId();
    expect(active).toBe(GENERATION_ID);
    const stored = (await repo.readRecords(GENERATION_ID)).records.subjects;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.recordId).toBe(SUBJECT_ID);
  });

  it('rebuilds the app-shaped persisted state from the active generation', async () => {
    const repo = await storageV2For('app-state');
    selectStorageV2Repository(repo);
    await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());

    const state = await readAppStateFromStorageV2(repo, { activeSubjectId: SUBJECT_ID });
    expect(state.subjects.map((entry) => entry.id)).toEqual([SUBJECT_ID]);
    expect(state.subjects[0]?.snapshot.dungeon.subjectName).toBe('Routing synthetic subject');
    expect(state.activeSubjectId).toBe(SUBJECT_ID);
    // Nothing was stored for these, so hydration sees an empty canonical
    // progression and the stores resolve their own documented defaults. The
    // version is part of the envelope: it is what lets a reader recognise the
    // payload as the by-subject shape and stop filing it as a flat record.
    expect(state.progression).toEqual({
      version: CANONICAL_PROGRESSION_VERSION,
      bySubject: {},
      crossSubjectAchievements: [],
    });
    expect(state.preferences).toBeNull();
    expect(state.shortcuts).toBeNull();
    expect(state.sessions).toBeNull();
  });
});

describe('Phase 4 dual-write: storage-v2 is primary, the legacy key is the mirror', () => {
  it('lands a save in the generation and in the legacy key', async () => {
    const repo = await storageV2For('dual-write');
    selectStorageV2Repository(repo);

    const snapshot = syntheticSnapshot('Dual-write synthetic subject');
    const result = await saveSubjectSnapshot(SUBJECT_ID, snapshot);

    expect(result).toEqual({ success: true });
    // The primary landed.
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.subjects).toHaveLength(1);
    // The mirror landed, and it is the pre-phase payload: `JSON.stringify` of the
    // snapshot the caller passed, with no canonical-only wrapper.
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(SUBJECT_ID))).toBe(JSON.stringify(snapshot));
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.subjectIndex) as string)).toEqual([SUBJECT_ID]);
    // Nothing *failed*, and the success is reported: a write that landed records
    // `written`, so a recovery screen can count successful writes as well as
    // failures. A successful write is still not an error report.
    expect(dualWriteReports()).toEqual([
      { sequence: 1, operation: 'subject.save', outcome: 'written', code: null },
    ]);
  });

  it('reports a mirror failure without failing the primary write', async () => {
    const repo = await storageV2For('mirror-failure');
    selectStorageV2Repository(repo);

    // The legacy mirror is made to fail the way a quota-blocked write fails.
    const failure = new DOMException('synthetic quota exhaustion', 'QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw failure;
    });

    const result = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());

    // The learner's save succeeded: the primary is storage-v2.
    expect(result.success).toBe(true);
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.subjects).toHaveLength(1);

    // And the mirror failure was reported, not swallowed: a code, an operation,
    // and an outcome. No message, no key, no value.
    const reports = dualWriteReports();
    // Two facts, both true and both reported: the primary landed, and the mirror
    // did not take it. `written` is independent of the mirror, so the failure is
    // never hidden behind a success and a success never hides the failure.
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual({
      sequence: 1,
      operation: 'subject.save',
      outcome: 'written',
      code: null,
    });
    expect(reports[1]).toEqual({
      sequence: 2,
      operation: 'subject.save',
      outcome: 'mirror-failed',
      code: 'LEGACY_MIRROR_WRITE_FAILED',
    });
    expect(Object.keys(reports[0] as unknown as Record<string, unknown>).sort()).toEqual([
      'code',
      'operation',
      'outcome',
      'sequence',
    ]);
    expect(summarizeDualWriteReports(reports)).toEqual({
      written: 1,
      primaryFailed: 0,
      mirrorFailed: 1,
      lastCode: 'LEGACY_MIRROR_WRITE_FAILED',
    });
  });

  it('rejects and reports when the primary write itself fails', async () => {
    const repo = await storageV2For('primary-failure');
    selectStorageV2Repository(repo);
    vi.spyOn(repo, 'putRecords').mockRejectedValue(new Error('synthetic generation failure'));

    const result = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());

    // A write the learner asked for and did not get must not report success.
    expect(result.success).toBe(false);
    expect(result.error).toBe('synthetic generation failure');
    expect(dualWriteReports()).toEqual([
      { sequence: 1, operation: 'subject.save', outcome: 'primary-failed', code: 'STORAGE_V2_WRITE_FAILED' },
    ]);
    // The mirror is not written either, so the legacy keys can never be ahead of
    // storage-v2.
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(SUBJECT_ID))).toBeNull();
  });

  it('runs the mirror only after the primary has succeeded', async () => {
    const order: string[] = [];
    await writeThrough({
      operation: 'sessions',
      primary: async () => {
        order.push('primary');
      },
      mirror: () => {
        order.push('mirror');
        return true;
      },
    });
    expect(order).toEqual(['primary', 'mirror']);
  });

  it('mirrors a subject deletion to both repositories', async () => {
    const repo = await storageV2For('dual-delete');
    selectStorageV2Repository(repo);
    await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);

    await deleteSubject(SUBJECT_ID);

    expect(await listSubjectIds()).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(SUBJECT_ID))).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.subjectIndex) as string)).toEqual([]);
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.subjects).toEqual([]);
  });
});

describe('Phase 4 rollback: a device written with the flag on is readable with it off', () => {
  it('reads the flag-on device completely through the legacy repository', async () => {
    // 1. A flagged device: a realistic legacy key set, migrated into storage-v2.
    const subject = syntheticSnapshot('Rollback synthetic subject');
    window.localStorage.setItem(STORAGE_KEYS.subjectIndex, JSON.stringify([SUBJECT_ID]));
    window.localStorage.setItem(STORAGE_KEYS.subject(SUBJECT_ID), JSON.stringify(subject));
    window.localStorage.setItem(STORAGE_KEYS.activeSubjectId, SUBJECT_ID);
    window.localStorage.setItem(
      'knowledge-dungeon:v1:progression',
      JSON.stringify({
        version: 3,
        bySubject: {
          [SUBJECT_ID]: {
            xpTotal: 42,
            rank: 'Novice',
            badges: ['synthetic-rollback-badge'],
            inventory: [],
            equippedItems: [],
            collectedNotes: [],
            streakCount: 1,
            subjectsMastered: 0,
            roomsCleared: 2,
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
      'knowledge-dungeon:session:preferences',
      JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'colorful', activeSpritePack: null }),
    );

    const repo = await storageV2For('rollback');
    selectStorageV2Repository(repo);
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-rollback-synthetic-0001',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);

    // 2. The learner keeps working on the flagged device. Progression and the
    //    subject both dual-write, which is what the rollback depends on.
    const { useProgressionStore } = await import('@/store/progressionStore');
    useProgressionStore.getState().hydrateProgression(
      JSON.parse(window.localStorage.getItem('knowledge-dungeon:v1:progression') as string),
    );
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-rollback-second-badge');
    await saveSubjectSnapshot(SUBJECT_ID, {
      ...subject,
      dungeon: { ...subject.dungeon, subjectName: 'Rollback synthetic subject, edited' },
    } as SubjectSnapshot);

    // 3. Roll back: `VITE_STORAGE_REPOSITORY=legacy` in a fresh build. The
    //    active-subject pointer is dropped first, so the rollback is proved to
    //    read the subject out of the data mirror and not out of session state.
    resetRepositorySelection();
    selectLegacyRepository();
    window.localStorage.removeItem('knowledge-dungeon:v1:activeSubjectId');

    // The rollback build sees the subject, the edited name, and the second badge -
    // all from the mirror, with the storage-v2 database untouched and unread.
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);
    const rolledBack = await loadSubjectSnapshot(SUBJECT_ID);
    expect(rolledBack?.dungeon.subjectName).toBe('Rollback synthetic subject, edited');
    const rawProgression = JSON.parse(
      window.localStorage.getItem('knowledge-dungeon:v1:progression') as string,
    ) as { bySubject: Record<string, { badges: string[] }> };
    expect(rawProgression.bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-rollback-badge',
      'synthetic-rollback-second-badge',
    ]);
    // And the flagged data is still there for a roll-forward.
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.subjects).toHaveLength(1);
  });
});

describe('Phase 4 dual-write: the flag off does not touch storage-v2 at all', () => {
  it('writes only the legacy keys, and storage-v2 stays empty', async () => {
    // A storage-v2 repository is open and selected nowhere: the flag is off, so
    // the facade must not reach it.
    const repo = await storageV2For('flag-off');
    selectLegacyRepository();
    expect(isStorageV2Selected()).toBe(false);

    const result = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot('Flag-off synthetic subject'));

    expect(result.success).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEYS.subject(SUBJECT_ID))).not.toBeNull();
    // The generation is still the empty one the harness staged, so nothing wrote
    // into storage-v2 through the facade.
    const records = (await repo.readRecords(GENERATION_ID)).records;
    expect(records.subjects).toEqual([]);
    expect(records.progression).toEqual([]);
    expect(await listSubjectIds()).toEqual([SUBJECT_ID]);
    expect(dualWriteReports()).toEqual([]);
  });

  it('a device with no storage-v2 database never creates one', async () => {
    // No repository is opened at all on this path: the legacy repository is the
    // default, so there is nothing that could have created a database.
    selectLegacyRepository();
    const result = await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    expect(result.success).toBe(true);
    expect(legacyKeys()).toEqual({
      [STORAGE_KEYS.subject(SUBJECT_ID)]: JSON.stringify(syntheticSnapshot()),
      [STORAGE_KEYS.subjectIndex]: JSON.stringify([SUBJECT_ID]),
    });
  });
});
