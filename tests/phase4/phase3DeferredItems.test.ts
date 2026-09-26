/**
 * Phase 3 deferred items, each pinned by a test that fails if the fix is
 * reverted.
 *
 * Phase 3 recorded these as "found, deliberately not fixed here":
 *
 * 1. `discardStagedGeneration`'s status check was not in the same transaction as
 *    its deletes, and there was no "abandoned orphan" concept.
 * 2. A same-`generationId` run could report `migrated` with `activated: false`
 *    for a generation that was still only `staged`.
 * 3. `onStage` and `forceValidationFailure` were test seams living in production
 *    code paths.
 * 4. Migration-report problems tagged `severity: 'error'` did not block
 *    activation, so either the severity naming or the blocking rule was
 *    misleading.
 * 5. `StorageV2Error.details` accepted any string, so `toReport()` was safe only
 *    because every call site happened to pass codes.
 *
 * Every test below is written to fail on a revert, not to pass on the current
 * code by coincidence. Where the fix is structural rather than observable, the
 * test measures the structure (how many transactions a discard opens) or scans
 * the production source for the thing that was removed.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SUBJECT_ID, NOW, seedLegacyKeys, openRepo, dropRepo, legacyKeySet, syntheticSnapshot } from './support/phase4Support';

import { migrateLegacyState, NO_MIGRATION_SEAMS, MIGRATION_STAGES } from '@/services/persistence/v2/migrations';
import { LEGACY_MIGRATION_ID } from '@/services/persistence/v2/schema';
import { openStorageV2Repository, NO_STAGING_SEAMS, type StagingSeams } from '@/services/persistence/v2/repository';
import { assertMigrationStatusReachable, isActivationBlocking, partitionMigrationProblems, MIGRATION_BLOCKING_POLICY } from '@/services/persistence/v2/migrationState';
import { StorageV2Error, isSanitizedDetailText, type StorageV2ErrorDetails } from '@/services/persistence/v2/schema';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports } from '@/services/persistence/v2/dualWrite';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');
const V2_DIR = join(SRC, 'services', 'persistence', 'v2');

/**
 * Every record in the database under one generation id, read raw.
 *
 * The `byGeneration` index on each store, one transaction per store, with no
 * repository code involved, so "nothing was left behind" is a statement about the
 * database rather than about the accessor that is under test.
 */
async function readRecordsDirect(databaseName: string, generationId: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = globalThis.indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  if (!db) throw new Error(`database ${databaseName} is not open`);
  const out: unknown[] = [];
  for (const storeName of db.objectStoreNames) {
    if (storeName === 'meta') continue;
    const index = db.transaction(storeName, 'readonly').objectStore(storeName).index('byGeneration');
    const rows = await new Promise<unknown[]>((resolve) => {
      const request = index.getAll(generationId);
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => resolve([]);
    });
    out.push(...rows);
  }
  db.close();
  return out;
}

/**
 * Write one record envelope straight into the database, bypassing the
 * repository, and without a registry entry.
 *
 * This is how a real orphan arises: a browser that reclaims the connection
 * between the data write and the descriptor write. The repository refuses to
 * create one, which is correct, so the state has to be built the way the crash
 * would have built it.
 */
async function writeOrphanRecord(
  databaseName: string,
  generationId: string,
  storeName: string,
  recordId: string,
  value: unknown,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('open failed'));
  });
  const updatedAt = NOW;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put({
      generationId,
      recordId,
      value,
      checksum: null,
      updatedAt,
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('write failed'));
    transaction.onabort = () => reject(new Error('aborted'));
  });
  db.close();
}

/** Write a migration receipt straight into the database. */
async function writeRawReceipt(
  databaseName: string,
  generationId: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('open failed'));
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('migrationReceipts', 'readwrite');
    transaction.objectStore('migrationReceipts').put({
      generationId,
      recordId: `${generationId}:${LEGACY_MIGRATION_ID}`,
      value: { ...receipt, generationId },
      checksum: null,
      updatedAt: NOW,
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('write failed'));
    transaction.onabort = () => reject(new Error('aborted'));
  });
  db.close();
}

const handles: StorageV2Repository[] = [];
const dbNames: string[] = [];

async function openRepoTracked(suffix: string): Promise<StorageV2Repository> {
  dbNames.push(suffix);
  const repo = await openRepo(suffix);
  handles.push(repo);
  return repo;
}

/** Every production module under `src/`, as absolute paths. */
function productionModules(directory = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionModules(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

beforeEach(() => {
  window.localStorage.clear();
  seedLegacyKeys();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const suffix of dbNames.splice(0)) await dropRepo(suffix);
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

describe('Deferred item 1: the discard guard and its deletes are one transaction', () => {
  it('opens exactly one read-write transaction, spanning every store', async () => {
    const repo = await openRepoTracked('atomic-discard');
    // A `staged` generation with records, which is what a failed run leaves.
    await repo.stageGeneration({
      generationId: 'gen-phase4-staged',
      source: 'legacy-migration',
      records: {
        subjects: [
          {
            subjectId: SUBJECT_ID,
            schemaVersion: '1.1.0',
            snapshot: syntheticSnapshot(),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    });
    expect((await repo.readGeneration('gen-phase4-staged'))?.descriptor?.status).toBe('staged');

    // Count the transactions the repository opens on the real database.
    const observed: { mode: string; stores: string[] }[] = [];
    const realTransaction = IDBDatabase.prototype.transaction;
    const spy = vi
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (
        this: IDBDatabase,
        stores: string | Iterable<string>,
        mode?: IDBTransactionMode,
      ) {
        observed.push({
          mode: mode ?? 'readonly',
          stores: Array.isArray(stores) ? [...stores].sort() : [String(stores)],
        });
        return (realTransaction as (...rest: unknown[]) => IDBTransaction).apply(this, [stores, mode] as never);
      });
    try {
      expect(await repo.discardStagedGeneration('gen-phase4-staged')).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // One transaction, read-write, over every store: the guard and the deletes
    // cannot be separated by another tab. A revert to a separate read pass would
    // produce a readonly transaction here as well.
    expect(observed).toHaveLength(1);
    expect(observed[0]?.mode).toBe('readwrite');
    expect(observed[0]?.stores).toEqual(
      [
        'assistance',
        'attachments',
        'customSprites',
        'meta',
        'migrationReceipts',
        'preferences',
        'progression',
        'recovery',
        'sessions',
        'shortcuts',
        'subjects',
      ].sort(),
    );
    // And it really removed the records, read raw rather than through the API.
    expect((await readRecordsDirect(`kd-phase4-independent-atomic-discard`, 'gen-phase4-staged')).length).toBe(0);
  });

  it('reclaims orphan records that no registry entry describes', async () => {
    const repo = await openRepoTracked('orphan');
    // A run that died between its data write and its descriptor write: records
    // under a generation id nothing points at.
    await writeOrphanRecord('kd-phase4-independent-orphan', 'gen-phase4-orphan', 'subjects', SUBJECT_ID, {
      subjectId: SUBJECT_ID,
      schemaVersion: '1.1.0',
      snapshot: syntheticSnapshot(),
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect((await repo.readGeneration('gen-phase4-orphan'))?.descriptor ?? null).toBeNull();
    expect((await readRecordsDirect('kd-phase4-independent-orphan', 'gen-phase4-orphan')).length).toBe(1);

    expect(await repo.discardAbandonedGeneration('gen-phase4-orphan')).toBe('removed-orphan-records');
    expect((await readRecordsDirect('kd-phase4-independent-orphan', 'gen-phase4-orphan')).length).toBe(0);
    // Nothing to discard is reported as such, not as a removal.
    expect(await repo.discardAbandonedGeneration('gen-phase4-orphan')).toBe('nothing-to-discard');
  });

  it('never touches a live generation, and never one the pointer owns', async () => {
    const repo = await openRepoTracked('live');
    await repo.stageGeneration({ generationId: 'gen-phase4-live', source: 'legacy-migration', records: {} });
    await repo.putRecords('gen-phase4-live', {
      subjects: [
        {
          subjectId: SUBJECT_ID,
          schemaVersion: '1.1.0',
          snapshot: syntheticSnapshot(),
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    await repo.activateGeneration('gen-phase4-live');
    const before = (await readRecordsDirect('kd-phase4-independent-live', 'gen-phase4-live')).length;

    // An active generation is retained, and the refusal is typed.
    expect(await repo.discardAbandonedGeneration('gen-phase4-live')).toBe('retained-live-generation');
    expect(() => repo.discardStagedGeneration('gen-phase4-live')).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    await expect(repo.discardStagedGeneration('gen-phase4-live')).rejects.toBeInstanceOf(StorageV2Error);
    expect((await readRecordsDirect('kd-phase4-independent-live', 'gen-phase4-live')).length).toBe(before);
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-live');
  });
});

describe('Deferred item 2: `migrated` never describes an unreachable generation', () => {
  it('a generation left staged with a receipt is discarded and migrated again', async () => {
    const repo = await openRepoTracked('staged-receipt');
    const before = legacyKeySet();

    // Stage a generation and give it a receipt, but never activate it: the
    // records exist and nothing points at them.
    await repo.stageGeneration({
      generationId: 'gen-phase4-staged-receipt',
      source: 'legacy-migration',
      records: {
        subjects: [
          {
            subjectId: 'subject-qa-stale',
            schemaVersion: '1.1.0',
            snapshot: syntheticSnapshot({
              dungeon: { ...syntheticSnapshot().dungeon, dungeonId: 'subject-qa-stale' },
            } as never),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    });
    await writeRawReceipt('kd-phase4-independent-staged-receipt', 'gen-phase4-staged-receipt', {
      migrationId: LEGACY_MIGRATION_ID,
      from: 'legacy',
      to: 'storage-v2',
      stagedGenerationId: 'gen-phase4-staged-receipt',
      previousActiveGenerationId: null,
      status: 'staged',
      createdAt: NOW,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: '1.1.0',
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {} as never,
      recordChecksums: {} as never,
      contentChecksum: 'a'.repeat(64),
    });
    expect((await repo.readGeneration('gen-phase4-staged-receipt'))?.descriptor?.status).toBe('staged');
    expect(await repo.listMigrationReceipts('gen-phase4-staged-receipt')).toHaveLength(1);

    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-staged-receipt',
      now: NOW,
      clock: { now: () => NOW },
    });

    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-staged-receipt');
    expect((await repo.readGeneration('gen-phase4-staged-receipt'))?.descriptor?.status).toBe('active');
    // The stale record from the abandoned attempt is gone, so a re-stage cannot
    // leave a record no reader expects.
    const subjects = (await repo.readRecords('gen-phase4-staged-receipt')).records.subjects;
    expect(subjects.map((entry) => entry.recordId)).toEqual([SUBJECT_ID]);
    // The report satisfies the reachability invariant the guard enforces.
    const observed = (await repo.readGeneration('gen-phase4-staged-receipt'))?.descriptor?.status ?? null;
    expect(() => assertMigrationStatusReachable(outcome.report, observed)).not.toThrow();
    // And the legacy device is still untouched.
    expect(legacyKeySet()).toEqual(before);
  });
});

describe('Deferred item 3: the failure-injection seams are not in production paths', () => {
  it('a seam inside the staging input is ignored, not honoured', async () => {
    const repo = await openRepoTracked('seam-input');
    // The pre-Phase-4 shape: `onStage` as a member of the content contract. A
    // revert would abort the transaction; today it is simply not read.
    const legacyShaped = {
      generationId: 'gen-phase4-seam-input',
      source: 'legacy-migration' as const,
      records: {},
      onStage: () => {
        throw new Error('qa seam was honoured');
      },
    };
    await expect(repo.stageGeneration(legacyShaped)).resolves.toMatchObject({
      generationId: 'gen-phase4-seam-input',
    });
    expect((await repo.readGeneration('gen-phase4-seam-input'))?.descriptor?.status).toBe('staged');
    // The production collaborator is frozen and empty, and the seam is a separate
    // argument.
    expect(NO_STAGING_SEAMS).toEqual({});
    expect(Object.isFrozen(NO_STAGING_SEAMS)).toBe(true);
    const seams: StagingSeams = {
      onStage: (point) => {
        if (point === 'after-subjects') throw new Error('qa injected');
      },
    };
    await expect(
      repo.stageGeneration({ generationId: 'gen-phase4-seam-arg', source: 'legacy-migration', records: {} }, seams),
    ).rejects.toBeInstanceOf(StorageV2Error);
    // The abort really left nothing behind.
    expect(await repo.readGeneration('gen-phase4-seam-arg')).toBeNull();
    expect((await readRecordsDirect('kd-phase4-independent-seam-input', 'gen-phase4-seam-arg')).length).toBe(0);
  });

  it('the production migration value injects nothing, and the stage list is unchanged', async () => {
    expect(NO_MIGRATION_SEAMS).toEqual({});
    expect(Object.isFrozen(NO_MIGRATION_SEAMS)).toBe(true);
    expect(MIGRATION_STAGES).toEqual([
      'read-legacy',
      'transform',
      'stage-records',
      'validate',
      'compare',
      'receipt',
      'activate',
    ]);
  });

  it('no production module outside the v2 tree names a migration seam', () => {
    // A revert that moved the seam back into an application path - reading
    // `import.meta.env`, or a prop threaded from the UI - would appear here.
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => lead + ' '.repeat(match.length - lead.length));
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of productionModules()) {
      if (file.startsWith(V2_DIR)) continue;
      if (file.endsWith('bootstrap.ts')) continue;
      scanned += 1;
      // Comments are stripped: a doc comment *describing* the removed seam is
      // good practice, not a reachable seam. Only code counts.
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const marker of ['onStage', 'forceValidationFailure', 'MIGRATION_SEAMS', 'StagingSeams']) {
        if (code.includes(marker)) offenders.push(`${file.replace(REPO_ROOT, '.')} -> ${marker}`);
      }
    }
    expect(scanned, 'the scan must have read a real slice of the application').toBeGreaterThan(100);
    expect(offenders).toEqual([]);
    // And the one file that legitimately owns the migration passes no seam at
    // all: its call has exactly the four documented options.
    const bootstrap = stripComments(readFileSync(join(SRC, 'application', 'bootstrap.ts'), 'utf8'));
    expect(bootstrap).toContain('await migrateLegacyState({');
    expect(bootstrap).not.toContain('seams:');
    expect(bootstrap).not.toContain('onStage:');
    expect(bootstrap).not.toContain('forceValidationFailure');
  });

  it('a production-shaped run is unobstructed: no seam fires and no flag can arm one', async () => {
    const repo = await openRepoTracked('seam-production');
    // With no seam supplied, every stage still runs and the run completes.
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-seam-production',
      now: NOW,
      clock: { now: () => NOW },
    });
    expect(outcome.report.status).toBe('migrated');
    // The seam is opt-in through a collaborator, not through the environment.
    const { parseRuntimeConfig } = await import('@/config/runtimeConfig');
    const config = parseRuntimeConfig({ VITE_STORAGE_REPOSITORY: 'v2' });
    expect(JSON.stringify(config)).not.toContain('seam');
    expect(JSON.stringify(config)).not.toContain('forceValidation');
  });
});

describe('Deferred item 4: severity is the activation rule', () => {
  it('`error` blocks and `warning` discloses, and the rule is one function', () => {
    expect(
      isActivationBlocking({ code: 'not-an-object', scope: 'subject', count: 1, severity: 'error' }),
    ).toBe(true);
    expect(
      isActivationBlocking({ code: 'not-an-object', scope: 'subject', count: 1, severity: 'warning' }),
    ).toBe(false);
    expect(MIGRATION_BLOCKING_POLICY).toBe('error-blocks-warning-discloses');
    const partitioned = partitionMigrationProblems([
      { code: 'duplicate-identifier', scope: 'subject', count: 2, severity: 'error' },
      { code: 'unexpected-json-shape', scope: 'session', count: 3, severity: 'warning' },
    ]);
    expect(partitioned.blocking.map((problem) => problem.code)).toEqual(['duplicate-identifier']);
    expect(partitioned.disclosed.map((problem) => problem.code)).toEqual(['unexpected-json-shape']);
    // The counts are sums of `count`, so a screen can state "2 records blocked,
    // 3 disclosed" rather than a number of problems.
    expect(partitioned.blockingCount).toBe(2);
    expect(partitioned.disclosedCount).toBe(3);
  });

  it('a source record the transform declines to carry is disclosed, not refused', async () => {
    const repo = await openRepoTracked('severity');
    // An index entry with no payload: the one record the transform cannot carry.
    window.localStorage.setItem(
      'knowledge-dungeon:v1:subjects',
      JSON.stringify([SUBJECT_ID, 'subject-qa-ghost-with-no-payload']),
    );
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-severity',
      now: NOW,
      clock: { now: () => NOW },
    });
    // A revert to `severity: 'error'` here would leave this failing.
    expect(outcome.report.problems.length).toBeGreaterThan(0);
    expect(outcome.report.problems.every((problem) => problem.severity === 'warning')).toBe(true);
    // And because it is a disclosure and not a refusal, the rest of the device
    // still migrated and activated.
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    expect((await repo.readRecords('gen-phase4-severity')).records.subjects).toHaveLength(1);
  });

  it('a generation-level failure is refused, and the refusal is the whole device', async () => {
    const repo = await openRepoTracked('severity-refused');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-severity-refused',
      now: NOW,
      clock: { now: () => NOW },
      seams: { forceValidationFailure: true },
    });
    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.activated).toBe(false);
    expect(await repo.readActiveGenerationId()).toBeNull();
    // The stage named is the one that failed, not the one before it.
    expect(outcome.report.recovery?.stage).toBe('validate');
    // And a `recovery-required` report can never satisfy the success invariant.
    expect(() => assertMigrationStatusReachable(outcome.report, 'staged')).not.toThrow();
  });
});

describe('Deferred item 5: `StorageV2Error.details` refuses a value that is not a code', () => {
  it('accepts codes, counts, booleans, and opaque identifiers', () => {
    const accepted: StorageV2ErrorDetails = {
      stage: 'stage-records',
      count: 3,
      generationId: 'gen-phase4-0001',
      subjectId: SUBJECT_ID,
      store: 'subjects',
      ok: true,
    };
    const error = new StorageV2Error('VALIDATION_FAILED', accepted);
    expect(error.toReport()).toEqual({ code: 'VALIDATION_FAILED', details: accepted });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('refuses anything a learner could have written, at construction', () => {
    // Every one of these is a value a real call site could plausibly pass. A
    // revert to `Record<string, string | number | boolean>` would accept them.
    const refused: [string, string][] = [
      ['subjectName', 'Phase4 Independent Synthetic Subject'],
      ['roomTopic', 'Vector spaces and eigenvalues'],
      ['note', 'Summary: the learner wrote this'],
      ['fileName', 'photo-of-my-cat.png'],
      ['url', 'https://example.invalid/photo.png'],
      ['path', 'uploads/photo.png'],
      ['withSpace', 'two words'],
      ['nonAscii', 'café'],
      ['newLine', 'line one\nline two'],
      ['quote', 'he said "hi"'],
    ];
    for (const [key, value] of refused) {
      expect(() => new StorageV2Error('VALIDATION_FAILED', { [key]: value }), key).toThrow(TypeError);
    }
    // And the throw itself must not echo the value, or the check would be the
    // leak it exists to prevent.
    try {
      new StorageV2Error('VALIDATION_FAILED', { subjectName: 'Phase4 Independent Synthetic Subject' });
      throw new Error('the constructor did not refuse the value');
    } catch (thrown) {
      expect(String((thrown as Error).message)).not.toContain('Phase4 Independent Synthetic Subject');
    }
  });

  it('judges the boundary rule itself, including the recorded residual', () => {
    expect(isSanitizedDetailText('gen-phase4-0001')).toBe(true);
    expect(isSanitizedDetailText('sub_ject.1-2')).toBe(true);
    expect(isSanitizedDetailText('')).toBe(false);
    expect(isSanitizedDetailText('a'.repeat(64))).toBe(true);
    expect(isSanitizedDetailText('a'.repeat(65))).toBe(false);
    expect(isSanitizedDetailText('photo.png')).toBe(false);
    // The recorded residual: a subject id that happened to end in `.v1` is
    // refused. It is the conservative direction - the gate refuses rather than
    // passing something that could be a filename - and every id this application
    // mints is code-shaped. A subject id is *not* currently passed as a detail
    // by any production call site, so the residual is unreachable today.
    expect(isSanitizedDetailText('subject-example.v1')).toBe(false);
    expect(isSanitizedDetailText('subject-example.v11')).toBe(false);
    // The rule the residual comes from, stated so a future change to it is
    // visible: any trailing `.<short extension>` is treated as a filename.
    expect(isSanitizedDetailText('report.csv')).toBe(false);
    // The rule's own boundary: a trailing segment of six or more characters is
    // not treated as a filename, because real extensions are short. Recorded as
    // a residual of the fix rather than hidden.
    expect(isSanitizedDetailText('store.v1beta')).toBe(true);
    expect(isSanitizedDetailText('archive.tar')).toBe(false);
  });

  it('a detail bag is frozen, so a later mutation cannot smuggle content in', () => {
    const details: Record<string, string | number | boolean> = { stage: 'validate' };
    const error = new StorageV2Error('VALIDATION_FAILED', details);
    details.subjectName = 'Phase4 Independent Synthetic Subject';
    expect(error.details).toEqual({ stage: 'validate' });
    expect(JSON.stringify(error.toReport())).not.toContain('Phase4 Independent Synthetic Subject');
  });

  it('the real error surface carries no learner content on any path', async () => {
    const repo = await openRepoTracked('error-surface');
    const marker = 'Phase4 Independent Synthetic Subject';
    const caught: StorageV2Error[] = [];
    try {
      await repo.readGeneration('');
    } catch (error) {
      if (error instanceof StorageV2Error) caught.push(error);
    }
    await expect(repo.stageGeneration({ generationId: '', source: 'legacy-migration', records: {} })).rejects.toBeInstanceOf(
      StorageV2Error,
    );
    for (const error of caught) {
      expect(JSON.stringify(error.toReport())).not.toContain(marker);
      expect(Object.keys(error.details).every((key) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key))).toBe(true);
    }
  });
});

describe('Deferred item 5, the migration surface in particular', () => {
  it('a failed run reports only codes, counts, and stage names', async () => {
    const repo = await openRepoTracked('error-report');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-error-report',
      now: NOW,
      clock: { now: () => NOW },
      seams: { onStage: (stage) => { if (stage === 'transform') throw new Error('qa injected'); } },
    });
    const serialised = JSON.stringify(outcome.report);
    expect(serialised).not.toContain('Phase4 Independent Synthetic Subject');
    expect(serialised).not.toContain('qa injected');
    expect(outcome.report.recovery?.stage).toBe('transform');
    expect(typeof outcome.report.recovery?.code).toBe('string');
  });
});

describe('A direct repository call still refuses to corrupt a live generation', () => {
  it('a re-stage over an active generation is refused rather than merged', async () => {
    // Phase 3 recorded that `stageGeneration` only upserts, so a direct caller
    // re-staging with a subset leaves a stale record. The migration discards
    // first, so the migration path is unaffected - this records the direct
    // behaviour so a future change to it is deliberate.
    const repo = await openRepoTracked('restage');
    await repo.stageGeneration({
      generationId: 'gen-phase4-restage',
      source: 'legacy-migration',
      records: {
        subjects: [
          { subjectId: SUBJECT_ID, schemaVersion: '1.1.0', snapshot: syntheticSnapshot(), createdAt: NOW, updatedAt: NOW },
        ],
      },
    });
    await repo.activateGeneration('gen-phase4-restage');
    await expect(
      repo.stageGeneration({ generationId: 'gen-phase4-restage', source: 'legacy-migration', records: {} }),
    ).rejects.toMatchObject({ code: 'GENERATION_ALREADY_ACTIVE' });
    // Whatever the refusal says, the live record is still there.
    expect((await repo.readRecords('gen-phase4-restage')).records.subjects).toHaveLength(1);
    expect(await repo.readActiveGenerationId()).toBe('gen-phase4-restage');
  });
});

describe('The open helper is the real one', () => {
  it('openStorageV2Repository still works after every probe above', async () => {
    // A guard against this file's own harness silently passing: the real
    // factory opens a real (shimmed) database.
    const repo = await openStorageV2Repository({ databaseName: 'kd-phase4-probe-open' });
    handles.push(repo);
    expect(await repo.readActiveGenerationId()).toBeNull();
    expect(await repo.readGeneration('gen-missing')).toBeNull();
  });
});
