/**
 * Phase 4: the migration state model the UI renders.
 *
 * The four states a screen has to tell apart are the phase's deliverable, and the
 * two that are easy to conflate are `migrated` and `partial`: a run that carried
 * one fewer attachment than the device held is a *success with a disclosure*, and
 * a screen that renders it as a clean success would be lying about what a backup
 * will contain. This file proves the four are distinguishable, that a failed run
 * leaves legacy authoritative with the pointer unflipped, that a recovery state
 * carries codes and counts only, and that the Phase 3 defects the application now
 * reaches are actually fixed:
 *
 * - a same-`generationId` no-op can no longer report `migrated` for a generation
 *   that is still only `staged`;
 * - `onStage` and `forceValidationFailure` sit behind an injected collaborator
 *   the application entry point cannot supply;
 * - `severity: 'error'` now means what it says, and the policy is declared once;
 * - the staged-generation guard runs in the same transaction as its deletes, and
 *   an abandoned orphan is a concept the repository now has.
 *
 * Privacy: every value is synthetic; the only host is the reserved
 * `example.invalid` and it is never dereferenced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteTestDatabase,
  openTestRepository,
  readSubjectFixture,
  MIGRATION_NOW,
} from './support/storageV2TestSupport';
import {
  MIGRATION_BLOCKING_POLICY,
  assertMigrationStatusReachable,
  buildMigrationPreview,
  classifyMigrationReport,
  isActivationBlocking,
  nextActionsFor,
  partitionMigrationProblems,
  type MigrationState,
} from '@/services/persistence/v2/migrationState';
import {
  MIGRATION_STAGES,
  NO_MIGRATION_SEAMS,
  buildMigratedRecords,
  migrateLegacyState,
  type MigrationSeams,
} from '@/services/persistence/v2/migrations';
import { readLegacyAppState } from '@/services/persistence/v2/legacyReader';
import { countBlockingProblems, type ValidationProblem } from '@/services/persistence/v2/validation';
import { LEGACY_MIGRATION_ID, type MigrationReport } from '@/services/persistence/v2/schema';
import { buildRecordEnvelopes, type StorageV2Repository } from '@/services/persistence/v2/repository';

const GENERATION_ID = 'gen-state-synthetic-0001';
const SUBJECT_ID = 'subject-state-synthetic';
const ROOM_ID = 'room-state-synthetic-root';
const NOW = MIGRATION_NOW;

let databaseName = '';
let repository: StorageV2Repository | null = null;

async function repositoryFor(suffix: string): Promise<StorageV2Repository> {
  databaseName = `kd-phase4-state-${suffix}`;
  repository = await openTestRepository(databaseName, NOW);
  return repository;
}

/**
 * A legacy device with one subject carrying two historical attachments: a
 * `/uploads/` reference whose bytes are not recoverable, and an external link.
 */
function seedLegacyDevice(withAttachments = true): void {
  window.localStorage.clear();
  const subject = JSON.parse(readSubjectFixture('subject-1.1.0-full-unknown-fields.json')) as {
    dungeon: Record<string, unknown>;
    rooms: Record<string, Record<string, unknown>>;
  };
  subject.dungeon.dungeonId = SUBJECT_ID;
  subject.dungeon.subjectName = 'State synthetic subject';
  for (const room of Object.values(subject.rooms)) {
    (room as Record<string, unknown>).attachments = withAttachments
      ? [
        {
          attachmentId: 'att-state-local',
          sourceType: 'local',
          fileName: 'state-synthetic-uploaded.png',
          mimeType: 'image/png',
          relativePath: 'uploads/state-synthetic-uploaded.png',
          addedAt: '2026-01-04T03:04:05.000Z',
        },
        {
          attachmentId: 'att-state-external',
          sourceType: 'external',
          fileName: 'state-synthetic-external.png',
          mimeType: 'image/png',
          externalUrl: 'https://example.invalid/state-synthetic-external.png',
          addedAt: '2026-01-04T03:04:05.000Z',
        },
      ]
      : [];
  }
  window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_ID]));
  window.localStorage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_ID}`, JSON.stringify(subject));
  window.localStorage.setItem(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({ version: 3, bySubject: {}, crossSubjectAchievements: [] }),
  );
}

function snapshotLegacyKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index) as string;
    out[key] = window.localStorage.getItem(key) as string;
  }
  return out;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function migrate(repo: StorageV2Repository, generationId = GENERATION_ID, seams?: MigrationSeams) {
  return migrateLegacyState({
    repository: repo,
    generationId,
    now: NOW,
    clock: { now: () => NOW },
    ...(seams ? { seams } : {}),
  });
}

describe('Phase 4 migration state: preview', () => {
  it('describes what a migration would move, from a read-only legacy read', () => {
    seedLegacyDevice();
    const legacyBefore = snapshotLegacyKeys();
    const state = readLegacyAppState({});
    const preview = buildMigrationPreview(
      state,
      { allowlistedKeys: 22, present: 3, absent: 19, parseErrors: 0, unsupportedShapes: 0 },
      0,
    );

    expect(preview.kind).toBe('preview');
    expect(preview.repository).toBe('v2');
    expect(preview.counts.subjects).toBe(1);
    // Every legacy attachment would become `external-only`, because none of the
    // legacy web build's bytes are recoverable. The seeded subject has two rooms
    // and each carries the two historical attachments.
    expect(preview.externalOnlyAttachments).toBe(4);
    expect(preview.counts.attachmentMetadata).toBe(4);
    expect(preview.counts.attachmentBlobs).toBe(0);
    expect(preview.unreadableSourceRecords).toBe(0);
    expect(preview.stagedGenerationId).toBeNull();
    expect(preview.activeGenerationFlipped).toBe(false);
    expect(preview.blockingPolicy).toBe(MIGRATION_BLOCKING_POLICY);
    // A preview writes nothing.
    expect(snapshotLegacyKeys()).toEqual(legacyBefore);
  });

  it('counts a subject payload it cannot read as a disclosure, not as a subject', () => {
    seedLegacyDevice();
    window.localStorage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_ID}`, '{ not json');
    const state = readLegacyAppState({});
    const preview = buildMigrationPreview(
      state,
      { allowlistedKeys: 22, present: 3, absent: 19, parseErrors: 1, unsupportedShapes: 0 },
      0,
    );
    expect(preview.unreadableSourceRecords).toBe(1);
    expect(preview.counts.subjects).toBe(0);
  });
});

describe('Phase 4 migration state: a clean success', () => {
  it('is `migrated`, not `partial`, when every byte is on the device', async () => {
    seedLegacyDevice(false);
    const repo = await repositoryFor('clean');
    const outcome = await migrate(repo);
    const state = classifyMigrationReport(outcome.report);

    expect(outcome.report.status).toBe('migrated');
    expect(state.kind).toBe('migrated');
    if (state.kind !== 'migrated' && state.kind !== 'partial') throw new Error('unreachable');
    expect(state.hasDisclosure).toBe(false);
    expect(state.externalOnlyAttachments).toBe(0);
    expect(state.externalOnlyReasons).toEqual([]);
    expect(state.activeGenerationFlipped).toBe(true);
    expect(state.stagedGenerationId).toBe(GENERATION_ID);
    expect(state.contentChecksum).toBe(outcome.report.contentChecksum);
    expect(state.receiptId).toBe(outcome.report.receiptId);
    expect(state.counts.subjects).toBe(1);
    expect(state.counts.attachmentMetadata).toBe(0);
    // The pointer really was flipped, and the generation really validates.
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);
    expect((await repo.validateGeneration(GENERATION_ID)).ok).toBe(true);
    assertMigrationStatusReachable(outcome.report, 'active');
  });
});

describe('Phase 4 migration state: a partial outcome is distinguishable from a success', () => {
  it('is `partial` when a report carries external-only attachments', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('partial');
    const outcome = await migrate(repo);
    const state = classifyMigrationReport(outcome.report);

    expect(outcome.report.status).toBe('migrated');
    // The distinguishing assertion: not a clean success.
    expect(state.kind).toBe('partial');
    if (state.kind !== 'migrated' && state.kind !== 'partial') throw new Error('unreachable');
    expect(state.hasDisclosure).toBe(true);
    expect(state.externalOnlyAttachments).toBe(2);
    expect(state.externalOnlyReasons).toEqual(['bytes-not-recoverable', 'historical-external-url']);
    expect(state.activeGenerationFlipped).toBe(true);
    // The data really is there; only the bytes are not.
    expect(state.counts.subjects).toBe(1);
    expect(state.counts.attachmentMetadata).toBe(2);
    expect(state.counts.attachmentBlobs).toBe(0);
  });

  it('reports the partial case as a disclosure, not as a failure', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('partial-severity');
    const outcome = await migrate(repo);
    expect(outcome.report.problems.filter(isActivationBlocking)).toEqual([]);
    expect(countBlockingProblems(outcome.report.problems)).toBe(0);
    expect(classifyMigrationReport(outcome.report).kind).toBe('partial');
  });
});

describe('Phase 4 migration state: recovery-required leaves legacy authoritative', () => {
  it('reports a recovery state, keeps the pointer unflipped, and keeps the legacy bytes', async () => {
    seedLegacyDevice();
    const legacyBefore = snapshotLegacyKeys();
    const repo = await repositoryFor('recovery');
    const outcome = await migrate(repo, GENERATION_ID, {
      onStage: (stage) => {
        if (stage === 'compare') throw new Error('synthetic failure after the stage commit');
      },
    });
    const state = classifyMigrationReport(outcome.report);

    expect(outcome.report.status).toBe('recovery-required');
    expect(state.kind).toBe('recovery-required');
    if (state.kind !== 'recovery-required') throw new Error('unreachable');
    expect(state.recovery).toEqual({ code: 'MIGRATION_FAILED', stage: 'compare' });
    expect(state.legacyAuthoritative).toBe(true);
    expect(state.activeGenerationFlipped).toBe(false);
    expect(state.retryable).toBe(true);
    // The pointer never moved, so nothing reads the half-written generation.
    expect(await repo.readActiveGenerationId()).toBeNull();
    // And the legacy device is byte-for-byte what the migration read.
    expect(snapshotLegacyKeys()).toEqual(legacyBefore);
  });

  it('reports a non-retryable recovery when IndexedDB itself is unavailable', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('recovery-unavailable');
    const { StorageV2Error } = await import('@/services/persistence/v2/schema');
    const outcome = await migrate(repo, GENERATION_ID, {
      onStage: (stage) => {
        if (stage === 'read-legacy') throw new StorageV2Error('INDEXEDDB_UNAVAILABLE', { api: 'indexedDB' });
      },
    });
    const state = classifyMigrationReport(outcome.report);
    expect(state.kind).toBe('recovery-required');
    if (state.kind !== 'recovery-required') throw new Error('unreachable');
    expect(state.recovery.code).toBe('INDEXEDDB_UNAVAILABLE');
    expect(state.retryable).toBe(false);
  });

  it('every recovery state carries a code and a stage and nothing else', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('recovery-sanitized');
    const outcome = await migrate(repo, GENERATION_ID, {
      onStage: (stage) => {
        if (stage === 'activate') throw new Error('phase4-marker-thrown-message');
      },
    });
    const state = classifyMigrationReport(outcome.report);
    if (state.kind !== 'recovery-required') throw new Error('unreachable');
    expect(Object.keys(state.recovery).sort()).toEqual(['code', 'stage']);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('phase4-marker-thrown-message');
    expect(serialized).not.toContain('State synthetic subject');
    expect(serialized).not.toContain('uploads/');
    expect(serialized).not.toContain('example.invalid');
  });

  it('the four states are mutually exclusive for reports that differ only in their outcome', () => {
    const base: MigrationReport = {
      migrationId: LEGACY_MIGRATION_ID,
      status: 'migrated',
      stagedGenerationId: GENERATION_ID,
      activated: true,
      previousActiveGenerationId: null,
      createdAt: NOW,
      legacyKeys: { allowlistedKeys: 22, present: 3, absent: 19, parseErrors: 0, unsupportedShapes: 0 },
      subjectSchemaVersions: { '1.1.0': 1 },
      progressionSourceVersions: { '3': 1 },
      recordCounts: {
        subjects: 1,
        progression: 0,
        sessions: 0,
        preferences: 0,
        shortcuts: 0,
        assistance: 1,
        attachments: 0,
        attachmentBlobs: 0,
        customSprites: 0,
        recovery: 0,
      },
      attachments: { total: 0, storedBytes: 0, externalOnly: 0 },
      externalOnlyAttachments: [],
      problems: [],
      contentChecksum: '0'.repeat(64),
      receiptId: `${GENERATION_ID}-receipt`,
      recovery: null,
    };

    const kindFor = (report: MigrationReport): string => (classifyMigrationReport(report) as MigrationState).kind;
    const clean = kindFor(base);
    const partial = kindFor({
      ...base,
      externalOnlyAttachments: [
        {
          attachmentId: 'att-state-external',
          subjectId: SUBJECT_ID,
          roomId: ROOM_ID,
          contentHash: null,
          byteLength: null,
          reason: 'historical-external-url',
          sourceType: 'external',
        },
      ],
      attachments: { total: 1, storedBytes: 0, externalOnly: 1 },
    });
    const failed = kindFor({
      ...base,
      status: 'recovery-required',
      activated: false,
      recovery: { code: 'MIGRATION_FAILED', stage: 'activate' },
    });
    const empty = kindFor({ ...base, status: 'no-source-data', stagedGenerationId: null, receiptId: null });

    expect([clean, partial, failed, empty]).toEqual([
      'migrated',
      'partial',
      'recovery-required',
      'no-source-data',
    ]);
    expect(new Set([clean, partial, failed, empty]).size).toBe(4);
  });
});

describe('Phase 4 fixed defect: `migrated` never describes an unreachable generation', () => {
  it('re-stages and activates a generation left `staged` by a failed run', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('staged-noop');

    // Fail at activation, which is the exact state the Phase 3 reproduction
    // recorded: a `staged` generation carrying this migration's receipt, which the
    // old short-circuit reported as `migrated` with `activated: false`.
    const failed = await migrate(repo, GENERATION_ID, {
      onStage: (stage) => {
        if (stage === 'activate') throw new Error('synthetic activation failure');
      },
    });
    expect(failed.report.status).toBe('recovery-required');
    expect((await repo.readGeneration(GENERATION_ID))?.descriptor?.status).toBe('staged');
    const receiptsWhileStaged = await repo.listMigrationReceipts(GENERATION_ID);
    expect(receiptsWhileStaged).toHaveLength(1);
    expect(receiptsWhileStaged[0]?.migrationId).toBe(LEGACY_MIGRATION_ID);

    // The retry is not a no-op: the abandoned generation is discarded, migrated
    // again, and activated, so the data is reachable.
    const retry = await migrate(repo, GENERATION_ID);
    expect(retry.report.status).toBe('migrated');
    expect(retry.report.activated).toBe(true);
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);
    expect((await repo.readGeneration(GENERATION_ID))?.descriptor?.status).toBe('active');
    // Exactly one receipt, and the generation validates.
    expect(await repo.listMigrationReceipts(GENERATION_ID)).toHaveLength(1);
    expect((await repo.validateGeneration(GENERATION_ID)).ok).toBe(true);
    assertMigrationStatusReachable(retry.report, 'active');
  });

  it('is still a no-op once the generation is genuinely active', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('active-noop');
    const first = await migrate(repo, GENERATION_ID);
    expect(first.report.activated).toBe(true);
    const before = await repo.readRecords(GENERATION_ID);

    const second = await migrate(repo, GENERATION_ID);
    expect(second.report.status).toBe('migrated');
    expect(second.report.activated).toBe(true);
    expect(await repo.readActiveGenerationId()).toBe(GENERATION_ID);
    expect((await repo.readRecords(GENERATION_ID)).records).toEqual(before.records);
    expect((await repo.listGenerations()).map((entry) => entry.generationId)).toEqual([GENERATION_ID]);
  });

  it('the reachability guard rejects an ambiguous report', () => {
    const report = {
      migrationId: LEGACY_MIGRATION_ID,
      status: 'migrated',
      stagedGenerationId: GENERATION_ID,
      activated: false,
      previousActiveGenerationId: null,
      createdAt: NOW,
      legacyKeys: { allowlistedKeys: 0, present: 0, absent: 0, parseErrors: 0, unsupportedShapes: 0 },
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {
        subjects: 0,
        progression: 0,
        sessions: 0,
        preferences: 0,
        shortcuts: 0,
        assistance: 0,
        attachments: 0,
        attachmentBlobs: 0,
        customSprites: 0,
        recovery: 0,
      },
      attachments: { total: 0, storedBytes: 0, externalOnly: 0 },
      externalOnlyAttachments: [],
      problems: [],
      contentChecksum: null,
      receiptId: null,
      recovery: null,
    } satisfies MigrationReport;

    // The exact Phase 3 defect: `migrated`, not activated, generation still only
    // staged. The guard refuses it.
    expect(() => assertMigrationStatusReachable(report, 'staged')).toThrow(/still only staged/);
    // A superseded generation is the one legitimate `migrated` + not-activated
    // outcome, and the guard accepts it.
    expect(() => assertMigrationStatusReachable(report, 'superseded')).not.toThrow();
    // A migrated report that names no generation is refused too.
    expect(() => assertMigrationStatusReachable({ ...report, stagedGenerationId: null }, null)).toThrow(
      /must name the generation/,
    );
    // And a non-migrated status is never the guard's business.
    expect(() =>
      assertMigrationStatusReachable({ ...report, status: 'recovery-required' }, 'staged'),
    ).not.toThrow();
  });
});

describe('Phase 4 fixed defect: the failure-injection seams are an injected collaborator', () => {
  it('the production value injects nothing, and the stage list is unchanged', () => {
    expect(NO_MIGRATION_SEAMS.onStage).toBeUndefined();
    expect(NO_MIGRATION_SEAMS.forceValidationFailure).toBeUndefined();
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

  it('a production-shaped run is unobstructed', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('no-seam');
    // No `seams`, no flat aliases: the application entry point passes neither, and
    // the run completes through the whole stage sequence.
    const outcome = await migrate(repo);
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.recovery).toBeNull();
  });

  it('a seam is only reachable when a test injects the collaborator', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('seam-injected');
    const seen: string[] = [];
    const outcome = await migrate(repo, GENERATION_ID, {
      onStage: (stage) => {
        seen.push(stage);
      },
    });
    expect(outcome.report.status).toBe('migrated');
    expect(seen).toEqual(MIGRATION_STAGES);
  });
});

describe('Phase 4: the state a screen renders names its own next actions', () => {
  it('offers an action per state, and a retry only where a retry can help', () => {
    expect(nextActionsFor('preview', false)).toEqual(['start-migration']);
    expect(nextActionsFor('running', false)).toEqual([]);
    expect(nextActionsFor('migrated', false)).toEqual([]);
    expect(nextActionsFor('partial', false)).toEqual(['review-disclosures']);
    expect(nextActionsFor('no-source-data', false)).toEqual([]);
    expect(nextActionsFor('recovery-required', true)).toEqual(['retry-migration']);
    // A store that is gone is not something a retry fixes, so offering one there
    // would be a screen telling a learner to press a button that cannot work.
    expect(nextActionsFor('recovery-required', false)).toEqual([]);
  });

  it('a recovery state says the data is intact, because that is not inferable from a code', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('intact');
    const outcome = await migrate(repo, GENERATION_ID, { forceValidationFailure: true });
    const state = classifyMigrationReport(outcome.report);
    if (state.kind !== 'recovery-required') throw new Error('unreachable');
    expect(state.dataIsIntact).toBe(true);
    expect(state.legacyAuthoritative).toBe(true);
    expect(state.activeGenerationFlipped).toBe(false);
    expect(state.nextActions).toEqual(['retry-migration']);
    // And nothing points at the staged generation, so the failed run is invisible
    // to a reader that only follows the pointer.
    expect(await repo.readActiveGenerationId()).toBeNull();
  });

  it('a partial success offers the disclosures, never a retry', async () => {
    const repo = await repositoryFor('partial-actions');
    seedLegacyDevice();
    const outcome = await migrate(repo);
    const state = classifyMigrationReport(outcome.report);
    expect(state.kind === 'partial' || state.kind === 'migrated').toBe(true);
    // Re-running would not recover bytes this device does not hold, so a retry
    // here would be a button that cannot do what it says.
    expect(state.nextActions).toEqual(state.kind === 'partial' ? ['review-disclosures'] : []);
  });
});

describe('Phase 4 fixed defect: severity is the activation rule', () => {
  it('a source record the transform declines to carry is a disclosure, not a refusal', () => {
    window.localStorage.clear();
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-unreadable']));
    window.localStorage.setItem('knowledge-dungeon:v1:subject:subject-unreadable', '{ not json');
    const state = readLegacyAppState({});
    const built = buildMigratedRecords(state, { now: NOW, generationId: GENERATION_ID });

    expect(built.records.subjects).toEqual([]);
    expect(built.problems.length).toBeGreaterThan(0);
    for (const problem of built.problems) {
      expect(problem.severity).toBe('warning');
      expect(isActivationBlocking(problem)).toBe(false);
    }
    const partitioned = partitionMigrationProblems(built.problems);
    expect(partitioned.blocking).toEqual([]);
    expect(partitioned.blockingCount).toBe(0);
    expect(partitioned.disclosedCount).toBeGreaterThan(0);
  });

  it('an activation-blocking run is refused, and the refusal is the whole device', async () => {
    seedLegacyDevice();
    const repo = await repositoryFor('blocking');
    const outcome = await migrate(repo, GENERATION_ID, { forceValidationFailure: true });

    // The name and the rule agree: the run is refused, and it is refused because
    // activation was refused, not for any unrelated reason.
    expect(outcome.report.status).toBe('recovery-required');
    expect(outcome.report.activated).toBe(false);
    expect(await repo.readActiveGenerationId()).toBeNull();
    const state = classifyMigrationReport(outcome.report);
    expect(state.kind).toBe('recovery-required');
    if (state.kind !== 'recovery-required') throw new Error('unreachable');
    expect(state.recovery.code).toBe('VALIDATION_FAILED');
    expect(state.recovery.stage).toBe('validate');
  });

  // Regression: the rule is applied at each site that raises a problem, so one
  // site raising `error` where the policy means `warning` would refuse a whole
  // learner's device over one unreadable record. These are the real raising sites
  // observed through the real reader, not the policy function re-tested.
  it('every site the migration raises a problem discloses rather than blocks', () => {
    window.localStorage.clear();
    window.localStorage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify(['subject-raised']));
    // Unreadable subject payload, unparsable progression, unparsable sessions,
    // unparsable shortcuts, and an attachment whose bytes are unrecoverable: one
    // device that reaches every disclosure site at once.
    window.localStorage.setItem('knowledge-dungeon:v1:subject:subject-raised', '{ not json');
    window.localStorage.setItem('knowledge-dungeon:v1:progression', '{ not json');
    window.localStorage.setItem('knowledge-dungeon:v1:sessions', '{ not json');
    window.localStorage.setItem('knowledge-dungeon:v1:shortcuts', '{ not json');
    const state = readLegacyAppState({});
    const built = buildMigratedRecords(state, { now: NOW, generationId: GENERATION_ID });

    // Non-vacuous: the device really did reach several distinct sites.
    expect(new Set(built.problems.map((problem) => `${problem.scope}/${problem.code}`)).size).toBeGreaterThan(2);
    for (const problem of built.problems) {
      expect(problem.severity, `${problem.scope}/${problem.code}`).toBe('warning');
      expect(isActivationBlocking(problem), `${problem.scope}/${problem.code}`).toBe(false);
    }
    expect(countBlockingProblems(built.problems)).toBe(0);
  });

  it('an `error` problem is the only thing that blocks, whatever raised it', () => {
    const raised: ValidationProblem[] = [
      { code: 'dangling-edge', scope: 'relationship', count: 1, severity: 'error' },
      { code: 'count-mismatch', scope: 'generation', count: 1, severity: 'error' },
    ];
    expect(countBlockingProblems(raised)).toBe(2);
    for (const problem of raised) expect(isActivationBlocking(problem)).toBe(true);
  });

  it('the policy is declared once and says what the two severities mean', () => {
    expect(MIGRATION_BLOCKING_POLICY).toBe('error-blocks-warning-discloses');
    const problems: ValidationProblem[] = [
      { code: 'dangling-edge', scope: 'relationship', count: 2, severity: 'error' },
      { code: 'unknown-subject-reference', scope: 'relationship', count: 3, severity: 'warning' },
      { code: 'not-an-object', scope: 'subject', count: 1, severity: 'warning' },
    ];
    const partitioned = partitionMigrationProblems(problems);
    expect(partitioned.blocking).toEqual([problems[0]]);
    expect(partitioned.disclosed).toEqual([problems[1], problems[2]]);
    expect(partitioned.blockingCount).toBe(2);
    expect(partitioned.disclosedCount).toBe(4);
  });
});

describe('Phase 4 fixed defect: the staged-generation guard is atomic with its deletes', () => {
  it('an orphan record set with no descriptor is reclaimed, and a live generation is not', async () => {
    const repo = await repositoryFor('orphans');
    // A live generation first, so the "kept" case has something to keep.
    await repo.stageGeneration({ generationId: 'gen-live', source: 'initial', records: {} });
    await repo.activateGeneration('gen-live');

    // Orphans: records written under an id no registry entry describes. This is
    // what a run interrupted between its data write and its descriptor write
    // leaves behind, and `stageGeneration` would otherwise upsert on top of them.
    const { CANONICAL_SUBJECT_SCHEMA_VERSION } = await import('@/services/persistence/v2/schema');
    const envelopes = buildRecordEnvelopes(
      'gen-orphan',
      {
        subjects: [
          {
            subjectId: 'subject-orphan',
            schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
            snapshot: JSON.parse(readSubjectFixture('subject-1.1.0-minimal.json')) as never,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
      NOW,
    );
    const handle = (repo as unknown as { db: IDBDatabase }).db;
    const transaction = handle.transaction('subjects', 'readwrite');
    transaction.objectStore('subjects').put(envelopes.subjects[0] as never);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    expect((await repo.readRecords('gen-orphan')).records.subjects).toHaveLength(1);

    // A registry entry the pointer owns is never reclaimed.
    expect(await repo.discardAbandonedGeneration('gen-live')).toBe('retained-live-generation');
    expect((await repo.readRecords('gen-live')).descriptor).not.toBeNull();

    // The orphan is.
    expect(await repo.discardAbandonedGeneration('gen-orphan')).toBe('removed-orphan-records');
    expect((await repo.readRecords('gen-orphan')).records.subjects).toEqual([]);
    // And a second attempt is a no-op, not a second delete.
    expect(await repo.discardAbandonedGeneration('gen-orphan')).toBe('nothing-to-discard');
    expect(await repo.discardAbandonedGeneration('gen-never-existed')).toBe('nothing-to-discard');
  });

  it('a refused discard leaves every record of the live generation intact', async () => {
    const repo = await repositoryFor('discard-refused');
    await repo.stageGeneration({ generationId: 'gen-live', source: 'initial', records: {} });
    await repo.activateGeneration('gen-live');
    await repo.stageGeneration({ generationId: 'gen-staged', source: 'local-edit', records: {} });

    await expect(repo.discardStagedGeneration('gen-live')).rejects.toMatchObject({
      code: 'GENERATION_NOT_STAGGED',
    });
    expect((await repo.readGeneration('gen-live'))?.descriptor?.status).toBe('active');
    expect((await repo.readGeneration('gen-staged'))?.descriptor?.status).toBe('staged');
    // ...and the genuinely staged one is still discardable.
    expect(await repo.discardStagedGeneration('gen-staged')).toBe(true);
    expect(await repo.readGeneration('gen-staged')).toBeNull();
  });
});
