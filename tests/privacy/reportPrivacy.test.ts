/**
 * Phase 4 privacy gate, test 4: no learner data in privacy-adjacent reports.
 *
 * A report is the one surface a learner is most likely to paste into a bug
 * report, a console log, or a CI artifact, so every report, receipt, descriptor,
 * and error projection the storage-v2 and application layers produce must carry
 * codes, counts, version identifiers, opaque ids, and checksums only.
 *
 * The method follows the Phase 3 QA approach: one distinctive synthetic marker
 * is planted in every learner-content field at once, and every sanitized surface
 * is then required to be free of it. Two properties keep this from being
 * vacuous:
 *
 * - Each surface is asserted by its **exact key set**, so a surface cannot pass
 *   by being empty, and a new learner-content field fails the test by name.
 * - The marker is planted in a subject that really is migrated, and the
 *   migration really does produce a report, external-only disclosures,
 *   validation problems, a receipt, and a descriptor. Zero surfaces would make
 *   the absence assertions meaningless, so their non-emptiness is asserted too.
 *
 * What is deliberately NOT asserted: `AttachmentMetadataRecordValue` carries
 * `fileName` and `altText` on purpose, because the application has to be able to
 * render the attachment the learner already has. A record is learner data by
 * design; a *report* is not. This file only constrains the report surfaces.
 *
 * Privacy: the marker is synthetic, self-describing, and not a real subject. No
 * learner data exists in this file, and the only host mentioned is the reserved
 * `example.invalid`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedClock } from '@/services/persistence/v2/database';
import {
  buildMigratedRecords,
  migrateLegacyState,
} from '@/services/persistence/v2/migrations';
import { readLegacyAppState } from '@/services/persistence/v2/legacyReader';
import {
  countGenerationRecords,
  emptyGenerationRecords,
  validateGenerationRecords,
  type GenerationRecords,
} from '@/services/persistence/v2/validation';
import {
  StorageV2Error,
  type GenerationDescriptor,
  type MigrationReceiptValue,
  type ProgressionRecordValue,
} from '@/services/persistence/v2/schema';
import {
  deleteTestDatabase,
  openTestRepository,
  readSubjectFixture,
  MIGRATION_NOW,
} from '../migrations/support/storageV2TestSupport';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const NOW = MIGRATION_NOW;
const GENERATION_ID = 'gen-privacy-report-0001';
const SUBJECT_ID = 'subject-privacy-marker';

/** One marker, planted in every learner-content field at once. */
const MARKER = 'PRIVACY-MARKER-synthetic-7c41d0-not-real-content';
const EXTERNAL_URL = 'https://example.invalid/privacy-synthetic.png';

/** Every literal substring that must never leave a report surface. */
const FORBIDDEN_FRAGMENTS = [
  MARKER,
  'privacy-synthetic',
  'note-body',
  'example.invalid',
  'subjectName',
  'noteText',
  'fileName',
  'altText',
  'externalUrl',
] as const;

let repository: StorageV2Repository | null = null;
let databaseName = '';

async function repositoryFor(suffix: string): Promise<StorageV2Repository> {
  databaseName = `kd-privacy-report-${suffix}`;
  repository = await openTestRepository(databaseName, NOW);
  return repository;
}

function seedMarkedSubject(): void {
  const payload = JSON.parse(readSubjectFixture('subject-1.1.0-full-unknown-fields.json')) as {
    dungeon: Record<string, unknown>;
    rooms: Record<string, Record<string, unknown>>;
  };
  payload.dungeon.subjectName = MARKER;
  const room = Object.values(payload.rooms)[0] as Record<string, unknown>;
  room.topic = `${MARKER}-topic`;
  room.noteText = `${MARKER}-note-body`;
  room.attachments = [
    {
      attachmentId: 'att-privacy-marker',
      sourceType: 'external',
      fileName: `${MARKER}-attachment.png`,
      mimeType: 'image/png',
      externalUrl: EXTERNAL_URL,
      altText: `${MARKER}-alt`,
      addedAt: NOW,
    },
  ];

  const storage = window.localStorage;
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([SUBJECT_ID]));
  storage.setItem(`knowledge-dungeon:v1:subject:${SUBJECT_ID}`, JSON.stringify(payload));
  storage.setItem('knowledge-dungeon:v1:activeSubjectId', SUBJECT_ID);
  storage.setItem(
    'knowledge-dungeon:v1:progression',
    JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: 3,
          collectedNotes: [{ noteId: `${MARKER}-note-id`, topic: `${MARKER}-note-topic` }],
        },
      },
      crossSubjectAchievements: [`${MARKER}-achievement`],
    }),
  );
  storage.setItem(`knowledge-dungeon:backup:${SUBJECT_ID}`, `${MARKER}-raw-backup`);
  storage.setItem('knowledge-dungeon:locale', 'en');
}

/** Asserts a surface carries no marker and no learner-content field name. */
function expectSanitized(label: string, surface: unknown): void {
  const text = JSON.stringify(surface);
  expect(text.length, `${label} must not be empty`).toBeGreaterThan(2);
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    expect(text.includes(fragment), `${label} leaked ${fragment}`).toBe(false);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  seedMarkedSubject();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
  vi.restoreAllMocks();
});

describe('Phase 4 privacy gate 4: reports, receipts, descriptors, and errors carry no learner content', () => {
  it('keeps the migration report on exactly its declared, sanitized key set', async () => {
    const repo = await repositoryFor('report');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GENERATION_ID,
      now: NOW,
      clock: fixedClock(NOW),
    });

    // The surface really is populated: an empty report would make every absence
    // assertion below meaningless.
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.recordCounts.subjects).toBe(1);
    expect(outcome.report.externalOnlyAttachments).toHaveLength(1);
    expect(outcome.report.attachments.externalOnly).toBe(1);
    expect(outcome.report.receiptId).not.toBeNull();

    expect(Object.keys(outcome.report).sort()).toEqual(
      [
        'activated',
        'attachments',
        'contentChecksum',
        'createdAt',
        'externalOnlyAttachments',
        'legacyKeys',
        'migrationId',
        'previousActiveGenerationId',
        'problems',
        'progressionSourceVersions',
        'receiptId',
        'recordCounts',
        'recovery',
        'stagedGenerationId',
        'status',
        'subjectSchemaVersions',
      ].sort(),
    );
    expect(Object.keys(outcome.report.legacyKeys).sort()).toEqual(
      ['absent', 'allowlistedKeys', 'parseErrors', 'present', 'unsupportedShapes'].sort(),
    );
    expect(Object.keys(outcome.report.attachments).sort()).toEqual(
      ['externalOnly', 'storedBytes', 'total'].sort(),
    );
    expect(Object.keys(outcome.report.recordCounts).sort()).toEqual(
      [
        'assistance',
        'attachmentBlobs',
        'attachments',
        'customSprites',
        'preferences',
        'progression',
        'recovery',
        'sessions',
        'shortcuts',
        'subjects',
      ].sort(),
    );

    expectSanitized('MigrationReport', outcome.report);
    for (const entry of outcome.report.externalOnlyAttachments) {
      expect(Object.keys(entry).sort()).toEqual([
        'attachmentId',
        'byteLength',
        'contentHash',
        'reason',
        'roomId',
        'sourceType',
        'subjectId',
      ]);
      expectSanitized('ExternalOnlyAttachmentReport', entry);
    }
    for (const problem of outcome.report.problems) {
      expect(Object.keys(problem).sort()).toEqual(['code', 'count', 'scope', 'severity']);
    }
  });

  it('keeps the migration receipt and the generation descriptor to codes, counts, versions, ids, and checksums', async () => {
    const repo = await repositoryFor('receipt');
    await migrateLegacyState({
      repository: repo,
      generationId: GENERATION_ID,
      now: NOW,
      clock: fixedClock(NOW),
    });

    const receipts = (await repo.listMigrationReceipts(GENERATION_ID)) as MigrationReceiptValue[];
    expect(receipts).toHaveLength(1);
    expect(Object.keys(receipts[0] as MigrationReceiptValue).sort()).toEqual(
      [
        'contentChecksum',
        'createdAt',
        'fromStorage',
        'migrationId',
        'previousActiveGenerationId',
        'progressionSourceVersions',
        'receiptId',
        'recordChecksums',
        'recordCounts',
        'stagedGenerationId',
        'status',
        'storageGenerationFormatVersion',
        'subjectSchemaVersion',
        'subjectSchemaVersions',
        'toStorage',
      ].sort(),
    );
    // Real checksums, not placeholders: every store carries a 64-hex digest.
    const storeNames = Object.keys((receipts[0] as MigrationReceiptValue).recordChecksums);
    expect(storeNames.length).toBeGreaterThanOrEqual(9);
    for (const store of storeNames) {
      const digest = (receipts[0] as MigrationReceiptValue).recordChecksums[
        store as keyof MigrationReceiptValue['recordChecksums']
      ] as string;
      expect(digest, store).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((receipts[0] as MigrationReceiptValue).status).toBe('activated');
    expectSanitized('MigrationReceiptValue', receipts[0]);

    const descriptor = (await repo.readGeneration(GENERATION_ID))?.descriptor as GenerationDescriptor;
    expect(Object.keys(descriptor).sort()).toEqual(
      [
        'activatedAt',
        'contentChecksum',
        'createdAt',
        'generationFormatVersion',
        'generationId',
        'parentGenerationId',
        'recordCounts',
        'source',
        'status',
        'subjectSchemaVersion',
      ].sort(),
    );
    expect(descriptor.status).toBe('active');
    expect(descriptor.source).toBe('legacy-migration');
    expect(descriptor.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
    expectSanitized('GenerationDescriptor', descriptor);
  });

  it('keeps the recovery path on a code and a stage, and drops the thrown message', async () => {
    const repo = await repositoryFor('recovery');
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: GENERATION_ID,
      now: NOW,
      clock: fixedClock(NOW),
      onStage: (stage: string) => {
        if (stage === 'compare') throw new Error(`${MARKER}-thrown-message`);
      },
    });

    // The real failure path: a thrown message carrying learner content must not
    // survive into the report.
    expect(outcome.report.recovery).toEqual({ code: 'MIGRATION_FAILED', stage: 'compare' });
    expectSanitized('MigrationReport with recovery', outcome.report);
  });

  it('keeps the legacy read report to counts and opaque key ids', () => {
    const report = readLegacyAppState().report;

    // A dynamic key family embeds the opaque subject id. That is the documented
    // boundary: the id is a machine identifier, never a title.
    expect(report.keys.map((entry) => entry.keyId)).toContain(`subject:${SUBJECT_ID}`);
    expect(report.keys.length).toBeGreaterThan(10);
    for (const entry of report.keys) {
      expect(Object.keys(entry).sort()).toEqual([
        'byteLength',
        'itemCount',
        'keyId',
        'kind',
        'reason',
        'status',
        'targetStore',
      ]);
    }
    const text = JSON.stringify(report);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('attachment.png');
  });

  it('keeps generation validation problems to code, scope, count, and severity', () => {
    const state = readLegacyAppState();
    const built = buildRecordsFor(state);

    // The record really does carry the marker, so a leak here would be caught.
    const serialized = JSON.stringify(built.records.subjects?.[0]?.value ?? {});
    expect(serialized).toContain(MARKER);

    const result = validateGenerationRecords(GENERATION_ID, built.descriptor, built.records);
    expectSanitized('ValidationResult', result);
    for (const problem of result.problems) {
      expect(Object.keys(problem).sort()).toEqual(['code', 'count', 'scope', 'severity']);
      expect(typeof problem.code).toBe('string');
      expect(typeof problem.count).toBe('number');
      expect(['error', 'warning']).toContain(problem.severity);
    }
  });

  it('keeps a StorageV2Error message fixed per code, with no detail interpolation', () => {
    const error = new StorageV2Error('VALIDATION_FAILED', { stage: 'validate', problemCount: 2 });
    const report = error.toReport();

    expect(Object.keys(report).sort()).toEqual(['code', 'details']);
    expect(report.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(report.details).sort()).toEqual(['problemCount', 'stage']);
    expect(error.message).toBe('storage-v2 error: VALIDATION_FAILED');
    expectSanitized('StorageV2Error.toReport', report);
    expect(error.message).not.toContain(MARKER);
  });
});

/** Builds a staged-looking record set from the marked legacy state. */
function buildRecordsFor(state: ReturnType<typeof readLegacyAppState>): {
  records: GenerationRecords;
  descriptor: GenerationDescriptor;
} {
  const built = buildMigratedRecords(state, { now: NOW, generationId: GENERATION_ID });
  const records: GenerationRecords = emptyGenerationRecords();
  records.subjects = (built.records.subjects ?? []).map((value) => ({
    generationId: GENERATION_ID,
    recordId: value.subjectId,
    value,
    checksum: null,
    updatedAt: NOW,
  }));
  records.progression = (built.records.progression ?? []).map((value) => ({
    generationId: GENERATION_ID,
    recordId: (value as ProgressionRecordValue).subjectId,
    value,
    checksum: null,
    updatedAt: NOW,
  }));

  const descriptor: GenerationDescriptor = {
    generationId: GENERATION_ID,
    generationFormatVersion: 1,
    subjectSchemaVersion: '1.1.0',
    status: 'staged',
    source: 'legacy-migration',
    createdAt: NOW,
    activatedAt: null,
    parentGenerationId: null,
    recordCounts: countGenerationRecords(records),
    contentChecksum: '0'.repeat(64),
  };

  return { records, descriptor };
}
