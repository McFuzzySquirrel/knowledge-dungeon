/**
 * Phase 7 verifier device helper.
 *
 * Independent of `tests/data/support/*`: a fresh IndexedDB per gate file, a real
 * `StorageV2Repository`, and a legacy-`localStorage` reader. Nothing here is imported
 * by `vitest.setup.ts`, so the shim stays inside `tests/phase7`.
 */

import 'fake-indexeddb/auto';

import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import { writeSubjectToActiveGeneration } from '@/services/persistence/v2/appRepository';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';

export const LEGACY_INDEX_KEY = 'knowledge-dungeon:v1:subjects';
export const LEGACY_SUBJECT_PREFIX = 'knowledge-dungeon:v1:subject:';
export const NOW = '2026-09-27T09:00:00.000Z';

let sequence = 0;

/** A database name no other gate uses, so two gates cannot collide. */
export function uniqueDatabaseName(label: string): string {
  sequence += 1;
  return `kd-p7-${label}-${String(sequence).padStart(3, '0')}`;
}

export async function openDevice(databaseName: string): Promise<StorageV2Repository> {
  return openStorageV2Repository({
    databaseName,
    clock: fixedClock(NOW),
    idFactory: createDeterministicIdFactory('p7'),
  });
}

/** Clear every legacy key this application's facade owns. */
export function resetLegacyStorage(): void {
  const doomed: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === null) continue;
    if (key.startsWith('knowledge-dungeon') || key.startsWith('kd-')) doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
}

/** The whole legacy key/value set, sorted, for a before/after comparison. */
export function legacyFingerprint(): string {
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === null) continue;
    entries.push([key, localStorage.getItem(key) as string]);
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * A stable fingerprint of everything a storage-v2 generation holds.
 *
 * Record **ids** are included on purpose: a subject that vanished and was re-created
 * under a different id is a different device state, and a fingerprint that only counted
 * records would call those two states equal.
 */
export function fingerprintGeneration(
  repository: StorageV2Repository,
  generationId: string,
): Promise<string> {
  return repository.readRecords(generationId).then((snapshot) => {
    const stores: Record<string, string[]> = {};
    const records = snapshot.records as unknown as Record<string, Array<{ recordId: string; value: unknown }>>;
    for (const [store, envelopes] of Object.entries(records)) {
      stores[store] = envelopes
        .map((envelope) => `${envelope.recordId}=${JSON.stringify(envelope.value)}`)
        .sort();
    }
    return JSON.stringify({
      generationId,
      stores: Object.fromEntries(Object.entries(stores).sort(([left], [right]) => (left < right ? -1 : 1))),
    });
  });
}

/**
 * Every generation the device holds, keyed by id, with its status.
 *
 * The registry lives in the `meta` store under `generation:<id>`, so this reads it
 * directly rather than guessing ids. Sorted, so a comparison is a comparison.
 */
export async function listGenerations(
  repository: StorageV2Repository,
): Promise<Array<{ id: string; status: string | null; source: string | null }>> {
  const descriptors = await repository.listGenerations();
  return descriptors
    .map((descriptor) => ({
      id: descriptor.generationId,
      status: descriptor.status ?? null,
      source: descriptor.source ?? null,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Seed one subject into the active generation, the way the application would. */
export async function seedSubject(
  repository: StorageV2Repository,
  subjectId: string,
  snapshot: SubjectSnapshot,
): Promise<void> {
  await writeSubjectToActiveGeneration(repository, subjectId, snapshot, NOW);
}

/** A counting id generator of the shape the product's `SubjectIdGenerator` wants. */
export function countingGenerator(prefix: string): { next: () => string } {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-${String(counter).padStart(4, '0')}`;
    },
  };
}
