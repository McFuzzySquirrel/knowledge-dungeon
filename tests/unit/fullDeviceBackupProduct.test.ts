/**
 * Phase 5 data-product gate 10: the full-device backup product's own suite.
 *
 * `tests/data/` holds the nine gates the maintainer pinned for this phase, and it
 * holds them well. This file covers what they do not, and every item here exists
 * because a pinned gate is silent about it:
 *
 * 1. **A fresh-profile restore** in `fake-indexeddb`: a brand-new database with no
 *    prior state at all - no generation, no pointer, no records - and the whole
 *    state comes back and reads equal. The pinned round-trip gate restores into a
 *    device that already holds an empty activated generation, which is a real
 *    scenario but not the hardest one.
 * 2. **Idempotency**: importing the same archive twice must not duplicate a single
 *    record.
 * 3. **The previous generation is genuinely retained** and still readable after a
 *    successful import, and `keepPreviousGeneration: false` does not delete it.
 * 4. **Determinism**: an export under a fixed clock is byte-identical, twice.
 * 5. **Attachment-byte resolution**, with and without a caller-supplied map,
 *    including the device-local store and the declared-versus-computed hash
 *    disagreement.
 * 6. **Inspection touches no stored data**, proven by a fingerprint around the
 *    call rather than asserted.
 * 7. **Directory entries are accepted and ignored**, and a real zip-slip member is
 *    still rejected - the interoperability decision, tested from both sides.
 * 8. **Renderer-neutrality and no egress**: the product tree imports no renderer
 *    and contains no call that could download, share, or upload anything.
 *
 * Privacy: the fixture this file uses is the gate suite's synthetic one, whose only
 * host is the reserved `example.invalid`. No real subject, note, filename, or URL
 * appears here.
 */

import 'fake-indexeddb/auto';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { join, relative } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readArchive, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import { closeDeviceLocalAttachmentStore } from '@/services/persistence/v2/attachmentBytes';
import {
  currentRepositorySelection,
  resetRepositorySelection,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import { storeAttachmentBytes } from '@/services/persistence/v2/attachmentBytes';
import {
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  StorageV2Error,
  type StorageV2StoreName,
} from '@/services/persistence/v2/schema';
import { CURRENT_SCHEMA_VERSION, DATA_PRODUCT_FORMAT_VERSIONS } from '@/core/validation/persistence/types';

import {
  createDeterministicIdFactory,
  fixedClock,
} from '@/services/persistence/v2/database';
import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  readLiveActiveGenerationId,
  resolveDeviceLocalPayloadBytes,
  resolveLiveDeviceRepository,
  FULL_DEVICE_BACKUP_FILE_NAME,
  type FullDeviceExportResult,
} from '@/services/persistence/products/fullDeviceBackup';
import {
  readFullDeviceArchive,
  inspectFullDeviceArchive,
  readFullDeviceArchiveContents,
  classifyFullDeviceMemberName,
  FULL_DEVICE_MANIFEST_KEYS,
  FULL_DEVICE_STATE_SECTIONS,
} from '@/services/persistence/products/archiveValidation';

import { blankComments } from '../data/support/importGraph';
import {
  ATTACHMENT_IDS,
  DEVICE_NOW,
  POPULATED_GENERATION_ID,
  PRIOR_GENERATION_ID,
  SPRITE_PATH,
  SUBJECT_IDS,
  createPopulatedDevice,
  resetLegacyStorage,
  type PopulatedDevice,
} from '../data/support/populatedDevice';
import { captureDeviceState, fingerprintOf, diffDeviceStates, describeDifferences } from '../data/support/deviceState';
import { rawFflateZip, rawZip } from '../data/support/hostileZip';
import { isFreeOfLearnerContent } from '../data/support/marker';
import { utf8 } from '../data/support/hashes';
import { buildStateDocument, compareStateDocument, describeDocumentDifferences, STATE_DOCUMENT_KEYS } from '../data/support/stateDocument';

const SRC_ROOT = join(process.cwd(), 'src');
const PRODUCTS_ROOT = join(SRC_ROOT, 'services', 'persistence', 'products');

function repoPath(absolute: string): string {
  return relative(process.cwd(), absolute).split('\\').join('/');
}

function productModules(): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(PRODUCTS_ROOT).sort()) {
    const full = join(PRODUCTS_ROOT, entry);
    if (statSync(full).isFile() && entry.endsWith('.ts')) out.push(repoPath(full));
  }
  return out;
}

function readProductModule(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/**
 * How a product module reached one specifier, resolved to a repo-relative path.
 *
 * A second, small implementation on purpose: this file already owns a source
 * scanner with its own positive control, and reusing the *same* helper to check
 * the same edges would let a bug in the helper hide itself. The rule under test
 * here is narrow - "no product module statically imports an opening module for
 * real" - so the implementation is narrow too.
 */
type ProductEdgeKind = 'value' | 'type-only' | 'dynamic' | 'require';

const PRODUCT_EDGE_PATTERN =
  /\b(?:import|export)\s+(?:(?<typeOnly>type)\s+)?[^;'"]*?\bfrom\s*['"](?<from>[^'"]+)['"]|\bimport\s*\(\s*['"](?<dynamic>[^'"]+)['"]\s*\)|\brequire\s*\(\s*['"](?<required>[^'"]+)['"]\s*\)/g;

function productEdges(path: string): { specifier: string; kind: ProductEdgeKind }[] {
  return productEdgesIn(blankComments(readProductModule(path)));
}

function productEdgesIn(code: string): { specifier: string; kind: ProductEdgeKind }[] {
  const edges: { specifier: string; kind: ProductEdgeKind }[] = [];
  for (const match of code.matchAll(PRODUCT_EDGE_PATTERN)) {
    const groups = match.groups ?? {};
    if (groups.from !== undefined) {
      edges.push({
        specifier: groups.from,
        kind: groups.typeOnly !== undefined ? 'type-only' : 'value',
      });
    } else if (groups.dynamic !== undefined) {
      edges.push({ specifier: groups.dynamic, kind: 'dynamic' });
    } else if (groups.required !== undefined) {
      edges.push({ specifier: groups.required, kind: 'require' });
    }
  }
  return edges;
}

/** Resolve a product module's specifier the way Vite would, or `null`. */
function productResolveTarget(path: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolvePath(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolvePath(dirname(join(process.cwd(), path)), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return repoPath(candidate);
  }
  return null;
}

/** The storage-v2 modules that can actually open or mutate a database. */
const OPENING_STORAGE_V2_MODULES: readonly string[] = [
  'src/services/persistence/v2/database.ts',
  'src/services/persistence/v2/repository.ts',
  'src/services/persistence/v2/migrations.ts',
];

function countRecords(snapshot: { records: Record<string, unknown[]> }): Record<StorageV2StoreName, number> {
  return {
    meta: 0,
    subjects: snapshot.records.subjects?.length ?? 0,
    progression: snapshot.records.progression?.length ?? 0,
    sessions: snapshot.records.sessions?.length ?? 0,
    preferences: snapshot.records.preferences?.length ?? 0,
    shortcuts: snapshot.records.shortcuts?.length ?? 0,
    assistance: snapshot.records.assistance?.length ?? 0,
    attachments:
      (snapshot.records.attachmentMetadata?.length ?? 0) +
      (snapshot.records.attachmentBlobs?.length ?? 0),
    customSprites: snapshot.records.customSprites?.length ?? 0,
    recovery: snapshot.records.recovery?.length ?? 0,
    migrationReceipts: snapshot.records.migrationReceipts?.length ?? 0,
  } as Record<StorageV2StoreName, number>;
}

async function exportOf(
  device: PopulatedDevice,
  overrides: { now?: string; payloadBytes?: ReadonlyMap<string, Uint8Array> | null } = {},
): Promise<FullDeviceExportResult> {
  return exportFullDeviceBackup({
    repository: device.repository,
    generationId: device.generationId,
    now: overrides.now ?? DEVICE_NOW,
    payloadBytes:
      overrides.payloadBytes === null ? undefined : (overrides.payloadBytes ?? device.payloadBytes),
    activeSubjectId: null,
  });
}

async function importInto(
  repository: StorageV2Repository,
  bytes: Uint8Array,
  now = DEVICE_NOW,
): ReturnType<typeof importFullDeviceBackup> {
  return importFullDeviceBackup({ repository, bytes, now, keepPreviousGeneration: true });
}

/** Every record on the device, per store, summed across every generation. */
async function totalRecordsOn(repository: StorageV2Repository): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  for (const descriptor of await repository.listGenerations()) {
    const counts = countRecords((await repository.readRecords(descriptor.generationId)) as never);
    for (const [key, value] of Object.entries(counts)) total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

/** A repository with no generation, no pointer, and no records at all. */
async function openFreshRepository(databaseName: string): Promise<StorageV2Repository> {
  return openStorageV2Repository({
    databaseName,
    clock: fixedClock(DEVICE_NOW),
    idFactory: createDeterministicIdFactory('phase5-fresh'),
  });
}

let device: PopulatedDevice;

beforeAll(async () => {
  resetLegacyStorage();
  device = await createPopulatedDevice('kd-phase5-product');
});

afterEach(() => {
  resetLegacyStorage();
  resetRepositorySelection();
});

// ── 1. Fresh profile ──────────────────────────────────────────────────────

describe('Phase 5 gate 10: a fresh profile restores the whole state', () => {
  it('a brand-new database with no prior state receives the state and reads back equal', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-fresh-profile');

    // The freshness is measured, not assumed: no generation, no pointer, no
    // records, and an empty legacy key set.
    expect(await target.readActiveGenerationId()).toBeNull();
    expect(await target.listGenerations()).toEqual([]);
    expect(window.localStorage.length).toBe(0);
    const freshSnapshot = await target.readRecords('gen-phase5-does-not-exist');
    expect(countRecords(freshSnapshot as never)).toEqual({
      meta: 0,
      subjects: 0,
      progression: 0,
      sessions: 0,
      preferences: 0,
      shortcuts: 0,
      assistance: 0,
      attachments: 0,
      customSprites: 0,
      recovery: 0,
      migrationReceipts: 0,
    });

    const bytes = (await exportOf(device)).bytes;
    const result = await importInto(target, bytes);

    // There was no previous generation, so none is retained, and the result says
    // so rather than claiming a rollback path that does not exist.
    expect(result.previousActiveGenerationId).toBeNull();
    expect(result.previousGenerationRetained).toBe(false);
    expect(result.activated).toBe(true);
    expect(await target.readActiveGenerationId()).toBe(result.generationId);
    expect(await target.listGenerations()).toHaveLength(1);

    // The whole state came back, field by field, through the same comparator the
    // pinned gate proved can fail.
    const restored = await target.readRecords(result.generationId);
    const source = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const differences = compareStateDocument(
      buildStateDocument({ ...device, generationId: result.generationId }, restored, DEVICE_NOW),
      source,
    );
    expect(differences, describeDocumentDifferences(differences)).toEqual([]);
    expect(countRecords(restored as never)).toEqual(countRecords(source as never));
    expect(restored.records.subjects).toHaveLength(3);
    expect(restored.records.sessions).toHaveLength(4);
    expect(restored.records.attachmentBlobs).toHaveLength(3);

    // The repository's own statement that counts, relationships, and checksums
    // agree.
    const validation = await target.validateGeneration(result.generationId);
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('a fresh profile still records the legacy key set change nothing, and the restore is lossless for unknown fields', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-fresh-unknown-fields');
    const bytes = (await exportOf(device)).bytes;
    const result = await importInto(target, bytes);
    const restored = await target.readRecords(result.generationId);

    // Unknown app-owned fields at five levels of a subject snapshot, plus the one
    // progression record's own unknown field.
    const alpha = restored.records.subjects.find(
      (envelope) => envelope.value.subjectId === SUBJECT_IDS.alpha,
    )?.value as unknown as Record<string, unknown>;
    const snapshot = alpha.snapshot as Record<string, unknown>;
    expect(snapshot.unknownTopLevelField).toBeDefined();
    expect(snapshot.fixtureFormat).toBeDefined();
    const dungeon = snapshot.dungeon as Record<string, unknown>;
    expect(dungeon.fixtureDungeonField).toBeDefined();
    const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
    expect(rooms['room-data-gate-alpha-root']?.fixtureRoomField).toBe(
      'preserve-this-synthetic-room-field',
    );
    const attachments = rooms['room-data-gate-alpha-root']?.attachments as Record<string, unknown>[];
    expect(attachments.some((entry) => entry.fixtureAttachmentField !== undefined)).toBe(true);
    const progression = restored.records.progression.find(
      (envelope) => envelope.value.subjectId === SUBJECT_IDS.alpha,
    )?.value as unknown as { bySubject: Record<string, { extraFields: unknown }> };
    expect(progression.bySubject[SUBJECT_IDS.alpha]?.extraFields).toEqual({
      fixtureProgressionField: 'preserve-this-synthetic-progression-field',
    });
    // Three custom sprite records for one path, all three kinds, byte-identical.
    const sprites = restored.records.customSprites.map((envelope) => envelope.value);
    expect(
      sprites
        .filter((record: { spritePath: string }) => record.spritePath === SPRITE_PATH)
        .map((record: { kind: string }) => record.kind)
        .sort(),
    ).toEqual(['anim', 'original', 'override']);
  });
});

// ── 2. Idempotency ────────────────────────────────────────────────────────

describe('Phase 5 gate 10: importing the same archive twice does not duplicate anything', () => {
  it('a second import writes a new generation with identical counts and no duplicated record', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-idempotent');
    const bytes = (await exportOf(device)).bytes;

    const first = await importInto(target, bytes);
    const firstSnapshot = await target.readRecords(first.generationId);
    const firstCounts = countRecords(firstSnapshot as never);
    const totalRecordsAfterFirst = await totalRecordsOn(target);

    const second = await importInto(target, bytes);
    expect(second.generationId).not.toBe(first.generationId);
    // The archive's own label was free the first time and is taken the second
    // time, so the second import mints one and re-points the receipts. Both facts
    // are reported rather than hidden.
    expect(first.reusedArchiveGenerationId).toBe(true);
    expect(first.generationId).toBe(POPULATED_GENERATION_ID);
    expect(second.reusedArchiveGenerationId).toBe(false);

    // Two generations, and the totals are exactly twice the single-generation
    // totals: a second import adds a generation, it does not add records to the
    // first one.
    expect(await target.listGenerations()).toHaveLength(2);
    const totalRecordsAfterSecond = await totalRecordsOn(target);
    for (const [key, value] of Object.entries(totalRecordsAfterFirst)) {
      expect(totalRecordsAfterSecond[key], key).toBe((value as number) * 2);
    }

    // And the two generations are semantically identical: same counts, same state.
    const secondSnapshot = await target.readRecords(second.generationId);
    expect(countRecords(secondSnapshot as never)).toEqual(firstCounts);
    const source = await device.repository.readRecords(POPULATED_GENERATION_ID);
    const differences = compareStateDocument(
      buildStateDocument({ ...device, generationId: second.generationId }, secondSnapshot, DEVICE_NOW),
      source,
    );
    // The only permitted difference is the migration receipt's generation label,
    // which the second import re-pointed because the archive's own label was
    // already in use on this device. Nothing else may move.
    expect(differences.map((difference) => `${difference.section}.${difference.field}`)).toEqual([
      'migrationReceipts.stagedGenerationId',
    ]);

    // No record id is duplicated inside either generation.
    for (const snapshot of [firstSnapshot, secondSnapshot]) {
      const ids = (store: 'subjects' | 'sessions' | 'attachmentMetadata' | 'attachmentBlobs' | 'customSprites' | 'recovery' | 'migrationReceipts') =>
        snapshot.records[store].map((envelope) => envelope.recordId);
      for (const store of ['subjects', 'sessions', 'attachmentMetadata', 'attachmentBlobs', 'customSprites', 'recovery', 'migrationReceipts'] as const) {
        expect(new Set(ids(store)).size, store).toBe(ids(store).length);
      }
    }

    // A third import is still clean.
    const third = await importInto(target, bytes);
    expect(await target.listGenerations()).toHaveLength(3);
    expect(await target.validateGeneration(third.generationId).then((report) => report.problems)).toEqual([]);
  });
});

// ── 3. Previous generation retention ──────────────────────────────────────

describe('Phase 5 gate 10: the previous generation is retained and still readable', () => {
  it('a successful import supersedes rather than deletes, and the old records read back', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-retention');
    const bytes = (await exportOf(device)).bytes;

    // A generation the restore can replace, with its own distinctive record.
    await target.stageGeneration({
      generationId: 'gen-phase5-previous',
      source: 'local-edit',
      records: {
        preferences: [{ preferenceId: 'theme', value: 'cozy', updatedAt: DEVICE_NOW }],
      },
    });
    await target.activateGeneration('gen-phase5-previous');
    const before = await captureDeviceState(target);

    const result = await importInto(target, bytes);
    expect(result.previousActiveGenerationId).toBe('gen-phase5-previous');
    expect(result.previousGenerationRetained).toBe(true);
    expect(result.retentionNote).toBe('previous-generation-always-retained');

    // Retained, superseded, and still holding its own record: a rollback path
    // that could not be read would not be a rollback path.
    const descriptors = await target.listGenerations();
    const previous = descriptors.find((entry) => entry.generationId === 'gen-phase5-previous');
    expect(previous?.status).toBe('superseded');
    const retained = await target.readRecords('gen-phase5-previous');
    expect(retained.records.preferences).toHaveLength(1);
    expect(retained.records.subjects).toHaveLength(0);
    expect(descriptors.find((entry) => entry.generationId === result.generationId)?.status).toBe('active');

    // The change is exactly the pointer and the new generation: the previous
    // generation's own bytes did not move.
    const after = await captureDeviceState(target);
    const differences = diffDeviceStates(before, after).filter(
      (difference: { kind: string; where: string }) =>
        difference.kind === 'record' && difference.where.startsWith('gen-phase5-previous/'),
    );
    expect(differences, describeDifferences(differences)).toEqual([]);
    expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
  });

  it('keepPreviousGeneration: false is reported as a request, and never deletes the replaced generation', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-retention-false');
    await target.stageGeneration({ generationId: 'gen-phase5-a', source: 'initial', records: {} });
    await target.activateGeneration('gen-phase5-a');

    const bytes = (await exportOf(device)).bytes;
    const result = await importFullDeviceBackup({
      repository: target,
      bytes,
      now: DEVICE_NOW,
      keepPreviousGeneration: false,
    });

    // The answer is the safe one: a restore never deletes the generation it
    // replaced, because that generation is the learner's other copy of everything.
    expect(result.previousGenerationRetained).toBe(true);
    expect(result.retentionNote).toBe('previous-generation-always-retained');
    // Every outcome-shaped field reports that retention happened, whatever was
    // asked for. This field used to carry the request, so a caller reading it as
    // an outcome would have been told `false` about a generation still on the
    // device; it now reports the outcome and the request has its own field.
    expect(result.keepPreviousGeneration).toBe(true);
    expect(result.requestedRetention).toBe(false);
    const retained = await target.readRecords('gen-phase5-a');
    expect(retained.descriptor?.status).toBe('superseded');
  });

  it('the source device keeps both of its own generations after an import into itself', async () => {
    resetLegacyStorage();
    const own = await createPopulatedDevice('kd-phase5-self-import');
    const before = await captureDeviceState(own.repository);
    const activeBefore = await own.repository.readGeneration(POPULATED_GENERATION_ID);
    const bytes = (await exportOf(own)).bytes;
    const result = await importInto(own.repository, bytes);

    expect(result.previousActiveGenerationId).toBe(POPULATED_GENERATION_ID);
    expect(result.reusedArchiveGenerationId).toBe(false);
    const descriptors = await own.repository.listGenerations();
    const ids = descriptors.map((entry) => entry.generationId).sort();
    // The prior generation, the generation that was active, and the one the
    // restore wrote: three, none deleted.
    expect(ids).toEqual([POPULATED_GENERATION_ID, PRIOR_GENERATION_ID, result.generationId].sort());
    const priorSnapshot = await own.repository.readRecords(PRIOR_GENERATION_ID);
    expect(priorSnapshot.records.subjects).toHaveLength(1);
    const activeRecordsBefore = await own.repository.readRecords(POPULATED_GENERATION_ID);
    const after = await captureDeviceState(own.repository);
    const movedPrior = diffDeviceStates(before, after).filter(
      (difference: { kind: string; where: string }) =>
        difference.kind === 'record' && difference.where.startsWith(`${PRIOR_GENERATION_ID}/`),
    );
    expect(movedPrior, describeDifferences(movedPrior)).toEqual([]);
    // The previously-active generation is now superseded, so its status changed -
    // that is the only change to it.
    const activeAfter = await own.repository.readGeneration(POPULATED_GENERATION_ID);
    // The generation that was active before the import was read *before* the
    // import, and the only thing that changed about it is its status.
    expect(activeBefore?.descriptor?.status).toBe('active');
    expect(activeAfter?.descriptor?.status).toBe('superseded');
    expect(activeAfter?.records.subjects).toHaveLength(3);
    // Its records are byte-for-byte what they were: only the status moved.
    expect(canonicalJsonStringify(activeAfter?.records)).toBe(
      canonicalJsonStringify(activeRecordsBefore.records),
    );
  });
});

// ── 4. Determinism ────────────────────────────────────────────────────────

describe('Phase 5 gate 10: the export is deterministic under a fixed clock', () => {
  it('two exports of the same generation with the same clock are byte-identical', async () => {
    const first = await exportOf(device);
    const second = await exportOf(device);
    expect(second.bytes.length).toBe(first.bytes.length);
    expect(second.bytes.every((byte, index) => byte === first.bytes[index])).toBe(true);
    expect(canonicalJsonStringify(second.manifest)).toBe(canonicalJsonStringify(first.manifest));
    expect(second.memberNames).toEqual(first.memberNames);
  });

  it('a different clock changes only the timestamps, and the member order never changes', async () => {
    const base = await exportOf(device, { now: '2026-01-02T03:04:05.000Z' });
    const later = await exportOf(device, { now: '2030-12-31T23:59:59.000Z' });
    expect(later.memberNames).toEqual(base.memberNames);
    expect(later.manifest.createdAt).not.toBe(base.manifest.createdAt);
    // The only member whose bytes moved is `state.json`, which carries the clock;
    // every content-addressed and index-addressed member is byte-identical.
    const baseByPath = new Map(base.manifest.members.map((member) => [member.path, member.sha256]));
    const movedPaths = later.manifest.members
      .filter((member) => baseByPath.get(member.path) !== member.sha256)
      .map((member) => member.path);
    expect(movedPaths).toEqual(['state.json']);
    // So the manifest's own content checksum does move with it, and the counts do
    // not.
    expect(later.manifest.contentChecksum).not.toBe(base.manifest.contentChecksum);
    expect(later.manifest.recordCounts).toEqual(base.manifest.recordCounts);
    expect(later.manifest.memberCount).toBe(base.manifest.memberCount);
    expect(later.manifest.attachmentBytes).toEqual(base.manifest.attachmentBytes);
    expect(later.bytes.length).not.toBe(base.bytes.length);
  });

  it('the member order is the layout, and it is stable across runs', async () => {
    const { memberNames } = await exportOf(device);
    expect(memberNames[0]).toBe('manifest.json');
    expect(memberNames[1]).toBe('state.json');
    expect(memberNames.slice(2).filter((name) => name.startsWith('attachments/'))).toHaveLength(2);
    expect(memberNames.filter((name) => name.startsWith('custom-sprites/'))).toHaveLength(3);
    expect(memberNames.filter((name) => name.startsWith('recovery/'))).toHaveLength(2);
    expect(memberNames).toEqual([...(await exportOf(device)).memberNames]);
  });
});

// ── 5. Attachment-byte resolution ─────────────────────────────────────────

describe('Phase 5 gate 10: how the export resolves attachment bytes', () => {
  it('with a caller-supplied map, every available payload becomes a member', async () => {
    const result = await exportOf(device);
    const members = new Map(readArchive(result.bytes).map((member) => [member.path, member.bytes]));
    for (const [attachmentId, source] of device.payloadBytes) {
      // Compared by content, not by identity: the archive's bytes are a fresh
      // buffer, so `===` would compare two different objects.
      const path = [...members.entries()].find(
        ([, bytes]) =>
          bytes.length === source.length && bytes.every((byte, index) => byte === source[index]),
      )?.[0];
      expect(path, attachmentId).toBeDefined();
      expect((path as string).startsWith('attachments/')).toBe(true);
      // ...and the member is named by the digest of the bytes it carries.
      const entry = result.manifest.members.find((member) => member.path === path);
      expect(entry?.sha256).toBe((path as string).slice('attachments/'.length));
    }
    // Two attachments share one payload, so three attachments are two members.
    expect(result.manifest.attachmentBytes.memberCount).toBe(2);
  });

  it('with no map at all, the generation mirror is the fallback and the export still succeeds', async () => {
    const result = await exportOf(device, { payloadBytes: null });
    // The fixture's generation carries the mirrored blob records, so the same two
    // members are produced with no caller-supplied bytes at all.
    expect(result.manifest.attachmentBytes.memberCount).toBe(2);
    expect(result.manifest.attachmentBytes.byteLength).toBe(
      (await exportOf(device)).manifest.attachmentBytes.byteLength,
    );
  });

  it('an archive whose state declares a stored attachment with no member is refused, not half-restored', async () => {
    // A `stored` attachment whose bytes the archive does not carry is a corrupt
    // archive, and the layout is closed: the member is declared, so a member that
    // is absent is a missing member. This is asserted so the boundary is visible -
    // the *reachable* case for an unrecoverable attachment is the one below, where
    // the state document itself says `external-only`.
    resetLegacyStorage();
    const bytes = (await exportOf(device)).bytes;
    const rebuilt = rebuildArchive(bytes, (manifest, state) => ({
      manifest: { ...manifest },
      state: { ...state },
    }));
    // Remove one attachment member from the archive without touching the manifest:
    // exactly the corruption a truncated or rewritten file produces.
    const members = readArchive(rebuilt).filter((member) => !member.path.startsWith('attachments/'));
    const firstAttachment = readArchive(rebuilt).find((member) => member.path.startsWith('attachments/'));
    expect(firstAttachment).toBeDefined();
    const withoutOne = writeArchive(members);
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(withoutOne);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).code).toBe('ARCHIVE_MEMBER_MISSING');
    expect((thrown as StorageV2Error).details.reason).toBe('missing-declared-member');
  });

  it('an archive whose state already says external-only is restored as external-only, and disclosed', async () => {
    // The reachable form of "these bytes are gone": the state document reports the
    // attachment as `external-only`, which is what Phase 4's migration writes when
    // it cannot recover a payload. The import must not invent a hash for it, must
    // not fail, and must disclose it - and the manifest's own histogram has to
    // agree, which is why the mutation below updates both.
    resetLegacyStorage();
    const bytes = (await exportOf(device)).bytes;
    const mutated = rebuildArchive(bytes, (manifest, state) => {
      const metadata = (state.attachmentMetadata as Record<string, unknown>[]).map((record) =>
        record.attachmentId === ATTACHMENT_IDS.storedThree
          ? { ...record, availability: 'external-only', contentHash: null }
          : record,
      );
      return {
        manifest: {
          ...manifest,
          recordCounts: { ...(manifest.recordCounts as Record<string, number>), attachments: 6 },
          externalOnlyAttachments: {
            count: 2,
            reasons: { 'bytes-not-recoverable': 1, 'historical-external-url': 1 },
          },
        },
        state: { ...state, attachmentMetadata: metadata },
      };
    });
    const preview = readFullDeviceArchive(mutated);
    expect(preview.externalOnlyCount).toBe(2);

    const target = await openFreshRepository('kd-phase5-declared-external-only');
    const result = await importInto(target, mutated);
    expect(result.activated).toBe(true);
    expect(result.externalOnlyAttachments.map((entry) => entry.attachmentId).sort()).toEqual(
      [ATTACHMENT_IDS.externalOne, ATTACHMENT_IDS.storedThree].sort(),
    );
    for (const disclosure of result.externalOnlyAttachments) {
      expect(disclosure.contentHash).toBeNull();
      expect(disclosure.byteLength).toBeNull();
      expect(isFreeOfLearnerContent(JSON.stringify(disclosure))).toBe(true);
    }
    const snapshot = await target.readRecords(result.generationId);
    const third = snapshot.records.attachmentMetadata.find(
      (envelope) => envelope.value.attachmentId === ATTACHMENT_IDS.storedThree,
    );
    expect(third?.value.availability).toBe('external-only');
    expect(third?.value.contentHash).toBeNull();
    expect(
      snapshot.records.attachmentBlobs.filter(
        (envelope) => envelope.value.attachmentId === ATTACHMENT_IDS.storedThree,
      ),
    ).toEqual([]);
    expect((await target.validateGeneration(result.generationId)).problems).toEqual([]);
  });

  it('a declared hash that disagrees with the bytes is disclosed, not trusted', async () => {
    resetLegacyStorage();
    const repository = await openFreshRepository('kd-phase5-bad-hash');
    const staged = structuredClone(device.staged) as typeof device.staged;
    // The metadata claims one digest; the mirrored bytes hash to another.
    const wrongHash = 'f'.repeat(64);
    staged.attachmentMetadata = staged.attachmentMetadata.map((record) =>
      record.attachmentId === ATTACHMENT_IDS.storedThree
        ? { ...record, contentHash: wrongHash }
        : record,
    );
    await repository.stageGeneration({
      generationId: POPULATED_GENERATION_ID,
      source: 'initial',
      records: staged,
    });
    await repository.activateGeneration(POPULATED_GENERATION_ID);
    const thin: PopulatedDevice = { ...device, repository, generationId: POPULATED_GENERATION_ID };
    resetLegacyStorage();

    const result = await exportOf(thin);
    // Every member is named by the digest of the bytes it carries, so the archive
    // is content-addressed throughout...
    const attachmentMembers = result.manifest.members.filter((member) =>
      member.path.startsWith('attachments/'),
    );
    for (const member of attachmentMembers) {
      expect(member.path.slice('attachments/'.length)).toBe(member.sha256);
    }
    expect(attachmentMembers.some((member) => member.path.endsWith(wrongHash))).toBe(false);
    // ...and the attachment whose bytes do not hash to the digest its own record
    // declares is disclosed rather than included under a name its record does not
    // use. Including it would have produced an archive its own importer would have
    // to refuse, because the restored record would name a member that is not there.
    expect(attachmentMembers).toHaveLength(1);
    expect(result.externalOnlyAttachments.map((entry) => entry.attachmentId)).toContain(
      ATTACHMENT_IDS.storedThree,
    );
    expect(
      result.externalOnlyAttachments.find((entry) => entry.attachmentId === ATTACHMENT_IDS.storedThree)
        ?.reason,
    ).toBe('bytes-not-recoverable');
    const target = await openFreshRepository('kd-phase5-bad-hash-target');
    const restored = await importInto(target, result.bytes);
    const metadata = (await target.readRecords(restored.generationId)).records.attachmentMetadata;
    const third = metadata.find((envelope) => envelope.value.attachmentId === ATTACHMENT_IDS.storedThree);
    expect(third?.value.availability).toBe('external-only');
    expect(third?.value.contentHash).toBeNull();
  });

  it('the device-local attachment store is resolvable into a payload map', async () => {
    // The real path a caller takes: store bytes the way the note editor does, then
    // hand the resolved map to the export.
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_IDS.alpha,
      roomId: 'room-data-gate-alpha-root',
      bytes: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/png' }),
      mimeType: 'image/png',
      fileName: 'synthetic-phase5.png',
      now: DEVICE_NOW,
    });
    const resolved = await resolveDeviceLocalPayloadBytes([stored.attachmentId, 'att-does-not-exist']);
    expect([...resolved.keys()]).toEqual([stored.attachmentId]);
    const bytes = resolved.get(stored.attachmentId) as Uint8Array;
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // An unknown id is simply absent, so the export discloses it rather than
    // inventing bytes for it.
    expect(resolved.has('att-does-not-exist')).toBe(false);
    closeDeviceLocalAttachmentStore();
  });
});

// ── 6. Inspection touches no stored data ──────────────────────────────────

describe('Phase 5 gate 10: inspection has no side effects', () => {
  it('reading a preview leaves the whole device byte-for-byte identical', async () => {
    const bytes = (await exportOf(device)).bytes;
    const before = await captureDeviceState(device.repository);
    const beforeFingerprint = fingerprintOf(before);

    const preview = readFullDeviceArchive(bytes);
    const inspection = inspectFullDeviceArchive(bytes);
    const contents = readFullDeviceArchiveContents(bytes);

    const after = await captureDeviceState(device.repository);
    expect(fingerprintOf(after)).toBe(beforeFingerprint);
    expect(diffDeviceStates(before, after), describeDifferences(diffDeviceStates(before, after))).toEqual([]);
    expect(inspection.ok).toBe(true);
    expect(contents.preview).toEqual(preview);
  });

  it('the preview shows counts and disclosures and no learner content at all', async () => {
    const bytes = (await exportOf(device)).bytes;
    const preview = readFullDeviceArchive(bytes);
    // Everything a Data Center may show before the learner commits, and nothing
    // else. The serialized preview is asserted free of learner content, which is
    // the property that makes it safe to render or to attach to a bug report.
    expect(preview.recordCounts.subjects).toBe(3);
    expect(preview.recordCounts.sessions).toBe(4);
    expect(preview.recordCounts.attachments).toBe(7);
    expect(preview.recordCounts.customSprites).toBe(3);
    expect(preview.recordCounts.recovery).toBe(2);
    expect(preview.recordCounts.migrationReceipts).toBe(1);
    expect(preview.attachmentBytes.memberCount).toBe(2);
    expect(preview.totalMemberCount).toBe(preview.memberCount + 1);
    expect(preview.externalOnlyCount).toBe(1);
    expect(preview.externalOnlyAttachments).toHaveLength(1);
    expect(preview.externalOnlyAttachments[0]?.attachmentId).toBe(ATTACHMENT_IDS.externalOne);
    expect(preview.externalOnlyAttachments[0]?.contentHash).toBeNull();
    expect(preview.subjectSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(preview.storageGenerationFormatVersion).toBe(STORAGE_V2_GENERATION_FORMAT_VERSION);
    expect(preview.formatVersion).toBe(DATA_PRODUCT_FORMAT_VERSIONS.kdbak);
    const serialized = JSON.stringify(preview);
    expect(isFreeOfLearnerContent(serialized), serialized.slice(0, 200)).toBe(true);
  });

  it('a corrupt archive is reported, not thrown, by the non-throwing inspection', async () => {
    const inspection = inspectFullDeviceArchive(new Uint8Array([1, 2, 3, 4]));
    expect(inspection.ok).toBe(false);
    if (inspection.ok) return;
    expect(inspection.error.code).toBe('ARCHIVE_MALFORMED');
    expect(isFreeOfLearnerContent(JSON.stringify(inspection.error))).toBe(true);
    // And the throwing read refuses the same bytes with the same code.
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(new Uint8Array([1, 2, 3, 4]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).code).toBe(inspection.error.code);
  });
});

// ── 7. Directory entries and hostile names ────────────────────────────────

describe('Phase 5 gate 10: directory entries are metadata, and unsafe names are still refused', () => {
  /** Rebuild a valid archive with directory entries added under every prefix. */
  function withDirectoryEntries(bytes: Uint8Array): Uint8Array {
    const members = readArchive(bytes);
    const zippable: Record<string, [Uint8Array, { level: 0 }]> = {
      'attachments/': [new Uint8Array(0), { level: 0 }],
      'custom-sprites/': [new Uint8Array(0), { level: 0 }],
      'recovery/': [new Uint8Array(0), { level: 0 }],
    };
    for (const member of members) zippable[member.path] = [member.bytes, { level: 0 }];
    return rawFflateZip(Object.entries(zippable).map(([path, [content]]) => ({ path, bytes: content })));
  }

  it('a prefix directory entry is accepted, ignored, and never becomes a member', async () => {
    const bytes = withDirectoryEntries((await exportOf(device)).bytes);
    const preview = readFullDeviceArchive(bytes);
    expect(preview.ignoredDirectoryEntries).toEqual(['attachments/', 'custom-sprites/', 'recovery/']);
    // The member set is unchanged, and the manifest still counts the same members.
    const plain = readFullDeviceArchive((await exportOf(device)).bytes);
    expect(preview.memberCount).toBe(plain.memberCount);
    expect(preview.members.map((member) => member.path)).toEqual(plain.members.map((member) => member.path));
    // ...and it imports.
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-directory-entries');
    const result = await importInto(target, bytes);
    expect(result.activated).toBe(true);
    expect((await target.validateGeneration(result.generationId)).problems).toEqual([]);
  });

  it('a directory entry under a prefix the layout does not define is refused', () => {
    const bytes = rawFflateZip([
      { path: 'manifest.json', bytes: utf8('{}') },
      { path: 'subjects/', bytes: new Uint8Array(0) },
    ]);
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).details.reason).toBe('empty-segment');
  });

  it('a real zip-slip member is still rejected, on read', () => {
    for (const path of ['../escape.json', 'a/../../escape.json', '/etc/passwd', 'C:/x.json', 'a\\b.json']) {
      const bytes = rawFflateZip([
        { path: 'manifest.json', bytes: utf8('{}') },
        { path, bytes: utf8('{}') },
      ]);
      let thrown: unknown = null;
      try {
        readFullDeviceArchive(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, path).toBeInstanceOf(StorageV2Error);
      expect((thrown as StorageV2Error).code, path).toBe('ARCHIVE_UNSAFE_PATH');
    }
  });

  it('a member whose recorded mode says symlink or directory is refused', () => {
    const manifest = utf8('{}');
    for (const [mode, expected] of [
      [0o120777, 'symlink-member'],
      [0o040755, 'directory-entry'],
    ] as const) {
      const bytes = rawZip([
        { name: 'manifest.json', bytes: manifest },
        { name: 'custom-sprites/000001.svg', unixMode: mode, bytes: utf8('/etc/hostname') },
      ]);
      let thrown: unknown = null;
      try {
        readFullDeviceArchive(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(mode)).toBeInstanceOf(StorageV2Error);
      expect((thrown as StorageV2Error).details.reason, String(mode)).toBe(expected);
    }
  });

  it('the member-name classifier is total, and it never accepts a descriptive name', () => {
    for (const path of [
      'manifest.json',
      'state.json',
      `attachments/${'a'.repeat(64)}`,
      'custom-sprites/000001.override',
      'recovery/000001.json',
      'attachments/',
    ]) {
      expect(classifyFullDeviceMemberName(path).kind, path).not.toBe('rejected');
    }
    for (const [path, reason] of [
      ['../escape.json', 'parent-traversal'],
      ['/etc/passwd', 'absolute-path'],
      ['C:/x.json', 'drive-letter'],
      ['a\\b.json', 'backslash-separator'],
      ['subjects/000001.json', 'unknown-prefix'],
      ['attachments/not-a-hash.png', 'descriptive-member-name'],
      ['custom-sprites/warden-override.json', 'descriptive-member-name'],
      ['attachments/a/b/c', 'nested-too-deep'],
      ['toString', 'not-under-a-member-prefix'],
      ['attachments//x', 'empty-segment'],
    ] as const) {
      expect(classifyFullDeviceMemberName(path), path).toEqual({ kind: 'rejected', reason });
    }
  });
});

// ── 8. Version refusals ───────────────────────────────────────────────────

describe('Phase 5 gate 10: the three version contracts are refused separately', () => {
  /**
   * One version field changed, in both documents.
   *
   * The input is the product's own archive, so this is a real archive with one
   * contract altered rather than a hand-built fixture, and the manifest is
   * recomputed so only the intended change is present.
   */
  function withVersions(overrides: {
    formatVersion?: number;
    storageGenerationFormatVersion?: number;
    subjectSchemaVersion?: string;
  }): Uint8Array {
    return versionMutated(overrides);
  }

  it('a newer or older subject schema is refused, in the manifest and in the state', async () => {
    const bytes = (await exportOf(device)).bytes;
    for (const version of ['99.0.0', '1.0.0', '2.0.0']) {
      let thrown: unknown = null;
      try {
        readFullDeviceArchive(withVersions({ subjectSchemaVersion: version }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, version).toBeInstanceOf(StorageV2Error);
      const failure = thrown as StorageV2Error;
      expect(failure.code, version).toBe('VALIDATION_FAILED');
      expect(failure.details.reason, version).toBe('unsupported-subject-schema-version');
    }
    // And the real one is accepted, so the refusal is not vacuous.
    expect(readFullDeviceArchive(bytes).subjectSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('an unknown product format version and an unknown storage format version are refused separately', () => {
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(withVersions({ formatVersion: 2 }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as StorageV2Error).details.reason).toBe('unsupported-product-format-version');

    thrown = null;
    try {
      readFullDeviceArchive(withVersions({ storageGenerationFormatVersion: 2 }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as StorageV2Error).details.reason).toBe('unsupported-storage-format-version');
  });

  it('the manifest key set is closed at format version 1, and a new key is refused', () => {
    let thrown: unknown = null;
    try {
      readFullDeviceArchive(withManifestMutation((manifest) => ({ ...manifest, extraKey: 1 })));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as StorageV2Error).code).toBe('VALIDATION_FAILED');
    expect((thrown as StorageV2Error).details.reason).toBe('manifest-unexpected-field');
  });
});

// ── 9. Shape and result contracts ─────────────────────────────────────────

/**
 * Rebuild a product archive with a different `state.json`, manifest resealed.
 *
 * Every declared count, length and digest is recomputed, so a resealed archive is
 * indistinguishable from an export except for the intended change - which is the
 * only way a test of that change can be trusted.
 */
function resealArchiveState(
  archive: Uint8Array,
  state: Record<string, unknown>,
  recordCounts: Record<string, number>,
): Uint8Array {
  const manifest = JSON.parse(new TextDecoder().decode(
    readArchive(archive).find((member) => member.path === 'manifest.json')!.bytes,
  )) as Record<string, unknown>;
  const others = readArchive(archive).filter(
    (member) => member.path !== 'manifest.json' && member.path !== 'state.json',
  );
  const stateBytes = new TextEncoder().encode(canonicalJsonStringify(state));
  const entries = [
    ...others.map((member) => ({
      path: member.path,
      byteLength: member.bytes.byteLength,
      sha256: sha256Hex(member.bytes),
    })),
    { path: 'state.json', byteLength: stateBytes.byteLength, sha256: sha256Hex(stateBytes) },
  ];
  const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
  const resealed = {
    ...manifest,
    recordCounts,
    memberCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: sha256Hex(
      new TextEncoder().encode(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n')),
    ),
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    members: entries,
  };
  return writeArchive([
    { path: 'manifest.json', bytes: new TextEncoder().encode(canonicalJsonStringify(resealed)) },
    { path: 'state.json', bytes: stateBytes },
    ...others.map((member) => ({ path: member.path, bytes: member.bytes })),
  ]);
}

/**
 * Rebuild a product archive with a different `sourceGenerationId`, so a test can
 * ask the importer to adopt a label of its choosing.
 */
function resealSourceGeneration(archive: Uint8Array, sourceGenerationId: string): Uint8Array {
  const state = JSON.parse(new TextDecoder().decode(
    readArchive(archive).find((member) => member.path === 'state.json')!.bytes,
  )) as Record<string, unknown>;
  const manifest = JSON.parse(new TextDecoder().decode(
    readArchive(archive).find((member) => member.path === 'manifest.json')!.bytes,
  )) as { recordCounts: Record<string, number> };
  return resealArchiveState(archive, { ...state, sourceGenerationId }, {
    ...manifest.recordCounts,
    migrationReceipts: Array.isArray(state.migrationReceipts) ? state.migrationReceipts.length : 0,
  });
}

describe('Phase 5 gate 10: a generation label is never an Object.prototype key', () => {
  it('an Object.prototype key in the archive is never adopted as the new generation id', async () => {
    // A generation id is an IndexedDB *key*, so a label like `__proto__` or
    // `constructor` is not merely ugly: it resolves to a property of
    // `Object.prototype` for any lookup that has not been hardened, and `__proto__`
    // assigns rather than creates. The reader has refused these as a member *name*
    // since Phase 5; the same rule has to cover a generation *label*, which is the
    // same string in a more dangerous position.
    const archive = (await exportOf(device)).bytes;
    for (const label of Object.getOwnPropertyNames(Object.prototype)) {
      const target = await openFreshRepository(`kd-label-${label}`);
      const result = await importInto(target, resealSourceGeneration(archive, label));
      // Never adopted, and never written.
      expect(result.reusedArchiveGenerationId, label).toBe(false);
      expect(result.generationId, label).not.toBe(label);
      const generations = await target.listGenerations();
      expect(generations.some((entry) => entry.generationId === label), label).toBe(false);
      // The chosen label is safe to hold: code-shaped, so it round-trips as a key
      // and as a record id with no prototype lookup anywhere.
      expect(result.generationId, label).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      // ...and the restore itself still succeeded, which is the half the defect
      // broke. Before the fix a `__proto__` label either wrote a generation that
      // could not be read back or failed activation outright.
      expect((await target.readRecords(result.generationId)).descriptor?.status, label).toBe('active');
    }
  });

  it('the receipts are re-pointed for a refused label, and the result discloses it', async () => {
    // D2 and D6 meet here: a label that cannot be adopted is a case where a receipt
    // has to be re-pointed, and D6's disclosure is what tells a caller that the
    // receipt's own checksums now describe another device.
    const target = await openFreshRepository('kd-label-receipts');
    const result = await importInto(
      target,
      resealSourceGeneration((await exportOf(device)).bytes, 'constructor'),
    );
    expect(result.migrationReceiptRepointed).toBe(true);
    expect(result.receiptProvenanceNote).toBe('receipts-repointed-provenance-preserved');
    const receipts = await target.listMigrationReceipts(result.generationId);
    expect(receipts[0]?.stagedGenerationId).toBe(result.generationId);
    expect(receipts[0]?.receiptId).toBe('receipt-data-gate-0001');
  });
});

describe('Phase 5 gate 10: the shape the product writes and reports', () => {
  it('the state document carries every key the plan lists, and three separate versions', async () => {
    const contents = readFullDeviceArchiveContents((await exportOf(device)).bytes);
    const state = contents.state;
    for (const key of STATE_DOCUMENT_KEYS) {
      expect(key in state, key).toBe(true);
    }
    for (const section of FULL_DEVICE_STATE_SECTIONS) {
      expect(Array.isArray(state[section]), section).toBe(true);
      expect((state[section] as unknown[]).length, section).toBeGreaterThan(0);
    }
    // Three version keys, three values, two types - and no single `version` key
    // that could stand in for them.
    expect(state.version).toBeUndefined();
    expect(state.formatVersion).toBe(DATA_PRODUCT_FORMAT_VERSIONS.kdbak);
    expect(state.storageGenerationFormatVersion).toBe(STORAGE_V2_GENERATION_FORMAT_VERSION);
    expect(state.subjectSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // The two the plan names separately are document keys in their own right.
    expect(state.locale).toBe('en-GB');
    expect((state.questState as Record<string, unknown>).questId).toBe('quest-data-gate-synthetic');
    // Attachment bytes are members, not a section: the document carries metadata
    // that names a content hash and the hash is resolved against a member.
    expect('attachmentBlobs' in state).toBe(false);
    expect(Array.isArray(state.attachmentMetadata)).toBe(true);
  });

  it('the manifest has exactly the twelve pinned keys, in the manifest member', async () => {
    const result = await exportOf(device);
    const members = readArchive(result.bytes);
    const manifestMember = members.find((member) => member.path === 'manifest.json');
    expect(manifestMember).toBeDefined();
    expect(Object.keys(JSON.parse(new TextDecoder().decode(manifestMember?.bytes))).sort()).toEqual(
      [...FULL_DEVICE_MANIFEST_KEYS].sort(),
    );
    // The counting rule: `memberCount` is `members.length`, and `members[]` omits
    // `manifest.json` because a member cannot contain its own digest.
    expect(result.manifest.memberCount).toBe(result.manifest.members.length);
    expect(result.manifest.members.some((member) => member.path === 'manifest.json')).toBe(false);
    expect(members.length).toBe(result.manifest.memberCount + 1);
    expect(result.manifest.totalBytes).toBe(
      result.manifest.members.reduce((total, member) => total + member.byteLength, 0),
    );
  });

  it('the export returns bytes and a content-free file name, and downloads nothing', async () => {
    const result = await exportOf(device);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    // Plan section 12, rule 6: nothing learner-derived may reach a filename. This
    // one is a constant, which is the only form that satisfies that.
    expect(result.fileName).toBe(FULL_DEVICE_BACKUP_FILE_NAME);
    expect(result.fileName.endsWith('.kdbak')).toBe(true);
    expect(isFreeOfLearnerContent(result.fileName)).toBe(true);
  });

  it('the import reports the active subject and does not apply it', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-active-subject');
    const bytes = await exportFullDeviceBackup({
      repository: device.repository,
      generationId: POPULATED_GENERATION_ID,
      now: DEVICE_NOW,
      payloadBytes: device.payloadBytes,
      activeSubjectId: SUBJECT_IDS.gamma,
    }).then((result) => result.bytes);
    expect(readFullDeviceArchive(bytes).activeSubjectId).toBe(SUBJECT_IDS.gamma);

    const before = await captureDeviceState(target);
    const result = await importInto(target, bytes);
    expect(result.restoredActiveSubjectId).toBe(SUBJECT_IDS.gamma);
    // The pointer is synchronously readable legacy-mirror state that the storage-v2
    // repositories deliberately do not own, so nothing was written for it.
    const after = await captureDeviceState(target);
    const pointerMoves = diffDeviceStates(before, after).filter(
      (difference: { kind: string }) =>
        difference.kind === 'legacy-key' || difference.kind === 'legacy-value',
    );
    expect(pointerMoves, describeDifferences(pointerMoves)).toEqual([]);
  });

  it('the import reports the receipts it carried and mints none of its own', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-receipts');
    const result = await importInto(target, (await exportOf(device)).bytes);
    expect(result.migrationReceiptCount).toBe(1);
    expect(result.receiptNote).toBe('restore-mints-no-receipt');
    const receipts = await target.listMigrationReceipts(result.generationId);
    expect(receipts).toHaveLength(1);
    // The carried receipt is the archive's own, byte for byte, because the
    // archive's generation label was free on this device and was reused.
    expect(receipts[0]?.receiptId).toBe('receipt-data-gate-0001');
    expect(receipts[0]?.stagedGenerationId).toBe(result.generationId);
    expect(receipts[0]?.migrationId).toBe('legacy-localstorage-to-storage-v2');
    // The label was adopted, so no receipt was re-pointed and there is no
    // provenance mismatch to disclose. The flag reports an action taken, so it is
    // false here rather than "no rule fired".
    expect(result.migrationReceiptRepointed).toBe(false);
    expect(result.receiptProvenanceNote).toBe('receipts-carried-verbatim');
  });

  it('an occupied label re-points the receipts, and the result says so rather than repairing them', async () => {
    // The disclosure is a *report*, not a repair. Rewriting the receipt's own
    // checksums to agree with this device would forge a record of a migration this
    // device never ran and would erase the evidence that the data came from
    // somewhere else, so the mismatch is left in place and named instead.
    resetLegacyStorage();
    const target = await openFreshRepository('kd-receipts-occupied');
    const occupied = 'gen-phase5-already-here';
    await target.stageGeneration({ generationId: occupied, source: 'initial', records: {} });
    await target.activateGeneration(occupied);
    const result = await importInto(
      target,
      resealSourceGeneration((await exportOf(device)).bytes, occupied),
    );

    expect(result.reusedArchiveGenerationId).toBe(false);
    expect(result.generationId).not.toBe(occupied);
    expect(result.migrationReceiptRepointed).toBe(true);
    expect(result.receiptProvenanceNote).toBe('receipts-repointed-provenance-preserved');
    // The receipt was re-pointed...
    const receipts = await target.listMigrationReceipts(result.generationId);
    expect(receipts[0]?.stagedGenerationId).toBe(result.generationId);
    // ...and its own checksums are deliberately the source device's, so it
    // disagrees with the generation it now names. That is the disclosed state.
    const descriptor = await target.readGeneration(result.generationId);
    expect(receipts[0]?.contentChecksum).not.toBe(descriptor?.descriptor?.contentChecksum);
    // The label the replaced generation held is untouched: nothing was merged.
    expect((await target.readGeneration(occupied))?.descriptor?.status).toBe('superseded');
  });

  it('a relationship warning is disclosed and does not refuse the restore', async () => {
    // Storage-v2 treats a progression record whose subject no longer exists as a
    // `warning`, not an `error`, because dropping the record would be destructive
    // and activating without disclosing it would be dishonest. A restore has to
    // behave the same way: refusing a backup over a dangling reference would
    // strand a learner's XP and fish on the device they are trying to leave.
    resetLegacyStorage();
    const repository = await openFreshRepository('kd-phase5-warnings');
    const staged = structuredClone(device.staged) as typeof device.staged;
    const orphan = 'subject-data-gate-deleted';
    staged.progression = [
      ...staged.progression,
      {
        subjectId: orphan,
        sourceVersion: 3 as const,
        rank: 'Novice' as const,
        xpTotal: 11,
        bySubject: { [orphan]: { subjectId: orphan, xpTotal: 11, rank: 'Novice', badges: [], inventory: [], equippedItems: [], collectedNotes: [], streakCount: 0, subjectsMastered: 0, roomsCleared: 0, reviewPasses: 0, artifacts: 0, bossesDefeated: 0, fishCollection: [] } },
        crossSubjectAchievements: [],
      },
    ];
    await repository.stageGeneration({ generationId: POPULATED_GENERATION_ID, source: 'initial', records: staged });
    await repository.activateGeneration(POPULATED_GENERATION_ID);
    const sourceValidation = await repository.validateGeneration(POPULATED_GENERATION_ID);
    expect(sourceValidation.ok).toBe(true);
    expect(sourceValidation.problems.map((problem) => problem.severity)).toEqual(['warning']);
    const warningDevice: PopulatedDevice = { ...device, repository, generationId: POPULATED_GENERATION_ID };
    resetLegacyStorage();

    const target = await openFreshRepository('kd-phase5-warnings-target');
    const result = await importInto(target, (await exportOf(warningDevice)).bytes);
    expect(result.activated).toBe(true);
    // The condition is disclosed rather than swallowed, with a code and a count.
    expect(result.disclosedWarnings.map((problem) => problem.code)).toContain('unknown-subject-reference');
    expect(result.disclosedWarnings.every((problem) => problem.severity === 'warning')).toBe(true);
    // The dangling record is still there: disclosed, not dropped.
    const snapshot = await target.readRecords(result.generationId);
    expect(snapshot.records.progression.map((envelope) => envelope.value.subjectId)).toContain(orphan);
  });

  it('a manifest or state member that is not an object is refused with a typed error', async () => {
    // A detail that is not code-shaped would make the `StorageV2Error`
    // constructor throw a `TypeError` instead, turning a typed refusal into an
    // untyped one. Both are asserted as `StorageV2Error` for that reason.
    for (const [path, value] of [
      ['manifest.json', '[]'],
      ['manifest.json', '"a string"'],
      ['state.json', '[]'],
      ['state.json', '42'],
    ] as const) {
      const bytes = rebuildArchive((await exportOf(device)).bytes, (manifest, state) => ({
        manifest: { ...manifest },
        state: { ...state },
      }));
      const members = readArchive(bytes).map((member) =>
        member.path === path ? { path: member.path, bytes: utf8(value) } : member,
      );
      const rebuilt = writeArchive(members);
      let thrown: unknown = null;
      try {
        readFullDeviceArchive(rebuilt);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${path} ${value}`).toBeInstanceOf(StorageV2Error);
      expect((thrown as StorageV2Error).code, `${path} ${value}`).toBe('VALIDATION_FAILED');
    }
  });

  it('an empty generation exports and imports without a record of any kind', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-empty');
    await target.stageGeneration({ generationId: 'gen-phase5-empty', source: 'initial', records: {} });
    await target.activateGeneration('gen-phase5-empty');
    const emptyDevice: PopulatedDevice = { ...device, repository: target, generationId: 'gen-phase5-empty' };
    resetLegacyStorage();

    const result = await exportOf(emptyDevice);
    expect(result.manifest.memberCount).toBe(1);
    expect(result.manifest.recordCounts.subjects).toBe(0);
    expect(result.manifest.externalOnlyAttachments.count).toBe(0);

    const destination = await openFreshRepository('kd-phase5-empty-target');
    const restored = await importInto(destination, result.bytes);
    expect(restored.activated).toBe(true);
    expect((await destination.validateGeneration(restored.generationId)).problems).toEqual([]);
  });

  it('a refused import leaves a staged generation nothing behind', async () => {
    resetLegacyStorage();
    const target = await openFreshRepository('kd-phase5-no-orphan');
    const before = await captureDeviceState(target);
    await expect(importInto(target, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]))).rejects.toBeInstanceOf(
      StorageV2Error,
    );
    const after = await captureDeviceState(target);
    expect(fingerprintOf(after)).toBe(fingerprintOf(before));
    expect(after.descriptors).toEqual([]);
  });
});

// ── 9. Reaching the live device ──────────────────────────────────────────

describe('Phase 5 gate 10: the product publishes the live handle a screen needs', () => {
  it('resolveLiveDeviceRepository returns the handle the bootstrap published', async () => {
    const handle = await openFreshRepository('kd-phase5-live-selected');
    // Before anything selects it, there is no handle - and that is the default,
    // because plan section 11 keeps `legacy` the production default.
    resetRepositorySelection();
    expect(currentRepositorySelection()).toBe('legacy');
    expect(await resolveLiveDeviceRepository()).toBeNull();

    selectStorageV2Repository(handle);
    expect(currentRepositorySelection()).toBe('v2');
    expect(await resolveLiveDeviceRepository()).toBe(handle);
    // The very same object, not a copy and not a re-open: the accessor hands over
    // the live handle, because the product's request type is a repository handle.
    expect(await resolveLiveDeviceRepository()).toBe(await resolveLiveDeviceRepository());
  });

  it('resolveLiveDeviceRepository returns null, not a throw, on the legacy path', async () => {
    // A caller on the legacy path must get a clean "nothing to back up" rather than
    // an error it would have to classify - and the legacy path is the *default*, so
    // this is the likely answer rather than the exceptional one.
    resetRepositorySelection();
    let resolved: unknown = 'unset';
    try {
      resolved = await resolveLiveDeviceRepository();
    } catch (error) {
      throw new Error(`resolveLiveDeviceRepository threw on the legacy path: ${String(error)}`);
    }
    expect(resolved).toBeNull();
  });

  it('readLiveActiveGenerationId names the live generation, and is null on the legacy path', async () => {
    resetRepositorySelection();
    expect(await readLiveActiveGenerationId()).toBeNull();

    const handle = await openFreshRepository('kd-phase5-live-generation');
    // Selected, but nothing activated yet: still null, and still not an error.
    selectStorageV2Repository(handle);
    expect(await readLiveActiveGenerationId()).toBeNull();

    await handle.stageGeneration({ generationId: 'gen-phase5-live-0001', source: 'initial', records: {} });
    await handle.activateGeneration('gen-phase5-live-0001');
    expect(await readLiveActiveGenerationId()).toBe('gen-phase5-live-0001');

    // And the id moves with the pointer, so a caller cannot cache it.
    await handle.stageGeneration({ generationId: 'gen-phase5-live-0002', source: 'local-edit', records: {} });
    await handle.activateGeneration('gen-phase5-live-0002');
    expect(await readLiveActiveGenerationId()).toBe('gen-phase5-live-0002');

    // ...and back to null the moment the selection is withdrawn, which is the
    // Phase 5 rollback and the pre-bootstrap default.
    resetRepositorySelection();
    expect(await readLiveActiveGenerationId()).toBeNull();
  });

  it('the two accessors together are enough to export the live generation', async () => {
    // The end-to-end shape a screen uses: two lazy accessors, one generation id,
    // and nothing else. A screen that has to reach storage-v2 itself is the
    // problem the accessors exist to remove.
    resetLegacyStorage();
    const handle = await openFreshRepository('kd-phase5-live-end-to-end');
    await handle.stageGeneration({
      generationId: POPULATED_GENERATION_ID,
      source: 'initial',
      records: structuredClone(device.staged) as typeof device.staged,
    });
    await handle.activateGeneration(POPULATED_GENERATION_ID);
    selectStorageV2Repository(handle);
    resetLegacyStorage();

    const repository = await resolveLiveDeviceRepository();
    const generationId = await readLiveActiveGenerationId();
    expect(repository).toBe(handle);
    expect(generationId).toBe(POPULATED_GENERATION_ID);

    const result = await exportFullDeviceBackup({
      repository: repository as StorageV2Repository,
      generationId: generationId as string,
      now: DEVICE_NOW,
      payloadBytes: device.payloadBytes,
      activeSubjectId: null,
    });
    expect(result.manifest.recordCounts.subjects).toBe(3);

    const restored = await importFullDeviceBackup({
      repository: repository as StorageV2Repository,
      bytes: result.bytes,
      now: DEVICE_NOW,
      keepPreviousGeneration: true,
    });
    expect(restored.activated).toBe(true);
    expect(await readLiveActiveGenerationId()).toBe(restored.generationId);
  });

  it('no product module statically imports an opening module for real', () => {
    // The boundary the accessors must not break: a screen reaches the product
    // lazily, and the product reaches storage-v2 lazily, so nothing here can put
    // the repository or the database in an entry chunk.
    //
    // A *type-only* import of an opening module is fine and expected - the product's
    // request type is a `StorageV2Repository` - because it is erased at build. A
    // static **value** import is not, and that is what this asserts.
    for (const path of productModules()) {
      for (const edge of productEdges(path)) {
        const target = productResolveTarget(path, edge.specifier);
        if (target === null) continue;
        if (!OPENING_STORAGE_V2_MODULES.includes(target)) continue;
        expect(edge.kind, `${path} -> ${edge.specifier}`).not.toBe('value');
      }
    }
  });

  it('the live-repository accessor reaches the selection module dynamically, and the detector bites', () => {
    // Narrower than the test above, and stated in the exact form the boundary
    // needs: the accessor must not become a static edge the day someone tidies it.
    const repositorySelection = 'src/services/persistence/v2/repositorySelection.ts';
    const naming = productModules().filter(
      (path) =>
        productEdges(path).some(
          (edge) => productResolveTarget(path, edge.specifier) === repositorySelection,
        ),
    );
    // Exactly one module needs the selection, and it needs it once.
    expect(naming).toEqual(['src/services/persistence/products/fullDeviceBackup.ts']);
    for (const path of naming) {
      const edges = productEdges(path).filter(
        (edge) => productResolveTarget(path, edge.specifier) === repositorySelection,
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]?.kind, path).toBe('dynamic');
    }

    // The positive control, run through the *same* extractor: a static edge to the
    // same module is classified `value`, so the assertion above is not passing
    // because nothing was found.
    const plantedStatic = productEdgesIn(
      [
        "import { currentStorageV2Repository } from '@/services/persistence/v2/repositorySelection';",
        'export const get = currentStorageV2Repository;',
      ].join('\n'),
    );
    expect(plantedStatic.map((edge) => edge.kind)).toEqual(['value']);
    // ...and the dynamic form of the same import is classified `dynamic`.
    const plantedDynamic = productEdgesIn(
      "const selection = await import('@/services/persistence/v2/repositorySelection');",
    );
    expect(plantedDynamic.map((edge) => edge.kind)).toEqual(['dynamic']);
    // ...and a type-only import is distinguished from both, which is the whole
    // point of the classifier and the reason the planted control has three cases.
    const plantedTypeOnly = productEdgesIn(
      "import type { StorageV2Repository } from '@/services/persistence/v2/repository';",
    );
    expect(plantedTypeOnly.map((edge) => edge.kind)).toEqual(['type-only']);
  });
});

// ── 10. Renderer neutrality and no egress ────────────────────────────────

describe('Phase 5 gate 10: the product tree is renderer-neutral and cannot send anything', () => {
  const FORBIDDEN_RENDERER = [
    /\bfrom\s*['"]phaser['"]/,
    /\bfrom\s*['"]pixi\.js/,
    /\bfrom\s*['"]@pixi\//,
    /\bfrom\s*['"]@\/game\b/,
    /\bfrom\s*['"][^'"]*\/game\//,
  ];
  const FORBIDDEN_EGRESS = [
    /\bnavigator\s*\.\s*share\s*\(/,
    /\bnavigator\s*\.\s*canShare\s*\(/,
    /\bcreateObjectURL\s*\(/,
    /\bfetch\s*\(/,
    /\bnew\s+XMLHttpRequest\s*\(/,
    /\bnew\s+FormData\s*\(/,
    /\bsendBeacon\s*\(/,
    /\bnew\s+WebSocket\s*\(/,
    /\bnew\s+EventSource\s*\(/,
    /\bnew\s+Worker\s*\(/,
    /\bwindow\s*\.\s*open\s*\(/,
    /\blocation\s*\.\s*(?:assign|replace)\s*\(/,
    /\bdocument\s*\.\s*createElement\s*\(/,
    /\bconsole\s*\./,
    /\blocalStorage\b/,
  ];

  it('the product modules are the two the plan names, and they import no renderer', () => {
    const modules = productModules();
    expect(modules).toEqual([
      'src/services/persistence/products/archiveValidation.ts',
      'src/services/persistence/products/fullDeviceBackup.ts',
    ]);
    for (const path of modules) {
      const code = blankComments(readProductModule(path));
      for (const pattern of FORBIDDEN_RENDERER) {
        expect(pattern.test(code), `${path} ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('the product modules contain no call that could download, share, upload, or log', () => {
    for (const path of productModules()) {
      const code = blankComments(readProductModule(path));
      for (const pattern of FORBIDDEN_EGRESS) {
        expect(pattern.test(code), `${path} ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('the detector this gate uses can find a planted violation', () => {
    // The non-vacuity floor: a source scan that matched nothing would make both
    // assertions above decorative, which is the failure mode Phase 3 review found
    // five times in this repository.
    const planted = [
      "import Phaser from 'phaser';",
      "import { Application } from 'pixi.js';",
      "import { createGame } from '@/game/createGame';",
      "const url = URL.createObjectURL(blob);",
      'await navigator.share({ files: [] });',
      "await fetch('https://example.invalid/upload', { method: 'POST' });",
      'window.localStorage.setItem("knowledge-dungeon:v1:x", "y");',
      "console.log('a subject name');",
    ];
    for (const line of planted) {
      const matched =
        [...FORBIDDEN_RENDERER, ...FORBIDDEN_EGRESS].some((pattern) => pattern.test(blankComments(line)));
      expect(matched, line).toBe(true);
    }
    // ...and a module that does none of those is still clean.
    const clean = "const total = a + b; export const x = total > 1 ? 'a' : 'b';";
    expect([...FORBIDDEN_RENDERER, ...FORBIDDEN_EGRESS].some((pattern) => pattern.test(clean))).toBe(false);
  });

  it('the product depends only on storage-v2, the core subject contract, and the codec', () => {
    for (const path of productModules()) {
      const code = blankComments(readProductModule(path));
      const specifiers = [...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        const allowed =
          specifier.startsWith('@/services/persistence/v2/') ||
          specifier.startsWith('@/core/validation/persistence') ||
          specifier.startsWith('./');
        expect(allowed, `${path} -> ${specifier}`).toBe(true);
      }
    }
  });
});

// ── Helpers that need the module-level export cache ───────────────────────

/** Bytes of the last export, so the version-mutating helpers can rebuild from it. */
let lastExportBytes: Uint8Array | null = null;

function versionMutated(overrides: {
  formatVersion?: number;
  storageGenerationFormatVersion?: number;
  subjectSchemaVersion?: string;
}): Uint8Array {
  if (lastExportBytes === null) throw new Error('No export to mutate.');
  return rebuildArchive(lastExportBytes, (manifest, state) => {
    const nextManifest = { ...manifest } as Record<string, unknown>;
    const nextState = { ...state } as Record<string, unknown>;
    for (const [key, value] of Object.entries(overrides)) {
      nextManifest[key] = value;
      nextState[key] = value;
    }
    return { manifest: nextManifest, state: nextState };
  });
}

function withManifestMutation(
  mutate: (manifest: Record<string, unknown>) => Record<string, unknown>,
): Uint8Array {
  if (lastExportBytes === null) throw new Error('No export to mutate.');
  return rebuildArchive(lastExportBytes, (manifest) => ({ manifest: mutate(manifest), state: null }));
}

/**
 * Rebuild a product archive with its two JSON members replaced, recomputing the
 * manifest so only the intended change is present.
 */
function rebuildArchive(
  bytes: Uint8Array,
  mutate: (
    manifest: Record<string, unknown>,
    state: Record<string, unknown>,
  ) => { manifest: Record<string, unknown>; state: Record<string, unknown> | null },
): Uint8Array {
  const members = readArchive(bytes);
  const decode = (path: string): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(members.find((member) => member.path === path)?.bytes)) as Record<
      string,
      unknown
    >;
  const originalManifest = decode('manifest.json');
  const originalState = decode('state.json');
  const { manifest, state } = mutate(originalManifest, originalState);
  const stateBytes = state === null ? null : utf8(canonicalJsonStringify(state));

  const files = members
    .filter((member) => member.path !== 'manifest.json')
    .map((member) =>
      stateBytes !== null && member.path === 'state.json'
        ? { path: member.path, bytes: stateBytes }
        : { path: member.path, bytes: member.bytes },
    );
  const nextManifest: Record<string, unknown> = {
    ...manifest,
    members: files.map((file) => ({
      path: file.path,
      byteLength: file.bytes.byteLength,
      sha256: sha256Hex(file.bytes),
    })),
  };
  nextManifest.memberCount = files.length;
  nextManifest.totalBytes = files.reduce(
    (total: number, file: { bytes: Uint8Array }) => total + file.bytes.byteLength,
    0,
  );
  const attachmentEntries = files.filter((file) => file.path.startsWith('attachments/'));
  nextManifest.attachmentBytes = {
    memberCount: attachmentEntries.length,
    byteLength: attachmentEntries.reduce((total: number, file: { bytes: Uint8Array }) => total + file.bytes.byteLength, 0),
  };
  nextManifest.contentChecksum = sha256Hex(
    utf8(
      (nextManifest.members as { sha256: string; path: string }[])
        .map((member) => `${member.sha256} ${member.path}`)
        .join('\n'),
    ),
  );
  return writeArchive([
    { path: 'manifest.json', bytes: utf8(canonicalJsonStringify(nextManifest)) },
    ...files,
  ]);
}

beforeAll(async () => {
  lastExportBytes = (await exportOf(device)).bytes;
});
