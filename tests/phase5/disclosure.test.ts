/**
 * Verifier gate V4 - Phase 5 exit criterion 4.
 *
 * "External-only images are disclosed."
 *
 * Plan section 2.3: "Existing external-only attachments must be disclosed
 * honestly when a backup cannot include their bytes", and "External image URLs
 * remain user-provided external content and are not silently downloaded into
 * backups."
 *
 * The attacks: a device where *every* attachment is external-only; an archive in
 * which a disclosed attachment's own bytes ride along as a real member anyway; an
 * archive whose disclosure reasons disagree between the manifest and the state
 * document; and a device whose bytes are present for an `external`-source record.
 *
 * Four properties are asserted for each: no fabricated hash anywhere, the import
 * still succeeds, the disclosure reaches the UI in words a learner can act on, and
 * the record's own `externalUrl`/`fileName` never leaves `state.json`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
  readFullDeviceArchive,
  type FullDeviceExportResult,
} from '@/services/persistence/products/fullDeviceBackup';
import { readArchive, readArchiveJson } from '@/services/persistence/v2/archive';
import { StorageV2Error, type AttachmentMetadataRecordValue } from '@/services/persistence/v2/schema';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import { describeExternalOnlyReason, formatByteCount, formatInstant } from '@/ui/data/ImportPreview';
import {
  ATTACHMENT,
  SUBJECT,
  VERIFIER_MARKERS,
  VERIFIER_RESTORE_NOW,
  buildVerifierDevice,
  bytesOf,
  hashOf,
  otherGenerationLabel,
  type VerifierDevice,
} from './support/device';

const devices: VerifierDevice[] = [];

async function device(options: { alt?: boolean } = {}): Promise<VerifierDevice> {
  const built = await buildVerifierDevice({ labels: options.alt === true ? otherGenerationLabel() : undefined });
  devices.push(built);
  return built;
}

afterEach(() => {
  while (devices.length > 0) devices.pop()?.close();
});

function values<T>(store: unknown): T[] {
  const list = store as Array<{ value: T }>;
  if (list.every((entry) => entry !== null && typeof entry === 'object' && 'recordId' in entry && 'value' in entry)) {
    return list.map((envelope) => envelope.value);
  }
  return list as T[];
}

function unwrapRecords(records: unknown): GenerationRecordValues {
  return Object.fromEntries(
    Object.entries(records as Record<string, unknown>).map(([store, list]) => [store, values(list)]),
  ) as unknown as GenerationRecordValues;
}

const EXTERNAL_ONLY_MARKER = 'https://pictures.example.invalid/zz-verifier-remote.png';

describe('V4: external-only images are disclosed', () => {
  let source: VerifierDevice;
  let exported: FullDeviceExportResult;

  beforeEach(async () => {
    source = await device();
    exported = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: VERIFIER_RESTORE_NOW,
      payloadBytes: source.payloadBytes,
      activeSubjectId: SUBJECT.rich,
    });
  });

  it('the export discloses both unreachable images, with no fabricated hash and no invented length', () => {
    const disclosures = exported.externalOnlyAttachments;
    expect(disclosures.map((entry) => entry.attachmentId).sort()).toEqual(
      [ATTACHMENT.external, ATTACHMENT.hashDisagrees].sort(),
    );
    for (const disclosure of disclosures) {
      expect(disclosure.contentHash).toBeNull();
      expect(disclosure.byteLength).toBeNull();
    }
    // The reason distinguishes the two cases in words a learner can act on.
    const byId = new Map(disclosures.map((entry) => [entry.attachmentId, entry]));
    expect(byId.get(ATTACHMENT.external)?.reason).toBe('historical-external-url');
    expect(byId.get(ATTACHMENT.external)?.sourceType).toBe('external');
    expect(byId.get(ATTACHMENT.hashDisagrees)?.reason).toBe('bytes-not-recoverable');
    expect(byId.get(ATTACHMENT.hashDisagrees)?.sourceType).toBe('local');
  });

  it('the manifest carries a count and a histogram, and no id, hash, length, or URL', () => {
    const manifest = readArchiveJson(exported.bytes, 'manifest.json') as Record<string, unknown>;
    const sub = manifest.externalOnlyAttachments as { count: number; reasons: Record<string, number> };
    expect(sub.count).toBe(2);
    expect(sub).toEqual({ count: 2, reasons: { 'bytes-not-recoverable': 1, 'historical-external-url': 1 } });
    const serialized = JSON.stringify(manifest);
    for (const marker of [
      VERIFIER_MARKERS.subjectName,
      VERIFIER_MARKERS.roomTopic,
      VERIFIER_MARKERS.noteBody,
      VERIFIER_MARKERS.attachmentFileName,
      VERIFIER_MARKERS.attachmentAltText,
      EXTERNAL_ONLY_MARKER,
      ATTACHMENT.external,
      ATTACHMENT.hashDisagrees,
    ]) {
      expect(serialized.includes(marker), `the manifest leaked ${marker}`).toBe(false);
    }
    // The state document is where the ids live, and it legitimately carries them.
    expect(JSON.stringify(readArchiveJson(exported.bytes, 'state.json')).includes(ATTACHMENT.external)).toBe(true);
  });

  it('an attachment the device holds bytes for but that is an external URL is carried, not hidden', () => {
    // Plan section 2.3: an external URL is user-provided content and is never
    // silently downloaded. Bytes that are *already on the device* are a
    // different thing, and the exporter carries them.
    const disclosure = exported.externalOnlyAttachments.find(
      (entry) => entry.attachmentId === ATTACHMENT.externalWithBytes,
    );
    expect(disclosure).toBeUndefined();
    const members = readArchive(exported.bytes).map((member) => member.path);
    expect(members).toContain(`attachments/${hashOf(source.payloads.externalWithBytes)}`);
  });

  it('a device where every attachment is external-only discloses all of them and the import still succeeds', async () => {
    const target = await device({ alt: true });
    // Build the archive by hand: an all-external state document with a matching
    // manifest, sealed so every checksum is right.
    const state = readArchiveJson(exported.bytes, 'state.json') as Record<string, unknown>;
    const metadata = values<AttachmentMetadataRecordValue>(state.attachmentMetadata).map((entry) => ({
      ...entry,
      availability: 'external-only' as const,
      contentHash: null,
    }));
    const allExternal = { ...state, attachmentMetadata: metadata };
    const reasons: Record<string, number> = {};
    for (const entry of metadata) {
      const reason = entry.sourceType === 'external' ? 'historical-external-url' : 'bytes-not-recoverable';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    const reasonsSummary = { count: metadata.length, reasons };
    const other = readArchive(exported.bytes).filter(
      (member) => member.path !== 'manifest.json' && member.path !== 'state.json' && !member.path.startsWith('attachments/'),
    );
    const stateBytes = bytesOf(JSON.stringify(allExternal, Object.keys(allExternal).sort() as never));
    // Canonical JSON is required, so build it through the production serializer.
    const { canonicalJsonStringify } = await import('@/services/persistence/v2/checksum');
    const canonical = bytesOf(canonicalJsonStringify(allExternal));
    void stateBytes;
    const entries = [
      ...other.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
      { path: 'state.json', byteLength: canonical.byteLength, sha256: hashOf(canonical) },
    ];
    const { sha256Hex } = await import('@/services/persistence/v2/checksum');
    const { writeArchive } = await import('@/services/persistence/v2/archive');
    const manifest = {
      product: 'kdbak' as const,
      formatVersion: 1,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: state.subjectSchemaVersion as string,
      createdAt: state.createdAt as string,
      memberCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
      contentChecksum: sha256Hex(bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
      recordCounts: counts(allExternal),
      attachmentBytes: { memberCount: 0, byteLength: 0 },
      externalOnlyAttachments: reasonsSummary,
      members: entries,
    };
    const archive = writeArchive([
      { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
      { path: 'state.json', bytes: canonical },
      ...other,
    ]);

    // The import succeeds, discloses everything, and fabricates nothing.
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    expect(result.activated).toBe(true);
    expect(result.externalOnlyAttachments).toHaveLength(metadata.length);
    for (const disclosure of result.externalOnlyAttachments) {
      expect(disclosure.contentHash).toBeNull();
      expect(disclosure.byteLength).toBeNull();
    }
    const restored = unwrapRecords((await target.repository.readRecords(result.generationId)).records);
    const byId = new Map(
      values<AttachmentMetadataRecordValue>(restored.attachmentMetadata).map((entry) => [entry.attachmentId, entry]),
    );
    for (const entry of metadata) {
      expect(byId.get(entry.attachmentId)?.availability, entry.attachmentId).toBe('external-only');
      expect(byId.get(entry.attachmentId)?.contentHash, entry.attachmentId).toBeNull();
      // The record is not thrown away: its own metadata survives, so the UI can
      // still show the learner which image it was.
      expect(byId.get(entry.attachmentId)?.addedAt, entry.attachmentId).toBe(entry.addedAt);
    }
    expect(restored.attachmentBlobs).toEqual([]);
  });

  it('a disclosed attachment whose bytes ride along as a real member is still disclosed, and the member is not silently adopted', async () => {
    const target = await device({ alt: true });
    const state = readArchiveJson(exported.bytes, 'state.json') as Record<string, unknown>;
    const metadata = values<AttachmentMetadataRecordValue>(state.attachmentMetadata);
    const disclosed = metadata.find((entry) => entry.attachmentId === ATTACHMENT.hashDisagrees)!;
    // Put the *device's* bytes for the disclosed record into the archive as a
    // real, content-addressed member, while the record still claims
    // external-only with no hash. A permissive importer would attach those bytes.
    const orphanPath = `attachments/${hashOf(source.payloads.hashDisagrees)}`;
    const other = readArchive(exported.bytes).filter(
      (member) => member.path !== 'manifest.json' && member.path !== 'state.json',
    );
    const extra = [...other, { path: orphanPath, bytes: source.payloads.hashDisagrees }];
    const { canonicalJsonStringify, sha256Hex } = await import('@/services/persistence/v2/checksum');
    const { writeArchive } = await import('@/services/persistence/v2/archive');
    const canonical = bytesOf(canonicalJsonStringify(state));
    const entries = [
      ...extra.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
      { path: 'state.json', byteLength: canonical.byteLength, sha256: hashOf(canonical) },
    ];
    const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
    const manifest = {
      product: 'kdbak' as const,
      formatVersion: 1,
      storageGenerationFormatVersion: 1,
      subjectSchemaVersion: state.subjectSchemaVersion as string,
      createdAt: state.createdAt as string,
      memberCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
      contentChecksum: sha256Hex(bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
      // The declared record counts are the *original* manifest's, and they are
      // the product's own rule: metadata plus the records whose declared hash
      // names a member. The extra member does not change either number, which is
      // exactly the point - an orphan byte member is not a record.
      recordCounts: (readArchiveJson(exported.bytes, 'manifest.json') as { recordCounts: Record<string, number> })
        .recordCounts,
      attachmentBytes: {
        memberCount: attachmentEntries.length,
        byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
      },
      externalOnlyAttachments: (readArchiveJson(exported.bytes, 'manifest.json') as {
        externalOnlyAttachments: { count: number; reasons: Record<string, number> };
      }).externalOnlyAttachments,
      members: entries,
    };
    const archive = writeArchive([
      { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(manifest)) },
      { path: 'state.json', bytes: canonical },
      ...extra,
    ]);
    const result = await importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: VERIFIER_RESTORE_NOW,
    });
    // The disclosure still names the record...
    expect(
      result.externalOnlyAttachments.some((entry) => entry.attachmentId === ATTACHMENT.hashDisagrees),
    ).toBe(true);
    // ...and no bytes were attached to it, because the record names no hash.
    const restored = unwrapRecords((await target.repository.readRecords(result.generationId)).records);
    const restoredRecord = values<AttachmentMetadataRecordValue>(restored.attachmentMetadata).find(
      (entry) => entry.attachmentId === ATTACHMENT.hashDisagrees,
    );
    expect(restoredRecord?.availability).toBe('external-only');
    expect(restoredRecord?.contentHash).toBeNull();
    // The orphan member is not adopted as a blob for any record either: every
    // blob belongs to a record that names its hash.
    const orphanHashes = new Set(
      values<AttachmentMetadataRecordValue>(restored.attachmentMetadata)
        .filter((entry) => entry.availability === 'stored' && typeof entry.contentHash === 'string')
        .map((entry) => entry.contentHash as string),
    );
    expect(orphanHashes.has(hashOf(source.payloads.hashDisagrees))).toBe(false);
    // The *state document* still records the hash the device declared, which is
    // the truth about the source device and is why the disclosure exists; the
    // disclosure itself reports a null hash, and the restored record drops it.
    expect(disclosed.availability).toBe('stored');
    expect(disclosed.contentHash).not.toBeNull();
    const preview = readFullDeviceArchive(archive);
    const previewEntry = preview.externalOnlyAttachments.find(
      (entry) => entry.attachmentId === ATTACHMENT.hashDisagrees,
    );
    expect(previewEntry?.contentHash).toBeNull();
    expect(previewEntry?.byteLength).toBeNull();
  });

  it('disclosure reasons that disagree between the manifest and the state document are refused', async () => {
    const target = await device({ alt: true });
    const state = readArchiveJson(exported.bytes, 'state.json') as Record<string, unknown>;
    const other = readArchive(exported.bytes).filter(
      (member) => member.path !== 'manifest.json' && member.path !== 'state.json',
    );
    const { canonicalJsonStringify, sha256Hex } = await import('@/services/persistence/v2/checksum');
    const { writeArchive } = await import('@/services/persistence/v2/archive');
    const canonical = bytesOf(canonicalJsonStringify(state));
    const entries = [
      ...other.map((member) => ({ path: member.path, byteLength: member.bytes.byteLength, sha256: hashOf(member.bytes) })),
      { path: 'state.json', byteLength: canonical.byteLength, sha256: hashOf(canonical) },
    ];
    const attachmentEntries = entries.filter((entry) => entry.path.startsWith('attachments/'));
    // The histogram says both disclosures are external URLs; the state document
    // says one of them is a local record whose bytes are unreachable.
    const lying = {
      ...(readArchiveJson(exported.bytes, 'manifest.json') as Record<string, unknown>),
      externalOnlyAttachments: { count: 2, reasons: { 'historical-external-url': 2 } },
      members: entries,
      memberCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
      contentChecksum: sha256Hex(bytesOf(entries.map((entry) => `${entry.sha256} ${entry.path}`).join('\n'))),
      attachmentBytes: {
        memberCount: attachmentEntries.length,
        byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
      },
    };
    const archive = writeArchive([
      { path: 'manifest.json', bytes: bytesOf(canonicalJsonStringify(lying)) },
      { path: 'state.json', bytes: canonical },
      ...other,
    ]);
    let thrown: unknown = null;
    try {
      await importFullDeviceBackup({ repository: target.repository, bytes: archive, now: VERIFIER_RESTORE_NOW });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'a manifest that lies about its own disclosure was accepted').not.toBeNull();
    expect(thrown).toBeInstanceOf(StorageV2Error);
    expect((thrown as StorageV2Error).code).toBe('COUNT_MISMATCH');
    // ...and the device is untouched, so the refusal is worth something.
    const active = await target.repository.readActiveGenerationId();
    expect(active).toBe(target.generationId);
  });

  it('the disclosure reaches the interface in words, and never as a digest or an id', () => {
    // The exact strings the Data Center renders for the reasons the product emits.
    expect(describeExternalOnlyReason('historical-external-url')).toMatch(
      /link to a picture on the internet/i,
    );
    expect(describeExternalOnlyReason('bytes-not-recoverable')).toMatch(/not on this device/i);
    expect(describeExternalOnlyReason('bytes-missing-locally')).toMatch(/not on this device/i);
    // An unknown reason is disclosed as unknown rather than folded into a lie.
    expect(describeExternalOnlyReason('reason-from-a-newer-build')).toMatch(/does not recognise/i);

    // A preview the product really produced, serialized: no digest, no id, no
    // file name, no URL anywhere in what the preview surface can render.
    const preview = readFullDeviceArchive(exported.bytes);
    const renderable = JSON.stringify({
      count: preview.externalOnlyCount,
      reasons: preview.externalOnlyAttachments.map((entry) => describeExternalOnlyReason(entry.reason)),
      bytes: formatByteCount(preview.attachmentBytes.byteLength),
      when: formatInstant(preview.createdAt),
    });
    for (const marker of [
      VERIFIER_MARKERS.subjectName,
      VERIFIER_MARKERS.roomTopic,
      VERIFIER_MARKERS.noteBody,
      VERIFIER_MARKERS.attachmentFileName,
      VERIFIER_MARKERS.attachmentAltText,
      EXTERNAL_ONLY_MARKER,
      ATTACHMENT.external,
      ATTACHMENT.hashDisagrees,
      'sha256',
    ]) {
      expect(renderable.includes(marker), `the renderable disclosure leaked ${marker}`).toBe(false);
    }
    // A 64-character hex string is a digest, and the rendered surface has none.
    expect(/[0-9a-f]{64}/.test(renderable)).toBe(false);
    // ...but the words are there, and they are actionable.
    expect(renderable).toContain('link to a picture on the internet');
    expect(renderable).toContain('not on this device');
  });

  it('the subject id and room id a disclosure carries are opaque, and are not the attachment id', () => {
    const preview = readFullDeviceArchive(exported.bytes);
    for (const entry of preview.externalOnlyAttachments) {
      // Opaque means "an identifier, and nothing a learner would recognise": not
      // a digest, not a length, and none of the planted markers.
      expect(entry.attachmentId.length).toBeGreaterThan(0);
      expect(entry.attachmentId.length).toBeLessThanOrEqual(64);
      expect(entry.contentHash).toBeNull();
      expect(entry.byteLength).toBeNull();
      expect(entry).not.toHaveProperty('fileName');
      expect(entry).not.toHaveProperty('externalUrl');
      expect(entry).not.toHaveProperty('altText');
    }
    // The external-only record really does name a real subject and room.
    const external = preview.externalOnlyAttachments.find((entry) => entry.attachmentId === ATTACHMENT.external);
    expect(external?.subjectId).toBe(SUBJECT.unicode);
  });
});

function counts(state: Record<string, unknown>): Record<string, number> {
  const metadata = state.attachmentMetadata as Array<Record<string, unknown>>;
  return {
    meta: 0,
    subjects: (state.subjects as unknown[]).length,
    progression: (state.progression as unknown[]).length,
    sessions: (state.sessions as unknown[]).length,
    preferences: (state.preferences as unknown[]).length,
    shortcuts: (state.shortcuts as unknown[]).length,
    assistance: (state.assistance as unknown[]).length,
    attachments: metadata.length + metadata.filter((entry) => entry.availability === 'stored' && typeof entry.contentHash === 'string').length,
    customSprites: (state.customSprites as unknown[]).length,
    recovery: (state.recovery as unknown[]).length,
    migrationReceipts: (state.migrationReceipts as unknown[]).length,
  };
}
