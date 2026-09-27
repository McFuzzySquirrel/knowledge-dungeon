/**
 * Phase 7 data-product gate 23: an import writes one new subject and changes nothing else.
 *
 * Plan section 5.2 requires that "Data imports never partially overwrite the active data
 * generation". Phases 5 and 6 both satisfy it by staging a complete new generation and
 * flipping the `activeGeneration` pointer, because both of those products *merge into*
 * data the device already holds. A template import does not merge: it appends one record
 * under a freshly minted subject id and deletes and updates nothing, so there is no
 * overwrite for it to be partial.
 *
 * That is a claim, and this gate is the measurement of it, from both sides:
 *
 * - **A refusal moves nothing.** Every one of the hostile cases from the sibling gate is
 *   re-run here through the *device* entry point, and the whole device is fingerprinted
 *   before and after: every generation, every record envelope including its own `recordId`,
 *   `checksum` and `updatedAt`, every descriptor, the active-generation pointer, and the
 *   entire ordered legacy `localStorage` key set with its values. The digest must be
 *   identical.
 * - **A success moves exactly one thing.** The imported record is added, and the **only**
 *   other differences are the three descriptor fields that are *derived* from the record
 *   set: `recordCounts`, `contentChecksum` and the descriptor's own `updatedAt`. Every one
 *   of them is named by the diff, so a change to an unrelated record, an unrelated subject,
 *   a preference, a progression record or an attachment blob fails by name rather than by
 *   "the digest moved".
 * - **The fingerprint can move.** A positive control flips one stored value through the real
 *   repository and requires the digest to change and the difference to be named. Without it
 *   every "unchanged" assertion in this file would be decorative, and this suite has a
 *   history of exactly that failure.
 *
 * ## Why the device is staged with a bystander subject and every device-global store
 *
 * An isolation gate is only as good as what it isolates *from*. This device holds two
 * subjects, an unrelated progression record, a preferences record, a shortcut, an
 * assistance record, a session, an attachment blob, a custom sprite, a recovery record, and
 * a migration receipt - so "no unrelated subject, no preference, no progression, no
 * attachment bytes" has something to be true about. The receipt matters in particular: a
 * receipt is a statement about the generation carrying it, so an import that rewrote or
 * dropped one would either forge provenance or lose history, and both are checked here
 * rather than assumed.
 *
 * ## The idempotence of a repeated import
 *
 * Importing the same template twice creates **two** subjects, not one, because every mint
 * is fresh. That is the correct behaviour rather than a wart - two imports creating
 * independent subjects is an exit criterion - and it is stated here so a future "dedupe
 * this" feature is a deliberate change with a decision behind it rather than a bug fix.
 *
 * Privacy: differences are named by store, record id, and field. No assertion message
 * reproduces a topic, a note, a filename, or a URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository, type StorageV2Repository } from '@/services/persistence/v2/repository';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import { CANONICAL_SUBJECT_SCHEMA_VERSION, StorageV2Error } from '@/services/persistence/v2/schema';
import { readSubjectIdsFromActiveGeneration } from '@/services/persistence/v2/appRepository';
import {
  exportSubjectTemplate,
  importSubjectTemplate,
  SUBJECT_TEMPLATE_MAX_BYTES,
} from '@/services/persistence/products/subjectTemplate';
import {
  captureDeviceState,
  diffDeviceStates,
  fingerprintOf,
  mutateActiveSubject,
  type DeviceState,
} from './support/deviceState';
import { resetLegacyStorage } from './support/populatedDevice';
import { canonicalProgressionShapeFor } from './support/progressionShape';
import {
  TEMPLATE_APPROVED_TAGS,
  TEMPLATE_BLOB_CONTENT_HASH,
  TEMPLATE_NOW,
  TEMPLATE_ROOM_LABELS,
  deviceOnlyRecords,
  templateIds,
  templateSnapshot,
} from './support/templateSubject';

const GENERATION = 'gen-template-isolation';
const PRIOR_GENERATION = 'gen-template-isolation-prior';
const BYSTANDER = 'subject-template-bystander';
const BYSTANDER_ROOT = 'room-template-bystander-root';

const template = exportSubjectTemplate(templateSnapshot(), {
  now: TEMPLATE_NOW,
  approvedTags: TEMPLATE_APPROVED_TAGS,
  approvedBiome: 'cozy-meadow',
  name: 'Synthetic Template',
}).template;

function counterGenerator(prefix: string): { next(): string } {
  let calls = 0;
  return { next: () => `${prefix}-${(calls += 1).toString().padStart(4, '0')}` };
}

/** The bystander subject, which must come through every import byte for byte. */
function bystanderSnapshot() {
  return {
    dungeon: {
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      dungeonId: BYSTANDER,
      subjectName: 'Synthetic Bystander Subject',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: BYSTANDER_ROOT,
      rooms: [{ roomId: BYSTANDER_ROOT, topic: 'Synthetic bystander topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: {
      [BYSTANDER_ROOT]: {
        roomId: BYSTANDER_ROOT,
        topic: 'Synthetic bystander topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        state: 'Created',
        notePath: `rooms/${BYSTANDER_ROOT}/notes.txt`,
        artifactPath: `rooms/${BYSTANDER_ROOT}/artifact.md`,
        noteText: '',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 0,
            clarityReadability: 0,
          },
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [],
      },
    },
  };
}

/** Stage a device holding the subject under test, a bystander, and every global store. */
async function createDevice(databaseName: string): Promise<StorageV2Repository> {
  resetLegacyStorage();
  const only = deviceOnlyRecords();
  const staged: GenerationRecordValues = {
    subjects: [
      {
        subjectId: templateIds('alpha').subject,
        schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        snapshot: templateSnapshot(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        subjectId: BYSTANDER,
        schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        snapshot: bystanderSnapshot() as never,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ] as never,
    progression: only.progression as never,
    sessions: only.sessions as never,
    preferences: only.preferences as never,
    shortcuts: [
      { actionId: 'toggle-map', labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false },
    ] as never,
    assistance: only.assistance as never,
    attachmentMetadata: [
      {
        attachmentId: templateIds('alpha').attachment,
        subjectId: templateIds('alpha').subject,
        roomId: templateIds('alpha').root,
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: TEMPLATE_BLOB_CONTENT_HASH,
        fileName: 'synthetic-bystander-attachment.png',
        altText: 'synthetic alt text',
        addedAt: '2026-01-03T00:00:00.000Z',
      },
    ] as never,
    attachmentBlobs: only.attachmentBlobs as never,
    customSprites: only.customSprites as never,
    recovery: only.recovery as never,
    // A receipt naming the generation that carries it, which is the invariant a restore
    // must not break.
    migrationReceipts: [
      {
        receiptId: 'receipt-template-isolation',
        migrationId: 'legacy-localstorage-to-storage-v2',
        fromStorage: 'legacy-localstorage',
        toStorage: 'storage-v2',
        stagedGenerationId: GENERATION,
        previousActiveGenerationId: PRIOR_GENERATION,
        status: 'activated',
        createdAt: '2026-01-04T00:00:00.000Z',
        storageGenerationFormatVersion: 1,
        subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
        subjectSchemaVersions: { [CANONICAL_SUBJECT_SCHEMA_VERSION]: 1 },
        progressionSourceVersions: { '3': 1 },
        recordCounts: {} as never,
        recordChecksums: {} as never,
        contentChecksum: 'b'.repeat(64),
      },
    ] as never,
  };

  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(TEMPLATE_NOW),
    idFactory: createDeterministicIdFactory('template-isolation'),
  });
  await repository.stageGeneration({ generationId: PRIOR_GENERATION, source: 'legacy-migration', records: {} });
  await repository.activateGeneration(PRIOR_GENERATION);
  await repository.stageGeneration({
    generationId: GENERATION,
    source: 'local-edit',
    parentGenerationId: PRIOR_GENERATION,
    records: staged,
  });
  await repository.activateGeneration(GENERATION);

  // The legacy mirror is seeded too, so the fingerprint covers real key/value bytes rather
  // than an empty store.
  window.localStorage.setItem(
    'knowledge-dungeon:v1:subjects',
    JSON.stringify([templateIds('alpha').subject, BYSTANDER]),
  );
  for (const subject of staged.subjects as unknown as Array<{ subjectId: string; snapshot: unknown }>) {
    window.localStorage.setItem(
      `knowledge-dungeon:v1:subject:${subject.subjectId}`,
      JSON.stringify(subject.snapshot),
    );
  }
  window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', BYSTANDER);
  window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');
  // The subject's own progression is keyed on the subject under test, so "progression did
  // not change" is a claim about a record that exists rather than about an empty store.
  expect((only.progression as unknown[]).length).toBe(1);
  expect(canonicalProgressionShapeFor).toBeTypeOf('function');
  return repository;
}

async function fingerprint(repository: StorageV2Repository): Promise<{ state: DeviceState; digest: string }> {
  const state = await captureDeviceState(repository);
  return { state, digest: fingerprintOf(state) };
}

describe('Phase 7 gate 23: the fingerprint can detect a change', () => {
  it('one flipped byte in one stored value moves the digest and is named', async () => {
    // The positive control for the whole file, on its own database so its permanent
    // mutation cannot contaminate the assertions below.
    const control = await createDevice('kd-data-gate-template-iso-control');
    const before = await fingerprint(control);
    expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
    // A substantial capture, or the digest would be measuring almost nothing.
    expect(before.state.records.length).toBeGreaterThanOrEqual(12);
    expect(before.state.legacyEntries.length).toBeGreaterThanOrEqual(4);
    expect([...before.state.generationIds].sort()).toEqual([GENERATION, PRIOR_GENERATION].sort());
    // Every store the plan names is present, so "changed nothing else" has a referent.
    for (const store of [
      'subjects',
      'progression',
      'sessions',
      'preferences',
      'shortcuts',
      'assistance',
      'attachmentMetadata',
      'attachmentBlobs',
      'customSprites',
      'recovery',
      'migrationReceipts',
    ]) {
      expect(before.state.recordCounts[store], store).toBeGreaterThanOrEqual(1);
    }

    await mutateActiveSubject(control, GENERATION, templateIds('alpha').subject);
    const after = await fingerprint(control);
    expect(after.digest).not.toBe(before.digest);
    expect(
      diffDeviceStates(before.state, after.state).some(
        (difference) =>
          difference.kind === 'record' &&
          difference.where.endsWith(`/subjects/${templateIds('alpha').subject}`) &&
          difference.field === 'value',
      ),
    ).toBe(true);
    // Only the value moved: the record count is the same, so this is not a fingerprint that
    // merely notices added and removed rows.
    expect(after.state.recordCounts).toEqual(before.state.recordCounts);
  });

  it('one legacy key change is detected too', async () => {
    const control = await createDevice('kd-data-gate-template-iso-legacy');
    const before = await fingerprint(control);
    window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', templateIds('alpha').subject);
    const after = await fingerprint(control);
    expect(after.digest).not.toBe(before.digest);
    expect(diffDeviceStates(before.state, after.state)).toEqual([
      { kind: 'legacy-value', where: 'knowledge-dungeon:v1:activeSubjectId', field: 'value' },
    ]);
  });
});

describe('Phase 7 gate 23: a refused import leaves the device byte-identical', () => {
  it('every malformed and hostile document is refused with the device unmoved', async () => {
    // Nine shapes, one per refusal family the product declares, each run through the
    // **device** entry point rather than the pure one - so the assertion covers the whole
    // import, not only its first step.
    const malformed: ReadonlyArray<{ readonly id: string; readonly template: string }> = [
      { id: 'not-json', template: '{"oops' },
      { id: 'too-large', template: `{"pad":"${'x'.repeat(SUBJECT_TEMPLATE_MAX_BYTES + 16)}"}` },
      { id: 'too-deep', template: `${'{"a":'.repeat(40)}1${' }'.repeat(40)}` },
      {
        id: 'wrong-format-version',
        template: JSON.stringify({ ...(JSON.parse(template) as object), formatVersion: 99 }),
      },
      {
        id: 'wrong-subject-schema-version',
        template: JSON.stringify({ ...(JSON.parse(template) as object), subjectSchemaVersion: '8.8.8' }),
      },
      {
        id: 'unexpected-document-key',
        template: JSON.stringify({ ...(JSON.parse(template) as object), noteText: 'leak' }),
      },
      {
        id: 'legacy-format',
        template: JSON.stringify({ format: 'knowledge-dungeon-template', rooms: [] }),
      },
      {
        id: 'prototype-key',
        template: `{"__proto__":{"x":1},${template.slice(1)}`,
      },
      {
        id: 'dangling-edge',
        template: (() => {
          const parsed = JSON.parse(template) as { graph: { structureEdges: Array<Record<string, unknown>> } };
          parsed.graph.structureEdges[0]!.to = 999;
          return JSON.stringify(parsed);
        })(),
      },
      {
        id: 'reserved-word-tag',
        template: (() => {
          const parsed = JSON.parse(template) as { graph: { tags: string[] } };
          parsed.graph.tags = ['__proto__'];
          return JSON.stringify(parsed);
        })(),
      },
    ];
    expect(malformed.length).toBeGreaterThanOrEqual(10);
    const repository = await createDevice('kd-data-gate-template-iso-refusal');
    const before = await fingerprint(repository);
    let after = before;

    for (const entry of malformed) {
      let thrown: unknown;
      try {
        await importSubjectTemplate({
          repository,
          template: entry.template,
          now: TEMPLATE_NOW,
          generator: counterGenerator(`refused-${entry.id}`),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.id).toBeInstanceOf(StorageV2Error);
      after = await fingerprint(repository);
      expect(after.digest, `${entry.id} changed the device`).toBe(before.digest);
      expect(diffDeviceStates(before.state, after.state), entry.id).toEqual([]);
    }
    // The pointer never moved either, and the subject list is exactly what it was.
    expect(after.state.activeGenerationId).toBe(GENERATION);
    expect(await readSubjectIdsFromActiveGeneration(repository)).toEqual([
      templateIds('alpha').subject,
      BYSTANDER,
    ]);
  });
});

describe('Phase 7 gate 23: a successful import changes exactly one record', () => {
  let repository: StorageV2Repository;
  let before: { state: DeviceState; digest: string };
  let importedSubjectId: string;

  beforeAll(async () => {
    repository = await createDevice('kd-data-gate-template-iso-success');
    before = await fingerprint(repository);
    const result = await importSubjectTemplate({
      repository,
      template,
      now: TEMPLATE_NOW,
      generator: counterGenerator('iso'),
      destinationSubjectName: 'An Imported Subject',
    });
    importedSubjectId = result.subjectId;
  });

  it('the result says what it did, in code-shaped words', () => {
    // Re-run the import in a fresh scope would double the subject, so the assertions on the
    // result shape are made here from the value the `beforeAll` captured, and the device
    // assertions below are made against the same import.
    expect(importedSubjectId).toMatch(/^kc-subject-/);
    expect(importedSubjectId).not.toBe(templateIds('alpha').subject);
    expect(importedSubjectId).not.toBe(BYSTANDER);
  });

  it('the only new record is the imported subject, and nothing else moved', async () => {
    const after = await fingerprint(repository);
    expect(after.digest).not.toBe(before.digest);
    const differences = diffDeviceStates(before.state, after.state);
    // Every other record is byte-identical: same value, same checksum, same `updatedAt`.
    const added = differences.filter((difference) => difference.kind === 'record' && difference.field === 'added');
    expect(added.map((difference) => difference.where)).toEqual([
      `${GENERATION}/subjects/${importedSubjectId}`,
    ]);
    const touchedRecords = differences.filter((difference) => difference.kind === 'record');
    expect(touchedRecords.every((difference) => difference.field === 'added')).toBe(true);
    // The pointer did not move: this is an append into the active generation, not a
    // generation swap.
    expect(differences.some((difference) => difference.kind === 'pointer')).toBe(false);
    // The only descriptor differences are the three fields derived from the record set, and
    // each is named. A change to the descriptor's source, status, or version would fail
    // here, because it would appear as a difference this list does not contain.
    const descriptorFields = differences
      .filter((difference) => difference.kind === 'descriptor')
      .map((difference) => difference.field)
      .sort();
    // Only the two descriptor fields that are *derived* from the record set. The descriptor's
    // own `updatedAt` does not appear because the repository runs on an injected fixed
    // clock here - the same clock the export is byte-deterministic under - and on a real
    // clock it would join them. So the assertion is a subset check over all three derived
    // fields, plus the exact set this clock produces.
    expect(['contentChecksum', 'recordCounts', 'updatedAt']).toEqual(
      expect.arrayContaining(descriptorFields),
    );
    expect(descriptorFields).toEqual(['contentChecksum', 'recordCounts']);
    // No generation was created and none was removed.
    expect(after.state.generationIds).toEqual(before.state.generationIds);
    expect(after.state.activeGenerationId).toBe(before.state.activeGenerationId);
    // Every store's count is unchanged except `subjects`, which grew by exactly one.
    for (const store of Object.keys(before.state.recordCounts)) {
      const expected = (before.state.recordCounts[store] as number) + (store === 'subjects' ? 1 : 0);
      expect(after.state.recordCounts[store], store).toBe(expected);
    }
    // The legacy mirror is untouched, because the product writes storage-v2 and the mirror
    // is the persistence facade's job. A template product that wrote localStorage directly
    // would show up here.
    expect(after.state.legacyEntries).toEqual(before.state.legacyEntries);
  });

  it('the bystander subject, its progression, and the migration receipt are intact', async () => {
    const after = await captureDeviceState(repository);
    const bystander = after.records.filter(
      (record) => record.generationId === GENERATION && record.recordId === BYSTANDER,
    );
    expect(bystander).toHaveLength(1);
    // Every store that is not `subjects` still holds exactly the record it held, with the
    // same value and the same envelope metadata.
    const beforeByKey = new Map(
      before.state.records.map((record) => [`${record.generationId}/${record.store}/${record.recordId}`, record]),
    );
    for (const record of after.records) {
      if (record.store === 'subjects' && record.recordId === importedSubjectId) continue;
      const key = `${record.generationId}/${record.store}/${record.recordId}`;
      const original = beforeByKey.get(key);
      expect(original, key).toBeDefined();
      expect(record.canonicalValue, key).toBe(original?.canonicalValue);
      expect(record.checksum, key).toBe(original?.checksum);
      expect(record.updatedAt, key).toBe(original?.updatedAt);
    }
    // The receipt still names the generation carrying it, so the generation storage-v2 would
    // activate is still a generation it accepts.
    const validation = await repository.validateGeneration(GENERATION);
    expect(validation.ok).toBe(true);
    expect(validation.checksumMismatches).toEqual([]);
  });

  it('the imported subject shares no identifier with either subject already on the device', async () => {
    const result = await importSubjectTemplate({
      repository,
      template,
      now: TEMPLATE_NOW,
      generator: counterGenerator('iso-collision'),
    });
    expect(result.subjectId).not.toBe(importedSubjectId);
    expect(result.subjectId).not.toBe(BYSTANDER);
    expect(result.subjectId).not.toBe(templateIds('alpha').subject);
    for (const roomId of result.roomIds) {
      expect(roomId).not.toBe(BYSTANDER_ROOT);
      expect(roomId).not.toBe(templateIds('alpha').root);
    }
    // Four subjects now: the two the device started with, plus one from the `beforeAll`
    // import and one from this one. **Two imports of one template make two subjects** -
    // which is the correct behaviour rather than a wart, because "two imports create
    // independent subjects" is an exit criterion - and it is stated here so a future
    // "dedupe repeated imports" feature is a deliberate change with a decision behind it.
    const ids = await readSubjectIdsFromActiveGeneration(repository);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain(templateIds('alpha').subject);
    expect(ids).toContain(BYSTANDER);
  });
});

describe('Phase 7 gate 23: the destination name defaults, and a device with no generation works', () => {
  it('an empty device gets an initial generation and the default subject name', async () => {
    // A device that has never been migrated and never been written has no generation to
    // write into, so the first write creates one. That is a real generation in the registry,
    // and the result reports the absence of a previous one rather than leaving a caller to
    // infer it.
    resetLegacyStorage();
    const fresh = await openStorageV2Repository({
      databaseName: 'kd-data-gate-template-iso-empty',
      clock: fixedClock(TEMPLATE_NOW),
      idFactory: createDeterministicIdFactory('template-empty'),
    });
    expect(await fresh.readActiveGenerationId()).toBeNull();
    const result = await importSubjectTemplate({
      repository: fresh,
      template,
      now: TEMPLATE_NOW,
      generator: counterGenerator('fresh'),
    });
    expect(result.previousActiveGenerationId).toBeNull();
    expect(result.writePolicy).toBe('additive-single-record');
    // The per-store counts are complete, not partial: a caller must not have to guess what a
    // descriptor left out.
    // The eleven storage-v2 store names, and no others. Named explicitly rather than derived
    // from the product's own constant, so a store added to the schema fails here until a
    // reader has decided what this product should report for it.
    expect(Object.keys(result.recordCounts).sort()).toEqual([
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
    ]);
    expect(result.recordCounts.subjects).toBe(1);
    expect(result.rollback).toBe('delete-the-created-subject-record');
    expect(result.subjectNameSource).toBe('template-name');
    expect(result.roomIds).toHaveLength(TEMPLATE_ROOM_LABELS.length);
    const active = await fresh.readActiveGenerationId();
    expect(active).not.toBeNull();
    expect(await readSubjectIdsFromActiveGeneration(fresh)).toEqual([result.subjectId]);
    const validation = await fresh.validateGeneration(active as string);
    expect(validation.ok).toBe(true);
  });
});
