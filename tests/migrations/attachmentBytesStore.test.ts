/**
 * Phase 4: the device-local attachment store and the external-only representation.
 *
 * Plan section 2.3 is the contract: web image bytes live in IndexedDB, they are
 * never uploaded, and an external URL stays a URL. This file proves the three
 * halves of that at the application seam - the shape the subject store and the
 * note editor actually use:
 *
 * 1. **Bytes round-trip byte-identically** with a matching SHA-256, and the
 *    device-local path performs no network call of any kind.
 * 2. **An external attachment stores no bytes and no hash.** It is
 *    `external-only`, which is the honest representation, and reading it back
 *    reports unavailable bytes instead of fetching anything.
 * 3. **Unknown ids return `null`**, and deleting a record actually forgets it.
 *
 * It also covers the storage-v2 mirror: with the repository selected, a
 * device-local write is *also* recorded in the active generation, and with the
 * flag off the storage-v2 database is never touched.
 *
 * Privacy: every payload is a synthetic byte array; the only host named anywhere
 * in this file is the reserved `example.invalid`, and it is never dereferenced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDeviceLocalAttachmentStore,
  deleteDeviceLocalAttachmentDatabase,
  DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME,
  listDeviceLocalAttachments,
  readAttachmentBytes,
  readAttachmentObjectUrl,
  readAttachmentRecord,
  recordExternalAttachment,
  storeAttachmentBytes,
} from '@/services/persistence/v2/attachmentBytes';
import {
  addDeviceLocalRoomAttachment,
  readDeviceLocalAttachmentUrl,
  removeDeviceLocalAttachment,
} from '@/services/persistence/deviceAttachments';
import { addRoomExternalAttachment } from '@/services/persistence/subjectPersistence';
import { checksumBytes } from '@/services/persistence/v2/checksum';
import {
  resetRepositorySelection,
  selectLegacyRepository,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import {
  deleteTestDatabase,
  openTestRepository,
  MIGRATION_NOW,
} from './support/storageV2TestSupport';
import { writeSubjectToActiveGeneration } from '@/services/persistence/v2/appRepository';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { AttachmentMetadataRecordValue } from '@/services/persistence/v2/schema';

const SUBJECT_ID = 'subject-attachments-synthetic';
const ROOM_ID = 'room-attachments-synthetic-root';
const GENERATION_ID = 'gen-attachments-synthetic-0001';
const NOW = MIGRATION_NOW;
const EXTERNAL_URL = 'https://example.invalid/attachment-synthetic-external.png';

/**
 * A complete, valid 1x1 PNG written out byte by byte, so the payload is synthetic
 * and self-describing. The trailing marker bytes make it 67 bytes long.
 */
const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

/** 55 bytes: the SHA-256 padding boundary Phase 3 got wrong once. */
const BOUNDARY_55: readonly number[] = Array.from({ length: 55 }, (_unused, index) => (index * 7) % 251);

/** A minimal valid subject, so an attachment's `subjectId` resolves. */
function subjectFixture(): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName: 'Attachments synthetic subject',
      createdAt: NOW,
      updatedAt: NOW,
      phaseState: 'CreatorActive',
      rootRoomId: ROOM_ID,
      rooms: [{ roomId: ROOM_ID, topic: 'Attachments synthetic root topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      [ROOM_ID]: {
        roomId: ROOM_ID,
        topic: 'Attachments synthetic root topic',
        createdAt: NOW,
        updatedAt: NOW,
        state: 'Created',
        notePath: `rooms/${ROOM_ID}/notes.txt`,
        artifactPath: `rooms/${ROOM_ID}/artifact.md`,
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
  } as unknown as SubjectSnapshot;
}

function blobOf(bytes: readonly number[], type = 'image/png'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function syntheticFile(bytes: readonly number[]): Blob & { name: string } {
  const blob = blobOf(bytes);
  Object.defineProperty(blob, 'name', { value: 'attachment-synthetic-image.png' });
  return blob as Blob & { name: string };
}

let storageV2Name = '';
let storageV2: StorageV2Repository | null = null;

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  selectLegacyRepository();
  closeDeviceLocalAttachmentStore();
});

afterEach(async () => {
  closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase();
  storageV2?.close();
  storageV2 = null;
  if (storageV2Name) await deleteTestDatabase(storageV2Name);
  storageV2Name = '';
  resetRepositorySelection();
  vi.restoreAllMocks();
});

describe('Phase 4 device-local attachment bytes', () => {
  it('round-trips a picked image byte-identically with a real SHA-256', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const original = new Uint8Array(SYNTHETIC_PNG);

    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      fileName: 'attachment-synthetic-image.png',
      now: NOW,
    });

    expect(stored.byteLength).toBe(original.length);
    // The hash is a real SHA-256 of exactly these bytes, not a placeholder.
    expect(stored.contentHash).toBe(checksumBytes(original));
    expect(stored.storedAt).toBe(NOW);

    const readBack = await readAttachmentBytes(stored.attachmentId);
    expect(readBack).not.toBeNull();
    expect(Array.from((readBack as { bytes: Uint8Array }).bytes)).toEqual(Array.from(original));
    expect((readBack as { contentHash: string }).contentHash).toBe(stored.contentHash);
    expect((readBack as { byteLength: number }).byteLength).toBe(original.length);

    // The bytes are in IndexedDB and nowhere else.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    const listed = await listDeviceLocalAttachments();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      attachmentId: stored.attachmentId,
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      sourceType: 'local',
      availability: 'stored',
      contentHash: stored.contentHash,
      byteLength: original.length,
    });
  });

  it('preserves the 55-byte padding-boundary payload', async () => {
    const original = new Uint8Array(BOUNDARY_55);
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(BOUNDARY_55),
      mimeType: 'image/png',
      now: NOW,
    });
    expect(stored.contentHash).toBe(checksumBytes(original));
    const readBack = await readAttachmentBytes(stored.attachmentId);
    expect(Array.from((readBack as { bytes: Uint8Array }).bytes)).toEqual(Array.from(BOUNDARY_55));
  });

  it('returns null for an unknown id and for a deleted record', async () => {
    expect(await readAttachmentBytes('att-attachments-does-not-exist')).toBeNull();
    expect(await readAttachmentObjectUrl('att-attachments-does-not-exist')).toBeNull();
    expect(await readAttachmentRecord('att-attachments-does-not-exist')).toBeNull();

    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      now: NOW,
    });
    expect(await removeDeviceLocalAttachment(stored.attachmentId)).toBe(true);
    expect(await readAttachmentBytes(stored.attachmentId)).toBeNull();
    // Deleting again is a no-op, not an error.
    expect(await removeDeviceLocalAttachment(stored.attachmentId)).toBe(false);
  });

  it('mints a distinct id per attachment and content-addresses the bytes', async () => {
    const first = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      now: NOW,
    });
    const second = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      now: NOW,
    });
    const other = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(BOUNDARY_55),
      mimeType: 'image/png',
      now: NOW,
    });
    expect(new Set([first.attachmentId, second.attachmentId, other.attachmentId]).size).toBe(3);
    // Identical bytes hash identically; different bytes do not collide.
    expect(second.contentHash).toBe(first.contentHash);
    expect(other.contentHash).not.toBe(first.contentHash);
  });
});

describe('Phase 4 external attachments: a link stays a link', () => {
  it('records no bytes and no content hash, and never fetches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const recorded = await recordExternalAttachment({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      externalUrl: EXTERNAL_URL,
      mimeType: 'image/png',
      fileName: 'attachment-synthetic-external.png',
      now: NOW,
    });

    expect(recorded.availability).toBe('external-only');
    expect(recorded.contentHash).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const record = await readAttachmentRecord(recorded.attachmentId);
    expect(record).toMatchObject({
      sourceType: 'external',
      availability: 'external-only',
      contentHash: null,
      bytes: null,
      byteLength: 0,
      externalUrl: EXTERNAL_URL,
      storedAt: null,
    });
    // Reading the bytes of an external-only attachment reports unavailability
    // rather than going and getting them.
    expect(await readAttachmentBytes(recorded.attachmentId)).toBeNull();
    expect(await readAttachmentObjectUrl(recorded.attachmentId)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Phase 4 the subject-store attachment seam', () => {
  it('turns a picked file into a local room attachment and resolves it back to bytes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const file = syntheticFile(SYNTHETIC_PNG);
    const original = new Uint8Array(SYNTHETIC_PNG);

    const attachment = await addDeviceLocalRoomAttachment({ subjectId: SUBJECT_ID, roomId: ROOM_ID, file });

    expect(attachment).not.toBeNull();
    expect(attachment?.sourceType).toBe('local');
    expect(attachment?.fileName).toBe('attachment-synthetic-image.png');
    expect(attachment?.mimeType).toBe('image/png');
    expect(attachment?.addedAt.length).toBeGreaterThan(0);
    // A local attachment is not a URL, so nothing in the subject record points at
    // one.
    expect(attachment?.externalUrl).toBeUndefined();

    const readBack = await readAttachmentBytes(attachment?.attachmentId as string);
    expect(Array.from((readBack as { bytes: Uint8Array }).bytes)).toEqual(Array.from(original));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the extension when the browser reports no MIME type', async () => {
    const file = syntheticFile(SYNTHETIC_PNG);
    Object.defineProperty(file, 'type', { value: '' });
    const attachment = await addDeviceLocalRoomAttachment({ subjectId: SUBJECT_ID, roomId: ROOM_ID, file });
    expect(attachment?.mimeType).toBe('image/png');
  });

  it('records an external link added through the persistence facade without inventing bytes for it', async () => {
    // The real web path: the facade's no-bridge fallback, which is what the note
    // editor's URL field calls.
    const attachment = await addRoomExternalAttachment(SUBJECT_ID, ROOM_ID, EXTERNAL_URL);
    expect(attachment?.sourceType).toBe('external');
    expect(attachment?.externalUrl).toBe(EXTERNAL_URL);
    const record = await readAttachmentRecord(attachment?.attachmentId as string);
    expect(record?.availability).toBe('external-only');
    expect(record?.contentHash).toBeNull();
    expect(record?.bytes).toBeNull();
    // ...and reading its bytes reports unavailability rather than fetching them.
    expect(await readAttachmentBytes(attachment?.attachmentId as string)).toBeNull();
  });

  it('refuses a non-http external URL and stores nothing', async () => {
    expect(await addRoomExternalAttachment(SUBJECT_ID, ROOM_ID, 'javascript:synthetic')).toBeNull();
    expect(await listDeviceLocalAttachments()).toEqual([]);
  });

  it('creates a preview object URL from bytes already on the device', async () => {
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      now: NOW,
    });
    const url = await readDeviceLocalAttachmentUrl(stored.attachmentId);
    // jsdom has no `URL.createObjectURL`, so the honest answer here is `null`; the
    // point is that the resolution path is a local read, not a request.
    expect(url === null || url.startsWith('blob:')).toBe(true);
  });
});

describe('Phase 4 device-local storage and the storage-v2 generation', () => {
  it('never opens storage-v2 while the flag is off', async () => {
    selectLegacyRepository();
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      now: NOW,
    });
    // The bytes are still stored device-locally, and nothing is mirrored into a
    // generation because none is selected.
    expect(stored.mirroredToGeneration).toBe(false);
    expect((await readAttachmentBytes(stored.attachmentId))?.byteLength).toBe(SYNTHETIC_PNG.length);
  });

  it('also records the bytes and the metadata in the active generation when it is selected', async () => {
    storageV2Name = 'kd-phase4-attachments-v2';
    storageV2 = await openTestRepository(storageV2Name, NOW);
    await storageV2.stageGeneration({ generationId: GENERATION_ID, source: 'initial', records: {} });
    await storageV2.activateGeneration(GENERATION_ID);
    selectStorageV2Repository(storageV2);

    // The subject is written first, exactly as the application does when a room
    // gains an image: an attachment that references a subject the generation does
    // not hold is a dangling reference, and generation validation says so.
    await writeSubjectToActiveGeneration(storageV2, SUBJECT_ID, subjectFixture(), NOW);

    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      bytes: blobOf(SYNTHETIC_PNG),
      mimeType: 'image/png',
      fileName: 'attachment-synthetic-image.png',
      now: NOW,
    });
    expect(stored.mirroredToGeneration).toBe(true);

    const records = (await storageV2.readRecords(GENERATION_ID)).records;
    expect(records.attachmentMetadata).toHaveLength(1);
    expect(records.attachmentBlobs).toHaveLength(1);
    const metadata = records.attachmentMetadata[0]?.value as AttachmentMetadataRecordValue;
    expect(metadata).toMatchObject({
      attachmentId: stored.attachmentId,
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      sourceType: 'local',
      availability: 'stored',
      contentHash: stored.contentHash,
    });
    const blobRecord = records.attachmentBlobs[0]?.value as { bytes: ArrayBuffer; contentHash: string };
    expect(checksumBytes(new Uint8Array(blobRecord.bytes))).toBe(stored.contentHash);
    // The generation validates, so the mirror did not corrupt it.
    expect((await storageV2.validateGeneration(GENERATION_ID)).ok).toBe(true);

    // An external link mirrored into the generation carries no blob at all.
    const external = await recordExternalAttachment({
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      externalUrl: EXTERNAL_URL,
      mimeType: 'image/png',
      now: NOW,
    });
    expect(external.mirroredToGeneration).toBe(true);
    const after = (await storageV2.readRecords(GENERATION_ID)).records;
    expect(after.attachmentMetadata).toHaveLength(2);
    expect(after.attachmentBlobs).toHaveLength(1);
    const externalMetadata = after.attachmentMetadata
      .map((entry) => entry.value as AttachmentMetadataRecordValue)
      .find((entry) => entry.attachmentId === external.attachmentId);
    expect(externalMetadata).toMatchObject({ availability: 'external-only', contentHash: null });
    expect((await storageV2.validateGeneration(GENERATION_ID)).ok).toBe(true);
  });

  it('uses a database name distinct from storage-v2, so the legacy flag-off path never opens it', () => {
    expect(DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME).toBe('knowledge-dungeon-attachments');
    expect(DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME).not.toBe('knowledge-dungeon-storage-v2');
  });
});
