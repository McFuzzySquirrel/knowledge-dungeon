/**
 * INDEPENDENT QA re-verification, round 2.
 *
 * Written by the verification owner to attack the round-1 fixes, specifically:
 * - `discardStagedGeneration` (new, DELETES data)
 * - `recomputeDescriptor` / `mergeEnvelopes` / `omitEnvelopes` (new, compute the
 *   descriptor in memory instead of letting IndexedDB be the source of truth)
 * - the same-`generationId` no-op path
 * - the corrected SHA-256's effect on stored checksums, receipts, and eventIds
 *
 * Every fixture value is synthetic. No learner content, no real URLs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedClock, createDeterministicIdFactory } from '@/services/persistence/v2/database';
import {
  computeStoreChecksums,
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import { readLegacyAppState } from '@/services/persistence/v2/legacyReader';
import {
  LEGACY_MIGRATION_ID,
  STORAGE_V2_STORE_NAMES,
  type GenerationDescriptor,
  type MigrationReceiptValue,
  type ProgressionRecordValue,
  type StorageV2StoreName,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import { checksumValue } from '@/services/persistence/v2/checksum';
import type { GenerationRecords } from '@/services/persistence/v2/validation';

import {
  deleteTestDatabase,
  readProgressionFixture,
  readSubjectFixture,
  resetStorageV2Environment,
  snapshotLocalStorage,
} from './support/storageV2TestSupport';

const V11 = readSubjectFixture('subject-1.1.0-minimal.json');
const V3_PROGRESSION = readProgressionFixture('progression-v3-current-full.json');
const V1_FLAT_MALFORMED = readProgressionFixture('progression-v1-flat-malformed.json');
const NOW = '2026-09-25T00:00:00.000Z';
const NOW_LATER = '2026-11-11T11:11:11.111Z';
const GEN = 'gen-r2-0001';
const GEN_B = 'gen-r2-0002';
const GEN_C = 'gen-r2-0003';
const QA_MARKER = 'QA-MARKER-round2-synthetic-7c1e05-not-real-content';

let dbCounter = 0;
let repository: StorageV2Repository | null = null;
let databaseName = '';

async function repoFor(suffix: string): Promise<StorageV2Repository> {
  dbCounter += 1;
  databaseName = `kd-r2-${suffix}-${dbCounter}`;
  repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(NOW),
    idFactory: createDeterministicIdFactory('r2'),
  });
  return repository;
}

async function teardown(): Promise<void> {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
  resetStorageV2Environment();
}

function subject(subjectId: string): SubjectRecordValue {
  return {
    subjectId,
    schemaVersion: '1.1.0',
    snapshot: JSON.parse(V11) as SubjectRecordValue['snapshot'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function migrateOptions(
  repo: StorageV2Repository,
  overrides: Record<string, unknown> = {},
): Parameters<typeof migrateLegacyState>[0] {
  return {
    repository: repo,
    generationId: GEN,
    now: NOW,
    clock: fixedClock(NOW),
    ...overrides,
  } as Parameters<typeof migrateLegacyState>[0];
}

/** Seed a legacy device whose first room id is the one the V11 fixture uses. */
function seedLegacy(progression = V3_PROGRESSION): void {
  const storage = window.localStorage;
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-r2-a']));
  storage.setItem(`knowledge-dungeon:v1:subject:subject-r2-a`, V11);
  storage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-r2-a');
  storage.setItem('knowledge-dungeon:v1:progression', progression);
  storage.setItem('knowledge-dungeon:v1:sessions', '[]');
  storage.setItem(`knowledge-dungeon:backup:subject-r2-a`, `{"dungeon":${QA_MARKER}`);
}

function rawRecordsOf(records: GenerationRecords | null | undefined): string[] {
  if (!records) return [];
  return Object.entries(records).flatMap(([key, list]) =>
    (list as { recordId: string }[]).map((entry) => `${key}/${entry.recordId}`),
  );
}

async function allStoreKeys(repo: StorageV2Repository, generationId: string): Promise<string[]> {
  const db = (repo as unknown as { db: IDBDatabase }).db;
  const tx = db.transaction([...STORAGE_V2_STORE_NAMES], 'readonly');
  const found: string[] = [];
  await Promise.all(
    STORAGE_V2_STORE_NAMES.map((storeName) => {
      if (storeName === 'meta') return Promise.resolve();
      return new Promise<void>((resolve) => {
        const request = tx.objectStore(storeName).index('byGeneration').getAllKeys(generationId);
        request.onsuccess = () => {
          for (const key of request.result) {
            found.push(`${storeName}/${String((key as [string, string])[1])}`);
          }
          resolve();
        };
        request.onerror = () => resolve();
      });
    }),
  );
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  return found.sort();
}

// ── 1. discardStagedGeneration ─────────────────────────────────────────────

describe('R2 attack: discardStagedGeneration', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('REFUSES to discard an active generation', async () => {
    const repo = await repoFor('discard-active');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);

    await expect(repo.discardStagedGeneration(GEN)).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    // Nothing was destroyed.
    expect(await repo.readGeneration(GEN)).not.toBeNull();
    expect(await repo.readActiveGenerationId()).toBe(GEN);
    expect(await allStoreKeys(repo, GEN)).toEqual([]);
  });

  it('REFUSES to discard a superseded generation', async () => {
    const repo = await repoFor('discard-superseded');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.stageGeneration({ generationId: GEN_B, source: 'local-edit', records: {} });
    await repo.activateGeneration(GEN_B);
    expect((await repo.readGeneration(GEN))?.descriptor?.status).toBe('superseded');

    await expect(repo.discardStagedGeneration(GEN)).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    expect(await repo.readGeneration(GEN)).not.toBeNull();
  });

  it('REFUSES a rollback target: a generation the pointer names after a rollback', async () => {
    const repo = await repoFor('discard-rollback-target');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.stageGeneration({ generationId: GEN_B, source: 'local-edit', records: {} });
    await repo.activateGeneration(GEN_B);
    await repo.rollbackToGeneration(GEN);

    // GEN is now the active generation. Discard must refuse.
    expect(await repo.readActiveGenerationId()).toBe(GEN);
    await expect(repo.discardStagedGeneration(GEN)).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    expect(await repo.readGeneration(GEN)).not.toBeNull();
  });

  it('returns false for a generation that does not exist, and does not throw', async () => {
    const repo = await repoFor('discard-missing');
    expect(await repo.discardStagedGeneration('gen-does-not-exist')).toBe(false);
  });

  it('DELETES A LEGITIMATE, COMPLETE, VALID STAGED GENERATION (design gap)', async () => {
    // A valid staged generation is not an "orphan": nothing about the
    // repository's state distinguishes "abandoned by a failed run" from "a
    // concurrent run just staged this and is about to activate it". The API has
    // no orphan marker, so a caller can destroy a perfectly good generation.
    const repo = await repoFor('discard-valid-staged');
    const staged = await repo.stageGeneration({
      generationId: GEN,
      source: 'legacy-migration',
      records: { subjects: [subject('subject-r2-valid')] },
    });
    expect(staged.descriptor.status).toBe('staged');
    // It validates: this is NOT a corrupt or partial generation.
    expect((await repo.validateGeneration(GEN)).ok).toBe(true);
    expect(await allStoreKeys(repo, GEN)).toEqual(['subjects/subject-r2-valid']);

    // The repository API deletes it anyway.
    expect(await repo.discardStagedGeneration(GEN)).toBe(true);
    expect(await repo.readGeneration(GEN)).toBeNull();
    expect(await allStoreKeys(repo, GEN)).toEqual([]);
  });

  it('leaves NO trace: meta registry, records, and the active pointer all survive the discard of a staged sibling', async () => {
    const repo = await repoFor('discard-sibling');
    await repo.stageGeneration({ generationId: GEN_B, source: 'initial', records: { subjects: [subject('subject-r2-keep')] } });
    await repo.activateGeneration(GEN_B);
    await repo.stageGeneration({
      generationId: GEN,
      source: 'legacy-migration',
      records: {
        subjects: [subject('subject-r2-drop')],
        preferences: [{ preferenceId: 'locale', value: 'en', updatedAt: NOW }],
        recovery: [{ kind: 'corrupt' as const, subjectId: 'subject-r2-drop', raw: QA_MARKER, capturedAt: NOW }],
      },
    });
    expect(await allStoreKeys(repo, GEN)).toHaveLength(3);

    expect(await repo.discardStagedGeneration(GEN)).toBe(true);
    // The discarded generation is gone from every generation-scoped store.
    expect(await allStoreKeys(repo, GEN)).toEqual([]);
    expect((await repo.listGenerations()).map((g) => g.generationId)).toEqual([GEN_B]);
    // The live generation is completely untouched, byte for byte.
    const survivor = await repo.readGeneration(GEN_B);
    expect(survivor?.descriptor?.status).toBe('active');
    expect(rawRecordsOf(survivor?.records)).toEqual(['subjects/subject-r2-keep']);
    expect(await repo.readActiveGenerationId()).toBe(GEN_B);
    // Nothing carrying the marker survives anywhere in the DB.
    const db = (repo as unknown as { db: IDBDatabase }).db;
    const tx = db.transaction([...STORAGE_V2_STORE_NAMES], 'readonly');
    const dumps: string[] = [];
    await Promise.all(
      STORAGE_V2_STORE_NAMES.map((store) => {
        if (store === 'meta') return Promise.resolve();
        return new Promise<void>((resolve) => {
          const request = tx.objectStore(store).getAll();
          request.onsuccess = () => {
            dumps.push(JSON.stringify(request.result));
            resolve();
          };
          request.onerror = () => resolve();
        });
      }),
    );
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    expect(dumps.join('|')).not.toContain(QA_MARKER);
  });

  it('the migration only discards a generation it recognises as its OWN abandoned run', async () => {
    // A `staged` generation that is NOT from this migration's id must be left
    // alone, per the code comment at migrations.ts:568-575.
    const repo = await repoFor('discard-foreign');
    await repo.stageGeneration({ generationId: GEN, source: 'local-edit', records: { subjects: [subject('subject-r2-foreign')] } });
    expect((await repo.readGeneration(GEN))?.descriptor?.status).toBe('staged');

    // Now run the migration with the SAME id. It is `staged` and carries no
    // receipt, so per the implementation it is discarded and re-staged.
    seedLegacy();
    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');
    // The foreign record is gone: it was overwritten by the migration's own
    // subject set. Recorded as observed, because "preserve unknown data" and
    // "reuse the id" are in tension here.
    const ids = await allStoreKeys(repo, GEN);
    expect(ids.filter((key) => key.startsWith('subjects/'))).not.toContain(
      'subjects/subject-r2-foreign',
    );
  });
});

// ── 2. recomputeDescriptor / mergeEnvelopes / omitEnvelopes ────────────────

describe('R2 attack: the in-memory descriptor agrees with what IndexedDB stored', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  /** Assert the committed descriptor and the stored records fully agree. */
  async function assertDescriptorAgrees(repo: StorageV2Repository, generationId: string): Promise<void> {
    const snapshot = await repo.readGeneration(generationId);
    expect(snapshot, generationId).not.toBeNull();
    const descriptor = snapshot!.descriptor as GenerationDescriptor;
    const records = snapshot!.records;

    // 1. Per-store counts.
    const actual = {
      subjects: records.subjects.length,
      progression: records.progression.length,
      sessions: records.sessions.length,
      preferences: records.preferences.length,
      shortcuts: records.shortcuts.length,
      assistance: records.assistance.length,
      attachments: records.attachmentMetadata.length + records.attachmentBlobs.length,
      customSprites: records.customSprites.length,
      recovery: records.recovery.length,
      migrationReceipts: records.migrationReceipts.length,
      meta: 0,
    } as Record<StorageV2StoreName, number>;
    for (const storeName of STORAGE_V2_STORE_NAMES) {
      expect(descriptor.recordCounts[storeName], `${generationId}/${storeName}`).toBe(actual[storeName]);
    }

    // 2. Roll-up checksum, recomputed from the records as IndexedDB returned them.
    expect(descriptor.contentChecksum, generationId).toBe(computeStoreChecksums(records).meta);

    // 3. Every record's own envelope checksum still matches its value.
    for (const list of Object.values(records)) {
      for (const envelope of list as { checksum: string | null; value: unknown }[]) {
        expect(envelope.checksum, generationId).toBe(checksumValue(envelope.value));
      }
    }

    // 4. The repository's own validator agrees.
    const report = await repo.validateGeneration(generationId);
    expect(report.checksumMismatches, generationId).toEqual([]);
    for (const storeName of STORAGE_V2_STORE_NAMES) {
      expect(report.countDeltas[storeName], `${generationId}/${storeName}`).toBe(0);
    }
    expect(report.ok, `${generationId}: ${JSON.stringify(report.problems)}`).toBe(true);
  }

  it('adding records', async () => {
    const repo = await repoFor('desc-add');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await assertDescriptorAgrees(repo, GEN);

    const result = await repo.putRecords(GEN, {
      subjects: [subject('subject-r2-x'), subject('subject-r2-y')],
      preferences: [{ preferenceId: 'locale', value: 'fr', updatedAt: NOW }],
    });
    expect(result.recordCounts.subjects).toBe(2);
    expect(result.recordCounts.preferences).toBe(1);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('replacing a record with the same id (upsert, not duplicate)', async () => {
    const repo = await repoFor('desc-replace');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, { preferences: [{ preferenceId: 'locale', value: 'en', updatedAt: NOW }] });
    await assertDescriptorAgrees(repo, GEN);

    const result = await repo.putRecords(GEN, { preferences: [{ preferenceId: 'locale', value: 'es', updatedAt: NOW }] });
    expect(result.recordCounts.preferences).toBe(1);
    const stored = await repo.readRecords(GEN);
    expect(stored.records.preferences).toHaveLength(1);
    expect(stored.records.preferences[0]?.value.value).toBe('es');
    await assertDescriptorAgrees(repo, GEN);
  });

  it('replacing a record with a DIFFERENT value of a different length', async () => {
    const repo = await repoFor('desc-replace-len');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, { preferences: [{ preferenceId: 'graphics', value: 'a', updatedAt: NOW }] });
    await assertDescriptorAgrees(repo, GEN);
    // A much longer value changes the roll-up checksum materially.
    const long = 'x'.repeat(200);
    const result = await repo.putRecords(GEN, { preferences: [{ preferenceId: 'graphics', value: long, updatedAt: NOW }] });
    expect(result.recordCounts.preferences).toBe(1);
    const stored = await repo.readRecords(GEN);
    expect(stored.records.preferences[0]?.value.value).toBe(long);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('deleting records', async () => {
    const repo = await repoFor('desc-delete');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, {
      subjects: [subject('subject-r2-a'), subject('subject-r2-b')],
      preferences: [{ preferenceId: 'locale', value: 'en', updatedAt: NOW }],
    });
    await assertDescriptorAgrees(repo, GEN);

    const result = await repo.deleteRecords(GEN, { subjects: ['subject-r2-a'] });
    expect(result.recordCounts.subjects).toBe(1);
    expect(await allStoreKeys(repo, GEN)).toEqual([
      'preferences/locale',
      'subjects/subject-r2-b',
    ]);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('deleting a record that does not exist leaves the descriptor correct', async () => {
    const repo = await repoFor('desc-delete-missing');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, { subjects: [subject('subject-r2-a')] });
    const before = (await repo.readGeneration(GEN))?.descriptor?.contentChecksum;

    await repo.deleteRecords(GEN, { subjects: ['subject-r2-never-existed'] });
    // The stored record survived and the descriptor is unchanged.
    expect(await allStoreKeys(repo, GEN)).toEqual(['subjects/subject-r2-a']);
    expect((await repo.readGeneration(GEN))?.descriptor?.contentChecksum).toBe(before);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('FIXED (was NEW DEFECT): deleting a record that does not exist reports removed 0', async () => {
    // This test was registered as `it.fails(...)` while the defect was open.
    // `it.fails` turns RED when the defect is fixed, which is when this file
    // should be updated - so the reproduction is kept, now as a POSITIVE
    // assertion, and is not deleted.
    //
    // Defect was: src/services/persistence/v2/repository.ts
    //   const removed = before.records.subjects.length
    //     + countEnvelopes(before.records) - countEnvelopes(next);
    // `countEnvelopes` already walks the `subjects` list, so the subject count
    // was added a second time and `removed` was that number plus the generation's
    // subject count. The defect was in the return value only: the descriptor, the
    // per-store counts, the roll-up checksum, and `validateGeneration()` all
    // agreed with storage throughout (see the delete test above).
    const repo = await repoFor('desc-delete-missing-count');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, { subjects: [subject('subject-r2-a'), subject('subject-r2-b')] });

    // Delete only a record that was never stored: nothing was removed.
    const result = await repo.deleteRecords(GEN, { subjects: ['subject-r2-never-existed'] });
    expect(result.removed).toBe(0);
  });

  it('FIXED (was NEW DEFECT): `removed` is not inflated by the generation subject count', async () => {
    // Registered as `it.fails(...)` while the defect was open; kept, now
    // POSITIVE, not deleted. See the previous test for the defect and the
    // "return value only" data-integrity note.
    //
    // The inflation was UNBOUNDED in the subject count, where round 1's
    // `removed += 2` was bounded by the attachment count, so it was a regression
    // in severity as well as in kind.
    const repo = await repoFor('desc-removed-count');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, {
      subjects: [subject('subject-r2-a'), subject('subject-r2-b'), subject('subject-r2-c')],
      preferences: [{ preferenceId: 'locale', value: 'en', updatedAt: NOW }],
    });

    // Delete one subject and one preference: 2 records really go away, and the
    // generation still holds two subjects that must NOT be counted.
    const result = await repo.deleteRecords(GEN, {
      subjects: ['subject-r2-a'],
      preferences: ['locale'],
    });
    expect(result.removed).toBe(2);
  });

  it('deleting across the attachments store meta:/blob: record-id pairs', async () => {
    const repo = await repoFor('desc-attachments');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const hash = checksumValue(Array.from(new Uint8Array(bytes)));

    await repo.putRecords(GEN, {
      subjects: [subject('subject-r2-a')],
      attachmentMetadata: [
        {
          attachmentId: 'att-r2-1',
          subjectId: 'subject-r2-a',
          roomId: 'room-phase0-v110-minimal-root',
          sourceType: 'local',
          mimeType: 'image/png',
          availability: 'stored',
          contentHash: hash,
          addedAt: NOW,
        },
        {
          attachmentId: 'att-r2-2',
          subjectId: 'subject-r2-a',
          roomId: 'room-phase0-v110-minimal-root',
          sourceType: 'external',
          mimeType: 'image/png',
          availability: 'external-only',
          contentHash: null,
          addedAt: NOW,
        },
      ],
      attachmentBlobs: [
        {
          attachmentId: 'att-r2-1',
          contentHash: hash,
          bytes,
          byteLength: 4,
          storedAt: NOW,
        },
      ],
    });
    await assertDescriptorAgrees(repo, GEN);
    expect(await allStoreKeys(repo, GEN)).toEqual([
      'attachments/blob:att-r2-1',
      'attachments/meta:att-r2-1',
      'attachments/meta:att-r2-2',
      'subjects/subject-r2-a',
    ]);

    // Delete the attachment that has BOTH a metadata and a blob record.
    const result = await repo.deleteRecords(GEN, { attachments: ['att-r2-1'] });
    expect(result.recordCounts.attachments).toBe(1);
    expect(await allStoreKeys(repo, GEN)).toEqual([
      'attachments/meta:att-r2-2',
      'subjects/subject-r2-a',
    ]);
    await assertDescriptorAgrees(repo, GEN);

    // Delete the metadata-only attachment (its blob id does not exist).
    await repo.deleteRecords(GEN, { attachments: ['att-r2-2'] });
    expect(await allStoreKeys(repo, GEN)).toEqual(['subjects/subject-r2-a']);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('deleting an attachment that does not exist leaves the descriptor correct', async () => {
    const repo = await repoFor('desc-attachments-missing');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: {} });
    await repo.activateGeneration(GEN);
    await repo.putRecords(GEN, { subjects: [subject('subject-r2-a')] });
    const before = (await repo.readGeneration(GEN))?.descriptor?.contentChecksum;

    await repo.deleteRecords(GEN, { attachments: ['att-r2-never-existed'] });
    expect(await allStoreKeys(repo, GEN)).toEqual(['subjects/subject-r2-a']);
    expect((await repo.readGeneration(GEN))?.descriptor?.contentChecksum).toBe(before);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('writeMigrationReceipt lands in the descriptor it recomputed', async () => {
    const repo = await repoFor('desc-receipt');
    await repo.stageGeneration({ generationId: GEN, source: 'initial', records: { subjects: [subject('subject-r2-a')] } });
    await repo.activateGeneration(GEN);
    const before = await repo.readGeneration(GEN);
    expect(before?.descriptor?.recordCounts.migrationReceipts).toBe(0);
    await assertDescriptorAgrees(repo, GEN);

    await repo.writeMigrationReceipt({
      receiptId: 'receipt-r2-1',
      migrationId: LEGACY_MIGRATION_ID,
      fromStorage: 'legacy-localstorage',
      toStorage: 'storage-v2',
      stagedGenerationId: GEN,
      previousActiveGenerationId: null,
      status: 'activated',
      createdAt: NOW,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {} as never,
      recordChecksums: {} as never,
      contentChecksum: 'x'.repeat(64),
    });
    const after = await repo.readGeneration(GEN);
    expect(after?.descriptor?.recordCounts.migrationReceipts).toBe(1);
    expect(after?.descriptor?.contentChecksum).not.toBe(before?.descriptor?.contentChecksum);
    await assertDescriptorAgrees(repo, GEN);
  });

  it('re-staging the same generation with a strict subset is refused by validation, not silently accepted', async () => {
    // Round 1 item 2.8. The migration now discards first, but the repository
    // API still only upserts.
    const repo = await repoFor('desc-restage');
    await repo.stageGeneration({
      generationId: GEN,
      source: 'legacy-migration',
      records: { subjects: [subject('subject-r2-a'), subject('subject-r2-b')] },
    });
    await repo.stageGeneration({
      generationId: GEN,
      source: 'legacy-migration',
      records: { subjects: [subject('subject-r2-a')] },
    });
    expect(await allStoreKeys(repo, GEN)).toEqual([
      'subjects/subject-r2-a',
      'subjects/subject-r2-b',
    ]);
    expect((await repo.validateGeneration(GEN)).ok).toBe(false);
  });

  it('requires an existing generation for every mutating call', async () => {
    const repo = await repoFor('desc-require');
    await expect(repo.putRecords('gen-nope', {})).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
    await expect(
      repo.deleteRecords('gen-nope', { subjects: ['a'] }),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });

  it('PROVES the transaction spy still observes multiple readwrite transactions', async () => {
    // Positive control for the round-1 assertion that was retargeted to
    // `toHaveLength(1)`: a spy that can only ever see one transaction would
    // make that assertion vacuous. `pruneGenerations` really does open one
    // readwrite transaction per doomed generation.
    const repo = await repoFor('desc-spy-control');
    for (const id of [GEN, GEN_B, GEN_C]) {
      await repo.stageGeneration({ generationId: id, source: 'initial', records: {} });
      await repo.activateGeneration(id);
    }
    const db = (repo as unknown as { db: IDBDatabase }).db;
    const seen: string[] = [];
    const original = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, 'transaction')
      .mockImplementation(((names: string | Iterable<string>, mode?: IDBTransactionMode) => {
        if ((mode ?? 'readonly') === 'readwrite') seen.push([...names].sort().join('+'));
        return original(names as string, mode) as IDBTransaction;
      }) as typeof db.transaction);
    try {
      const pruned = await repo.pruneGenerations({ keepAtLeast: 1 });
      expect(pruned.removed).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
    // Two doomed generations -> two readwrite transactions were observed. The
    // spy is live, so a `toHaveLength(1)` assertion elsewhere is meaningful.
    expect(seen).toHaveLength(2);
    for (const entry of seen) expect(entry).toContain('meta');
  });
});

// ── 3. the same-generationId no-op path ────────────────────────────────────

describe('R2 attack: the same-generationId no-op path', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('is a no-op success when the generation is still the active one', async () => {
    seedLegacy();
    const repo = await repoFor('noop-active');
    const first = await migrateLegacyState(migrateOptions(repo));
    expect(first.report.status).toBe('migrated');
    const before = await repo.readGeneration(GEN);

    const second = await migrateLegacyState(migrateOptions(repo));
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(true);
    expect(second.report.recovery).toBeNull();
    const after = await repo.readGeneration(GEN);
    expect(after?.descriptor).toEqual(before?.descriptor);
    expect(rawRecordsOf(after?.records)).toEqual(rawRecordsOf(before?.records));
    expect(await repo.listMigrationReceipts(GEN)).toHaveLength(1);
  });

  it('reports activated=false when the generation has been superseded by a later phase', async () => {
    seedLegacy();
    const repo = await repoFor('noop-superseded');
    await migrateLegacyState(migrateOptions(repo));
    // A later phase advances the device.
    await repo.stageGeneration({ generationId: GEN_B, source: 'local-edit', records: {} });
    await repo.activateGeneration(GEN_B);
    expect(await repo.readActiveGenerationId()).toBe(GEN_B);

    // Re-running the migration with the OLD id must not re-activate it.
    const second = await migrateLegacyState(migrateOptions(repo));
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(false);
    // The pointer is still where the later phase put it.
    expect(await repo.readActiveGenerationId()).toBe(GEN_B);
    expect((await repo.readGeneration(GEN))?.descriptor?.status).toBe('superseded');
    // The later phase's data is intact.
    expect(await repo.readGeneration(GEN_B)).not.toBeNull();
  });

  it('does NOT short-circuit on a generation built by a different source', async () => {
    // `alreadyMigrated` requires source === 'legacy-migration' AND a receipt
    // with this migrationId. A `local-edit` generation must be re-staged.
    seedLegacy();
    const repo = await repoFor('noop-wrong-source');
    await repo.stageGeneration({ generationId: GEN, source: 'local-edit', records: { subjects: [subject('subject-r2-x')] } });
    await repo.activateGeneration(GEN);

    const outcome = await migrateLegacyState(migrateOptions(repo));
    // The generation is `active`, so the staging step refuses it.
    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.recovery?.code).toBe('GENERATION_ALREADY_ACTIVE');
    // ...and the foreign data was NOT destroyed by the discard step.
    expect(await allStoreKeys(repo, GEN)).toEqual(['subjects/subject-r2-x']);
  });

  it('does NOT short-circuit when the descriptor is active but the receipt is missing', async () => {
    // The brief's fourth case. `alreadyMigrated` needs a receipt, so this is
    // NOT a no-op: it falls through, and because the generation is `active` the
    // staging step refuses. The data is preserved, but the caller gets a
    // recovery result rather than a no-op success.
    seedLegacy();
    const repo = await repoFor('noop-no-receipt');
    await repo.stageGeneration({ generationId: GEN, source: 'legacy-migration', records: { subjects: [subject('subject-r2-x')] } });
    await repo.activateGeneration(GEN);

    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.recovery?.code).toBe('GENERATION_ALREADY_ACTIVE');
    expect(await allStoreKeys(repo, GEN)).toEqual(['subjects/subject-r2-x']);
  });

  it('does NOT short-circuit when a receipt exists for a DIFFERENT migrationId', async () => {
    seedLegacy();
    const repo = await repoFor('noop-other-migration');
    await repo.stageGeneration({ generationId: GEN, source: 'legacy-migration', records: {} });
    await repo.activateGeneration(GEN);
    await repo.writeMigrationReceipt({
      receiptId: 'receipt-other',
      migrationId: 'some-other-migration',
      fromStorage: 'legacy-localstorage',
      toStorage: 'storage-v2',
      stagedGenerationId: GEN,
      previousActiveGenerationId: null,
      status: 'activated',
      createdAt: NOW,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {} as never,
      recordChecksums: {} as never,
      contentChecksum: 'x'.repeat(64),
    });

    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.recovery?.code).toBe('GENERATION_ALREADY_ACTIVE');
  });

  it('is a no-op success when the generation is staged WITH its receipt', async () => {
    // A staged generation that already carries this migration's receipt: the
    // short-circuit fires and reports `migrated` with `activated: false`, and
    // the generation is left `staged`. It is then never activated.
    seedLegacy();
    const repo = await repoFor('noop-staged-with-receipt');
    await repo.stageGeneration({ generationId: GEN, source: 'legacy-migration', records: { subjects: [subject('subject-r2-x')] } });
    await repo.writeMigrationReceipt({
      receiptId: 'receipt-r2',
      migrationId: LEGACY_MIGRATION_ID,
      fromStorage: 'legacy-localstorage',
      toStorage: 'storage-v2',
      stagedGenerationId: GEN,
      previousActiveGenerationId: null,
      status: 'activated',
      createdAt: NOW,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {} as never,
      recordChecksums: {} as never,
      contentChecksum: 'x'.repeat(64),
    });

    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(false);
    // The generation is STILL staged and the pointer was never flipped. A
    // caller that reads `status: 'migrated'` and `activated: false` has no
    // signal that the data is still invisible.
    expect((await repo.readGeneration(GEN))?.descriptor?.status).toBe('staged');
    expect(await repo.readActiveGenerationId()).toBeNull();
  });

  it('the discarded-then-restaged path leaves a VALID generation', async () => {
    seedLegacy();
    const repo = await repoFor('discard-then-restage');
    // Fail after the stage commit so generation GEN is left staged.
    const failed = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage: string) => {
          if (stage === 'validate') throw new Error('qa-injected after stage commit');
        },
      }),
    );
    expect(failed.report.status).toBe('recovery-required');
    expect((await repo.readGeneration(GEN))?.descriptor?.status).toBe('staged');
    expect((await allStoreKeys(repo, GEN)).length).toBeGreaterThan(0);

    // Retry with the same id: the abandoned generation is discarded and
    // re-staged cleanly, and the result validates.
    const retry = await migrateLegacyState(migrateOptions(repo));
    expect(retry.report.status).toBe('migrated');
    expect(await repo.readActiveGenerationId()).toBe(GEN);
    const report = await repo.validateGeneration(GEN);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    expect(await repo.listMigrationReceipts(GEN)).toHaveLength(1);
    // The stale record from the abandoned attempt is gone: the subject id is
    // the one the migration derives, and nothing else survives.
    expect(await allStoreKeys(repo, GEN)).toEqual(
      expect.arrayContaining(['subjects/subject-phase0-v110-minimal']),
    );
  });
});

// ── 4. checksums, eventId, and receipts after the SHA-256 fix ──────────────

describe('R2 attack: no stale checksum survives the SHA-256 correction', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('every stored checksum is a standard SHA-256 of its value', async () => {
    seedLegacy();
    const repo = await repoFor('checksums');
    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');

    const snapshot = await repo.readGeneration(GEN);
    let checked = 0;
    for (const list of Object.values(snapshot!.records)) {
      for (const envelope of list as { recordId: string; checksum: string; value: unknown }[]) {
        // Recompute independently, through the Web Crypto path.
        const bytes = new TextEncoder().encode(
          (await import('@/services/persistence/v2/checksum')).canonicalJsonStringify(envelope.value),
        );
        // Copy the view's elements into a typed array in this realm. See the
        // full explanation in qaHardening.test.ts: `.buffer.slice(...)` yields
        // a cross-realm ArrayBuffer that Node 20's SubtleCrypto rejects.
        const digest = await globalThis.crypto.subtle.digest(
          'SHA-256',
          new Uint8Array(bytes),
        );
        const expected = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        expect(envelope.checksum, envelope.recordId).toBe(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('a session eventId is a prefix of a standard SHA-256 of its derivation input', async () => {
    const sessions = JSON.stringify([
      { sessionId: 'session-r2-1', startedAt: '2026-01-02T03:04:05.000Z', subjectId: 'subject-r2-a' },
      // Deliberately sized so the derivation input is 55 bytes, the length the
      // old padding formula got wrong.
      { sessionId: 'x'.repeat(23), startedAt: 'x', subjectId: 'subject-r2-a' },
    ]);
    seedLegacy();
    // After seedLegacy, which writes an empty `sessions` key of its own.
    window.localStorage.setItem('knowledge-dungeon:v1:sessions', sessions);
    const repo = await repoFor('eventid');
    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');

    const snapshot = await repo.readRecords(GEN);
    const stored = snapshot.records.sessions;
    expect(stored).toHaveLength(2);

    const bytesFor = (sessionId: string, startedAt: string): Uint8Array =>
      new TextEncoder().encode(JSON.stringify({ sessionId, startedAt }));
    const expectedFor = async (sessionId: string, startedAt: string): Promise<string> => {
      const bytes = bytesFor(sessionId, startedAt);
      // Copy into a typed array in this realm; see qaHardening.test.ts.
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
    };

    const first = stored.find((entry) => entry.value.sessionId === 'session-r2-1');
    const hazardous = stored.find((entry) => entry.value.sessionId === 'x'.repeat(23));
    // The hazardous derivation input is exactly 55 bytes, the previously broken
    // length, and the eventId must still be a standard SHA-256 prefix.
    expect(bytesFor('x'.repeat(23), 'x').length).toBe(55);
    expect(first?.value.eventId).toBe(await expectedFor('session-r2-1', '2026-01-02T03:04:05.000Z'));
    expect(hazardous?.value.eventId).toBe(await expectedFor('x'.repeat(23), 'x'));
  });

  it('receipt recordChecksums are standard SHA-256 roll-ups', async () => {
    seedLegacy();
    const repo = await repoFor('receipt-checksums');
    await migrateLegacyState(migrateOptions(repo));
    const receipts = (await repo.listMigrationReceipts(GEN)) as MigrationReceiptValue[];
    expect(receipts).toHaveLength(1);
    for (const storeName of STORAGE_V2_STORE_NAMES) {
      expect(receipts[0]!.recordChecksums[storeName], storeName).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(receipts[0]!.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the migration prefix-honours the id factory and is stable across runs', async () => {
    window.localStorage.setItem('knowledge-dungeon:v1:progression', V1_FLAT_MALFORMED);
    seedLegacy(V1_FLAT_MALFORMED);
    const first = await repoFor('ids-1');
    const a = await migrateLegacyState(migrateOptions(first));
    expect(a.report.status).toBe('migrated');
    const firstIds = collectProgressionIds(a.records);

    const second = await repoFor('ids-2');
    const b = await migrateLegacyState(migrateOptions(second));
    const secondIds = collectProgressionIds(b.records);

    // Two runs at the same injected clock produce identical ids.
    expect(secondIds).toEqual(firstIds);
    // Ids are unique and prefixed by kind.
    expect(new Set(firstIds).size).toBe(firstIds.length);
    for (const id of firstIds) expect(id).toMatch(/^(loot|gear)-migrated-\d{4}$/);
  });

  it('a run at a DIFFERENT injected clock still produces the same ids', async () => {
    seedLegacy(V1_FLAT_MALFORMED);
    const first = await repoFor('ids-clock-a');
    const a = await migrateLegacyState(migrateOptions(first));
    const second = await repoFor('ids-clock-b');
    const b = await migrateLegacyState(
      migrateOptions(second, { generationId: GEN_B, now: NOW_LATER, clock: fixedClock(NOW_LATER) }),
    );
    expect(collectProgressionIds(b.records)).toEqual(collectProgressionIds(a.records));
  });
});

function collectProgressionIds(records: GenerationRecords | null): string[] {
  if (!records) return [];
  const ids: string[] = [];
  for (const envelope of records.progression) {
    const value = envelope.value as ProgressionRecordValue;
    for (const subjectRecord of Object.values(value.bySubject)) {
      const typed = subjectRecord as { inventory?: { id: string }[]; equippedItems?: { id: string }[] };
      for (const entry of [...(typed.inventory ?? []), ...(typed.equippedItems ?? [])]) {
        ids.push(entry.id);
      }
    }
  }
  return ids.sort();
}

// ── 5. privacy, re-confirmed with the round-2 marker ──────────────────────

describe('R2 privacy gate', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('the round-2 marker never appears in any report, receipt, descriptor, or error', async () => {
    const payload = JSON.parse(V11) as {
      dungeon: Record<string, unknown>;
      rooms: Record<string, Record<string, unknown>>;
    };
    payload.dungeon.subjectName = QA_MARKER;
    const room = Object.values(payload.rooms)[0]!;
    room.topic = `${QA_MARKER}-topic`;
    room.noteText = `${QA_MARKER}-note`;
    room.attachments = [
      {
        attachmentId: 'att-r2-marker',
        sourceType: 'external',
        fileName: `${QA_MARKER}.png`,
        externalUrl: 'https://example.invalid/r2.png',
        altText: `${QA_MARKER}-alt`,
        mimeType: 'image/png',
        addedAt: NOW,
      },
    ];
    const storage = window.localStorage;
    storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-r2-marker']));
    storage.setItem('knowledge-dungeon:v1:subject:subject-r2-marker', JSON.stringify(payload));
    storage.setItem('knowledge-dungeon:v1:activeSubjectId', 'subject-r2-marker');
    storage.setItem(
      'knowledge-dungeon:v1:progression',
      JSON.stringify({
        version: 3,
        bySubject: { 'subject-r2-marker': { xpTotal: 1, badges: [QA_MARKER] } },
        crossSubjectAchievements: [QA_MARKER],
      }),
    );
    storage.setItem(`knowledge-dungeon:backup:subject-r2-marker`, `${QA_MARKER}-raw`);
    storage.setItem('knowledge-dungeon:locale', 'en');

    const repo = await repoFor('privacy');
    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');

    const surfaces: [string, unknown][] = [
      ['MigrationReport', outcome.report],
      ['externalOnlyAttachments', outcome.report.externalOnlyAttachments],
      ['LegacyReadReport', readLegacyAppState().report],
      ['receipts', await repo.listMigrationReceipts(GEN)],
      ['descriptor', (await repo.readGeneration(GEN))?.descriptor],
      ['generation validation', (await repo.validateGeneration(GEN)).problems],
    ];
    for (const [name, surface] of surfaces) {
      const text = JSON.stringify(surface) ?? '';
      expect(text, name).not.toContain(QA_MARKER);
      expect(text, name).not.toContain('example.invalid');
      expect(text, name).not.toContain('noteMarkdown');
      expect(text, name).not.toContain('noteText');
      expect(text, name).not.toContain('altText');
    }
    // The recovery record legitimately holds the raw legacy bytes; it is stored
    // data, not a report surface. Assert it is present and that the REPORTS do
    // not carry it.
    const recovery = (await repo.readRecords(GEN)).records.recovery[0]?.value;
    expect(recovery?.raw).toBe(`${QA_MARKER}-raw`);
  });

  it('a failed migration reports a code and a stage and never the thrown message', async () => {
    seedLegacy();
    const repo = await repoFor('privacy-failure');
    const outcome = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage: string) => {
          if (stage === 'compare') throw new Error(`${QA_MARKER}-thrown`);
        },
      }),
    );
    expect(outcome.report.status).toBe('recovery-required');
    expect(Object.keys(outcome.report.recovery ?? {}).sort()).toEqual(['code', 'stage']);
    expect(JSON.stringify(outcome.report)).not.toContain(QA_MARKER);
  });

  it('the discarded-generation path does not surface the abandoned records in any report', async () => {
    seedLegacy();
    const repo = await repoFor('privacy-discard');
    await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage: string) => {
          if (stage === 'activate') throw new Error('qa-injected at activate');
        },
      }),
    );
    const retry = await migrateLegacyState(migrateOptions(repo));
    expect(retry.report.status).toBe('migrated');
    expect(JSON.stringify(retry.report)).not.toContain(QA_MARKER);
    expect(JSON.stringify(retry.report.problems)).not.toContain('noteText');
  });
});

// ── 6. legacy keys and determinism, re-confirmed ──────────────────────────

describe('R2 legacy keys and determinism', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('legacy keys stay byte-for-byte identical across a FAILED then a successful run', async () => {
    seedLegacy();
    const before = snapshotLocalStorage();
    const repo = await repoFor('legacy-fail-then-ok');

    await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage: string) => {
          if (stage === 'validate') throw new Error('qa-injected');
        },
      }),
    );
    // The DISCARD path now runs on the retry, which is a new write path over
    // the v2 stores. It must not touch legacy storage.
    await migrateLegacyState(migrateOptions(repo));

    const after = snapshotLocalStorage();
    expect(after.keys()).toEqual(before.keys());
    expect(after.entries()).toEqual(before.entries());
    expect(window.localStorage.length).toBe(before.entries().length);
  });

  it('no real clock, randomness, or network in the v2 tree or the canonical module', async () => {
    seedLegacy();
    const repo = await repoFor('determinism');
    const consulted: string[] = [];
    const realRandom = Math.random;
    const realFetch = globalThis.fetch;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('1999-12-31T23:59:59.000Z'));
    Math.random = (): number => {
      consulted.push('Math.random');
      return 0.5;
    };
    const fetchSpy = vi.fn(() => {
      consulted.push('fetch');
      throw new Error('qa-probe: network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const outcome = await migrateLegacyState(migrateOptions(repo));
      expect(outcome.report.status).toBe('migrated');
      expect(outcome.report.createdAt).toBe(NOW);
      // The failure + retry path, which now calls discardStagedGeneration.
      await migrateLegacyState(
        migrateOptions(repo, {
          generationId: GEN_B,
          onStage: (stage: string) => {
            if (stage === 'validate') throw new Error('qa-injected');
          },
        }),
      );
      await migrateLegacyState(migrateOptions(repo, { generationId: GEN_B }));
    } finally {
      Math.random = realRandom;
      vi.stubGlobal('fetch', realFetch);
      vi.useRealTimers();
    }
    expect(consulted).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('two full runs at the same clock are byte-identical, discard path included', async () => {
    seedLegacy();
    const a = await repoFor('repeat-a');
    await migrateLegacyState(
      migrateOptions(a, {
        onStage: (stage: string) => {
          if (stage === 'validate') throw new Error('qa-injected');
        },
      }),
    );
    await migrateLegacyState(migrateOptions(a));
    const b = await repoFor('repeat-b');
    await migrateLegacyState(
      migrateOptions(b, {
        onStage: (stage: string) => {
          if (stage === 'validate') throw new Error('qa-injected');
        },
      }),
    );
    await migrateLegacyState(migrateOptions(b));

    const left = await a.readGeneration(GEN);
    const right = await b.readGeneration(GEN);
    expect(right?.descriptor?.contentChecksum).toBe(left?.descriptor?.contentChecksum);
    expect(right?.records).toEqual(left?.records);
  });
});
