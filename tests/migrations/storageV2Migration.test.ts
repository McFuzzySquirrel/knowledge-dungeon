/**
 * The storage-v2 migration and repository.
 *
 * Exit criteria covered here:
 * - "Legacy fixtures migrate idempotently."
 * - "A failed staged transaction leaves the active generation unchanged."
 * - "Legacy keys remain byte-for-byte untouched."
 *
 * Every fixture value is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeterministicIdFactory,
  fixedClock,
} from '@/services/persistence/v2/database';
import { openStorageV2Repository, type StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  MIGRATION_STAGES,
  buildMigratedRecords,
  migrateLegacyState,
  rollbackMigration,
  type MigrationStage,
} from '@/services/persistence/v2/migrations';
import { readLegacyAppState, type ReadOnlyLegacyStorage } from '@/services/persistence/v2/legacyReader';
import { isImportableSubjectSnapshot } from '@/core/validation/persistence';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  LEGACY_MIGRATION_ID,
  STORAGE_V2_SCHEMA_VERSION,
  STORAGE_V2_STORE_NAMES,
  isStorageV2Error,
  type StorageV2StoreName,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import { checksumText, checksumValue } from '@/services/persistence/v2/checksum';
import { FIXTURE_ROOT } from './support/storageV2TestSupport';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GENERATION_ID,
  MIGRATION_NOW,
  allowlistedKeysIn,
  createWriteTrapStorage,
  deleteTestDatabase,
  openTestRepository,
  readProgressionFixture,
  readSubjectFixture,
  resetStorageV2Environment,
  snapshotLocalStorage,
  toReadOnlyStorage,
} from './support/storageV2TestSupport';

const V10_SUBJECT = readSubjectFixture('subject-1.0.0-migration-defaults.json');
const V10_FULL_SUBJECT = readSubjectFixture('subject-1.0.0-full-unknown-fields.json');
const V10_MINIMAL_SUBJECT = readSubjectFixture('subject-1.0.0-minimal.json');
const V11_SUBJECT = readSubjectFixture('subject-1.1.0-minimal.json');
const V11_FULL_SUBJECT = readSubjectFixture('subject-1.1.0-full-unknown-fields.json');
const INVALID_SYNTAX_SUBJECT = readSubjectFixture('subject-invalid-syntax.txt');
const MISSING_ROOM_SUBJECT = readSubjectFixture('subject-invalid-parseable-missing-room-v1.0.json');

let databaseCounter = 0;
let repository: StorageV2Repository | null = null;
let databaseName = '';

function nextDatabaseName(suffix: string): string {
  databaseCounter += 1;
  return `kd-storage-v2-test-${suffix}-${databaseCounter}`;
}

async function repositoryFor(suffix: string): Promise<StorageV2Repository> {
  databaseName = nextDatabaseName(suffix);
  repository = await openTestRepository(databaseName);
  return repository;
}

async function closeRepository(): Promise<void> {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
}

/** Seed a legacy localStorage with two subjects and a v3 progression payload. */
function seedLegacyState(options: { progressionFixture?: string } = {}): void {
  const storage = window.localStorage;
  storage.setItem(
    'knowledge-dungeon:v1:subjects',
    JSON.stringify(['subject-phase0-v100-migration', 'subject-phase0-v100-full', 'subject-phase0-v110-full']),
  );
  storage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-phase0-v100-migration');
  storage.setItem('knowledge-dungeon:v1:subject:subject-phase0-v100-migration', V10_SUBJECT);
  storage.setItem('knowledge-dungeon:v1:subject:subject-phase0-v100-full', V10_FULL_SUBJECT);
  storage.setItem('knowledge-dungeon:v1:subject:subject-phase0-v110-full', V11_FULL_SUBJECT);
  storage.setItem(
    'knowledge-dungeon:v1:progression',
    readProgressionFixture(options.progressionFixture ?? 'progression-v3-current-full.json'),
  );
  storage.setItem(
    'knowledge-dungeon:v1:sessions',
    JSON.stringify([
      {
        sessionId: 'session-synthetic-1',
        startedAt: '2026-01-02T03:04:05.000Z',
        endedAt: '2026-01-02T04:04:05.000Z',
        subjectId: 'subject-phase0-v100-migration',
        roomsVisited: ['room-phase0-v100-migration-root'],
        notesSubmitted: 1,
        reviewsCompleted: 0,
        xpEarned: 20,
      },
    ]),
  );
  storage.setItem('knowledge-dungeon:session:preferences', '{"colorTheme":"dark","graphicsMode":"rpg"}');
  storage.setItem(
    'knowledge-dungeon:session:shortcuts',
    JSON.stringify([
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false },
    ]),
  );
  storage.setItem('knowledge-dungeon:locale', 'en');
  storage.setItem('kd-quest-step', 'synthetic-quest-step');
  storage.setItem('kd-village-spawn', '{"gridX":1,"gridY":2}');
  storage.setItem('knowledge-dungeon:ui:fishing-hint:v1', '1');
  storage.setItem('knowledge-dungeon:custom-sprites:override:village/tree.svg', '<svg id="synthetic"/>');
  storage.setItem('knowledge-dungeon:backup:subject-phase0-v100-migration', '{"dungeon":truncated');
  storage.setItem('knowledge-dungeon:corrupt:subject-phase0-v100-migration', '{"dungeon":');
  // A key the app does not own, to prove the reader leaves it alone too.
  storage.setItem('knowledge-dungeon:subjects:index', '["must-not-be-read"]');
  storage.setItem('unrelated-third-party-key', 'leave-me-alone');
}

function migrateOptions(
  repo: StorageV2Repository,
  overrides: Partial<Parameters<typeof migrateLegacyState>[0]> = {},
): Parameters<typeof migrateLegacyState>[0] {
  return {
    repository: repo,
    generationId: GENERATION_ID,
    now: MIGRATION_NOW,
    clock: fixedClock(MIGRATION_NOW),
    storage: toReadOnlyStorage(snapshotLocalStorage()),
    ...overrides,
  };
}

async function canonicalSnapshot(repo: StorageV2Repository): Promise<unknown> {
  const snapshot = await repo.readGeneration(GENERATION_ID);
  return snapshot === null ? null : JSON.parse(JSON.stringify(snapshot.records));
}

/**
 * Project a record set to what two independent runs of the same migration must
 * agree on: record ids, checksums, and values.
 *
 * The `generationId` of each envelope and the whole `migrationReceipts` list are
 * excluded, because a receipt legitimately names the generation it belongs to
 * and the envelope's tag is the generation under test.
 */
function recordProjection(records: unknown): unknown {
  if (records === null || typeof records !== 'object') return records;
  const input = records as Record<string, { generationId?: string; recordId: string; checksum: string | null; value: unknown }[]>;
  const projected: Record<string, unknown[]> = {};
  for (const [key, list] of Object.entries(input)) {
    if (key === 'migrationReceipts') continue;
    projected[key] = list
      .map((entry) => ({ recordId: entry.recordId, checksum: entry.checksum, value: entry.value }))
      .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  }
  return projected;
}

describe('storage-v2 repository foundations', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(async () => {
    await closeRepository();
    resetStorageV2Environment();
  });

  it('creates every object store the plan requires, indexed by generation', async () => {
    const repo = await repositoryFor('schema');
    const internal = (repo as unknown as { db: IDBDatabase }).db;
    const names = [...internal.objectStoreNames].sort();

    expect(names).toEqual([...STORAGE_V2_STORE_NAMES].sort());
    expect(internal.version).toBe(STORAGE_V2_SCHEMA_VERSION);
    for (const tx of internal.transaction([...STORAGE_V2_STORE_NAMES], 'readonly').objectStoreNames) {
      expect(tx).toBeDefined();
    }
  });

  it('stages a generation invisibly and only exposes it after activation', async () => {
    const repo = await repositoryFor('staging');

    expect(await repo.readActiveGenerationId()).toBeNull();
    expect(await repo.readActiveGeneration()).toBeNull();

    const subject: SubjectRecordValue = {
      subjectId: 'subject-staged',
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      snapshot: JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'],
      createdAt: MIGRATION_NOW,
      updatedAt: MIGRATION_NOW,
    };
    const staged = await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: { subjects: [subject] },
    });

    expect(staged.descriptor.status).toBe('staged');
    expect(await repo.readActiveGenerationId()).toBeNull();
    expect(await repo.readGeneration(GENERATION_ID)).not.toBeNull();
    expect((await repo.listGenerations()).map((entry) => entry.generationId)).toEqual([GENERATION_ID]);

    const activation = await repo.activateGeneration(GENERATION_ID);
    expect(activation).toEqual({ previousActiveGenerationId: null, activeGenerationId: GENERATION_ID });
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);
  });

  it('validates a staged generation and reports a typed error for a missing one', async () => {
    const repo = await repositoryFor('validate');
    const report = await (async () => {
      await repo.stageGeneration({ generationId: GENERATION_ID, source: 'initial', records: {} });
      return repo.validateGeneration(GENERATION_ID);
    })();

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.checksumMismatches).toEqual([]);

    await expect(repo.validateGeneration('gen-does-not-exist')).rejects.toMatchObject({
      code: 'GENERATION_NOT_FOUND',
    });
  });

  it('reports a dangling relationship without blocking activation', async () => {
    const repo = await repositoryFor('relationship');
    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        sessions: [
          {
            sessionId: 'session-orphan',
            subjectId: 'subject-does-not-exist',
            startedAt: MIGRATION_NOW,
            endedAt: null,
            roomsVisited: [],
            notesSubmitted: 0,
            reviewsCompleted: 0,
            xpEarned: 0,
            eventId: 'event-synthetic-1',
          },
        ],
      },
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    // A session for a subject that is gone is disclosed, not fatal: the session
    // record is still valid history and dropping it would be destructive.
    expect(report.problems).toContainEqual({
      code: 'unknown-subject-reference',
      scope: 'relationship',
      count: 1,
      severity: 'warning',
    });
    expect(report.ok).toBe(true);
  });

  it('refuses to validate a generation whose edge points at a missing room', async () => {
    const repo = await repositoryFor('dangling-edge');
    const snapshot = JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'];
    snapshot.dungeon.edges = [
      {
        fromRoomId: snapshot.dungeon.rootRoomId,
        toRoomId: 'room-does-not-exist',
        relationType: 'subtopic',
        createdAt: MIGRATION_NOW,
        createdByPhase: 'Creator',
      },
    ];

    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        subjects: [
          {
            subjectId: snapshot.dungeon.dungeonId,
            schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
            snapshot,
            createdAt: MIGRATION_NOW,
            updatedAt: MIGRATION_NOW,
          },
        ],
      },
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      code: 'dangling-edge',
      scope: 'relationship',
      count: 1,
      severity: 'error',
    });
  });

  it('rolls back to a retained generation and keeps both available', async () => {
    const repo = await repositoryFor('rollback');
    await repo.stageGeneration({ generationId: 'gen-first', source: 'initial', records: {} });
    await repo.activateGeneration('gen-first');
    await repo.stageGeneration({ generationId: 'gen-second', source: 'local-edit', parentGenerationId: 'gen-first', records: {} });
    await repo.activateGeneration('gen-second');

    expect(await repo.readActiveGenerationId()).toBe('gen-second');
    const rollback = await repo.rollbackToGeneration('gen-first');
    expect(rollback.activeGenerationId).toBe('gen-first');
    expect(await repo.readActiveGenerationId()).toBe('gen-first');

    // The superseded generation is retained, not deleted.
    expect(await repo.readGeneration('gen-second')).not.toBeNull();
    const generations = await repo.listGenerations();
    expect(generations.find((entry) => entry.generationId === 'gen-second')?.status).toBe('superseded');
  });

  it('rolls a staged transaction back completely when a write fails mid-way', async () => {
    const repo = await repositoryFor('abort');
    await repo.stageGeneration({ generationId: 'gen-baseline', source: 'initial', records: {} });
    await repo.activateGeneration('gen-baseline');
    const before = await canonicalSnapshot(repo);

    await expect(
      repo.stageGeneration({
        generationId: GENERATION_ID,
        source: 'legacy-migration',
        records: { subjects: [{ subjectId: 'subject-x', schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION, snapshot: JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'], createdAt: MIGRATION_NOW, updatedAt: MIGRATION_NOW }] },
        onStage: (point) => {
          if (point === 'after-progression') throw new Error('synthetic mid-write failure');
        },
      }),
    ).rejects.toSatisfy((error: unknown) => isStorageV2Error(error));

    expect(await repo.readGeneration(GENERATION_ID)).toBeNull();
    expect(await repo.readActiveGenerationId()).toBe('gen-baseline');
    expect(await canonicalSnapshot(repo)).toEqual(before);
  });

  it('prunes old generations but never the active one', async () => {
    const repo = await repositoryFor('prune');
    for (const id of ['gen-a', 'gen-b', 'gen-c']) {
      await repo.stageGeneration({ generationId: id, source: 'initial', records: {} });
      await repo.activateGeneration(id);
    }

    const pruned = await repo.pruneGenerations({ keepAtLeast: 1 });
    expect(pruned.removed).toEqual(['gen-a', 'gen-b']);
    expect(pruned.retained).toEqual(['gen-c']);
    expect(await repo.readGeneration('gen-a')).toBeNull();
    expect(await repo.readActiveGenerationId()).toBe('gen-c');
  });

  it('writes a migration receipt that carries counts, checksums, and versions only', async () => {
    const repo = await repositoryFor('receipt');
    seedLegacyState();
    await migrateLegacyState(migrateOptions(repo));

    const receipts = await repo.listMigrationReceipts(GENERATION_ID);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.migrationId).toBe(LEGACY_MIGRATION_ID);
    expect(receipt.fromStorage).toBe('legacy-localstorage');
    expect(receipt.toStorage).toBe('storage-v2');
    expect(receipt.subjectSchemaVersions).toEqual({ '1.0.0': 2, '1.1.0': 1 });
    expect(Object.keys(receipt.recordChecksums).sort()).toEqual([...STORAGE_V2_STORE_NAMES].sort());
    expect(receipt.contentChecksum).toMatch(/^[0-9a-f]{64}$/);

    // No learner value of any kind in a receipt.
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('Synthetic Phase 0');
    expect(serialized).not.toContain('synthetic-quest-step');
    expect(serialized).not.toContain('phase0-synthetic');
    expect(serialized).not.toContain('noteText');
  });
});

describe('legacy fixtures migrate idempotently', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(async () => {
    await closeRepository();
    resetStorageV2Environment();
  });

  const subjectFixtures = [
    'subject-1.0.0-minimal.json',
    'subject-1.0.0-migration-defaults.json',
    'subject-1.0.0-full-unknown-fields.json',
    'subject-1.1.0-minimal.json',
    'subject-1.1.0-full-unknown-fields.json',
  ];

  const invalidSubjectFixtures = [
    'subject-invalid-missing-room.json',
    'subject-invalid-missing-schema-version.json',
    'subject-invalid-malformed-room-summary.json',
    'subject-invalid-unsupported-version.json',
    'subject-invalid-parseable-missing-room-v1.0.json',
    'subject-invalid-syntax.txt',
  ];

  const progressionFixtures = [
    'progression-v1-flat.json',
    'progression-v1-flat-malformed.json',
    'progression-v2-by-subject.json',
    'progression-v2-malformed-by-subject.json',
    'progression-v3-current-full.json',
    'progression-v3-malformed-values.json',
    'progression-invalid-syntax.txt',
  ];

  it('migrates every valid subject fixture, and running it twice on the SAME generation changes nothing', async () => {
    for (const fixture of subjectFixtures) {
      resetStorageV2Environment();
      const raw = readSubjectFixture(fixture);
      const subjectId = (JSON.parse(raw) as { dungeon: { dungeonId: string } }).dungeon.dungeonId;
      window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([subjectId]));
      window.localStorage.setItem(`knowledge-dungeon:v1:subject:${subjectId}`, raw);

      const repo = await repositoryFor('idempotent-subject');
      const first = await migrateLegacyState(migrateOptions(repo));
      expect(first.report.status, fixture).toBe('migrated');
      const firstRecords = recordProjection(await canonicalSnapshot(repo));

      // Second run against the SAME repository and the SAME generation id: a
      // retry of an already-migrated generation. It must be a no-op success, and
      // the stored records must be untouched.
      const second = await migrateLegacyState(migrateOptions(repo));
      expect(second.report.status, fixture).toBe('migrated');
      expect(second.report.activated, fixture).toBe(true);
      expect(second.report.recovery, fixture).toBeNull();
      const secondRecords = recordProjection(await canonicalSnapshot(repo));

      expect(secondRecords, fixture).toEqual(firstRecords);
      // No duplicated record and no accumulated generation.
      expect((await repo.listGenerations()).map((entry) => entry.generationId)).toEqual([GENERATION_ID]);
      expect(await repo.listMigrationReceipts(GENERATION_ID)).toHaveLength(1);

      // A retry into a DIFFERENT generation is also stable: same source, same
      // canonical records, and the first generation is left intact.
      const secondRepo = await repositoryFor('idempotent-subject-2');
      const third = await migrateLegacyState(
        migrateOptions(secondRepo, { generationId: `${GENERATION_ID}-second` }),
      );
      expect(third.report.status, fixture).toBe('migrated');
      const thirdRecords = recordProjection(
        JSON.parse(JSON.stringify((await secondRepo.readGeneration(`${GENERATION_ID}-second`))?.records ?? null)),
      );

      expect(thirdRecords, fixture).toEqual(firstRecords);
      const carried = (secondRecords as { subjects: { value: SubjectRecordValue }[] }).subjects;
      // Every importable fixture must actually be carried, never dropped.
      expect(carried, fixture).toHaveLength(1);
      const subjectIds = carried.map((entry) => entry.value.subjectId);
      expect(new Set(subjectIds).size, fixture).toBe(subjectIds.length);
    }
  });

  it('migrates every progression fixture, and a same-generation retry changes nothing', async () => {
    for (const fixture of progressionFixtures) {
      resetStorageV2Environment();
      window.localStorage.setItem('knowledge-dungeon:v1:progression', readProgressionFixture(fixture));
      window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-synthetic-active');

      const repo = await repositoryFor('idempotent-progression');
      const first = await migrateLegacyState(migrateOptions(repo));
      const firstRecords = recordProjection(await canonicalSnapshot(repo));

      // Retry the SAME generation on the SAME database: a no-op success with the
      // records untouched. This is the idempotency claim, and a second fresh
      // database would only prove determinism.
      const retry = await migrateLegacyState(migrateOptions(repo));
      expect(retry.report.status, fixture).toBe('migrated');
      expect(recordProjection(await canonicalSnapshot(repo)), fixture).toEqual(firstRecords);
      expect((await repo.listGenerations()).map((entry) => entry.generationId)).toEqual([GENERATION_ID]);

      // Determinism across a fresh database and a fresh generation id.
      const secondRepo = await repositoryFor('idempotent-progression-2');
      await migrateLegacyState(migrateOptions(secondRepo, { generationId: `${GENERATION_ID}-second` }));
      const secondRecords = recordProjection(
        JSON.parse(JSON.stringify((await secondRepo.readGeneration(`${GENERATION_ID}-second`))?.records ?? null)),
      );

      expect(secondRecords, fixture).toEqual(firstRecords);
      const progression = (firstRecords as { progression: unknown[] }).progression;
      const ids = progression.map((entry) => (entry as { recordId: string }).recordId);
      expect(new Set(ids).size, fixture).toBe(ids.length);
      if (fixture !== 'progression-invalid-syntax.txt') {
        expect(first.report.status, fixture).toBe('migrated');
      }
    }
  });

  it('reports a problem and writes nothing for an unusable subject payload', async () => {
    for (const fixture of invalidSubjectFixtures) {
      resetStorageV2Environment();
      const raw = readSubjectFixture(fixture);
      window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-invalid']));
      window.localStorage.setItem('knowledge-dungeon:v1:subject:subject-invalid', raw);

      await repositoryFor(`invalid-${fixture}`);
      const state = readLegacyAppState({ storage: toReadOnlyStorage(snapshotLocalStorage()) });
      const built = buildMigratedRecords(state, { now: MIGRATION_NOW, generationId: GENERATION_ID });

      expect(built.records.subjects, fixture).toEqual([]);
      expect(built.problems.length, fixture).toBeGreaterThan(0);
      for (const problem of built.problems) {
        expect(Object.keys(problem).sort(), fixture).toEqual(['code', 'count', 'scope', 'severity']);
        expect(problem.severity, fixture).toBe('error');
      }
    }
  });

  it('reports an empty device as no-source-data without staging anything', async () => {
    const repo = await repositoryFor('empty');
    const outcome = await migrateLegacyState(migrateOptions(repo));

    expect(outcome.report.status).toBe('no-source-data');
    expect(outcome.stagedGenerationId).toBeNull();
    expect(await repo.listGenerations()).toEqual([]);
    expect(await repo.readActiveGenerationId()).toBeNull();
  });

  it('preserves unknown top-level, dungeon, and room fields in the migrated snapshot', async () => {
    const repo = await repositoryFor('unknown-fields');
    const subjectId = 'subject-phase0-v100-migration';
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([subjectId]));
    window.localStorage.setItem(`knowledge-dungeon:v1:subject:${subjectId}`, V10_SUBJECT);

    await migrateLegacyState(migrateOptions(repo));
    const snapshot = await repo.readGeneration(GENERATION_ID);
    const stored = snapshot?.records.subjects[0]?.value.snapshot as unknown as Record<string, unknown>;

    expect(stored).toHaveProperty('legacyEnvelope');
    expect(stored).toHaveProperty('fixtureFormat');
    expect((stored.dungeon as Record<string, unknown>).fixtureDungeonField).toBe(
      'preserve-this-synthetic-dungeon-field',
    );
    expect(
      (stored.rooms as Record<string, Record<string, unknown>>)['room-phase0-v100-migration-root']
        .fixtureRoomField,
    ).toBe('preserve-this-synthetic-room-field');
    expect(stored.dungeon).toMatchObject({ schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION });
  });

  it('migrates a full legacy device in one pass and activates the result', async () => {
    const repo = await repositoryFor('full-migration');
    seedLegacyState();
    const before = snapshotLocalStorage();

    const outcome = await migrateLegacyState(migrateOptions(repo));

    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    expect(outcome.report.receiptId).not.toBeNull();
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);

    const snapshot = await repo.readGeneration(GENERATION_ID);
    expect(snapshot?.records.subjects).toHaveLength(3);
    expect(snapshot?.records.progression.length).toBeGreaterThan(0);
    expect(snapshot?.records.sessions).toHaveLength(1);
    expect(snapshot?.records.preferences.length).toBeGreaterThan(0);
    expect(snapshot?.records.shortcuts).toHaveLength(1);
    expect(snapshot?.records.customSprites.length).toBeGreaterThan(0);
    expect(snapshot?.records.recovery).toHaveLength(2);
    expect(snapshot?.records.assistance).toHaveLength(1);

    // The legacy snapshot is byte-for-byte unchanged.
    expect(snapshotLocalStorage().entries()).toEqual(before.entries());
  });

  it('reports external-only attachments without a filename or URL', async () => {
    const repo = await repositoryFor('external-only');
    seedLegacyState();
    const outcome = await migrateLegacyState(migrateOptions(repo));

    expect(outcome.report.attachments.externalOnly).toBeGreaterThan(0);
    expect(outcome.report.attachments.storedBytes).toBe(0);
    for (const record of outcome.report.externalOnlyAttachments) {
      expect(record.contentHash).toBeNull();
      expect(record.byteLength).toBeNull();
    }
    const serialized = JSON.stringify(outcome.report.externalOnlyAttachments);
    expect(serialized).not.toContain('fileName');
    expect(serialized).not.toContain('externalUrl');
    expect(serialized).not.toContain('example.invalid');
  });
});

describe('a failed staged transaction leaves the active generation unchanged', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(async () => {
    await closeRepository();
    resetStorageV2Environment();
  });

  async function baseline(): Promise<{ repo: StorageV2Repository; legacyBefore: [string, string][]; recordsBefore: unknown; generationBefore: string | null }> {
    const repo = await repositoryFor('baseline');
    await repo.stageGeneration({ generationId: 'gen-baseline', source: 'initial', records: {} });
    await repo.activateGeneration('gen-baseline');
    seedLegacyState();
    return {
      repo,
      legacyBefore: snapshotLocalStorage().entries(),
      recordsBefore: JSON.parse(JSON.stringify((await repo.readGeneration('gen-baseline'))?.records ?? null)),
      generationBefore: await repo.readActiveGenerationId(),
    };
  }

  const failurePoints: { stage: MigrationStage | 'stage-point'; label: string }[] = [
    { stage: 'read-legacy', label: 'while reading the legacy source' },
    { stage: 'transform', label: 'while transforming records' },
    { stage: 'stage-records', label: 'mid-write, between stores' },
    { stage: 'validate', label: 'at the validation step' },
    { stage: 'compare', label: 'at the checksum comparison' },
    { stage: 'receipt', label: 'while writing the migration receipt' },
    { stage: 'activate', label: 'at generation activation' },
  ];

  for (const failurePoint of failurePoints) {
    it(`leaves the active generation and legacy storage unchanged when it fails ${failurePoint.label}`, async () => {
      const { repo, legacyBefore, recordsBefore, generationBefore } = await baseline();

      const outcome = await migrateLegacyState(
        migrateOptions(repo, {
          onStage: (stage) => {
            if (stage === failurePoint.stage) {
              throw new Error(`synthetic failure at ${failurePoint.stage}`);
            }
          },
        }),
      );

      expect(outcome.report.status).toBe('recovery-required');
      expect(outcome.report.activated).toBe(false);
      expect(outcome.report.recovery).not.toBeNull();
      expect(outcome.report.recovery?.stage).toBe(failurePoint.stage);

      // The pointer never moved.
      expect(await repo.readActiveGenerationId()).toBe(generationBefore);
      expect(generationBefore).toBe('gen-baseline');
      expect((await repo.readGeneration('gen-baseline'))?.descriptor?.status).toBe('active');

      // The previously active generation's records are byte-for-byte unchanged.
      expect(JSON.parse(JSON.stringify((await repo.readGeneration('gen-baseline'))?.records ?? null))).toEqual(
        recordsBefore,
      );

      // Legacy storage is byte-for-byte unchanged, including key order.
      expect(snapshotLocalStorage().entries()).toEqual(legacyBefore);
    });
  }

  it('leaves the active generation unchanged on a validation failure', async () => {
    const { repo, legacyBefore, generationBefore } = await baseline();

    const outcome = await migrateLegacyState(
      migrateOptions(repo, { forceValidationFailure: true }),
    );

    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.recovery?.code).toBe('VALIDATION_FAILED');
    expect(await repo.readActiveGenerationId()).toBe(generationBefore);
    expect(snapshotLocalStorage().entries()).toEqual(legacyBefore);
  });

  it('leaves the active generation unchanged on a checksum mismatch', async () => {
    const { repo, legacyBefore, generationBefore } = await baseline();

    // Stage a generation whose declared roll-up checksum is wrong, then try to
    // activate it: the comparison must refuse.
    const internal = (repo as unknown as { db: IDBDatabase }).db;
    await repo.stageGeneration({ generationId: GENERATION_ID, source: 'legacy-migration', records: {} });
    const tx = internal.transaction(['meta'], 'readwrite');
    const meta = tx.objectStore('meta');
    const request = meta.index('byKey').get(`generation:${GENERATION_ID}`);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const entry = request.result as { value: { contentChecksum: string } };
        entry.value.contentChecksum = '0'.repeat(64);
        meta.put(entry);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    expect(report.ok).toBe(false);
    expect(report.checksumMismatches).toContain('meta');
    expect(await repo.readActiveGenerationId()).toBe(generationBefore);
    expect(snapshotLocalStorage().entries()).toEqual(legacyBefore);
  });

  it('leaves the active generation unchanged on a per-record checksum mismatch', async () => {
    const { repo, legacyBefore, generationBefore } = await baseline();
    const internal = (repo as unknown as { db: IDBDatabase }).db;

    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'legacy-migration',
      records: {
        subjects: [
          {
            subjectId: 'subject-checksum',
            schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
            snapshot: JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'],
            createdAt: MIGRATION_NOW,
            updatedAt: MIGRATION_NOW,
          },
        ],
      },
    });

    // Rewrite a record in place without updating its checksum.
    const tx = internal.transaction(['subjects'], 'readwrite');
    const store = tx.objectStore('subjects');
    const getRequest = store.get([GENERATION_ID, 'subject-checksum']);
    await new Promise<void>((resolve, reject) => {
      getRequest.onsuccess = () => {
        const entry = getRequest.result as { value: { updatedAt: string } };
        entry.value.updatedAt = '2099-01-01T00:00:00.000Z';
        store.put(entry);
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      code: 'checksum-mismatch',
      scope: 'checksum',
      count: 1,
      severity: 'error',
    });
    expect(await repo.readActiveGenerationId()).toBe(generationBefore);
    expect(snapshotLocalStorage().entries()).toEqual(legacyBefore);
  });

  it('leaves the active generation unchanged when a receipt write fails', async () => {
    const { repo, legacyBefore, generationBefore } = await baseline();

    const outcome = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage) => {
          if (stage === 'receipt') throw new Error('synthetic receipt failure');
        },
      }),
    );

    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.receiptId).toBeNull();
    expect(await repo.listMigrationReceipts(GENERATION_ID)).toEqual([]);
    expect(await repo.readActiveGenerationId()).toBe(generationBefore);
    expect(snapshotLocalStorage().entries()).toEqual(legacyBefore);
  });

  it('leaves the active generation unchanged when activation itself fails', async () => {
    const { repo, legacyBefore, generationBefore } = await baseline();

    const outcome = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage) => {
          if (stage === 'activate') throw new Error('synthetic activation failure');
        },
      }),
    );

    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.receiptId).not.toBeNull();
    expect(await repo.readActiveGenerationId()).toBe(generationBefore);
    expect(snapshotLocalStorage().entries()).toEqual(legacyBefore);
  });

  it('observes every declared stage exactly once, in order, during a successful run', async () => {
    // Comparing the exported constant against a hard-coded copy of the same
    // strings asserts nothing about behavior. This drives a real migration and
    // checks the stages it actually reaches.
    const repo = await repositoryFor('stage-observability');
    seedLegacyState();
    const seen: MigrationStage[] = [];

    const outcome = await migrateLegacyState(
      migrateOptions(repo, { onStage: (stage) => seen.push(stage) }),
    );

    expect(outcome.report.status).toBe('migrated');
    expect(seen).toEqual([...MIGRATION_STAGES]);
    // Each stage is reached, and reached once.
    expect(new Set(seen).size).toBe(seen.length);
    for (const stage of MIGRATION_STAGES) {
      expect(seen, stage).toContain(stage);
    }
  });

  it('reports each reachable failure as a stage the run actually entered', async () => {
    // The recovery stage must name a step the migration really ran, so a
    // recovery screen cannot point at a phase that had not started yet.
    for (const stage of MIGRATION_STAGES) {
      const { repo, legacyBefore, generationBefore } = await baseline();
      const outcome = await migrateLegacyState(
        migrateOptions(repo, {
          onStage: (current) => {
            if (current === stage) throw new Error(`synthetic failure at ${stage}`);
          },
        }),
      );
      expect(outcome.report.status, stage).toBe('recovery-required');
      expect(outcome.report.recovery?.stage, stage).toBe(stage);
      expect(MIGRATION_STAGES, stage).toContain(outcome.report.recovery!.stage);
      expect(await repo.readActiveGenerationId(), stage).toBe(generationBefore);
      expect(snapshotLocalStorage().entries(), stage).toEqual(legacyBefore);
    }
  });
});

describe('legacy keys remain byte-for-byte untouched', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(async () => {
    await closeRepository();
    resetStorageV2Environment();
  });

  it('leaves the whole storage snapshot identical after a full migration', async () => {
    const repo = await repositoryFor('untouched');
    seedLegacyState();
    const before = snapshotLocalStorage();

    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');

    const after = snapshotLocalStorage();
    expect(after.entries()).toEqual(before.entries());
    // Key order, not just key/value pairs.
    expect(after.keys()).toEqual(before.keys());
    expect(after.keys().length).toBe(before.keys().length);
  });

  it('invokes no mutating method on the REAL localStorage object during a full migration', async () => {
    const repo = await repositoryFor('write-spy');
    seedLegacyState();

    // Instrument the real `Storage` instance the migration would reach through
    // `globalThis.localStorage`. Handing the migration a different object is not
    // enough: a write to the real one would be the actual regression.
    const real = window.localStorage;
    const calls: string[] = [];
    const spies = (['setItem', 'removeItem', 'clear'] as const).map((method) =>
      vi.spyOn(real, method).mockImplementation(((...args: unknown[]) => {
        calls.push(`${method}:${String(args[0])}`);
        return undefined;
      }) as never),
    );

    try {
      const outcome = await migrateLegacyState(migrateOptions(repo));
      expect(outcome.report.status).toBe('migrated');
      expect(calls).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // The real storage is still intact after the run.
    expect(window.localStorage.getItem(STORAGE_KEYS.progression)).not.toBeNull();
  });

  it('invokes no mutating storage method on a substituted full Storage implementation', async () => {
    const repo = await repositoryFor('write-trap');
    seedLegacyState();
    // A full `Storage` implementation, so a substituted reader *could* write.
    const trap = createWriteTrapStorage(snapshotLocalStorage());

    const outcome = await migrateLegacyState(
      migrateOptions(repo, { storage: trap as unknown as ReadOnlyLegacyStorage }),
    );
    expect(outcome.report.status).toBe('migrated');
    expect(trap.mutations).toEqual([]);
    expect(trap.length).toBe(snapshotLocalStorage().keys().length);
  });

  it('reads every allowlisted key it reports on and adds no new key', async () => {
    const repo = await repositoryFor('allowlist-coverage');
    seedLegacyState();
    const before = snapshotLocalStorage();
    const allowlistedBefore = allowlistedKeysIn(before).sort();

    await migrateLegacyState(migrateOptions(repo));

    const after = snapshotLocalStorage();
    expect(allowlistedKeysIn(after).sort()).toEqual(allowlistedBefore);
    expect(after.keys()).toEqual(before.keys());
    for (const [key, value] of before.entries()) {
      expect(after.get(key), key).toBe(value);
    }
  });

  it('preserves recovery payloads byte-for-byte through the migration', async () => {
    const repo = await repositoryFor('recovery-verbatim');
    seedLegacyState();
    const rawBackup = window.localStorage.getItem('knowledge-dungeon:backup:subject-phase0-v100-migration');
    const rawCorrupt = window.localStorage.getItem('knowledge-dungeon:corrupt:subject-phase0-v100-migration');

    await migrateLegacyState(migrateOptions(repo));
    const snapshot = await repo.readGeneration(GENERATION_ID);
    const stored = snapshot?.records.recovery.map((entry) => entry.value) ?? [];

    expect(stored).toEqual(
      expect.arrayContaining([
        { kind: 'backup', subjectId: 'subject-phase0-v100-migration', raw: rawBackup, capturedAt: MIGRATION_NOW },
        { kind: 'corrupt', subjectId: 'subject-phase0-v100-migration', raw: rawCorrupt, capturedAt: MIGRATION_NOW },
      ]),
    );
  });

  it('runs a second migration over the same legacy state without changing it', async () => {
    const repo = await repositoryFor('second-run');
    seedLegacyState();
    const before = snapshotLocalStorage();

    await migrateLegacyState(migrateOptions(repo));
    const second = await migrateLegacyState(migrateOptions(repo, { generationId: `${GENERATION_ID}-2` }));

    expect(second.report.status).toBe('migrated');
    expect(snapshotLocalStorage().entries()).toEqual(before.entries());
  });

  it('rolls a migrated device back to the previous generation', async () => {
    const repo = await repositoryFor('migration-rollback');
    await repo.stageGeneration({ generationId: 'gen-original', source: 'initial', records: {} });
    await repo.activateGeneration('gen-original');
    seedLegacyState();

    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);

    const rollback = await rollbackMigration(repo, 'gen-original');
    expect(rollback.ok).toBe(true);
    expect(await repo.readActiveGenerationId()).toBe('gen-original');
    // The migrated generation is retained, not deleted.
    expect(await repo.readGeneration(GENERATION_ID)).not.toBeNull();
  });
});

describe('attachment bytes and checksums', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(async () => {
    await closeRepository();
    resetStorageV2Environment();
  });

  it('stores an attachment blob keyed by its content hash and reads it back', async () => {
    const repo = await repositoryFor('blobs');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const contentHash = checksumValue(Array.from(bytes));

    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        subjects: [
          {
            subjectId: 'subject-blob',
            schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
            snapshot: JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'],
            createdAt: MIGRATION_NOW,
            updatedAt: MIGRATION_NOW,
          },
        ],
        attachmentMetadata: [
          {
            attachmentId: 'att-synthetic-1',
            subjectId: 'subject-blob',
            roomId: 'room-phase0-v110-minimal-root',
            sourceType: 'local',
            mimeType: 'image/png',
            availability: 'stored',
            contentHash,
            addedAt: MIGRATION_NOW,
          },
        ],
        attachmentBlobs: [
          {
            attachmentId: 'att-synthetic-1',
            contentHash,
            bytes: bytes.buffer,
            byteLength: bytes.byteLength,
            storedAt: MIGRATION_NOW,
          },
        ],
      },
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    expect(report.ok).toBe(true);

    const snapshot = await repo.readGeneration(GENERATION_ID);
    const blob = snapshot?.records.attachmentBlobs[0]?.value;
    expect(blob?.contentHash).toBe(contentHash);
    expect(new Uint8Array(blob?.bytes ?? new ArrayBuffer(0))).toEqual(bytes);
  });

  it('rejects an attachment marked stored with no blob record', async () => {
    const repo = await repositoryFor('blob-missing');
    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        subjects: [
          {
            subjectId: 'subject-blob',
            schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
            snapshot: JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'],
            createdAt: MIGRATION_NOW,
            updatedAt: MIGRATION_NOW,
          },
        ],
        attachmentMetadata: [
          {
            attachmentId: 'att-synthetic-2',
            subjectId: 'subject-blob',
            roomId: 'room-phase0-v110-minimal-root',
            sourceType: 'local',
            mimeType: 'image/png',
            availability: 'stored',
            contentHash: checksumText('present'),
            addedAt: MIGRATION_NOW,
          },
        ],
      },
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      code: 'attachment-without-metadata',
      scope: 'relationship',
      count: 1,
      severity: 'error',
    });
  });

  it('rejects an external-only attachment that claims a content hash', async () => {
    const repo = await repositoryFor('external-with-hash');
    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        subjects: [
          {
            subjectId: 'subject-blob',
            schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
            snapshot: JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'],
            createdAt: MIGRATION_NOW,
            updatedAt: MIGRATION_NOW,
          },
        ],
        attachmentMetadata: [
          {
            attachmentId: 'att-synthetic-3',
            subjectId: 'subject-blob',
            roomId: 'room-phase0-v110-minimal-root',
            sourceType: 'external',
            mimeType: 'image/png',
            availability: 'external-only',
            contentHash: checksumText('nonsense'),
            addedAt: MIGRATION_NOW,
          },
        ],
      },
    });

    const report = await repo.validateGeneration(GENERATION_ID);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      code: 'content-hash-mismatch',
      scope: 'attachment',
      count: 1,
      severity: 'error',
    });
  });
});

describe('determinism', () => {
  beforeEach(() => {
    resetStorageV2Environment();
  });

  afterEach(async () => {
    await closeRepository();
    resetStorageV2Environment();
  });

  it('produces byte-identical records for the same legacy state and clock', async () => {
    const first = await repositoryFor('determinism-1');
    seedLegacyState();
    await migrateLegacyState(migrateOptions(first));
    const firstRecords = recordProjection(await canonicalSnapshot(first));

    resetStorageV2Environment();
    const second = await repositoryFor('determinism-2');
    seedLegacyState();
    await migrateLegacyState(migrateOptions(second));
    const secondRecords = recordProjection(await canonicalSnapshot(second));

    expect(JSON.stringify(secondRecords)).toBe(JSON.stringify(firstRecords));
  });

  it('uses an injected id factory, never Math.random', async () => {
    await repositoryFor('id-factory');
    const factory = createDeterministicIdFactory('seed');
    expect(factory.next()).toBe('seed-0001');
    expect(factory.next()).toBe('seed-0002');

    // A separate repository handle proves the injected clock is what stamps
    // records, not the system clock.
    const stamped = await openStorageV2Repository({
      databaseName: nextDatabaseName('clock'),
      clock: fixedClock('2030-01-01T00:00:00.000Z'),
      idFactory: createDeterministicIdFactory('clock'),
    });
    const staged = await stamped.stageGeneration({ generationId: 'gen-clock', source: 'initial', records: {} });
    expect(staged.descriptor.createdAt).toBe('2030-01-01T00:00:00.000Z');
    expect(staged.descriptor.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
    stamped.close();
    await deleteTestDatabase('kd-storage-v2-test-clock-0');
  });
});

describe('test-fixture hygiene', () => {
  it('reads every fixture from the Phase 0 synthetic fixture set', () => {
    const file = readFileSync(join(FIXTURE_ROOT, 'README.md'), 'utf8');

    expect(file).toContain('synthetic');
    expect(V10_SUBJECT).toContain('synthetic');
    expect(V10_FULL_SUBJECT).toContain('synthetic');
    expect(V10_MINIMAL_SUBJECT).toContain('synthetic');
    expect(V11_SUBJECT).toContain('synthetic');
    expect(V11_FULL_SUBJECT).toContain('synthetic');
    expect(INVALID_SYNTAX_SUBJECT).toContain('synthetic');
    // The real missing-room fixture, which the importer rejects, so the
    // migration must not carry it.
    expect(MISSING_ROOM_SUBJECT).toContain('synthetic');
    expect(MISSING_ROOM_SUBJECT).not.toBe(V10_SUBJECT);
    expect(() => JSON.parse(MISSING_ROOM_SUBJECT)).not.toThrow();
    expect(isImportableSubjectSnapshot(JSON.parse(MISSING_ROOM_SUBJECT))).toBe(false);
  });

  it('keeps every storage-v2 store name in the plan list', () => {
    const expected: StorageV2StoreName[] = [
      'meta',
      'subjects',
      'progression',
      'sessions',
      'preferences',
      'shortcuts',
      'assistance',
      'attachments',
      'customSprites',
      'recovery',
      'migrationReceipts',
    ];

    expect([...STORAGE_V2_STORE_NAMES]).toEqual(expected);
  });
});
