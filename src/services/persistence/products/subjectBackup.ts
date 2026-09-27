/**
 * The individual-subject `.kdsubject` backup product: export, and import.
 *
 * Plan section 7.3 fixes the archive layout and this module implements it and
 * nothing else:
 *
 * ```text
 * manifest.json
 * subject.json
 * progression.json
 * sessions.json
 * assistance.json
 * attachments/*
 * ```
 *
 * The default import mode is **Create copy**, which is why
 * `./idRemapping` exists; **Replace existing** is explicit, destructive, and
 * confirmed. Neither downloads anything - the product returns bytes and a
 * content-free file name, and turning them into a file is a user-interface
 * concern. There is no `navigator.share`, no `fetch`, no `XMLHttpRequest`, no
 * `sendBeacon`, and no `URL.createObjectURL` anywhere in this file, and
 * `tests/data/localDownloadOnly.test.ts` walks the real application graph to
 * keep it that way.
 *
 * ## What is shared with the `.kdbak` product, and what genuinely differs
 *
 * Reused, not forked, because these are properties of a ZIP archive and of this
 * application's data model rather than of any one product's member list:
 *
 * - the audited ZIP codec, `writeArchive` / `readArchive` and friends, and the
 *   `archiveMemberTimeFrom` DOS-date clamp that makes an export
 *   byte-deterministic under an injected clock;
 * - `readAndVetArchiveMembers` from `./archiveValidation`, which applies every
 *   layout-independent check: no dropped member, no entry that declares itself a
 *   directory or a symlink, no unsafe or duplicated member name, no
 *   `Object.prototype` name;
 * - `isPrototypeMemberName`, and the same reason a generated generation label
 *   cannot be a prototype name: a label becomes a database key;
 * - `fullDeviceManifestContentChecksum` - the roll-up digest over declared
 *   members, over the same `{sha256} {path}` line format;
 * - `fullDeviceExternalOnlyReason` - one rule for why an attachment has no bytes,
 *   used by the export's manifest histogram and by the importer's disclosure set so
 *   the two cross-checks can hold;
 * - the storage-v2 per-record validators, and `MIGRATION_BLOCKING_POLICY` /
 *   `isActivationBlocking` / `partitionMigrationProblems` as the single rule that
 *   separates a refusal from a disclosure;
 * - the content-addressed `attachments/<sha256>` member name, and the rule that
 *   such a member's bytes must hash to its own name;
 * - `resolveLiveDeviceRepository`, `readLiveActiveGenerationId`, and
 *   `resolveDeviceLocalPayloadBytes`, re-exported from `./fullDeviceBackup` so a
 *   screen has one storage-v2-aware import for both products.
 *
 * What genuinely differs, and therefore lives here rather than being
 * parameterised into the shared code:
 *
 * - **The fixed member set and the prefixes.** A `.kdsubject` has five fixed
 *   member names against the `.kdbak`'s two, and one prefix (`attachments`)
 *   against three. Parameterising a shared layout with a product's member list
 *   would produce a function whose name says "archive" and whose body is a union
 *   of two products, so each product declares its own layout and shares only the
 *   safety.
 * - **One subject, not a device.** `subject.json` holds exactly one subject
 *   record; an archive that carries two is refused. A `.kdsubject` therefore has
 *   no `preferences`, `shortcuts`, `customSprites`, `recovery`, or
 *   `migrationReceipts` at all, and the manifest's `recordCounts` is keyed by the
 *   five document sections rather than by the eleven storage-v2 store names -
 *   because the only honest count of a product that is deliberately not a
 *   whole-generation replace is a count of what the product *carries*.
 *
 * ## The generation transaction, and why a subject import is partial
 *
 * Plan section 5.2 requires that "Data imports never partially overwrite the
 * active data generation", and plan section 7.1 requires staging under an
 * `activeGeneration` pointer. A subject import satisfies both by **never writing
 * into the live active generation**. It:
 *
 * 1. reads and validates the archive without touching stored data;
 * 2. reads the active generation's records and carries every record this import
 *    does not own over **byte for byte**;
 * 3. stages a complete new generation containing the carry-over plus the
 *    imported subject;
 * 4. compares record counts, the recomputed roll-up checksum, and the
 *    relationship problems;
 * 5. refuses only on **blocking** problems, decided by
 *    `isActivationBlocking` - not by a locally re-derived rule and not by the
 *    problem count, which is Phase 5's blocker in a second form;
 * 6. activates, retaining the previous generation unconditionally; and
 * 7. on any failure, discards the staged generation and leaves the device
 *    byte-identical.
 *
 * A note on the in-place alternative, because it is the obvious one: writing the
 * imported subject with `putRecords` into the active generation would be one write
 * instead of a transaction, and it would break the contract above in the exact way
 * the contract exists to prevent - a failure halfway through leaves the learner's
 * device with half an import and no rollback. The previous generation is the
 * rollback path, and only a new generation gives you one.
 *
 * ## Migration receipts: the one store a subject import does *not* carry forward
 *
 * A migration receipt is a statement about **the generation that carries it**:
 * `MigrationReceiptValue.stagedGenerationId` names the generation storage-v2 wrote,
 * and `validateGenerationRecords` refuses - at `error` severity - any generation
 * holding a receipt that names a different one. So a subject import that carried
 * the device's receipts forward byte for byte would produce a generation that
 * storage-v2 refuses to activate, and the import would be impossible on every
 * device that had ever migrated.
 *
 * The two alternatives are both worse, and one of them is the lie Phase 5 already
 * had to disclose:
 *
 * - **Re-point** `stagedGenerationId` at the new generation. The receipt then
 *   claims the subject-import generation was the product of the legacy migration,
 *   and the rest of its fields - `contentChecksum`, `recordChecksums`,
 *   `previousActiveGenerationId` - still describe a different device entirely.
 *   That is a forged provenance record, and it is the precise defect
 *   `FullDeviceImportResult.migrationReceiptRepointed` exists to disclose.
 * - **Delete** the receipts. Nothing is lost - the retained previous generation
 *   still holds them, readable, with the same ids - but the new generation's
 *   receipt list is empty rather than carried, and that is a real, visible
 *   difference from "byte-identical".
 *
 * So this product does the third thing, which is the honest one: **the new
 * generation carries no receipts, and the previous generation retains them.**
 * {@link SubjectImportResult.receiptPolicy} and
 * {@link SubjectImportResult.previousGenerationReceiptCount} say so on the result,
 * and `tests/data/subjectImportIsolation.test.ts` asserts the retained generation
 * still holds them byte for byte. Every other store is carried over byte for byte,
 * and that is what the same gate asserts.
 *
 * ## No receipt is minted for an import
 *
 * `MigrationReceiptValue.fromStorage` is typed `'legacy-localstorage'`. A receipt
 * written here would claim a migration this device never performed, so none is
 * written, exactly as Phase 5 established for a `.kdbak` restore
 * (`'restore-mints-no-receipt'`). A generation's `source` field records
 * `'subject-import'` instead, and that is the honest record of what produced it.
 *
 * ## Sessions are filtered, and what happens to an orphan
 *
 * The export carries a session when its `subjectId` equals the exported subject's
 * id, and no others. A session whose `subjectId` names a subject that no longer
 * exists - the case `SessionRecordValue.subjectName` exists for - is therefore
 * **not in the `.kdsubject` at all**: it is not this subject's history, and the
 * `.kdsubject` is not a device backup. The device keeps it, because the import
 * carries the base generation's records over byte for byte, so nothing is lost by
 * the omission.
 *
 * On import the rule is deliberately *not* mirrored, because there dropping the
 * record would be destructive. A session inside an archive that names a subject
 * the archive's own `subject.json` does not declare is **disclosed as a warning**
 * and carried, for the same reason storage-v2 discloses a progression record whose
 * subject the learner deleted: the record is real history, dropping it is data
 * loss, and a `.kdsubject` a learner made by hand must not fail to restore
 * because it is more careful than the writer. The warning is on
 * {@link SubjectImportResult.disclosedWarnings}.
 *
 * ## Privacy
 *
 * The manifest carries counts, versions, digests, and member names, and no
 * identifier at all - not even the subject's, because the reader can get it from
 * `subject.json` and a manifest that names a subject is a manifest a rejected
 * archive can leak through. Member names are a fixed name or a content hash. The
 * result carries opaque ids, codes, and counts. Nothing here logs, and no
 * `StorageV2Error` detail is ever a value a learner authored - the constructor
 * refuses one.
 *
 * Renderer-neutral: no renderer, no UI, no network.
 */

import {
  writeArchive as writeArchiveBytes,
  decodeArchiveJsonMember,
  type ArchiveFile,
} from '@/services/persistence/v2/archive';
import { canonicalJsonStringify, checksumValue, sha256Hex } from '@/services/persistence/v2/checksum';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  isSanitizedDetailText,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  StorageV2Error,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type AssistanceRecordValue,
  type ExternalOnlyAttachmentReport,
  type ProgressionRecordValue,
  type SessionRecordValue,
  type StorageV2StoreName,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import {
  MIGRATION_BLOCKING_POLICY,
  partitionMigrationProblems,
  type MigrationBlockingPolicy,
} from '@/services/persistence/v2/migrationState';
import {
  countBlockingProblems,
  validateAssistanceRecord,
  validateAttachmentMetadataRecord,
  validateProgressionRecord,
  validateSessionRecord,
  validateSubjectRecord,
  type GenerationRecordValues,
  type ValidationProblem,
  type ValidationScope,
} from '@/services/persistence/v2/validation';
import type { GenerationSnapshot, StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  DATA_PRODUCT_FORMAT_VERSIONS,
  type DataProductKind,
} from '@/core/validation/persistence/types';
import {
  archiveMemberTimeFrom,
  classifyFullDeviceMemberName,
  fullDeviceExternalOnlyReason,
  fullDeviceManifestContentChecksum,
  isPrototypeMemberName,
  readAndVetArchiveMembers,
  type MemberNameVerdict,
} from './archiveValidation';
import {
  collectExistingIdentifiers,
  remapSubjectRecords,
  subjectIdentifierGroups,
  SUBJECT_ID_KIND_PREFIX,
  SUBJECT_ID_MINT_ATTEMPTS,
  type SubjectIdGenerator,
  type SubjectIdKind,
  type SubjectIdMapping,
  type SubjectVerbatimDisclosure,
} from './idRemapping';

export {
  readLiveActiveGenerationId,
  resolveDeviceLocalPayloadBytes,
  resolveLiveDeviceRepository,
} from './fullDeviceBackup';
export type { SubjectIdKind, SubjectIdMapping, SubjectIdMappingEntry } from './idRemapping';

// ── The layout ─────────────────────────────────────────────────────────────

/** Which product this module writes and reads. */
export const SUBJECT_PRODUCT: DataProductKind = 'kdsubject';

/** The `.kdsubject` layout version this build writes and accepts. */
export const SUBJECT_ARCHIVE_FORMAT_VERSION = DATA_PRODUCT_FORMAT_VERSIONS[SUBJECT_PRODUCT];

/** The five member names the plan fixes, in write order after the manifest. */
export const SUBJECT_ARCHIVE_SUBJECT_MEMBER = 'subject.json';
export const SUBJECT_ARCHIVE_PROGRESSION_MEMBER = 'progression.json';
export const SUBJECT_ARCHIVE_SESSIONS_MEMBER = 'sessions.json';
export const SUBJECT_ARCHIVE_ASSISTANCE_MEMBER = 'assistance.json';
export const SUBJECT_ARCHIVE_MANIFEST_MEMBER = 'manifest.json';

/** The four non-manifest fixed members, in write order. */
export const SUBJECT_ARCHIVE_DOCUMENT_MEMBERS: readonly string[] = [
  SUBJECT_ARCHIVE_SUBJECT_MEMBER,
  SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
  SUBJECT_ARCHIVE_SESSIONS_MEMBER,
  SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
];

/** Every fixed member name, manifest included. */
export const SUBJECT_ARCHIVE_FIXED_MEMBERS: readonly string[] = [
  SUBJECT_ARCHIVE_MANIFEST_MEMBER,
  ...SUBJECT_ARCHIVE_DOCUMENT_MEMBERS,
];

/**
 * The one member prefix the plan's `.kdsubject` layout allows, without the
 * trailing slash. There is no `custom-sprites/` and no `recovery/`: a subject
 * backup carries a subject and its learner state, and a custom sprite or a legacy
 * recovery payload belongs to the device, not to a subject.
 */
export const SUBJECT_ARCHIVE_ATTACHMENT_PREFIX = 'attachments';

/** Lowercase 64-hex: the content-addressed member-name shape, shared with `.kdbak`. */
const CONTENT_HASH_NAME = /^[0-9a-f]{64}$/;

/**
 * The manifest's exact key set. Nothing may be added and nothing may be dropped.
 *
 * Thirteen keys, and every one of them is a count, a version, a digest, or a
 * fixed member name. There is **no identifier of any kind** - no `subjectId`, no
 * `sessionId` - because a manifest that named a subject would be a manifest a
 * refused archive could leak a subject id through, and the reader can read the
 * subject id out of `subject.json` in one line. `roomCount` is here because a
 * subject backup's headline number is its room count and a preview should not have
 * to parse a whole snapshot to learn it.
 */
export const SUBJECT_ARCHIVE_MANIFEST_KEYS = [
  'product',
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
  'createdAt',
  'memberCount',
  'totalBytes',
  'contentChecksum',
  'roomCount',
  'recordCounts',
  'attachmentBytes',
  'externalOnlyAttachments',
  'members',
] as const;

export type SubjectArchiveManifestKey = (typeof SUBJECT_ARCHIVE_MANIFEST_KEYS)[number];

/**
 * The `recordCounts` keys, and why they are not the storage-v2 store names.
 *
 * A `.kdbak` is a whole generation, so its counts are per storage-v2 store and an
 * importer can compare them with `countGenerationRecords`. A `.kdsubject` is
 * deliberately **not** a whole generation - it carries one subject and nothing
 * else - so the only count that means anything is "how many of the things this
 * archive carries does it carry". The five document sections plus the blob count
 * are exactly that, and the merged generation's real per-store counts are computed
 * by the repository and reported on the import result instead.
 */
export const SUBJECT_ARCHIVE_RECORD_COUNT_KEYS = [
  'subjects',
  'progression',
  'sessions',
  'assistance',
  'attachments',
  'attachmentBlobs',
] as const;

export type SubjectArchiveRecordCountKey = (typeof SUBJECT_ARCHIVE_RECORD_COUNT_KEYS)[number];

/** The `members[]` entry key set: a path, a length, and a digest. Nothing else. */
export const SUBJECT_ARCHIVE_MANIFEST_MEMBER_KEYS = ['path', 'byteLength', 'sha256'] as const;

/** The `attachmentBytes` sub-document key set. */
export const SUBJECT_ARCHIVE_ATTACHMENT_BYTES_KEYS = ['memberCount', 'byteLength'] as const;

/** The `externalOnlyAttachments` sub-document key set. */
export const SUBJECT_ARCHIVE_EXTERNAL_ONLY_KEYS = ['count', 'reasons'] as const;

/**
 * The three version fields, as three names, and refused three ways.
 *
 * Plan section 12, rule 4 keeps the data product format version, the storage
 * generation format version, and the subject schema version apart, and plan
 * section 7.3's `.kdbak` contract refuses each on its own. `.kdsubject` does the
 * same, and additionally requires the four document members' own copies of the
 * three contracts to agree with the manifest's - one member cannot claim a newer
 * subject schema than another, or the archive's declared contract is not a
 * contract.
 */
export const SUBJECT_ARCHIVE_VERSION_KEYS = [
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
] as const;

/**
 * The `subject.json` document's exact key set.
 *
 * `attachmentMetadata` is here because the plan's layout has no
 * `attachments.json`: the attachment records ride inside the subject document under
 * their own key, and adding a sixth JSON member would be a layout change rather
 * than an implementation of the layout.
 */
export const SUBJECT_ARCHIVE_SUBJECT_DOCUMENT_KEYS = [
  ...SUBJECT_ARCHIVE_VERSION_KEYS,
  'createdAt',
  'sourceGenerationId',
  'subject',
  'attachmentMetadata',
] as const;

/** Each of the three list documents' exact key set, plus its own payload key. */
export const SUBJECT_ARCHIVE_LIST_DOCUMENT_KEYS = [
  ...SUBJECT_ARCHIVE_VERSION_KEYS,
  'createdAt',
  'subjectId',
] as const;

/** The payload key each list document carries its records under. */
export const SUBJECT_ARCHIVE_LIST_PAYLOAD_KEYS = {
  [SUBJECT_ARCHIVE_PROGRESSION_MEMBER]: 'progression',
  [SUBJECT_ARCHIVE_SESSIONS_MEMBER]: 'sessions',
  [SUBJECT_ARCHIVE_ASSISTANCE_MEMBER]: 'assistance',
} as const;

export interface SubjectArchiveManifestMember {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface SubjectArchiveManifest {
  readonly product: DataProductKind;
  /** The `.kdsubject` layout version. A separate contract from the two below. */
  readonly formatVersion: number;
  /** The storage-v2 generation record shape. A separate contract. */
  readonly storageGenerationFormatVersion: number;
  /** The subject snapshot schema. A separate contract, and a semver string. */
  readonly subjectSchemaVersion: string;
  readonly createdAt: string;
  /** Number of entries in `members[]`, which omits `manifest.json` itself. */
  readonly memberCount: number;
  readonly totalBytes: number;
  readonly contentChecksum: string;
  readonly roomCount: number;
  readonly recordCounts: Readonly<Record<SubjectArchiveRecordCountKey, number>>;
  readonly attachmentBytes: { readonly memberCount: number; readonly byteLength: number };
  readonly externalOnlyAttachments: {
    readonly count: number;
    readonly reasons: Readonly<Record<string, number>>;
  };
  readonly members: readonly SubjectArchiveManifestMember[];
}

/**
 * The manifest's counting rule, stated once because it is the only place the two
 * member counts can diverge: `members[]` describes every member **except**
 * `manifest.json` itself, because a member cannot contain its own digest. An
 * archive's total member count is therefore `memberCount + 1`.
 */
export const SUBJECT_ARCHIVE_MANIFEST_OMITS_ITSELF = true;

/**
 * The file name a download should be offered under.
 *
 * Fixed and content-free: plan section 12, rule 6 forbids putting learner data in
 * a filename, and a timestamp would make an otherwise deterministic export look
 * like it varied. Not a per-subject name either - a file called
 * `<subject name>.kdsubject` is a subject name on the learner's disk and in their
 * downloads folder. The product returns the constant; the user interface applies
 * it.
 */
export const SUBJECT_BACKUP_FILE_NAME = 'knowledge-dungeon-subject-backup.kdsubject';

/**
 * Write a `.kdsubject`'s members.
 *
 * A re-export of the audited codec's writer, for the same reason
 * `fullDeviceBackup.ts` re-exports it: the plan's product contract includes a
 * `.kdsubject` being readable by other tooling, and the writer half of that is a
 * product concern. Nothing in this product hand-rolls ZIP.
 */
export const writeArchive = writeArchiveBytes;

// ── Member names ───────────────────────────────────────────────────────────

/**
 * Classify one member name against the `.kdsubject` layout.
 *
 * The *layout* rules are genuinely this product's own - five fixed names, one
 * content-addressed prefix - and are declared here rather than parameterised into
 * `classifyFullDeviceMemberName`, which is the `.kdbak`'s layout. The two things
 * that are **not** genuinely different are reused:
 *
 * - the content-addressed `attachments/<sha256>` name is the *same* plan
 *   contract over the *same* prefix, so the decision is delegated to
 *   `classifyFullDeviceMemberName` rather than re-deriving the digest shape;
 * - path safety is not decided here at all. It is applied before classification,
 *   by the shared `readAndVetArchiveMembers`, from the same function the `.kdbak`
 *   reader uses. A second copy of "is this path safe" is a second copy to forget.
 *
 * The reasons are fixed, code-shaped strings that name a *property* of the name
 * and never the name itself, so a rejection cannot leak what it rejected.
 */
export function classifySubjectArchiveMemberName(path: string): MemberNameVerdict {
  if ((SUBJECT_ARCHIVE_FIXED_MEMBERS as readonly string[]).includes(path)) {
    return { kind: 'fixed-name' };
  }
  if (typeof path !== 'string' || path.length === 0) {
    return { kind: 'rejected', reason: 'empty-path' };
  }
  if (isDirectoryEntryName(path)) {
    return path === `${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`
      ? { kind: 'directory-entry' }
      : { kind: 'rejected', reason: 'unknown-prefix' };
  }
  const segments = path.split('/');
  if (segments.length < 2) return { kind: 'rejected', reason: 'not-under-a-member-prefix' };
  if (segments.length > 2) return { kind: 'rejected', reason: 'nested-too-deep' };
  const [prefix, name] = segments as [string, string];
  if (prefix !== SUBJECT_ARCHIVE_ATTACHMENT_PREFIX) {
    return { kind: 'rejected', reason: 'unknown-prefix' };
  }
  // The content-address decision is the shared one, not a second copy of the
  // digest shape. It can only return `content-addressed` or `rejected` for a name
  // that already passed the shared safety sweep and the prefix test.
  const shared = classifyFullDeviceMemberName(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/${name}`);
  if (shared.kind === 'content-addressed') return shared;
  return { kind: 'rejected', reason: 'descriptive-member-name' };
}

function isDirectoryEntryName(path: string): boolean {
  return typeof path === 'string' && path.length > 1 && path.endsWith('/');
}

// ── The preview and the contents ───────────────────────────────────────────

/**
 * The sanitized view of a `.kdsubject`: everything a preview may show and a report
 * may carry, and nothing else.
 *
 * No subject name, room topic, note content, attachment filename, attachment URL,
 * or absolute path appears anywhere in this shape. `members` is a list of paths,
 * lengths, and digests, and `recordCounts` is a histogram.
 *
 * `externalOnlyAttachments` is the one entry that carries **identifiers**: an
 * `ExternalOnlyAttachmentReport` is `{attachmentId, subjectId, roomId, contentHash,
 * byteLength, reason, sourceType}`, and it has to be, because "this attachment's
 * bytes were not recovered" is a claim about a specific file in a specific room of a
 * specific subject and means nothing without them. It is the shape storage-v2's own
 * migration disclosure report already uses, for the same reason, so a consumer has
 * one thing to read rather than two.
 *
 * It is still not a subject summary: an id is not content, and a name, a topic, a
 * note, a path, or a count of rooms is still absent. An archive with no external-only
 * attachment discloses no identifier at all, which is why
 * {@link readSubjectArchive} cannot be used to learn which subject an archive holds.
 */
export interface SubjectArchivePreview {
  readonly product: DataProductKind;
  readonly formatVersion: number;
  readonly storageGenerationFormatVersion: number;
  readonly subjectSchemaVersion: string;
  readonly createdAt: string;
  readonly manifestCreatedAt: string;
  readonly memberCount: number;
  /** `memberCount + 1`: the declared members plus `manifest.json` itself. */
  readonly totalMemberCount: number;
  readonly totalBytes: number;
  readonly contentChecksum: string;
  readonly roomCount: number;
  readonly recordCounts: Readonly<Record<SubjectArchiveRecordCountKey, number>>;
  readonly attachmentBytes: { readonly memberCount: number; readonly byteLength: number };
  readonly memberNames: readonly string[];
  readonly members: readonly SubjectArchiveManifestMember[];
  readonly ignoredDirectoryEntries: readonly string[];
  readonly externalOnlyAttachments: readonly ExternalOnlyAttachmentReport[];
  readonly externalOnlyCount: number;
  readonly disclosedProblems: readonly ValidationProblem[];
  /** The policy that separated {@link disclosedProblems} from the refusals. */
  readonly blockingPolicy: MigrationBlockingPolicy;
}

/**
 * The importer's view of a `.kdsubject`: the preview **plus** the learner's own
 * bytes.
 *
 * This type carries subject names, topics, notes, filenames, and external URLs,
 * because that is what a subject backup is. It must never be rendered, logged,
 * attached to a bug report, or put in an error. The name says so.
 */
export interface SubjectArchiveContents {
  readonly preview: SubjectArchivePreview;
  /** The subject's id. An opaque identifier, not learner content. */
  readonly subjectId: string;
  /** `subject.json`'s record, verbatim. Learner data. */
  readonly subject: SubjectRecordValue;
  readonly progression: ProgressionRecordValue[];
  readonly sessions: SessionRecordValue[];
  readonly assistance: AssistanceRecordValue[];
  readonly attachmentMetadata: AttachmentMetadataRecordValue[];
  readonly attachmentBlobs: AttachmentBlobRecordValue[];
  /** Member bytes by path. Learner data. */
  readonly memberBytes: ReadonlyMap<string, Uint8Array>;
}

// ── Reading and validating an archive ─────────────────────────────────────

const encoder = new TextEncoder();

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isSemver(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function validationFailure(reason: string, details: Record<string, string | number | boolean> = {}): StorageV2Error {
  const problemCount = details.problemCount;
  if (typeof problemCount === 'number' && problemCount < 1) {
    // A refusal that counts zero problems is the Phase 5 D1 defect in a second
    // form, and the offending value is not interpolated: a throw that echoed it
    // would be the leak this detail rule exists to prevent.
    throw new TypeError(
      `validation refusal "${reason}" was asked to report a non-positive problem count.`,
    );
  }
  return new StorageV2Error('VALIDATION_FAILED', {
    reason,
    ...(problemCount === undefined ? {} : { policy: MIGRATION_BLOCKING_POLICY }),
    ...details,
  });
}

/**
 * Refuse an archive whose three version contracts this build cannot honour.
 *
 * Three separate refusals with separate reasons, because they fail for different
 * reasons and a caller that merged them would not know which contract it was
 * violating. The subject-schema refusal is the one that stops a *newer* backup
 * being silently restored into an older build and losing data.
 */
function assertSupportedVersions(
  formatVersion: number,
  storageGenerationFormatVersion: number,
  subjectSchemaVersion: string,
): void {
  if (formatVersion !== SUBJECT_ARCHIVE_FORMAT_VERSION) {
    throw validationFailure('unsupported-product-format-version', { field: 'formatVersion' });
  }
  if (storageGenerationFormatVersion !== STORAGE_V2_GENERATION_FORMAT_VERSION) {
    throw validationFailure('unsupported-storage-format-version', {
      field: 'storageGenerationFormatVersion',
    });
  }
  if (subjectSchemaVersion !== CANONICAL_SUBJECT_SCHEMA_VERSION) {
    throw validationFailure('unsupported-subject-schema-version', { field: 'subjectSchemaVersion' });
  }
}

/**
 * A closed key set, checked in both directions.
 *
 * An **unexpected** key is reported as a *count* and never by name. A key out of an
 * untrusted object is attacker-controlled, and the `StorageV2Error` constructor
 * refuses a detail that is not code-shaped - so naming one would turn a typed
 * refusal into a `TypeError`, which is the one way a malformed file escapes the
 * code/reason contract every other refusal obeys. The count says what a caller needs
 * and cannot leak. A **missing** key is named, because the list of names searched is
 * this product's own closed vocabulary and therefore always code-shaped.
 */
function closedKeyCheck(
  value: Record<string, unknown>,
  required: readonly string[],
  reasons: { readonly unexpected: string; readonly missing: string },
  field: string,
): void {
  const declared = Object.keys(value).sort();
  const unexpected = declared.filter((key) => !required.includes(key)).length;
  if (unexpected > 0) throw validationFailure(reasons.unexpected, { field, keyCount: unexpected });
  for (const key of required) {
    if (!declared.includes(key)) throw validationFailure(reasons.missing, { field });
  }
}

/**
 * A code-shaped token per fixed member, for use in a `StorageV2Error` detail.
 *
 * A member name cannot go in a detail: `isSanitizedDetailText` refuses anything
 * ending in `.` plus a short extension, and every member name here ends in `.json`.
 * So the vocabulary is declared once and the details use these instead.
 */
export const SUBJECT_ARCHIVE_FIELD_TOKENS: ReadonlyMap<string, string> = new Map([
  [SUBJECT_ARCHIVE_MANIFEST_MEMBER, 'manifest'],
  [SUBJECT_ARCHIVE_SUBJECT_MEMBER, 'subject'],
  [SUBJECT_ARCHIVE_PROGRESSION_MEMBER, 'progression'],
  [SUBJECT_ARCHIVE_SESSIONS_MEMBER, 'sessions'],
  [SUBJECT_ARCHIVE_ASSISTANCE_MEMBER, 'assistance'],
]);

function fieldToken(path: string): string {
  return SUBJECT_ARCHIVE_FIELD_TOKENS.get(path) ?? 'document';
}

function validateManifestShape(manifest: unknown): SubjectArchiveManifest {
  if (!isRecordObject(manifest)) throw validationFailure('manifest-wrong-type', { field: 'manifest' });
  closedKeyCheck(
    manifest,
    [...SUBJECT_ARCHIVE_MANIFEST_KEYS],
    { unexpected: 'manifest-unexpected-field', missing: 'manifest-missing-field' },
    'manifest',
  );

  if (manifest.product !== SUBJECT_PRODUCT) {
    throw validationFailure('unsupported-product', { field: 'product' });
  }
  if (!isInteger(manifest.formatVersion)) {
    throw validationFailure('manifest-invalid-field', { field: 'formatVersion' });
  }
  if (!isInteger(manifest.storageGenerationFormatVersion)) {
    throw validationFailure('manifest-invalid-field', { field: 'storageGenerationFormatVersion' });
  }
  if (!isSemver(manifest.subjectSchemaVersion)) {
    throw validationFailure('manifest-invalid-field', { field: 'subjectSchemaVersion' });
  }
  if (typeof manifest.createdAt !== 'string' || manifest.createdAt.length === 0) {
    throw validationFailure('manifest-invalid-field', { field: 'createdAt' });
  }
  if (!isInteger(manifest.memberCount) || !isInteger(manifest.totalBytes) || !isInteger(manifest.roomCount)) {
    throw validationFailure('manifest-invalid-field', { field: 'memberCount' });
  }
  if (typeof manifest.contentChecksum !== 'string' || !CONTENT_HASH_NAME.test(manifest.contentChecksum)) {
    throw validationFailure('manifest-invalid-field', { field: 'contentChecksum' });
  }
  if (!Array.isArray(manifest.members)) {
    throw validationFailure('manifest-invalid-field', { field: 'members' });
  }

  const memberKeys = [...SUBJECT_ARCHIVE_MANIFEST_MEMBER_KEYS];
  const members: SubjectArchiveManifestMember[] = [];
  manifest.members.forEach((entry, index) => {
    if (!isRecordObject(entry)) throw validationFailure('manifest-invalid-field', { field: 'members' });
    closedKeyCheck(
      entry,
      memberKeys,
      { unexpected: 'manifest-invalid-field', missing: 'manifest-invalid-field' },
      'members',
    );
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw validationFailure('manifest-invalid-field', { field: 'members', index });
    }
    if (!isInteger(entry.byteLength) || (entry.byteLength as number) < 0) {
      throw validationFailure('manifest-invalid-field', { field: 'members', index });
    }
    if (typeof entry.sha256 !== 'string' || !CONTENT_HASH_NAME.test(entry.sha256)) {
      throw validationFailure('manifest-invalid-field', { field: 'members', index });
    }
    members.push({ path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256 });
  });

  if (!isRecordObject(manifest.recordCounts)) {
    throw validationFailure('manifest-invalid-field', { field: 'recordCounts' });
  }
  closedKeyCheck(
    manifest.recordCounts,
    [...SUBJECT_ARCHIVE_RECORD_COUNT_KEYS],
    { unexpected: 'manifest-invalid-field', missing: 'manifest-invalid-field' },
    'recordCounts',
  );
  const recordCounts = {} as Record<SubjectArchiveRecordCountKey, number>;
  for (const key of SUBJECT_ARCHIVE_RECORD_COUNT_KEYS) {
    const value = manifest.recordCounts[key];
    if (!isInteger(value) || (value as number) < 0) {
      throw validationFailure('manifest-invalid-field', { field: 'recordCounts' });
    }
    recordCounts[key] = value;
  }

  if (!isRecordObject(manifest.attachmentBytes)) {
    throw validationFailure('manifest-invalid-field', { field: 'attachmentBytes' });
  }
  closedKeyCheck(
    manifest.attachmentBytes,
    [...SUBJECT_ARCHIVE_ATTACHMENT_BYTES_KEYS],
    { unexpected: 'manifest-invalid-field', missing: 'manifest-invalid-field' },
    'attachmentBytes',
  );
  if (
    !isInteger(manifest.attachmentBytes.memberCount) ||
    !isInteger(manifest.attachmentBytes.byteLength) ||
    (manifest.attachmentBytes.memberCount as number) < 0 ||
    (manifest.attachmentBytes.byteLength as number) < 0
  ) {
    throw validationFailure('manifest-invalid-field', { field: 'attachmentBytes' });
  }

  if (!isRecordObject(manifest.externalOnlyAttachments)) {
    throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
  }
  closedKeyCheck(
    manifest.externalOnlyAttachments,
    [...SUBJECT_ARCHIVE_EXTERNAL_ONLY_KEYS],
    { unexpected: 'manifest-invalid-field', missing: 'manifest-invalid-field' },
    'externalOnlyAttachments',
  );
  if (!isInteger(manifest.externalOnlyAttachments.count) || (manifest.externalOnlyAttachments.count as number) < 0) {
    throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
  }
  if (!isRecordObject(manifest.externalOnlyAttachments.reasons)) {
    throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
  }
  const reasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(manifest.externalOnlyAttachments.reasons)) {
    if (!/^[a-z][a-z0-9-]*$/.test(reason) || !isInteger(count) || (count as number) < 0) {
      throw validationFailure('manifest-invalid-field', { field: 'externalOnlyAttachments' });
    }
    reasons[reason] = count;
  }

  return {
    product: SUBJECT_PRODUCT,
    formatVersion: manifest.formatVersion,
    storageGenerationFormatVersion: manifest.storageGenerationFormatVersion,
    subjectSchemaVersion: manifest.subjectSchemaVersion,
    createdAt: manifest.createdAt,
    memberCount: manifest.memberCount,
    totalBytes: manifest.totalBytes,
    contentChecksum: manifest.contentChecksum,
    roomCount: manifest.roomCount,
    recordCounts,
    attachmentBytes: {
      memberCount: manifest.attachmentBytes.memberCount,
      byteLength: manifest.attachmentBytes.byteLength,
    },
    externalOnlyAttachments: { count: manifest.externalOnlyAttachments.count, reasons },
    members,
  };
}

function assertManifestCountsAgree(manifest: SubjectArchiveManifest): void {
  if (manifest.memberCount !== manifest.members.length) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const declaredBytes = manifest.members.reduce((total, member) => total + member.byteLength, 0);
  if (manifest.totalBytes !== declaredBytes) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const attachmentMembers = manifest.members.filter((member) =>
    member.path.startsWith(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`),
  );
  if (manifest.attachmentBytes.memberCount !== attachmentMembers.length) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const attachmentBytes = attachmentMembers.reduce((total, member) => total + member.byteLength, 0);
  if (manifest.attachmentBytes.byteLength !== attachmentBytes) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const declaredPaths = new Set(manifest.members.map((member) => member.path));
  if (declaredPaths.size !== manifest.members.length) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  if (manifest.roomCount < 0) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  for (const key of SUBJECT_ARCHIVE_RECORD_COUNT_KEYS) {
    if (manifest.recordCounts[key] < 0) {
      throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
    }
  }
}

function assertManifestContentChecksum(manifest: SubjectArchiveManifest): void {
  if (fullDeviceManifestContentChecksum(manifest.members) !== manifest.contentChecksum) {
    throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'manifest-content-checksum-mismatch' });
  }
}

function assertDeclaredNamesAreInLayout(manifest: SubjectArchiveManifest): void {
  for (const member of manifest.members) {
    const verdict = classifySubjectArchiveMemberName(member.path);
    if (verdict.kind === 'rejected' || verdict.kind === 'directory-entry') {
      throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'member-name-not-in-layout' });
    }
  }
}

function assertMemberSetsAgree(
  manifest: SubjectArchiveManifest,
  files: readonly ArchiveFile[],
): void {
  // `actual` is the archive's members *minus* `manifest.json`, which is exactly the
  // set the manifest describes: the plan's own counting rule is that `members[]`
  // omits the manifest, so comparing the two without the subtraction would report a
  // spurious extra member on every archive.
  //
  // The fixed members were already checked before the documents were read, so this
  // function is only about the two sets agreeing - declared and actual - in both
  // directions. One copy of that rule, not two.
  const actual = new Set(files.map((file) => file.path));
  actual.delete(SUBJECT_ARCHIVE_MANIFEST_MEMBER);
  const declared = new Set(manifest.members.map((member) => member.path));
  for (const member of manifest.members) {
    if (!actual.has(member.path)) {
      throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'missing-declared-member' });
    }
  }
  for (const path of actual) {
    if (!declared.has(path)) {
      throw new StorageV2Error('ARCHIVE_MALFORMED', { reason: 'unexpected-member' });
    }
  }
}

function assertMemberChecksums(
  manifest: SubjectArchiveManifest,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): void {
  for (const member of manifest.members) {
    const bytes = bytesByPath.get(member.path) as Uint8Array;
    if (bytes.length !== member.byteLength) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'member-checksum-mismatch' });
    }
    if (sha256Hex(bytes) !== member.sha256) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'member-checksum-mismatch' });
    }
    if (member.path.startsWith(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`)) {
      if (member.path.slice(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`.length) !== member.sha256) {
        throw new StorageV2Error('CHECKSUM_MISMATCH', { reason: 'member-checksum-mismatch' });
      }
    }
  }
}

/**
 * Run the application's own per-record validators over the archive's records.
 *
 * Reuse rather than reimplement: a record the storage-v2 repository would refuse to
 * activate must be refused here too, or the preview would promise an import the
 * product cannot deliver.
 *
 * A `warning` is a **disclosure, not a refusal**, and the refusal decision is
 * `MIGRATION_BLOCKING_POLICY` applied through `isActivationBlocking` - the *same*
 * single policy the import gates on. Refusing on the total problem count made the
 * `.kdbak` reader stricter than the importer it feeds; this reader is the importer's
 * peer and is gated the same way.
 *
 * The `try`/`catch` around each record is a hardening this reader adds over the
 * `.kdbak` reader, and it is worth being explicit about why. A per-record validator
 * can throw on a payload this build cannot normalize, and a learner's own file
 * should not be able to produce an untyped exception - an untyped throw is a
 * refusal the caller cannot classify, and it is the one way a malformed file
 * escapes the code/reason contract every other refusal obeys. So an unexpected
 * throw becomes a blocking `unexpected-json-shape` problem for that record, which
 * is reported, counted, and refused through the same policy as everything else.
 */
function validateRecords(
  contents: { subject: SubjectRecordValue; progression: readonly ProgressionRecordValue[]; sessions: readonly SessionRecordValue[]; assistance: readonly AssistanceRecordValue[]; attachmentMetadata: readonly AttachmentMetadataRecordValue[] },
): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const run = <T>(
    values: readonly T[],
    scope: ValidationScope,
    validate: (value: T) => { problems: ValidationProblem[] },
  ): void => {
    for (const value of values) {
      if (!isRecordObject(value)) {
        problems.push({ code: 'not-an-object', scope, count: 1, severity: 'error' });
        continue;
      }
      try {
        problems.push(...validate(value).problems);
      } catch {
        problems.push({ code: 'unexpected-json-shape', scope, count: 1, severity: 'error' });
      }
    }
  };

  run([contents.subject], 'subject', validateSubjectRecord);
  run(contents.progression, 'progression', validateProgressionRecord);
  run(contents.sessions, 'session', validateSessionRecord);
  run(contents.assistance, 'assistance', validateAssistanceRecord);
  run(contents.attachmentMetadata, 'attachment', validateAttachmentMetadataRecord);

  const { blocking, disclosed } = partitionMigrationProblems(problems);
  if (blocking.length > 0) {
    throw validationFailure('state-record-invalid', { problemCount: countBlockingProblems(problems) });
  }
  return disclosed;
}

/**
 * The subject's own internal references, disclosed rather than refused.
 *
 * This is the one product rule that has no `validateSubjectSnapshot` equivalent,
 * and the reason is specific rather than general: storage-v2 validates a subject's
 * *edges* (a dangling edge is a blocking `relationship` error) but treats every
 * deeper finding as a `warning`, because the importer accepts shallow payloads and
 * must not refuse a subject the learner can currently open. For a `.kdsubject` that
 * is the wrong trade, because copy mode has to **rewrite** these references: a room
 * whose `rooms` key disagrees with its own `roomId`, or a `tagIndex` entry naming
 * a room that was deleted, cannot be made internally consistent by remapping, and
 * the copy inherits the source's inconsistency either way.
 *
 * So these are checked, counted, and **disclosed** - never a refusal. Refusing would
 * make a real subject un-backable, and silently "fixing" it would change the
 * learner's data during a backup, which is worse than either. `rootRoomId` is the
 * same: a subject with rooms but no resolvable root is broken already, and a backup
 * product does not get to decide that is grounds to refuse a file.
 */
function collectSubjectStructureFindings(subject: SubjectRecordValue): readonly ValidationProblem[] {
  const snapshot = subject.snapshot as unknown as Record<string, unknown>;
  const rooms = isRecordObject(snapshot.rooms) ? snapshot.rooms : {};
  const dungeon = isRecordObject(snapshot.dungeon) ? snapshot.dungeon : {};
  const roomIds = new Set(Object.keys(rooms));
  let mismatched = 0;
  let dangling = 0;

  for (const [roomId, room] of Object.entries(rooms)) {
    if (!isRecordObject(room)) continue;
    if (room.roomId !== roomId) mismatched += 1;
  }
  if (roomIds.size > 0) {
    if (typeof dungeon.rootRoomId !== 'string' || !roomIds.has(dungeon.rootRoomId)) dangling += 1;
    if (Array.isArray(dungeon.edges)) {
      for (const edge of dungeon.edges) {
        if (!isRecordObject(edge)) continue;
        if (typeof edge.fromRoomId !== 'string' || !roomIds.has(edge.fromRoomId)) dangling += 1;
        if (typeof edge.toRoomId !== 'string' || !roomIds.has(edge.toRoomId)) dangling += 1;
      }
    }
    if (isRecordObject(dungeon.tagIndex)) {
      for (const roomIdsForTag of Object.values(dungeon.tagIndex)) {
        if (!Array.isArray(roomIdsForTag)) continue;
        for (const entry of roomIdsForTag) {
          if (typeof entry !== 'string' || !roomIds.has(entry)) dangling += 1;
        }
      }
    }
  }

  const problems: ValidationProblem[] = [];
  if (mismatched > 0) {
    problems.push({ code: 'unknown-room-reference', scope: 'subject', count: mismatched, severity: 'warning' });
  }
  if (dangling > 0) {
    problems.push({ code: 'unknown-room-reference', scope: 'subject', count: dangling, severity: 'warning' });
  }
  return problems;
}

/** Records that name a subject the archive's own `subject.json` does not declare. */
function collectCrossSubjectFindings(
  declaredSubjectId: string,
  progression: readonly ProgressionRecordValue[],
  sessions: readonly SessionRecordValue[],
  attachmentMetadata: readonly AttachmentMetadataRecordValue[],
): readonly ValidationProblem[] {
  let progressions = 0;
  let sessionCount = 0;
  let attachments = 0;
  for (const record of progression) if (record.subjectId !== declaredSubjectId) progressions += 1;
  for (const record of sessions) if (record.subjectId !== declaredSubjectId) sessionCount += 1;
  for (const record of attachmentMetadata) if (record.subjectId !== declaredSubjectId) attachments += 1;

  const problems: ValidationProblem[] = [];
  if (progressions > 0) {
    problems.push({ code: 'unknown-subject-reference', scope: 'relationship', count: progressions, severity: 'warning' });
  }
  if (sessionCount > 0) {
    problems.push({ code: 'unknown-subject-reference', scope: 'relationship', count: sessionCount, severity: 'warning' });
  }
  if (attachments > 0) {
    problems.push({ code: 'unknown-subject-reference', scope: 'relationship', count: attachments, severity: 'warning' });
  }
  return problems;
}

function assertDeclaredRecordCounts(
  manifest: SubjectArchiveManifest,
  built: {
    readonly subject: SubjectRecordValue;
    readonly progression: readonly ProgressionRecordValue[];
    readonly sessions: readonly SessionRecordValue[];
    readonly assistance: readonly AssistanceRecordValue[];
    readonly attachmentMetadata: readonly AttachmentMetadataRecordValue[];
    readonly attachmentBlobs: readonly AttachmentBlobRecordValue[];
  },
): void {
  const actual: Record<SubjectArchiveRecordCountKey, number> = {
    subjects: 1,
    progression: built.progression.length,
    sessions: built.sessions.length,
    assistance: built.assistance.length,
    attachments: built.attachmentMetadata.length,
    attachmentBlobs: built.attachmentBlobs.length,
  };
  for (const key of SUBJECT_ARCHIVE_RECORD_COUNT_KEYS) {
    if (manifest.recordCounts[key] !== actual[key]) {
      throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
    }
  }
  const snapshot = built.subject.snapshot as unknown as Record<string, unknown>;
  const roomCount = isRecordObject(snapshot.rooms) ? Object.keys(snapshot.rooms).length : 0;
  if (manifest.roomCount !== roomCount) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
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
 * The archive's own disclosure set, read out of the attachment metadata.
 *
 * Every entry has `contentHash: null` and `byteLength: null`. An attachment whose
 * bytes are not in the archive has no content to hash and no length to report, and
 * a fabricated digest would misreport what the backup contains (plan section 2.3).
 * The sub-document in the manifest carries only a count and a reason histogram
 * precisely so the *ids* live here, on the importer's side.
 */
function disclosureSet(
  metadata: readonly AttachmentMetadataRecordValue[],
  manifest: SubjectArchiveManifest,
  availableContentHashes: ReadonlySet<string>,
): ExternalOnlyAttachmentReport[] {
  const disclosures: ExternalOnlyAttachmentReport[] = [];
  for (const record of metadata) {
    const storedBytesPresent =
      record.availability === 'stored' &&
      typeof record.contentHash === 'string' &&
      availableContentHashes.has(record.contentHash);
    if (storedBytesPresent) continue;
    disclosures.push(disclosureFor(record, fullDeviceExternalOnlyReason(record)));
  }
  if (disclosures.length !== manifest.externalOnlyAttachments.count) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  const histogram: Record<string, number> = {};
  for (const disclosure of disclosures) {
    histogram[disclosure.reason] = (histogram[disclosure.reason] ?? 0) + 1;
  }
  const declaredReasons = manifest.externalOnlyAttachments.reasons;
  if (canonicalJsonStringify(histogram) !== canonicalJsonStringify(declaredReasons)) {
    throw new StorageV2Error('COUNT_MISMATCH', { reason: 'manifest-counts-disagree' });
  }
  return disclosures;
}

/**
 * Decode one fixed member as a JSON object.
 *
 * The parameter is called `files` and the result `section`, never `document`: a local
 * named `document` inside a module whose entire claim is that it never touches the DOM
 * is a latent hazard rather than a style question, and this gate checks for it.
 */
function readDocument(files: readonly ArchiveFile[], path: string): Record<string, unknown> {
  const value = decodeArchiveJsonMember(files, path);
  if (!isRecordObject(value)) {
    throw validationFailure('document-wrong-shape', { field: fieldToken(path) });
  }
  return value;
}

/**
 * Read the three version contracts a document carries, and hold them to the
 * manifest's.
 *
 * Each of the three is refused on its own, and each document's copy must equal the
 * manifest's. A file whose `subject.json` claims a newer subject schema than its own
 * `manifest.json` is not an archive with a stale member, it is an archive whose
 * declared contract is not a contract.
 */
function readVersionContracts(
  section: Record<string, unknown>,
  manifest: SubjectArchiveManifest,
): void {
  for (const key of SUBJECT_ARCHIVE_VERSION_KEYS) {
    if (!(key in section)) throw validationFailure('document-wrong-shape', { field: key });
  }
  if (!isInteger(section.formatVersion)) {
    throw validationFailure('document-wrong-shape', { field: 'formatVersion' });
  }
  if (!isInteger(section.storageGenerationFormatVersion)) {
    throw validationFailure('document-wrong-shape', { field: 'storageGenerationFormatVersion' });
  }
  if (!isSemver(section.subjectSchemaVersion)) {
    throw validationFailure('document-wrong-shape', { field: 'subjectSchemaVersion' });
  }
  if (typeof section.createdAt !== 'string' || section.createdAt.length === 0) {
    throw validationFailure('document-wrong-shape', { field: 'createdAt' });
  }
  assertSupportedVersions(
    section.formatVersion,
    section.storageGenerationFormatVersion,
    section.subjectSchemaVersion,
  );
  if (
    section.formatVersion !== manifest.formatVersion ||
    section.storageGenerationFormatVersion !== manifest.storageGenerationFormatVersion ||
    section.subjectSchemaVersion !== manifest.subjectSchemaVersion
  ) {
    throw new StorageV2Error('VALIDATION_FAILED', { reason: 'version-contracts-disagree' });
  }
}

/**
 * Read and validate a `.kdsubject`, and touch no stored data.
 *
 * Synchronous on purpose: everything it needs is in the bytes, so a caller can use
 * it inside a `FileReader` callback or an `onchange` handler without introducing a
 * pending state, and a failure is a typed throw rather than a promise that has to be
 * awaited before the learner can be told anything.
 *
 * The order of the checks is the order a person would use: open the manifest, open
 * the four documents, and only then ask whether every byte in the file is what the
 * manifest says it is. A file whose `subject.json` has been mangled is told the
 * subject is unreadable, not that a digest disagrees - and a file whose subject is
 * unreadable is corrupt either way.
 */
export function readSubjectArchiveContents(bytes: Uint8Array): SubjectArchiveContents {
  // ── 1. Structure ──
  // Every layout-independent check is the shared sequence, so a second product
  // cannot forget one of them; the only product-supplied part is the
  // directory-entry predicate, which is this layout's single prefix.
  const { files, ignoredDirectoryEntries } = readAndVetArchiveMembers(bytes, (name) => {
    return name === `${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`;
  });

  const bytesByPath = new Map<string, Uint8Array>();
  for (const file of files) bytesByPath.set(file.path, file.bytes);

  // ── 2. The manifest and the four fixed documents ──
  if (!bytesByPath.has(SUBJECT_ARCHIVE_MANIFEST_MEMBER)) {
    throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'no-manifest' });
  }
  const manifest = validateManifestShape(
    decodeArchiveJsonMember(files, SUBJECT_ARCHIVE_MANIFEST_MEMBER),
  );
  assertSupportedVersions(
    manifest.formatVersion,
    manifest.storageGenerationFormatVersion,
    manifest.subjectSchemaVersion,
  );

  // The fixed members are checked **before** the four documents are read, so a
  // missing one is reported with this product's own reason rather than by the codec
  // noticing it could not find a member it was asked for. The plan names five
  // members; an archive with four of them is a different product, and saying so is
  // more useful than "the member I went looking for is absent".
  for (const required of SUBJECT_ARCHIVE_FIXED_MEMBERS) {
    if (!bytesByPath.has(required)) {
      throw new StorageV2Error('ARCHIVE_MEMBER_MISSING', { reason: 'missing-fixed-member' });
    }
  }

  const subjectDocument = readDocument(files, SUBJECT_ARCHIVE_SUBJECT_MEMBER);
  closedKeyCheck(
    subjectDocument,
    [...SUBJECT_ARCHIVE_SUBJECT_DOCUMENT_KEYS],
    { unexpected: 'document-unexpected-field', missing: 'document-missing-field' },
    fieldToken(SUBJECT_ARCHIVE_SUBJECT_MEMBER),
  );
  readVersionContracts(subjectDocument, manifest);
  if (typeof subjectDocument.sourceGenerationId !== 'string') {
    throw validationFailure('document-wrong-shape', { field: 'sourceGenerationId' });
  }
  const subject = subjectDocument.subject;
  if (!isRecordObject(subject)) {
    throw validationFailure('document-wrong-shape', { field: 'subject' });
  }
  if (typeof subject.subjectId !== 'string' || subject.subjectId.length === 0) {
    throw validationFailure('document-wrong-shape', { field: 'subjectId' });
  }
  const subjectId = subject.subjectId;

  const readList = <T>(path: string, payloadKey: string): T[] => {
    const section = readDocument(files, path);
    closedKeyCheck(
      section,
      [...SUBJECT_ARCHIVE_LIST_DOCUMENT_KEYS, payloadKey],
      { unexpected: 'document-unexpected-field', missing: 'document-missing-field' },
      fieldToken(path),
    );
    readVersionContracts(section, manifest);
    if (section.subjectId !== subjectId) {
      // Each document names the subject it belongs to, and they must all be the
      // same subject. A `.kdsubject` that mixes two subjects is not a subject
      // backup, and refusing it here is what keeps a merge from attributing one
      // subject's sessions to another's progression record.
      throw new StorageV2Error('VALIDATION_FAILED', { reason: 'document-subject-disagrees' });
    }
    const payload = section[payloadKey];
    if (!Array.isArray(payload)) {
      throw validationFailure('document-wrong-shape', { field: payloadKey });
    }
    return payload as T[];
  };

  const progression = readList<ProgressionRecordValue>(
    SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
    SUBJECT_ARCHIVE_LIST_PAYLOAD_KEYS[SUBJECT_ARCHIVE_PROGRESSION_MEMBER],
  );
  const sessions = readList<SessionRecordValue>(
    SUBJECT_ARCHIVE_SESSIONS_MEMBER,
    SUBJECT_ARCHIVE_LIST_PAYLOAD_KEYS[SUBJECT_ARCHIVE_SESSIONS_MEMBER],
  );
  const assistance = readList<AssistanceRecordValue>(
    SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
    SUBJECT_ARCHIVE_LIST_PAYLOAD_KEYS[SUBJECT_ARCHIVE_ASSISTANCE_MEMBER],
  );

  // ── 3. Attachment metadata and the bytes this archive actually carries ──
  const attachmentMetadata = readAttachmentMetadata(files);
  const attachmentBlobs: AttachmentBlobRecordValue[] = [];
  for (const record of [...attachmentMetadata]) {
    const declaredHash =
      record.availability === 'stored' && typeof record.contentHash === 'string'
        ? record.contentHash
        : null;
    const memberPath =
      declaredHash === null ? undefined : `${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/${declaredHash}`;
    const bytes = memberPath === undefined ? undefined : bytesByPath.get(memberPath);
    if (declaredHash === null || bytes === undefined) {
      // Plan section 2.3: an attachment whose bytes are not in the archive is
      // disclosed, keeps no hash, and does not fail the import. Storage-v2's own
      // relationship rule requires the two halves to agree - `stored` without a
      // blob is an error - so the record is restored as what it really is.
      const restored: AttachmentMetadataRecordValue = {
        ...record,
        availability: 'external-only',
        contentHash: null,
      };
      attachmentMetadata.splice(attachmentMetadata.indexOf(record), 1, restored);
      continue;
    }
    attachmentBlobs.push({
      attachmentId: record.attachmentId,
      contentHash: declaredHash,
      bytes: bytes.slice().buffer as ArrayBuffer,
      byteLength: bytes.byteLength,
      // `storedAt` is a fact about the device the copy is written to, so the
      // importer re-stamps it with its own clock. The archive's own creation time is
      // the honest placeholder for the value the reader returns.
      storedAt: manifest.createdAt,
    });
  }

  // ── 4. The manifest's claims about the rest of the file ──
  assertManifestCountsAgree(manifest);
  assertDeclaredNamesAreInLayout(manifest);
  assertManifestContentChecksum(manifest);
  assertMemberSetsAgree(manifest, files);
  assertMemberChecksums(manifest, bytesByPath);
  assertDeclaredRecordCounts(manifest, {
    subject: subject as unknown as SubjectRecordValue,
    progression,
    sessions,
    assistance,
    attachmentMetadata,
    attachmentBlobs,
  });

  const availableContentHashes = new Set(
    manifest.members
      .filter((member) => member.path.startsWith(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`))
      .map((member) => member.path.slice(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`.length)),
  );
  const disclosures = disclosureSet(attachmentMetadata, manifest, availableContentHashes);

  // ── 5. Record validation, and the product's own structural disclosures ──
  const disclosed = [
    ...validateRecords({ subject: subject as unknown as SubjectRecordValue, progression, sessions, assistance, attachmentMetadata }),
    ...collectSubjectStructureFindings(subject as unknown as SubjectRecordValue),
    ...collectCrossSubjectFindings(subjectId, progression, sessions, attachmentMetadata),
  ];

  return {
    preview: {
      product: manifest.product,
      formatVersion: manifest.formatVersion,
      storageGenerationFormatVersion: manifest.storageGenerationFormatVersion,
      subjectSchemaVersion: manifest.subjectSchemaVersion,
      createdAt: subjectDocument.createdAt as string,
      manifestCreatedAt: manifest.createdAt,
      memberCount: manifest.memberCount,
      totalMemberCount: manifest.memberCount + 1,
      totalBytes: manifest.totalBytes,
      contentChecksum: manifest.contentChecksum,
      roomCount: manifest.roomCount,
      recordCounts: manifest.recordCounts,
      attachmentBytes: manifest.attachmentBytes,
      memberNames: manifest.members.map((member) => member.path),
      members: manifest.members,
      ignoredDirectoryEntries: [...ignoredDirectoryEntries].sort(),
      externalOnlyAttachments: disclosures,
      externalOnlyCount: manifest.externalOnlyAttachments.count,
      disclosedProblems: disclosed,
      blockingPolicy: MIGRATION_BLOCKING_POLICY,
    },
    subjectId,
    subject: subject as unknown as SubjectRecordValue,
    progression,
    sessions,
    assistance,
    attachmentMetadata,
    attachmentBlobs,
    memberBytes: bytesByPath,
  };
}

/**
 * The attachment metadata records a `.kdsubject` carries.
 *
 * The plan's layout has no `attachments.json`, so the metadata rides inside
 * `subject.json` alongside the subject record, under its own key. That is the one
 * place the layout had to be read rather than invented: adding a sixth JSON member
 * would be a layout change, and dropping the metadata would make a stored
 * attachment's bytes unreferenced.
 */
function readAttachmentMetadata(files: readonly ArchiveFile[]): AttachmentMetadataRecordValue[] {
  const section = readDocument(files, SUBJECT_ARCHIVE_SUBJECT_MEMBER);
  if (!('attachmentMetadata' in section)) {
    throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
  }
  const payload = section.attachmentMetadata;
  if (!Array.isArray(payload)) {
    throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
  }
  const records: AttachmentMetadataRecordValue[] = [];
  for (const entry of payload) {
    if (!isRecordObject(entry)) {
      throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
    }
    if (typeof entry.attachmentId !== 'string' || entry.attachmentId.length === 0) {
      throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
    }
    if (typeof entry.subjectId !== 'string' || entry.subjectId.length === 0) {
      throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
    }
    if (typeof entry.roomId !== 'string' || entry.roomId.length === 0) {
      throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
    }
    if (typeof entry.addedAt !== 'string' || entry.addedAt.length === 0) {
      throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
    }
    if (entry.sourceType !== 'local' && entry.sourceType !== 'external') {
      throw validationFailure('document-wrong-shape', { field: 'attachmentMetadata' });
    }
    records.push(entry as unknown as AttachmentMetadataRecordValue);
  }
  return records;
}

/**
 * Read and validate a `.kdsubject` and return only what a preview may show.
 *
 * The Data Center calls this before a learner commits to anything, and it is the
 * only read path a UI needs: it touches no stored data, opens no database, and
 * returns counts, versions, digests, member names, and the disclosure set.
 *
 * It does not name the subject the archive holds, and that is deliberate - a preview
 * that named a subject would put a subject on a screen before the learner decided
 * anything, and a rejected archive's subject id would reach a report. The **one**
 * exception, and it is a consequence of the disclosure shape rather than a choice:
 * an archive with an external-only attachment discloses an
 * {@link ExternalOnlyAttachmentReport}, which carries that attachment's `subjectId`
 * and `roomId`. That is the exported subject's own id, it appears only when the
 * archive has an attachment whose bytes were not recovered, and it is a disclosure
 * a learner needs to understand rather than something a preview can avoid. A caller
 * that must never see an identifier at all must screen
 * `preview.externalOnlyAttachments` itself.
 */
export function readSubjectArchive(bytes: Uint8Array): SubjectArchivePreview {
  return readSubjectArchiveContents(bytes).preview;
}

/** A preview outcome that cannot throw, for a UI that renders the failure. */
export type SubjectArchiveInspection =
  | { readonly ok: true; readonly preview: SubjectArchivePreview }
  | { readonly ok: false; readonly error: ReturnType<StorageV2Error['toReport']> };

/**
 * {@link readSubjectArchive} as a result rather than a throw.
 *
 * A preview is the one place where a failure is an expected outcome rather than an
 * exception, so this returns the same sanitized report the typed error carries and
 * never re-throws.
 */
export function inspectSubjectArchive(bytes: Uint8Array): SubjectArchiveInspection {
  try {
    return { ok: true, preview: readSubjectArchive(bytes) };
  } catch (error) {
    if (error instanceof StorageV2Error) return { ok: false, error: error.toReport() };
    return {
      ok: false,
      error: { code: 'ARCHIVE_MALFORMED' as const, details: { reason: 'unreadable' } },
    };
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

export interface SubjectExportRequest {
  /** The generation to read. Nothing is written, so this is a pure read. */
  readonly repository: StorageV2Repository;
  readonly generationId: string;
  /** The subject to export. An opaque identifier, never a name. */
  readonly subjectId: string;
  /** Injected clock. An export under a fixed clock is byte-deterministic. */
  readonly now: string;
  /**
   * Real payload bytes per attachment id, resolved by the caller from the
   * device-local attachment store. Optional: an export without it still works,
   * falling back to the generation's mirrored blob records and disclosing whatever
   * is still missing.
   */
  readonly payloadBytes?: ReadonlyMap<string, Uint8Array>;
}

export interface SubjectExportResult {
  /** The `.kdsubject`. The caller decides what to do with it. */
  readonly bytes: Uint8Array;
  /** The manifest exactly as it was written into the archive. */
  readonly manifest: SubjectArchiveManifest;
  /** Member paths in write order, including `manifest.json`. */
  readonly memberNames: readonly string[];
  /** A content-free file name for the download. */
  readonly fileName: string;
  /** Attachments whose bytes were not available, with no fabricated hash. */
  readonly externalOnlyAttachments: readonly ExternalOnlyAttachmentReport[];
  /** The subject id that was exported. An opaque identifier. */
  readonly subjectId: string;
}

function sortedValues<T>(envelopes: readonly { recordId: string; value: T }[]): T[] {
  // Sorted by the record id the repository derives, so the document's order is a
  // function of the data rather than of an IndexedDB cursor. A fixed clock and a
  // fixed generation therefore produce fixed bytes.
  return [...envelopes]
    .sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0))
    .map((envelope) => envelope.value);
}

function emptyRecordCounts(): Record<SubjectArchiveRecordCountKey, number> {
  return {
    subjects: 0,
    progression: 0,
    sessions: 0,
    assistance: 0,
    attachments: 0,
    attachmentBlobs: 0,
  };
}

/**
 * Produce a `.kdsubject` from one subject in one generation.
 *
 * Reads and never writes: the result is a pure function of (the generation's
 * contents, the subject id, `now`, `payloadBytes`).
 *
 * The records carried are the subject's **associated learner state** and nothing
 * else: its progression record (which is where the fish live, under
 * `bySubject[subjectId].fishCollection`), its sessions, the assistance records the
 * generation holds, and its attachment metadata plus whatever bytes are recoverable.
 * No preferences, no shortcuts, no custom sprites, no recovery records, no
 * migration receipts, and no other subject - the plan's non-goals, enforced by
 * construction rather than by a filter that could be forgotten.
 */
export async function exportSubjectBackup(
  request: SubjectExportRequest,
): Promise<SubjectExportResult> {
  const { repository, generationId, subjectId, now } = request;
  const snapshot: GenerationSnapshot = await repository.readRecords(generationId);
  const records = snapshot.records;

  const subjectEnvelope = records.subjects.find((entry) => entry.value.subjectId === subjectId);
  if (subjectEnvelope === undefined) {
    throw new StorageV2Error('RECORD_NOT_FOUND', { field: 'subjectId' });
  }
  const subject = subjectEnvelope.value;

  const progression = sortedValues(
    records.progression.filter((entry) => entry.value.subjectId === subjectId),
  );
  const sessions = sortedValues(
    records.sessions.filter((entry) => entry.value.subjectId === subjectId),
  );
  // Assistance records are not subject-keyed in the schema, and the plan's
  // `.kdsubject` layout lists `assistance.json`, so the generation's records are
  // carried and the manifest discloses the count. A copy mints fresh identifiers
  // for them, so the destination's own assistance record is never overwritten; a
  // replace preserves identifiers, and the result says how many records that
  // replaced.
  const assistance = sortedValues(records.assistance);

  const attachmentMetadata = sortedValues(
    records.attachmentMetadata.filter((entry) => entry.value.subjectId === subjectId),
  );

  // ── Attachment bytes ──
  // The resolution order is the `.kdbak` product's, for the same reason: the bytes
  // live in the device-local attachment store, which is the one that survives a
  // repository rollback, so the caller's map is tried first, the generation's own
  // mirrored blob second, and anything still missing is **disclosed** with no
  // fabricated hash rather than failing the export.
  const payloadBytes = request.payloadBytes ?? new Map<string, Uint8Array>();
  const blobByAttachment = new Map(
    records.attachmentBlobs.map((entry) => [entry.value.attachmentId, entry.value]),
  );
  const attachmentMembers = new Map<string, Uint8Array>();
  const exportedMetadata: AttachmentMetadataRecordValue[] = [];
  const externalOnly: ExternalOnlyAttachmentReport[] = [];
  let blobCount = 0;

  for (const metadata of attachmentMetadata) {
    if (metadata.availability !== 'stored' || metadata.contentHash === null) {
      externalOnly.push(disclosureFor(metadata, fullDeviceExternalOnlyReason(metadata)));
      exportedMetadata.push(metadata);
      continue;
    }
    const supplied = payloadBytes.get(metadata.attachmentId);
    const mirrored = blobByAttachment.get(metadata.attachmentId);
    const bytes =
      supplied ?? (mirrored === undefined ? undefined : new Uint8Array(mirrored.bytes));
    const contentHash = bytes === undefined || bytes.byteLength === 0 ? null : sha256Hex(bytes);
    if (contentHash === null || contentHash !== metadata.contentHash) {
      // Either there are no bytes anywhere on this device, or the bytes that are
      // there are not the bytes this record says they are. Both are disclosed, and
      // neither makes the export fail: an unreachable or inconsistent image must
      // not make a backup impossible.
      externalOnly.push(disclosureFor(metadata, fullDeviceExternalOnlyReason(metadata)));
      exportedMetadata.push({ ...metadata, availability: 'external-only', contentHash: null });
      continue;
    }
    // Content addressing is the plan's contract, so the member is named by the
    // digest of the bytes it actually carries. Two attachments with identical bytes
    // therefore collapse onto one member.
    if (!attachmentMembers.has(contentHash)) attachmentMembers.set(contentHash, bytes as Uint8Array);
    exportedMetadata.push(metadata);
    blobCount += 1;
  }

  // ── The four documents ──
  const versions = {
    formatVersion: SUBJECT_ARCHIVE_FORMAT_VERSION,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion:
      snapshot.descriptor?.subjectSchemaVersion ?? CANONICAL_SUBJECT_SCHEMA_VERSION,
  };
  const subjectDocument = {
    ...versions,
    createdAt: now,
    // The generation label the source device used. An opaque identifier, not
    // learner content, and reported rather than adopted: a subject import mints its
    // own label, so nothing on the destination is named by the archive.
    sourceGenerationId: generationId,
    subject,
    attachmentMetadata: exportedMetadata,
  };
  const listHeader = (): Record<string, unknown> => ({ ...versions, createdAt: now, subjectId });

  const snapshotValue = subject.snapshot as unknown as Record<string, unknown>;
  const roomCount = isRecordObject(snapshotValue.rooms) ? Object.keys(snapshotValue.rooms).length : 0;

  // ── Members ──
  // One `mtime`, from the injected clock, for every member. fflate stamps each
  // entry from the wall clock otherwise, at two-second resolution, so two exports
  // seconds apart would differ in a handful of header bytes while every member was
  // identical.
  const mtime = archiveMemberTimeFrom(now);
  const files: ArchiveFile[] = [
    { path: SUBJECT_ARCHIVE_SUBJECT_MEMBER, bytes: encoder.encode(canonicalJsonStringify(subjectDocument)), mtime },
    {
      path: SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
      bytes: encoder.encode(canonicalJsonStringify({ ...listHeader(), progression })),
      mtime,
    },
    {
      path: SUBJECT_ARCHIVE_SESSIONS_MEMBER,
      bytes: encoder.encode(canonicalJsonStringify({ ...listHeader(), sessions })),
      mtime,
    },
    {
      path: SUBJECT_ARCHIVE_ASSISTANCE_MEMBER,
      bytes: encoder.encode(canonicalJsonStringify({ ...listHeader(), assistance })),
      mtime,
    },
  ];
  for (const [contentHash, bytes] of attachmentMembers) {
    files.push({ path: `${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/${contentHash}`, bytes, mtime });
  }

  const memberEntries: SubjectArchiveManifestMember[] = files.map((file) => ({
    path: file.path,
    byteLength: file.bytes.byteLength,
    sha256: sha256Hex(file.bytes),
  }));
  const attachmentEntries = memberEntries.filter((entry) =>
    entry.path.startsWith(`${SUBJECT_ARCHIVE_ATTACHMENT_PREFIX}/`),
  );
  const recordCounts = emptyRecordCounts();
  recordCounts.subjects = 1;
  recordCounts.progression = progression.length;
  recordCounts.sessions = sessions.length;
  recordCounts.assistance = assistance.length;
  recordCounts.attachments = exportedMetadata.length;
  recordCounts.attachmentBlobs = blobCount;

  const reasonHistogram: Record<string, number> = {};
  for (const disclosure of externalOnly) {
    reasonHistogram[disclosure.reason] = (reasonHistogram[disclosure.reason] ?? 0) + 1;
  }

  const manifest: SubjectArchiveManifest = {
    product: SUBJECT_PRODUCT,
    formatVersion: versions.formatVersion,
    storageGenerationFormatVersion: versions.storageGenerationFormatVersion,
    subjectSchemaVersion: versions.subjectSchemaVersion,
    createdAt: now,
    memberCount: memberEntries.length,
    totalBytes: memberEntries.reduce((total, entry) => total + entry.byteLength, 0),
    contentChecksum: fullDeviceManifestContentChecksum(memberEntries),
    roomCount,
    recordCounts,
    attachmentBytes: {
      memberCount: attachmentEntries.length,
      byteLength: attachmentEntries.reduce((total, entry) => total + entry.byteLength, 0),
    },
    externalOnlyAttachments: { count: externalOnly.length, reasons: reasonHistogram },
    members: memberEntries,
  };

  files.unshift({
    path: SUBJECT_ARCHIVE_MANIFEST_MEMBER,
    bytes: encoder.encode(canonicalJsonStringify(manifest)),
    mtime,
  });

  return {
    bytes: writeArchive(files),
    manifest,
    memberNames: files.map((file) => file.path),
    fileName: SUBJECT_BACKUP_FILE_NAME,
    externalOnlyAttachments: externalOnly,
    subjectId,
  };
}

// ── Import ─────────────────────────────────────────────────────────────────

/**
 * The two import modes, and which one is the default.
 *
 * Plan section 7.3: "The default import mode is **Create copy**". So the request's
 * `mode` is optional and its absence means `copy`, and there is no way for an import
 * to be destructive without the caller having said `replace` *and* confirmed it.
 */
export type SubjectImportMode = 'copy' | 'replace';

export interface SubjectImportRequest {
  readonly repository: StorageV2Repository;
  readonly bytes: Uint8Array;
  /** Injected clock, stamped on the blob records the import writes. */
  readonly now: string;
  /**
   * Defaults to `copy`.
   *
   * There is deliberately no "auto" mode: `auto` is how a product ends up
   * replacing a subject the learner did not agree to replace, and the plan's
   * non-goals forbid automatic replacement.
   */
  readonly mode?: SubjectImportMode;
  /**
   * Required for `mode: 'replace'`: the subject on the destination that the archive
   * replaces. It must exist, and it must equal the archive's own subject id.
   *
   * Requiring the caller's word *and* the archive's is the point. "Replace existing"
   * means the subject named by the backup replaces itself, with its identifiers
   * preserved exactly; importing this backup over a *different* subject is a copy,
   * which is the default mode and is always available. So the two ids agreeing is
   * the whole contract, and a caller who wants a different subject asks for a copy.
   */
  readonly replaceSubjectId?: string;
  /**
   * Required `true` for `mode: 'replace'`.
   *
   * A boolean with no safe default: the plan calls replace "destructive and
   * confirmed", and this is the product half of that confirmation. The user
   * interface collects it; the product enforces it. A `replace` without it is refused
   * before anything is read, so an unconfirmed replace cannot even be attempted.
   */
  readonly confirmReplace?: boolean;
}

export interface SubjectImportResult {
  readonly mode: SubjectImportMode;
  /** The generation this import wrote. */
  readonly generationId: string;
  /** The generation that was active before, and that is still retained. */
  readonly previousActiveGenerationId: string | null;
  readonly activated: boolean;
  /** True when the previous generation is still readable after the import. */
  readonly previousGenerationRetained: boolean;
  /**
   * The subject id the device holds for this subject **after** the import.
   *
   * A fresh identifier in `copy` mode, the same identifier in `replace` mode. The UI
   * needs it to navigate to the subject it just created; it is an opaque id.
   */
  readonly importedSubjectId: string;
  /** The subject that was destroyed. Always `null` in `copy` mode. */
  readonly replacedSubjectId: string | null;
  /** Every identifier the copy rewrote, in a stable order. Empty in `replace` mode. */
  readonly idMapping: SubjectIdMapping;
  /** How many identifiers the copy rewrote. */
  readonly identifiersRemapped: number;
  /**
   * Strings that mention a mapped identifier without being one, carried verbatim.
   *
   * The disclosed residual of the unknown-field policy, and the reason it is on the
   * result at all: a non-zero count means the rewrite was not total, and a screen
   * that renders a bare "imported" would be saying something the product knows is not
   * quite true.
   */
  readonly unresolvedReferenceCount: number;
  /** Cross-subject achievement tokens carried verbatim, and why. */
  readonly crossSubjectAchievementsCarried: number;
  /** How many records each carried-forward store kept, byte for byte. */
  readonly carriedForwardRecordCounts: Readonly<Record<string, number>>;
  /** The stores this import copied from the active generation without touching. */
  readonly carriedForwardStores: readonly StorageV2StoreName[];
  /** Records of the replaced subject that were destroyed, per store. */
  readonly destroyedRecordCounts: Readonly<Record<string, number>>;
  /**
   * What the import did to learner state that belonged to **other** subjects, and to
   * the device-global assistance store.
   *
   * Present in both modes, and all zeros in `copy` mode - a copy adds a subject and
   * touches nothing the device already held, so there is nothing to disclose. In
   * `replace` mode this is the answer to "what did that import destroy?", which
   * `destroyedRecordCounts` cannot give: that field counts *records* per store, and
   * another subject's rooms cleared, notes, and fish are not records.
   *
   * Counts only. See {@link SubjectReplaceForeignState} for why a bystander
   * identifier must never appear in a report.
   */
  readonly foreignState: SubjectReplaceForeignState;
  /**
   * Values the copy carried verbatim because a declared rule says to, by code.
   *
   * A separate disclosure from {@link SubjectImportResult.unresolvedReferenceCount}
   * because the two mean different things: that one is prose that mentions an
   * identifier, this one is a value this product *chose* not to rewrite, with a
   * closed code saying which rule. Empty when nothing needed disclosing.
   */
  readonly verbatimDisclosures: readonly SubjectVerbatimDisclosure[];
  /** Per-store record counts of the generation the import wrote. */
  readonly recordCounts: Readonly<Record<StorageV2StoreName, number>>;
  /** The activated generation's roll-up checksum, read back from its descriptor. */
  readonly contentChecksum: string;
  /**
   * Relationship conditions that were disclosed rather than refused.
   *
   * Storage-v2 separates `error` problems, which block activation, from `warning`
   * problems, which mark a reference to something legitimately absent. This import
   * refuses the first and discloses the second through `isActivationBlocking`.
   */
  readonly disclosedWarnings: readonly ValidationProblem[];
  /** The policy that separated the two. */
  readonly blockingPolicy: MigrationBlockingPolicy;
  /** Attachments restored without their bytes, with no fabricated hash. */
  readonly externalOnlyAttachments: readonly ExternalOnlyAttachmentReport[];
  /**
   * Always `per-generation-receipts-not-carried-forward`.
   *
   * A migration receipt is a statement about the generation that carries it, and
   * storage-v2 refuses a generation holding a receipt that names a different one. So
   * the new generation carries none, the previous generation retains them byte for
   * byte, and this field says so rather than leaving a caller to discover an empty
   * receipt store and guess why.
   */
  readonly receiptPolicy: 'per-generation-receipts-not-carried-forward';
  /** One line, code-shaped, saying what happened to the receipts. */
  readonly receiptNote: string;
  /** How many receipts the retained previous generation still holds. */
  readonly previousGenerationReceiptCount: number;
  /** The sanitized preview the import was allowed to act on. */
  readonly preview: SubjectArchivePreview;
  /** The generator used to mint identifiers, for a caller that wants to log it. */
  readonly generator: SubjectIdGenerator;
}

/** A generation label this importer is willing to write. */
const ADOPTABLE_GENERATION_ID = /^[A-Za-z0-9._-]{1,64}$/;

// ── Replace-mode merge: records that are not owned by the subject they are keyed on ──

/**
 * What a replace did to the learner state a record was carrying for **other**
 * subjects, and to the device-global assistance store.
 *
 * **Counts only, never identifiers.** This is serialized onto an import report, a
 * disclosure screen, and a log, and a bystander subject's id - or a fish id, or a
 * room id - appearing in any of those would be a privacy leak dressed as a
 * disclosure. The reviewer of this phase measured exactly that leak, so the shape is
 * fixed: five numbers and one code-shaped line.
 */
export interface SubjectReplaceForeignState {
  /**
   * `bySubject` entries the device held and the archive did not carry, so they were
   * preserved **verbatim** rather than destroyed.
   */
  readonly preservedProgressionKeys: number;
  /**
   * `bySubject` entries the archive carried that the device did not have, applied
   * as the archive wrote them.
   */
  readonly appliedProgressionKeys: number;
  /**
   * `bySubject` entries both the device and the archive carried, where the
   * **device's** state was kept.
   *
   * Not a rollback and not a merge: the device's copy is newer by construction - it
   * is the one the learner has been using - so applying an older archived value over
   * it would undo work the learner did after the backup was taken. The archive's
   * value is *disclosed* as not applied rather than silently dropped or silently
   * preferred.
   */
  readonly retainedProgressionKeys: number;
  /**
   * The replaced subject's **own** `bySubject` entry that the archive did not carry.
   *
   * The one key a replace is allowed to destroy, and the only one: the archive is
   * authoritative about the subject it names. A non-zero count means the import
   * cleared the imported subject's own rooms-cleared, notes, fish, XP, and streak
   * because the archive held none for it.
   */
  readonly destroyedProgressionKeys: number;
  /**
   * Assistance records the device and the archive both held, with the same value.
   *
   * Counted so a repeated import is visibly idempotent rather than quietly growing
   * the store: the second import of the same archive adds nothing.
   */
  readonly identicalAssistanceRecords: number;
  /**
   * Assistance records the device and the archive both held with **different**
   * values, where the device's was kept and the archive's was preserved under a
   * freshly minted id.
   *
   * See {@link mergeAssistanceForReplace} for why neither side may simply win.
   */
  readonly preservedAssistanceRecords: number;
  /** Assistance records the archive carried that the device did not have. */
  readonly appliedAssistanceRecords: number;
  /** One line, code-shaped, naming what the numbers mean. */
  readonly note: string;
}

const REPLACE_FOREIGN_NOTE =
  'replace-preserves-foreign-progression-keys-device-copy-wins-on-conflict-assistance-collisions-are-preserved-not-overwritten';

function emptyForeignState(): SubjectReplaceForeignState {
  return {
    preservedProgressionKeys: 0,
    appliedProgressionKeys: 0,
    retainedProgressionKeys: 0,
    destroyedProgressionKeys: 0,
    identicalAssistanceRecords: 0,
    preservedAssistanceRecords: 0,
    appliedAssistanceRecords: 0,
    note: REPLACE_FOREIGN_NOTE,
  };
}

/** A `bySubject` map, or an empty one when the field is absent or the wrong shape. */
function bySubjectOf(record: ProgressionRecordValue | undefined): Record<string, unknown> {
  const value = record?.bySubject;
  return isRecordObject(value) ? value : {};
}

/**
 * Merge one progression record's `bySubject` for a replace.
 *
 * ## The defect this exists to prevent
 *
 * `ProgressionRecordValue` is keyed by `record.subjectId` but holds a
 * `bySubject` map, and the shape the legacy v3 writer produced puts **every subject
 * on the device** into one record. So "the record whose `subjectId` is the target" is
 * not the target's record alone: it is a record that also holds a bystander's rooms
 * cleared, notes, fish, XP, and streak. Dropping it to replace one subject's data
 * destroyed all of that, and the device's own copy of the bystander is a *subject*
 * record - not their progression. The import reported nothing, because
 * `destroyedRecordCounts` counts records per store and a bystander is not a record.
 *
 * ## The rule
 *
 * - The **target's own key** is the archive's, wholesale. A replace is authoritative
 *   about the subject it names; its entry is not merged with the device's, and if the
 *   archive carries none, the device's own entry for that subject is destroyed and
 *   counted.
 * - A **foreign key** - any key that is not the target - is never destroyed and never
 *   merged. The device's value is kept when it has one, the archive's is applied when
 *   it does not, and a key both hold keeps the **device's** value, because the
 *   device's is the newer one by construction and the archive's is a statement about
 *   an earlier moment. All three outcomes are counted.
 *
 * Foreign values are carried **verbatim**, values and all: a bystander's fish ids and
 * note ids are not remapped, because they are not this import's data and rewriting one
 * would fork a subject the learner never touched. See `idRemapping.ts` for why that
 * fork is not a cosmetic problem.
 */
export function mergeProgressionForReplace(
  base: readonly ProgressionRecordValue[],
  archive: readonly ProgressionRecordValue[],
  target: string,
): {
  readonly records: ProgressionRecordValue[];
  readonly preservedProgressionKeys: number;
  readonly appliedProgressionKeys: number;
  readonly retainedProgressionKeys: number;
  readonly destroyedProgressionKeys: number;
} {
  // Every record the device holds that is **not** the target's is left exactly as it
  // was, before any of this runs.
  const others = base.filter((record) => record.subjectId !== target);
  const baseTarget = base.find((record) => record.subjectId === target);
  const archiveTarget = archive.find((record) => record.subjectId === target);
  // An archive holding more than one record for one subject would be refused by the
  // archive's own record-count checks, so the first is the only one; taking the first
  // rather than merging all of them keeps that assumption explicit instead of
  // silently picking a winner.
  const baseBySubject = bySubjectOf(baseTarget);
  const archiveBySubject = bySubjectOf(archiveTarget);
  const baseForeignKeys = Object.keys(baseBySubject).filter((key) => key !== target);
  const archiveForeignKeys = Object.keys(archiveBySubject).filter((key) => key !== target);

  const preservedProgressionKeys = baseForeignKeys.filter(
    (key) => !(key in archiveBySubject),
  ).length;
  const appliedProgressionKeys = archiveForeignKeys.filter(
    (key) => !(key in baseBySubject),
  ).length;
  const retainedProgressionKeys = archiveForeignKeys.filter((key) => key in baseBySubject).length;
  const destroyedProgressionKeys =
    baseTarget !== undefined && archiveTarget === undefined && target in baseBySubject ? 1 : 0;

  // The merged map, in a fixed order: the target's own entry first, then foreign keys
  // sorted, so two runs over the same input produce byte-identical records and the
  // generation checksum does not depend on iteration order.
  const mergedBySubject = Object.create(null) as Record<string, unknown>;
  if (archiveTarget !== undefined) {
    mergedBySubject[target] = archiveBySubject[target];
  }
  const foreignKeys = [...new Set([...baseForeignKeys, ...archiveForeignKeys])].sort();
  for (const key of foreignKeys) {
    // The device's value wins a conflict. `in` rather than a truthiness test, so a
    // key whose value is `null` - a real state a normalization can produce - is
    // preserved rather than treated as absent.
    if (key in baseBySubject) mergedBySubject[key] = baseBySubject[key];
    else if (key in archiveBySubject) mergedBySubject[key] = archiveBySubject[key];
  }

  // The record survives if the archive described the target's own state, or if any
  // foreign state had to be kept. A replace that would leave neither is a record with
  // an empty map, which is not a record: it is an entry that says "this subject has
  // no progression" while carrying nothing else, and the next write would put a
  // truthy envelope on it.
  const keepsARecord = archiveTarget !== undefined || foreignKeys.length > 0;
  if (!keepsARecord) {
    return {
      records: others,
      preservedProgressionKeys,
      appliedProgressionKeys,
      retainedProgressionKeys,
      destroyedProgressionKeys,
    };
  }
  // The record's own scalar fields - `sourceVersion`, `rank`, `xpTotal`,
  // `crossSubjectAchievements` - come from the archive when it has a record, because
  // a replace is authoritative about the subject it names. When it has none, the
  // device's scalars are kept, so a bystander's record does not lose its streak to an
  // import that had nothing to say about it.
  const scalars = archiveTarget ?? baseTarget;
  return {
    records: [
      ...others,
      { ...(scalars as ProgressionRecordValue), subjectId: target, bySubject: mergedBySubject },
    ],
    preservedProgressionKeys,
    appliedProgressionKeys,
    retainedProgressionKeys,
    destroyedProgressionKeys,
  };
}

/**
 * Merge the device-global assistance store for a replace.
 *
 * ## Why this needs a rule at all
 *
 * `AssistanceRecordValue` has **no `subjectId`**: it is keyed by `assistanceId`
 * alone and is device-global. And the identifiers two devices mint are not private -
 * the repository's default id factory is a seeded **counter** (`gen-0001`,
 * `gen-0002`, ...), so a backup taken on one machine and imported onto another
 * collides on assistance ids *by construction*, not by chance. The old merge let the
 * archive overwrite a colliding device record, which is how importing subject A's
 * backup could quietly rewrite subject B's assistance state - or, on a device with a
 * single shared record, a record belonging to no subject at all.
 *
 * ## The rule
 *
 * The import cannot tell whether a colliding id is the same subject's state or a
 * different subject's, so it does not guess and it does not pick a winner:
 *
 * - **Same value**: nothing happens. The archive asked for something the device
 *   already has, so this is also what makes a repeated import idempotent.
 * - **Different value**: the device's record is kept - it is the one the learner has
 *   been using - and the archive's value is preserved under a **freshly minted id**.
 *   That is the one non-destructive resolution of a key collision, and it is the same
 *   thing copy mode already does with every identifier.
 * - **No collision**: the archive's record is applied as written.
 *
 * Nothing is destroyed and nothing is silently preferred, and all three outcomes are
 * counted so the report can say which happened. Nothing in the application reads this
 * store for behaviour yet - Phase 19 is where that arrives - so keeping both records
 * is safe today and is the only choice that is still safe then.
 */
export function mergeAssistanceForReplace(
  base: readonly AssistanceRecordValue[],
  archive: readonly AssistanceRecordValue[],
  generator: SubjectIdGenerator,
  reserved: ReadonlySet<string>,
): {
  readonly records: AssistanceRecordValue[];
  readonly identical: number;
  readonly preserved: number;
  readonly applied: number;
} {
  const deviceById = new Map(base.map((record) => [record.assistanceId, record]));
  const taken = new Set(reserved);
  let identical = 0;
  let preserved = 0;
  let applied = 0;
  const kept: AssistanceRecordValue[] = [...base];
  for (const incoming of archive) {
    const device = deviceById.get(incoming.assistanceId);
    if (device === undefined) {
      applied += 1;
      kept.push(incoming);
      continue;
    }
    // Canonical JSON, not `===`, so two records that differ only in key order are
    // the same record. `checksumValue` is the same serializer the generation checksum
    // uses, which keeps one notion of "the same value" in the codebase.
    if (checksumValue(device) === checksumValue(incoming)) {
      identical += 1;
      continue;
    }
    preserved += 1;
    kept.push({ ...incoming, assistanceId: mintReplacementId(generator, taken) });
  }
  // A device record the archive never mentioned is still in `kept`, untouched: only
  // the archive's own records were ever candidates for anything here.
  return { records: kept, identical, preserved, applied };
}

/** One minted identifier that is free on the device, prefixed with its kind. */
function mintReplacementId(generator: SubjectIdGenerator, taken: Set<string>): string {
  for (let attempt = 0; attempt < SUBJECT_ID_MINT_ATTEMPTS; attempt += 1) {
    const candidate = generator.next();
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    if (isPrototypeMemberName(candidate)) continue;
    if (taken.has(candidate)) continue;
    const minted = candidate.startsWith(SUBJECT_ID_KIND_PREFIX.assistance)
      ? candidate
      : `${SUBJECT_ID_KIND_PREFIX.assistance}-${candidate}`;
    if (!isSanitizedDetailText(minted) || taken.has(minted)) continue;
    taken.add(minted);
    return minted;
  }
  throw new StorageV2Error('RECORD_INVALID', {
    field: 'idGenerator',
    reason: 'no-free-identifier',
  });
}

function emptyStoreCounts(): Record<StorageV2StoreName, number> {
  return {
    meta: 0,
    subjects: 0,
    progression: 0,
    sessions: 0,
    preferences: 0,
    shortcuts: 0,
    assistance: 0,
    attachments: 0,
    customSprites: 0,
    recovery: 0,
    migrationReceipts: 0,
  };
}

/** Whether a generation label is safe to write into the database. */
function isWritableGenerationId(candidate: string): boolean {
  return ADOPTABLE_GENERATION_ID.test(candidate) && !isPrototypeMemberName(candidate);
}

function generationHasRecords(snapshot: GenerationSnapshot): boolean {
  const records = snapshot.records as unknown as Record<string, unknown[]>;
  return Object.values(records).some((entries) => Array.isArray(entries) && entries.length > 0);
}

/**
 * Choose a free generation label.
 *
 * The `.kdbak` importer prefers the archive's own label, because the migration
 * receipts it carries name the generation they were written for. A `.kdsubject`
 * carries no receipts, so there is nothing to keep truthful by adopting the
 * archive's label, and adopting a label the destination device may already use
 * would be actively wrong. So this mints, checks that the label is code-shaped and
 * not a prototype name, and checks that nothing is stored under it.
 */
async function chooseGenerationId(
  repository: StorageV2Repository,
  generator: SubjectIdGenerator,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generator.next();
    if (typeof candidate !== 'string' || candidate.trim().length === 0) break;
    if (!isWritableGenerationId(candidate)) continue;
    if ((await repository.readGeneration(candidate)) !== null) continue;
    if (generationHasRecords(await repository.readRecords(candidate))) continue;
    return candidate;
  }
  throw new StorageV2Error('RECORD_INVALID', { field: 'generator', reason: 'no-free-generation-id' });
}

/** The record **values** a generation holds, which is what a merge operates on. */
function valuesOf(snapshot: GenerationSnapshot): GenerationRecordValues {
  return {
    subjects: snapshot.records.subjects.map((envelope) => envelope.value),
    progression: snapshot.records.progression.map((envelope) => envelope.value),
    sessions: snapshot.records.sessions.map((envelope) => envelope.value),
    preferences: snapshot.records.preferences.map((envelope) => envelope.value),
    shortcuts: snapshot.records.shortcuts.map((envelope) => envelope.value),
    assistance: snapshot.records.assistance.map((envelope) => envelope.value),
    attachmentMetadata: snapshot.records.attachmentMetadata.map((envelope) => envelope.value),
    attachmentBlobs: snapshot.records.attachmentBlobs.map((envelope) => envelope.value),
    customSprites: snapshot.records.customSprites.map((envelope) => envelope.value),
    recovery: snapshot.records.recovery.map((envelope) => envelope.value),
    migrationReceipts: snapshot.records.migrationReceipts.map((envelope) => envelope.value),
  };
}

/** Every identifier the destination device already holds, flattened. */
function existingIdentifiersOf(records: GenerationRecordValues): ReturnType<typeof collectExistingIdentifiers> {
  const groups: Array<{ kind: SubjectIdKind; ids: string[] }> = [
    { kind: 'subject', ids: records.subjects.map((record) => record.subjectId) },
    { kind: 'session', ids: records.sessions.map((record) => record.sessionId) },
    { kind: 'assistance', ids: records.assistance.map((record) => record.assistanceId) },
  ];
  const roomIds: string[] = [];
  const fishIds: string[] = [];
  const noteIds: string[] = [];
  const lootIds: string[] = [];
  for (const record of records.subjects) {
    const snapshot = record.snapshot as unknown as Record<string, unknown>;
    const rooms = isRecordObject(snapshot.rooms) ? snapshot.rooms : {};
    roomIds.push(...Object.keys(rooms));
    for (const group of subjectIdentifierGroups(record, [])) {
      if (group.kind === 'room') roomIds.push(...group.ids);
    }
  }
  for (const record of records.progression) {
    const bySubject = isRecordObject(record.bySubject) ? record.bySubject : {};
    for (const perSubject of Object.values(bySubject)) {
      if (!isRecordObject(perSubject)) continue;
      if (Array.isArray(perSubject.fishCollection)) {
        for (const fish of perSubject.fishCollection) {
          if (isRecordObject(fish) && typeof fish.id === 'string') fishIds.push(fish.id);
        }
      }
      if (Array.isArray(perSubject.collectedNotes)) {
        for (const note of perSubject.collectedNotes) {
          if (isRecordObject(note) && typeof note.noteId === 'string') noteIds.push(note.noteId);
        }
      }
      for (const key of ['inventory', 'equippedItems'] as const) {
        if (!Array.isArray(perSubject[key])) continue;
        for (const item of perSubject[key]) {
          if (isRecordObject(item) && typeof item.id === 'string') lootIds.push(item.id);
        }
      }
    }
  }
  const attachmentIds = [
    ...records.attachmentMetadata.map((record) => record.attachmentId),
    ...records.attachmentBlobs.map((record) => record.attachmentId),
  ];
  return collectExistingIdentifiers([
    ...groups,
    { kind: 'room', ids: roomIds },
    { kind: 'attachment', ids: attachmentIds },
    { kind: 'fish', ids: fishIds },
    { kind: 'note', ids: noteIds },
    { kind: 'loot', ids: lootIds },
  ]);
}

/**
 * Import a `.kdsubject` into a new generation, and activate it only if it is sound.
 *
 * The exact conditions under which `activeGeneration` flips are: the archive read
 * and validated, the manifest's declared record counts matched the records the
 * archive actually carries, the complete merged generation was staged, the staged
 * generation validated with no **blocking** problem, no count delta and no checksum
 * mismatch, its recomputed roll-up checksum equalled the staged one, and the
 * activation transaction committed. Every one of those is a hard gate.
 *
 * The live active generation is **never** written to. The imported subject is merged
 * into a *new* generation that also carries every unrelated record over byte for
 * byte, so a failure at any point leaves the device exactly as it was and the
 * previous generation remains the rollback path.
 */
export async function importSubjectBackup(
  request: SubjectImportRequest,
): Promise<SubjectImportResult> {
  const { repository, bytes, now } = request;
  const mode: SubjectImportMode = request.mode ?? 'copy';

  // ── 0. The destructive mode is gated before anything is read ──
  // An unconfirmed replace is refused without opening the archive, so a
  // mis-wired call site cannot destroy a subject even if it then handed over a
  // perfectly good file.
  if (mode === 'replace' && request.confirmReplace !== true) {
    throw validationFailure('replace-not-confirmed', { field: 'confirmReplace' });
  }
  if (mode === 'replace' && typeof request.replaceSubjectId !== 'string') {
    throw validationFailure('replace-target-not-named', { field: 'replaceSubjectId' });
  }

  // ── 1. Read and validate without modifying anything ──
  const contents = readSubjectArchiveContents(bytes);
  const preview = contents.preview;
  const archiveSubjectId = contents.subjectId;

  if (mode === 'replace' && request.replaceSubjectId !== archiveSubjectId) {
    // "Replace existing" means the subject named by the backup replaces itself. A
    // caller who means a different subject wants a copy, which is the default.
    throw validationFailure('replace-target-disagrees', { field: 'replaceSubjectId' });
  }

  const previousActiveGenerationId = await repository.readActiveGenerationId();
  // A device with no active generation has nothing to merge into, and that is a
  // real state rather than an error: a profile that has run storage-v2 without
  // creating a subject. The base is then empty, the import stages a generation
  // holding only the imported subject, and there is no previous generation to
  // retain - which is reported as `previousGenerationRetained: false` rather than
  // left for a caller to infer.
  const base: GenerationRecordValues =
    previousActiveGenerationId === null
      ? {
          subjects: [],
          progression: [],
          sessions: [],
          preferences: [],
          shortcuts: [],
          assistance: [],
          attachmentMetadata: [],
          attachmentBlobs: [],
          customSprites: [],
          recovery: [],
          migrationReceipts: [],
        }
      : valuesOf(await repository.readRecords(previousActiveGenerationId));
  const previousGenerationReceiptCount = base.migrationReceipts.length;

  const idGenerator: SubjectIdGenerator = {
    next: () => repository.idFactory.next(),
  };

  let importedSubjectId = archiveSubjectId;
  let idMapping: SubjectIdMapping = [];
  let unresolvedReferenceCount = 0;
  let verbatimDisclosures: readonly SubjectVerbatimDisclosure[] = [];
  let foreignState: SubjectReplaceForeignState = emptyForeignState();
  let merged: GenerationRecordValues;

  if (mode === 'copy') {
    // ── 2a. Copy: remap every identifier, then add ──
    const remap = remapSubjectRecords({
      subject: contents.subject,
      progression: contents.progression,
      sessions: contents.sessions,
      assistance: contents.assistance,
      attachmentMetadata: contents.attachmentMetadata,
      attachmentBlobs: contents.attachmentBlobs,
      existing: existingIdentifiersOf(base),
      generator: idGenerator,
      now,
    });
    importedSubjectId = remap.subject.subjectId;
    idMapping = remap.mapping;
    unresolvedReferenceCount = remap.unresolvedReferenceCount;
    verbatimDisclosures = remap.verbatimDisclosures;
    merged = {
      subjects: [...base.subjects, remap.subject],
      progression: [...base.progression, ...remap.progression],
      sessions: [...base.sessions, ...remap.sessions],
      // Copy mode mints a fresh id for every assistance record, so it can never
      // collide with one already on the device and there is nothing to preserve or
      // disclose. The store is device-global, which is why the count of what a copy
      // *adds* is reported by the caller from the record counts and not here.
      assistance: [...base.assistance, ...remap.assistance],
      attachmentMetadata: [...base.attachmentMetadata, ...remap.attachmentMetadata],
      attachmentBlobs: [...base.attachmentBlobs, ...remap.attachmentBlobs],
      // The four device-global stores are carried over untouched, byte for byte.
      preferences: base.preferences,
      shortcuts: base.shortcuts,
      customSprites: base.customSprites,
      recovery: base.recovery,
      // See the module header: a receipt describes the generation carrying it, and
      // storage-v2 refuses a generation whose receipts name another. The previous
      // generation retains them.
      migrationReceipts: [],
    };
  } else {
    // ── 2b. Replace: destroy the named subject, write the archive's records ──
    const target = request.replaceSubjectId as string;
    if (!base.subjects.some((record) => record.subjectId === target)) {
      // "Replace existing" on a subject the device does not have is not a replace.
      // Refusing is what keeps the mode from becoming a silent overwrite of an
      // unrelated subject.
      throw new StorageV2Error('RECORD_NOT_FOUND', { field: 'replaceSubjectId' });
    }
    const destroyedAttachmentIds = new Set(
      base.attachmentMetadata
        .filter((record) => record.subjectId === target)
        .map((record) => record.attachmentId),
    );
    // A progression record is not owned by the subject it is keyed on, and neither is
    // an assistance record. Both merges are pure functions with their own stated
    // rules, so both are testable without a database.
    const progression = mergeProgressionForReplace(base.progression, contents.progression, target);
    const assistance = mergeAssistanceForReplace(
      base.assistance,
      contents.assistance,
      idGenerator,
      // A minted replacement must not land on an id the device already holds, which
      // includes every id in the records about to be written.
      existingIdentifiersOf(base).taken,
    );
    foreignState = {
      preservedProgressionKeys: progression.preservedProgressionKeys,
      appliedProgressionKeys: progression.appliedProgressionKeys,
      retainedProgressionKeys: progression.retainedProgressionKeys,
      destroyedProgressionKeys: progression.destroyedProgressionKeys,
      identicalAssistanceRecords: assistance.identical,
      preservedAssistanceRecords: assistance.preserved,
      appliedAssistanceRecords: assistance.applied,
      note: REPLACE_FOREIGN_NOTE,
    };
    merged = {
      subjects: [...base.subjects.filter((record) => record.subjectId !== target), contents.subject],
      progression: progression.records,
      sessions: [...base.sessions.filter((record) => record.subjectId !== target), ...contents.sessions],
      assistance: assistance.records,
      attachmentMetadata: [
        ...base.attachmentMetadata.filter((record) => record.subjectId !== target),
        ...contents.attachmentMetadata,
      ],
      // Blobs are destroyed **by attachment id**, never by content hash: two subjects
      // can legitimately share one file - the same image attached in two rooms - and
      // a hash-keyed filter would take the bystander's bytes with the target's.
      attachmentBlobs: [
        ...base.attachmentBlobs.filter((record) => !destroyedAttachmentIds.has(record.attachmentId)),
        ...contents.attachmentBlobs.map((record) => ({ ...record, storedAt: now })),
      ],
      preferences: base.preferences,
      shortcuts: base.shortcuts,
      customSprites: base.customSprites,
      recovery: base.recovery,
      migrationReceipts: [],
    };
  }

  const crossSubjectAchievementsCarried = merged.progression
    .filter((record) => record.subjectId === importedSubjectId)
    .reduce((total, record) => total + record.crossSubjectAchievements.length, 0);

  const carriedForwardStores: StorageV2StoreName[] = [
    'preferences',
    'shortcuts',
    'customSprites',
    'recovery',
  ];
  const carriedForwardRecordCounts: Record<string, number> = {
    preferences: merged.preferences.length,
    shortcuts: merged.shortcuts.length,
    customSprites: merged.customSprites.length,
    recovery: merged.recovery.length,
  };
  const destroyedRecordCounts: Record<string, number> = {};
  if (mode === 'replace') {
    const target = request.replaceSubjectId as string;
    destroyedRecordCounts.subjects = base.subjects.filter((record) => record.subjectId === target).length;
    destroyedRecordCounts.progression = base.progression.filter((record) => record.subjectId === target).length;
    destroyedRecordCounts.sessions = base.sessions.filter((record) => record.subjectId === target).length;
    destroyedRecordCounts.attachments = base.attachmentMetadata.filter(
      (record) => record.subjectId === target,
    ).length;
  }

  const generationId = await chooseGenerationId(repository, idGenerator);

  // ── 3. Write a complete new generation ──
  let staged = false;
  try {
    const written = await repository.stageGeneration({
      generationId,
      source: 'subject-import',
      parentGenerationId: previousActiveGenerationId,
      records: merged,
    });
    staged = true;

    // ── 4. Compare counts, relationships, and checksums ──
    const reread = await repository.readRecords(generationId);
    if (reread.contentChecksum !== written.contentChecksum) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', { stage: 'compare' });
    }
    const validation = await repository.validateGeneration(generationId);
    // Only *blocking* problems refuse an import. `validation.ok` is precisely that
    // test, and using the problem count instead would refuse a device whose
    // progression record names a subject the learner deleted - which storage-v2
    // deliberately treats as a disclosure rather than a defect, because dropping
    // the record would be destructive and activating without it would be dishonest.
    if (!validation.ok) {
      throw new StorageV2Error('VALIDATION_FAILED', {
        stage: 'validate',
        problemCount: countBlockingProblems(validation.problems),
        policy: MIGRATION_BLOCKING_POLICY,
      });
    }
    if (validation.checksumMismatches.length > 0) {
      throw new StorageV2Error('CHECKSUM_MISMATCH', {
        stage: 'validate',
        storeCount: validation.checksumMismatches.length,
      });
    }
    for (const [storeName, delta] of Object.entries(validation.countDeltas)) {
      if (delta !== 0) {
        throw new StorageV2Error('COUNT_MISMATCH', { stage: 'validate', store: storeName });
      }
    }

    // ── 5. Flip the pointer, retaining the previous generation ──
    const activation = await repository.activateGeneration(generationId);
    const activated = await repository.readGeneration(generationId);
    // Retention is unconditional and the activate transaction does not delete, so
    // this is measured rather than assumed. `false` only when the device had nothing
    // active, in which case there was no previous generation to retain.
    const previousGenerationRetained = previousActiveGenerationId !== null;
    const activatedCounts = activated?.descriptor?.recordCounts ?? emptyStoreCounts();
    return {
      mode,
      generationId,
      previousActiveGenerationId: activation.previousActiveGenerationId,
      activated: true,
      previousGenerationRetained,
      importedSubjectId,
      replacedSubjectId: mode === 'replace' ? (request.replaceSubjectId as string) : null,
      idMapping,
      identifiersRemapped: idMapping.length,
      unresolvedReferenceCount,
      verbatimDisclosures,
      foreignState,
      crossSubjectAchievementsCarried,
      carriedForwardRecordCounts,
      carriedForwardStores,
      destroyedRecordCounts,
      // The activated generation's own counts, read back from its descriptor rather
      // than echoed from what was staged: what the device holds.
      recordCounts: activatedCounts,
      contentChecksum: activated?.descriptor?.contentChecksum ?? '',
      disclosedWarnings: validation.problems.filter((problem) => problem.severity === 'warning'),
      blockingPolicy: MIGRATION_BLOCKING_POLICY,
      externalOnlyAttachments: preview.externalOnlyAttachments,
      receiptPolicy: 'per-generation-receipts-not-carried-forward',
      receiptNote: 'subject-import-mints-no-receipt-receipts-stay-with-their-generation',
      previousGenerationReceiptCount,
      preview,
      generator: idGenerator,
    };
  } catch (error) {
    // ── 6. On any failure, leave the device exactly as it was ──
    // A generation that was only `staged` has no reader and no pointer, so it is
    // removed rather than left for a later run to reclaim. The previous generation
    // is untouched, and nothing claimed success.
    if (staged) {
      await repository.discardStagedGeneration(generationId);
    }
    throw error;
  }
}

/**
 * Every identifier a device's records already hold, as one set.
 *
 * Exported because "the copy shares no id with the source" is a claim about two sets
 * of identifiers, and a caller - or a gate - should not have to reimplement the
 * flattening to make it. It performs no storage access; the caller passes the record
 * values in.
 */
export function collectDeviceIdentifiers(records: GenerationRecordValues): ReadonlySet<string> {
  return existingIdentifiersOf(records).taken;
}
