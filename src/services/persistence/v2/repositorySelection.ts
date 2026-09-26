/**
 * Which persistence repository the application is currently talking to.
 *
 * Plan section 11: `VITE_STORAGE_REPOSITORY` is `legacy` in production and `v2`
 * only in the explicitly flagged build. This module is the single place that
 * decision is *made*, so no other module has to read `import.meta.env` or import
 * the repository to find out.
 *
 * The default is `legacy`, and it is the default **before any bootstrap runs**.
 * That matters: a module that asks "which repository?" during import must get the
 * safe answer, never an unopened handle.
 *
 * Selecting the storage-v2 repository is the act of *publishing a live handle*.
 * A handle only exists after {@link openStorageV2Repository} has succeeded, so
 * every consumer that sees `'v2'` also has a repository to talk to. Nothing here
 * opens a database, writes a record, or reads a flag on its own.
 *
 * Renderer-neutral: this module imports no renderer and performs no storage
 * access of its own.
 */

import type { StorageRepository } from '@/config/runtimeConfig';
import type { StorageV2Repository } from './repository';

let selection: StorageRepository = 'legacy';
let repository: StorageV2Repository | null = null;

/**
 * Route the application through the legacy `localStorage` mirror.
 *
 * This is the production default and the documented rollback (plan section 11):
 * set `VITE_STORAGE_REPOSITORY=legacy`, rebuild, and every read and write goes
 * back to the keys the previous release wrote.
 */
export function selectLegacyRepository(): void {
  selection = 'legacy';
  repository = null;
}

/**
 * Route the application through an already-open storage-v2 repository.
 *
 * @param handle A live handle from `openStorageV2Repository`.
 */
export function selectStorageV2Repository(handle: StorageV2Repository): void {
  selection = 'v2';
  repository = handle;
}

/** The repository the application is routed through. */
export function currentRepositorySelection(): StorageRepository {
  return selection;
}

/** The live storage-v2 handle, or `null` unless {@link selectStorageV2Repository} ran. */
export function currentStorageV2Repository(): StorageV2Repository | null {
  return repository;
}

/** True when reads and writes must go to storage-v2. */
export function isStorageV2Selected(): boolean {
  return selection === 'v2' && repository !== null;
}

/**
 * Reset to the pre-bootstrap default.
 *
 * Only a test needs this: it is how a suite proves the default really is
 * `legacy` with no handle, and it keeps module-level state from leaking between
 * suites.
 */
export function resetRepositorySelection(): void {
  selection = 'legacy';
  repository = null;
}
