/**
 * Verifier gate V1 - Phase 5 exit criterion 1.
 *
 * "A populated storage-v2 state exports and restores with semantic equality."
 *
 * The rail claims a field-by-field comparison. This gate builds a **different,
 * nastier** device (`./support/device.ts`): a subject with no rooms, a subject
 * with exactly one room, unicode and emoji at every level, an unknown app-owned
 * field on the record, the snapshot, the dungeon, an edge, a room, a validation
 * state, a note, an inventory item, a fish, an attachment, a sprite, a recovery
 * record and a session; attachments that share a payload, that differ only in
 * their last byte, one whose declared hash disagrees with the bytes on the
 * device, a 256 KiB payload, and an external-only record; three custom sprites
 * sharing one path whose second body is not valid JSON; two recovery records
 * whose first is not parseable; and a migration receipt.
 *
 * Every comparison is a **list of paths**, produced by a comparator written here
 * and proved able to fail in `./harness.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
} from '@/services/persistence/products/fullDeviceBackup';
import { readFullDeviceArchive } from '@/services/persistence/products/archiveValidation';
import { readArchive, readArchiveJson } from '@/services/persistence/v2/archive';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import type { AttachmentBlobRecordValue, AttachmentMetadataRecordValue } from '@/services/persistence/v2/schema';
import {
  ATTACHMENT,
  SPRITE_PATH,
  otherGenerationLabel,
  SUBJECT,
  VERIFIER_MARKERS,
  VERIFIER_RESTORE_NOW,
  buildVerifierDevice,
  diffValues,
  encodeValue,
  fromArrayBuffer,
  hashOf,
  textOf,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];

async function device(options: { empty?: boolean; alt?: boolean } = {}): Promise<VerifierDevice> {
  const built = await buildVerifierDevice({
    empty: options.empty,
    labels: options.alt === true ? otherGenerationLabel() : undefined,
  });
  devices.push(built);
  return built;
}

afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

/** The restored generation's record values, keyed the way the fixture is. */
async function restoredRecords(
  _source: VerifierDevice,
  bytes: Uint8Array,
  into?: VerifierDevice,
): Promise<{ target: VerifierDevice; records: GenerationRecordValues; generationId: string }> {
  const target = into ?? (await device({ alt: true }));
  const result = await importFullDeviceBackup({
    repository: target.repository,
    bytes,
    now: VERIFIER_RESTORE_NOW,
    keepPreviousGeneration: true,
  });
  const snapshot = await target.repository.readRecords(result.generationId);
  const unwrapped = Object.fromEntries(
    Object.entries(snapshot.records as unknown as Record<string, unknown>).map(([store, list]) => [
      store,
      values(list),
    ]),
  ) as unknown as GenerationRecordValues;
  return { target, records: unwrapped, generationId: result.generationId };
}

/**
 * The repository returns *envelopes*; the export and the state document carry the
 * *values*. A comparison between the two has to unwrap first, or every field
 * "differs" for the uninteresting reason that one side has a `checksum`.
 */
function values<T>(store: unknown): T[] {
  const list = store as Array<{ value: T }>;
  // Idempotent, so a caller can unwrap whether it got envelopes from the
  // repository or plain values from a restored record set.
  // `recordId` is the discriminator, not `value`: a preference record legitimately
  // has a `value` property of its own, so `'value' in entry` alone unwraps a
  // preference into its own value and loses the identity.
  if (list.every((entry) => entry !== null && typeof entry === 'object' && 'recordId' in entry && 'value' in entry)) {
    return list.map((envelope) => envelope.value);
  }
  return list as T[];
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
}

/**
 * A stable identity for a record, so two lists can be compared without letting
 * array order stand in for a difference. The export sorts by the record id the
 * repository derives, so a source list declared in another order is not a
 * difference - but a *missing* record still is.
 */
const IDENTITY: Readonly<Record<string, string>> = {
  subjects: 'subjectId',
  progression: 'subjectId',
  sessions: 'sessionId',
  preferences: 'preferenceId',
  shortcuts: 'actionId',
  assistance: 'assistanceId',
  attachmentMetadata: 'attachmentId',
  attachmentBlobs: 'attachmentId',
  customSprites: 'spritePath',
  recovery: 'subjectId',
  migrationReceipts: 'receiptId',
};

function byIdentity<T>(store: keyof typeof IDENTITY, list: readonly T[]): T[] {
  const key = IDENTITY[store];
  return sorted(list, (value) => String((value as Record<string, unknown>)[key]) + canonical(value));
}

function compareStore(store: keyof typeof IDENTITY, left: unknown, right: unknown): ReturnType<typeof diffValues> {
  return diffValues(byIdentity(store, left as never[]), byIdentity(store, right as never[]));
}

/**
 * A canonical sort key.
 *
 * `JSON.stringify` follows *insertion* order, and a value that has been through
 * the state document comes back in canonical (sorted) key order, so using it as a
 * sort key reorders the two sides against each other and manufactures 20 phantom
 * differences. `encodeValue` sorts keys at every depth.
 */
function canonical(value: unknown): string {
  return encodeValue(value);
}

describe('V1: a populated storage-v2 state exports and restores with semantic equality', () => {
  let source: VerifierDevice;
  let archive: Uint8Array;

  beforeEach(async () => {
    source = await device();
    archive = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: source.payloadBytes,
        activeSubjectId: SUBJECT.rich,
      })
    ).bytes;
  });

  it('every store survives with no difference at all except the two documented ones', async () => {
    const { records } = await restoredRecords(source, archive);

    // 1. Subjects, verbatim, including every unknown field at every level.
    expect(compareStore('subjects', records.subjects, source.records.subjects)).toEqual([]);

    // 2. Progression, including badges, inventory, equipped, collected notes,
    //    fish, and cross-subject achievements.
    expect(compareStore('progression', records.progression, source.records.progression)).toEqual([]);

    // 3. Sessions, preferences, shortcuts, assistance, custom sprites, recovery.
    for (const store of ['sessions', 'preferences', 'shortcuts', 'assistance', 'customSprites', 'recovery'] as const) {
      expect(compareStore(store, records[store], source.records[store]), store).toEqual([]);
    }

    // 4. The unicode subject's emoji, tag, and note survive byte for byte.
    const unicode = values<{ subjectId: string; snapshot: { rooms: Record<string, { tags: string[]; noteText: string }> } }>(
      records.subjects,
    ).find((entry) => entry.subjectId === SUBJECT.unicode);
    const room = unicode?.snapshot.rooms['room-verifier-unicode'];
    expect(room?.tags).toContain('ZZ-verifier-tag-🚀');
    expect(room?.noteText).toBe(VERIFIER_MARKERS.noteBody);

    // 5. The three sprite records that share one path all come back, including
    //    the body that is not valid JSON and the one that would need escaping.
    const sprites = values<{ spritePath: string; kind: string; content: string }>(records.customSprites);
    expect(sprites.map((sprite) => sprite.kind).sort()).toEqual(['anim', 'original', 'override']);
    expect(sprites.every((sprite) => sprite.spritePath === SPRITE_PATH)).toBe(true);
    expect(sprites.find((sprite) => sprite.kind === 'override')?.content).toContain('\\backslash/');
    expect(sprites.find((sprite) => sprite.kind === 'anim')?.content).toBe(
      '{ "frames": [ {"ms":120}, {"ms":120} ',
    );

    // 6. Recovery raw text, including the deliberately unparseable payload.
    const recovery = values<{ kind: string; raw: string }>(records.recovery);
    expect(recovery.map((entry) => entry.raw)).toContain(VERIFIER_MARKERS.recoveryRaw);

    // 7. Locale and quest state are the preferences the state document names.
    const preferences = values<{ preferenceId: string; value: unknown }>(records.preferences);
    expect(preferences.find((entry) => entry.preferenceId === 'locale')?.value).toBe('es');

    // 8. Migration receipts: the count and every field, because the label was
    //    free on the target and the archive's own label was adopted.
    expect(records.migrationReceipts).toHaveLength(1);
    expect(records.migrationReceipts[0]).toEqual(source.records.migrationReceipts[0]);
  });

  it('attachment metadata round-trips except for the two attachments the export had to disclose', async () => {
    const { records } = await restoredRecords(source, archive);
    const byId = new Map(
      values<AttachmentMetadataRecordValue>(records.attachmentMetadata).map((entry) => [entry.attachmentId, entry]),
    );

    // The three that carried real, matching bytes are identical, unknown field
    // and file name and alt text included.
    for (const id of [ATTACHMENT.stored, ATTACHMENT.duplicatePayload, ATTACHMENT.lastByteOnly, ATTACHMENT.large, ATTACHMENT.externalWithBytes]) {
      const original = (source.records.attachmentMetadata as AttachmentMetadataRecordValue[]).find(
        (entry) => entry.attachmentId === id,
      );
      expect(diffValues(byId.get(id), original), id).toEqual([]);
      expect(byId.get(id)?.availability).toBe('stored');
    }

    // The record whose declared hash disagrees with the device's bytes, and the
    // external-only record, are disclosed and become what they really are.
    for (const id of [ATTACHMENT.hashDisagrees, ATTACHMENT.external]) {
      expect(byId.get(id)?.availability, id).toBe('external-only');
      expect(byId.get(id)?.contentHash, id).toBeNull();
    }
    // ...and the *file name* of a disclosed local record is not invented away.
    expect(byId.get(ATTACHMENT.hashDisagrees)?.fileName).toBeUndefined();
  });

  it('every attachment blob comes back with the exact bytes that were exported', async () => {
    const { records } = await restoredRecords(source, archive);
    const blobs = new Map(
      values<AttachmentBlobRecordValue>(records.attachmentBlobs).map((entry) => [entry.attachmentId, entry]),
    );
    // Six blobs on the device; the hash-disagreeing one is disclosed, so five.
    expect(blobs.size).toBe(5);
    for (const id of [ATTACHMENT.stored, ATTACHMENT.duplicatePayload, ATTACHMENT.lastByteOnly, ATTACHMENT.large, ATTACHMENT.externalWithBytes]) {
      const restored = fromArrayBuffer(blobs.get(id)!.bytes);
      // The last one is deliberately **not** in `payloadBytes`: the export must
      // fall back to the generation's own mirrored blob record for it.
      const original = source.payloadBytes.get(id) ?? source.payloads.externalWithBytes;
      expect(original, id).toBeDefined();
      expect(hashOf(restored), id).toBe(hashOf(original!));
      // ...and the declared hash is the digest of those exact bytes.
      expect(blobs.get(id)!.contentHash, id).toBe(hashOf(original!));
      expect(blobs.get(id)!.byteLength, id).toBe(original!.byteLength);
    }
    // The two records that share a payload are byte-identical to each other, and
    // the last-byte-only record is *not*.
    expect(fromArrayBuffer(blobs.get(ATTACHMENT.stored)!.bytes)).toEqual(
      fromArrayBuffer(blobs.get(ATTACHMENT.duplicatePayload)!.bytes),
    );
    expect(fromArrayBuffer(blobs.get(ATTACHMENT.lastByteOnly)!.bytes)).not.toEqual(
      fromArrayBuffer(blobs.get(ATTACHMENT.stored)!.bytes),
    );
  });

  it('the round trip is stable: exporting the restored generation reproduces the same state document', async () => {
    const first = await restoredRecords(source, archive);
    const reExported = (
      await exportFullDeviceBackup({
        repository: first.target.repository,
        generationId: first.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: new Map(
          values<AttachmentBlobRecordValue>(first.records.attachmentBlobs).map((blob) => [
            blob.attachmentId,
            fromArrayBuffer(blob.bytes),
          ]),
        ),
        activeSubjectId: SUBJECT.rich,
      })
    ).bytes;
    const stateOf = (bytes: Uint8Array): Record<string, unknown> =>
      readArchiveJson(bytes, 'state.json') as Record<string, unknown>;
    // Only the two disclosed attachments differ, because the second export's
    // source has them as `external-only` already.
    const differences = diffValues(stateOf(archive), stateOf(reExported));
    const attachmentPaths = new Set(
      differences
        .filter((difference) => difference.path.includes('attachmentMetadata'))
        .map((difference) => difference.path),
    );
    expect(differences.filter((difference) => !attachmentPaths.has(difference.path))).toEqual([]);
    expect(attachmentPaths.size).toBeGreaterThan(0);
  });

  it('the archive carries the active subject id, and the import reports it without applying it', async () => {
    const state = readArchiveJson(archive, 'state.json') as Record<string, unknown>;
    expect(state.activeSubjectId).toBe(SUBJECT.rich);
    const target = await device({ alt: true });
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.restoredActiveSubjectId).toBe(SUBJECT.rich);
    // The pointer the application itself uses is untouched by the restore: no UI
    // claim is licensed because the *repository* has no such concept.
    expect(result.generationId).not.toBe(SUBJECT.rich);
  });

  it('a re-import of the very same archive is a second generation, and both are readable', async () => {
    const target = await device({ alt: true });
    const first = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    const second = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    // The first restore adopted the archive's own label, so the second cannot.
    expect(first.reusedArchiveGenerationId).toBe(true);
    expect(first.generationId).toBe(source.generationId);
    expect(second.reusedArchiveGenerationId).toBe(false);
    expect(second.generationId).not.toBe(first.generationId);
    expect(second.previousActiveGenerationId).toBe(first.generationId);
    // Both generations hold the same records: the first was not overwritten.
    const a = await target.repository.readRecords(first.generationId);
    const b = await target.repository.readRecords(second.generationId);
    expect(compareStore('subjects', values(a.records.subjects), values(b.records.subjects))).toEqual([]);
    expect(compareStore('progression', values(a.records.progression), values(b.records.progression))).toEqual([]);
    // The two generations differ in exactly one thing: which generation they are.
    expect(a.generationId).not.toBe(b.generationId);
    expect((await target.repository.readActiveGenerationId())).toBe(second.generationId);
  });

  it('a generation that already carries a restore can itself be exported and restored again', async () => {
    const first = await restoredRecords(source, archive);
    const payloads = new Map(
      values<AttachmentBlobRecordValue>(first.records.attachmentBlobs).map((blob) => [
        blob.attachmentId,
        fromArrayBuffer(blob.bytes),
      ]),
    );
    const secondArchive = (
      await exportFullDeviceBackup({
        repository: first.target.repository,
        generationId: first.generationId,
        now: '2026-09-28T12:00:00.000Z',
        payloadBytes: payloads,
        activeSubjectId: null,
      })
    ).bytes;
    const third = await restoredRecords(source, secondArchive, first.target);
    const differences = diffValues(third.records.subjects, first.records.subjects);
    expect(differences).toEqual([]);
    expect(third.records.customSprites).toHaveLength(3);
  });

  it('a device with no attachments at all round-trips', async () => {
    const bare = await device({ empty: true });
    const bytes = (
      await exportFullDeviceBackup({
        repository: bare.repository,
        generationId: bare.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: new Map(),
        activeSubjectId: null,
      })
    ).bytes;
    const preview = readFullDeviceArchive(bytes);
    expect(preview.recordCounts.attachments).toBe(0);
    expect(preview.attachmentBytes).toEqual({ memberCount: 0, byteLength: 0 });
    const { records } = await restoredRecords(bare, bytes);
    expect(records.attachmentMetadata).toEqual([]);
    expect(records.attachmentBlobs).toEqual([]);
    expect(records.subjects).toHaveLength(4);
    // The sprite, recovery and receipt sections are absent from the *empty*
    // device, so the archive carries no such members and no orphan members either.
    const memberNames = readArchive(bytes).map((member) => member.path);
    expect(memberNames.filter((name) => name.startsWith('custom-sprites/'))).toEqual([]);
    expect(memberNames.filter((name) => name.startsWith('recovery/'))).toEqual([]);
  });

  it('a device where every attachment is external-only discloses all of them and still succeeds', async () => {
    const stripped = await device({ alt: true });
    // Drop every attachment record and blob, then make each remaining record
    // external-only: the "device with only unreachable images" case.
    const records = (await stripped.repository.readRecords(stripped.generationId)).records;
    const metadata = values<AttachmentMetadataRecordValue>(records.attachmentMetadata).map((entry) => ({
      ...entry,
      availability: 'external-only' as const,
      contentHash: null,
    }));
    // `putRecords` merges and `deleteRecords` removes *both* halves of an
    // attachment, so the way to reach "metadata only, no bytes" is: write the
    // external-only metadata, delete the pair, write the metadata back.
    await stripped.repository.putRecords(stripped.generationId, { attachmentMetadata: metadata });
    await stripped.repository.deleteRecords(stripped.generationId, {
      attachments: metadata.map((entry) => entry.attachmentId),
    });
    await stripped.repository.putRecords(stripped.generationId, { attachmentMetadata: metadata });
    const afterRewrite = await stripped.repository.readRecords(stripped.generationId);
    expect(afterRewrite.records.attachmentBlobs).toEqual([]);
    expect(values(afterRewrite.records.attachmentMetadata)).toHaveLength(metadata.length);
    expect((await stripped.repository.validateGeneration(stripped.generationId)).ok).toBe(true);
    const bytes = (
      await exportFullDeviceBackup({
        repository: stripped.repository,
        generationId: stripped.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: stripped.payloadBytes,
        activeSubjectId: null,
      })
    ).bytes;
    const preview = readFullDeviceArchive(bytes);
    expect(preview.externalOnlyCount).toBe(metadata.length);
    expect(preview.attachmentBytes.memberCount).toBe(0);
    expect(readArchive(bytes).some((member) => member.path.startsWith('attachments/'))).toBe(false);
    const { records: restored } = await restoredRecords(stripped, bytes);
    expect(
      values<AttachmentMetadataRecordValue>(restored.attachmentMetadata).every(
        (entry) => entry.availability === 'external-only' && entry.contentHash === null,
      ),
    ).toBe(true);
    expect(restored.attachmentBlobs).toEqual([]);
  });

  it('a very large attachment really is large, and survives', async () => {
    const members = readArchive(archive);
    const large = members.find((member) => member.path === `attachments/${hashOf(source.payloads.large)}`);
    expect(large?.bytes.byteLength).toBe(256 * 1024);
    const { records } = await restoredRecords(source, archive);
    const blob = values<AttachmentBlobRecordValue>(records.attachmentBlobs).find(
      (entry) => entry.attachmentId === ATTACHMENT.large,
    );
    expect(fromArrayBuffer(blob!.bytes).byteLength).toBe(256 * 1024);
    expect(hashOf(fromArrayBuffer(blob!.bytes))).toBe(hashOf(source.payloads.large));
  });

  it('the restored generation passes the production validator with no blocking problem', async () => {
    const { target, generationId } = await restoredRecords(source, archive);
    const report = await target.repository.validateGeneration(generationId);
    expect(report.problems.filter((problem) => problem.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('an export reads no state it does not write: a second export has the same members, in the same order', async () => {
    // NOT the archive bytes. `writeArchive` gives fflate no `mtime`, so fflate
    // stamps each entry with the wall clock and two exports a second apart differ
    // in a handful of header bytes. Asserting byte equality here would be a flaky
    // test of my own making, so the claim is made where it is true: the members,
    // their bytes, and their order. The non-determinism itself is recorded in
    // `privacy.test.ts`.
    const again = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: source.payloadBytes,
        activeSubjectId: SUBJECT.rich,
      })
    ).bytes;
    const membersOf = (bytes: Uint8Array): Array<[string, string]> =>
      readArchive(bytes).map((member) => [member.path, hashOf(member.bytes)]);
    expect(membersOf(again)).toEqual(membersOf(archive));
    expect(readArchiveJson(again, 'state.json')).toEqual(readArchiveJson(archive, 'state.json'));
    expect(readArchiveJson(again, 'manifest.json')).toEqual(readArchiveJson(archive, 'manifest.json'));
  });

  it('the state document is canonical JSON, so key order cannot hide a difference', async () => {
    const state = readArchiveJson(archive, 'state.json') as Record<string, unknown>;
    const first = (state.subjects as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    // Every object's keys are in ascending order, at every depth.
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const keys = Object.keys(value as Record<string, unknown>);
      expect(keys, path).toEqual([...keys].sort());
      for (const key of keys) walk((value as Record<string, unknown>)[key], `${path}.${key}`);
    };
    walk(first, '$.subjects[0]');
  });

  it('the custom sprite member bodies are the record contents, byte for byte', async () => {
    const members = readArchive(archive);
    const sprites = (readArchiveJson(archive, 'state.json') as { customSprites: Array<{ kind: string; content: string }> })
      .customSprites;
    sprites.forEach((sprite, index) => {
      const member = members.find((entry) => entry.path === `custom-sprites/${String(index + 1).padStart(6, '0')}.${sprite.kind}`);
      expect(member, sprite.kind).toBeDefined();
      expect(textOf(member!.bytes), sprite.kind).toBe(sprite.content);
    });
  });
});

describe('V1: the two documented carve-outs are the *only* carve-outs', () => {
  it('lists every field that differs between the source records and the restored ones', async () => {
    const source = await device();
    const archive = (
      await exportFullDeviceBackup({
        repository: source.repository,
        generationId: source.generationId,
        now: VERIFIER_RESTORE_NOW,
        payloadBytes: source.payloadBytes,
        activeSubjectId: null,
      })
    ).bytes;
    const { records } = await restoredRecords(source, archive);
    const differences = [
      ...compareStore('subjects', records.subjects, source.records.subjects),
      ...compareStore('progression', records.progression, source.records.progression),
      ...compareStore('sessions', records.sessions, source.records.sessions),
      ...compareStore('preferences', records.preferences, source.records.preferences),
      ...compareStore('shortcuts', records.shortcuts, source.records.shortcuts),
      ...compareStore('assistance', records.assistance, source.records.assistance),
      ...compareStore('customSprites', records.customSprites, source.records.customSprites),
      ...compareStore('recovery', records.recovery, source.records.recovery),
      ...compareStore('migrationReceipts', records.migrationReceipts, source.records.migrationReceipts),
    ];
    // A record-by-record, field-by-field list: no wildcard, no tolerance.
    expect(differences).toEqual([]);
  });
});
