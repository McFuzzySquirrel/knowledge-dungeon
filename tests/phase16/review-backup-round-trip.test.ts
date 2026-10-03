/**
 * Phase 16 exit criterion: **SM-2 values survive reload and backup.**
 *
 * ## Why this file exists rather than being read off Phase 15
 *
 * Phase 15 proved that the *carrier* round-trips: the progression record's
 * `extraFields` reaches the `.kdbak` and `.kdsubject` products byte for byte.
 * Phase 16 then put two new things in that carrier - the review-pass reward ledger
 * and the interrupted-review marker - and inherited the argument that they ride
 * safely, without testing it.
 *
 * An inherited argument is not evidence. This file performs the missing half:
 *
 * 1. Write a real SM-2 schedule and a real ledger and marker through the **real**
 *    domain functions.
 * 2. Export through the **real** `.kdbak` product.
 * 3. Import through the **real** `.kdbak` product into a second, empty device.
 * 4. Read the restored progression record back and assert all three survived with
 *    their values.
 * 5. Then ask the **real** decision function whether the restored ledger still
 *    suppresses a duplicate award, and the real marker reader whether the
 *    interrupted review is still resumable.
 *
 * Steps 4 and 5 are the point. A round trip that only proves "the bytes are equal"
 * would be satisfied by a carrier that carried the right bytes to the wrong place;
 * a duplicate that only proves "the ledger is readable" would be satisfied by a
 * ledger whose entries no longer match the identities the store will derive. Only
 * the last step exercises the property a learner would experience.
 *
 * ## The `.kdsubject` half is the same claim on a second product
 *
 * The full-device product is the one the plan's section 7.3 names first, but the
 * ledger is *per subject* state, and a learner who backs up one subject must not
 * lose it. Both products are exercised, and the `.kdsubject` lane imports in
 * `replace` mode into a device that already has the subject, because `copy` mints
 * a fresh subject id and would therefore be a different subject's data by
 * construction.
 *
 * Privacy: every value is synthetic and app-minted. Room ids are `room-…` strings
 * invented here, no note body, topic, subject name, or learner string is written,
 * and no assertion copies one into a failure message.
 */
import { describe, expect, it } from 'vitest';

import { STORAGE_V2_GENERATION_FORMAT_VERSION } from '@/services/persistence/v2/schema';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import type { ProgressionRecordValue, SubjectRecordValue } from '@/services/persistence/v2/schema';
import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
} from '@/services/persistence/products/fullDeviceBackup';
import {
  exportSubjectBackup,
  importSubjectBackup,
} from '@/services/persistence/products/subjectBackup';
import {
  applyInterruptedReviewSessionWrite,
  deriveReviewPassIdentity,
  hasReviewPassReward,
  readInterruptedReviewSessionFromFields,
  readReviewPassRewardLedgerFromFields,
  writeReviewPassRewardLedgerToFields,
} from '@/core/review';
import { decideReviewPassReward } from '@/core/review/reviewPassRewards';
import { resetLegacyStorage } from '../data/support/nastySubject';

// ── Synthetic identities ────────────────────────────────────────────────────

const NOW = '2026-04-02T00:00:00.000Z';
const LATER = '2026-04-03T00:00:00.000Z';

const SUBJECT_ID = 'subject-phase16-backup';
const ROOM_ID = 'room-phase16-backup';
const PRIOR_GENERATION_ID = 'gen-phase16-backup-prior';
const GENERATION_ID = 'gen-phase16-backup';

/** The pass the ledger says this room was already paid for. */
const AWARDED_PASS = 1;
/** A pass the ledger has never seen, which must still be awardable after a restore. */
const NEXT_PASS = 2;

/**
 * The SM-2 state a completed review leaves behind.
 *
 * Realistic values rather than zeros, because the claim is that the *values*
 * survive and a round trip of zeros proves only that zeros survive.
 */
const SM2_BEFORE_RESTORE = {
  reviewPassCount: 1,
  sm2QualityResponse: 4,
  sm2EaseFactor: 2.5,
  sm2IntervalDays: 6,
  sm2NextReviewDate: '2026-04-08T00:00:00.000Z',
  sm2ConsecutiveCorrect: 1,
} as const;

function stamp(): SubjectRecordValue {
  const now = NOW;
  const sm2 = SM2_BEFORE_RESTORE;
  const record = {
    subjectId: SUBJECT_ID,
    schemaVersion: '1.1.0',
    createdAt: now,
    updatedAt: now,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    snapshot: {
      dungeon: {
        schemaVersion: '1.1.0',
        dungeonId: SUBJECT_ID,
        subjectName: 'Synthetic Phase 16 Backup Subject',
        createdAt: now,
        updatedAt: now,
        phaseState: 'ArchaeologistActive',
        rootRoomId: ROOM_ID,
        rooms: [{ roomId: ROOM_ID, topic: 'Synthetic Backup Topic', status: 'ArtifactCollected' }],
        edges: [],
        progression: { xpTotal: 6, rank: 'Novice', badges: [], fishCollection: [] },
        biome: 'cozy-library',
      },
      rooms: {
        [ROOM_ID]: {
          roomId: ROOM_ID,
          topic: 'Synthetic Backup Topic',
          createdAt: now,
          updatedAt: now,
          state: 'ArtifactCollected',
          notePath: `rooms/${ROOM_ID}/notes.md`,
          artifactPath: `rooms/${ROOM_ID}/artifact.md`,
          noteText: 'Synthetic note body.',
          artifactMarkdown: '# Synthetic Backup Topic\n',
          validationState: {
            wordCount: 30,
            requiredSectionsPresent: true,
            manualConfirmed: true,
            criterionScores: {
              sectionCompleteness: 1,
              conceptTermCoverage: 1,
              linkReferences: 1,
              recallQuestionQuality: 1,
              clarityReadability: 1,
            },
            failedChecks: [],
            qualityBonus: 6,
            finalPass: true,
          },
          ...sm2,
          attachments: [],
        },
      },
    },
  };
  return record as unknown as SubjectRecordValue;
}

/**
 * The progression record, with the Phase 16 carrier written by the real writers.
 *
 * `writeReviewPassRewardLedgerToFields` and `applyInterruptedReviewSessionWrite` are
 * the production functions, not a hand-built object, so this fixture cannot drift
 * from the shape they produce.
 */
function progressionWithReviewState(): ProgressionRecordValue {
  const now = NOW;
  const ledger = writeReviewPassRewardLedgerToFields(undefined, {
    version: 1,
    entries: [
      {
        roomId: ROOM_ID,
        passNumber: AWARDED_PASS,
        reviewIdentity: deriveReviewPassIdentity({ roomId: ROOM_ID, passNumber: AWARDED_PASS }),
        awardedAt: now,
      },
    ],
  });
  const withMarker = applyInterruptedReviewSessionWrite(ledger, {
    kind: 'save',
    session: {
      version: 1,
      roomId: ROOM_ID,
      passNumber: AWARDED_PASS,
      startedAt: now,
      savedAt: now,
      qualityRating: null,
    },
  });

  return {
    subjectId: SUBJECT_ID,
    schemaVersion: '1.1.0',
    xpTotal: 6,
    rank: 'Novice',
    badges: [],
    inventory: [],
    equippedItems: [],
    collectedNotes: [],
    streakCount: 0,
    subjectsMastered: 0,
    roomsCleared: 1,
    reviewPasses: 1,
    artifacts: [],
    bossesDefeated: 0,
    fishCollection: [],
    crossSubjectAchievements: [],
    updatedAt: now,
    bySubject: {
      [SUBJECT_ID]: {
        xpTotal: 6,
        rank: 'Novice',
        badges: [],
        inventory: [],
        equippedItems: [],
        collectedNotes: [],
        streakCount: 0,
        subjectsMastered: 0,
        roomsCleared: 1,
        reviewPasses: 1,
        artifacts: [],
        bossesDefeated: 0,
        fishCollection: [],
        extraFields: withMarker,
      },
    },
  } as unknown as ProgressionRecordValue;
}

async function openDevice(
  databaseName: string,
  records: GenerationRecordValues,
): Promise<StorageV2Repository> {
  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(NOW),
    idFactory: createDeterministicIdFactory(databaseName),
  });
  await repository.stageGeneration({
    generationId: PRIOR_GENERATION_ID,
    source: 'legacy-migration',
    records: { subjects: [stamp()] },
  });
  await repository.activateGeneration(PRIOR_GENERATION_ID);
  await repository.stageGeneration({
    generationId: GENERATION_ID,
    source: 'local-edit',
    parentGenerationId: PRIOR_GENERATION_ID,
    records,
  });
  await repository.activateGeneration(GENERATION_ID);
  const validation = await repository.validateGeneration(GENERATION_ID);
  if (!validation.ok) {
    throw new Error(
      `The Phase 16 backup fixture does not validate: ${validation.problems
        .map((problem) => `${problem.severity}:${problem.scope}:${problem.code}`)
        .join(',')}`,
    );
  }
  return repository;
}

function emptyStores(): GenerationRecordValues {
  return {
    subjects: [],
    progression: [],
    sessions: [],
    preferences: [],
    shortcuts: [],
    assistance: [],
    attachmentMetadata: [],
    attachmentBlobs: [],
    customSprites: [],
    recovery: [],
    migrationReceipts: [],
  };
}

/** Read the one subject's preserved fields back off whatever generation is active. */
async function readRestoredExtraFields(
  repository: StorageV2Repository,
  generationId: string,
): Promise<Record<string, unknown>> {
  const snapshot = await repository.readRecords(generationId);
  const record = snapshot.records.progression.find(
    (entry) => entry.value.subjectId === SUBJECT_ID,
  );
  if (record === undefined) throw new Error('No progression record was restored.');
  const bySubject = record.value.bySubject as Record<string, Record<string, unknown>>;
  const entry = bySubject[SUBJECT_ID];
  if (entry === undefined) throw new Error('No per-subject progression entry was restored.');
  const extraFields = entry.extraFields;
  if (typeof extraFields !== 'object' || extraFields === null) {
    throw new Error('The restored progression entry carried no preserved fields.');
  }
  return extraFields as Record<string, unknown>;
}

function readRestoredRoomSm2(
  repository: StorageV2Repository,
  generationId: string,
): Promise<Record<string, unknown> | null> {
  return repository.readRecords(generationId).then((snapshot) => {
    const record = snapshot.records.subjects.find(
      (entry) => entry.value.subjectId === SUBJECT_ID,
    );
    const snapshotValue = record?.value.snapshot as
      | { rooms?: Record<string, Record<string, unknown>> }
      | undefined;
    return snapshotValue?.rooms?.[ROOM_ID] ?? null;
  });
}

/**
 * The claim, stated once and asserted on both products.
 *
 * The three checks are deliberately about behaviour and not about bytes:
 *
 * - the SM-2 numbers are the numbers that went in;
 * - the ledger still **suppresses** `(room, AWARDED_PASS)` and still **permits**
 *   `(room, NEXT_PASS)`, decided by the production decision function;
 * - the marker is still readable and still names this room.
 */
async function assertReviewStateSurvived(
  repository: StorageV2Repository,
  generationId: string,
  product: string,
): Promise<void> {
  const room = await readRestoredRoomSm2(repository, generationId);
  expect(room, `${product}: the room was not restored`).not.toBeNull();
  for (const [field, value] of Object.entries(SM2_BEFORE_RESTORE)) {
    expect(room?.[field], `${product}: SM-2 field ${field}`).toBe(value);
  }

  const extraFields = await readRestoredExtraFields(repository, generationId);

  const ledger = readReviewPassRewardLedgerFromFields(extraFields);
  expect(ledger.entries.length, `${product}: ledger entry count`).toBe(1);
  expect(
    hasReviewPassReward(ledger, ROOM_ID, AWARDED_PASS),
    `${product}: the restored ledger lost its (room, pass) entry`,
  ).toBe(true);
  // And the entries the store will mint now still match the entry it wrote before,
  // which is the part a byte comparison cannot see.
  const replay = decideReviewPassReward({
    extraFields,
    roomId: ROOM_ID,
    passNumber: AWARDED_PASS,
    awardedAt: LATER,
  });
  expect(replay.outcome, `${product}: a duplicate award was not suppressed`).toBe('already-awarded');
  expect(replay.ledger, `${product}: a suppressed duplicate still rewrote the ledger`).toEqual(ledger);

  const fresh = decideReviewPassReward({
    extraFields,
    roomId: ROOM_ID,
    passNumber: NEXT_PASS,
    awardedAt: LATER,
  });
  expect(
    fresh.outcome,
    `${product}: the restored ledger also suppressed the next genuine pass`,
  ).toBe('awarded');
  expect(
    fresh.ledger.entries.length,
    `${product}: the next pass did not append exactly one entry`,
  ).toBe(2);

  const marker = readInterruptedReviewSessionFromFields(extraFields);
  expect(marker?.roomId, `${product}: the interrupted-review marker did not survive`).toBe(ROOM_ID);
  expect(marker?.passNumber, `${product}: the marker's pass number did not survive`).toBe(
    AWARDED_PASS,
  );
}

describe('Phase 16: the review ledger and the interrupted-review marker survive a real backup', () => {
  it('survives a full-device .kdbak export and import', async () => {
    resetLegacyStorage();
    const source = await openDevice('kd-phase16-backup-source', {
      ...emptyStores(),
      subjects: [stamp()],
      progression: [progressionWithReviewState()],
    });

    // The controls, read off the source before the archive exists, so a restore that
    // silently carried *nothing* cannot pass by comparison against an empty expectation.
    expect(hasReviewPassReward(readReviewPassRewardLedgerFromFields(
      await readRestoredExtraFields(source, GENERATION_ID),
    ), ROOM_ID, AWARDED_PASS)).toBe(true);

    const exported = await exportFullDeviceBackup({
      repository: source,
      generationId: GENERATION_ID,
      now: LATER,
    });
    const bytes = exported.bytes;

    // A second, empty device. Not the same repository: the point is that the state
    // arrives through the product, not that it never left memory.
    const destination = await openStorageV2Repository({
      databaseName: 'kd-phase16-backup-destination',
      clock: fixedClock(LATER),
      idFactory: createDeterministicIdFactory('kd-phase16-backup-destination'),
    });
    await importFullDeviceBackup({
      repository: destination,
      bytes,
      now: LATER,
      keepPreviousGeneration: true,
    });

    const restored = await destination.readActiveGenerationId();
    expect(restored, '.kdbak: no generation is active after the import').not.toBeNull();
    await assertReviewStateSurvived(destination, restored as string, '.kdbak');
  });

  it('survives a single-subject .kdsubject export and a replace import', async () => {
    resetLegacyStorage();
    const source = await openDevice('kd-phase16-subject-source', {
      ...emptyStores(),
      subjects: [stamp()],
      progression: [progressionWithReviewState()],
    });

    const exported = await exportSubjectBackup({
      repository: source,
      generationId: GENERATION_ID,
      subjectId: SUBJECT_ID,
      now: LATER,
    });

    const destination = await openDevice('kd-phase16-subject-destination', {
      ...emptyStores(),
      subjects: [stamp()],
      progression: [progressionWithReviewState()],
    });
    // `replace`, not `copy`: a copy mints a fresh subject id, so the restored record
    // would be a *different* subject's data and "it survived" would be untestable.
    await importSubjectBackup({
      repository: destination,
      bytes: exported.bytes,
      now: LATER,
      mode: 'replace',
      confirmReplace: true,
      replaceSubjectId: SUBJECT_ID,
    });

    const restored = await destination.readActiveGenerationId();
    expect(restored, '.kdsubject: no generation is active after the import').not.toBeNull();
    await assertReviewStateSurvived(destination, restored as string, '.kdsubject');
  });
});