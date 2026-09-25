/**
 * Storage-v2 IndexedDB open, upgrade, and pointer plumbing.
 *
 * Scope boundary: this module knows how to create the object stores, how to read
 * and write the `meta` pointer, and how to inject the clock and identifier
 * factory. It contains **no** migration logic and **no** repository logic, so
 * the failure surface stays small.
 *
 * It is renderer-neutral and performs no network or file-system access.
 */

import {
  ACTIVE_GENERATION_META_KEY,
  ACTIVE_GENERATION_META_OWNER,
  GENERATION_META_KEY_PREFIX,
  GENERATION_SCOPED_STORE_NAMES,
  STORAGE_V2_DATABASE_NAME,
  STORAGE_V2_SCHEMA_VERSION,
  STORAGE_V2_STORE_NAMES,
  StorageV2Error,
  toStorageV2Error,
  type ActiveGenerationPointer,
  type GenerationDescriptor,
  type MetaRecordEnvelope,
  type StorageV2StoreName,
} from './schema';
import { checksumValue } from './checksum';

const GENERATION_SCOPE_INDEX = 'byGeneration';

export interface StorageV2Clock {
  /** Injected ISO-8601 clock. The migration never reads the real clock. */
  now(): string;
}

/** A clock that returns a fixed value; the default for deterministic tests. */
export function fixedClock(iso: string): StorageV2Clock {
  return { now: () => iso };
}

export interface StorageV2IdFactory {
  /** Deterministic identifier generator, seeded by the caller. */
  next(): string;
}

/**
 * A seeded, counter-based identifier factory.
 *
 * Same seed, same sequence, same identifiers: that is what makes a migration
 * run reproducible in tests and in receipts. No `Math.random()`, no clock.
 */
export function createDeterministicIdFactory(seed: string): StorageV2IdFactory {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return `${seed}-${counter.toString(36).padStart(4, '0')}`;
    },
  };
}

export interface OpenStorageV2Options {
  /** Override the database name. Used by tests to stay isolated. */
  databaseName?: string;
  /** IndexedDB factory. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** Injected clock, stored on the handle for repository writes. */
  clock?: StorageV2Clock;
  /** Injected id factory, stored on the handle for repository writes. */
  idFactory?: StorageV2IdFactory;
}

/** A database plus its injected dependencies. */
export interface StorageV2DatabaseHandle {
  db: IDBDatabase;
  databaseName: string;
  schemaVersion: number;
  clock: StorageV2Clock;
  idFactory: StorageV2IdFactory;
  close(): void;
}

function resolveIndexedDB(factory?: IDBFactory): IDBFactory {
  if (factory) return factory;
  const global = globalThis as { indexedDB?: IDBFactory };
  if (!global.indexedDB) {
    throw new StorageV2Error(
      'INDEXEDDB_UNAVAILABLE',
      { api: 'indexedDB' },
      'storage-v2 requires IndexedDB, which this environment does not provide.',
    );
  }
  return global.indexedDB;
}

/**
 * Create one object store and its indexes.
 *
 * Keyed by `[generationId, recordId]` so every record is generation-scoped and a
 * generation can be read or removed in one index range without touching its
 * neighbours.
 */
export function createStorageV2Store(db: IDBDatabase, storeName: StorageV2StoreName): void {
  const store = db.createObjectStore(storeName, { keyPath: ['generationId', 'recordId'] });

  if (storeName === 'meta') {
    // The active-generation pointer and the generation registry are keyed by
    // logical name. They are indexed separately because they are not
    // generation-scoped in the same way a data record is.
    store.createIndex('byKey', 'recordId', { unique: true });
    return;
  }

  if ((GENERATION_SCOPED_STORE_NAMES as readonly string[]).includes(storeName) || storeName === 'migrationReceipts') {
    store.createIndex(GENERATION_SCOPE_INDEX, 'generationId', { unique: false });
  }
  if (storeName === 'migrationReceipts') {
    store.createIndex('byMigration', 'value.migrationId', { unique: false });
  }
}

/** Create every store that does not exist yet. Existing stores are untouched. */
export function createStorageV2Schema(db: IDBDatabase): void {
  for (const storeName of STORAGE_V2_STORE_NAMES) {
    if (db.objectStoreNames.contains(storeName)) continue;
    createStorageV2Store(db, storeName);
  }
}

/** Build the `meta` envelope for a value. */
export function metaEnvelope<TValue>(
  generationId: string,
  recordId: string,
  value: TValue,
  updatedAt: string,
): MetaRecordEnvelope<TValue> {
  return { generationId, recordId, value, checksum: checksumValue(value), updatedAt };
}

/** The `meta` key of a generation's registry entry. */
export function generationMetaKey(generationId: string): string {
  return `${GENERATION_META_KEY_PREFIX}${generationId}`;
}

/**
 * Open (creating or upgrading as needed) the storage-v2 database.
 *
 * A database written by a newer structural version is refused rather than
 * deleted: rolling storage forward is a Phase 4 decision, not an implicit
 * side effect of opening it.
 */
export function openStorageV2Database(
  options: OpenStorageV2Options = {},
): Promise<StorageV2DatabaseHandle> {
  const factory = resolveIndexedDB(options.indexedDB);
  const databaseName = options.databaseName ?? STORAGE_V2_DATABASE_NAME;

  return new Promise<StorageV2DatabaseHandle>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, STORAGE_V2_SCHEMA_VERSION);
    } catch (error) {
      reject(toStorageV2Error(error, 'DATABASE_OPEN_FAILED'));
      return;
    }

    request.onupgradeneeded = () => {
      // `onupgradeneeded` fires before the connection opens, and only for
      // structural differences, so adding a store never recreates an existing
      // one and never drops its records.
      createStorageV2Schema(request.result);
    };

    request.onblocked = () => {
      reject(
        new StorageV2Error(
          'DATABASE_OPEN_FAILED',
          { databaseName },
          'storage-v2 database upgrade is blocked by another open connection.',
        ),
      );
    };

    request.onerror = () => {
      reject(toStorageV2Error(request.error, 'DATABASE_OPEN_FAILED', { databaseName }));
    };

    request.onsuccess = () => {
      const db = request.result;
      if (db.version > STORAGE_V2_SCHEMA_VERSION) {
        db.close();
        reject(
          new StorageV2Error(
            'DATABASE_VERSION_TOO_LOW',
            { found: db.version, supported: STORAGE_V2_SCHEMA_VERSION },
            'storage-v2 database was written by a newer structural version.',
          ),
        );
        return;
      }
      resolve({
        db,
        databaseName,
        schemaVersion: STORAGE_V2_SCHEMA_VERSION,
        clock: options.clock ?? fixedClock('1970-01-01T00:00:00.000Z'),
        idFactory: options.idFactory ?? createDeterministicIdFactory('gen'),
        close: () => db.close(),
      });
    };
  });
}

// ── Transaction helpers ───────────────────────────────────────────────────

/** Promise for a single request. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toStorageV2Error(request.error, 'TRANSACTION_FAILED'));
  });
}

/**
 * Promise for a transaction's completion.
 *
 * Rejects with a typed error for both an explicit `abort()` and a failed
 * request, so a caller can never mistake a half-written transaction for a
 * finished one.
 */
export function transactionToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        toStorageV2Error(tx.error, 'TRANSACTION_ABORTED', {
          storeCount: tx.objectStoreNames.length,
        }),
      );
    tx.onerror = () => reject(toStorageV2Error(tx.error, 'TRANSACTION_FAILED'));
  });
}

/** Every store name, in a stable order, for a full-database transaction. */
export function allStoreNames(): StorageV2StoreName[] {
  return [...STORAGE_V2_STORE_NAMES];
}

// ── Pointer access ────────────────────────────────────────────────────────

/**
 * Write the active-generation pointer inside an existing transaction.
 *
 * The pointer row is tagged with {@link ACTIVE_GENERATION_META_OWNER}: it belongs
 * to no generation, and a stable primary key is what makes re-pointing a plain
 * update instead of a delete plus an insert.
 */
export function writeActiveGenerationPointerTo(
  tx: IDBTransaction,
  pointer: ActiveGenerationPointer,
  updatedAt: string,
): void {
  tx.objectStore('meta').put(
    metaEnvelope(ACTIVE_GENERATION_META_OWNER, ACTIVE_GENERATION_META_KEY, pointer, updatedAt),
  );
}

/** Write one generation's registry entry inside an existing transaction. */
export function writeGenerationDescriptorTo(
  tx: IDBTransaction,
  descriptor: GenerationDescriptor,
  updatedAt: string,
): void {
  tx.objectStore('meta').put(
    metaEnvelope(
      descriptor.generationId,
      generationMetaKey(descriptor.generationId),
      descriptor,
      updatedAt,
    ),
  );
}
