/**
 * Raw IndexedDB reads for the Phase 6 verifier harness.
 *
 * The repository API exposes no "list every generation" call and no way to see
 * orphan records under a generation id that no descriptor describes - both of
 * which a blast-radius claim needs. So this reads the object stores directly,
 * which is also the only way to see a *staged* generation that an import left
 * behind after failing.
 *
 * This is the verifier's own file. It shares nothing with `tests/data/support/`.
 */

const META_DESCRIPTOR_PREFIX = 'generation-descriptor:';

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolvePromise, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    request.onsuccess = () => resolvePromise(request.result);
    request.onerror = () => reject(request.error ?? new Error('request failed'));
  });
}

/** Every key currently in every object store of the database. */
export async function listEveryStoreKey(databaseName: string): Promise<Record<string, readonly string[]>> {
  const db = await openDatabase(databaseName);
  try {
    const storeNames = [...db.objectStoreNames];
    const out: Record<string, string[]> = {};
    for (const storeName of storeNames) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keys = await requestToPromise(store.getAllKeys());
      out[storeName] = keys.map((key) =>
        Array.isArray(key) ? key.map((part) => String(part)).join(' ') : String(key),
      );
    }
    return out;
  } finally {
    db.close();
  }
}

/** Every generation id that has a descriptor row, in sorted order. */
export async function listMetaRecordIds(databaseName: string): Promise<string[]> {
  const db = await openDatabase(databaseName);
  try {
    const tx = db.transaction('meta', 'readonly');
    const store = tx.objectStore('meta');
    const keys = await requestToPromise(store.getAllKeys());
    const ids: string[] = [];
    for (const key of keys) {
      const recordId = Array.isArray(key) ? String(key[1]) : String(key);
      if (recordId.startsWith(META_DESCRIPTOR_PREFIX)) {
        ids.push(recordId.slice(META_DESCRIPTOR_PREFIX.length));
      }
    }
    return ids.sort();
  } finally {
    db.close();
  }
}

/**
 * Every generation id that has *any* record under it, descriptor or not.
 *
 * An abandoned staged generation has no descriptor, so this is the only way to
 * see that an import left records behind.
 */
export async function listAllRecordGenerations(databaseName: string): Promise<string[]> {
  const db = await openDatabase(databaseName);
  try {
    const storeNames = [...db.objectStoreNames].filter((name) => name !== 'meta');
    const ids = new Set<string>();
    for (const storeName of storeNames) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keys = await requestToPromise(store.getAllKeys());
      for (const key of keys) {
        if (Array.isArray(key)) ids.add(String(key[0]));
      }
    }
    return [...ids].sort();
  } finally {
    db.close();
  }
}
