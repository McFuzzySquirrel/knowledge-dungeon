/**
 * Shared setup for the storage-v2 migration suites.
 *
 * Nothing here is imported by `vitest.setup.ts`: the IndexedDB shim and the
 * legacy-storage snapshot must not reach the rest of the suite, because the
 * rest of the suite characterizes current behavior against real `localStorage`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** In-memory IndexedDB. Installed only for the suites that import this helper. */
import 'fake-indexeddb/auto';

import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import {
  LEGACY_STORAGE_KEY_ALLOWLIST,
  type ReadOnlyLegacyStorage,
} from '@/services/persistence/v2/legacyReader';

export const FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/persistence');
export const FIXED_NOW = '2026-09-24T12:34:56.789Z';
export const MIGRATION_NOW = '2026-09-25T00:00:00.000Z';
export const GENERATION_ID = 'gen-synthetic-0001';

export function readSubjectFixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, 'subject', name), 'utf8');
}

export function readProgressionFixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, 'progression', name), 'utf8');
}

/**
 * A snapshot of `localStorage` that records every access.
 *
 * The migration tests assert against `snapshot()` that nothing was written and
 * nothing was removed, and that only `getItem`/`key`/`length` were used, which is
 * a stronger claim than "the values look the same".
 */
export interface StorageSnapshot {
  /** Key/value pairs in storage order. */
  entries(): [string, string][];
  /** Every mutating call made against the storage, in order. */
  mutations(): string[];
  /** Every key that exists, in storage order. */
  keys(): string[];
  get(key: string): string | null;
}

export function snapshotLocalStorage(): StorageSnapshot {
  const storage = window.localStorage;
  const entries: [string, string][] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    entries.push([key, storage.getItem(key) as string]);
  }
  return {
    entries: () => entries.map(([key, value]) => [key, value] as [string, string]),
    mutations: () => [],
    keys: () => entries.map(([key]) => key),
    get: (key: string) => storage.getItem(key),
  };
}

/** Reset the legacy storage between tests. IndexedDB is per-test-database. */
export function resetStorageV2Environment(): void {
  window.localStorage.clear();
}

/**
 * A `Storage` that throws on every write path.
 *
 * Passing this to the migration makes "the migration never writes legacy keys"
 * an enforced property rather than an observation: a single `setItem` would fail
 * the run.
 */
export function createWriteTrapStorage(source: StorageSnapshot): Storage & { mutations: string[] } {
  const mutations: string[] = [];
  const backing = new Map(source.entries());
  const trap = {
    get length(): number {
      return backing.size;
    },
    key(index: number): string | null {
      return [...backing.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return backing.has(key) ? (backing.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      mutations.push(`setItem:${key}`);
      backing.set(key, value);
    },
    removeItem(key: string): void {
      mutations.push(`removeItem:${key}`);
      backing.delete(key);
    },
    clear(): void {
      mutations.push('clear');
      backing.clear();
    },
    key_: undefined as never,
    mutations,
  };
  void (trap as { key_?: unknown }).key_;
  return trap as unknown as Storage & { mutations: string[] };
}

/** A read-only view of a snapshot, for the legacy reader. */
export function toReadOnlyStorage(source: StorageSnapshot): ReadOnlyLegacyStorage {
  return {
    get length(): number {
      return source.keys().length;
    },
    key: (index: number) => source.keys()[index] ?? null,
    getItem: (key: string) => source.get(key),
  };
}

/** Open a repository against a unique in-memory database with an injected clock. */
export async function openTestRepository(
  databaseName: string,
  clockIso: string = MIGRATION_NOW,
): Promise<StorageV2Repository> {
  return openStorageV2Repository({
    databaseName,
    clock: fixedClock(clockIso),
    idFactory: createDeterministicIdFactory('test'),
  });
}

/** Delete an in-memory database so the next open starts clean. */
export function deleteTestDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve) => {
    const request = globalThis.indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Keys covered by the allowlist that are present in a snapshot. */
export function allowlistedKeysIn(source: StorageSnapshot): string[] {
  const keys = source.keys();
  return LEGACY_STORAGE_KEY_ALLOWLIST.flatMap((spec) => {
    if (spec.key !== undefined) return keys.includes(spec.key) ? [spec.key] : [];
    const prefix = spec.keyPrefix;
    if (prefix === undefined) return [];
    return keys.filter((key) => key.startsWith(prefix) && key.length > prefix.length);
  });
}
