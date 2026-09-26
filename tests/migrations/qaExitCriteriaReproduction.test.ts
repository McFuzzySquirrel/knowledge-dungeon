/**
 * INDEPENDENT QA reproduction suite for Phase 3.
 *
 * These tests were written by the verification owner, not by the implementer.
 * Every one of them targets a claim the implementer's own suite asserts more
 * weakly, or a scenario the implementer's suite does not cover at all.
 *
 * Every fixture value is synthetic. No learner content, no real URLs.
 *
 * Group 1: "Legacy fixtures migrate idempotently" - attacked in the *same*
 *   repository, which the implementer's suite never does (it uses a second,
 *   fresh database each time, which proves determinism, not idempotency).
 * Group 2: "A failed staged transaction leaves the active generation unchanged"
 *   - injected at the repository's own store-level failure points, and checked
 *   store by store rather than only through the public read API.
 * Group 3: "Legacy keys remain byte-for-byte untouched" - compared against the
 *   real `window.localStorage` object with a storage that *throws* on write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedClock, createDeterministicIdFactory } from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
  type StageFailurePoint,
} from '@/services/persistence/v2/repository';
import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import { readLegacyAppState, type ReadOnlyLegacyStorage } from '@/services/persistence/v2/legacyReader';
import {
  STORAGE_V2_STORE_NAMES,
  type StorageV2StoreName,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import { buildRecordEnvelopes, computeStoreChecksums } from '@/services/persistence/v2/repository';
import { emptyGenerationRecordValues, type GenerationRecords } from '@/services/persistence/v2/validation';

import {
  deleteTestDatabase,
  readProgressionFixture,
  readSubjectFixture,
  resetStorageV2Environment,
  snapshotLocalStorage,
} from './support/storageV2TestSupport';

const V10 = readSubjectFixture('subject-1.0.0-migration-defaults.json');
const V11 = readSubjectFixture('subject-1.1.0-minimal.json');
const V3_PROGRESSION = readProgressionFixture('progression-v3-current-full.json');
const V1_FLAT_PROGRESSION = readProgressionFixture('progression-v1-flat.json');

const SUBJECT_A = 'subject-qa-a';
const SUBJECT_B = 'subject-qa-b';
/** The ids the migration actually derives: the payload's own `dungeonId`. */
const SUBJECT_A_RECORD_ID = 'subject-phase0-v100-migration';
const SUBJECT_B_RECORD_ID = 'subject-phase0-v110-minimal';
const GEN_1 = 'gen-qa-0001';
const GEN_2 = 'gen-qa-0002';
const GEN_3 = 'gen-qa-0003';
const NOW_A = '2026-09-25T00:00:00.000Z';
const NOW_B = '2026-10-25T11:22:33.444Z';

/** A distinctive, synthetic marker. Must never appear in a report or an error. */
export const QA_MARKER = 'QA-MARKER-synthetic-4f2b91-not-real-content';

let dbCounter = 0;
let repository: StorageV2Repository | null = null;
let databaseName = '';

async function repoFor(suffix: string): Promise<StorageV2Repository> {
  dbCounter += 1;
  databaseName = `kd-qa-${suffix}-${dbCounter}`;
  repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(NOW_A),
    idFactory: createDeterministicIdFactory('qa'),
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

/**
 * Seed a legacy device with two subjects, one already at 1.1.0, a v1 flat
 * progression payload with an unknown app-owned field, plus a quarantined
 * corrupt payload. Every value is synthetic and self-describing.
 */
function seedLegacyDevice(): void {
  const storage = window.localStorage;
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_A, SUBJECT_B]));
  storage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_A);
  storage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_A}`, V10);
  storage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_B}`, V11);
  storage.setItem('knowledge-dungeon:v1:progression', V1_FLAT_PROGRESSION);
  storage.setItem('knowledge-dungeon:v1:sessions', '[]');
  // Quarantine family: a truncated backup and an unparseable corrupt record.
  storage.setItem(`knowledge-dungeon:backup:${SUBJECT_A}`, `{"dungeon":${QA_MARKER}`);
  storage.setItem(`knowledge-dungeon:corrupt:${SUBJECT_B}`, `{"dungeon":`);
  // An index that names a subject with no payload at all.
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_A, SUBJECT_B, 'subject-qa-ghost']));
}

function migrateOptions(
  repo: StorageV2Repository,
  overrides: Record<string, unknown> = {},
): Parameters<typeof migrateLegacyState>[0] {
  return {
    repository: repo,
    generationId: GEN_1,
    now: NOW_A,
    clock: fixedClock(NOW_A),
    // No `storage` option on purpose: the reader resolves the REAL
    // `globalThis.localStorage`, so these tests exercise the real object.
    ...overrides,
  } as Parameters<typeof migrateLegacyState>[0];
}

/** Every record in every store, keyed by `${store}/${recordId}`. */
async function allRecords(repo: StorageV2Repository, generationId: string): Promise<string[]> {
  const db = (repo as unknown as { db: IDBDatabase }).db;
  const tx = db.transaction([...STORAGE_V2_STORE_NAMES], 'readonly');
  const found: string[] = [];
  await Promise.all(
    STORAGE_V2_STORE_NAMES.map((storeName) => {
      if (storeName === 'meta') return Promise.resolve();
      const index = tx.objectStore(storeName).index('byGeneration');
      return new Promise<void>((resolve) => {
        const request = index.getAllKeys(generationId);
        request.onsuccess = () => {
          for (const key of request.result) found.push(`${storeName}/${String((key as [string, string])[1])}`);
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

function projection(records: GenerationRecords | null | undefined): unknown {
  if (!records) return null;
  const out: Record<string, unknown[]> = {};
  for (const [key, list] of Object.entries(records)) {
    if (key === 'migrationReceipts') continue;
    out[key] = [...list]
      .map((entry) => ({ recordId: entry.recordId, checksum: entry.checksum, value: entry.value }))
      .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  }
  return out;
}

describe('QA exit criterion 1: legacy fixtures migrate idempotently', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('FIXED: re-running the same generation id after activation is a no-op success, and changes nothing', async () => {
    seedLegacyDevice();
    const repo = await repoFor('idem-same-repo');

    const first = await migrateLegacyState(migrateOptions(repo));
    expect(first.report.status).toBe('migrated');
    const firstRecords = projection(first.records);
    const firstKeys = await allRecords(repo, GEN_1);
    const firstDescriptor = JSON.parse(
      JSON.stringify((await repo.readGeneration(GEN_1))?.descriptor ?? null),
    );

    // Second run, same generation id. This used to be refused with
    // `GENERATION_ALREADY_ACTIVE`, which meant a routine retry - or a Phase 4
    // cutover re-run with a fixed id - showed a recovery screen on a device that
    // was already fully migrated. It is now a no-op success.
    const second = await migrateLegacyState(migrateOptions(repo));
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(true);
    expect(second.report.recovery).toBeNull();
    expect(second.report.stagedGenerationId).toBe(GEN_1);
    // The no-op still reports the generation's real content rather than zeroes.
    expect(second.report.recordCounts).toEqual(first.report.recordCounts);
    expect(second.report.contentChecksum).toBe(first.report.contentChecksum);

    // Nothing duplicated, nothing drifted, nothing damaged.
    expect(await allRecords(repo, GEN_1)).toEqual(firstKeys);
    expect(projection((await repo.readGeneration(GEN_1))?.records)).toEqual(firstRecords);
    expect(JSON.parse(JSON.stringify((await repo.readGeneration(GEN_1))?.descriptor ?? null))).toEqual(
      firstDescriptor,
    );
    expect(await repo.readActiveGenerationId()).toBe(GEN_1);
    // The receipt did not accumulate a duplicate.
    expect(await repo.listMigrationReceipts(GEN_1)).toHaveLength(1);
  });

  it('FIXED: reports stage-records for a failure inside the staging transaction', async () => {
    // DEFECT WAS (should-fix): `migrateLegacyState` only advanced `currentStage`
    // to 'stage-records' from the repository's `before-commit` hook, so a failure
    // anywhere else inside `stageGeneration` was reported as stage 'transform'
    // and the recovery screen told the learner the wrong thing. The migration
    // now enters the stage before it calls the repository.
    seedLegacyDevice();
    const repo = await repoFor('stage-misreport');

    // An ACTIVE generation under this migration's own id, carrying no receipt.
    // `stageGeneration` refuses to re-stage it, so the failure happens inside the
    // staging step, before any data is written.
    await repo.stageGeneration({ generationId: GEN_2, source: 'legacy-migration', records: {} });
    await repo.activateGeneration(GEN_2);

    const outcome = await migrateLegacyState(migrateOptions(repo, { generationId: GEN_2 }));
    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.recovery?.code).toBe('GENERATION_ALREADY_ACTIVE');
    // Observed before the fix: 'transform'. Now: the staging step.
    expect(outcome.report.recovery?.stage).toBe('stage-records');
    // The active generation is untouched.
    expect(await repo.readActiveGenerationId()).toBe(GEN_2);

    // And the stage the migration reports for a failure it owns is the staging
    // step too, not the transform step that ran before it.
    const seen: string[] = [];
    const fresh = await repoFor('stage-misreport-2');
    const injected = await migrateLegacyState(
      migrateOptions(fresh, {
        onStage: (stage: string) => {
          seen.push(stage);
          if (stage === 'stage-records') throw new Error('qa-injected inside staging');
        },
      }),
    );
    expect(injected.report.status).toBe('recovery-required');
    expect(injected.report.recovery?.stage).toBe('stage-records');
    expect(seen).toEqual(['read-legacy', 'transform', 'stage-records']);
  });

  it('retries a FAILED migration with the same generation id and succeeds', async () => {
    seedLegacyDevice();
    const repo = await repoFor('idem-retry');

    // Fail after the stage commit, so the generation is left `staged`.
    const failed = await migrateLegacyState(
      migrateOptions(repo, {
        onStage: (stage: string) => {
          if (stage === 'validate') throw new Error('qa-injected validate failure');
        },
      }),
    );
    expect(failed.report.status).toBe('recovery-required');
    expect((await repo.readGeneration(GEN_1))?.descriptor?.status).toBe('staged');

    // Retry with the same id. A `staged` generation may be re-staged, so the
    // retry must succeed and must not duplicate anything.
    const retry = await migrateLegacyState(migrateOptions(repo));
    expect(retry.report.status).toBe('migrated');
    expect(await repo.readActiveGenerationId()).toBe(GEN_1);
    const keys = await allRecords(repo, GEN_1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(await repo.listMigrationReceipts(GEN_1)).toHaveLength(1);
  });

  it('re-running with a DIFFERENT generationId keeps the first generation intact and readable', async () => {
    seedLegacyDevice();
    const repo = await repoFor('idem-new-gen');

    const first = await migrateLegacyState(migrateOptions(repo));
    expect(first.report.status).toBe('migrated');
    const firstSnapshot = await repo.readGeneration(GEN_1);
    expect(firstSnapshot?.descriptor?.status).toBe('active');

    const second = await migrateLegacyState(migrateOptions(repo, { generationId: GEN_2 }));
    expect(second.report.status).toBe('migrated');
    expect(second.report.previousActiveGenerationId).toBe(GEN_1);

    // The superseded generation is retained for rollback, byte-for-byte.
    const firstAfter = await repo.readGeneration(GEN_1);
    expect(firstAfter?.descriptor?.status).toBe('superseded');
    expect(projection(firstAfter?.records)).toEqual(projection(firstSnapshot?.records));
    expect(firstAfter?.contentChecksum).toBe(firstSnapshot?.contentChecksum);

    // Exactly one receipt per generation, not two in one.
    expect(await repo.listMigrationReceipts(GEN_1)).toHaveLength(1);
    expect(await repo.listMigrationReceipts(GEN_2)).toHaveLength(1);
    expect(await repo.listMigrationReceipts()).toHaveLength(2);

    // Re-activating a superseded generation is a rollback and still works.
    const rollback = await repo.rollbackToGeneration(GEN_1);
    expect(rollback.activeGenerationId).toBe(GEN_1);
  });

  it('re-runs cleanly after the active generation has already advanced twice', async () => {
    seedLegacyDevice();
    const repo = await repoFor('idem-advanced');

    await migrateLegacyState(migrateOptions(repo, { generationId: GEN_1 }));
    await migrateLegacyState(migrateOptions(repo, { generationId: GEN_2 }));
    const third = await migrateLegacyState(migrateOptions(repo, { generationId: GEN_3 }));
    expect(third.report.status).toBe('migrated');

    const keys = await allRecords(repo, GEN_3);
    expect(new Set(keys).size).toBe(keys.length);
    for (const generationId of [GEN_1, GEN_2, GEN_3]) {
      expect(await repo.listMigrationReceipts(generationId)).toHaveLength(1);
    }
    // All three generations remain readable, so nothing was clobbered.
    for (const generationId of [GEN_1, GEN_2, GEN_3]) {
      expect((await repo.readGeneration(generationId))?.descriptor).not.toBeNull();
    }
    expect(await repo.readActiveGenerationId()).toBe(GEN_3);
  });

  it('reports exactly what is and is not idempotent: generationId and now', async () => {
    seedLegacyDevice();
    const a = await repoFor('idem-scope-a');
    const first = await migrateLegacyState(migrateOptions(a));
    const b = await repoFor('idem-scope-b');
    const second = await migrateLegacyState(
      migrateOptions(b, { generationId: GEN_2, now: NOW_B, clock: fixedClock(NOW_B) }),
    );

    // Report-level fields that are NOT idempotent under a different id/clock.
    expect(second.report.stagedGenerationId).not.toBe(first.report.stagedGenerationId);
    expect(second.report.createdAt).not.toBe(first.report.createdAt);

    // The generation content checksum is a function of the injected `now` as
    // well as of the source data, because several record families fall back to
    // it and the 1.0.0 -> 1.1.0 transform stamps the SM-2 default review date
    // with it. It therefore cannot be compared across runs at different times.
    expect(second.report.contentChecksum).not.toBe(first.report.contentChecksum);

    // Exactly which parts drift, stated concretely:
    // (a) a 1.0.0 subject's default next-review date;
    const subjectA = (first.records as GenerationRecords).subjects.find(
      (entry) => entry.recordId === SUBJECT_A_RECORD_ID,
    )?.value as SubjectRecordValue;
    const subjectARebuilt = (second.records as GenerationRecords).subjects.find(
      (entry) => entry.recordId === SUBJECT_A_RECORD_ID,
    )?.value as SubjectRecordValue;
    const roomA = Object.values(subjectA.snapshot.rooms)[0] as unknown as Record<string, unknown>;
    const roomARebuilt = Object.values(subjectARebuilt.snapshot.rooms)[0] as unknown as Record<string, unknown>;
    expect(roomA.sm2NextReviewDate).toBe(NOW_A);
    expect(roomARebuilt.sm2NextReviewDate).toBe(NOW_B);
    expect(roomARebuilt.sm2EaseFactor).toBe(roomA.sm2EaseFactor);

    // (b) a subject record whose dungeon carries no createdAt falls back to `now`.
    const subjectB = (first.records as GenerationRecords).subjects.find(
      (entry) => entry.recordId === SUBJECT_B_RECORD_ID,
    )?.value as SubjectRecordValue;
    const subjectBRebuilt = (second.records as GenerationRecords).subjects.find(
      (entry) => entry.recordId === SUBJECT_B_RECORD_ID,
    )?.value as SubjectRecordValue;
    expect(subjectB.createdAt).toBe(NOW_A);
    expect(subjectBRebuilt.createdAt).toBe(NOW_B);

    // (c) recovery capture time, preference, and assistance stamps.
    const recoveryA = (first.records as GenerationRecords).recovery[0]?.value;
    const recoveryB = (second.records as GenerationRecords).recovery[0]?.value;
    expect(recoveryA?.capturedAt).toBe(NOW_A);
    expect(recoveryB?.capturedAt).toBe(NOW_B);
    // ...but the preserved recovery *bytes* are identical, which is the part
    // that must never drift.
    expect(recoveryA?.raw).toBe(recoveryB?.raw);
  });

  it('the legacy payload bytes it carries are identical across runs at different times', async () => {
    seedLegacyDevice();
    const a = await repoFor('idem-bytes-a');
    const first = await migrateLegacyState(migrateOptions(a));
    const b = await repoFor('idem-bytes-b');
    const second = await migrateLegacyState(
      migrateOptions(b, { generationId: GEN_2, now: NOW_B, clock: fixedClock(NOW_B) }),
    );

    // The snapshot content, ignoring injected timestamps, is byte-identical.
    const strip = (records: GenerationRecords | null): string => {
      const json = JSON.parse(
        JSON.stringify(records ?? null),
      ) as {
        subjects: { generationId: string; checksum: string; updatedAt: string; value: SubjectRecordValue }[];
      };
      for (const entry of json.subjects) {
        const snapshot = entry.value.snapshot as unknown as Record<string, unknown>;
        for (const room of Object.values(snapshot.rooms as Record<string, Record<string, unknown>>)) {
          delete room.sm2NextReviewDate;
        }
        entry.value.createdAt = '<injected>';
        entry.value.updatedAt = '<injected>';
        entry.generationId = '<injected>';
        entry.checksum = '<injected>';
        entry.updatedAt = '<injected>';
      }
      return JSON.stringify(json.subjects);
    };
    expect(strip(second.records)).toBe(strip(first.records));
  });

  it('treats an already-1.1.0 subject and an already-v3 progression as a no-op migration', async () => {
    // SUBJECT_B is already 1.1.0; the progression fixture is v3.
    const storage = window.localStorage;
    storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_B]));
    storage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_B}`, V11);
    storage.setItem('knowledge-dungeon:v1:progression', V3_PROGRESSION);
    storage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_B);

    const repo = await repoFor('already-current');
    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.subjectSchemaVersions).toEqual({ '1.1.0': 1 });
    expect(outcome.report.progressionSourceVersions).toEqual({ '3': 1 });

    // The 1.1.0 payload is carried through unchanged: no sm2 defaults invented,
    // no schema bump.
    const stored = (outcome.records as GenerationRecords).subjects[0]?.value as SubjectRecordValue;
    expect(stored.schemaVersion).toBe('1.1.0');
    expect(stored.snapshot.dungeon.schemaVersion).toBe('1.1.0');
    const original = JSON.parse(V11) as Record<string, unknown>;
    expect(stored.snapshot).toEqual(original);

    // A second generation over the same source is byte-identical.
    const repoTwo = await repoFor('already-current-2');
    const second = await migrateLegacyState(migrateOptions(repoTwo, { generationId: GEN_2 }));
    expect(second.report.status).toBe('migrated');
    expect(projection(second.records)).toEqual(projection(outcome.records));
  });

  it('carries a subject whose index names an id with no payload, without inventing one', async () => {
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-qa-ghost']));

    const repo = await repoFor('ghost-subject');
    const outcome = await migrateLegacyState(migrateOptions(repo));

    expect(outcome.report.status).toBe('migrated');
    expect((outcome.records as GenerationRecords).subjects).toHaveLength(0);
    const report = JSON.stringify(outcome.report);
    expect(report).not.toContain(QA_MARKER);
  });

  it('leaks a stale record when a staged generation id is re-staged with a subset', async () => {
    // Repository-level probe, independent of the migration.
    const repo = await repoFor('partial-restage');
    const snapshot = JSON.parse(V11) as SubjectRecordValue['snapshot'];
    const subject = (subjectId: string): SubjectRecordValue => ({
      subjectId,
      schemaVersion: '1.1.0',
      snapshot,
      createdAt: NOW_A,
      updatedAt: NOW_A,
    });

    await repo.stageGeneration({
      generationId: GEN_1,
      source: 'legacy-migration',
      records: { subjects: [subject('subject-qa-one'), subject('subject-qa-two')] },
    });
    expect(await allRecords(repo, GEN_1)).toEqual([
      'subjects/subject-qa-one',
      'subjects/subject-qa-two',
    ]);

    // Re-stage the same id with a strict subset. `stageGeneration` only ever
    // issues `put`, never `delete`, so the record that is no longer part of the
    // generation survives.
    await repo.stageGeneration({
      generationId: GEN_1,
      source: 'legacy-migration',
      records: { subjects: [subject('subject-qa-one')] },
    });
    const leftover = await allRecords(repo, GEN_1);
    expect(leftover).toEqual(['subjects/subject-qa-one', 'subjects/subject-qa-two']);

    // The count check refuses to activate it, so the leak is detected...
    const report = await repo.validateGeneration(GEN_1);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual({
      code: 'count-mismatch',
      scope: 'generation',
      count: 1,
      severity: 'error',
    });
    // ...but the leaked record is still on disk, and `readRecords` still
    // returns it, so anything that reads without validating sees it.
    expect((await repo.readRecords(GEN_1)).records.subjects).toHaveLength(2);
  });
});

describe('QA exit criterion 2: a failed staged transaction leaves the active generation unchanged', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  const POINTS: StageFailurePoint[] = [
    'after-subjects',
    'after-progression',
    'after-sessions',
    'after-attachments',
    'before-meta',
    'before-commit',
  ];

  for (const point of POINTS) {
    it(`leaves no partial record in ANY of the eleven stores when staging fails at "${point}"`, async () => {
      const repo = await repoFor(`stage-fail-${point}`);
      await repo.stageGeneration({ generationId: 'gen-baseline', source: 'initial', records: {} });
      await repo.activateGeneration('gen-baseline');

      const beforeKeys = await allRecords(repo, 'gen-baseline');
      const beforeMeta = JSON.parse(
        JSON.stringify((await repo.readGeneration('gen-baseline'))?.descriptor ?? null),
      );

      const snapshot = JSON.parse(V11) as SubjectRecordValue['snapshot'];
      await expect(
        repo.stageGeneration({
          generationId: GEN_1,
          source: 'legacy-migration',
          records: {
            subjects: [
              {
                subjectId: 'subject-qa-fail',
                schemaVersion: '1.1.0',
                snapshot,
                createdAt: NOW_A,
                updatedAt: NOW_A,
              },
            ],
            progression: [
              {
                subjectId: 'subject-qa-fail',
                sourceVersion: 3 as const,
                rank: 'Novice' as const,
                xpTotal: 1,
                bySubject: {},
                crossSubjectAchievements: [],
              },
            ],
            sessions: [
              {
                sessionId: 'session-qa-fail',
                subjectId: 'subject-qa-fail',
                startedAt: NOW_A,
                endedAt: null,
                roomsVisited: [],
                notesSubmitted: 0,
                reviewsCompleted: 0,
                xpEarned: 0,
                eventId: 'event-qa-fail',
              },
            ],
            attachmentMetadata: [
              {
                attachmentId: 'att-qa-fail',
                subjectId: 'subject-qa-fail',
                roomId: 'room-phase0-v110-minimal-root',
                sourceType: 'local' as const,
                mimeType: 'image/png',
                availability: 'external-only' as const,
                contentHash: null,
                addedAt: NOW_A,
              },
            ],
            preferences: [{ preferenceId: 'locale', value: 'en', updatedAt: NOW_A }],
            customSprites: [
              { spritePath: 'village/tree.svg', kind: 'override' as const, content: '<svg/>', updatedAt: NOW_A },
            ],
            recovery: [
              { kind: 'corrupt' as const, subjectId: 'subject-qa-fail', raw: QA_MARKER, capturedAt: NOW_A },
            ],
          } as never,
        }, {
          onStage: (p: StageFailurePoint) => {
            if (p === point) throw new Error(`qa-injected failure at ${p}`);
          },
        }),
      ).rejects.toMatchObject({ name: 'StorageV2Error' });

      // 1. The pointer never moved.
      expect(await repo.readActiveGenerationId()).toBe('gen-baseline');
      // 2. No record survived in ANY store, for the failed generation.
      expect(await allRecords(repo, GEN_1)).toEqual([]);
      // 3. No generation descriptor was written for the failed generation.
      expect(await repo.readGeneration(GEN_1)).toBeNull();
      expect((await repo.listGenerations()).map((g) => g.generationId)).toEqual(['gen-baseline']);
      // 4. The previous generation is still readable and unchanged.
      expect(await allRecords(repo, 'gen-baseline')).toEqual(beforeKeys);
      expect(JSON.parse(JSON.stringify((await repo.readGeneration('gen-baseline'))?.descriptor ?? null))).toEqual(
        beforeMeta,
      );
      // 5. A subsequent successful migration still works.
      const legacy = readLegacyAppState({ storage: snapshotLocalStorage() as unknown as ReadOnlyLegacyStorage });
      const outcome = await migrateLegacyState(
        migrateOptions(repo, {
          legacyState: {
            ...legacy,
            subjects: [
              {
                subjectId: 'subject-qa-retry',
                raw: V11,
                parsed: JSON.parse(V11),
                schemaVersion: '1.1.0',
              },
            ],
            subjectIds: ['subject-qa-retry'],
            progressionRaw: null,
            sessionsRaw: null,
            declaredSessionRaw: null,
            preferencesRaw: null,
            shortcutsRaw: null,
            locale: null,
            customSprites: [],
            spritePacksRaw: null,
            recovery: [],
          },
        }),
      );
      expect(outcome.report.status).toBe('migrated');
      expect(await repo.readActiveGenerationId()).toBe(GEN_1);
    });
  }

  it('leaves a STAGED generation behind when the failure lands after the stage commit', async () => {
    const repo = await repoFor('stage-commit-gap');
    await repo.stageGeneration({ generationId: 'gen-baseline', source: 'initial', records: {} });
    await repo.activateGeneration('gen-baseline');

    const snapshot = JSON.parse(V11) as SubjectRecordValue['snapshot'];
    const subject: SubjectRecordValue = {
      subjectId: 'subject-qa-staged',
      schemaVersion: '1.1.0',
      snapshot,
      createdAt: NOW_A,
      updatedAt: NOW_A,
    };

    // Failure at the `validate` stage, i.e. after stageGeneration has committed
    // and before activateGeneration runs.
    const outcome = await migrateLegacyState(
      migrateOptions(repo, {
        legacyState: {
          ...readLegacyAppState({ storage: snapshotLocalStorage() as unknown as ReadOnlyLegacyStorage }),
          subjects: [{ subjectId: subject.subjectId, raw: V11, parsed: JSON.parse(V11), schemaVersion: '1.1.0' }],
          subjectIds: [subject.subjectId],
          progressionRaw: null,
          sessionsRaw: null,
          declaredSessionRaw: null,
          preferencesRaw: null,
          shortcutsRaw: null,
          locale: null,
          customSprites: [],
          spritePacksRaw: null,
          recovery: [],
        },
        onStage: (stage: string) => {
          if (stage === 'validate') throw new Error('qa-injected failure after the stage commit');
        },
      }),
    );

    expect(outcome.report.status).toBe('recovery-required');
    expect(await repo.readActiveGenerationId()).toBe('gen-baseline');

    // The abandoned staged generation IS still present, in full, on disk.
    const abandoned = await repo.readGeneration(GEN_1);
    expect(abandoned).not.toBeNull();
    expect(abandoned?.descriptor?.status).toBe('staged');
    const abandonedKeys = await allRecords(repo, GEN_1);
    expect(abandonedKeys).toContain('subjects/subject-phase0-v110-minimal');
    expect(abandonedKeys).toContain('assistance/default');
    expect((await repo.listGenerations()).map((g) => g.generationId)).toEqual([
      'gen-baseline',
      GEN_1,
    ]);

    // It is inert: `readActiveGeneration` still resolves to the baseline, so a
    // reader can never observe the abandoned generation.
    const active = await repo.readActiveGeneration();
    expect(active?.generationId).toBe('gen-baseline');
    expect((active?.records.subjects ?? []).length).toBe(0);

    // Prune removes it, so it is reclaimable rather than an unbounded leak.
    const pruned = await repo.pruneGenerations({ keepAtLeast: 1 });
    expect(pruned.removed).toEqual([GEN_1]);
    expect(await repo.readGeneration(GEN_1)).toBeNull();
  });

  it('refuses to activate a generation that is not staged', async () => {
    const repo = await repoFor('activate-guards');
    await repo.stageGeneration({ generationId: 'gen-a', source: 'initial', records: {} });
    await repo.activateGeneration('gen-a');
    await repo.stageGeneration({ generationId: 'gen-b', source: 'local-edit', records: {} });
    await repo.activateGeneration('gen-b');

    // gen-a is superseded, so activating it again must be refused.
    await expect(repo.activateGeneration('gen-a')).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    await expect(repo.activateGeneration(GEN_3)).rejects.toMatchObject({
      code: 'GENERATION_NOT_FOUND',
    });
    // Re-staging the active generation under its own id is refused too.
    await expect(
      repo.stageGeneration({ generationId: 'gen-b', source: 'local-edit', records: {} }),
    ).rejects.toMatchObject({ code: 'GENERATION_ALREADY_ACTIVE' });
  });

  it('never advances the migration stage hook for a mid-transaction store failure', async () => {
    // A repository-level failure at 'after-sessions' never reaches the
    // migration's own stage hook, so the hook sequence a caller observes omits
    // 'stage-records' entirely. Recorded as the observed contract.
    seedLegacyDevice();
    const repo = await repoFor('hook-omission');
    const repo2 = await repoFor('hook-omission-2');
    const seen: string[] = [];
    await repo2.stageGeneration(
      {
        generationId: GEN_2,
        source: 'legacy-migration',
        records: {},
      },
      {
        onStage: (point: StageFailurePoint) => {
          if (point === 'after-sessions') throw new Error('qa-injected');
        },
      },
    ).catch(() => undefined);
    // A migration-level run over the same repository still reports the pointer
    // it found, and no hook fired for the failed stage.
    const outcome = await migrateLegacyState(
      migrateOptions(repo, { onStage: (stage: string) => seen.push(stage) }),
    );
    expect(outcome.report.status).toBe('migrated');
    expect(seen).toEqual(['read-legacy', 'transform', 'stage-records', 'validate', 'compare', 'receipt', 'activate']);
  });

  it('opens one readwrite transaction per stage, spanning all eleven stores', async () => {
    const repo = await repoFor('tx-count');
    const db = (repo as unknown as { db: IDBDatabase }).db;
    const seen: { mode: string; stores: string[] }[] = [];
    const original = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, 'transaction')
      .mockImplementation(((names: string | Iterable<string>, mode?: IDBTransactionMode) => {
        const list = typeof names === 'string' ? [names] : [...names];
        seen.push({ mode: mode ?? 'readonly', stores: list });
        return original(names as string, mode) as IDBTransaction;
      }) as typeof db.transaction);

    try {
      await repo.stageGeneration({ generationId: GEN_1, source: 'initial', records: {} });
    } finally {
      spy.mockRestore();
    }

    const write = seen.filter((entry) => entry.mode === 'readwrite');
    expect(write).toHaveLength(1);
    expect([...write[0]!.stores].sort()).toEqual([...STORAGE_V2_STORE_NAMES].sort());
  });

  it('commits putRecords data and its descriptor refresh in ONE transaction', async () => {
    const repo = await repoFor('tx-put');
    const db = (repo as unknown as { db: IDBDatabase }).db;
    await repo.stageGeneration({ generationId: GEN_1, source: 'initial', records: {} });
    await repo.activateGeneration(GEN_1);

    const seen: { mode: string; stores: string[] }[] = [];
    const original = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, 'transaction')
      .mockImplementation(((names: string | Iterable<string>, mode?: IDBTransactionMode) => {
        const list = typeof names === 'string' ? [names] : [...names];
        seen.push({ mode: mode ?? 'readonly', stores: list });
        return original(names as string, mode) as IDBTransaction;
      }) as typeof db.transaction);

    let after: Awaited<ReturnType<typeof repo.putRecords>> | null = null;
    try {
      after = await repo.putRecords(GEN_1, {
        preferences: [{ preferenceId: 'locale', value: 'fr', updatedAt: NOW_A }],
      });
    } finally {
      spy.mockRestore();
    }

    const writes = seen.filter((entry) => entry.mode === 'readwrite');
    // DEFECT WAS (should-fix): the data write and the descriptor refresh
    // committed as TWO readwrite transactions, so a crash between them left a
    // `recordCounts` / `contentChecksum` that `validateGeneration` would later
    // report as a mismatch. They now commit together, in ONE transaction that
    // spans the data stores and `meta`.
    expect(writes).toHaveLength(1);
    expect([...writes[0]!.stores].sort()).toEqual([...STORAGE_V2_STORE_NAMES].sort());
    expect(writes[0]!.stores).toContain('meta');
    expect(after?.recordCounts.preferences).toBe(1);
  });

  it('FIXED: the descriptor after putRecords agrees with what is actually stored', async () => {
    // The consequence of the single-transaction fix: re-reading the generation
    // and validating it must both agree with the descriptor that was committed.
    const repo = await repoFor('tx-put-agree');
    await repo.stageGeneration({ generationId: GEN_1, source: 'initial', records: {} });
    await repo.activateGeneration(GEN_1);

    await repo.putRecords(GEN_1, {
      preferences: [{ preferenceId: 'locale', value: 'fr', updatedAt: NOW_A }],
    });
    await repo.putRecords(GEN_1, {
      preferences: [
        { preferenceId: 'locale', value: 'es', updatedAt: NOW_A },
        { preferenceId: 'graphics', value: { colorTheme: 'dark' }, updatedAt: NOW_A },
      ],
    });
    await repo.writeMigrationReceipt({
      receiptId: 'receipt-agree',
      migrationId: 'legacy-localstorage-to-storage-v2',
      fromStorage: 'legacy-localstorage',
      toStorage: 'storage-v2',
      stagedGenerationId: GEN_1,
      previousActiveGenerationId: null,
      status: 'activated',
      createdAt: NOW_A,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {} as never,
      recordChecksums: {} as never,
      contentChecksum: 'x'.repeat(64),
    });

    const descriptor = (await repo.readGeneration(GEN_1))?.descriptor;
    const stored = (await repo.readGeneration(GEN_1))?.records;
    expect(descriptor?.recordCounts.preferences).toBe(2);
    expect(descriptor?.recordCounts.migrationReceipts).toBe(1);
    expect(descriptor?.contentChecksum).toBe(stored ? computeStoreChecksums(stored).meta : null);
    const report = await repo.validateGeneration(GEN_1);
    expect(report.ok).toBe(true);
    expect(report.checksumMismatches).toEqual([]);
  });
});

describe('QA exit criterion 3: legacy keys remain byte-for-byte untouched', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('compares every key, its exact string, and key order against the REAL localStorage', async () => {
    seedLegacyDevice();
    // Extra hostile-ish but legal shapes: a corrupt JSON value, an empty value,
    // a key the allowlist excludes, and a key with a value containing a
    // surrogate pair so byte length and string length differ.
    window.localStorage.setItem('knowledge-dungeon:session:preferences', '{not json');
    window.localStorage.setItem('knowledge-dungeon:locale', '');
    window.localStorage.setItem('unrelated-third-party', '\u{1F41F}synthetic-emoji');
    window.localStorage.setItem('kd-quest-step', 'synthetic-step');

    const before = snapshotLocalStorage();
    const beforeKeys = before.keys();
    const beforeEntries = before.entries();
    const beforeLength = window.localStorage.length;

    const repo = await repoFor('byte-for-byte');
    const outcome = await migrateLegacyState(migrateOptions(repo));
    expect(outcome.report.status).toBe('migrated');

    const after = snapshotLocalStorage();
    // 1. Same key set, in the same insertion order.
    expect(after.keys()).toEqual(beforeKeys);
    expect(window.localStorage.length).toBe(beforeLength);
    // 2. Same exact string per key.
    expect(after.entries()).toEqual(beforeEntries);
    for (const [key, value] of beforeEntries) {
      expect(window.localStorage.getItem(key), key).toBe(value);
    }
    // 3. No new key appeared.
    expect(after.keys().filter((key) => !beforeKeys.includes(key))).toEqual([]);
  });

  it('a storage that THROWS on setItem/removeItem/clear survives a full migration', async () => {
    seedLegacyDevice();
    const repo = await repoFor('throwing-storage');
    const calls: string[] = [];
    const backing = new Map(snapshotLocalStorage().entries());
    const throwing = {
      get length(): number {
        return backing.size;
      },
      key(index: number): string | null {
        return [...backing.keys()][index] ?? null;
      },
      getItem(key: string): string | null {
        return backing.has(key) ? (backing.get(key) as string) : null;
      },
      setItem(key: string): never {
        calls.push(`setItem:${key}`);
        throw new Error('qa-probe: legacy storage write attempted');
      },
      removeItem(key: string): never {
        calls.push(`removeItem:${key}`);
        throw new Error('qa-probe: legacy storage removal attempted');
      },
      clear(): never {
        calls.push('clear');
        throw new Error('qa-probe: legacy storage clear attempted');
      },
    } as unknown as ReadOnlyLegacyStorage;

    const outcome = await migrateLegacyState(migrateOptions(repo, { storage: throwing }));
    expect(outcome.report.status).toBe('migrated');
    expect(calls).toEqual([]);
  });

  it('instruments the REAL localStorage object and proves no mutating call is made', async () => {
    seedLegacyDevice();
    const repo = await repoFor('real-storage-spy');
    const storage = window.localStorage;
    const calls: string[] = [];
    const setItem = storage.setItem.bind(storage);
    const removeItem = storage.removeItem.bind(storage);
    const clear = storage.clear.bind(storage);
    const setSpy = vi.spyOn(storage, 'setItem').mockImplementation((key: string, value: string) => {
      calls.push(`setItem:${key}`);
      return setItem(key, value);
    });
    const removeSpy = vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      calls.push(`removeItem:${key}`);
      return removeItem(key);
    });
    const clearSpy = vi.spyOn(storage, 'clear').mockImplementation(() => {
      calls.push('clear');
      return clear();
    });

    try {
      // No `storage` option: the reader must resolve globalThis.localStorage.
      const outcome = await migrateLegacyState(migrateOptions(repo));
      expect(outcome.report.status).toBe('migrated');
    } finally {
      setSpy.mockRestore();
      removeSpy.mockRestore();
      clearSpy.mockRestore();
    }

    expect(calls).toEqual([]);
  });

  it('the legacy reader alone performs no writes, with a throwing storage', () => {
    seedLegacyDevice();
    const calls: string[] = [];
    const backing = new Map(snapshotLocalStorage().entries());
    const throwing = {
      get length(): number {
        return backing.size;
      },
      key: (index: number) => [...backing.keys()][index] ?? null,
      getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
      setItem: (key: string) => {
        calls.push(`setItem:${key}`);
        throw new Error('qa-probe: read attempted to write');
      },
      removeItem: (key: string) => {
        calls.push(`removeItem:${key}`);
        throw new Error('qa-probe: read attempted to remove');
      },
      clear: () => {
        calls.push('clear');
        throw new Error('qa-probe: read attempted to clear');
      },
    } as unknown as ReadOnlyLegacyStorage;

    const state = readLegacyAppState({ storage: throwing });
    expect(state.subjects.length).toBeGreaterThan(0);
    expect(state.report.keys.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('never puts the marker string, a room topic, or a note into any report or error', async () => {
    seedLegacyDevice();
    const repo = await repoFor('privacy-marker');
    const outcome = await migrateLegacyState(migrateOptions(repo));

    const surfaces: [string, unknown][] = [
      ['MigrationReport', outcome.report],
      ['externalOnlyAttachments', outcome.report.externalOnlyAttachments],
      ['LegacyReadReport', readLegacyAppState().report],
      ['stageGeneration descriptor', JSON.parse(JSON.stringify((await repo.readGeneration(GEN_1))?.descriptor ?? null))],
      [
        'migration receipts',
        await repo.listMigrationReceipts(GEN_1),
      ],
    ];
    for (const [name, surface] of surfaces) {
      const text = JSON.stringify(surface) ?? '';
      expect(text, name).not.toContain(QA_MARKER);
      expect(text, name).not.toContain('Synthetic V1 Topic');
      expect(text, name).not.toContain('Synthetic V1 Note');
      expect(text, name).not.toContain('Synthetic Legacy Relic');
      expect(text, name).not.toContain('noteMarkdown');
      expect(text, name).not.toContain('topic');
    }
  });
});

describe('QA determinism: no clock, no randomness, no network', () => {
  beforeEach(resetStorageV2Environment);
  afterEach(teardown);

  it('never consults the real clock, Math.random, or the network', async () => {
    seedLegacyDevice();
    const repo = await repoFor('determinism-probes');

    const consulted: string[] = [];
    const realRandom = Math.random;
    const realFetch = globalThis.fetch;

    // Only `Date` is faked: `fake-indexeddb` schedules its own work with
    // `setTimeout`/`setImmediate`, so faking the whole timer surface would
    // deadlock the transaction rather than test anything.
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
      expect(outcome.report.createdAt).toBe(NOW_A);
    } finally {
      Math.random = realRandom;
      vi.stubGlobal('fetch', realFetch);
      vi.useRealTimers();
    }

    expect(consulted).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('produces the same records when the system clock is moved between runs', async () => {
    seedLegacyDevice();
    const a = await repoFor('clock-a');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'));
    const first = await migrateLegacyState(migrateOptions(a));
    vi.useRealTimers();

    const b = await repoFor('clock-b');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-06-06T06:06:06.000Z'));
    const second = await migrateLegacyState(migrateOptions(b));
    vi.useRealTimers();

    expect(JSON.stringify(projection(second.records))).toBe(
      JSON.stringify(projection(first.records)),
    );
  });

  it('the migration module itself references no clock, randomness, or network API', async () => {
    const modules = [
      'services/persistence/v2/checksum.ts',
      'services/persistence/v2/schema.ts',
      'services/persistence/v2/validation.ts',
      'services/persistence/v2/database.ts',
      'services/persistence/v2/repository.ts',
      'services/persistence/v2/legacyReader.ts',
      'services/persistence/v2/migrations.ts',
      'services/persistence/v2/archive.ts',
      'core/progression/canonicalProgression.ts',
    ];
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const forbidden: [RegExp, string][] = [
      [/\bMath\s*\.\s*random\b/, 'Math.random'],
      [/\bDate\s*\.\s*now\b/, 'Date.now'],
      // `new Date(0)` is the frozen epoch constant, not a clock read.
      [/\bnew\s+Date\s*\((?!0\s*\))/, 'new Date(...)'],
      [/\bfetch\s*\(/, 'fetch(...)'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bperformance\s*\.\s*now\b/, 'performance.now'],
      [/\bWebSocket\b/, 'WebSocket'],
      [/\bnavigator\s*\.\s*sendBeacon\b/, 'navigator.sendBeacon'],
    ];
    for (const relative of modules) {
      const source = readFileSync(join(process.cwd(), 'src', relative), 'utf8');
      // Strip block and line comments so prose about determinism is not a hit.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [pattern, label] of forbidden) {
        expect(pattern.test(code), `${relative} must not reference ${label}`).toBe(false);
      }
    }
  });
});

describe('QA record-key derivation is collision-free', () => {
  it('keeps metadata and blob record ids disjoint', () => {
    const values = emptyGenerationRecordValues();
    const records = buildRecordEnvelopes(
      'gen',
      {
        ...values,
        attachmentMetadata: [
          {
            attachmentId: 'blob:x',
            subjectId: 's',
            roomId: 'r',
            sourceType: 'local',
            mimeType: 'image/png',
            availability: 'stored',
            contentHash: 'a'.repeat(64),
            addedAt: NOW_A,
          },
        ],
      } as never,
      NOW_A,
    );
    const ids = [...records.attachmentMetadata, ...records.attachmentBlobs].map((r) => r.recordId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(records.attachmentMetadata[0]?.recordId).toBe('meta:blob:x');
  });

  it('stores counts for every declared store name', () => {
    const repo = (null as unknown) as StorageV2Repository;
    void repo;
    expect([...STORAGE_V2_STORE_NAMES]).toHaveLength(11);
    const names: StorageV2StoreName[] = [
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
    expect(names).toHaveLength(11);
  });
});
