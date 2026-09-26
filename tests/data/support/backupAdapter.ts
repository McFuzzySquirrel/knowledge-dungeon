/**
 * The adapter between these gates and the not-yet-written Phase 5 product.
 *
 * Everything a registered reproduction could "invent" about the product's call
 * shape lives in this one file, so an implementer has a single place to read and
 * a single place to change:
 *
 * - {@link exportRequest} is the **exact** argument object the export entry point
 *   receives. Its keys are the contract.
 * - {@link importRequest} is the exact argument object the import entry point
 *   receives.
 * - {@link produceArchive} and {@link consumeArchive} resolve the entry point,
 *   call it, and reduce whatever comes back to the two shapes the gates need:
 *   archive bytes, and an import outcome.
 *
 * The result is *not* normalised into a guessed result type. The gates read the
 * manifest out of the returned bytes with the audited production codec, because
 * "the manifest is a member of the archive" is itself part of what has to be
 * proven; and the import outcome is compared as an opaque value except for the
 * external-only disclosure it must contain.
 *
 * When the product does not exist, both helpers raise
 * {@link RegisteredReproduction}, which names the interface, the module, and
 * every accepted export name. That is what makes a registered test's failure
 * readable as "waiting for this" rather than "something broke".
 *
 * Privacy: this module passes repository handles and archive bytes. It never
 * logs, reports, or writes either, and it never inspects a record's contents.
 */

import { readArchiveJson } from '@/services/persistence/v2/archive';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  ARCHIVE_VALIDATION_MODULE,
  FULL_DEVICE_BACKUP_MODULE,
  RegisteredReproduction,
  resolveProductExport,
} from './productInterface';

export interface BackupContext {
  readonly repository: StorageV2Repository;
  /** The generation a full-device export reads. */
  readonly generationId: string;
  /** Injected clock, so an export is deterministic under test. */
  readonly now: string;
  /** Real payload bytes per attachment id, for the attachment-bytes gate. */
  readonly payloadBytes: ReadonlyMap<string, Uint8Array>;
}

/** The keys the export entry point is called with. */
export const EXPORT_REQUEST_KEYS = [
  'repository',
  'generationId',
  'now',
  'payloadBytes',
  'activeSubjectId',
] as const;

/** The keys the import entry point is called with. */
export const IMPORT_REQUEST_KEYS = [
  'repository',
  'bytes',
  'now',
  'keepPreviousGeneration',
] as const;

/** The exact argument object the export entry point receives. */
export function exportRequest(context: BackupContext): Record<string, unknown> {
  return {
    repository: context.repository,
    generationId: context.generationId,
    now: context.now,
    payloadBytes: context.payloadBytes,
    // Present so a product that resolves the active subject itself is not
    // forced to read it; `null` is the honest value for a headless export.
    activeSubjectId: null,
  };
}

/** The exact argument object the import entry point receives. */
export function importRequest(
  context: BackupContext,
  bytes: Uint8Array,
): Record<string, unknown> {
  return {
    repository: context.repository,
    bytes,
    now: context.now,
    // Plan section 7.1 step 6 and the Phase 5 scope: the previous generation is
    // retained. The request states it rather than leaving it to a default.
    keepPreviousGeneration: true,
  };
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'object' && value !== null) {
    for (const key of ['bytes', 'archive', 'file', 'blob']) {
      const candidate = (value as Record<string, unknown>)[key];
      if (candidate instanceof Uint8Array) return candidate;
    }
  }
  return null;
}

/**
 * Produce a `.kdbak` through the product's export entry point.
 *
 * Raises {@link RegisteredReproduction} until the product implements it.
 */
export async function produceArchive(context: BackupContext): Promise<Uint8Array> {
  const exportEntry = await resolveProductExport(FULL_DEVICE_BACKUP_MODULE, 'exportArchive');
  const bytes = bytesOf(await exportEntry(exportRequest(context)));
  if (bytes === null) {
    throw new RegisteredReproduction({
      interfaceName: 'an export that returns the archive bytes',
      modulePath: FULL_DEVICE_BACKUP_MODULE,
      acceptedExportNames: ['Uint8Array', '{ bytes: Uint8Array }', '{ archive: Uint8Array }'],
    });
  }
  return bytes;
}

/**
 * Import a `.kdbak` through the product's import entry point.
 *
 * Raises {@link RegisteredReproduction} until the product implements it.
 */
export async function consumeArchive(
  context: BackupContext,
  bytes: Uint8Array,
): Promise<unknown> {
  const importEntry = await resolveProductExport(FULL_DEVICE_BACKUP_MODULE, 'importArchive');
  return importEntry(importRequest(context, bytes));
}

/**
 * Inspect a `.kdbak` without touching stored data.
 *
 * Raises {@link RegisteredReproduction} until the product implements it. The
 * gates read the manifest themselves with the audited codec; this exists for the
 * gate that wants the product's own *declaration* of what the archive contains,
 * which is the claim the plan asks to be disclosed.
 */
export async function inspectArchive(bytes: Uint8Array): Promise<unknown> {
  const readEntry = await resolveProductExport(ARCHIVE_VALIDATION_MODULE, 'readArchive');
  return readEntry(bytes);
}

/**
 * The manifest as a decoded member, read with the audited production codec.
 *
 * Not the product's reader: reading the member here is what proves the member is
 * *there*, independently of whether the product can find it.
 */
export function manifestMember(bytes: Uint8Array): Record<string, unknown> {
  const manifest = readArchiveJson(bytes, 'manifest.json');
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new TypeError('The manifest member is not a JSON object.');
  }
  return manifest as Record<string, unknown>;
}
