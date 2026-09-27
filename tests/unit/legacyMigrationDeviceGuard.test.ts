/**
 * The legacy-migration guard's decision table, pinned.
 *
 * ## Why this file exists
 *
 * A cross-phase data-loss defect survived two accepted phases because the gate
 * suite read the **active generation** directly - which is exactly the generation
 * that a second boot used to supersede. Every assertion in it was true and the
 * product was still losing data, because the assertion was made about the wrong
 * object: the question "did this write land?" was answered by reading the write's
 * destination, and never by asking what the *next boot* would do to it.
 *
 * So this file pins the **decision**, and it pins it in two forms that cannot
 * substitute for each other:
 *
 * 1. {@link decideDeviceMigration} as a pure function over the registry facts, as
 *    a table of six cases. This is the rule itself, and it is checkable without a
 *    database.
 * 2. The same six cases driven through `migrateLegacyState` against a real
 *    repository, asserting the *effect* on the device: which generation the
 *    pointer names, whether the write is still reachable, whether anything was
 *    staged, and what the report says.
 *
 * A pure-function table can be self-consistently wrong, and an end-to-end run can
 * be accidentally vacuous. Together they are the reasoning, and the browser lane
 * `tests/e2e/reloadPersistence.spec.ts` is the third leg: the same six cases
 * against the flagged artifact in Chromium.
 *
 * ## The six cases
 *
 * | # | the device | the run must |
 * | --- | --- | --- |
 * | 1 | holds real legacy data and nothing else - it used an older build | migrate it |
 * | 2 | took the `no-source-data` short-circuit and then made a real write | do nothing, and keep the write |
 * | 3 | holds only a `staged` generation from a run that failed | discard it and migrate again |
 * | 4 | holds no learner content at all | report `no-source-data` and stage nothing |
 * | 5 | already holds a `legacy-migration` generation with this migration's receipt | be a no-op, and say so |
 * | 6 | (all of the above) | report an outcome a caller can tell apart from "migrated just now" |
 *
 * Every fixture value is synthetic. No learner data, no real host, no network.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import 'fake-indexeddb/auto';

import {
  createDeterministicIdFactory,
  fixedClock,
} from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import {
  decideDeviceMigration,
  migrateLegacyState,
  type DeviceMigrationEvidence,
  type DeviceMigrationDecision,
} from '@/services/persistence/v2/migrations';
import { ensureInitialGeneration } from '@/services/persistence/v2/appState';
import {
  assertMigrationStatusReachable,
  classifyMigrationReport,
} from '@/services/persistence/v2/migrationState';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import type { SubjectSnapshot } from '@/core/validation/persistence';

const FIXED_NOW = '2026-09-27T09:00:00.000Z';
const MIGRATION_GENERATION_ID = 'gen-migration-0001';
const INITIAL_GENERATION_ID = 'gen-initial-0001';
const SUBJECT_FIXTURE = join(
  process.cwd(),
  'tests',
  'fixtures',
  'persistence',
  'subject',
  'subject-1.1.0-minimal.json',
);

function syntheticSnapshot(subjectId: string, subjectName: string): SubjectSnapshot {
  const snapshot = JSON.parse(readFileSync(SUBJECT_FIXTURE, 'utf8')) as SubjectSnapshot;
  snapshot.dungeon.dungeonId = subjectId;
  snapshot.dungeon.subjectName = subjectName;
  return snapshot;
}

/** A subject record of the shape `putRecords` and the products write. */
function subjectRecord(subjectId: string, subjectName: string): SubjectRecordValue {
  return {
    subjectId,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot: syntheticSnapshot(subjectId, subjectName),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

/** A device with nothing in it: no generation, no pointer, no records. */
async function openEmptyDevice(databaseName: string): Promise<StorageV2Repository> {
  return openStorageV2Repository({
    databaseName,
    clock: fixedClock(FIXED_NOW),
    idFactory: createDeterministicIdFactory('guard'),
  });
}

/** Seed the legacy keys with one real subject, as an older build would have. */
function seedLegacySubject(subjectId: string, subjectName: string): void {
  window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([subjectId]));
  window.localStorage.setItem(
    `knowledge-dungeon:v1:subject:${subjectId}`,
    JSON.stringify(syntheticSnapshot(subjectId, subjectName)),
  );
}

function migrateOptions(
  repository: StorageV2Repository,
  generationId = MIGRATION_GENERATION_ID,
): Parameters<typeof migrateLegacyState>[0] {
  return {
    repository,
    generationId,
    now: FIXED_NOW,
    clock: { now: () => FIXED_NOW },
  };
}

/** The subject ids in the generation the pointer names, or `[]`. */
async function subjectsInActiveGeneration(
  repository: StorageV2Repository,
): Promise<{ generationId: string | null; subjectIds: string[] }> {
  const active = await repository.readActiveGenerationId();
  if (active === null) return { generationId: null, subjectIds: [] };
  const records = (await repository.readRecords(active)).records;
  return {
    generationId: active,
    subjectIds: records.subjects.map((envelope) => envelope.recordId).sort(),
  };
}

/** A registry description, for the pure table. */
function evidence(
  generations: DeviceMigrationEvidence['generations'],
  activeGenerationId: string | null,
  legacyMigrationReceipts: DeviceMigrationEvidence['legacyMigrationReceipts'] = [],
): DeviceMigrationEvidence {
  return { generations, activeGenerationId, legacyMigrationReceipts };
}

let openRepositories: StorageV2Repository[] = [];
let databaseCount = 0;

/** A device whose database name is unique to one test. */
async function device(): Promise<StorageV2Repository> {
  databaseCount += 1;
  const repository = await openEmptyDevice(`kd-guard-table-${databaseCount}`);
  openRepositories.push(repository);
  return repository;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  for (const repository of openRepositories.splice(0)) repository.close();
  window.localStorage.clear();
});

// ── 1. The decision, as a pure table ───────────────────────────────────────

describe('the device-level guard decides over the registry, not over one generation id', () => {
  it('has exactly two outcomes, and neither of them is a third thing', () => {
    // The guard is a decision between "re-stage" and "do not touch this device".
    // A skip that wrote anything, or a migration that declined, would be a third
    // outcome - which is what the defect was.
    const migrate: DeviceMigrationDecision = { kind: 'migrate', reason: 'no-reachable-generation' };
    const skip: DeviceMigrationDecision = {
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: 'g',
      receiptId: null,
    };
    expect(decideDeviceMigration(evidence([], null))).toEqual(migrate);
    expect(decideDeviceMigration(evidence([{ generationId: 'g', source: 'initial', status: 'active' }], 'g'))).toEqual(
      skip,
    );
  });

  it('case 1: a device that has never migrated migrates', () => {
    // A device that used an older build and then upgraded. No registry entry at
    // all, and no pointer: there is nothing to supersede, so this is the whole
    // point of the phase and the guard must not get in its way.
    expect(decideDeviceMigration(evidence([], null))).toEqual({
      kind: 'migrate',
      reason: 'no-reachable-generation',
    });
    // A receipt with no generation is not a reachable generation either, so it
    // cannot stand in for one.
    expect(
      decideDeviceMigration(
        evidence([], null, [{ receiptId: 'receipt-orphan', stagedGenerationId: 'gen-gone' }]),
      ),
    ).toEqual({ kind: 'migrate', reason: 'no-reachable-generation' });
  });

  it('case 2: a device that took the short-circuit and then wrote is left alone', () => {
    // THE DEFECT. `gen-initial-0001` is `active`, there is no
    // `gen-migration-0001` on this device, and there is no receipt - and the
    // device is not migrated again, because a second generation would supersede
    // the one the learner's write is in.
    const decision = decideDeviceMigration(
      evidence([{ generationId: INITIAL_GENERATION_ID, source: 'initial', status: 'active' }], INITIAL_GENERATION_ID),
    );
    expect(decision).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: INITIAL_GENERATION_ID,
      receiptId: null,
    });
  });

  it('case 3: a staged generation alone is not a migrated device', () => {
    // A run that failed after its stage commit left real records that no reader
    // can reach. Reporting `migrated` for that would tell a caller reading only
    // `status` that the device is migrated when its data is not, so the guard
    // migrates again - and the caller's reclaim step discards the staged records.
    expect(
      decideDeviceMigration(
        evidence([{ generationId: MIGRATION_GENERATION_ID, source: 'legacy-migration', status: 'staged' }], null),
      ),
    ).toEqual({ kind: 'migrate', reason: 'no-reachable-generation' });
    // Even with this migration's own receipt on it. A receipt on an unreachable
    // generation is the fingerprint of a failed run, not of a migration.
    expect(
      decideDeviceMigration(
        evidence(
          [{ generationId: MIGRATION_GENERATION_ID, source: 'legacy-migration', status: 'staged' }],
          null,
          [{ receiptId: 'receipt-staged', stagedGenerationId: MIGRATION_GENERATION_ID }],
        ),
      ),
    ).toEqual({ kind: 'migrate', reason: 'no-reachable-generation' });
  });

  it('case 5: a migrated device is a no-op, with or without a later generation', () => {
    const receipt = { receiptId: 'gen-migration-0001-receipt', stagedGenerationId: MIGRATION_GENERATION_ID };
    // Migrated, and still the generation the device uses.
    expect(
      decideDeviceMigration(
        evidence(
          [{ generationId: MIGRATION_GENERATION_ID, source: 'legacy-migration', status: 'active' }],
          MIGRATION_GENERATION_ID,
          [receipt],
        ),
      ),
    ).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: MIGRATION_GENERATION_ID,
      receiptId: receipt.receiptId,
    });
    // Migrated, and since superseded by a later phase. Still a no-op, and the
    // report names the generation the pointer is on rather than the old one.
    expect(
      decideDeviceMigration(
        evidence(
          [
            { generationId: MIGRATION_GENERATION_ID, source: 'legacy-migration', status: 'superseded' },
            { generationId: 'gen-product-0001', source: 'subject-import', status: 'active' },
          ],
          'gen-product-0001',
          [receipt],
        ),
      ),
    ).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: 'gen-product-0001',
      receiptId: receipt.receiptId,
    });
  });

  it('counts every reachable status, and only reachable ones', () => {
    // `staged` is the only status whose records no reader can reach, so it is the
    // only one that does not count. This is asserted over the union of statuses
    // rather than over the three cases above so a fourth status added to the
    // schema cannot slip past the guard's own rule.
    for (const status of ['staged', 'active', 'superseded'] as const) {
      const decision = decideDeviceMigration(
        evidence([{ generationId: 'gen-x', source: 'local-edit', status }], status === 'staged' ? null : 'gen-x'),
      );
      expect(decision.kind, status).toBe(status === 'staged' ? 'migrate' : 'skip');
    }
  });

  it('reads the registry, not the pointer: a pointer into an undescribed generation migrates', () => {
    // The pointer names a generation the registry does not describe. That is a
    // corrupt registry rather than a migrated device, so the run migrates - and the
    // reclaim step refuses to touch whatever the pointer owns, so nothing is
    // deleted to get there.
    expect(decideDeviceMigration(evidence([], 'gen-undescribed'))).toEqual({
      kind: 'migrate',
      reason: 'no-reachable-generation',
    });
  });

  it('is total: a pointer naming something unreachable still decides, without throwing', () => {
    // A self-consistent registry cannot produce this, and a guard that threw here
    // would turn a corrupt registry into a `recovery-required` for a device whose
    // data is fine. The decision is 'skip' - the device holds a reachable
    // generation - and the report names no active generation, because the pointer
    // does not name one.
    expect(
      decideDeviceMigration(
        evidence([{ generationId: 'gen-reachable', source: 'local-edit', status: 'active' }], 'gen-gone'),
      ),
    ).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: null,
      receiptId: null,
    });
  });
});

// ── 2. The same six cases, observed on a device ───────────────────────────

describe('case 1: a never-migrated device with real legacy data still migrates', () => {
  it('carries the subject in, activates it, and reports migrated', async () => {
    const repository = await device();
    seedLegacySubject('subject-legacy-guard', 'Guard synthetic legacy subject');

    const outcome = await migrateLegacyState(migrateOptions(repository));

    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    expect(outcome.report.stagedGenerationId).toBe(MIGRATION_GENERATION_ID);
    expect(outcome.report.receiptId).not.toBeNull();
    expect(await subjectsInActiveGeneration(repository)).toEqual({
      generationId: MIGRATION_GENERATION_ID,
      subjectIds: ['subject-legacy-guard'],
    });
    // And the legacy keys are still there, byte for byte: the mirror is what a
    // rollback build reads.
    expect(window.localStorage.getItem('knowledge-dungeon:v1:subjects')).toBe(
      JSON.stringify(['subject-legacy-guard']),
    );
  });
});

describe('case 2: a device that wrote after the short-circuit is not migrated again', () => {
  it('the write is still reachable after the next boot, and the pointer never moved', async () => {
    const repository = await device();
    // Boot 1 on a fresh profile: only a locale, so there is nothing to migrate.
    window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');
    const first = await migrateLegacyState(migrateOptions(repository));
    expect(first.report.status).toBe('no-source-data');
    expect(await repository.readActiveGenerationId()).toBeNull();

    // The first real write creates the initial generation and lands in it, the
    // way every subject save and every data product does.
    await ensureInitialGeneration(repository, {
      generationId: INITIAL_GENERATION_ID,
      now: FIXED_NOW,
    });
    await repository.putRecords(INITIAL_GENERATION_ID, {
      subjects: [subjectRecord('subject-written-after-boot', 'Guard synthetic written subject')],
    });
    expect(await subjectsInActiveGeneration(repository)).toEqual({
      generationId: INITIAL_GENERATION_ID,
      subjectIds: ['subject-written-after-boot'],
    });

    // The learner then creates a subject through the app, which mirrors it.
    seedLegacySubject('subject-mirrored-by-the-app', 'Guard synthetic mirrored subject');

    // Boot 2.
    const second = await migrateLegacyState(migrateOptions(repository));

    expect(second.report.status).toBe('already-migrated');
    expect(second.report.stagedGenerationId).toBeNull();
    expect(second.report.activated).toBe(false);
    expect(second.report.previousActiveGenerationId).toBe(INITIAL_GENERATION_ID);
    // The generation the write is in is still the generation the device uses.
    expect(await subjectsInActiveGeneration(repository)).toEqual({
      generationId: INITIAL_GENERATION_ID,
      subjectIds: ['subject-written-after-boot'],
    });
    expect((await repository.readGeneration(INITIAL_GENERATION_ID))?.descriptor?.status).toBe('active');
    // No second generation, and no receipt: this run staged nothing.
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([
      INITIAL_GENERATION_ID,
    ]);
    expect(await repository.listMigrationReceipts()).toEqual([]);
    // Boot 3 is the same answer.
    expect((await migrateLegacyState(migrateOptions(repository))).report.status).toBe('already-migrated');
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([
      INITIAL_GENERATION_ID,
    ]);
  });

  it('a write that reached only the active generation survives - the products\' case', async () => {
    // The defect, stated without any product: a record written straight into the
    // active generation, with nothing in `localStorage` naming it. This is what a
    // `.kdbak` restore, a `.kdsubject` copy import, and a `.kdtemplate` import
    // each leave behind, and it is the write the old guard destroyed.
    const repository = await device();
    window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');
    expect((await migrateLegacyState(migrateOptions(repository))).report.status).toBe('no-source-data');
    await ensureInitialGeneration(repository, { generationId: INITIAL_GENERATION_ID, now: FIXED_NOW });

    // Something the learner does, which the legacy mirror knows nothing about.
    window.localStorage.setItem('knowledge-dungeon:v1:progression', JSON.stringify({ version: 3, bySubject: {} }));
    await repository.putRecords(INITIAL_GENERATION_ID, {
      subjects: [subjectRecord('subject-product-only', 'Guard synthetic product-only subject')],
    });

    const second = await migrateLegacyState(migrateOptions(repository));

    expect(second.report.status).toBe('already-migrated');
    expect(await subjectsInActiveGeneration(repository)).toEqual({
      generationId: INITIAL_GENERATION_ID,
      subjectIds: ['subject-product-only'],
    });
  });
});

describe('case 3: a staged generation from a failed run is discarded and migrated again', () => {
  it('the abandoned records are replaced by a reachable generation that holds the source', async () => {
    const repository = await device();
    seedLegacySubject('subject-after-failed-run', 'Guard synthetic after failed run');

    // What a run that failed after its stage commit leaves behind: real records
    // under a `staged` generation, and a pointer naming nothing. This device has
    // **no** reachable generation, which is the only shape case 3 is about.
    await repository.stageGeneration({
      generationId: MIGRATION_GENERATION_ID,
      source: 'legacy-migration',
      records: { subjects: [subjectRecord('subject-abandoned', 'Guard synthetic abandoned')] },
    });
    expect((await repository.readGeneration(MIGRATION_GENERATION_ID))?.descriptor?.status).toBe('staged');
    expect(await repository.readActiveGenerationId()).toBeNull();

    const second = await migrateLegacyState(migrateOptions(repository));

    // Not a skip: the abandoned records are unreachable, so the device is not
    // migrated until they are reclaimed and the source is carried in again. The
    // reclaimed id is the one the abandoned generation used, and the abandoned
    // record is not in the result - the source is.
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(true);
    expect(await subjectsInActiveGeneration(repository)).toEqual({
      generationId: MIGRATION_GENERATION_ID,
      subjectIds: ['subject-after-failed-run'],
    });
  });

  it('and a staged generation on an already-migrated device is left for prune, not deleted', async () => {
    // A skip is a decision to touch nothing, so it does not reclaim. A `staged`
    // generation is unreachable by definition, so leaving one is not data loss,
    // and `pruneGenerations` already treats it as a removal candidate. Stated
    // here because "nothing happens on this path" is exactly the kind of property
    // a later change makes destructive by accident.
    const repository = await device();
    seedLegacySubject('subject-guard-live', 'Guard synthetic live subject');
    expect((await migrateLegacyState(migrateOptions(repository))).report.status).toBe('migrated');
    await repository.stageGeneration({
      generationId: 'gen-guard-orphan',
      source: 'legacy-migration',
      records: { subjects: [subjectRecord('subject-guard-orphan', 'Guard synthetic orphan')] },
    });

    const second = await migrateLegacyState(migrateOptions(repository, 'gen-guard-orphan'));

    expect(second.report.status).toBe('already-migrated');
    expect((await repository.readGeneration('gen-guard-orphan'))?.descriptor?.status).toBe('staged');
    expect(await subjectsInActiveGeneration(repository)).toEqual({
      generationId: MIGRATION_GENERATION_ID,
      subjectIds: ['subject-guard-live'],
    });
  });
});

describe('case 4: hasNoLearnerContent still short-circuits', () => {
  it('reports no-source-data and stages nothing, on a device with a live generation too', async () => {
    const repository = await device();
    window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');

    const first = await migrateLegacyState(migrateOptions(repository));

    expect(first.report.status).toBe('no-source-data');
    expect(first.report.stagedGenerationId).toBeNull();
    expect(first.report.activated).toBe(false);
    expect(await repository.listGenerations()).toEqual([]);
    expect(await repository.readActiveGenerationId()).toBeNull();
    expect(await repository.listMigrationReceipts()).toEqual([]);

    // With a live generation present the short-circuit is still the answer: there
    // is genuinely nothing in the mirror to move, and `ensureInitialGeneration` is
    // a no-op over a device that already has one.
    await ensureInitialGeneration(repository, { generationId: INITIAL_GENERATION_ID, now: FIXED_NOW });
    const second = await migrateLegacyState(migrateOptions(repository));
    expect(second.report.status).toBe('no-source-data');
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([
      INITIAL_GENERATION_ID,
    ]);
  });
});

describe('case 5: a device that already migrated stays a no-op, reported as migrated', () => {
  it('re-runs under the same id, changes nothing, and keeps today\'s report shape', async () => {
    // Deliberately unchanged behaviour, pinned so the device-level guard cannot be
    // mistaken for a replacement of it. A same-id retry can name the generation
    // that consumed the legacy state, so `migrated` remains literally true of it.
    const repository = await device();
    seedLegacySubject('subject-guard-retry', 'Guard synthetic retry subject');

    const first = await migrateLegacyState(migrateOptions(repository));
    expect(first.report.status).toBe('migrated');
    const recordsBefore = JSON.stringify((await repository.readGeneration(MIGRATION_GENERATION_ID))?.records);

    const second = await migrateLegacyState(migrateOptions(repository));

    expect(second.report.status).toBe('migrated');
    expect(second.report.stagedGenerationId).toBe(MIGRATION_GENERATION_ID);
    expect(second.report.activated).toBe(true);
    expect(second.report.recovery).toBeNull();
    expect(second.report.recordCounts).toEqual(first.report.recordCounts);
    expect(second.report.contentChecksum).toBe(first.report.contentChecksum);
    expect(second.report.receiptId).toBe(first.report.receiptId);
    expect(JSON.stringify((await repository.readGeneration(MIGRATION_GENERATION_ID))?.records)).toBe(
      recordsBefore,
    );
    expect(await repository.listMigrationReceipts(MIGRATION_GENERATION_ID)).toHaveLength(1);
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([
      MIGRATION_GENERATION_ID,
    ]);
  });

  it('and a same-id retry after a later generation superseded it does not steal the pointer', async () => {
    const repository = await device();
    seedLegacySubject('subject-guard-superseded', 'Guard synthetic superseded subject');
    expect((await migrateLegacyState(migrateOptions(repository))).report.status).toBe('migrated');
    await repository.stageGeneration({ generationId: 'gen-later', source: 'subject-import', records: {} });
    await repository.activateGeneration('gen-later');

    const second = await migrateLegacyState(migrateOptions(repository));

    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(false);
    expect(second.report.previousActiveGenerationId).toBe('gen-later');
    expect(await repository.readActiveGenerationId()).toBe('gen-later');
    expect((await repository.readGeneration(MIGRATION_GENERATION_ID))?.descriptor?.status).toBe('superseded');
  });
});

describe('case 6: the report distinguishes a skip from a migration', () => {
  it('a skip never claims an activation, and never names a staged generation', async () => {
    const repository = await device();
    window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');
    expect((await migrateLegacyState(migrateOptions(repository))).report.status).toBe('no-source-data');
    await ensureInitialGeneration(repository, { generationId: INITIAL_GENERATION_ID, now: FIXED_NOW });
    seedLegacySubject('subject-guard-report', 'Guard synthetic report subject');

    const skip = await migrateLegacyState(migrateOptions(repository));

    // The two answers a caller has to be able to tell apart, side by side.
    expect(skip.report.status).toBe('already-migrated');
    expect(skip.report.status).not.toBe('migrated');
    expect(skip.report.activated).toBe(false);
    expect(skip.report.receiptId).toBeNull();
    expect(skip.report.recovery).toBeNull();
    // Counts and checksum describe what a run *wrote*, and this run wrote nothing.
    expect(skip.report.recordCounts.subjects).toBe(0);
    expect(skip.report.contentChecksum).toBeNull();
    // And the reachability guard is not asked to bless it, because it does not
    // claim a migrated generation.
    const observedStatus =
      (await repository.readGeneration(MIGRATION_GENERATION_ID))?.descriptor?.status ?? null;
    expect(() => assertMigrationStatusReachable(skip.report, observedStatus)).not.toThrow();
  });

  it('the state the application renders offers nothing, and renders no notice', async () => {
    const repository = await device();
    window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');
    await migrateLegacyState(migrateOptions(repository));
    await ensureInitialGeneration(repository, { generationId: INITIAL_GENERATION_ID, now: FIXED_NOW });
    seedLegacySubject('subject-guard-state', 'Guard synthetic state subject');

    const skip = await migrateLegacyState(migrateOptions(repository));
    const state = classifyMigrationReport(skip.report);

    // Classified as the same *situation* a `no-source-data` device is in: nothing
    // was staged, the pointer did not move, there is nothing to retry and nothing
    // to tell a learner. The distinction the report carries is not blurred away
    // into `migrated`, which is the claim that would have been false.
    expect(state.kind).toBe('no-source-data');
    expect(state.nextActions).toEqual([]);
    expect(state.activeGenerationFlipped).toBe(false);
    expect(state.stagedGenerationId).toBeNull();
    expect(state.previousActiveGenerationId).toBe(INITIAL_GENERATION_ID);
  });

  it('and a real migration still classifies as migrated, with the notice the surface renders', async () => {
    const repository = await device();
    seedLegacySubject('subject-guard-classify', 'Guard synthetic classify subject');

    const outcome = await migrateLegacyState(migrateOptions(repository));
    const state = classifyMigrationReport(outcome.report);

    expect(outcome.report.status).toBe('migrated');
    expect(state.kind).toBe('migrated');
    expect(state.activeGenerationFlipped).toBe(true);
    expect(state.counts.subjects).toBe(1);
    expect(() =>
      assertMigrationStatusReachable(outcome.report, 'active'),
    ).not.toThrow();
  });
});
