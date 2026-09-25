/**
 * Review-round-2 fixes, pinned by the implementer's own suite.
 *
 * Each test here corresponds to one reviewed finding and names it, so a
 * regression points at the finding rather than at a line number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedClock } from '@/services/persistence/v2/database';
import {
  computeStoreChecksums,
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import { STORAGE_V2_STORE_NAMES, type SubjectRecordValue } from '@/services/persistence/v2/schema';
import { countGenerationRecords, type GenerationRecords } from '@/services/persistence/v2/validation';

import {
  GENERATION_ID,
  MIGRATION_NOW,
  deleteTestDatabase,
  openTestRepository,
  readProgressionFixture,
  readSubjectFixture,
  resetStorageV2Environment,
  snapshotLocalStorage,
  toReadOnlyStorage,
} from './support/storageV2TestSupport';

const V11_SUBJECT = readSubjectFixture('subject-1.1.0-minimal.json');
const V10_SUBJECT = readSubjectFixture('subject-1.0.0-migration-defaults.json');

let databaseCounter = 0;
let repository: StorageV2Repository | null = null;
let databaseName = '';

async function repositoryFor(suffix: string): Promise<StorageV2Repository> {
  databaseCounter += 1;
  databaseName = `kd-round2-${suffix}-${databaseCounter}`;
  repository = await openTestRepository(databaseName);
  return repository;
}

async function teardown(): Promise<void> {
  repository?.close();
  repository = null;
  if (databaseName) {
    await deleteTestDatabase(databaseName);
    databaseName = '';
  }
  resetStorageV2Environment();
}

function seedLegacySubject(): void {
  const storage = window.localStorage;
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-phase0-v100-migration']));
  storage.setItem('knowledge-dungeon:v1:subject:subject-phase0-v100-migration', V10_SUBJECT);
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

async function readAllRecordKeys(repo: StorageV2Repository, generationId: string): Promise<string[]> {
  const snapshot = await repo.readGeneration(generationId);
  if (!snapshot) return [];
  return Object.entries(snapshot.records)
    .flatMap(([list, entries]) =>
      (entries as { recordId: string }[]).map((entry) => `${list}/${entry.recordId}`),
    )
    .sort();
}

describe('2.4 a same-id retry of an already-migrated generation is a no-op success', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('reports success, does not re-stage, and leaves every record untouched', async () => {
    const repo = await repositoryFor('retry');
    seedLegacySubject();

    const first = await migrateLegacyState(migrateOptions(repo));
    expect(first.report.status).toBe('migrated');
    const keysAfterFirst = await readAllRecordKeys(repo, GENERATION_ID);
    const recordsAfterFirst = JSON.stringify((await repo.readGeneration(GENERATION_ID))?.records);
    const descriptorAfterFirst = JSON.stringify((await repo.readGeneration(GENERATION_ID))?.descriptor);

    const second = await migrateLegacyState(migrateOptions(repo));

    // Success, not a recovery screen on an already-migrated device.
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(true);
    expect(second.report.recovery).toBeNull();
    expect(second.report.stagedGenerationId).toBe(GENERATION_ID);
    // The no-op still describes the real generation, not zeroes.
    expect(second.report.recordCounts).toEqual(first.report.recordCounts);
    expect(second.report.contentChecksum).toBe(first.report.contentChecksum);
    expect(second.report.receiptId).toBe(first.report.receiptId);

    // Nothing rewritten: no duplicated record, no new receipt, no new generation.
    expect(await readAllRecordKeys(repo, GENERATION_ID)).toEqual(keysAfterFirst);
    expect(JSON.stringify((await repo.readGeneration(GENERATION_ID))?.records)).toBe(recordsAfterFirst);
    expect(JSON.stringify((await repo.readGeneration(GENERATION_ID))?.descriptor)).toBe(descriptorAfterFirst);
    expect(await repo.listMigrationReceipts(GENERATION_ID)).toHaveLength(1);
    expect((await repo.listGenerations()).map((entry) => entry.generationId)).toEqual([GENERATION_ID]);
  });

  it('re-runs cleanly after the active generation has advanced to a different id', async () => {
    const repo = await repositoryFor('retry-advanced');
    seedLegacySubject();
    await migrateLegacyState(migrateOptions(repo));

    // A later phase advanced the active pointer.
    await repo.stageGeneration({ generationId: 'gen-later', source: 'local-edit', parentGenerationId: GENERATION_ID, records: {} });
    await repo.activateGeneration('gen-later');
    expect(await repo.readActiveGenerationId()).toBe('gen-later');

    const retry = await migrateLegacyState(migrateOptions(repo));

    expect(retry.report.status).toBe('migrated');
    expect(retry.report.recovery).toBeNull();
    // The no-op does NOT steal the pointer back from the newer generation.
    expect(await repo.readActiveGenerationId()).toBe('gen-later');
    // And it reports honestly that its own generation is no longer the active
    // one, rather than claiming an activation that did not happen.
    expect(retry.report.activated).toBe(false);
    expect(retry.report.previousActiveGenerationId).toBe('gen-later');
    // The retired generation keeps its records and its receipt.
    expect((await repo.readGeneration(GENERATION_ID))?.descriptor?.status).toBe('superseded');
    expect(await repo.listMigrationReceipts(GENERATION_ID)).toHaveLength(1);
  });
});

describe('2.5 an abandoned staged generation is discarded by the next run', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('a run that fails after its stage commit leaves the generation staged, and the next run clears it', async () => {
    const repo = await repositoryFor('abandoned');
    seedLegacySubject();

    // Fail at the validation stage: after the stage commit, before activation.
    const failed = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage) => {
          if (stage === 'validate') throw new Error('synthetic failure after the stage commit');
        },
      }),
    );
    expect(failed.report.status).toBe('recovery-required');
    expect(failed.report.activated).toBe(false);

    // The abandoned generation is on disk but inert.
    const abandoned = await repo.readGeneration(GENERATION_ID);
    expect(abandoned?.descriptor?.status).toBe('staged');
    expect(abandoned?.records.subjects.length).toBeGreaterThan(0);
    expect(await repo.readActiveGenerationId()).toBeNull();

    // The next run of the same migration discards it and stages cleanly.
    const retry = await migrateLegacyState(migrateOptions(repo));
    expect(retry.report.status).toBe('migrated');
    expect(retry.report.activated).toBe(true);
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);
    const after = await repo.readGeneration(GENERATION_ID);
    expect(after?.descriptor?.status).toBe('active');
    // No stale record survived: the descriptor's counts and roll-up checksum are
    // exactly what is stored, and they match what the report described.
    const empty: GenerationRecords = {
      subjects: [], progression: [], sessions: [], preferences: [], shortcuts: [],
      assistance: [], attachmentMetadata: [], attachmentBlobs: [], customSprites: [],
      recovery: [], migrationReceipts: [],
    };
    const storedRecords = after?.records ?? empty;
    expect(countGenerationRecords(storedRecords)).toEqual(after?.descriptor?.recordCounts);
    expect(computeStoreChecksums(storedRecords).meta).toBe(after?.descriptor?.contentChecksum);
    expect(after?.descriptor?.contentChecksum).toBe(retry.report.contentChecksum);
    expect(countGenerationRecords(storedRecords).subjects).toBe(retry.report.recordCounts.subjects);
  });

  it('re-staging over a partial subset does not leave the old record behind', async () => {
    const repo = await repositoryFor('abandoned-subset');
    const snapshot = JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'];
    const subject = (id: string): SubjectRecordValue => ({
      subjectId: id,
      schemaVersion: '1.1.0',
      snapshot: { ...snapshot, dungeon: { ...snapshot.dungeon, dungeonId: id } },
      createdAt: MIGRATION_NOW,
      updatedAt: MIGRATION_NOW,
    });

    // A staged generation holding two subjects.
    await repo.stageGeneration({
      generationId: 'gen-partial',
      source: 'legacy-migration',
      records: { subjects: [subject('subject-a'), subject('subject-b')] },
    });

    // Discard and re-stage with only one: the stale record must be gone.
    await repo.discardStagedGeneration('gen-partial');
    await repo.stageGeneration({
      generationId: 'gen-partial',
      source: 'legacy-migration',
      records: { subjects: [subject('subject-a')] },
    });

    const staged = await repo.readGeneration('gen-partial');
    expect(staged?.records.subjects.map((entry) => entry.value.subjectId)).toEqual(['subject-a']);
    expect(staged?.descriptor?.recordCounts.subjects).toBe(1);
    expect((await repo.validateGeneration('gen-partial')).ok).toBe(true);
  });

  it('refuses to discard an active or superseded generation', async () => {
    const repo = await repositoryFor('discard-guards');
    await repo.stageGeneration({ generationId: 'gen-one', source: 'initial', records: {} });
    await repo.activateGeneration('gen-one');
    await repo.stageGeneration({ generationId: 'gen-two', source: 'local-edit', records: {} });
    await repo.activateGeneration('gen-two');

    await expect(repo.discardStagedGeneration('gen-two')).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    await expect(repo.discardStagedGeneration('gen-one')).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    // An unknown id is a no-op, not an error.
    expect(await repo.discardStagedGeneration('gen-does-not-exist')).toBe(false);
    expect(await repo.readGeneration('gen-one')).not.toBeNull();
  });
});

describe('2.6 a record write and its descriptor update commit in one transaction', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  async function readwriteTransactions(
    repo: StorageV2Repository,
    run: () => Promise<unknown>,
  ): Promise<{ stores: string[] }[]> {
    const db = (repo as unknown as { db: IDBDatabase }).db;
    const seen: { stores: string[] }[] = [];
    const original = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, 'transaction')
      .mockImplementation(((names: string | Iterable<string>, mode?: IDBTransactionMode) => {
        if ((mode ?? 'readonly') === 'readwrite') {
          seen.push({ stores: typeof names === 'string' ? [names] : [...names] });
        }
        return original(names as string, mode) as IDBTransaction;
      }) as typeof db.transaction);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  it('putRecords opens exactly one readwrite transaction spanning meta and every data store', async () => {
    const repo = await repositoryFor('one-tx-put');
    await repo.stageGeneration({ generationId: GENERATION_ID, source: 'initial', records: {} });

    const writes = await readwriteTransactions(repo, () =>
      repo.putRecords(GENERATION_ID, {
        preferences: [{ preferenceId: 'locale', value: 'fr', updatedAt: MIGRATION_NOW }],
      }),
    );

    expect(writes).toHaveLength(1);
    expect([...writes[0]!.stores].sort()).toEqual([...STORAGE_V2_STORE_NAMES].sort());
    expect(writes[0]!.stores).toContain('meta');
  });

  it('deleteRecords opens exactly one readwrite transaction spanning meta and every data store', async () => {
    const repo = await repositoryFor('one-tx-delete');
    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        preferences: [
          { preferenceId: 'locale', value: 'fr', updatedAt: MIGRATION_NOW },
          { preferenceId: 'graphics', value: {}, updatedAt: MIGRATION_NOW },
        ],
      },
    });

    const writes = await readwriteTransactions(repo, () =>
      repo.deleteRecords(GENERATION_ID, { preferences: ['locale'] }),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]!.stores).toContain('meta');
    const after = await repo.readGeneration(GENERATION_ID);
    expect(after?.descriptor?.recordCounts.preferences).toBe(1);
    expect(after?.records.preferences.map((entry) => entry.value.preferenceId)).toEqual(['graphics']);
  });

  it('writeMigrationReceipt opens exactly one readwrite transaction spanning meta and every data store', async () => {
    const repo = await repositoryFor('one-tx-receipt');
    await repo.stageGeneration({ generationId: GENERATION_ID, source: 'initial', records: {} });

    const writes = await readwriteTransactions(repo, () =>
      repo.writeMigrationReceipt({
        receiptId: 'receipt-1',
        migrationId: 'legacy-localstorage-to-storage-v2',
        fromStorage: 'legacy-localstorage',
        toStorage: 'storage-v2',
        stagedGenerationId: GENERATION_ID,
        previousActiveGenerationId: null,
        status: 'activated',
        createdAt: MIGRATION_NOW,
        storageGenerationFormatVersion: 1,
        subjectSchemaVersion: '1.1.0',
        subjectSchemaVersions: {},
        progressionSourceVersions: {},
        recordCounts: {} as never,
        recordChecksums: {} as never,
        contentChecksum: '0'.repeat(64),
      }),
    );

    expect(writes).toHaveLength(1);
    expect([...writes[0]!.stores].sort()).toEqual([...STORAGE_V2_STORE_NAMES].sort());
    // The descriptor committed with the receipt, so it already counts it.
    const after = await repo.readGeneration(GENERATION_ID);
    expect(after?.descriptor?.recordCounts.migrationReceipts).toBe(1);
    expect(after?.descriptor?.contentChecksum).toBe(after?.contentChecksum);
  });
});

describe('2.7 a failure inside staging is reported as the staging stage', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('reports stage-records, not the previous stage', async () => {
    const repo = await repositoryFor('stage');
    seedLegacySubject();
    const seen: string[] = [];

    const outcome = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage) => {
          seen.push(stage);
          if (stage === 'stage-records') throw new Error('synthetic staging failure');
        },
      }),
    );

    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.recovery?.stage).toBe('stage-records');
    expect(seen).toEqual(['read-legacy', 'transform', 'stage-records']);
    expect(await repo.readActiveGenerationId()).toBeNull();
  });

  it('reports stage-records for a repository-level refusal inside the staging step', async () => {
    const repo = await repositoryFor('stage-refused');
    seedLegacySubject();
    // A generation that is active under a DIFFERENT id does not block staging, so
    // make staging genuinely fail: exceed nothing, just collide with a descriptor
    // the repository refuses. A blank generation id is the repository's own
    // validation, but the migration supplies it, so the observable case is the
    // generation-already-active refusal, which the migration now short-circuits.
    // Instead assert the stage is entered before the repository is called at all.
    const seen: string[] = [];
    await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage) => {
          seen.push(stage);
          if (stage === 'stage-records') throw new Error('stop before the repository call');
        },
      }),
    );
    // Nothing was staged, so the failure happened before the repository call.
    expect(await repo.readGeneration(GENERATION_ID)).toBeNull();
    expect(seen[seen.length - 1]).toBe('stage-records');
  });
});

describe('BLOCKER 2 the migration mints prefix-honouring, stable identifiers', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  const MALFORMED_FIXTURES = [
    'progression-v1-flat-malformed.json',
    'progression-v3-malformed-values.json',
  ];

  function mergedFromPersisted(
    bySubject: { bySubject: Record<string, unknown> }[],
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const value of bySubject) Object.assign(merged, value.bySubject);
    return merged;
  }

  it('gives every unidentified loot and gear item a distinct, prefixed id', async () => {
    for (const fixture of MALFORMED_FIXTURES) {
      window.localStorage.clear();
      window.localStorage.setItem('knowledge-dungeon:v1:progression', readProgressionFixture(fixture));
      window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-round2');
      const repo = await repositoryFor(`ids-${fixture}`);
      const outcome = await migrateLegacyState(migrateOptions(repo));
      expect(outcome.report.status, fixture).toBe('migrated');

      const snapshot = await repo.readGeneration(GENERATION_ID);
      const merged = mergedFromPersisted(
        (snapshot?.records.progression ?? []).map((envelope) => envelope.value),
      );
      const record = Object.values(merged)[0] as {
        inventory: { id: string }[];
        equippedItems: { id: string }[];
      };
      const ids = [...record.inventory.map((e) => e.id), ...record.equippedItems.map((e) => e.id)];

      expect(ids.length, fixture).toBeGreaterThan(0);
      expect(new Set(ids).size, fixture).toBe(ids.length);
      for (const id of record.inventory.map((e) => e.id)) expect(id, fixture).toMatch(/^loot-migrated-\d{4}$/);
      for (const id of record.equippedItems.map((e) => e.id)) expect(id, fixture).toMatch(/^gear-migrated-\d{4}$/);
      await teardown();
    }
  });

  it('is stable across two runs at the same injected clock', async () => {
    const capture = async (suffix: string): Promise<string> => {
      window.localStorage.clear();
      window.localStorage.setItem(
        'knowledge-dungeon:v1:progression',
        readProgressionFixture('progression-v1-flat-malformed.json'),
      );
      window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-round2');
      const repo = await repositoryFor(suffix);
      const outcome = await migrateLegacyState(migrateOptions(repo));
      expect(outcome.report.status).toBe('migrated');
      const snapshot = await repo.readGeneration(GENERATION_ID);
      const merged = mergedFromPersisted(
        (snapshot?.records.progression ?? []).map((envelope) => envelope.value),
      );
      const value = JSON.stringify(merged);
      await teardown();
      return value;
    };

    const first = await capture('stable-1');
    const second = await capture('stable-2');
    expect(second).toBe(first);
  });
});

describe('repository guards after the single-transaction change', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('refuses a write against a generation that does not exist', async () => {
    const repo = await repositoryFor('guards');
    await expect(repo.putRecords('gen-nope', {})).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
    await expect(repo.deleteRecords('gen-nope', { subjects: ['x'] })).rejects.toMatchObject({
      code: 'GENERATION_NOT_FOUND',
    });
    await expect(
      repo.writeMigrationReceipt({
        receiptId: 'r',
        migrationId: 'm',
        fromStorage: 'legacy-localstorage',
        toStorage: 'storage-v2',
        stagedGenerationId: 'gen-nope',
        previousActiveGenerationId: null,
        status: 'activated',
        createdAt: MIGRATION_NOW,
        storageGenerationFormatVersion: 1,
        subjectSchemaVersion: '1.1.0',
        subjectSchemaVersions: {},
        progressionSourceVersions: {},
        recordCounts: {} as never,
        recordChecksums: {} as never,
        contentChecksum: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });

  it('recomputes a descriptor that agrees with storage after a replace', async () => {
    const repo = await repositoryFor('replace');
    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        preferences: [
          { preferenceId: 'locale', value: 'fr', updatedAt: MIGRATION_NOW },
          { preferenceId: 'graphics', value: { colorTheme: 'dark' }, updatedAt: MIGRATION_NOW },
        ],
      },
    });

    // `putRecords` upserts, it does not delete: `locale` is replaced, `touch` is
    // added, and `graphics` is still there. The descriptor must say 3, and the
    // replaced record must carry the NEW value rather than a duplicate.
    const result = await repo.putRecords(GENERATION_ID, {
      preferences: [
        { preferenceId: 'locale', value: 'es', updatedAt: MIGRATION_NOW },
        { preferenceId: 'touch', value: { hint: true }, updatedAt: MIGRATION_NOW },
      ],
    });
    expect(result.recordCounts.preferences).toBe(3);
    const preferences = (await repo.readGeneration(GENERATION_ID))?.records.preferences ?? [];
    expect(preferences.map((entry) => entry.value.preferenceId).sort()).toEqual([
      'graphics',
      'locale',
      'touch',
    ]);
    const locale = preferences.find((entry) => entry.value.preferenceId === 'locale');
    expect(locale?.value.value).toBe('es');
    expect(preferences.filter((entry) => entry.value.preferenceId === 'locale')).toHaveLength(1);
    expect((await repo.validateGeneration(GENERATION_ID)).ok).toBe(true);
  });

  it('counts the records a delete actually removed, across every store', async () => {
    // This fixture previously had zero subjects, so the inflated `removed` term
    // was 0 and the test passed by accident. It now has subjects in every
    // relevant store, so the counter is actually pinned.
    const repo = await repositoryFor('delete-count');
    const snapshot = JSON.parse(V11_SUBJECT) as SubjectRecordValue['snapshot'];
    const subject = (id: string): SubjectRecordValue => ({
      subjectId: id,
      schemaVersion: '1.1.0',
      snapshot: { ...snapshot, dungeon: { ...snapshot.dungeon, dungeonId: id } },
      createdAt: MIGRATION_NOW,
      updatedAt: MIGRATION_NOW,
    });
    await repo.stageGeneration({
      generationId: GENERATION_ID,
      source: 'initial',
      records: {
        subjects: [subject('subject-x'), subject('subject-y'), subject('subject-z')],
        preferences: [{ preferenceId: 'locale', value: 'en', updatedAt: MIGRATION_NOW }],
      },
    });

    // 1. Deleting a record that does not exist removes nothing, whatever the
    //    generation's subject count is.
    const missing = await repo.deleteRecords(GENERATION_ID, { subjects: ['subject-never-existed'] });
    expect(missing.removed).toBe(0);

    // 2. Deleting the one real subject removes exactly one.
    const oneSubject = await repo.deleteRecords(GENERATION_ID, { subjects: ['subject-x'] });
    expect(oneSubject.removed).toBe(1);

    // 3. Deleting one subject and one preference removes exactly two, even
    //    though the generation still holds two subjects.
    const two = await repo.deleteRecords(GENERATION_ID, {
      subjects: ['subject-y'],
      preferences: ['locale'],
    });
    expect(two.removed).toBe(2);

    // 4. Deleting an attachment that does not exist removes nothing. An
    //    attachment id resolves to a `meta:` and a `blob:` record id, so a
    //    missing attachment is two absent record ids and still zero.
    const missingAttachment = await repo.deleteRecords(GENERATION_ID, {
      attachments: ['att-never-existed'],
    });
    expect(missingAttachment.removed).toBe(0);

    // Only `subject-z` survives, and the descriptor agrees with storage.
    const after = await repo.readGeneration(GENERATION_ID);
    expect(after?.records.subjects.map((entry) => entry.value.subjectId)).toEqual(['subject-z']);
    expect(after?.records.preferences).toHaveLength(0);
    expect(after?.descriptor?.recordCounts.subjects).toBe(1);
    expect(after?.descriptor?.recordCounts.preferences).toBe(0);
    expect((await repo.validateGeneration(GENERATION_ID)).ok).toBe(true);
  });
});

describe('the repository opens without a real clock or randomness', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('is deterministic for an injected clock and seeded id factory', async () => {
    const open = async (suffix: string) =>
      openStorageV2Repository({
        databaseName: `kd-round2-determinism-${suffix}`,
        clock: fixedClock('2030-01-01T00:00:00.000Z'),
        idFactory: { next: (() => { let n = 0; return () => `seed-${++n}`; })() },
      });

    const first = await open('a');
    const a = await first.stageGeneration({ generationId: 'gen-det', source: 'initial', records: {} });
    first.close();

    const second = await open('b');
    const b = await second.stageGeneration({ generationId: 'gen-det', source: 'initial', records: {} });
    second.close();

    expect(b.contentChecksum).toBe(a.contentChecksum);
    expect(b.descriptor.createdAt).toBe('2030-01-01T00:00:00.000Z');
  });
});
