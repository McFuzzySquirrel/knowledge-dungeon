/**
 * Device-local attachment bytes.
 *
 * Plan section 2.3: "Web image attachments are stored locally in IndexedDB and
 * are no longer uploaded to `/api/upload` by the redesigned application." This
 * module is where that promise is kept, and it is deliberately the only way image
 * bytes enter storage from the web build.
 *
 * Three properties the rest of the design depends on:
 *
 * 1. **Device-local in both repository modes.** The bytes live in their own small
 *    IndexedDB database, not in the storage-v2 generation model and not in
 *    `localStorage`. The legacy repository therefore still gets a working,
 *    reload-surviving local image *without* the storage-v2 database ever being
 *    opened, which is what "with the flag off, do not write to storage-v2 at
 *    all" requires.
 * 2. **Never a network call.** There is no `fetch`, no `XMLHttpRequest`, and no
 *    URL dereference anywhere in this file. An external attachment is recorded as
 *    `external-only` with `contentHash: null` and no bytes; it is never
 *    downloaded behind the learner's back.
 * 3. **A real content hash.** The recorded `contentHash` is
 *    `checksumBytes(bytes)` - the same SHA-256 the storage-v2 checksums and the
 *    plan section 7.3 `attachments/<sha256>` contract use.
 *
 * When the storage-v2 repository is selected, the same write is *also* recorded
 * into the active generation, so a later full-device backup (Phase 5) can include
 * the bytes and the storage-v2 lane can observe the real application write. That
 * mirror is best-effort and reported, never fatal to the device-local write.
 *
 * Renderer-neutral: no renderer import. The only global it touches is IndexedDB.
 */

import { checksumBytes } from './checksum';
import {
  StorageV2Error,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
} from './schema';
import { recordDualWriteReport } from './dualWrite';
import { currentStorageV2Repository, isStorageV2Selected } from './repositorySelection';

// ── Database contract ─────────────────────────────────────────────────────

/**
 * Database name for device-local attachment bytes.
 *
 * Separate from {@link STORAGE_V2_DATABASE_NAME} on purpose: this database has
 * no generations, so it is valid in the legacy repository too, and opening it
 * never counts as "writing to storage-v2".
 */
export const DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME = 'knowledge-dungeon-attachments';

/** Structural version. Bump only for a store or index change. */
export const DEVICE_LOCAL_ATTACHMENT_SCHEMA_VERSION = 1;

/** The one object store: one record per attachment, bytes inline. */
export const DEVICE_LOCAL_ATTACHMENT_STORE = 'attachmentBytes';

/** Index from a subject id to its attachment records. */
export const DEVICE_LOCAL_ATTACHMENT_SUBJECT_INDEX = 'bySubject';

/** How an attachment's bytes are (or are not) on the device. */
export type DeviceLocalAvailability = 'stored' | 'external-only';

/** One device-local attachment record. */
export interface DeviceLocalAttachmentRecord {
  attachmentId: string;
  subjectId: string;
  roomId: string;
  sourceType: 'local' | 'external';
  mimeType: string;
  availability: DeviceLocalAvailability;
  /** SHA-256 of {@link bytes}, or `null` when no bytes are on the device. */
  contentHash: string | null;
  /** `null` unless `availability === 'stored'`. */
  bytes: ArrayBuffer | null;
  /** `0` for an external-only attachment. */
  byteLength: number;
  fileName: string | null;
  /**
   * Kept only so the renderer can display the attachment the learner already
   * has. It is never copied into a report, a receipt, or a log.
   */
  externalUrl: string | null;
  altText: string | null;
  addedAt: string;
  /** `null` unless `availability === 'stored'`. */
  storedAt: string | null;
}

// ── Open / upgrade ────────────────────────────────────────────────────────

function resolveIndexedDB(factory?: IDBFactory): IDBFactory {
  const global = globalThis as { indexedDB?: IDBFactory };
  const resolved = factory ?? global.indexedDB;
  if (!resolved) {
    throw new StorageV2Error(
      'INDEXEDDB_UNAVAILABLE',
      { api: 'indexedDB' },
      'device-local attachment storage requires IndexedDB, which this environment does not provide.',
    );
  }
  return resolved;
}

export function openDeviceLocalAttachmentDatabase(
  options: { databaseName?: string; indexedDB?: IDBFactory } = {},
): Promise<IDBDatabase> {
  const factory = resolveIndexedDB(options.indexedDB);
  const databaseName = options.databaseName ?? DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME;

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DEVICE_LOCAL_ATTACHMENT_SCHEMA_VERSION);
    } catch (error) {
      reject(error instanceof StorageV2Error ? error : new StorageV2Error('DATABASE_OPEN_FAILED', { databaseName }));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(DEVICE_LOCAL_ATTACHMENT_STORE)) return;
      const store = db.createObjectStore(DEVICE_LOCAL_ATTACHMENT_STORE, { keyPath: 'attachmentId' });
      store.createIndex(DEVICE_LOCAL_ATTACHMENT_SUBJECT_INDEX, 'subjectId', { unique: false });
    };
    request.onerror = () =>
      reject(new StorageV2Error('DATABASE_OPEN_FAILED', { databaseName }));
    request.onblocked = () =>
      reject(
        new StorageV2Error(
          'DATABASE_OPEN_FAILED',
          { databaseName },
          'device-local attachment storage upgrade is blocked by another open connection.',
        ),
      );
    request.onsuccess = () => {
      const db = request.result;
      if (db.version > DEVICE_LOCAL_ATTACHMENT_SCHEMA_VERSION) {
        db.close();
        reject(
          new StorageV2Error('DATABASE_VERSION_TOO_LOW', {
            found: db.version,
            supported: DEVICE_LOCAL_ATTACHMENT_SCHEMA_VERSION,
          }),
        );
        return;
      }
      resolve(db);
    };
  });
}

/**
 * One cached connection.
 *
 * The promise is cached rather than the connection so two concurrent first reads
 * cannot open two databases, and the connection is held for the app's lifetime
 * rather than closed after each call: closing it while the cache still holds it
 * would hand the next caller an unusable handle. Teardown is explicit, through
 * {@link closeDeviceLocalAttachmentStore}.
 */
let cachedDatabase: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  cachedDatabase ??= openDeviceLocalAttachmentDatabase();
  return cachedDatabase;
}

/** Close the cached connection. Test support and app teardown. */
export function closeDeviceLocalAttachmentStore(): void {
  const pending = cachedDatabase;
  cachedDatabase = null;
  void pending?.then((db) => db.close()).catch(() => undefined);
}

/** Delete the whole device-local attachment database. Test support. */
export function deleteDeviceLocalAttachmentDatabase(
  databaseName: string = DEVICE_LOCAL_ATTACHMENT_DATABASE_NAME,
): Promise<void> {
  closeDeviceLocalAttachmentStore();
  return new Promise<void>((resolve) => {
    const request = globalThis.indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new StorageV2Error('TRANSACTION_FAILED', { store: DEVICE_LOCAL_ATTACHMENT_STORE }));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new StorageV2Error('TRANSACTION_ABORTED', { store: DEVICE_LOCAL_ATTACHMENT_STORE }));
    tx.onerror = () => reject(new StorageV2Error('TRANSACTION_FAILED', { store: DEVICE_LOCAL_ATTACHMENT_STORE }));
  });
}

// ── Identifier minting ────────────────────────────────────────────────────

let fallbackCounter = 0;

/**
 * A fresh attachment id.
 *
 * Prefers `crypto.randomUUID`. The fallback is a counter plus a clock reading,
 * so it is still unique within a session even where Web Crypto is unavailable.
 * The value is an opaque identifier: it never contains learner content.
 */
function mintAttachmentId(): string {
  const global = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof global.crypto?.randomUUID === 'function') {
    return `att-${global.crypto.randomUUID()}`;
  }
  fallbackCounter += 1;
  return `att-${Date.now().toString(36)}-${fallbackCounter.toString(36).padStart(4, '0')}`;
}

// ── Storage-v2 generation mirror ──────────────────────────────────────────

/**
 * Copy a device-local record into the active storage-v2 generation.
 *
 * Best effort by design: the device-local database is the authoritative copy in
 * both repository modes, so a failure here is reported and never fatal. It is a
 * no-op when storage-v2 is not the selected repository, which is what keeps the
 * legacy build from ever opening the storage-v2 database.
 */
async function mirrorIntoActiveGeneration(
  record: DeviceLocalAttachmentRecord,
): Promise<boolean> {
  if (!isStorageV2Selected()) return false;
  const repository = currentStorageV2Repository();
  if (repository === null) return false;

  const metadata: AttachmentMetadataRecordValue = {
    attachmentId: record.attachmentId,
    subjectId: record.subjectId,
    roomId: record.roomId,
    sourceType: record.sourceType,
    mimeType: record.mimeType,
    availability: record.availability,
    contentHash: record.contentHash,
    ...(record.fileName !== null ? { fileName: record.fileName } : {}),
    ...(record.externalUrl !== null ? { externalUrl: record.externalUrl } : {}),
    ...(record.altText !== null ? { altText: record.altText } : {}),
    addedAt: record.addedAt,
  };
  const blobs: AttachmentBlobRecordValue[] =
    record.availability === 'stored' && record.bytes !== null && record.contentHash !== null
      ? [
          {
            attachmentId: record.attachmentId,
            contentHash: record.contentHash,
            bytes: record.bytes,
            byteLength: record.byteLength,
            storedAt: record.storedAt ?? record.addedAt,
          },
        ]
      : [];

  try {
    const activeGenerationId = await repository.readActiveGenerationId();
    if (activeGenerationId === null) return false;
    await repository.putRecords(activeGenerationId, {
      attachmentMetadata: [metadata],
      attachmentBlobs: blobs,
    });
    return true;
  } catch {
    recordDualWriteReport('attachment.bytes', 'mirror-failed', 'STORAGE_V2_WRITE_FAILED');
    return false;
  }
}

// ── Public store API ──────────────────────────────────────────────────────

export interface StoreAttachmentBytesInput {
  readonly subjectId: string;
  readonly roomId: string;
  /** A real `Blob`, exactly what a file picker produces. */
  readonly bytes: Blob;
  readonly mimeType: string;
  readonly fileName?: string | null;
  readonly altText?: string | null;
  /** Injected for deterministic tests; defaults to the real clock. */
  readonly now?: string;
}

export interface StoredAttachmentSummary {
  readonly attachmentId: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly storedAt: string;
  /** True when the record was also written into the active storage-v2 generation. */
  readonly mirroredToGeneration: boolean;
}

export interface ReadAttachmentResult {
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly storedAt: string;
}

export interface RecordExternalAttachmentInput {
  readonly subjectId: string;
  readonly roomId: string;
  readonly externalUrl: string;
  readonly mimeType: string;
  readonly fileName?: string | null;
  readonly altText?: string | null;
  readonly now?: string;
}

export interface ExternalAttachmentSummary {
  readonly attachmentId: string;
  readonly availability: 'external-only';
  readonly contentHash: null;
  readonly mirroredToGeneration: boolean;
}

/**
 * Store picked image bytes on this device.
 *
 * The returned `contentHash` is a real SHA-256 of exactly the bytes written, and
 * `readAttachmentBytes` returns those bytes unchanged. The write is a single
 * IndexedDB read-write transaction, so a failure leaves no partial record.
 */
export async function storeAttachmentBytes(
  input: StoreAttachmentBytesInput,
): Promise<StoredAttachmentSummary> {
  const nowIso = input.now ?? new Date().toISOString();
  const attachmentId = mintAttachmentId();
  const buffer = await input.bytes.arrayBuffer();
  const contentHash = checksumBytes(new Uint8Array(buffer));
  const byteLength = buffer.byteLength;

  const record: DeviceLocalAttachmentRecord = {
    attachmentId,
    subjectId: input.subjectId,
    roomId: input.roomId,
    sourceType: 'local',
    mimeType: input.mimeType,
    availability: 'stored',
    contentHash,
    // A copy, so a later mutation of the caller's buffer cannot change what was
    // hashed or what is stored.
    bytes: buffer.slice(0),
    byteLength,
    fileName: input.fileName ?? null,
    externalUrl: null,
    altText: input.altText ?? null,
    addedAt: nowIso,
    storedAt: nowIso,
  };

  const db = await database();
  const tx = db.transaction(DEVICE_LOCAL_ATTACHMENT_STORE, 'readwrite');
  tx.objectStore(DEVICE_LOCAL_ATTACHMENT_STORE).put(record);
  await transactionDone(tx);

  const mirrored = await mirrorIntoActiveGeneration(record);
  return { attachmentId, contentHash, byteLength, storedAt: nowIso, mirroredToGeneration: mirrored };
}

/**
 * Read an attachment's bytes back.
 *
 * Returns `null` for an unknown id, for an external-only attachment, and for a
 * record whose bytes are missing. It never fetches anything: an attachment whose
 * bytes are not on this device is reported as unavailable rather than retrieved.
 */
export async function readAttachmentBytes(attachmentId: string): Promise<ReadAttachmentResult | null> {
  const record = await readAttachmentRecord(attachmentId);
  if (record === null) return null;
  if (record.availability !== 'stored' || record.bytes === null || record.contentHash === null) {
    return null;
  }
  const bytes = new Uint8Array(record.bytes);
  return {
    bytes,
    contentHash: record.contentHash,
    byteLength: bytes.byteLength,
    storedAt: record.storedAt ?? record.addedAt,
  };
}

/**
 * An object URL for a stored attachment, for a user-initiated preview.
 *
 * `null` when the bytes are not on this device. The caller owns the returned URL
 * and must revoke it; a preview is a display of bytes already present, never a
 * fetch.
 */
export async function readAttachmentObjectUrl(attachmentId: string): Promise<string | null> {
  const record = await readAttachmentRecord(attachmentId);
  if (record === null) return null;
  if (record.availability !== 'stored' || record.bytes === null) return null;
  const create = (globalThis as { URL?: { createObjectURL?: (blob: Blob) => string } }).URL;
  if (typeof create?.createObjectURL !== 'function') return null;
  // Copied into a fresh `ArrayBuffer` rather than handed over as a `Uint8Array`
  // view: a view over a `SharedArrayBuffer`-typed buffer is not a `BlobPart`, and
  // the copy also guarantees the blob owns exactly the stored bytes.
  const copy = new ArrayBuffer(record.byteLength);
  new Uint8Array(copy).set(new Uint8Array(record.bytes));
  return create.createObjectURL(new Blob([copy], { type: record.mimeType }));
}

/** The whole record, including `external-only` entries with no bytes. */
export async function readAttachmentRecord(
  attachmentId: string,
): Promise<DeviceLocalAttachmentRecord | null> {
  const db = await database();
  const record = await requestResult<DeviceLocalAttachmentRecord | undefined>(
    db.transaction(DEVICE_LOCAL_ATTACHMENT_STORE, 'readonly').objectStore(DEVICE_LOCAL_ATTACHMENT_STORE).get(attachmentId),
  );
  return record ?? null;
}

/**
 * Record an external image link without downloading it.
 *
 * The honest representation of "the learner pasted a link": the URL is kept so
 * the renderer can still show it, `contentHash` is `null` because no bytes exist
 * on this device, and no blob is ever written. Nothing is fetched.
 */
export async function recordExternalAttachment(
  input: RecordExternalAttachmentInput,
): Promise<ExternalAttachmentSummary> {
  const nowIso = input.now ?? new Date().toISOString();
  const attachmentId = mintAttachmentId();
  const record: DeviceLocalAttachmentRecord = {
    attachmentId,
    subjectId: input.subjectId,
    roomId: input.roomId,
    sourceType: 'external',
    mimeType: input.mimeType,
    availability: 'external-only',
    contentHash: null,
    bytes: null,
    byteLength: 0,
    fileName: input.fileName ?? null,
    externalUrl: input.externalUrl,
    altText: input.altText ?? null,
    addedAt: nowIso,
    storedAt: null,
  };

  const db = await database();
  const tx = db.transaction(DEVICE_LOCAL_ATTACHMENT_STORE, 'readwrite');
  tx.objectStore(DEVICE_LOCAL_ATTACHMENT_STORE).put(record);
  await transactionDone(tx);

  const mirrored = await mirrorIntoActiveGeneration(record);
  return { attachmentId, availability: 'external-only', contentHash: null, mirroredToGeneration: mirrored };
}

/** Remove a record. Returns `true` when one was removed. */
export async function deleteAttachmentBytes(attachmentId: string): Promise<boolean> {
  const db = await database();
  const tx = db.transaction(DEVICE_LOCAL_ATTACHMENT_STORE, 'readwrite');
  const store = tx.objectStore(DEVICE_LOCAL_ATTACHMENT_STORE);
  const existing = await requestResult<DeviceLocalAttachmentRecord | undefined>(store.get(attachmentId));
  if (existing === undefined) {
    await transactionDone(tx);
    return false;
  }
  store.delete(attachmentId);
  await transactionDone(tx);
  return true;
}

/** Byte-free projection of every device-local record, for reports and tests. */
export async function listDeviceLocalAttachments(): Promise<
  readonly {
    attachmentId: string;
    subjectId: string;
    roomId: string;
    sourceType: 'local' | 'external';
    availability: DeviceLocalAvailability;
    contentHash: string | null;
    byteLength: number;
  }[]
> {
  const db = await database();
  const all = await requestResult<DeviceLocalAttachmentRecord[]>(
    db.transaction(DEVICE_LOCAL_ATTACHMENT_STORE, 'readonly').objectStore(DEVICE_LOCAL_ATTACHMENT_STORE).getAll(),
  );
  return all
    .map((entry) => ({
      attachmentId: entry.attachmentId,
      subjectId: entry.subjectId,
      roomId: entry.roomId,
      sourceType: entry.sourceType,
      availability: entry.availability,
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
    }))
    .sort((left, right) => (left.attachmentId < right.attachmentId ? -1 : 1));
}
