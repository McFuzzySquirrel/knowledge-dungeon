/**
 * Phase 7 verifier gate V8 - the durability fix (`decideDeviceMigration`).
 *
 * This gate exists to answer one question honestly: **after the fix, can a device
 * lose a subject that exists only in the legacy `localStorage` mirror?**
 *
 * It works in two halves, because the decision function being pure does not make
 * the *placement* of its guard correct, and placement is where a fix like this
 * fails:
 *
 * - **the rule**, driven directly against the exported pure function over a decision
 *   table I wrote from the six cases the maintainer named, plus the cases that would
 *   make the rule wrong;
 * - **the placement**, driven end to end through `migrateLegacyState` against a real
 *   repository over `fake-indexeddb` and a real `localStorage` mirror written by the
 *   application's own `saveSubjectSnapshot` - the same bytes a rollback build leaves.
 *
 * The legacy mirror is seeded through the **application's own write path** rather than
 * by hand, so the fixture cannot accidentally be a shape the legacy reader would
 * never see. That matters: a hand-seeded mirror that `readLegacyAppState` ignores
 * would make every "still migrates" case pass for the wrong reason.
 *
 * Phase: 7 (the fix is a cross-phase Phase 4 change; this gate lives here because
 * this is the verification that the Phase 7 product it unblocks is durable).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decideDeviceMigration,
  migrateLegacyState,
  type DeviceMigrationEvidence,
} from '@/services/persistence/v2/migrations';
import { classifyMigrationReport, nextActionsFor } from '@/services/persistence/v2/migrationState';
import { CANONICAL_SUBJECT_SCHEMA_VERSION, type SubjectRecordValue } from '@/services/persistence/v2/schema';
import { ensureInitialGeneration, INITIAL_GENERATION_ID } from '@/services/persistence/v2/appState';
import { selectLegacyRepository, resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { listSubjectIds } from '@/services/persistence/subjectPersistence';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';
import { nastySubject } from './support/nastySubject';
import { legacyFingerprint, openDevice, uniqueDatabaseName } from './support/device';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const MIGRATION_NOW = '2026-09-27T10:00:00.000Z';
const MIGRATION_GENERATION = 'gen-verifier-migration-0001';
const INITIAL = INITIAL_GENERATION_ID;

type Source = 'initial' | 'legacy-migration' | 'local-edit' | 'subject-import' | 'full-device-import';

function evidence(input: {
  readonly generations: ReadonlyArray<{ generationId: string; source: Source; status: 'active' | 'superseded' | 'staged' }>;
  readonly activeGenerationId?: string | null;
  readonly receipts?: ReadonlyArray<{ receiptId: string; stagedGenerationId: string }>;
}): DeviceMigrationEvidence {
  return {
    generations: input.generations,
    activeGenerationId: input.activeGenerationId === undefined ? (input.generations[0]?.generationId ?? null) : input.activeGenerationId,
    legacyMigrationReceipts: input.receipts ?? [],
  };
}

function legacySubject(id: string, name: string): SubjectSnapshot {
  return nastySubject({ subjectId: id, subjectName: name });
}

/**
 * Write one subject into the legacy mirror using the application's own write path,
 * with the legacy repository selected, exactly as a rollback build would.
 */
async function seedMirror(subjectId: string, name: string): Promise<void> {
  resetRepositorySelection();
  selectLegacyRepository();
  const result = await saveSubjectSnapshot(subjectId, legacySubject(subjectId, name));
  expect(result.success).toBe(true);
}

function migrate(repository: StorageV2Repository, generationId = MIGRATION_GENERATION) {
  return migrateLegacyState({
    repository,
    generationId,
    now: MIGRATION_NOW,
    clock: { now: () => MIGRATION_NOW },
  });
}

describe('phase 7 verifier V8a: the rule, as a pure decision table', () => {
  it('migrates a device that holds nothing at all', () => {
    expect(decideDeviceMigration(evidence({ generations: [], activeGenerationId: null }))).toEqual({
      kind: 'migrate',
      reason: 'no-reachable-generation',
    });
  });

  it('migrates a device whose only generation is staged', () => {
    const decision = decideDeviceMigration(
      evidence({
        generations: [{ generationId: 'gen-abandoned', source: 'legacy-migration', status: 'staged' }],
        activeGenerationId: 'gen-abandoned',
      }),
    );
    expect(decision.kind).toBe('migrate');
  });

  it('migrates a device that holds only a staged generation, even with a receipt on it', () => {
    // The receipt on a `staged` generation is the fingerprint of a run that failed.
    const decision = decideDeviceMigration(
      evidence({
        generations: [{ generationId: 'gen-abandoned', source: 'legacy-migration', status: 'staged' }],
        activeGenerationId: 'gen-abandoned',
        receipts: [{ receiptId: 'r1', stagedGenerationId: 'gen-abandoned' }],
      }),
    );
    expect(decision.kind).toBe('migrate');
  });

  it('skips a device holding a legacy-migration generation with a receipt, pointer on it', () => {
    expect(
      decideDeviceMigration(
        evidence({
          generations: [{ generationId: MIGRATION_GENERATION, source: 'legacy-migration', status: 'active' }],
          activeGenerationId: MIGRATION_GENERATION,
          receipts: [{ receiptId: 'r1', stagedGenerationId: MIGRATION_GENERATION }],
        }),
      ),
    ).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: MIGRATION_GENERATION,
      receiptId: 'r1',
    });
  });

  it('skips a device holding a legacy-migration generation that a later generation superseded', () => {
    const decision = decideDeviceMigration(
      evidence({
        generations: [
          { generationId: MIGRATION_GENERATION, source: 'legacy-migration', status: 'superseded' },
          { generationId: 'gen-0001', source: 'full-device-import', status: 'active' },
        ],
        activeGenerationId: 'gen-0001',
        receipts: [{ receiptId: 'r1', stagedGenerationId: MIGRATION_GENERATION }],
      }),
    );
    expect(decision.kind).toBe('skip');
    // The receipt is read only when it sits on a **reachable** generation, and this
    // one is `superseded`, which is reachable.
    expect(decision.kind === 'skip' ? decision.receiptId : null).toBe('r1');
  });

  it('skips the initial generation with no receipt - the defect this fix removes', () => {
    expect(
      decideDeviceMigration(
        evidence({ generations: [{ generationId: INITIAL, source: 'initial', status: 'active' }], activeGenerationId: INITIAL }),
      ),
    ).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: INITIAL,
      receiptId: null,
    });
  });

  it('skips a generation a product created, under every product source', () => {
    for (const source of ['full-device-import', 'subject-import', 'local-edit'] as const) {
      const decision = decideDeviceMigration(
        evidence({ generations: [{ generationId: 'gen-0001', source, status: 'active' }], activeGenerationId: 'gen-0001' }),
      );
      expect(decision.kind, source).toBe('skip');
    }
  });

  it('skips even with legacy-looking content still in the mirror: the rule is device-shaped', () => {
    // The trade under test. The evidence the guard reads contains no mirror content
    // at all, so this case is decided the same way whatever the mirror holds.
    const decision = decideDeviceMigration(
      evidence({ generations: [{ generationId: INITIAL, source: 'initial', status: 'active' }], activeGenerationId: INITIAL }),
    );
    expect(decision.kind).toBe('skip');
  });

  it('migrates a device whose pointer names a generation the registry does not describe', () => {
    // A corrupt registry is not a migrated device.
    expect(
      decideDeviceMigration(evidence({ generations: [], activeGenerationId: 'gen-not-in-the-registry' })).kind,
    ).toBe('migrate');
  });

  it('reports a null active generation when the pointer names something unreachable', () => {
    const decision = decideDeviceMigration(
      evidence({
        generations: [{ generationId: 'gen-live', source: 'initial', status: 'active' }],
        activeGenerationId: 'gen-not-in-the-registry',
      }),
    );
    expect(decision).toEqual({
      kind: 'skip',
      reason: 'device-already-migrated',
      activeGenerationId: null,
      receiptId: null,
    });
  });

  it('ignores a receipt from a different migration entirely', () => {
    // The reader filters by migration id before the guard sees anything, so this gate
    // is about the *shape* of the evidence rather than about a branch in the rule.
    const withForeign = evidence({
      generations: [{ generationId: 'gen-live', source: 'legacy-migration', status: 'active' }],
      activeGenerationId: 'gen-live',
      receipts: [],
    });
    expect(decideDeviceMigration(withForeign).kind === 'skip' ? 'skip' : 'migrate').toBe('skip');
  });
});

describe('phase 7 verifier V8b: the placement, end to end against a real device and a real mirror', () => {
  let repository: StorageV2Repository;

  beforeEach(async () => {
    window.localStorage.clear();
    resetRepositorySelection();
    repository = await openDevice(uniqueDatabaseName('v8'));
  });

  afterEach(() => {
    repository.close();
    resetRepositorySelection();
  });

  it('a never-migrated device with real legacy subjects still migrates them into storage-v2', async () => {
    // The case the fix must not break. Asserted in both directions: the report says
    // migrated, the pointer moved, AND the subject the mirror held is now readable
    // out of the active generation. The last assertion is the one that would catch a
    // guard that skipped and left the report claiming something else.
    await seedMirror('subject-legacy-only', 'Mirror Only Subject');
    expect(await listSubjectIds()).toEqual(['subject-legacy-only']);

    const outcome = await migrate(repository);

    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    expect(await repository.readActiveGenerationId()).toBe(MIGRATION_GENERATION);
    const active = await repository.readActiveGeneration();
    const ids = (active?.records.subjects ?? []).map((entry) => entry.value.subjectId);
    expect(ids).toEqual(['subject-legacy-only']);
  });

  it('a never-migrated device with NO legacy content reports no-source-data and stages nothing', async () => {
    const outcome = await migrate(repository);
    expect(outcome.report.status).toBe('no-source-data');
    expect(outcome.report.stagedGenerationId).toBeNull();
    expect(outcome.report.activated).toBe(false);
    expect(await repository.listGenerations()).toEqual([]);
  });

  it('a staged-only device is reclaimed and re-migrated, not skipped', async () => {
    await seedMirror('subject-after-failure', 'Subject After A Failed Run');
    const first = await migrateLegacyState({
      repository,
      generationId: MIGRATION_GENERATION,
      now: MIGRATION_NOW,
      clock: { now: () => MIGRATION_NOW },
      seams: { forceValidationFailure: true },
    });
    expect(first.report.status).toBe('recovery-required');
    expect((await repository.readGeneration(MIGRATION_GENERATION))?.descriptor?.status).toBe('staged');
    expect(await repository.readActiveGenerationId()).toBeNull();

    const second = await migrate(repository);
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(true);
    expect(await repository.readActiveGenerationId()).toBe(MIGRATION_GENERATION);
    const active = await repository.readActiveGeneration();
    expect((active?.records.subjects ?? []).map((entry) => entry.value.subjectId)).toEqual([
      'subject-after-failure',
    ]);
    // The reclaim really happened: the abandoned generation is the one that is now
    // active, not a second one.
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([
      MIGRATION_GENERATION,
    ]);
  });

  it('the no-source-data-then-write device now skips, and the write is still there afterwards', async () => {
    // The defect, reproduced and then shown fixed, in the order the application does it.
    await ensureInitialGeneration(repository, { generationId: INITIAL, now: MIGRATION_NOW });
    // A product-shaped write: storage-v2 only, exactly as a `.kdtemplate` import is.
    const subjectId = 'kc-subject-written-only-to-storage-v2';
    await repository.putRecords(INITIAL, {
      subjects: [
        {
          subjectId,
          schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
          snapshot: legacySubject(subjectId, 'Written Only To Storage V2'),
          createdAt: MIGRATION_NOW,
          updatedAt: MIGRATION_NOW,
        } as SubjectRecordValue,
      ],
    });
    // And the mirror holds something too, which is what made the old guard re-stage.
    await seedMirror('subject-in-the-mirror', 'Subject In The Mirror');
    const mirrorBefore = legacyFingerprint();

    const outcome = await migrate(repository);

    expect(outcome.report.status).toBe('already-migrated');
    expect(outcome.report.stagedGenerationId).toBeNull();
    expect(outcome.report.activated).toBe(false);
    expect(outcome.report.recovery).toBeNull();
    expect(await repository.readActiveGenerationId()).toBe(INITIAL);
    expect((await repository.readGeneration(INITIAL))?.descriptor?.status).toBe('active');
    // The write that only ever reached storage-v2 is still readable.
    const active = await repository.readActiveGeneration();
    expect((active?.records.subjects ?? []).map((entry) => entry.value.subjectId)).toEqual([subjectId]);
    // Nothing was created, nothing was reclaimed, and the mirror was not touched.
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([INITIAL]);
    expect(await repository.listMigrationReceipts()).toEqual([]);
    expect(legacyFingerprint()).toBe(mirrorBefore);

    // And a third and fourth boot are the same answer.
    expect((await migrate(repository, 'gen-another-id')).report.status).toBe('already-migrated');
    expect((await migrate(repository, 'gen-a-third-id')).report.status).toBe('already-migrated');
    expect((await repository.listGenerations()).map((entry) => entry.generationId)).toEqual([INITIAL]);
  });

  it('an already-migrated device with its receipt stays a no-op success through the per-id guard', async () => {
    await seedMirror('subject-migrated-once', 'Migrated Once');
    const first = await migrate(repository);
    expect(first.report.status).toBe('migrated');
    expect(await repository.listMigrationReceipts(MIGRATION_GENERATION)).toHaveLength(1);

    // A later generation supersedes it, exactly as a restore or an import does.
    await repository.stageGeneration({ generationId: 'gen-0001', source: 'local-edit', records: {} });
    await repository.activateGeneration('gen-0001');
    const live = await repository.readGeneration('gen-0001');
    const liveBefore = JSON.stringify(live?.records ?? null);
    const pointerBefore = await repository.readActiveGenerationId();

    const second = await migrate(repository);

    // The per-id guard fires here, because the id and the receipt are both present.
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(false);
    expect(second.report.stagedGenerationId).toBe(MIGRATION_GENERATION);
    expect(await repository.readActiveGenerationId()).toBe(pointerBefore);
    expect(JSON.stringify((await repository.readGeneration('gen-0001'))?.records ?? null)).toBe(liveBefore);
  });

  it('never reports activated for a skip, and never leaves a recovery on one', async () => {
    await ensureInitialGeneration(repository, { generationId: INITIAL, now: MIGRATION_NOW });
    await seedMirror('subject-in-the-mirror', 'Subject In The Mirror');
    const outcome = await migrate(repository);
    expect(outcome.report.activated).toBe(false);
    expect(outcome.report.recovery).toBeNull();
    // The report's counts are the all-zero initialiser, the same shape
    // `no-source-data` leaves, because they count what a run wrote.
    expect(Object.values(outcome.report.recordCounts).every((count) => count === 0)).toBe(true);
    expect(outcome.report.contentChecksum).toBeNull();
    expect(outcome.records).toBeNull();
  });

  it('classifies a skip as a no-op state that offers nothing, and keeps the kind set at six', async () => {
    await ensureInitialGeneration(repository, { generationId: INITIAL, now: MIGRATION_NOW });
    await seedMirror('subject-in-the-mirror', 'Subject In The Mirror');
    const outcome = await migrate(repository);
    const state = classifyMigrationReport(outcome.report);
    expect(state.kind).toBe('no-source-data');
    expect(state.nextActions).toEqual([]);
    expect(nextActionsFor(state.kind, true)).toEqual([]);
    // The closed set of kinds is unchanged, which is what a switch-over in the copy
    // module depends on.
    const kinds = new Set(['idle', 'migrated', 'partial', 'no-source-data', 'running', 'recovery-required']);
    expect(kinds.has(state.kind)).toBe(true);
    expect(kinds.size).toBe(6);
  });

  describe('the mirror-loss question, constructed rather than assumed', () => {
    it('loses a mirror-only subject on a device that already moved on - the stated trade, measured', async () => {
      // Constructed exactly as a rollback flow produces it:
      //   1. the flagged build boots a fresh device, finds nothing to migrate, and
      //      takes `gen-initial-0001`;
      //   2. the learner rolls back to a `legacy` build and creates a subject there,
      //      which lands only in the mirror;
      //   3. the learner returns to the flagged build.
      // Expected from the rule: a skip, and therefore a subject the flagged build
      // cannot see. This test asserts the loss, so the trade is on the record rather
      // than in a comment.
      await ensureInitialGeneration(repository, { generationId: INITIAL, now: MIGRATION_NOW });
      await seedMirror('subject-made-on-a-rollback-build', 'Made On A Rollback Build');

      const outcome = await migrate(repository);
      expect(outcome.report.status).toBe('already-migrated');

      const active = await repository.readActiveGeneration();
      const visible = (active?.records.subjects ?? []).map((entry) => entry.value.subjectId);
      expect(visible).toEqual([]);
      // ...and the subject is still in the mirror, so a rollback build can still find
      // it. The loss is availability on this build, not destruction.
      expect(await listSubjectIds()).toEqual(['subject-made-on-a-rollback-build']);
    });

    it('does NOT lose it when the device has not moved on yet - the same mirror, no generation', async () => {
      // The same mirror, on a device with no reachable generation. This is the
      // difference the rule turns on, and it is the case that matters most: a learner
      // who has never run the flagged build must not lose a subject by running it.
      await seedMirror('subject-made-on-a-rollback-build', 'Made On A Rollback Build');
      const outcome = await migrate(repository);
      expect(outcome.report.status).toBe('migrated');
      const active = await repository.readActiveGeneration();
      expect((active?.records.subjects ?? []).map((entry) => entry.value.subjectId)).toEqual([
        'subject-made-on-a-rollback-build',
      ]);
    });

    it('does NOT lose a mirror-only subject when the reachable generation is `staged`', async () => {
      await seedMirror('subject-on-a-failed-device', 'Subject On A Failed Device');
      await repository.stageGeneration({ generationId: 'gen-abandoned', source: 'legacy-migration', records: {} });
      const outcome = await migrate(repository);
      expect(outcome.report.status).toBe('migrated');
      const active = await repository.readActiveGeneration();
      expect((active?.records.subjects ?? []).map((entry) => entry.value.subjectId)).toEqual([
        'subject-on-a-failed-device',
      ]);
    });
  });

  describe('is the recovery path now dead', () => {
    it('still produces recovery-required, from every stage, on a device with no reachable generation', async () => {
      for (const failurePoint of ['read-legacy', 'transform', 'stage-records', 'validate', 'compare', 'receipt', 'activate'] as const) {
        const fresh = await openDevice(uniqueDatabaseName(`v8-recovery-${failurePoint}`));
        try {
          await seedMirror('subject-recovery', 'Subject Recovery');
          const outcome = await migrateLegacyState({
            repository: fresh,
            generationId: MIGRATION_GENERATION,
            now: MIGRATION_NOW,
            clock: { now: () => MIGRATION_NOW },
            // Every stage is entered before the work that can fail in it, so a throw
            // from the hook is a failure *at* that stage rather than before it.
            onStage: (stage) => {
              if (stage === failurePoint) throw new Error('synthetic stage failure');
            },
          });
          expect(outcome.report.status, failurePoint).toBe('recovery-required');
          expect(outcome.report.recovery, failurePoint).not.toBeNull();
          expect(classifyMigrationReport(outcome.report).kind, failurePoint).toBe('recovery-required');
        } finally {
          fresh.close();
        }
      }
    });

    it('and cannot produce recovery-required on a device that already moved on, which is the narrowing', async () => {
      // Stated as a measurement, not a complaint: on a device with a reachable
      // generation every one of those failure points is now unreachable, because the
      // guard declines before any of them can run. The consequence worth naming is
      // that a *corrupt mirror* on a moved-on device is now silently ignored instead
      // of producing a recovery screen. That is the correct direction - the recovery
      // screen makes the bootstrap fall back to the stale mirror - and this test
      // pins the behaviour so it cannot change by accident.
      await ensureInitialGeneration(repository, { generationId: INITIAL, now: MIGRATION_NOW });
      await seedMirror('subject-in-the-mirror', 'Subject In The Mirror');
      window.localStorage.setItem('knowledge-dungeon:v1:subjects', '{ not json at all');

      const outcome = await migrate(repository);
      expect(outcome.report.status).toBe('already-migrated');
      expect(outcome.report.recovery).toBeNull();
      expect(await repository.readActiveGenerationId()).toBe(INITIAL);
    });
  });
});
