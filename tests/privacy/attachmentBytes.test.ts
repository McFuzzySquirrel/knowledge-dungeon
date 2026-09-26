/**
 * Phase 4 privacy gate, test 2: attachment bytes are device-local.
 *
 * Plan section 2.3: "Web image attachments are stored locally in IndexedDB and
 * are no longer uploaded to `/api/upload` by the redesigned application." A
 * device-local attachment is only real if the bytes come back byte-identical
 * and the recorded content hash is a genuine SHA-256 of those bytes, so this
 * file writes a synthetic image through the storage layer, reads it back, and
 * compares both the raw bytes and the hash.
 *
 * Two halves, and the distinction matters:
 *
 * - **Green, load-bearing.** The round trip runs through the real storage-v2
 *   repository with the real record contract (`AttachmentBlobRecordValue` plus
 *   `AttachmentMetadataRecordValue`) and the real `checksum.ts` helpers. This
 *   pins the invariant on the primitive Phase 3 shipped, so when the application
 *   layer lands it is already known to hold underneath it.
 * - **Registered reproduction.** The application-level device-local attachment
 *   store does not exist yet. It is written against the interface the Phase 4
 *   application change is specified to provide and registered with `it.fails`,
 *   so it is green now, goes RED the moment the interface lands, and is a live
 *   failure if a landed store stops preserving bytes.
 *
 * Privacy: every byte sequence here is synthetic and self-describing. The only
 * "URL" that appears in this file is the reserved `example.invalid` host, and it
 * is never fetched. No learner data exists in this suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checksumBytes } from '@/services/persistence/v2/checksum';
import { deleteTestDatabase, openTestRepository, MIGRATION_NOW } from '../migrations/support/storageV2TestSupport';
import {
  STORAGE_V2_DATABASE_NAME,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
} from '@/services/persistence/v2/schema';
import { validateAttachmentBlobRecord, validateAttachmentMetadataRecord } from '@/services/persistence/v2/validation';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const GENERATION_ID = 'gen-privacy-attachment-0001';
const SUBJECT_ID = 'subject-privacy-synthetic';
const ROOM_ID = 'room-privacy-synthetic';
const ATTACHMENT_ID = 'att-privacy-synthetic';
const NOW = MIGRATION_NOW;

/**
 * A complete, valid 1x1 PNG built byte by byte, so the payload is synthetic and
 * self-describing rather than copied from anywhere. The trailing marker bytes
 * are arbitrary and make the payload 67 bytes long.
 */
const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

/**
 * 55 bytes: the SHA-256 padding boundary that produced a valid digest of a
 * different message in Phase 3. A device-local attachment of exactly this size
 * must still hash to its own bytes.
 */
const BOUNDARY_55: readonly number[] = Array.from({ length: 55 }, (_unused, index) => (index * 7) % 251);

/** FIPS 180-4 published vectors, so the hash assertion is not self-referential. */
const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const hasSubtle = typeof globalThis.crypto?.subtle?.digest === 'function';

/**
 * `new Uint8Array(view)` copies the elements into the current realm. Under
 * jsdom the test realm and Node's crypto realm differ, and Node 20 rejects a
 * cross-realm `ArrayBuffer` from `bytes.buffer.slice(...)` while Node 22 accepts
 * it. That divergence is the recorded Phase 3 CI-only failure.
 */
async function subtleHex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function blobOf(bytes: readonly number[]): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
}

let repository: StorageV2Repository | null = null;
let databaseName = '';

async function repositoryFor(suffix: string): Promise<StorageV2Repository> {
  databaseName = `kd-privacy-attachment-${suffix}`;
  repository = await openTestRepository(databaseName, NOW);
  await repository.stageGeneration({ generationId: GENERATION_ID, source: 'local-edit', records: {} });
  await repository.activateGeneration(GENERATION_ID);
  return repository;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
});

describe('Phase 4 privacy gate 2: device-local attachment bytes are stored, not uploaded', () => {
  it('checksumBytes matches the published SHA-256 vectors and an independent Web Crypto digest', async () => {
    // The independent half of the assertion: the content hash the gate relies on
    // is genuinely SHA-256, not merely a 64-character hex string.
    expect(checksumBytes(new Uint8Array(0))).toBe(SHA256_OF_EMPTY);
    expect(checksumBytes(new TextEncoder().encode('abc'))).toBe(SHA256_OF_ABC);

    for (const payload of [SYNTHETIC_PNG, BOUNDARY_55]) {
      const bytes = new Uint8Array(payload);
      const ours = checksumBytes(bytes);
      expect(ours).toMatch(/^[0-9a-f]{64}$/);
      if (hasSubtle) {
        expect(ours, `${bytes.length} bytes`).toBe(await subtleHex(bytes));
      }
    }
  });

  it('round-trips a synthetic image Blob through the real attachment records byte for byte', async () => {
    const repo = await repositoryFor('roundtrip');
    const original = new Uint8Array(SYNTHETIC_PNG);
    const blob = blobOf(SYNTHETIC_PNG);
    const contentHash = checksumBytes(original);

    // The write path takes a real `Blob`, exactly as a file picker would hand
    // one to the application, and converts it to the stored byte form.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(original.length);

    const metadata: AttachmentMetadataRecordValue = {
      attachmentId: ATTACHMENT_ID,
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      sourceType: 'local',
      mimeType: 'image/png',
      availability: 'stored',
      contentHash,
      fileName: 'privacy-synthetic-attachment.png',
      altText: 'privacy synthetic alt text',
      addedAt: NOW,
    };
    const blobRecord: AttachmentBlobRecordValue = {
      attachmentId: ATTACHMENT_ID,
      contentHash,
      bytes: bytes.buffer,
      byteLength: bytes.length,
      storedAt: NOW,
    };

    // Both record kinds validate under the real validators before they are
    // written, so an inconsistent pair fails here rather than silently.
    expect(validateAttachmentMetadataRecord(metadata)).toEqual({ ok: true, problems: [] });
    expect(validateAttachmentBlobRecord(blobRecord)).toEqual({ ok: true, problems: [] });

    await repo.putRecords(GENERATION_ID, {
      attachmentMetadata: [metadata],
      attachmentBlobs: [blobRecord],
    });

    const records = await repo.readRecords(GENERATION_ID);
    expect(records.records.attachmentMetadata).toHaveLength(1);
    expect(records.records.attachmentBlobs).toHaveLength(1);

    const storedBlob = (records.records.attachmentBlobs[0] as { value: AttachmentBlobRecordValue }).value;
    const storedMetadata = (records.records.attachmentMetadata[0] as { value: AttachmentMetadataRecordValue }).value;

    // Byte identity, element by element, not merely a matching length.
    const readBack = new Uint8Array(storedBlob.bytes);
    expect(readBack.length).toBe(original.length);
    expect(Array.from(readBack)).toEqual(Array.from(original));
    expect(storedBlob.byteLength).toBe(original.length);
    expect(checksumBytes(readBack)).toBe(contentHash);
    expect(storedBlob.contentHash).toBe(contentHash);
    expect(storedMetadata.contentHash).toBe(contentHash);
    expect(storedMetadata.availability).toBe('stored');
    expect(storedMetadata.sourceType).toBe('local');

    // A second read is identical: nothing is consumed or re-encoded on read.
    const second = await repo.readRecords(GENERATION_ID);
    const secondRead = new Uint8Array(
      (second.records.attachmentBlobs[0] as { value: AttachmentBlobRecordValue }).value.bytes,
    );
    expect(Array.from(secondRead)).toEqual(Array.from(original));

    // The bytes did not leak into `localStorage` on the way through.
    expect(window.localStorage.length).toBe(0);
  });

  it('preserves the 55-byte padding-boundary payload and addresses it by content', async () => {
    const repo = await repositoryFor('boundary');
    const original = new Uint8Array(BOUNDARY_55);
    expect(original.length).toBe(55);
    const contentHash = checksumBytes(original);

    await repo.putRecords(GENERATION_ID, {
      attachmentBlobs: [
        {
          attachmentId: 'att-privacy-boundary',
          contentHash,
          bytes: original.buffer,
          byteLength: original.length,
          storedAt: NOW,
        },
      ],
    });

    const records = await repo.readRecords(GENERATION_ID);
    const stored = (records.records.attachmentBlobs[0] as { value: AttachmentBlobRecordValue }).value;
    const readBack = new Uint8Array(stored.bytes);
    expect(Array.from(readBack)).toEqual(Array.from(original));
    // The boundary length is where Phase 3 shipped a valid digest of a
    // different message, so the hash is compared against an independent
    // implementation rather than against the module under test.
    expect(stored.contentHash).toBe(contentHash);
    expect(stored.contentHash).not.toBe(checksumBytes(new Uint8Array(64).fill(0)));
    if (hasSubtle) expect(stored.contentHash).toBe(await subtleHex(original));

    // Content addressing: the same bytes under a different attachment id carry
    // the same hash, and a different payload does not collide with it.
    await repo.putRecords(GENERATION_ID, {
      attachmentBlobs: [
        {
          attachmentId: 'att-privacy-boundary-copy',
          contentHash,
          bytes: original.buffer.slice(0),
          byteLength: original.length,
          storedAt: NOW,
        },
        {
          attachmentId: 'att-privacy-other',
          contentHash: checksumBytes(new Uint8Array(SYNTHETIC_PNG)),
          bytes: new Uint8Array(SYNTHETIC_PNG).buffer,
          byteLength: SYNTHETIC_PNG.length,
          storedAt: NOW,
        },
      ],
    });
    const all = await repo.readRecords(GENERATION_ID);
    expect(all.records.attachmentBlobs).toHaveLength(3);
    const hashes = all.records.attachmentBlobs.map(
      (record) => (record.value as AttachmentBlobRecordValue).contentHash,
    );
    expect(new Set(hashes).size).toBe(2);
  });

  it('records an external attachment as unavailable bytes rather than a silent download', async () => {
    // The honest representation: an attachment whose bytes are not on the device
    // is stored with no content hash, and the repository never invents bytes for
    // it. `contentHash: null` is the whole point of the disclosure.
    const repo = await repositoryFor('external-only');
    const metadata: AttachmentMetadataRecordValue = {
      attachmentId: 'att-privacy-external',
      subjectId: SUBJECT_ID,
      roomId: ROOM_ID,
      sourceType: 'external',
      mimeType: 'image/png',
      availability: 'external-only',
      contentHash: null,
      externalUrl: 'https://example.invalid/synthetic-external.png',
      addedAt: NOW,
    };
    expect(validateAttachmentMetadataRecord(metadata)).toEqual({ ok: true, problems: [] });

    // A claimed hash on an external-only record is rejected, so a future write
    // path cannot fake availability.
    expect(
      validateAttachmentMetadataRecord({ ...metadata, contentHash: checksumBytes(new Uint8Array(1)) })
        .problems.map((problem) => problem.code),
    ).toContain('content-hash-mismatch');

    await repo.putRecords(GENERATION_ID, { attachmentMetadata: [metadata] });
    const records = await repo.readRecords(GENERATION_ID);
    expect(records.records.attachmentBlobs).toEqual([]);
    const stored = (records.records.attachmentMetadata[0] as { value: AttachmentMetadataRecordValue }).value;
    expect(stored.availability).toBe('external-only');
    expect(stored.contentHash).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});

// ── Registered reproduction ────────────────────────────────────────────────

/**
 * The interface this reproduction waits on.
 *
 * The Phase 4 application change must provide a device-local attachment-bytes
 * store in the storage-v2 tree that:
 *
 * 1. accepts a real `Blob` (what a file picker produces), plus the subject and
 *    room it belongs to, and returns the attachment id, the SHA-256 content
 *    hash of the stored bytes, and the stored byte length;
 * 2. reads the bytes back for an attachment id, or reports that the bytes are
 *    unavailable (`null`) rather than fetching anything;
 * 3. performs no network request of any kind.
 *
 * The module is discovered by looking for the first candidate that exports
 * `storeAttachmentBytes` and `readAttachmentBytes`; the required contract is the
 * function pair and its result shape, not the file name. Adjust
 * `CANDIDATE_STORE_MODULES` if the implementation lands under a different
 * path.
 */
const CANDIDATE_STORE_MODULES = [
  '@/services/persistence/v2/attachmentBytes',
  '@/services/persistence/v2/attachmentStore',
  '@/services/persistence/v2/attachments',
  '@/services/persistence/attachmentBytes',
] as const;

interface StoredAttachmentSummary {
  readonly attachmentId: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

interface ReadAttachmentResult {
  readonly bytes: Uint8Array;
  readonly contentHash: string;
}

interface DeviceLocalAttachmentStore {
  storeAttachmentBytes(input: {
    readonly subjectId: string;
    readonly roomId: string;
    readonly bytes: Blob;
    readonly mimeType: string;
  }): Promise<StoredAttachmentSummary>;
  readAttachmentBytes(attachmentId: string): Promise<ReadAttachmentResult | null>;
}

async function loadDeviceLocalAttachmentStore(): Promise<DeviceLocalAttachmentStore> {
  const resolved: string[] = [];
  for (const specifier of CANDIDATE_STORE_MODULES) {
    let module: Record<string, unknown>;
    try {
      module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof module.storeAttachmentBytes === 'function' && typeof module.readAttachmentBytes === 'function') {
      return module as unknown as DeviceLocalAttachmentStore;
    }
    resolved.push(specifier);
  }
  throw new Error(
    'No device-local attachment-bytes store is available. Expected a module exporting ' +
      '`storeAttachmentBytes({ subjectId, roomId, bytes, mimeType })` and ' +
      '`readAttachmentBytes(attachmentId)`. Checked: ' +
      `${CANDIDATE_STORE_MODULES.join(', ')} (loaded but without the contract: ${
        resolved.length > 0 ? resolved.join(', ') : 'none'
      }).`,
  );
}

describe('Phase 4 privacy gate 2 reproduction: the application attachment-bytes store', () => {
  it(
    'a picked image is written device-locally and read back byte-identically with a matching SHA-256',
    async () => {
      // The interface this reproduction waited on: `storeAttachmentBytes` /
      // `readAttachmentBytes` in the storage-v2 tree. It landed in
      // `src/services/persistence/v2/attachmentBytes.ts`, so this is now a live
      // assertion rather than a registered failure.
      await deleteTestDatabase(STORAGE_V2_DATABASE_NAME);
      const store = await loadDeviceLocalAttachmentStore();
      const original = new Uint8Array(SYNTHETIC_PNG);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const stored = await store.storeAttachmentBytes({
        subjectId: SUBJECT_ID,
        roomId: ROOM_ID,
        bytes: blobOf(SYNTHETIC_PNG),
        mimeType: 'image/png',
      });

      expect(stored.byteLength).toBe(original.length);
      expect(stored.contentHash).toBe(checksumBytes(original));
      expect(stored.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.attachmentId.length).toBeGreaterThan(0);

      const readBack = await store.readAttachmentBytes(stored.attachmentId);
      expect(readBack).not.toBeNull();
      const readBytes = (readBack as ReadAttachmentResult).bytes;
      expect(Array.from(readBytes)).toEqual(Array.from(original));
      expect((readBack as ReadAttachmentResult).contentHash).toBe(stored.contentHash);
      expect(checksumBytes(readBytes)).toBe(stored.contentHash);

      // An unknown id reports unavailable bytes rather than fetching anything.
      expect(await store.readAttachmentBytes('att-privacy-does-not-exist')).toBeNull();
      // Writing a device-local attachment must not touch the network.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      // ...and must not put the bytes in `localStorage`.
      expect(window.localStorage.length).toBe(0);
      await deleteTestDatabase(STORAGE_V2_DATABASE_NAME);
    },
  );
});
