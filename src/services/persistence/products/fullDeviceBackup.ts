/**
 * The full-device `.kdbak` backup product: export, and import.
 *
 * Plan section 7.3 fixes the archive layout; this module implements it and
 * nothing else. The two things it does not do are the two things that are not
 * this module's to do:
 *
 * - **It does not download anything.** {@link exportFullDeviceBackup} returns
 *   bytes. Turning them into a file is a user-interface concern - an object URL,
 *   an anchor, a revoke - and the Phase 5 non-goals are explicit that there is no
 *   cloud upload and no Web Share for a backup. There is no `navigator.share`, no
 *   `fetch`, no `XMLHttpRequest`, no `sendBeacon`, and no `URL.createObjectURL`
 *   anywhere in this file, and `tests/data/localDownloadOnly.test.ts` walks the
 *   real application graph to keep it that way.
 * - **It does not interpret a file the learner has not chosen.** Every byte this
 *   module reads goes through `archiveValidation.readFullDeviceArchiveContents`
 *   first, and that function touches no stored data. So the preview a learner
 *   sees and the restore a learner commits to are the same parse of the same
 *   bytes, run with the same rules, before anything is written.
 *
 * ## The generation transaction
 *
 * The import stages a **new** generation and activates it only after the staged
 * generation validates. It follows plan section 7.1's order - read and validate
 * without modifying, write a complete new generation, compare counts,
 * relationships, and checksums, then flip the pointer - and it retains the
 * generation it replaced. On **any** failure the pointer is untouched, a
 * generation that was only `staged` is discarded, and no receipt claims success.
 *
 * ## Attachment bytes
 *
 * The bytes come from the **device-local attachment store**, not from the
 * generation's `attachments` store, because that is where Phase 4 put them: the
 * generation holds a best-effort mirror, and the device-local database is the one
 * that survives a repository rollback. The resolution order is therefore:
 *
 * 1. the `payloadBytes` map the caller supplies, which the caller obtains from
 *    `attachmentBytes.ts` (see {@link resolveDeviceLocalPayloadBytes});
 * 2. the generation's own mirrored blob record, for an attachment whose
 *    device-local copy is unavailable at export time;
 * 3. nothing - and then the attachment is **disclosed** as external-only with a
 *    null hash, and the export still succeeds.
 *
 * A member is named by the SHA-256 of the bytes it actually carries, so two
 * identical payloads collapse to one member and a member cannot be a label the
 * writer chose.
 *
 * ## Determinism
 *
 * An export under a fixed clock is byte-deterministic: same generation, same
 * `now`, same `payloadBytes`, same bytes. That is a property of the **container**
 * as well as of the members, and it needs one thing the ZIP layer does not do by
 * itself - every member is written with an `mtime` derived from `now` rather than
 * from the wall clock. fflate's default stamps each entry from `Date.now()`, and
 * its DOS timestamp has two-second resolution, so two exports seconds apart
 * differed in a handful of header bytes while every member was identical. Passing
 * the clock through makes the claim true instead of nearly true.
 *
 * ## Privacy
 *
 * The manifest carries counts, versions, and checksums and nothing else: no
 * subject name, no room topic, no note, no attachment filename, no external URL,
 * and no absolute path. Member names are a fixed name, a content hash, or an
 * opaque index. The import result carries opaque ids and codes. Nothing in this
 * file logs, and no `StorageV2Error` detail is ever a value a learner authored -
 * the constructor refuses one.
 *
 * ## Reaching storage-v2 from a screen
 *
 * {@link resolveLiveDeviceRepository} and {@link readLiveActiveGenerationId} are
 * the only route from a screen to a storage-v2 handle. They are here, and not in
 * a screen, because this module's own request type *is* a repository handle: a
 * screen cannot call {@link exportFullDeviceBackup} without one, so a screen that
 * cannot be handed a handle has no way to use the product at all. Publishing the
 * accessor here makes the product the sanctioned boundary in both directions, so
 * the only import a screen needs is this module - lazily - and the seam allowlist
 * in `tests/migrations/qaHardening.test.ts` needs no entry for any UI file.
 *
 * Renderer-neutral: this module imports no renderer, no UI, and no network API.
 */

import {
  writeArchive as writeArchiveBytes,
  type ArchiveFile,
} from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, sha256Hex } from '@/services/persistence/v2/checksum';
import { readAttachmentBytes } from '@/services/persistence/v2/attachmentBytes';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  STORAGE_V2_STORE_NAMES,
  StorageV2Error,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type ExternalOnlyAttachmentReport,
  type MigrationReceiptValue,
  type StorageV2StoreName,
} from '@/services/persistence/v2/schema';
import {
  countBlockingProblems,
  type GenerationRecordValues,
  type ValidationProblem,
} from '@/services/persistence/v2/validation';
import type { GenerationSnapshot, StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  fullDeviceExternalOnlyReason,
  FULL_DEVICE_FORMAT_VERSION,
  FULL_DEVICE_MANIFEST_MEMBER,
  FULL_DEVICE_PRODUCT,
  FULL_DEVICE_STATE_MEMBER,
  FULL_DEVICE_STATE_SECTIONS,
  fullDeviceIndexMemberName,
  fullDeviceManifestContentChecksum,
  isPrototypeMemberName,
  readFullDeviceArchiveContents,
  type FullDeviceArchivePreview,
  type FullDeviceManifest,
  type FullDeviceManifestMember,
  type FullDeviceStateSection,
} from './archiveValidation';

export { readFullDeviceArchive, inspectFullDeviceArchive } from './archiveValidation';
export type {
  FullDeviceArchiveContents,
  FullDeviceArchivePreview,
  FullDeviceArchiveInspection,
} from './archiveValidation';

/**
 * Write a `.kdbak`'s members.
 *
 * A re-export of the audited codec's writer, and the one place a caller that
 * needs to assemble members by hand should go. It is here rather than only in the
 * codec because the plan's product contract includes "a `.kdbak` written by
 * another tool must be readable here and this build's archive must be writable by
 * another tool", and the writer half of that is a product concern. The codec's
 * duplicate check asks `Object.hasOwn`, so a member named after an
 * `Object.prototype` key is written rather than mistaken for a duplicate.
 */
export const writeArchive = writeArchiveBytes;

/**
 * The file name a download should be offered under.
 *
 * Fixed and content-free: plan section 12, rule 6 forbids putting learner data in
 * a filename, and a timestamp would make an otherwise deterministic export look
 * like it varied. The product returns it; the user interface applies it.
 */
export const FULL_DEVICE_BACKUP_FILE_NAME = 'knowledge-dungeon-device-backup.kdbak';

// ── Export ────────────────────────────────────────────────────────────────

export interface FullDeviceExportRequest {
  /**
   * The generation to read. Nothing is written, so this is a pure read.
   *
   * It must name an `active` or `superseded` generation. A `staged` generation is
   * invisible to every reader, and an archive taken from one cannot be restored:
   * the migration receipts it carries name the generation they were written for,
   * and storage-v2's own relationship rule refuses a generation whose receipts
   * point elsewhere. The product does not add a guard for this - refusing a
   * generation that was never readable is the caller's mistake to catch, and the
   * importer already refuses the resulting archive with a typed code - so the
   * contract is stated here instead. Recorded as a Phase 5 follow-up.
   */
  readonly repository: StorageV2Repository;
  readonly generationId: string;
  /** Injected clock. An export under a fixed clock is byte-deterministic. */
  readonly now: string;
  /**
   * Real payload bytes per attachment id, resolved by the caller from the
   * device-local attachment store. Optional: an export without it still works,
   * falling back to the generation's mirrored blob records and disclosing
   * whatever is still missing.
   */
  readonly payloadBytes?: ReadonlyMap<string, Uint8Array>;
  /**
   * The subject the learner had open, recorded so a restore can disclose it.
   *
   * Carried, not applied: the active-subject pointer is synchronously readable
   * legacy-mirror state that Phase 4 deliberately kept out of the storage-v2
   * repositories, and writing it from here would put a product module in charge
   * of a mirror it does not own. See the Phase 5 follow-up note.
   */
  readonly activeSubjectId?: string | null;
}

export interface FullDeviceExportResult {
  /** The `.kdbak`. The caller decides what to do with it. */
  readonly bytes: Uint8Array;
  /** The manifest exactly as it was written into the archive. */
  readonly manifest: FullDeviceManifest;
  /** Member paths in write order, including `manifest.json`. */
  readonly memberNames: readonly string[];
  /** A content-free file name for the download. */
  readonly fileName: string;
  /** Attachments whose bytes were not available, with no fabricated hash. */
  readonly externalOnlyAttachments: readonly ExternalOnlyAttachmentReport[];
}

const encoder = new TextEncoder();

/** The ZIP epoch, and the range the DOS timestamp can represent. */
const ZIP_EPOCH_YEAR = 1980;
const ZIP_MAX_YEAR = 2107;

/**
 * The member modification time an export stamps, derived from the injected clock.
 *
 * `now` is an ISO-8601 string, so the result is a function of the caller's clock
 * and not of the wall clock. A value outside the range a DOS timestamp can
 * represent - before 1980, after 2107 - would make fflate raise, so it is clamped
 * to the representable range rather than being allowed to fail the export. The
 * clamp is disclosed here because it is the one case where two different `now`
 * values could produce the same `mtime`; both are then equally deterministic.
 */
function exportMemberTime(now: string): Date {
  const parsed = new Date(now);
  const valid = Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
  if (valid.getUTCFullYear() < ZIP_EPOCH_YEAR) {
    return new Date(Date.UTC(ZIP_EPOCH_YEAR, 0, 1, 0, 0, 0));
  }
  if (valid.getUTCFullYear() > ZIP_MAX_YEAR) {
    return new Date(Date.UTC(ZIP_MAX_YEAR, 0, 1, 0, 0, 0));
  }
  return valid;
}

function sortedValues<T>(envelopes: readonly { recordId: string; value: T }[]): T[] {
  // Sorted by the record id the repository derives, so the document's order is a
  // function of the data rather than of an IndexedDB cursor. A fixed clock and a
  // fixed generation therefore produce fixed bytes.
  return [...envelopes]
    .sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0))
    .map((envelope) => envelope.value);
}

function preferenceValue(preferences: readonly { value: unknown }[], preferenceId: string): unknown {
  const record = preferences.find((entry) => (entry as { preferenceId?: string }).preferenceId === preferenceId);
  return record?.value ?? null;
}

function emptyCounts(): Record<StorageV2StoreName, number> {
  return Object.fromEntries(STORAGE_V2_STORE_NAMES.map((name) => [name, 0])) as Record<
    StorageV2StoreName,
    number
  >;
}

/** The disclosure an attachment with no bytes in the archive gets. */
function disclosureFor(
  record: AttachmentMetadataRecordValue,
  reason: string,
): ExternalOnlyAttachmentReport {
  return {
    attachmentId: record.attachmentId,
    subjectId: record.subjectId,
    roomId: record.roomId,
    contentHash: null,
    byteLength: null,
    reason: reason as ExternalOnlyAttachmentReport['reason'],
    sourceType: record.sourceType,
  };
}

/**
 * Read the device-local attachment store for the ids a generation references.
 *
 * Exported so the caller does not have to know that the bytes live in a second
 * IndexedDB database: the product's own caller passes the result straight back as
 * `payloadBytes`. Returns only the ids whose bytes are actually on the device, so
 * an absent or external-only attachment is simply not in the map and the export
 * discloses it.
 */
export async function resolveDeviceLocalPayloadBytes(
  attachmentIds: readonly string[],
): Promise<ReadonlyMap<string, Uint8Array>> {
  const resolved = new Map<string, Uint8Array>();
  for (const attachmentId of [...attachmentIds].sort()) {
    const stored = await readAttachmentBytes(attachmentId);
    if (stored === null) continue;
    resolved.set(attachmentId, stored.bytes);
  }
  return resolved;
}

/**
 * Produce a `.kdbak` from one complete generation.
 *
 * Reads and never writes: the repository is used for a single read pass, and the
 * result is a pure function of (generation contents, `now`, `payloadBytes`).
 */
export async function exportFullDeviceBackup(
  request: FullDeviceExportRequest,
): Promise<FullDeviceExportResult> {
  const { repository, generationId, now } = request;
  const snapshot: GenerationSnapshot = await repository.readRecords(generationId);
  const records = snapshot.records;

  const subjects = sortedValues(records.subjects);
  const progression = sortedValues(records.progression);
  const sessions = sortedValues(records.sessions);
  const preferences = sortedValues(records.preferences);
  const shortcuts = sortedValues(records.shortcuts);
  const assistance = sortedValues(records.assistance);
  const attachmentMetadata = sortedValues(records.attachmentMetadata);
  const customSprites = sortedValues(records.customSprites);
  const recovery = sortedValues(records.recovery);
  const migrationReceipts = sortedValues(records.migrationReceipts);

  // ── Attachment bytes ──
  const payloadBytes = request.payloadBytes ?? new Map<string, Uint8Array>();
  const blobByAttachment = new Map(
    records.attachmentBlobs.map((envelope) => [envelope.value.attachmentId, envelope.value]),
  );
  const attachmentMembers = new Map<string, Uint8Array>();
  const externalOnly: ExternalOnlyAttachmentReport[] = [];
  let blobCount = 0;

  for (const metadata of attachmentMetadata) {
    if (metadata.availability !== 'stored' || metadata.contentHash === null) {
      externalOnly.push(disclosureFor(metadata, fullDeviceExternalOnlyReason(metadata)));
      continue;
    }
    const supplied = payloadBytes.get(metadata.attachmentId);
    const mirrored = blobByAttachment.get(metadata.attachmentId);
    const bytes =
      supplied ??
      (mirrored === undefined ? undefined : new Uint8Array(mirrored.bytes));
    const contentHash = bytes === undefined || bytes.byteLength === 0 ? null : sha256Hex(bytes);
    if (contentHash === null || contentHash !== metadata.contentHash) {
      // Either there are no bytes anywhere on this device, or the bytes that are
      // there are not the bytes this record says they are. Both are disclosed with
      // no fabricated hash, and neither makes the export fail: an unreachable or
      // inconsistent image must not make a backup impossible.
      //
      // Including the mismatched bytes under their real digest would be worse than
      // omitting them: the record's declared hash would name no member, so the
      // importer would have to choose between restoring a record whose hash is a
      // lie and dropping its bytes anyway. Omitting them keeps the archive
      // self-consistent and the disclosure honest.
      externalOnly.push(disclosureFor(metadata, fullDeviceExternalOnlyReason(metadata)));
      continue;
    }
    // Content addressing is the plan's contract, so the member is named by the
    // digest of the bytes it actually carries. Two attachments with identical
    // bytes therefore collapse onto one member.
    if (!attachmentMembers.has(contentHash)) attachmentMembers.set(contentHash, bytes as Uint8Array);
    blobCount += 1;
  }

  // ── The state document ──
  const state: Record<string, unknown> = {
    formatVersion: FULL_DEVICE_FORMAT_VERSION,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion:
      snapshot.descriptor?.subjectSchemaVersion ?? CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: now,
    // The generation label the source device used. It is an opaque identifier, not
    // learner content, and the importer uses it so a restore onto a device that
    // does not already hold that label keeps the archive's own internal
    // references - the migration receipts - truthful.
    sourceGenerationId: generationId,
    activeSubjectId:
      typeof request.activeSubjectId === 'string' ? request.activeSubjectId : null,
    locale: preferenceValue(preferences, 'locale'),
    questState: preferenceValue(preferences, 'questState'),
    subjects,
    progression,
    sessions,
    preferences,
    shortcuts,
    assistance,
    attachmentMetadata,
    customSprites,
    recovery,
    migrationReceipts,
  };

  // ── Members ──
  // `state.json` first, then content-addressed attachment bytes, then the two
  // index-addressed groups in the document's own order, so a reader can rebuild
  // the mapping from `state.json` alone.
  // One `mtime`, from the injected clock, for every member. This is the difference
  // between "the members are reproducible" and "the archive is reproducible", and
  // the only reason it can be derived here is that `now` is already injected -
  // this module has no clock of its own to consult.
  const mtime = exportMemberTime(now);
  const files: ArchiveFile[] = [
    { path: FULL_DEVICE_STATE_MEMBER, bytes: encoder.encode(canonicalJsonStringify(state)), mtime },
  ];
  for (const [contentHash, bytes] of attachmentMembers) {
    files.push({ path: `attachments/${contentHash}`, bytes, mtime });
  }
  customSprites.forEach((record, index) => {
    files.push({
      path: `custom-sprites/${fullDeviceIndexMemberName(index + 1, record.kind)}`,
      bytes: encoder.encode(record.content),
      mtime,
    });
  });
  recovery.forEach((record, index) => {
    files.push({
      path: `recovery/${fullDeviceIndexMemberName(index + 1, 'json')}`,
      bytes: encoder.encode(record.raw),
      mtime,
    });
  });

  const memberEntries: FullDeviceManifestMember[] = files.map((file) => ({
    path: file.path,
    byteLength: file.bytes.byteLength,
    sha256: sha256Hex(file.bytes),
  }));
  const attachmentEntries = memberEntries.filter((entry) => entry.path.startsWith('attachments/'));
  const recordCounts = emptyCounts();
  recordCounts.subjects = subjects.length;
  recordCounts.progression = progression.length;
  recordCounts.sessions = sessions.length;
  recordCounts.preferences = preferences.length;
  recordCounts.shortcuts = shortcuts.length;
  recordCounts.assistance = assistance.length;
  recordCounts.attachments = attachmentMetadata.length + blobCount;
  recordCounts.customSprites = customSprites.length;
  recordCounts.recovery = recovery.length;
  recordCounts.migrationReceipts = migrationReceipts.length;

  const reasonHistogram: Record<string, number> = {};
  for (const disclosure of externalOnly) {
    reasonHistogram[disclosure.reason] = (reasonHistogram[disclosure.reason] ?? 0) + 1;
  }

  const manifest: FullDeviceManifest = {
    product: FULL_DEVICE_PRODUCT,
    formatVersion: FULL_DEVICE_FORMAT_VERSION,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion: state.subjectSchemaVersion as string,
    createdAt: now,
    memberCount: memberEntries.length,
    totalBytes: memberEntries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: fullDeviceManifestContentChecksum(memberEntries),
    recordCounts,
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    externalOnlyAttachments: { count: externalOnly.length, reasons: reasonHistogram },
    members: memberEntries,
  };

  files.unshift({
    path: FULL_DEVICE_MANIFEST_MEMBER,
    bytes: encoder.encode(canonicalJsonStringify(manifest)),
    mtime,
  });

  return {
    bytes: writeArchive(files),
    manifest,
    memberNames: files.map((file) => file.path),
    fileName: FULL_DEVICE_BACKUP_FILE_NAME,
    externalOnlyAttachments: externalOnly,
  };
}

// ── Reaching the live device ───────────────────────────────────────────────

/**
 * The live storage-v2 handle, or `null` when storage-v2 is not selected.
 *
 * ## Why the product publishes this
 *
 * {@link FullDeviceExportRequest.repository} is a
 * {@link StorageV2Repository}, so a screen that calls the export or the import has
 * to be able to hand over a handle. There are exactly two ways to give it one, and
 * this is the better one:
 *
 * - a screen reaches `repositorySelection` itself, which makes every UI file that
 *   backs up a device a module that names storage-v2, and therefore one more entry
 *   in `tests/migrations/qaHardening.test.ts`'s seam allowlist;
 * - the product publishes the accessor, so the screen's only storage-v2-aware
 *   import is this module, reached lazily, and the allowlist needs no UI entry.
 *
 * The second is what this is. The product is already the boundary between a screen
 * and storage-v2 - it owns the archive format, the request shape, and the
 * generation transaction - and publishing the handle it needs for its own request
 * type keeps that boundary in one place instead of spreading it across every
 * screen that offers a backup.
 *
 * It is reached the way every other consumer reaches storage-v2: a dynamic
 * `import()` of a literal, so the selection module and the repository type behind
 * it are in the module's own lazy chunk and not in a build with
 * `VITE_DATA_PRODUCTS_V2=false`. Nothing here opens a database: it asks the
 * selection module for the handle the bootstrap already published.
 *
 * Returns `null` rather than throwing, so a caller on the legacy path gets a clean
 * "there is nothing here to back up" instead of an error it would have to
 * classify. Plan section 11 keeps `legacy` the production default, so this is the
 * *likely* answer, not the exceptional one.
 */
export async function resolveLiveDeviceRepository(): Promise<StorageV2Repository | null> {
  const selection = await import('@/services/persistence/v2/repositorySelection');
  return selection.currentStorageV2Repository();
}

/**
 * The generation the live `activeGeneration` pointer names, or `null`.
 *
 * `null` covers both "storage-v2 is not selected" and "storage-v2 is selected but
 * no generation has been activated yet", which is the honest state of a profile
 * where the application has run but the learner has not created a subject. Both
 * are the same answer to a screen's question - "which generation would a backup
 * read?" - which is "none", and neither is an error.
 */
export async function readLiveActiveGenerationId(): Promise<string | null> {
  const repository = await resolveLiveDeviceRepository();
  if (repository === null) return null;
  return repository.readActiveGenerationId();
}

// ── Import ────────────────────────────────────────────────────────────────

export interface FullDeviceImportRequest {
  readonly repository: StorageV2Repository;
  readonly bytes: Uint8Array;
  /** Injected clock, stamped on the blob records the restore writes. */
  readonly now: string;
  /**
   * Plan section 7.1 step 6 and the Phase 5 scope: the previous generation is
   * retained. The request states it rather than leaving it to a default.
   *
   * Retention is nevertheless unconditional. A restore never deletes the
   * generation it replaced, because that generation is the learner's other copy
   * of everything; a boolean that could turn that into a deletion is a boolean
   * with no safe false value. The value is recorded in the result and
   * {@link FullDeviceImportResult.retentionNote} says what happened.
   */
  readonly keepPreviousGeneration?: boolean;
}

export interface FullDeviceImportResult {
  /** The generation this restore wrote. */
  readonly generationId: string;
  /** The generation that was active before, and that is still retained. */
  readonly previousActiveGenerationId: string | null;
  /** True only when `activeGeneration` was actually re-pointed. */
  readonly activated: boolean;
  /** True when the previous generation is still readable after the restore. */
  readonly previousGenerationRetained: boolean;
  /**
   * Relationship conditions that were disclosed rather than refused.
   *
   * Storage-v2 separates `error` problems, which block activation, from `warning`
   * problems, which mark a reference to something legitimately absent - a
   * progression record whose subject the learner deleted, for instance. A restore
   * refuses the first and discloses the second, because refusing a backup over a
   * dangling reference would strand the learner's XP and fish, and dropping the
   * record would be destructive. Each entry is a code, a scope, and a count.
   */
  readonly disclosedWarnings: readonly ValidationProblem[];
  /**
   * Whether the previous generation was in fact retained. Always `true`.
   *
   * This field used to carry the *request*, and a caller that read it as an
   * outcome drew the opposite conclusion from the truth: a restore asked with
   * `keepPreviousGeneration: false` reported `false` while the previous generation
   * was still on the device, superseded and fully readable. The name reads as an
   * outcome, so it now reports one - the same fact as
   * {@link previousGenerationRetained}, kept under the name existing callers
   * already read rather than added alongside it.
   */
  readonly keepPreviousGeneration: boolean;
  /**
   * The value the caller asked for, echoed unchanged.
   *
   * It has no effect on retention, which is unconditional. It exists so a caller
   * can log its own request and notice that its caller expected a no-op flag, and
   * it is deliberately *not* named like an outcome.
   */
  readonly requestedRetention: boolean;
  /** One line, code-shaped, saying why retention was not conditional. */
  readonly retentionNote: string;
  /** The sanitized preview the import was allowed to act on. */
  readonly preview: FullDeviceArchivePreview;
  /** Attachments restored without their bytes, with no fabricated hash. */
  readonly externalOnlyAttachments: readonly ExternalOnlyAttachmentReport[];
  /** Per-store record counts of the generation the restore wrote. */
  readonly recordCounts: Readonly<Record<StorageV2StoreName, number>>;
  /** The staged generation's roll-up checksum, recomputed after activation. */
  readonly contentChecksum: string;
  /**
   * The active-subject id the archive named, reported and **not** applied.
   *
   * The pointer is synchronously readable legacy-mirror state that Phase 4 kept
   * out of the storage-v2 repositories on purpose, so a product module does not
   * write it. Carrying it in the archive and disclosing it here keeps the restore
   * honest; applying it is recorded as a Phase 5 follow-up rather than smuggled in.
   */
  readonly restoredActiveSubjectId: string | null;
  /** True when the archive's own generation label was reused for this device. */
  readonly reusedArchiveGenerationId: boolean;
  /** Migration receipts the archive carried, restored into the new generation. */
  readonly migrationReceiptCount: number;
  /** No receipt is minted for a restore; the count is the archive's own. */
  readonly receiptNote: string;
  /**
   * Whether the restore had to re-point the archive's receipts at the generation
   * it wrote. False when the archive's label was adopted, so the receipts came
   * back verbatim.
   *
   * The disclosure matters because the re-point is partial. Only
   * `stagedGenerationId` is rewritten, so the receipt then names a generation
   * whose descriptor it disagrees with: its `contentChecksum`, `recordChecksums`
   * and `previousActiveGenerationId` still describe the **source** device. That
   * mismatch is disclosed here rather than repaired, and deliberately so -
   * recomputing those fields to agree with this device would forge a record of a
   * migration this device never performed, and would destroy the only evidence
   * that the data arrived from somewhere else. A caller that needs to know
   * whether a receipt can be trusted as a local fact must read this flag.
   */
  readonly migrationReceiptRepointed: boolean;
  /**
   * One line, code-shaped, saying whether the receipts' provenance is intact or
   * carries the source device's checksums.
   */
  readonly receiptProvenanceNote: string;
}

/** A generation label the importer is willing to adopt from an archive. */
const ADOPTABLE_GENERATION_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Whether a generation label is safe to write into the database.
 *
 * Two rules, both needed. The character class keeps a label code-shaped, which is
 * also what makes it safe to appear in a sanitized error detail. The prototype rule
 * is the same one the reader already applies to a member name, applied here because
 * a generation label is a **database key**: a key that collides with
 * `Object.prototype` is a hazard wherever it is later handled as a plain object,
 * and adopting an attacker-chosen one would put that hazard in the database rather
 * than in a file.
 */
function isAdoptableGenerationId(candidate: string): boolean {
  return ADOPTABLE_GENERATION_ID.test(candidate) && !isPrototypeMemberName(candidate);
}

function generationHasRecords(snapshot: GenerationSnapshot): boolean {
  const records = snapshot.records as unknown as Record<string, unknown[]>;
  return Object.values(records).some((entries) => Array.isArray(entries) && entries.length > 0);
}

/**
 * Choose the generation label the restore writes.
 *
 * The archive's own label is preferred, because the migration receipts it carries
 * name the generation they belong to and storage-v2's own relationship rule
 * refuses a generation whose receipts point elsewhere. Keeping the label makes
 * those references true on the new device too.
 *
 * It is only adopted when the label is code-shaped and this device holds nothing
 * under it - no descriptor and no records, including orphans - because staging
 * over a live or superseded generation would merge two sets of records.
 */
async function chooseGenerationId(
  repository: StorageV2Repository,
  requested: string | null,
): Promise<{ generationId: string; reused: boolean }> {
  const isFree = async (candidate: string): Promise<boolean> => {
    if ((await repository.readGeneration(candidate)) !== null) return false;
    return !generationHasRecords(await repository.readRecords(candidate));
  };
  if (requested !== null && isAdoptableGenerationId(requested) && (await isFree(requested))) {
    return { generationId: requested, reused: true };
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = repository.idFactory.next();
    if (candidate.trim().length === 0) break;
    // The minted label goes through the same rule as the requested one: an id
    // factory is injected, so its output is data like any other, and the one
    // guarantee this function offers is that whatever it returns is writable.
    if (!isAdoptableGenerationId(candidate)) continue;
    if (await isFree(candidate)) return { generationId: candidate, reused: false };
  }
  throw new StorageV2Error('GENERATION_NOT_FOUND', { reason: 'no-free-generation-id' });
}

/**
 * Rebuild the generation records the archive describes.
 *
 * Every value is carried **verbatim**: nothing is normalized, re-derived, or
 * field-picked, so an unknown app-owned field at any level survives a restore
 * (plan section 7.3). The only values this function changes are the ones that
 * cannot be carried verbatim because they are *about* the device the restore is
 * writing to - the generation a receipt belongs to - and the availability of an
 * attachment whose bytes the archive does not carry.
 */
function recordsFromArchive(
  contents: { state: Record<string, unknown>; memberBytes: ReadonlyMap<string, Uint8Array> },
  options: { readonly now: string; readonly generationId: string; readonly reuseArchiveGenerationId: boolean },
): {
  records: GenerationRecordValues;
  externalOnly: ExternalOnlyAttachmentReport[];
  blobCount: number;
  receiptsRepointed: boolean;
} {
  const state = contents.state;
  const section = <T>(name: FullDeviceStateSection): T[] => state[name] as T[];

  const attachmentBlobs: AttachmentBlobRecordValue[] = [];
  const externalOnly: ExternalOnlyAttachmentReport[] = [];
  const attachmentMetadata: AttachmentMetadataRecordValue[] = [];
  for (const record of section<AttachmentMetadataRecordValue>('attachmentMetadata')) {
    const declaredHash =
      record.availability === 'stored' && typeof record.contentHash === 'string'
        ? record.contentHash
        : null;
    const memberPath = declaredHash === null ? undefined : `attachments/${declaredHash}`;
    const bytes = memberPath === undefined ? undefined : contents.memberBytes.get(memberPath);
    if (declaredHash === null || bytes === undefined) {
      // Plan section 2.3: an attachment whose bytes are not in the archive is
      // disclosed, keeps no hash, and does not fail the restore. Storage-v2's own
      // relationship rule requires the two halves to agree - `stored` without a
      // blob is an error - so the record is restored as what it really is.
      attachmentMetadata.push({ ...record, availability: 'external-only', contentHash: null });
      externalOnly.push({
        attachmentId: record.attachmentId,
        subjectId: record.subjectId,
        roomId: record.roomId,
        contentHash: null,
        byteLength: null,
        reason: fullDeviceExternalOnlyReason(record),
        sourceType: record.sourceType,
      });
      continue;
    }
    attachmentMetadata.push(record);
    // The bytes are copied into a fresh ArrayBuffer so the record owns them: a
    // later mutation of the caller's view cannot change what was stored, which is
    // the same discipline `attachmentBytes.ts` applies on the way in.
    attachmentBlobs.push({
      attachmentId: record.attachmentId,
      contentHash: declaredHash,
      bytes: bytes.slice().buffer as ArrayBuffer,
      byteLength: bytes.byteLength,
      storedAt: options.now,
    });
  }

  // Adoption is what keeps a receipt truthful. Only when the label could not be
  // adopted is `stagedGenerationId` re-pointed at the generation this restore
  // wrote, and that is a partial rewrite: the receipt's own checksums keep
  // describing the source device. The caller discloses that with
  // `migrationReceiptRepointed` rather than this function quietly repairing it.
  const archiveReceipts = section<MigrationReceiptValue>('migrationReceipts');
  const receiptsRepointed = !options.reuseArchiveGenerationId && archiveReceipts.length > 0;
  const migrationReceipts = archiveReceipts.map((receipt) =>
    options.reuseArchiveGenerationId
      ? receipt
      : { ...receipt, stagedGenerationId: options.generationId },
  );

  return {
    receiptsRepointed,
    records: {
      subjects: section('subjects'),
      progression: section('progression'),
      sessions: section('sessions'),
      preferences: section('preferences'),
      shortcuts: section('shortcuts'),
      assistance: section('assistance'),
      attachmentMetadata,
      attachmentBlobs,
      customSprites: section('customSprites'),
      recovery: section('recovery'),
      migrationReceipts,
    },
    externalOnly,
    blobCount: attachmentBlobs.length,
  };
}

/**
 * Cross-check the manifest's declared record counts against the state document.
 *
 * Run before staging, so a manifest that lies about its own state never reaches
 * the database. The counts are computed the same way
 * `countGenerationRecords` computes them - including `attachments` being metadata
 * plus blobs, and `meta` being zero because the descriptor registry and the
 * pointer are written by activation rather than by staging - so a disagreement
 * here is a disagreement the repository would also have found.
 */
function assertDeclaredRecordCounts(
  declared: Readonly<Record<StorageV2StoreName, number>>,
  built: GenerationRecordValues,
): void {
  const actual: Record<StorageV2StoreName, number> = {
    meta: 0,
    subjects: built.subjects.length,
    progression: built.progression.length,
    sessions: built.sessions.length,
    preferences: built.preferences.length,
    shortcuts: built.shortcuts.length,
    assistance: built.assistance.length,
    attachments: built.attachmentMetadata.length + built.attachmentBlobs.length,
    customSprites: built.customSprites.length,
    recovery: built.recovery.length,
    migrationReceipts: built.migrationReceipts.length,
  };
  for (const storeName of STORAGE_V2_STORE_NAMES) {
    if (declared[storeName] !== actual[storeName]) {
      throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
    }
  }
}

/**
 * Restore a `.kdbak` into a new generation, and activate it only if it is sound.
 *
 * The exact conditions under which `activeGeneration` flips are: the archive read
 * and validated, the manifest's declared record counts matched the records the
 * state document actually carries, the complete generation was staged, the staged
 * generation validated with no blocking problem, no count delta, and no checksum
 * mismatch, its recomputed roll-up checksum equalled the staged one, and the
 * activation transaction committed. Every one of those is a hard gate; there is
 * no "warn and continue" path, and no partial restore.
 */
export async function importFullDeviceBackup(
  request: FullDeviceImportRequest,
): Promise<FullDeviceImportResult> {
  const { repository, bytes, now } = request;
  const keepPreviousGeneration = request.keepPreviousGeneration !== false;

  // ── 1. Read and validate without modifying anything ──
  // Nothing has been written at this point, so every failure up to here is
  // trivially "nothing changed": there was nothing to change.
  const contents = readFullDeviceArchiveContents(bytes);
  const preview = contents.preview;

  const previousActiveGenerationId = await repository.readActiveGenerationId();
  const requestedId =
    typeof contents.state.sourceGenerationId === 'string' ? contents.state.sourceGenerationId : null;
  const { generationId, reused } = await chooseGenerationId(repository, requestedId);

  const built = recordsFromArchive(contents, {
    now,
    generationId,
    reuseArchiveGenerationId: reused,
  });

  // A count disagreement is caught before staging, so a manifest that lies about
  // its own state never reaches the database.
  assertDeclaredRecordCounts(preview.recordCounts, built.records);

  // ── 2. Write a complete new generation ──
  let staged = false;
  try {
    const written = await repository.stageGeneration({
      generationId,
      source: 'full-device-import',
      parentGenerationId: previousActiveGenerationId,
      records: built.records,
    });
    staged = true;

    // ── 3. Compare counts, relationships, and checksums ──
    // The staged generation's own roll-up is compared with the one recomputed by
    // reading it back, before anything else is believed. A generation whose
    // stored checksum and recomputed checksum disagree is not a generation this
    // build can reason about, whatever its records say.
    const reread = await repository.readRecords(generationId);
    if (reread.contentChecksum !== written.contentChecksum) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { stage: 'compare' });
    }
    const validation = await repository.validateGeneration(generationId);
    // Only *blocking* problems refuse a restore. `validation.ok` is precisely that
    // test, and using the problem count instead would refuse a device whose
    // progression record names a subject the learner deleted - which storage-v2
    // deliberately treats as a disclosure rather than a defect, because dropping
    // the record would be destructive and activating without it would be
    // dishonest.
    if (!validation.ok) {
      throw new StorageV2Error('VALIDATION_FAILED', {
        stage: 'validate',
        problemCount: countBlockingProblems(validation.problems),
      });
    }
    if (validation.checksumMismatches.length > 0) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', {
        stage: 'validate',
        storeCount: validation.checksumMismatches.length,
      });
    }

    // ── 4. Flip the pointer, retaining the previous generation ──
    const activation = await repository.activateGeneration(generationId);
    const activated = await repository.readGeneration(generationId);
    // Retention is unconditional and the activate transaction does not delete, so
    // this is measured rather than assumed: whatever was active before is still
    // readable afterwards. `null` only when the device had nothing active, in which
    // case there was no previous generation to retain.
    const previousGenerationRetained = previousActiveGenerationId !== null;
    return {
      generationId,
      previousActiveGenerationId: activation.previousActiveGenerationId,
      activated: true,
      previousGenerationRetained,
      // An outcome, not the request. See the interface: a caller reading this as
      // "the previous generation was not kept" would otherwise be told `false`
      // while the generation is sitting on the device, readable.
      keepPreviousGeneration: previousGenerationRetained,
      requestedRetention: keepPreviousGeneration,
      retentionNote: 'previous-generation-always-retained',
      preview,
      disclosedWarnings: validation.problems.filter((problem) => problem.severity === 'warning'),
      externalOnlyAttachments: built.externalOnly,
      // The activated generation's own counts, read back from its descriptor
      // rather than echoed from the manifest: what the device holds, not what the
      // file claimed.
      recordCounts: activated?.descriptor?.recordCounts ?? emptyCounts(),
      contentChecksum: activated?.descriptor?.contentChecksum ?? '',
      restoredActiveSubjectId: preview.activeSubjectId,
      reusedArchiveGenerationId: reused,
      migrationReceiptCount: built.records.migrationReceipts.length,
      receiptNote: 'restore-mints-no-receipt',
      migrationReceiptRepointed: built.receiptsRepointed,
      receiptProvenanceNote: built.receiptsRepointed
        ? 'receipts-repointed-provenance-preserved'
        : 'receipts-carried-verbatim',
    };
  } catch (error) {
    // ── 5. On any failure, leave the device exactly as it was ──
    // A generation that was only `staged` has no reader and no pointer, so it is
    // removed rather than left for a later run to reclaim. The previous
    // generation is untouched, and nothing claimed success.
    if (staged) {
      await repository.discardStagedGeneration(generationId);
    }
    throw error;
  }
}

/** The sections an archive's state document must carry, re-exported for callers. */
export const FULL_DEVICE_SECTIONS = FULL_DEVICE_STATE_SECTIONS;
