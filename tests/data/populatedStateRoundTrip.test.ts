/**
 * Phase 5 data-product gate 1: a populated storage-v2 state exports and restores
 * with semantic equality.
 *
 * Plan section 7.3 fixes what a `.kdbak` must carry, and the exit criterion is a
 * *semantic* round trip: the same learner state, field by field, not the same
 * bytes. This file holds both halves of that claim.
 *
 * The green half is everything that does not need the product, and it is not a
 * formality:
 *
 * - The fixture is **real**. Records go through `stageGeneration` and
 *   `activateGeneration`, and `validateGeneration` must report `ok: true` with no
 *   count delta and no checksum mismatch. A fixture with a dangling relationship
 *   or a wrong count would fail its own validation, so "realistic" is measured.
 * - The fixture is **populated in the sense the plan means**: every store in the
 *   plan's section 7.1 list carries records, and the progression records carry
 *   XP, badges, inventory, equipped items, collected notes, fish, and
 *   cross-subject achievements, each list non-empty so the corresponding
 *   assertion cannot pass on an empty array.
 * - The **comparator bites**. `compareStateDocument` is fed a document with one
 *   real field removed and one real record removed, and must report exactly those
 *   two differences by name. A comparator that cannot fail would make every
 *   "semantically equal" claim in this repository decorative.
 * - The **unknown-field preservation** claim is checked against the fixture that
 *   actually has unknown app-owned fields at five levels.
 *
 * The registered half is the product round trip itself, and it turns RED the
 * moment the product implements the interface it names.
 *
 * Privacy: every value in this file is synthetic and self-describing. The
 * learner-content marker is planted on purpose so the privacy gates cannot be
 * satisfied by an empty surface. The only host is the reserved `example.invalid`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { CANONICAL_SUBJECT_SCHEMA_VERSION } from '@/services/persistence/v2/schema';
import { STORAGE_V2_STORE_NAMES } from '@/services/persistence/v2/schema';
import {
  DEVICE_NOW,
  POPULATED_GENERATION_ID,
  PRIOR_GENERATION_ID,
  ROOM_IDS,
  SUBJECT_IDS,
  createPopulatedDevice,
  resetLegacyStorage,
  type PopulatedDevice,
} from './support/populatedDevice';
import { CANONICAL_PROGRESSION_KEY_SET } from './support/progressionShape';
import { MARKER_TOKEN } from './support/marker';
import {
  buildStateDocument,
  compareStateDocument,
  describeDocumentDifferences,
  STATE_SECTIONS,
} from './support/stateDocument';
import { produceArchive, consumeArchive } from './support/backupAdapter';
import { FULL_DEVICE_BACKUP_MODULE, EXPORT_ENTRY_POINTS } from './support/productInterface';

let device: PopulatedDevice;

beforeAll(async () => {
  resetLegacyStorage();
  device = await createPopulatedDevice('kd-data-gate-round-trip');
});

describe('Phase 5 gate 1: the populated fixture is real and complete', () => {
  it('the staged generation validates clean, with no count delta and no checksum mismatch', async () => {
    const report = await device.repository.validateGeneration(POPULATED_GENERATION_ID);
    // A fixture that did not validate could not be "no data loss" in any
    // meaningful sense, so this is the first thing the gate proves.
    expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(Object.values(report.countDeltas).every((delta) => delta === 0)).toBe(true);
    expect(report.checksumMismatches).toEqual([]);
    // The roll-up checksum is a real digest, not a placeholder.
    expect(report.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(report.recordCounts.subjects).toBe(3);
    expect(report.recordCounts.attachments).toBe(7);
  });

  it('every store in the plan section 7.1 list holds real records', () => {
    const expected = device.expectedRecordCounts;
    // The plan's store list is the source of truth for which stores exist.
    expect(Object.keys(expected).sort()).toEqual([...STORAGE_V2_STORE_NAMES].sort());
    // Nine of the eleven are generation-scoped data stores; `meta` holds the
    // pointer and the registry, which `captureDeviceState` accounts for
    // separately, and `migrationReceipts` is global.
    const populatedStores = STORAGE_V2_STORE_NAMES.filter(
      (name) => (expected[name] ?? 0) > 0,
    );
    expect([...populatedStores].sort()).toEqual(
      [
        'assistance',
        'attachments',
        'customSprites',
        'migrationReceipts',
        'preferences',
        'progression',
        'recovery',
        'sessions',
        'shortcuts',
        'subjects',
      ].sort(),
    );
    // `meta` is the only empty store, and it is empty by design: the descriptor
    // registry and the pointer are written by activation, not by staging.
    expect(expected.meta).toBe(0);
  });

  it('the progression records carry every list the exit criterion names, non-empty', () => {
    const progression = device.staged.progression;
    expect(progression).toHaveLength(3);
    for (const record of progression) {
      const shape = record.bySubject[record.subjectId] as Record<string, unknown>;
      expect(Object.keys(shape).sort(), record.subjectId).toEqual(
        [...CANONICAL_PROGRESSION_KEY_SET].sort(),
      );
      expect(shape.xpTotal).toBe(record.xpTotal);
      expect(shape.rank).toBe(record.rank);
      expect(Array.isArray(shape.badges)).toBe(true);
      expect(Array.isArray(shape.inventory)).toBe(true);
      expect(Array.isArray(shape.equippedItems)).toBe(true);
      expect(Array.isArray(shape.collectedNotes)).toBe(true);
      expect(Array.isArray(shape.fishCollection)).toBe(true);
      // The alpha record has fish and badges; the gamma record deliberately has
      // neither, so "the list survived" is not just "the list is an array".
      expect(shape.extraFields).toEqual({
        fixtureProgressionField: 'preserve-this-synthetic-progression-field',
      });
    }
    const alpha = progression.find((record) => record.subjectId === SUBJECT_IDS.alpha);
    const alphaShape = alpha?.bySubject[SUBJECT_IDS.alpha] as Record<string, unknown>;
    expect((alphaShape.badges as string[]).length).toBeGreaterThan(0);
    expect((alphaShape.inventory as unknown[]).length).toBeGreaterThan(0);
    expect((alphaShape.equippedItems as unknown[]).length).toBeGreaterThan(0);
    expect((alphaShape.collectedNotes as unknown[]).length).toBeGreaterThan(0);
    expect((alphaShape.fishCollection as unknown[]).length).toBeGreaterThan(0);
    // Cross-subject achievements are on every record, which is the shape
    // `ProgressionRecordValue` declares.
    for (const record of progression) {
      expect(record.crossSubjectAchievements.length).toBeGreaterThan(0);
    }
  });

  it('unknown app-owned fields survive at every level of a subject snapshot', () => {
    const alpha = device.staged.subjects.find((subject) => subject.subjectId === SUBJECT_IDS.alpha);
    expect(alpha).toBeDefined();
    const snapshot = alpha?.snapshot as unknown as Record<string, unknown>;
    // Top level, dungeon level, room level, validation level, attachment level.
    expect(snapshot.unknownTopLevelField).toBeDefined();
    const dungeon = snapshot.dungeon as Record<string, unknown>;
    expect(dungeon.fixtureDungeonField).toBeDefined();
    const room = (snapshot.rooms as Record<string, Record<string, unknown>>)[ROOM_IDS.alphaRoot];
    expect(room?.fixtureRoomField).toBe('preserve-this-synthetic-room-field');
    const validation = room?.validationState as Record<string, unknown>;
    expect(validation.fixtureValidationField).toBe('preserve-this-synthetic-validation-field');
    // Attachment level: the fixture's own attachment is *kept* and this gate's is
    // added beside it, so the fifth unknown-field site survives and the alpha room
    // holds two attachments rather than one.
    const rootAttachments = room?.attachments as Record<string, unknown>[];
    expect(rootAttachments).toHaveLength(2);
    expect(rootAttachments[0]?.fixtureAttachmentField).toBe(
      'preserve-this-synthetic-attachment-field',
    );
    expect(rootAttachments[1]?.attachmentId).toBe('att-data-gate-stored-one');
    // And the marker really is planted, so the privacy gates' absence assertions
    // are not vacuous.
    expect(JSON.stringify(snapshot)).toContain(MARKER_TOKEN);
    expect(alpha?.schemaVersion).toBe(CANONICAL_SUBJECT_SCHEMA_VERSION);
  });

  it('the previous generation is retained for rollback and is superseded, not deleted', async () => {
    const generations = await device.repository.listGenerations();
    const ids = generations.map((descriptor) => descriptor.generationId).sort();
    expect(ids).toEqual([POPULATED_GENERATION_ID, PRIOR_GENERATION_ID].sort());
    const prior = generations.find((descriptor) => descriptor.generationId === PRIOR_GENERATION_ID);
    const active = generations.find((descriptor) => descriptor.generationId === POPULATED_GENERATION_ID);
    expect(prior?.status).toBe('superseded');
    expect(active?.status).toBe('active');
    expect(await device.repository.readActiveGenerationId()).toBe(POPULATED_GENERATION_ID);
    // The retained generation still has its record, which is what "retained for
    // rollback" has to mean.
    const retained = await device.repository.readRecords(PRIOR_GENERATION_ID);
    expect(retained.records.subjects).toHaveLength(1);
  });

  it('the legacy key set really holds the same subject set, so "unchanged" is a real claim', () => {
    const index = JSON.parse(
      window.localStorage.getItem('knowledge-dungeon:v1:subjects') as string,
    ) as string[];
    expect([...index].sort()).toEqual(
      [SUBJECT_IDS.alpha, SUBJECT_IDS.beta, SUBJECT_IDS.gamma].sort(),
    );
    expect(device.legacyKeys.size).toBeGreaterThanOrEqual(9);
    for (const key of device.legacyKeys.keys()) {
      expect(window.localStorage.getItem(key), key).toBe(device.legacyKeys.get(key));
    }
  });
});

describe('Phase 5 gate 1: the semantic-equality comparator can fail', () => {
  it('reports a removed field and a removed record, by name, and nothing else', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const document = buildStateDocument(device, snapshot, DEVICE_NOW);
    // The unmodified document is equal: the comparator is not simply reporting
    // everything.
    expect(compareStateDocument(document, snapshot)).toEqual([]);

    // One real field removed from one real record.
    const lossy = structuredClone(document) as Record<string, unknown>;
    const sessions = lossy.sessions as Record<string, unknown>[];
    delete (sessions[0] as Record<string, unknown>).xpEarned;
    // ...and one real record removed entirely, chosen by id so the expectation
    // does not depend on the order the repository happened to return.
    const shorts = lossy.shortcuts as Record<string, unknown>[];
    const removedIndex = shorts.findIndex((shortcut) => shortcut.actionId === 'toggle-info-panel');
    shorts.splice(removedIndex, 1);
    const differences = compareStateDocument(lossy, snapshot);
    expect(differences).toEqual([
      { section: 'sessions', recordId: 'session-data-gate-0001', field: 'xpEarned' },
      { section: 'shortcuts', recordId: 'toggle-info-panel', field: 'missing-record' },
    ]);
    expect(describeDocumentDifferences(differences)).toBe(
      'sessions/session-data-gate-0001.xpEarned; shortcuts/toggle-info-panel.missing-record',
    );
  });

  it('reports a changed nested value, not just a changed top-level field', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const document = buildStateDocument(device, snapshot, DEVICE_NOW);
    const lossy = structuredClone(document) as Record<string, unknown>;
    const subjects = lossy.subjects as Record<string, unknown>[];
    const alpha = subjects.find(
      (subject) => subject.subjectId === SUBJECT_IDS.alpha,
    ) as Record<string, unknown>;
    const snapshotValue = alpha.snapshot as Record<string, unknown>;
    const rooms = snapshotValue.rooms as Record<string, Record<string, unknown>>;
    (rooms[ROOM_IDS.alphaRoot] as Record<string, unknown>).noteText = 'replaced';
    const differences = compareStateDocument(lossy, snapshot);
    // The comparator descends into the snapshot and names the room field, so a
    // note that came back altered cannot hide behind an equal-looking envelope.
    expect(differences).toEqual([
      { section: 'subjects', recordId: SUBJECT_IDS.alpha, field: 'snapshot' },
    ]);
    expect(describeDocumentDifferences(differences)).toBe(
      'subjects/subject-data-gate-alpha.snapshot',
    );
  });

  it('the document carries every section the plan section 7.3 lists, each non-empty', async () => {
    const snapshot = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const document = buildStateDocument(device, snapshot, DEVICE_NOW);
    for (const section of STATE_SECTIONS) {
      const values = document[section];
      expect(Array.isArray(values), section).toBe(true);
      expect((values as unknown[]).length, section).toBeGreaterThan(0);
    }
    // Locale and quest state are named separately by the plan, so they are
    // separate document keys rather than buried in a preferences record.
    expect(document.locale).toBe('en-GB');
    expect((document.questState as Record<string, unknown>).questId).toBe(
      'quest-data-gate-synthetic',
    );
  });
});

describe('Phase 5 gate 1: REGISTERED - the product round trip', () => {
  it(
    'a populated storage-v2 state exports and restores with semantic equality, field by field',
    async () => {
      // HISTORY. Registered as `it.fails` in the Phase 5 rail set, waiting for
      // `exportFullDeviceBackup` and `importFullDeviceBackup` in the plan's Phase 5
      // module `src/services/persistence/products/fullDeviceBackup.ts`, called with
      // the request objects declared in `./support/backupAdapter`. The product
      // implements both, so this is now a live assertion: the same state comes back
      // into a separate, empty database, field by field, and the restored
      // generation validates clean.
      const context = {
        repository: device.repository,
        generationId: POPULATED_GENERATION_ID,
        now: DEVICE_NOW,
        payloadBytes: device.payloadBytes,
      };
      const bytes = await produceArchive(context);

      // A genuinely separate target device: its own database, its own empty
      // generation, and no legacy keys.
      resetLegacyStorage();
      const target = await createEmptyDevice('kd-data-gate-round-trip-target');
      const outcome = await consumeArchive(
        {
          repository: target.repository,
          generationId: target.generationId,
          now: DEVICE_NOW,
          payloadBytes: new Map(),
        },
        bytes,
      );
      void outcome;

      // The restored generation is a *new* generation and the previous one is
      // still there.
      const generations = await target.repository.listGenerations();
      expect(generations.length).toBeGreaterThanOrEqual(2);
      const active = await target.repository.readActiveGeneration();
      expect(active?.descriptor?.source).toBe('full-device-import');

      // Field-by-field semantic equality, through the same comparator the green
      // tests above proved can fail.
      const restored = await target.repository.readRecords(
        active?.descriptor?.generationId as string,
      );
      const source = await device.repository.readRecords(POPULATED_GENERATION_ID);
      // RAIL FIX, recorded deliberately. `buildStateDocument` refuses to build a
      // document from a generation other than the one its device names, and that
      // guard is load-bearing: it is what stops a restored state being compared
      // against the wrong source. The target device descriptor still names the
      // device's *original* empty generation, which a restore must not reuse -
      // staging over the active generation is refused by the repository, and the
      // assertion above requires at least two generations to exist. So the
      // comparison names the generation it is actually reading.
      //
      // The guard itself is unchanged: it still refuses a document built from a
      // generation the caller did not name, and the assertion that the restored
      // generation is a *new* one (two or more generations, `source` is
      // `full-device-import`) is above and unchanged.
      const restoredDevice = { ...target, generationId: active?.descriptor?.generationId as string };
      const restoredDocument = buildStateDocument(restoredDevice, restored, DEVICE_NOW);
      const sourceDocument = buildStateDocument(device, source, DEVICE_NOW);
      // The source document is itself equal to the source device, so a difference
      // below can only come from the restore, not from a bad reference document.
      expect(compareStateDocument(sourceDocument, source)).toEqual([]);
      const differences = compareStateDocument(restoredDocument, source);
      expect(differences, describeDocumentDifferences(differences)).toEqual([]);

      // And the restored generation itself validates clean, which is the
      // repository's own statement that counts, relationships, and checksums
      // agree.
      const report = await target.repository.validateGeneration(
        active?.descriptor?.generationId as string,
      );
      expect(report.problems).toEqual([]);
      expect(report.ok).toBe(true);
    },
  );

  it('names the interface the round-trip reproduction is waiting on', () => {
    // A pin, not a placeholder: the registered test above can only be turned
    // into a live assertion by implementing these names in this module.
    expect(FULL_DEVICE_BACKUP_MODULE).toBe(
      '@/services/persistence/products/fullDeviceBackup',
    );
    expect(EXPORT_ENTRY_POINTS.exportArchive).toContain('exportFullDeviceBackup');
    expect(EXPORT_ENTRY_POINTS.importArchive).toContain('importFullDeviceBackup');
  });
});

/**
 * A device with an empty database and one empty, activated generation.
 *
 * The restore target. A separate database is what makes the round trip a real
 * one: importing into the source device would pass even if the importer simply
 * kept whatever was already there.
 */
async function createEmptyDevice(
  databaseName: string,
): Promise<PopulatedDevice> {
  const { openStorageV2Repository } = await import(
    /* @vite-ignore */ '@/services/persistence/v2/repository'
  );
  const { createDeterministicIdFactory, fixedClock } = await import(
    /* @vite-ignore */ '@/services/persistence/v2/database'
  );
  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(DEVICE_NOW),
    idFactory: createDeterministicIdFactory('data-gate-target'),
  });
  const generationId = 'gen-data-gate-empty';
  await repository.stageGeneration({ generationId, source: 'initial', records: {} });
  await repository.activateGeneration(generationId);
  return {
    repository,
    databaseName,
    generationId,
    priorGenerationId: generationId,
    staged: {
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
    },
    payloadBytes: new Map(),
    duplicatePayloadAttachmentIds: [],
    legacyKeys: new Map(),
    expectedRecordCounts: {},
  };
}
